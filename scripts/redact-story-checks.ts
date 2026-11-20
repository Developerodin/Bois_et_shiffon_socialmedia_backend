/**
 * Rewrites stored story checks whose "Asset rights" note names someone by their email (stories saved before
 * 2026-11-20 stored the email as the confirmer's name). The note is rebuilt from each frame's `rights.by`, named as
 * personName(user, { reveal: false }) names them. QualityCheck rows are not hashed; version bodies are, so they are
 * only read, never written (the API hides their rights names on read).
 *
 *   npm run redact:story-checks                          dry run: counts only
 *   npm run redact:story-checks -- --apply               writes
 *   npm run redact:story-checks -- --workspace <id>      one workspace (with or without --apply)
 *
 * ponytail: one-off; delete this script (and its npm script and test) once it has run --apply on every database.
 */
import type { Prisma } from "@prisma/client";
import { personName } from "@/server/content/person-name";
import { prisma } from "@/server/db/prisma";
import { ASSET_RIGHTS, isStoryBody, rightsLines } from "@/server/stories/body";

const PAGE = 500;
type Row = { check?: unknown; status?: unknown; note?: unknown };

export async function redactStoryChecks(opts: { apply: boolean; workspaceId?: string }, log: (line: string) => void = console.log) {
  const where = { version: { item: { channel: "INSTAGRAM_STORY" as const, ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) } } };
  const counts = { scanned: 0, withEmail: 0, updated: 0, skipped: 0 };
  // Rewrites per workspace, for one audit event each (written even if a later page fails).
  const rewritten = new Map<string, number>();
  let cursor: string | undefined;
  try {
    for (let more = true; more; ) {
      const page = await prisma.qualityCheck.findMany({
        where, orderBy: { id: "asc" }, take: PAGE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, results: true, version: { select: { body: true, item: { select: { workspaceId: true } } } } },
      });
      more = page.length === PAGE;
      cursor = page.at(-1)?.id;
      counts.scanned += page.length;
      // Only a passing rights row names people; a blocked one lists frame numbers.
      const leaked = page.flatMap((c) => {
        const body = c.version.body;
        const emailInNote = Array.isArray(c.results)
          && (c.results as Row[]).some((r) => r?.check === ASSET_RIGHTS && r.status === "pass" && String(r.note).includes("@"));
        // An email in the note but no story body to rebuild it from: left as it is, and counted so it can be looked at by hand.
        if (emailInNote && !isStoryBody(body)) counts.skipped++;
        return emailInNote && isStoryBody(body) ? [{ id: c.id, workspaceId: c.version.item.workspaceId, results: c.results as Row[], frames: body.frames }] : [];
      });
      counts.withEmail += leaked.length;
      if (!leaked.length) continue;
      const ids = [...new Set(leaked.flatMap((c) => c.frames.flatMap((f) => (f.rights?.kind === "confirmed" ? [f.rights.by] : []))))];
      const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
      const names = new Map(users.map((u) => [u.id, personName(u, { reveal: false })]));
      for (const c of leaked) {
        const note = rightsLines(c.frames, (r) => (r.by ? names.get(r.by) : undefined)).join("; ");
        const results = c.results.map((r) => (r?.check === ASSET_RIGHTS && r.status === "pass" ? { ...r, note } : r));
        if (!opts.apply) continue;
        await prisma.qualityCheck.update({ where: { id: c.id }, data: { results: results as Prisma.InputJsonValue } });
        counts.updated++;
        rewritten.set(c.workspaceId, (rewritten.get(c.workspaceId) ?? 0) + 1);
      }
      log(`${counts.scanned} checks read, ${counts.withEmail} with an email, ${counts.updated} rewritten`);
    }
  } finally {
    for (const [workspaceId, count] of rewritten) {
      // Its own try/catch: a failed audit write is logged and never replaces the error that got us here.
      try {
        await prisma.auditEvent.create({ data: { workspaceId, action: "story-checks.redacted", entityType: "Workspace", entityId: workspaceId, metadata: { count } } });
      } catch (e) {
        log(`Could not write the audit event for workspace ${workspaceId} (${count} rewritten): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  log(`${opts.apply ? "Done" : "Dry run (pass --apply to write)"}: ${counts.scanned} story checks read, ${counts.withEmail} with an email in the rights note, ${counts.updated} rewritten, ${counts.skipped} skipped (email in the note but the body is not a story body).`);
  return counts;
}

// Run from the command line only (the test imports the function).
if (process.argv[1] && /redact-story-checks\.ts$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--workspace");
  const workspaceId = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && (!workspaceId || workspaceId.startsWith("--"))) throw new Error("--workspace needs a workspace id");
  redactStoryChecks({ apply: args.includes("--apply"), workspaceId })
    .then(() => prisma.$disconnect())
    .catch(async (e) => {
      console.error(e);
      await prisma.$disconnect();
      process.exit(1);
    });
}
