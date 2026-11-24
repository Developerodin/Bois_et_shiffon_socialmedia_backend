import { afterEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  // What the pinned (connect-time) lookup sees; the pre-check below always sees a public address.
  connectAddress: "127.0.0.1",
  fetch: null as null | ((url: URL | string, init?: unknown) => Promise<Response>),
}));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));
vi.mock("node:dns", () => ({
  lookup: (_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
    const a = { address: m.connectAddress, family: 4 };
    if (opts.all) cb(null, [a]);
    else cb(null, a.address, a.family);
  },
}));
vi.mock("undici", async (orig) => {
  const actual = await orig<typeof import("undici")>();
  return { ...actual, fetch: (url: URL | string, init?: unknown) => (m.fetch ?? (actual.fetch as never as NonNullable<typeof m.fetch>))(url, init) };
});

import { crawlSite, jsonLdNodes, ROBOTS_AGENT, robotsAllows, robotsCrawlDelay, robotsGroups, robotsSitemaps, safeFetch } from "@/server/research/crawl";

afterEach(() => {
  m.fetch = null;
});

describe("pinned lookup", () => {
  it("refuses a host that passed the check but rebinds to 127.0.0.1 at connect", async () => {
    const err = await safeFetch("http://rebind.example/").then(() => null, (e: unknown) => e as Error & { cause?: Error });
    expect(err).not.toBeNull();
    expect(String(err?.cause?.message ?? err?.message)).toMatch(/Private or local/);
  });
});

describe("robots.txt", () => {
  const txt = [
    "User-agent: *",
    "Disallow: /",
    "Crawl-delay: 2",
    "",
    "User-agent: BrandpilotResearchBot",
    "Disallow: /cart",
    "Disallow: /*?sort=",
    "Allow: /cart/share",
    "Disallow: /exact$",
    "Crawl-delay: 5",
    "",
    "Sitemap: https://shop.example/sitemap.xml",
    "sitemap: https://shop.example/products.xml # products",
  ].join("\n");

  it("own group wins over *", () => {
    expect(ROBOTS_AGENT).toBe("BrandpilotResearchBot");
    expect(robotsAllows(txt, "/products/table", ROBOTS_AGENT)).toBe(true);
    expect(robotsAllows(txt, "/products/table", "OtherBot")).toBe(false);
  });

  it("Allow beats a shorter Disallow; wildcards and $ match", () => {
    expect(robotsAllows(txt, "/cart", ROBOTS_AGENT)).toBe(false);
    expect(robotsAllows(txt, "/cart/share/1", ROBOTS_AGENT)).toBe(true);
    expect(robotsAllows(txt, "/c/tables?sort=price", ROBOTS_AGENT)).toBe(false);
    expect(robotsAllows(txt, "/exact", ROBOTS_AGENT)).toBe(false);
    expect(robotsAllows(txt, "/exact/more", ROBOTS_AGENT)).toBe(true);
    // equal length: Allow wins
    expect(robotsAllows("User-agent: *\nDisallow: /a\nAllow: /a\n", "/a", ROBOTS_AGENT)).toBe(true);
    expect(robotsAllows("", "/anything", ROBOTS_AGENT)).toBe(true);
  });

  it("Crawl-delay and Sitemap lines read", () => {
    expect(robotsCrawlDelay(txt, ROBOTS_AGENT)).toBe(5);
    expect(robotsCrawlDelay(txt, "OtherBot")).toBe(2);
    expect(robotsCrawlDelay("User-agent: *\nCrawl-delay: soon\n", ROBOTS_AGENT)).toBeNull();
    expect(robotsSitemaps(txt)).toEqual(["https://shop.example/sitemap.xml", "https://shop.example/products.xml"]);
    expect(robotsGroups(txt).get("brandpilotresearchbot")?.allow).toEqual(["/cart/share"]);
  });

  it("a hostile wildcard rule stays fast", () => {
    const rule = `/${"*a".repeat(200)}b`;
    const t = Date.now();
    expect(robotsAllows(`User-agent: *\nDisallow: ${rule}\n`, `/${"a".repeat(2000)}`, ROBOTS_AGENT)).toBe(true);
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe("crawlSite", () => {
  it("skips disallowed pages and still follows the rest (behaviour unchanged)", async () => {
    const pages: Record<string, string> = {
      "/robots.txt": "User-agent: *\nDisallow: /account\n",
      "/": '<title>Home</title><a href="/account">a</a><a href="/about">b</a>',
      "/about": "<title>About</title>",
    };
    m.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      const body = pages[path];
      return new Response(body ?? "", { status: body === undefined ? 404 : 200, headers: { "content-type": path.endsWith(".txt") ? "text/plain" : "text/html" } });
    };
    const res = await crawlSite("https://shop.example/");
    expect(res.pages.map((p) => p.title)).toEqual(["Home", "About"]);
    expect(res.failures).toEqual([{ url: "https://shop.example/account", error: "disallowed by robots.txt" }]);
  });
});

describe("jsonLdNodes", () => {
  it("flattens @graph and skips broken blocks", () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"Product","name":"Table"}]}</script><script type="application/ld+json">{bad</script>`;
    expect(jsonLdNodes(html).some((n) => n["@type"] === "Product")).toBe(true);
  });
});
