import { describe, expect, it } from "vitest";
import { urlKey, urlPath, urlVariants } from "@/shared";

describe("urlKey", () => {
  it("treats http/https, www, case of the host and a trailing slash as one page", () => {
    expect(urlKey("http://WWW.x.com/a/")).toBe("x.com/a");
    expect(urlKey("https://x.com/a")).toBe("x.com/a");
    expect(urlKey("http://WWW.x.com/a/")).toBe(urlKey("https://x.com/a"));
  });

  it("drops the query string and the fragment", () => {
    expect(urlKey("https://x.com/p/oak?variant=12&utm_source=a#reviews")).toBe("x.com/p/oak");
  });

  it("keeps the root and keeps different paths apart", () => {
    expect(urlKey("https://www.x.com")).toBe("x.com/");
    expect(urlKey("https://x.com/?a=1")).toBe("x.com/");
    expect(urlKey("https://x.com/a")).not.toBe(urlKey("https://x.com/a/b"));
  });

  it("returns null for other schemes and unparsable text", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "mailto:a@x.com", "not a url", ""]) expect(urlKey(bad), bad).toBeNull();
  });

  it("gives Unicode and punycode spellings of a host one key", () => {
    expect(urlKey("https://bücher.de/a")).toBe("xn--bcher-kva.de/a");
    expect(urlKey("https://xn--bcher-kva.de/a/")).toBe("xn--bcher-kva.de/a");
  });
});

describe("urlVariants", () => {
  it("lists the 8 stored spellings of a deep page", () => {
    const v = urlVariants("https://x.com/a/b?q=1");
    expect(v).toHaveLength(8);
    expect(v).toEqual(
      expect.arrayContaining([
        "http://x.com/a/b",
        "http://x.com/a/b/",
        "https://x.com/a/b",
        "https://x.com/a/b/",
        "http://www.x.com/a/b",
        "http://www.x.com/a/b/",
        "https://www.x.com/a/b",
        "https://www.x.com/a/b/",
      ]),
    );
    for (const s of v) expect(urlKey(s)).toBe("x.com/a/b");
  });

  it("lists 4 for the root", () => {
    expect(urlVariants("http://www.x.com").sort()).toEqual(["http://www.x.com/", "http://x.com/", "https://www.x.com/", "https://x.com/"]);
  });

  it("is empty for a non-http URL", () => {
    expect(urlVariants("javascript:alert(1)")).toEqual([]);
  });
});

describe("urlPath", () => {
  it("gives the key's path", () => {
    expect(urlPath("https://www.x.com/products/oak/?v=1")).toBe("/products/oak");
    expect(urlPath("https://x.com")).toBe("/");
    expect(urlPath("data:x")).toBeNull();
  });
});
