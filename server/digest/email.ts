import "server-only";
import type { DigestBody, DigestSales, DigestSection } from "@/shared";
import { appUrl } from "@/server/auth/tokens";
import { prisma } from "@/server/db/prisma";
import { readableDigest, readerAccess } from "@/server/digest/build";
import { unsubscribeUrl } from "@/server/digest/unsubscribe";

const n = (v: number) => v.toLocaleString("en-GB");
const pct = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(1)}%`);

/** A currency's week: net without VAT when known; a digest built before that change still shows its VAT-included net. */
function salesLine(c: DigestSales) {
  const orders = `${n(c.orders)} orders`;
  if (c.netExVat === undefined) return c.netSales === undefined ? orders : `${orders}, ${c.netSales} ${c.currency} net`;
  if (c.netExVat === null) return orders;
  const missing = c.exVatMissing ? ` (${n(c.exVatMissing)} orders left out: their VAT couldn't be read)` : "";
  return `${orders}, ${c.netExVat} ${c.currency} net excl. VAT${c.exVatFrom ? ` from ${c.exVatFrom}` : ""}${missing}`;
}

function sectionLines(s: DigestSection): string[] {
  switch (s.kind) {
    case "content":
      return [`Posts: ${n(s.published)} published, ${n(s.scheduled)} scheduled, ${n(s.awaitingApproval)} waiting for approval`];
    case "tasks":
      return [`Tasks: ${n(s.done)} done, ${n(s.open)} open, ${n(s.overdue)} overdue`, ...s.overdueTasks.map((t) => `  - overdue: ${t.title}`)];
    case "seo":
      return s.data
        ? [`Search (${s.data.range.from} to ${s.data.range.to}): ${n(s.data.totals.clicks)} clicks, ${n(s.data.totals.impressions)} impressions, CTR ${pct(s.data.totals.ctr)}`]
        : ["Search: no data yet"];
    case "posts":
      return [s.published ? "Top posts:" : "Top posts: none published",...s.top.map((p) => `  - ${p.title ?? "Untitled"} (${p.channel}): ${p.reach === null ? "reach not read yet" : `${n(p.reach)} reach`}`)];
    case "sales":
      return s.data ? [`Sales: ${s.data.length ? s.data.map(salesLine).join("; ") : "no orders"}`] : ["Sales: no data yet"];
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
  const body = await readableDigest(d.body as DigestBody, d.userId, d.workspaceId, access);
  if (!body.brands.length) return null;
  const url = unsubscribeUrl(d.userId, d.workspaceId);
  return {
    to: d.user.email,
    // Each brand's own week (zones can put brands a week apart).
    subject: `Your weekly digest: ${[...new Set(body.brands.map((b) => `${b.week.from} to ${b.week.to}`))].join(", ")}`,
    text: digestText(body, url),
    headers: { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}
