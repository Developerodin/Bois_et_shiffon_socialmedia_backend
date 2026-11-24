import { Prisma, type Job } from "@prisma/client";
import { prisma } from "@/server/db/prisma";

/**
 * Durable Postgres job queue (DEC-006/015, design §5.2 / §8b-1).
 * Claim = one UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) so two
 * runners can never take the same job. Expired leases are reclaimable (crash recovery).
 */
export const LEASE_MS = 5 * 60_000;

type Db = Prisma.TransactionClient | typeof prisma;

export type EnqueueInput = {
  type: string;
  workspaceId?: string;
  brandId?: string;
  payload: Prisma.InputJsonValue;
  runAt?: Date;
  maxAttempts?: number;
  /** Duplicate enqueues with the same key return the existing job. */
  idempotencyKey?: string;
};

export async function enqueueJob(input: EnqueueInput, db: Db = prisma) {
  const data = {
    type: input.type,
    workspaceId: input.workspaceId,
    brandId: input.brandId,
    payload: input.payload,
    runAt: input.runAt,
    maxAttempts: input.maxAttempts,
    idempotencyKey: input.idempotencyKey,
  };
  if (!input.idempotencyKey) return db.job.create({ data });
  return db.job.upsert({
    where: { idempotencyKey: input.idempotencyKey },
    update: {},
    create: data,
  });
}

/**
 * How many data.% jobs (provider syncs, up to 4 minutes each) may run at once across all runners.
 * ponytail: the count is read without a lock, so two runners claiming in the same instant can start a third; the cap
 * is about fairness, not correctness. The count uses the (status, runAt) index's RUNNING rows, a handful at most.
 */
export const DATA_RUNNING_MAX = 2;
/** The site reader (catalog.pages, server/catalog/page-reader.ts) runs on one runner at a time, outside the data.% pool. Same unlocked count. */
export const PAGES_RUNNING_MAX = 1;

export async function claimNextJob(workerId: string): Promise<Job | null> {
  const rows = await prisma.$queryRaw<Job[]>`
    UPDATE "Job" SET
      status = 'RUNNING',
      "leasedBy" = ${workerId},
      "leasedUntil" = now() + ${`${LEASE_MS} milliseconds`}::interval,
      attempts = attempts + 1,
      "updatedAt" = now()
    WHERE id = (
      SELECT id FROM "Job"
      WHERE ((status = 'PENDING' AND "runAt" <= now())
         OR (status = 'RUNNING' AND "leasedUntil" < now()))
        -- Data syncs take at most DATA_RUNNING_MAX runners, so publishing and the rest are never starved by them.
        AND (type NOT LIKE 'data.%' OR (
          SELECT count(*) FROM "Job" r
          WHERE r.type LIKE 'data.%' AND r.status = 'RUNNING' AND r."leasedUntil" >= now()
        ) < ${DATA_RUNNING_MAX})
        AND (type <> 'catalog.pages' OR (
          SELECT count(*) FROM "Job" r
          WHERE r.type = 'catalog.pages' AND r.status = 'RUNNING' AND r."leasedUntil" >= now()
        ) < ${PAGES_RUNNING_MAX})
      ORDER BY "runAt"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *`;
  return rows[0] ?? null;
}

/**
 * Keeps a running job's lease alive (every third of LEASE_MS) so a long job, like a 5+ minute Research run,
 * isn't reclaimed and run twice while it's still working. A crashed or cut-off runner stops renewing, so its
 * lease still expires and crash recovery works as before. Returns the stop function.
 * A failed or refused renewal is logged, not acted on here: a runner whose lease lapsed finds out at its final write
 * (holdsLease), and complete/fail are lease-guarded anyway.
 */
