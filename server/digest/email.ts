import "server-only";
import type { DigestBody, DigestSection } from "@/shared";
import { appUrl } from "@/server/auth/tokens";
import { prisma } from "@/server/db/prisma";
import { readerAccess, refilterDigest } from "@/server/digest/build";
import { unsubscribeUrl } from "@/server/digest/unsubscribe";

const n = (v: number) => v.toLocaleString("en-GB");
const pct = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(1)}%`);

function sectionLines(s: DigestSection): string[] {
  switch (s.kind) {
    case "content":
      return [`Posts: ${n(s.published)} published, ${n(s.scheduled)} scheduled, ${n(s.awaitingApproval)} waiting for approval`];
    case "tasks":
      return [`Tasks: ${n(s.done)} done, ${n(s.open)} open, ${n(s.overdue)} overdue`, ...s.overdueTitles.map((t) => `  - overdue: ${t}`)];
    case "seo":
      return s.data
        ? [`Search (${s.data.range.from} to ${s.data.range.to}): ${n(s.data.totals.clicks)} clicks, ${n(s.data.totals.impressions)} impressions, CTR ${pct(s.data.totals.ctr)}`]
        : ["Search: no data yet"];
    case "posts":
      return [s.published ? "Top posts:" : "Top posts: none published",...s.top.map((p) => `  - ${p.title ?? "Untitled"} (${p.channel}): ${p.reach === null ? "reach not read yet" : `${n(p.reach)} reach`}`)];
    case "sales":
      return s.data ? [`Sales: ${s.data.length ? s.data.map((c) => `${n(c.orders)} orders, ${c.netSales} ${c.currency} net`).join("; ") : "no orders"}`] : ["Sales: no data yet"];
    case "ads":
      return s.data ? [`Ads: ${s.data.length ? s.data.map((c) => `${c.spend} ${c.currency} spent, ${n(c.purchases)} purchases`).join("; ") : "no spend"}`] : ["Ads: no data yet"];
  }
}

/** The digest as plain text: one block per brand, then the page and the unsubscribe link. */
export function digestText(body: DigestBody, unsubscribe: string) {
  const blocks = body.brands.map((b) => [`${b.brandName} (${b.week.from} to ${b.week.to})`, ...b.sections.flatMap(sectionLines)].join("\n"));
  return [...blocks, `Open it in the app: ${appUrl("/digest")}`, `Stop these emails: ${unsubscribe}`].join("\n\n");
}

/**
 * The email for outbox ref "digest:<id>", built at send time: null (skip) when the digest is gone, the reader opted out,
 * is no longer a member, or nothing they may still see is left. Sections are re-filtered by their CURRENT permissions
 * and the address is read now, so a changed email or a removed key is honoured even for a queued send.
 */
export async function digestEmailFor(digestId: string) {
  const d = await prisma.digest.findUnique({
    where: { id: digestId },
    include: { user: { select: { email: true, digestEmail: true, status: true, deletedAt: true } } },
  });
  if (!d || !d.user.digestEmail || d.user.status !== "ACTIVE" || d.user.deletedAt) return null;
  const access = await readerAccess(d.userId, d.workspaceId);
  if (!access) return null;
  const body = refilterDigest(d.body as DigestBody, access);
  if (!body.brands.length) return null;
  const url = unsubscribeUrl(d.userId, d.workspaceId);
  return {
    to: d.user.email,
    subject: `Your weekly digest: week of ${d.weekStart.toISOString().slice(0, 10)}`,
    text: digestText(body, url),
    headers: { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}
