import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";

// Short-lived values shared across instances (challenges, in-flight markers, read caches).
// Expired rows are ignored on read and deleted by the worker's pruneOldRows.

const json = (value: unknown) => JSON.stringify(value ?? null);

export async function getTransient<T>(key: string): Promise<T | null> {
  const row = await prisma.transientEntry.findUnique({ where: { key } });
  return row && row.expiresAt > new Date() ? (row.value as T) : null;
}

export async function putTransient(key: string, value: unknown, ttlMs: number): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs);
  const v = (value ?? null) as Prisma.InputJsonValue;
  await prisma.transientEntry.upsert({ where: { key }, create: { key, value: v, expiresAt }, update: { value: v, expiresAt } });
}

/** True only if no live entry held the key; an expired one is taken over. */
export async function claimTransient(key: string, value: unknown, ttlMs: number): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlMs);
  const rows = await prisma.$queryRaw<{ key: string }[]>`
    INSERT INTO "TransientEntry" ("key", "value", "expiresAt")
    VALUES (${key}, ${json(value)}::jsonb, ${expiresAt})
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "expiresAt" = EXCLUDED."expiresAt"
    WHERE "TransientEntry"."expiresAt" < now()
    RETURNING "key"`;
  return rows.length > 0;
}

/** Reads and deletes a live entry in one statement, so only one caller gets it. */
export async function takeTransient<T>(key: string): Promise<T | null> {
  const rows = await prisma.$queryRaw<{ value: T }[]>`
    DELETE FROM "TransientEntry" WHERE "key" = ${key} AND "expiresAt" > now() RETURNING "value"`;
  return rows[0]?.value ?? null;
}

/** Deletes the entry; with `owner`, only while it still holds that value (a claim taken over after expiry is left alone). */
export async function dropTransient(key: string, owner?: unknown): Promise<void> {
  if (owner === undefined) {
    await prisma.transientEntry.deleteMany({ where: { key } });
    return;
  }
  await prisma.$executeRaw`DELETE FROM "TransientEntry" WHERE "key" = ${key} AND "value" = ${json(owner)}::jsonb`;
}
