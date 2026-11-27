import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/auth/tokens", async (orig) => ({ ...(await orig<object>()), appUrl: (p: string) => `https://app.test${p}` }));
vi.mock("@/server/digest/unsubscribe", () => ({ unsubscribeUrl: vi.fn() }));
vi.mock("@/server/digest/build", () => ({ readableDigest: vi.fn(), readerAccess: vi.fn() }));

import { adAlertText } from "@/server/ads/alerts";
import { digestText } from "@/server/digest/email";
import type { DigestBody, DigestSection } from "@/shared";

const body = (ads: DigestSection): DigestBody => ({ brands: [{ brandId: "b", brandName: "B", week: { from: "2026-11-16", to: "2026-11-22" }, sections: [ads] }] });
const data = [{ currency: "EUR", spend: "120.00", purchases: 4, purchaseValue: "300.00", roas: 2.5 }];

describe("digest email: ads alerts", () => {
  it("adds one line per alert under the ads line, and counts the rest", () => {
    // The text as the digest stores it: adAlertText's, so a campaign name with a line break stays on one line.
    const text = adAlertText({ kind: "NO_PURCHASES", accountId: "act_1", campaignName: "Spring\nSubject: forged", currency: "EUR", values: { day: "2026-11-21", spend: "46.10" } });
    const out = digestText(body({ kind: "ads", key: "ads.read", data, alerts: [{ kind: "NO_PURCHASES", text, firstDay: "2026-11-21", lastDay: "2026-11-21" }], moreAlerts: 2 }), "https://u");
    const lines = out.split("\n");
    const at = lines.indexOf("Ads: 120.00 EUR spent, 4 purchases");
    expect(lines.slice(at, at + 3)).toEqual([
      "Ads: 120.00 EUR spent, 4 purchases",
      '  - alert: Campaign "Spring Subject: forged" spent 46.10 EUR with no purchases for 3 days to 2026-11-21 (purchases can still grow a little)',
      "  - 2 more alerts in the app",
    ]);
    expect(lines.some((l) => l.startsWith("Subject:"))).toBe(false);
  });

  it("a stored body from before alerts renders as before", () => {
    expect(digestText(body({ kind: "ads", key: "ads.read", data }), "https://u")).toContain("B (2026-11-16 to 2026-11-22)\nAds: 120.00 EUR spent, 4 purchases\n\n");
    expect(digestText(body({ kind: "ads", key: "ads.read", data: null }), "https://u")).toContain("Ads: no data yet\n\n");
  });
});

describe("digest email: declining pages", () => {
  const seo = (declines?: { count: number; pages: string[] }): DigestSection => ({ kind: "seo", key: "analytics.read", data: null, ...(declines && { declines }) });
  it("adds one line with the count and the cleaned paths", () => {
    expect(digestText(body(seo({ count: 4, pages: ["/a", "/b"] })), "https://u")).toContain("Search: no data yet\n  - losing search traffic: 4 (/a, /b)\n");
  });
  it("a stored body from before declines renders as before", () => {
    expect(digestText(body(seo()), "https://u")).toContain("Search: no data yet\n\n");
  });
});
