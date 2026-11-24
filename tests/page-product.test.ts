import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/jobs/queue", () => ({ enqueueJob: vi.fn() }));

import { pageProducts } from "@/server/catalog/page-product";

const PAGE = "https://www.shop.test/p/chair";
const ld = (...blocks: unknown[]) => blocks.map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join("\n");
const product = (extra: Record<string, unknown> = {}) => ({
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Oak chair",
  sku: "CH-1",
  url: "https://shop.test/p/chair",
  image: ["https://cdn.shop.test/chair.jpg", "https://cdn.shop.test/chair-2.jpg"],
  offers: { "@type": "Offer", price: "129.90", priceCurrency: "EUR", availability: "https://schema.org/InStock" },
  ...extra,
});

// recorded 2026-11-24 from a furniture retailer's product page
const RECORDED = `
<script type="application/ld+json">{"@context":"https://schema.org","@type":"ProductGroup","name":"Canapé cuir Classique","description":"<p>Canapé Classique : <b>l'emblème de l'élégance en cuir.</b><br>Finitions réalisées par des selliers italiens.</p>","brand":{"@type":"Brand","name":"HOUSE BRAND"},"productGroupID":"02001021","variesBy":["https://schema.org/color"],"hasVariant":[{"@type":"Product","sku":"020010210318","name":"Canapé cuir Classique","description":"<p>Canapé Classique : <b>l'emblème de l'élégance en cuir.</b><br>Finitions réalisées par des selliers italiens.</p>","brand":{"@type":"Brand","name":"HOUSE BRAND"},"offers":{"@type":"Offer","url":"https://www.furniture.example/p/canape-cuir-pleine-fleur-2-6mm-classique-02001021?id=020010210318","priceCurrency":"EUR","price":3299,"availability":"https://schema.org/InStock"},"image":"https://cdn.furniture.example/m/18bb0c7d7a40e959/Web_JPG-2D_CANAPE_CUIR_2_4_PLACES_ROUGE_VZ_CLASSIQUE_02001021.jpg","color":"Rouge ","gtin13":"3661558163080"},{"@type":"Product","sku":"020010210325","name":"Canapé cuir Classique","description":"<p>Canapé Classique : <b>l'emblème de l'élégance en cuir.</b><br>Finitions réalisées par des selliers italiens.</p>","brand":{"@type":"Brand","name":"HOUSE BRAND"},"offers":{"@type":"Offer","url":"https://www.furniture.example/p/canape-cuir-pleine-fleur-2-6mm-classique-02001021?id=020010210325","priceCurrency":"EUR","price":3499,"availability":"https://schema.org/InStock"},"image":"https://cdn.furniture.example/m/1adb6faa09164358/Web_JPG-2D_CANAPE_CUIR_3_PLACES_ROUGE_VZ_CLASSIQUE_2001021.jpg","color":"Rouge ","gtin13":"3661558163141"}],"offers":{"@type":"AggregateOffer","lowPrice":3299,"highPrice":3499,"offerCount":2,"priceCurrency":"EUR"},"aggregateRating":{"@type":"AggregateRating","ratingValue":4.5541666666667,"reviewCount":45}}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","item":{"@type":"Thing","name":"Accueil","@id":"/"},"position":1},{"@type":"ListItem","item":{"@type":"Thing","name":"Canapés et fauteuils","@id":"/c/canapes-et-fauteuils"},"position":2},{"@type":"ListItem","item":{"@type":"Thing","name":"Canapés","@id":"/c/canapes-et-fauteuils/canapes"},"position":3},{"@type":"ListItem","item":{"@type":"Thing","name":"Canapés droits","@id":"/c/canapes-et-fauteuils/canapes/canapes-droits"},"position":4}]}</script>
`;

