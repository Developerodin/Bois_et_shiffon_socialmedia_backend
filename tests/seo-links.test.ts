import { describe, expect, it } from "vitest";
import { CrawlError } from "@/server/research/crawl";
import { classifyLink, linkFindings, linkMetrics, type LinkRow } from "@/server/seo/links";
import { retryAfterMs } from "@/server/seo/site-crawl";

const ok = (status: number, redirects = 0) => ({ status, redirects });

describe("classifyLink", () => {
  it("404, 410 and other 4xx are broken; 401/403 never are; a first 429 waits, a second is unknown", () => {
    expect(classifyLink(ok(404))).toBe("broken");
    expect(classifyLink(ok(410))).toBe("broken");
    expect(classifyLink(ok(400))).toBe("broken");
    expect(classifyLink(ok(401))).toBe("unknown");
    expect(classifyLink(ok(403))).toBe("unknown");
    expect(classifyLink(ok(429))).toBe("wait");
    expect(classifyLink(ok(429), true)).toBe("unknown");
  });

  it("a 5xx is re-checked once: 503 then 503 is a server error, 503 then 200 is fine", () => {
    expect(classifyLink(ok(503))).toBe("recheck");
    expect(classifyLink(ok(503), true)).toBe("server-error");
    expect(classifyLink(ok(200), true)).toBe("ok");
  });

  it("one redirect is fine, two make a chain; too many is a loop; an off-site redirect is skipped", () => {
    expect(classifyLink(ok(200, 1))).toBe("ok");
    expect(classifyLink(ok(200, 2))).toBe("chain");
    expect(classifyLink(ok(404, 2))).toBe("broken");
    expect(classifyLink({ error: new CrawlError("Too many redirects") })).toBe("loop");
    expect(classifyLink({ error: new CrawlError("Redirected to another site") })).toBe("skipped");
    expect(classifyLink({ error: new TypeError("fetch failed") })).toBe("unknown");
  });
});

const row = (url: string, outcome: string | null, carryCount: number, extra: Partial<LinkRow> = {}): LinkRow => ({
  url, checkedAt: outcome ? new Date() : null, status: outcome === "broken" ? 404 : outcome === "server-error" ? 503 : 200,
  redirects: outcome === "chain" ? 3 : 0, outcome, carryCount, sources: carryCount ? ["https://shop.test/from"] : [], ...extra,
});

describe("linkFindings", () => {
  it("one finding per kind, targets nobody links to left out, chains and loops together", () => {
    const f = linkFindings([
      row("https://shop.test/gone", "broken", 2),
      row("https://shop.test/sitemap-only", "broken", 0),
      row("https://shop.test/down", "server-error", 1),
      row("https://shop.test/hop", "chain", 1),
      row("https://shop.test/loop", "loop", 1, { status: null }),
      row("https://shop.test/fine", "ok", 9),
      row("https://shop.test/wall", "unknown", 3),
    ]);
    expect(f.map((x) => [x.id, x.severity, x.category])).toEqual([
      ["links-broken", "high", "Links"], ["links-server-error", "medium", "Links"], ["links-redirect-chain", "low", "Links"],
    ]);
    expect(f[0]!.urls).toEqual(["https://shop.test/gone"]);
    expect(f[0]!.detail).toContain("https://shop.test/gone (404) — on 2 pages, e.g. https://shop.test/from");
    expect(f[2]!.urls).toEqual(["https://shop.test/hop", "https://shop.test/loop"]);
    expect(f[2]!.detail).toContain("(3 redirects)");
    expect(f[2]!.detail).toContain("(redirect loop)");
  });

  it("lists the 20 most-linked targets and counts the rest", () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(`https://shop.test/p${i}`, "broken", i + 1));
    const [f] = linkFindings(rows);
    expect(f!.urls).toHaveLength(20);
    expect(f!.urls![0]).toBe("https://shop.test/p24");
    expect(f!.detail).toMatch(/and 5 more$/);
    expect(f!.detail.startsWith("25 pages")).toBe(true);
  });

  it("cleans the target and page text in the detail (bidi and control characters), keeps urls whole", () => {
    const long = `https://shop.test/${"a".repeat(1_500)}`;
    const [f] = linkFindings([row(long, "broken", 1, { sources: ["https://shop.test/‮evil\u0007"] })]);
    expect(f!.detail).not.toMatch(/[‮\u0007]/);
    expect(f!.detail).toContain(`${long.slice(0, 300)} (404)`);
    expect(f!.detail).not.toContain(long);
    expect(f!.urls).toEqual([long]);
  });
});

describe("linkMetrics", () => {
  it("counts outcomes; unchecked includes re-checks and links past the caps; complete only for COMPLETE", () => {
    const rows = [row("a", "broken", 1), row("b", null, 1), row("c", "recheck", 1), row("d", "chain", 1), row("e", "skipped", 0)];
    const crawl = { id: "c1", finishedAt: new Date("2026-11-20T10:00:00Z"), status: "PARTIAL", pages: 3, targets: 2, checked: 4, overflow: 7 };
    expect(linkMetrics(crawl, rows)).toEqual({
      crawlId: "c1", finishedAt: "2026-11-20T10:00:00.000Z", pages: 3, targets: 2, checked: 4, broken: 1, serverErrors: 0, chains: 1,
      loops: 0, unknown: 0, skipped: 1, unchecked: 9, complete: false,
    });
    expect(linkMetrics({ ...crawl, status: "COMPLETE" }, rows).complete).toBe(true);
  });
});

describe("retryAfterMs", () => {
  const now = new Date("2026-11-27T10:00:00Z");
  it("reads seconds or a date, caps at a day, ignores junk", () => {
    expect(retryAfterMs("120", now)).toBe(120_000);
    expect(retryAfterMs("Fri, 27 Nov 2026 10:05:00 GMT", now)).toBe(300_000);
    expect(retryAfterMs("999999", now)).toBe(86_400_000);
    expect(retryAfterMs("soon", now)).toBeNull();
    expect(retryAfterMs(null, now)).toBeNull();
  });
});
