import { gzipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";

const safeFetchBytes = vi.hoisted(() => vi.fn());
vi.mock("@/server/research/crawl", async (importOriginal) => ({ ...(await importOriginal<object>()), safeFetchBytes }));

import { discoverProductUrls, parseSitemap } from "@/server/catalog/sitemap";

const enc = (s: string) => new TextEncoder().encode(s);
type Body = string | Uint8Array | { status?: number; body?: string | Uint8Array; truncated?: boolean };
let site: Record<string, Body>;
beforeEach(() => {
  site = {};
  safeFetchBytes.mockReset();
  safeFetchBytes.mockImplementation(async (url: string) => {
    const hit = site[url];
    const spec = hit === undefined ? { status: 404 } : typeof hit === "string" || hit instanceof Uint8Array ? { body: hit } : hit;
    const body = spec.body ?? "";
    return { url: new URL(url), status: spec.status ?? 200, bytes: typeof body === "string" ? enc(body) : body, contentType: "application/xml", truncated: spec.truncated ?? false };
  });
});

const O = "https://www.shop.test";
const urlset = (urls: (string | [string, string])[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((u) => (typeof u === "string" ? `<url><loc>${u}</loc></url>` : `<url><loc>${u[0]}</loc><lastmod>${u[1]}</lastmod></url>`))
    .join("")}</urlset>`;
const index = (children: string[]) =>
  `<?xml version="1.0"?><sitemapindex>${children.map((c) => `<sitemap><loc>${c}</loc></sitemap>`).join("")}</sitemapindex>`;
const fetched = () => safeFetchBytes.mock.calls.map((c) => c[0] as string);

describe("parseSitemap", () => {
  it("reads loc and lastmod in either order, CDATA and entities", () => {
    const xml = `<urlset><url><lastmod>2026-01-02</lastmod><loc>https://a.test/p/1?x=1&amp;y=2</loc></url><url><loc><![CDATA[https://a.test/p/2]]></loc></url></urlset>`;
    expect(parseSitemap(xml)).toEqual({ index: false, entries: [{ loc: "https://a.test/p/1?x=1&y=2", lastmod: "2026-01-02" }, { loc: "https://a.test/p/2", lastmod: null }] });
  });

  it("refuses a DOCTYPE", () => {
    expect(parseSitemap(`<!DOCTYPE x [<!ENTITY a "b">]><urlset><url><loc>https://a.test/p/1</loc></url></urlset>`)).toBeNull();
  });

  it("needs a urlset or sitemapindex root, optionally prefixed", () => {
    expect(parseSitemap("<html><loc>https://a.test/p/1</loc></html>")).toBeNull();
    expect(parseSitemap("")).toBeNull();
    expect(parseSitemap(`<sm:sitemapindex xmlns:sm="x"><sm:sitemap><loc>https://a.test/s.xml</loc></sm:sitemap></sm:sitemapindex>`)?.index).toBe(true);
    expect(parseSitemap(`<urlset
 xmlns="x"></urlset>`)).toEqual({ index: false, entries: [] });
  });

  it("stays linear on 200,000 entries without lastmod or closing tags", () => {
    const xml = "<urlset>" + "<loc>https://a.test/p/1</loc>".repeat(200_000);
    const t = performance.now();
    expect(parseSitemap(xml)!.entries).toHaveLength(200_000);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe("discoverProductUrls", () => {
  it("uses the robots Sitemap lines", async () => {
    site[`${O}/maps/products.xml`] = urlset([`${O}/chair`]);
    const res = await discoverProductUrls(O, `Sitemap: ${O}/maps/products.xml`);
    expect(res).toEqual({ urls: [{ url: `${O}/chair`, lastmod: null }], complete: true, capped: false });
    expect(fetched()).toEqual([`${O}/maps/products.xml`]);
  });

  it("falls back to /sitemap.xml, then /sitemap_index.xml, without calling a missing fallback incomplete", async () => {
    site[`${O}/sitemap_index.xml`] = index([`${O}/sitemap.products.xml`]);
    site[`${O}/sitemap.products.xml`] = urlset([`${O}/chair`]);
    const res = await discoverProductUrls(O, "");
    expect(res.complete).toBe(true);
    expect(res.urls.map((u) => u.url)).toEqual([`${O}/chair`]);
  });

  it("ignores a sitemap or child on another host; the bare host counts as the same site", async () => {
    site[`${O}/sitemap.xml`] = index(["https://evil.test/products.xml", "https://shop.test/products.xml"]);
    site["https://shop.test/products.xml"] = urlset(["https://shop.test/chair", "https://evil.test/chair"]);
    const res = await discoverProductUrls(O, "Sitemap: https://evil.test/sitemap.xml");
    expect(fetched()).not.toContain("https://evil.test/sitemap.xml");
    expect(fetched()).not.toContain("https://evil.test/products.xml");
    expect(res.urls.map((u) => u.url)).toEqual(["https://shop.test/chair"]);
  });

  it("prefers product children and reads them alone", async () => {
    site[`${O}/sitemap.xml`] = index([`${O}/sitemap.pages.xml`, `${O}/sitemap.produits.xml`, `${O}/sitemap.blog.xml`]);
    site[`${O}/sitemap.produits.xml`] = urlset([`${O}/table`]);
    const res = await discoverProductUrls(O, "");
    expect(fetched()).toEqual([`${O}/sitemap.xml`, `${O}/sitemap.produits.xml`]);
    expect(res.urls.map((u) => u.url)).toEqual([`${O}/table`]);
    expect(res.complete).toBe(true);
  });

  it("an emptied sitemap is never complete, so it deletes nothing", async () => {
    site[`${O}/sitemap.products.xml`] = urlset([]);
    expect(await discoverProductUrls(O, `Sitemap: ${O}/sitemap.products.xml`)).toEqual({ urls: [], complete: false, capped: false, reason: "no-product-pages" });
  });

  it("a /sitemap.xml that fails other than 404/410 makes the read incomplete even when /sitemap_index.xml answers", async () => {
    site[`${O}/sitemap.xml`] = { status: 503 };
    site[`${O}/sitemap_index.xml`] = index([`${O}/sitemap.products.xml`]);
    site[`${O}/sitemap.products.xml`] = urlset([`${O}/chair`]);
    const res = await discoverProductUrls(O, "");
    expect(res.complete).toBe(false);
    expect(res.urls.map((u) => u.url)).toEqual([`${O}/chair`]);
    site[`${O}/sitemap.xml`] = { status: 410 };
    expect((await discoverProductUrls(O, "")).complete).toBe(true);
  });

  it("a 200 that isn't a sitemap (maintenance page, JSON error) makes the read incomplete", async () => {
    site[`${O}/sitemap.products.xml`] = "<html><body>Back soon</body></html>";
    expect((await discoverProductUrls(O, `Sitemap: ${O}/sitemap.products.xml`)).complete).toBe(false);
    site[`${O}/sitemap.products.xml`] = '{"error":"maintenance"}';
    expect((await discoverProductUrls(O, `Sitemap: ${O}/sitemap.products.xml`)).complete).toBe(false);
  });

  it("an http sitemap under an https site isn't fetched", async () => {
    site[`${O}/sitemap.xml`] = index(["http://www.shop.test/products.xml", `${O}/products-2.xml`]);
    site[`${O}/products-2.xml`] = urlset([`${O}/chair`]);
    await discoverProductUrls(O, "Sitemap: http://www.shop.test/sitemap.xml");
    expect(fetched().filter((u) => u.startsWith("http:"))).toEqual([]);
  });

  it("without a product sitemap keeps product-looking paths only, else says no-product-pages", async () => {
    site[`${O}/sitemap.xml`] = urlset([`${O}/about`, `${O}/p/1`, `${O}/products/chair`, `${O}/table-p-42`, `${O}/produit/x`, `${O}/blog/productivity`]);
    const res = await discoverProductUrls(O, "");
    expect(res.urls.map((u) => u.url).sort()).toEqual([`${O}/p/1`, `${O}/products/chair`, `${O}/produit/x`, `${O}/table-p-42`]);
    site[`${O}/sitemap.xml`] = urlset([`${O}/about`]);
    expect(await discoverProductUrls(O, "")).toEqual({ urls: [], complete: false, capped: false, reason: "no-product-pages" });
  });

  it("keeps at most 50,000 entries (incomplete) and checks robots.txt on the newest 5,000 only", async () => {
    site[`${O}/sitemap.products.xml`] = urlset(Array.from({ length: 60_000 }, (_, i) => [`${O}/p/${i}`, new Date(Date.UTC(2020, 0, 1) + i * 60_000).toISOString()] as [string, string]));
    const robots = `Sitemap: ${O}/sitemap.products.xml\nUser-agent: *\nDisallow: /p/49999\n`;
    const t = performance.now();
    const res = await discoverProductUrls(O, robots);
    expect(performance.now() - t).toBeLessThan(5000);
    expect(res).toMatchObject({ complete: false, capped: true });
    expect(res.urls).toHaveLength(4999); // the newest 5,000 of the first 50,000, less the disallowed one
    expect(res.urls[0]!.url).toBe(`${O}/p/49998`);
  });

  it("no sitemap at all → incomplete, no-product-pages", async () => {
    expect(await discoverProductUrls(O, "")).toEqual({ urls: [], complete: false, capped: false, reason: "no-product-pages" });
  });

  it("stops a gz that claims a small size but inflates past 20 MB", async () => {
    const big = gzipSync(enc(urlset([`${O}/products/a`]) + " ".repeat(21 * 1024 * 1024)));
    new DataView(big.buffer, big.byteOffset).setUint32(big.length - 4, 100, true); // the lying ISIZE trailer
    site[`${O}/sitemap.xml`] = index([`${O}/products-1.xml.gz`, `${O}/products-2.xml.gz`]);
    site[`${O}/products-1.xml.gz`] = big;
    site[`${O}/products-2.xml.gz`] = gzipSync(enc(urlset([`${O}/products/b`])));
    const res = await discoverProductUrls(O, "");
    expect(res.complete).toBe(false);
    expect(res.urls.map((u) => u.url)).toEqual([`${O}/products/b`]);
  });

  it("a truncated, failed or non-200 child makes the read incomplete but keeps what was read", async () => {
    site[`${O}/sitemap.xml`] = index([`${O}/products-1.xml`, `${O}/products-2.xml`]);
    site[`${O}/products-1.xml`] = { body: urlset([`${O}/products/a`]), truncated: true };
    site[`${O}/products-2.xml`] = urlset([`${O}/products/b`]);
    const res = await discoverProductUrls(O, "");
    expect(res.complete).toBe(false);
    expect(res.urls).toHaveLength(2);

    site[`${O}/products-1.xml`] = { status: 500 };
    expect((await discoverProductUrls(O, "")).complete).toBe(false);
    const served = safeFetchBytes.getMockImplementation()!;
    safeFetchBytes.mockImplementation(async (url: string) => {
      if (url.endsWith("products-1.xml")) throw new Error("connection reset");
      return served(url);
    });
    expect((await discoverProductUrls(O, "")).complete).toBe(false);
  });

  it("a 51st child makes the read incomplete and isn't fetched", async () => {
    const kids = Array.from({ length: 51 }, (_, i) => `${O}/products-${i}.xml`);
    site[`${O}/sitemap.xml`] = index(kids);
    for (const k of kids) site[k] = urlset([`${k.replace(".xml", "")}/p/1`]);
    const res = await discoverProductUrls(O, "");
    expect(res.complete).toBe(false);
    expect(fetched()).not.toContain(kids[50]);
    expect(res.urls).toHaveLength(50);
  });

  it("drops URLs robots.txt disallows (our group first)", async () => {
    site[`${O}/sitemap.xml`] = urlset([`${O}/products/a`, `${O}/products/private/b`, `${O}/products/c?sort=1`]);
    const robots = "User-agent: *\nDisallow: /\n\nUser-agent: BrandpilotResearchBot\nDisallow: /products/private\nDisallow: /*?sort=";
    const res = await discoverProductUrls(O, robots);
    expect(res.urls.map((u) => u.url)).toEqual([`${O}/products/a`]);
  });

  it("de-duplicates, sorts newest lastmod first and caps at 5,000", async () => {
    const urls: [string, string][] = Array.from({ length: 5002 }, (_, i) => [`${O}/p/${i}`, new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()]);
    site[`${O}/sitemap.xml`] = urlset([...urls, urls[0], `${O}/p/undated`]);
    const res = await discoverProductUrls(O, "");
    expect(res.capped).toBe(true);
    expect(res.complete).toBe(false); // the pages past the cap are still on the site: nothing may be deleted
    expect(res.urls).toHaveLength(5000);
    expect(res.urls[0].url).toBe(`${O}/p/5001`);
    expect(res.urls.at(-1)!.url).toBe(`${O}/p/2`);
  });
});
