import { afterEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  // What the pinned (connect-time) lookup sees; the pre-check below always sees a public address.
  connectAddress: "127.0.0.1",
  fetch: null as null | ((url: URL | string, init?: unknown) => Promise<Response>),
}));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));
vi.mock("node:dns", () => ({
  lookup: (_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
    const a = { address: m.connectAddress, family: m.connectAddress.includes(":") ? 6 : 4 };
    if (opts.all) cb(null, [a]);
    else cb(null, a.address, a.family);
  },
}));
vi.mock("undici", async (orig) => {
  const actual = await orig<typeof import("undici")>();
  return { ...actual, fetch: (url: URL | string, init?: unknown) => (m.fetch ?? (actual.fetch as never as NonNullable<typeof m.fetch>))(url, init) };
});

import { CrawlError, crawlSite, fetchRobots, jsonLdNodes, pinnedLookup, ROBOTS_AGENT, robotsAllows, robotsGroups, robotsRules, robotsSitemaps, safeFetch } from "@/server/research/crawl";

afterEach(() => {
  m.fetch = null;
  m.connectAddress = "127.0.0.1";
});

const allows = (txt: string, path: string, agent = ROBOTS_AGENT) => robotsAllows(robotsRules(txt, agent), path);
const lookupOne = (all: boolean) =>
  new Promise<unknown[]>((ok) => pinnedLookup("x.example", { all }, (...a: unknown[]) => ok(a)));

describe("pinned lookup", () => {
  it("refuses a host that passed the check but rebinds to 127.0.0.1 at connect", async () => {
    const err = await safeFetch("http://rebind.example/").then(() => null, (e: unknown) => e as Error & { cause?: Error });
    expect(err).not.toBeNull();
    expect(String(err?.cause?.message ?? err?.message)).toMatch(/Private or local/);
    expect(err?.cause).toBeInstanceOf(CrawlError);
  });

  it("refuses an IPv6 loopback at connect too", async () => {
    m.connectAddress = "::1";
    const err = await safeFetch("http://rebind.example/").then(() => null, (e: unknown) => e as Error & { cause?: Error });
    expect(err?.cause).toBeInstanceOf(CrawlError);
  });

  it("answers single-address lookups (options.all false) with the checked address", async () => {
    m.connectAddress = "2606:4700::1111";
    expect(await lookupOne(false)).toEqual([null, "2606:4700::1111", 6]);
    expect(await lookupOne(true)).toEqual([null, [{ address: "2606:4700::1111", family: 6 }]]);
    m.connectAddress = "10.0.0.1";
    expect((await lookupOne(false))[0]).toBeInstanceOf(CrawlError);
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
    expect(allows(txt, "/products/table")).toBe(true);
    expect(allows(txt, "/products/table", "OtherBot")).toBe(false);
  });

  it("a versioned User-agent line matches our token", () => {
    expect(allows("User-agent: BrandpilotResearchBot/0.1\nDisallow: /\n", "/x")).toBe(false);
  });

  it("Allow beats a shorter Disallow; wildcards and $ match", () => {
    expect(allows(txt, "/cart")).toBe(false);
    expect(allows(txt, "/cart/share/1")).toBe(true);
    expect(allows(txt, "/c/tables?sort=price")).toBe(false);
    expect(allows(txt, "/exact")).toBe(false);
    expect(allows(txt, "/exact/more")).toBe(true);
    // equal length: Allow wins
    expect(allows("User-agent: *\nDisallow: /a\nAllow: /a\n", "/a")).toBe(true);
    expect(allows("", "/anything")).toBe(true);
  });

  it("Crawl-delay and Sitemap lines read", () => {
    expect(robotsRules(txt, ROBOTS_AGENT).crawlDelay).toBe(5);
    expect(robotsRules(txt, "OtherBot").crawlDelay).toBe(2);
    expect(robotsRules("User-agent: *\nCrawl-delay: soon\n", ROBOTS_AGENT).crawlDelay).toBeNull();
    expect(robotsSitemaps(txt)).toEqual(["https://shop.example/sitemap.xml", "https://shop.example/products.xml"]);
    expect(robotsGroups(txt).get("brandpilotresearchbot")?.allow).toEqual(["/cart/share"]);
  });

  it("a hostile wildcard rule stays fast", () => {
    const rule = `/${"*a".repeat(200)}b`;
    const t = Date.now();
    expect(allows(`User-agent: *\nDisallow: ${rule}\n`, `/${"a".repeat(2000)}`)).toBe(true);
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe("fetchRobots", () => {
  const status = (code: number) => {
    m.fetch = async () => new Response(code === 200 ? "User-agent: *\nDisallow: /a\n" : "", { status: code });
    return fetchRobots("https://shop.example");
  };

  it("2xx text, 4xx allow all, 5xx and failures disallow all", async () => {
    await expect(status(200)).resolves.toEqual({ txt: "User-agent: *\nDisallow: /a\n", disallowAll: false });
    await expect(status(404)).resolves.toEqual({ txt: null, disallowAll: false });
    await expect(status(503)).resolves.toEqual({ txt: null, disallowAll: true });
    m.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(fetchRobots("https://shop.example")).resolves.toEqual({ txt: null, disallowAll: true });
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

  it("reads nothing when robots.txt answers 5xx", async () => {
    m.fetch = async (url) =>
      new Response("<title>x</title>", { status: String(url).endsWith("robots.txt") ? 500 : 200, headers: { "content-type": "text/html" } });
    const res = await crawlSite("https://shop.example/");
    expect(res.pages).toEqual([]);
    expect(res.failures[0].error).toBe("disallowed by robots.txt");
  });
});

describe("jsonLdNodes", () => {
  it("flattens @graph and skips broken blocks", () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"Product","name":"Table"}]}</script><script type="application/ld+json">{bad</script>`;
    expect(jsonLdNodes(html).some((n) => n["@type"] === "Product")).toBe(true);
  });
});