describe("pageProducts", () => {
  it("Product with Offer", () => {
    expect(pageProducts(`<html><head>${ld(product({ category: "Chairs", description: "Solid oak" }))}</head></html>`, PAGE)).toEqual([{
      externalId: "sku:CH-1",
      sku: "CH-1",
      title: "Oak chair",
      url: "https://shop.test/p/chair",
      category: "Chairs",
      description: "Solid oak",
      price: "129.90",
      compareAtPrice: null,
      currency: "EUR",
      inStock: true,
      stockQuantity: null,
      imageUrl: "https://cdn.shop.test/chair.jpg",
    }]);
  });

  it("AggregateOffer lowPrice", () => {
    const [row] = pageProducts(ld(product({ offers: { "@type": "AggregateOffer", lowPrice: 99, highPrice: 149, priceCurrency: "GBP" } })), PAGE);
    expect(row).toMatchObject({ price: "99.00", currency: "GBP", inStock: null });
  });

  it("ProductGroup variants (recorded page)", () => {
    const rows = pageProducts(RECORDED, "https://www.furniture.example/p/canape-cuir-pleine-fleur-2-6mm-classique-02001021?id=020010210325");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      externalId: "sku:020010210318",
      title: "Canapé cuir Classique — Rouge",
      url: "https://www.furniture.example/p/canape-cuir-pleine-fleur-2-6mm-classique-02001021?id=020010210318",
      category: "Canapés droits",
      price: "3299.00",
      currency: "EUR",
      inStock: true,
      imageUrl: expect.stringMatching(/^https:\/\/cdn\.furniture\.example\/.*\.jpg$/),
    });
    expect(rows[0].description).toBe("Canapé Classique : l'emblème de l'élégance en cuir. \nFinitions réalisées par des selliers italiens.");
    expect(rows[1]).toMatchObject({ externalId: "sku:020010210325", price: "3499.00" });
  });

  it("variants without sku take the group's fields and a numbered key", () => {
    const group = {
      "@type": "ProductGroup", name: "Lamp", url: "https://shop.test/p/lamp", image: "/img/lamp.jpg",
      hasVariant: [{ "@type": "Product", color: "Red" }, { "@type": "Product", color: "Blue", offers: { price: 20 } }],
    };
    const rows = pageProducts(ld(group), PAGE);
    expect(rows.map((r) => [r.externalId, r.title, r.imageUrl, r.price])).toEqual([
      ["url:https://shop.test/p/lamp#0", "Lamp — Red", "https://www.shop.test/img/lamp.jpg", null],
      ["url:https://shop.test/p/lamp#1", "Lamp — Blue", "https://www.shop.test/img/lamp.jpg", "20.00"],
    ]);
  });

  it("@graph", () => {
    const rows = pageProducts(ld({ "@context": "https://schema.org", "@graph": [{ "@type": "WebPage", name: "Shop" }, product({ sku: undefined, gtin13: "123" })] }), PAGE);
    expect(rows.map((r) => r.externalId)).toEqual(["sku:123"]);
  });

  it("availability mapping", () => {
    const stock = (availability: string) => pageProducts(ld(product({ offers: { price: 1, availability } })), PAGE)[0].inStock;
    expect(stock("https://schema.org/InStock")).toBe(true);
    expect(stock("http://schema.org/OutOfStock")).toBe(false);
    expect(stock("PreOrder")).toBe(true);
    expect(stock("https://schema.org/BackOrder")).toBe(true);
    expect(stock("https://schema.org/Discontinued")).toBeNull();
    expect(stock("https://schema.org/constructor")).toBeNull();
  });

  it("bad currency dropped", () => {
    expect(pageProducts(ld(product({ offers: { price: 5, priceCurrency: "euro" } })), PAGE)[0]).toMatchObject({ price: "5.00", currency: null });
  });

  it("HTML stripped", () => {
    const [row] = pageProducts(ld(product({ name: "Oak &amp; <b>ash</b> chair", description: "<p>Hand<br>made</p><style>p { color: red }</style>" })), PAGE);
    expect(row.title).toBe("Oak & ash chair");
    expect(row.description).toBe("Hand\nmade");
  });

  it("other-host canonical ignored", () => {
    const [row] = pageProducts(ld(product({ sku: undefined, url: "https://evil.test/p/chair", image: "javascript:alert(1)" })), PAGE);
    expect(row).toMatchObject({ url: PAGE, externalId: `url:${PAGE}`, imageUrl: null });
  });

  it("201 variants → 200", () => {
    const hasVariant = Array.from({ length: 201 }, (_, i) => ({ "@type": "Product", sku: `V${i}` }));
    expect(pageProducts(ld({ "@type": "ProductGroup", name: "Rug", hasVariant }), PAGE)).toHaveLength(200);
  });

  it("no Product → []", () => {
    expect(pageProducts(`${ld({ "@type": "WebSite", name: "Shop" })}<script type="application/ld+json">{broken</script>`, PAGE)).toEqual([]);
  });

  it("a product only mentioned as related is skipped", () => {
    expect(pageProducts(ld(product({ isRelatedTo: { "@type": "Product", name: "Other", sku: "X" } })), PAGE).map((r) => r.sku)).toEqual(["CH-1"]);
  });
});