export function holdLease(job: Job) {
  const timer = setInterval(() => {
    prisma.$executeRaw`
      UPDATE "Job" SET "leasedUntil" = now() + ${`${LEASE_MS} milliseconds`}::interval
      WHERE id = ${job.id} AND "leasedBy" = ${job.leasedBy} AND status = 'RUNNING'`.then(
      (n) => { if (n === 0) console.warn(`[jobs] ${job.type} ${job.id}: lease lost to another runner; its final write will be refused`); },
      (e) => console.error(`[jobs] ${job.type} ${job.id}: lease renewal failed`, e),
    );
  }, LEASE_MS / 3);
  return () => clearInterval(timer);
}

/** The claim a handler runs under (runner.ts passes it): enough to check that this runner still holds the job. */
export type Lease = { jobId: string; leasedBy: string | null };

/**
 * For a handler's last irreversible step or final write, inside its transaction: whether this runner still holds the
 * job. FOR SHARE keeps another runner from reclaiming or failing the job until the caller's transaction ends, so a
 * DB-only final write needs no margin (0). A check before an external call passes `marginSecs`, longer than that call,
 * so the lease can't lapse while it is in flight.
 */
export async function holdsLease(tx: Prisma.TransactionClient, lease: Lease, marginSecs = 0) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Job"
    WHERE id = ${lease.jobId} AND "leasedBy" = ${lease.leasedBy} AND status = 'RUNNING' AND "leasedUntil" > now() + make_interval(secs => ${marginSecs}::float8)
    FOR SHARE`;
  return rows.length === 1;
}

/** Only the lease holder may complete/fail a job (a reclaimed job's old runner is ignored). */
export async function completeJob(job: Job) {
  await prisma.job.updateMany({
    where: { id: job.id, leasedBy: job.leasedBy, status: "RUNNING" },
    data: { status: "COMPLETED", leasedUntil: null },
  });
}

export function backoffMs(attempts: number) {
  return Math.min(60 * 60_000, 2 ** attempts * 15_000);
}

/**
 * Hands a claimed job back untouched (a type this runner doesn't know, e.g. queued by a newer release): pending again
 * in a minute, the claim's attempt not counted. Guarded by the lease so a reclaimed job isn't disturbed.
 */
export async function releaseJob(job: Pick<Job, "id" | "leasedBy">) {
  await prisma.job.updateMany({
    where: { id: job.id, leasedBy: job.leasedBy, status: "RUNNING" },
    data: { status: "PENDING", runAt: new Date(Date.now() + 60_000), leasedUntil: null, leasedBy: null, attempts: { decrement: 1 } },
  });
}

/** How long a job out of tries waits before its failure hook is run again, if the first run of it didn't finish. */
export const HOOK_RETRY_MS = 60_000;

/**
 * Whether the job has no tries left, or null when this runner had lost the lease (nothing written: not its to fail).
 * A job out of tries isn't dead-lettered yet: it is parked, pending again in HOOK_RETRY_MS with no tries left, so that
 * its failure hook (mark failed, refund, queue a later retry) runs at least once. The runner dead-letters it
 * (deadLetterJob) only after the hook succeeded; if the hook throws or the process dies first, the next claim finds
 * attempts > maxAttempts and runs the hook again, never the job itself.
 */
export async function failJob(job: Job, error: unknown, retryable = true, lastError = String(error)) {
  const exhausted = !retryable || job.attempts >= job.maxAttempts;
  const { count } = await prisma.job.updateMany({
    where: { id: job.id, leasedBy: job.leasedBy, status: "RUNNING" },
    data: {
      status: "PENDING",
      runAt: new Date(Date.now() + (exhausted ? HOOK_RETRY_MS : backoffMs(job.attempts))),
      ...(exhausted ? { attempts: job.maxAttempts } : {}),
      leasedUntil: null,
      lastError: lastError.slice(0, 2000),
    },
  });
  return count === 1 ? exhausted : null;
}

/** After a parked job's failure hook succeeded: dead-letter it, unless another runner has claimed it meanwhile. */
export async function deadLetterJob(job: Pick<Job, "id" | "leasedBy">) {
  await prisma.job.updateMany({ where: { id: job.id, leasedBy: job.leasedBy, status: "PENDING" }, data: { status: "DEAD_LETTER" } });
}
