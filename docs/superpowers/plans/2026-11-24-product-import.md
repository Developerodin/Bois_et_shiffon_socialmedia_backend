# Product import (CSV / Excel) and website product-page reader

> **Review log:** written 2026-11-24 from the owner's choices (auto-match + preview; re-import updates and archives missing; build the site reader now too). Four-lens plan review done the same day; every Critical and Important finding is folded in below (summary at the end). **Shipped as two merges:** Part A (file import) first, then Part B (site reader), each with its own four-lens branch review.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A brand whose website isn't a Shopify store still gets its catalogue: (A) by uploading a CSV or Excel file, with columns matched automatically and fixable in a preview, re-imports updating the same products; (B) automatically, by reading the products listed in the website's sitemap from the product data embedded in each page (schema.org `Product` JSON-LD), a little each day.

**Why:** Camif (camif.fr: no `/products.json`, 404) and Tikamoon (tikamoon.com: 403, blocks automated readers) show "No products yet". Camif's sitemap index lists `sitemap.products.xml` with ~8,000 product URLs and each product page carries `Product` JSON-LD (checked 2026-11-24). Tikamoon blocks the whole site, so for it only the file import works.

**Architecture:** Two new `ProductSource` values: `IMPORT` (rows from a file, person-owned) and `SITE` (rows read from product pages). Both reuse `saveRows` in `server/catalog/sync.ts`, made source-generic, transaction-capable and batched. The file import is one stateless route called twice (`dryRun` preview, then import with the same file + mapping); nothing is stored. The site reader is its own job type `catalog.pages`, **outside** the `data.%` cap with its own cap of one runner, reading due pages politely under per-brand and per-host budgets, tracked in a `CatalogPage` table (resumable per-URL state across days needs it).

**Tech Stack:** Next.js routes, Prisma 6, zod, vitest; `fflate` (already a dependency) streaming `Unzip`/`Gunzip` with byte counting; no new dependency. Web Products page; mobile shared copy, labels and reasons only (no import UI on the phone).

**Estimate:** 10 dev days: Part A 5 d (Tasks 1–4), Part B 5 d (Tasks 5–9).

---

## Decisions (owner, 2026-11-24)

1. Columns are **auto-matched from headers (English and French) and shown in a preview** with one dropdown per column; the person fixes and imports.
2. **Re-import updates and archives missing:** rows matched to stored `IMPORT` rows; new ones added; `IMPORT` products absent from the new file are archived. `MANUAL` and synced products are never touched by an import.
3. **Build the site reader now** alongside the import (second merge).

## My calls (owner may override)

1. **Formats:** `.csv` (comma, semicolon or tab, detected; UTF-8 with or without BOM, UTF-16 with BOM, else Windows-1252) and `.xlsx` (first sheet). Old `.xls` / `.numbers` → "Save it as .xlsx or CSV". Limits enforced **while parsing**: 5 MB file, 5,000 data rows, 50 columns, 10,000 chars per cell, 20 MB inflated per zip entry and 30 MB in all.
2. **Fields:** title (required), SKU, link, image link, price, compare-at price, currency, category, description, in stock (yes/no, oui/non, 1/0, "in stock"/"en stock"/"out of stock"/"rupture"), stock quantity, materials, dimensions, certifications. Prices parsed with the existing `amountOf` (`server/content/product-checks.ts:88`, exported), which handles `1 299,00`, `1.299,00`, `1,299.00`; same caps as `ProductInput`.
3. **Who:** `context.edit` to import. Columns in `VOUCHED_FIELDS` (prices, stock, materials, dimensions, certifications) need **`rules.approve`** as for hand edits: without it the preview shows those columns as "needs approval rights" and the import refuses a mapping that includes them (403 `cannotVouch`). Rate limits: 30 calls/h per brand+user and 60/h per user across brands (`hitRateLimit`). Audit `product.import` with counts and mapped fields.
4. **Matching on re-import** (keeps the stored row, its links and its person-entered facts): an incoming row matches a stored `IMPORT` row by SKU, else link, else title (normalised); a match keeps its `id` and gets the new `externalId`; unmatched rows are created. `externalId` = `sku:<sku>` / `url:<normalised link>` / `title:<normalised title>`. Duplicate keys in one file: last wins, reported ("N rows had the same SKU/link/name; the last one was kept"), so variants without SKUs should carry one.
5. **IMPORT rows are person-owned:** editable and deletable in the product form like `MANUAL` (PATCH/DELETE allow `IMPORT`); stock is **always fresh** like `MANUAL` (`stockState`), with `stockCheckedAt` = import time shown as "checked … ago". An empty cell on re-import never blanks a stored person-owned field (materials, dimensions, certifications); an empty price/stock cell does clear (the file is the catalogue).
6. **Bad rows are skipped and reported** (row number + reason, first 50 shown). An import with zero good rows writes and archives nothing.
7. **Site reader order:** Shopify connection → website `/products.json` → **site pages** (only when the feed said "not a feed", never when the site blocked us). `catalogSource` returns `SITE` for such a brand, so status and labels say "from your website's product pages".
8. **Politeness:** one request at a time per **host** (www stripped), whichever brand asks; ≥ 1 s between requests, more if robots.txt `Crawl-delay` says (up to 10 s); our own robots group before `*`; robots.txt that fails (5xx/timeout) = disallow all for this job. Budgets: **1,000 pages per brand per UTC day and 1,500 per host per day.** A page is re-read when its sitemap `lastmod` changed or it was last read more than 7 days ago, with `If-None-Match`/`If-Modified-Since` (304 = no body). First fill of a big site takes days (Camif ~8 days for 8,000).
9. **Cap 5,000 product pages per brand** (same `MAX_ROWS` ceiling as feeds), newest `lastmod` first; at most 200 rows per page; the screen says when the cap applies.
10. **SITE stock freshness:** a SITE row is fresh for 8 days after its page was read (the 7-day refresh + a day), instead of the 50 h for feeds.
11. **Archiving for SITE:** a product is archived when no remaining page produces it (its page left a **complete** sitemap read, answers 404/410, or no longer carries that `Product`). Never because a run stopped early, a sitemap was cut off, or a page failed.
12. **Switching sources:** a brand that gains a Shopify connection or a working feed archives `SITE` rows (as `WEBSITE` ↔ `SHOPIFY` today); links to SITE rows are resolved by link/SKU (Task 9). `IMPORT` rows are never archived by a sync.

## Facts from the code (2026-11-24, checked by the plan review)

- `enum ProductSource { WEBSITE SHOPIFY MANUAL }` (`prisma/schema.prisma:1050`); `Product @@unique([brandId, source, externalId])`; `materials`/`dimensions`/`certifications` are person fields, not in `SyncedRow`.
- `server/catalog/sync.ts`: `websiteFeed` (`BLOCKED` on 401/403, `NOT_A_FEED` otherwise), `saveRows(scope, source, fetched)` reads **every** stored row of the source (`OWNED`), createMany new, **updates one by one**, `stockCheckedAt` bulk, archives via `archiveWhere` (only when `complete`); `archiveWhere` archives the *other* synced source (`SHOPIFY` ↔ `WEBSITE`); `archiveShopifyRows`; `record()` **replaces** `BrandProfile.catalogSync` wholesale; `catalogSyncRunning` looks only at `catalog.sync` jobs; `MAX_ROWS = 5000`; `DEADLINE_MS = 240 s`.
- `server/catalog/products.ts`: `ProductInput`, `PERSON_FIELDS`, `VOUCHED_FIELDS` (need `rules.approve`), `vouchedIn`, `cannotVouch`. `products/[productId]/route.ts:41,70`: PATCH/DELETE refuse non-`MANUAL` except person fields.
- `server/content/product-checks.ts:76`: `stockState` — `MANUAL` always fresh, others stale after 50 h (`STALE_MS`). `amountOf` (line 88, not exported).
- `server/catalog/linked.ts:11-18` `otherSourceId` and the facts copy in `saveRows` cover `WEBSITE` ↔ `SHOPIFY` only. `server/content/knowledge.ts:57` `productIdsForPhoto` orders by source name.
- `server/research/crawl.ts`: `safeFetch` (1 MB cap, `MAX_BYTES`), `safeFetchBytes(url, accept, maxBytes, signal, timeout)` (returns `truncated`, re-checks each redirect hop; DNS can rebind between check and connect — noted at lines 8–9), `robotsGroups`/`parseRobots` (Disallow only, `*` group), inline disallow check in `crawlSite` (~511), `jsonLdNodes` (internal), `pageAssets` (Product name/url/image only). `server/research/site-facts.ts` probes robots.txt and sitemap.
- Queue: `enqueueJob` upserts on `idempotencyKey` with `update: {}` (an existing key returns the old job whatever its status); `claimNextJob` caps `type LIKE 'data.%'` at 2 runners (`queue.ts:62`), ordered by `runAt`.
- Uploads: `media/route.ts` — authorize, rate limit, `Content-Length` guard (chunked refused), then `formData()`.
- Types to extend: `shared/products.ts` (`SyncReason`, `CatalogSync`), web `components/products/api.ts:9,33`, mobile `src/api/endpoints.ts:462,468,470`; web `products-board.tsx:432,446,454,479` (`=== "MANUAL"` branches).
- `shared/csv.ts` is export-only (`toCsv`); the CSV reader is new.

## Global constraints

Branch `product-import` in server, web, mobile (from `main`; carries the uncommitted "blocked" message change). Migrations: `ProductSource` values in their **own** migration (`ALTER TYPE … ADD VALUE`). Every query scoped `workspaceId AND brandId`, and every archive/update by key also by `source`. No upload is stored. Imported and page-read text is plain text (`htmlText`), never rendered as HTML; links only `http(s)` (`httpUrl`); cells are data (no formula evaluated). en + fr web copy; mobile strings in every locale folder under `src/i18n/locales`. One commit per repo per task. Checks: server `npm test`, `typecheck`, `lint`, `test:db`; web `npm test`, `typecheck`, `lint`; mobile `npx tsc --noEmit`. No web build while `next dev` runs.

## Review focus

1. An import never touches `MANUAL`, `SHOPIFY`, `WEBSITE` or `SITE` rows; a failed or all-bad import archives nothing; re-import keeps ids, links and facts.
2. Prices and stock can't be set by import without `rules.approve`.
3. A malicious file or sitemap (zip/gzip bomb with a lying size, sparse `XFD1` cells, DOCTYPE, 1 M rows, huge cells, `javascript:` links) is refused while parsing, without large allocations.
4. The page reader never fetches a private address (pinned lookup), never ignores robots.txt, never exceeds per-brand or per-host budgets, never runs two chains for one brand, and never archives on a partial run.
5. Two imports at once, or an import during a sync, leave consistent rows.
6. 5,000 changed rows save in a bounded number of queries inside the deadline.

---

## Part A: file import (5 d) — merge 1

### Task 1: Generic, batched, transaction-capable `saveRows` (1 d)

**Files:** `prisma/schema.prisma` + migration (`ProductSource` += `IMPORT`, `SITE`), `server/catalog/sync.ts`, `server/catalog/products.ts` (PATCH/DELETE rule moved to a helper `personOwned(source)` = `MANUAL | IMPORT`), `app/.../products/[productId]/route.ts`, `server/content/product-checks.ts` (`stockState`: `IMPORT` fresh like `MANUAL`; SITE threshold constant for Part B; export `amountOf`), `server/content/knowledge.ts` (source order explicit: SHOPIFY, WEBSITE, SITE, IMPORT, MANUAL), `shared/products.ts`. Tests `tests/db/catalog-save.db.test.ts`, existing catalog tests.

- `saveRows(db, scope, source, fetched, opts?)`: `db` is `prisma` or a transaction client. `opts.keys`: read only stored rows with `externalId IN keys` (used by Part B batches; uses the unique index); default reads the whole source (needed to archive). `opts.match` (IMPORT): a function mapping incoming rows to stored ids (My calls 4).
- Changed rows written with one `UPDATE "Product" p SET … , "updatedAt" = now(), "archivedAt" = NULL, "stockCheckedAt" = … FROM unnest($ids::text[], $titles::text[], $prices::numeric[], $stock::int[], $inStock::boolean[], …) AS u(…) WHERE p.id = u.id AND p."workspaceId" = $w AND p."brandId" = $b` per chunk of 1,000 (tagged SQL, every array cast explicitly). Replaces the row-by-row loop and the separate `stockCheckedAt` updateMany for those rows.
- For `IMPORT`, person fields ride in the row: written when non-empty, never blanked by an empty cell.
- `archiveWhere`: one list `AUTOMATIC = ["SHOPIFY","WEBSITE","SITE"]`. An automatic source with a complete fetch archives unseen rows of itself and all rows of the other automatic sources; `IMPORT` archives only unseen `IMPORT` rows; `MANUAL` never. A test pins today's `WEBSITE`/`SHOPIFY` result unchanged.
- Grep step: every `ProductSource`, `source ===`, `"MANUAL"` and `CatalogSync["source"]` use in the three repos; list each in the commit body with what was done (label, editable, grouping).

- [ ] Tests: db `IMPORT save archives only unseen IMPORT rows`; `WEBSITE/SHOPIFY archive unchanged` (pinned); `incomplete fetch archives nothing`; `5,000 changed rows: ≤ 6 queries and < 5 s` on sma-testdb; `keys mode reads only those rows`; `runs inside a passed transaction`; `IMPORT row editable via PATCH incl. price with rules.approve`; `IMPORT stock always fresh`; existing tests green.
- [ ] Commit: "Let imported products share the catalogue save, which now writes changes in batches and can run in a transaction".

### Task 2: Read CSV and XLSX (1.25 d)

**Files:** create `server/catalog/import-file.ts`, tests `tests/import-file.test.ts` (CSV strings, `.xlsx` via `toXlsx` + hand-made zips).

**Interfaces:** `parseSheet(bytes) → { headers: string[]; rows: string[][] } | { error: string }`.
- Type from magic bytes: `PK\x03\x04` → xlsx; `D0 CF 11 E0` → "Save it as .xlsx or CSV"; else CSV.
- CSV: RFC 4180 quotes, CRLF/LF, delimiter = most frequent of `,` `;` `\t` in the first line outside quotes; decoding: UTF-16 BOM → UTF-16; UTF-8 (fatal decoder, BOM stripped) else Windows-1252. Limits checked as it scans (row 5,001 → stop with error; column 51 → error; cell > 10,000 chars cut).
- XLSX with fflate's **streaming `Unzip` + `UnzipInflate`**, counting inflated bytes in `ondata` and terminating past 20 MB per entry / 30 MB total (the header `originalSize` is not trusted). Pass 1 reads `xl/workbook.xml` + `xl/_rels/workbook.xml.rels` to find the first sheet path; pass 2 reads that sheet + `xl/sharedStrings.xml`. Any `<!DOCTYPE` → refuse. Small regex scanners: shared strings join rich-text `<r><t>` runs, skip `<rPh>`; cells `t="s"`, `inlineStr`, `str`, `b`, numbers (no date conversion); a formula with no cached `<v>` is empty; cells with `r` placed by column (column > 50 → error immediately), without `r` sequential; stop at row 5,001.

- [ ] Tests: `comma / semicolon / tab`; `quoted newline and quote`; `BOM, UTF-16 and Windows-1252 (é)`; `xlsx shared, rich-text and inline strings`; `sparse cells`; `cell at XFD1 refused without allocating`; `entry claiming 1 KB but inflating 50 MB stopped at 20 MB`; `DOCTYPE refused`; `xls refused with message`; `5,001 rows → error`; `formula without cached value → empty`.
- [ ] Commit: "Read product spreadsheets from CSV and Excel files without storing them".

### Task 3: Match columns, validate, import (1.5 d)

**Files:** create `server/catalog/import-products.ts`, route `app/.../products/import/route.ts` (POST, `?dryRun=1` for the preview), `shared/products.ts` (`ImportField`, `IMPORT_FIELDS`, `ImportPreviewDto`, `ImportResultDto`). Tests `tests/import-products.test.ts`, `tests/db/import-products.db.test.ts`.

**Interfaces:**
- `guessMapping(headers) → (ImportField | null)[]`: header normalised (lowercase, accents and punctuation stripped) against synonym lists per field, en + fr (title: name, product, product name, titre, nom, désignation; price: price, prix, prix ttc, sale price; compareAtPrice: compare at, regular price, prix barré, prix avant; sku: sku, ref, référence, reference, code; url: url, link, lien, product url; imageUrl: image, image url, photo, visuel; stockQuantity: stock, quantity, qty, quantité; inStock: in stock, available, disponible, availability, disponibilité; …). Each field at most once.
- `toRows(sheet, mapping)`: values through `ProductInput` caps; `amountOf` for prices; `httpUrl` for links (bad link dropped, not the row); `htmlText` for description; identity and duplicates per My calls 4. Returns `{ rows, skipped, duplicates }`.
- Route order: `authorizeBrandRoute(context.edit)` → both rate limits → `Content-Length` ≤ 5 MB + 64 KB (chunked → 411) → `formData()` → `parseSheet`. `dryRun`: `{ headers, mapping, sample (first 20 rows), rowCount, problems (first 50), needsApproval: fields in VOUCHED_FIELDS }`; nothing written. Import: `mapping` JSON (zod: length = headers, values in `IMPORT_FIELDS` or null, `title` exactly once); vouched fields mapped without `rules.approve` → 403; parse and `toRows` **before** the transaction; then `prisma.$transaction(async tx => { pg_advisory_xact_lock(hashtext('catalog:' || brandId)); saveRows(tx, scope, "IMPORT", …, { match }) }, { timeout: 60_000 })` when at least one row is good; audit; `{ created, updated, unchanged, archived, skipped, duplicates, problems }`. `export const maxDuration = 60`.
- The same advisory lock key is taken by `runCatalogSync` around its save, so an import and a sync of one brand never interleave.
- Ceiling (comment): parsing is synchronous; a 5 MB file blocks the request for ~1 s; bounded by the rate limits.

- [ ] Tests: `French headers matched`; `each field once`; `"1 299,00 €" → 1299.00`; `oui/non stock`; `javascript: link dropped`; `no title column → 400`; `price column without rules.approve → 403, preview flags it`; `all rows bad → nothing written or archived`; `duplicate SKU last wins`; db `re-import keeps id when a SKU column is added`; db `re-import archives missing IMPORT rows only`; db `empty materials cell keeps stored materials`; db `other brand untouched`; `viewer → 403`; `rate limited per user across brands`; `chunked upload → 411`.
- [ ] Commit: "Import products from a spreadsheet, matching columns automatically and updating them on re-import".

### Task 4: Import screen on the web (1.25 d)

**Files:** web `components/products/import-dialog.tsx`, `products-board.tsx` ("Import file" next to Add product; labels `IMPORT` "Imported", `SITE` "From your website"; edit/delete for `IMPORT` like `MANUAL`), `components/products/api.ts` (types, calls), en/fr messages; mobile `src/api/endpoints.ts` types + source labels in every locale; `npm run sync:shared` (commit copies in web and mobile).

Flow: pick file → preview table (first 20 rows), a labelled dropdown above each column (fields + "Skip") prefilled from `mapping`; vouched columns marked "needs approval rights" for people without them; problems listed → "Import N products" → summary ("12 added, 30 updated, 4 archived, 2 rows skipped: …") → board refreshes.

- [ ] Tests: web `dialog maps, re-maps and posts the mapping`; `vouched columns disabled without rights`; `result summary`; `IMPORT rows editable`.
- [ ] Commits: web "Add an Import file dialog with a column preview to the Products page"; mobile "Label imported and website-read products".
- [ ] **Merge 1:** four-lens branch review, fixes, browser check (French semicolon CSV and `.xlsx` for Tikamoon; re-import with a row removed → archived; with a SKU column added → same products), HANDOVER updated, merge to main in the three repos.

## Part B: website product-page reader (5 d) — merge 2

### Task 5: Safe fetching for repeated crawling (0.75 d)

**Files:** `server/research/crawl.ts`, tests `tests/crawl.test.ts` (extended).

- **Pinned lookup:** `safeFetchBytes` uses an undici `Agent` whose `connect.lookup` resolves once and rejects private addresses (`isPrivateAddress`), closing the DNS-rebinding gap noted at lines 8–9 for every caller.
- Robots: extend the existing parser (no second one): `robotsGroups` also keeps `Allow`, `Crawl-delay` and `Sitemap:`; one `robotsAllows(txt, path, agent)` (own group first, then `*`), used by `crawlSite` instead of its inline check.
- Export `jsonLdNodes`.

- [ ] Tests: `rebinding to 127.0.0.1 at connect refused`; `own group wins over *`; `Allow beats a shorter Disallow`; `Crawl-delay and Sitemap lines read`; `crawlSite behaviour unchanged`.
- [ ] Commit: "Pin the checked address for every outside fetch and read Allow, Crawl-delay and Sitemap from robots.txt".

### Task 6: Sitemap discovery (1 d)

**Files:** create `server/catalog/sitemap.ts`, prisma `CatalogPage` + migration, tests `tests/sitemap.test.ts`, `tests/db/catalog-page.db.test.ts`.

```prisma
/// One product page the site reader knows about (from the sitemap): resumable state across days.
model CatalogPage {
  id          String    @id @default(cuid())
  workspaceId String
  brandId     String
  url         String
  lastmod     DateTime?
  readAt      DateTime?
  /// last attempt (read or failed): the daily budget counts these
  triedAt     DateTime?
  etag        String?
  modifiedAt  String?
  /// externalIds of the SITE rows this page produced
  productKeys String[]
  /// ok | no-product | gone | failed
  state       String?
  brand Brand @relation(fields: [brandId, workspaceId], references: [id, workspaceId], onDelete: Cascade)
  @@unique([brandId, url])
  @@index([brandId, triedAt])
}
```

**Interfaces:** `discoverProductUrls(origin, robots, signal) → { urls: { url, lastmod }[]; complete: boolean; capped: boolean }`:
- Sitemaps from robots `Sitemap:` lines and index children, **each on the same site** (host equal or `www.` variant), else `/sitemap.xml`, `/sitemap_index.xml`. Children named `product`/`produit` preferred and used alone when present; ≤ 50 children; ≤ 20 MB per file and 40 MB in all, 2 min overall. `.gz` through streaming `Gunzip` with the same byte counting (header size not trusted). `<loc>`/`<lastmod>` regex scan; DOCTYPE refused.
- **`complete` is false** when any file was truncated, non-200, failed, skipped over the child limit, or the time ran out.
- Without a product sitemap: product-looking paths only (`/p/`, `/product`, `/produit`, `/products/`, `-p-\d+`); none → reason `no-product-pages`.
- `http(s)`, same site, `robotsAllows`; de-duplicated; newest `lastmod` first; capped at 5,000.
- `syncCatalogPages(scope, found)`: upsert in `unnest` batches (skip unchanged `lastmod`); when `complete`, delete pages not in the list and hand their `productKeys` to the archive rule (Task 8).

- [ ] Tests: `robots Sitemap lines used`; `other-host sitemap or child ignored`; `index prefers product children`; `gz claiming a small size but inflating past 20 MB stopped`; `truncated child → incomplete`; `51st child → incomplete`; `disallowed URLs dropped`; `cap newest first`; db `incomplete discovery deletes nothing`.
- [ ] Commit: "Find a website's product pages from its sitemap".

### Task 7: Read product data from a page (0.75 d)

**Files:** create `server/catalog/page-product.ts`; refactor `websiteRows`' per-product normalising into a shared row builder both use. Tests `tests/page-product.test.ts` (inline HTML; one trimmed from camif.fr recorded 2026-11-24, names generic).

**Interfaces:** `pageProducts(html, pageUrl) → SyncedRow[]` (≤ 200): JSON-LD `Product` and `ProductGroup.hasVariant` (also inside `@graph`); `name`, `sku`/`gtin13`/`mpn`, canonical `url` (same site, else page URL), first `image` (`httpUrl`), `description` (`htmlText`, ≤ 5,000), `category` (string or last `BreadcrumbList` item), offers `Offer`/`AggregateOffer` (`price`/`lowPrice` via `parsePrice`, `priceCurrency` `^[A-Z]{3}$`, `availability` `InStock`/`OutOfStock`/`PreOrder`/`BackOrder`). `externalId` = `sku:<sku>` else `url:<canonical>` (variants without sku `url:<canonical>#<n>`).

- [ ] Tests: `Product with Offer`; `AggregateOffer lowPrice`; `ProductGroup variants`; `@graph`; `availability mapping`; `bad currency dropped`; `HTML stripped`; `other-host canonical ignored`; `201 variants → 200`; `no Product → []`.
- [ ] Commit: "Read a product's name, price, stock and image from the data embedded in its page".

### Task 8: The page-reader job (2 d)

**Files:** `server/catalog/sync.ts` (`runCatalogSync`, `catalogSource` returns `SITE`, `catalogSyncRunning` counts `catalog.pages`), create `server/catalog/page-reader.ts` (job `catalog.pages`), `server/jobs/queue.ts` (`catalog.pages` capped at 1 running, like the `data.%` rule), `server/jobs/runner.ts` (HANDLERS), `server/content/product-checks.ts` (SITE fresh for 8 days), `shared/products.ts` (`CatalogSync.source` += `"SITE"`, `SyncReason` += `"reading"`, `"no-product-pages"`, `"site-refused"`, `pages?: { read; total; capped }`). Tests `tests/page-reader.test.ts`, `tests/db/page-reader.db.test.ts`.

**Interfaces:**
- `runCatalogSync`: `NOT_A_FEED` (not `BLOCKED`) → queues `catalog.pages` `{ workspaceId, brandId, day }` with key `catalog-pages:<brandId>:<day>:0` and records `{ source: "SITE", reason: "reading" }`. Sync now on a SITE brand whose chain stopped earlier today uses key `…:<day>:manual:<n>` (n = manual count today) so a completed `:0` doesn't swallow it.
- **One chain per brand:** the handler returns at once if another `catalog.pages` job for the brand is RUNNING; the day comes from the payload; the next step (`…:<step+1>`, `runAt` now + 1 min) is enqueued as the run's **last** write.
- Run (≤ 4 min): step 0 does discovery + `syncCatalogPages`. Then due pages (`readAt IS NULL AND (triedAt IS NULL OR triedAt < today)`, then `lastmod > readAt`, then `readAt < now − 7 d`), oldest first; per page take the **host lock** (`pg_try_advisory_lock(hashtext('host:'||host))`, skip the run if busy) and the budgets (brand: count of `triedAt >= UTC day start`; host: `hitRateLimit("site-pages:<host>:<day>", 1500, 1 d)`); spacing ≥ 1 s / `Crawl-delay`. Fetch with `safeFetchBytes(url, "text/html", 3_000_000)` and conditional headers; a redirect to another host → `failed`, not parsed. 304 → `readAt` = now. 404/410 → `gone`. 401/403/429 → stop the run (`site-refused`), nothing archived. Other errors → `failed` + `triedAt`. 200 → `pageProducts`.
- Saving per batch of 25 pages: `saveRows(prisma, scope, "SITE", { rows, complete: false }, { keys })` under the `catalog:` advisory lock; then archive SITE rows (`source = 'SITE'`, brand-scoped) whose keys left this batch's pages **and appear in no other `CatalogPage.productKeys`**; update `productKeys`, `readAt`, `triedAt`, `etag`.
- When discovery was complete and no due pages remain, the first time a brand's SITE catalogue is fully read, archive `WEBSITE`/`SHOPIFY` rows (explicit, since SITE saves are partial).
- End of chain: `record({ source: "SITE", count, pages }, note)` once (no per-batch JSON writes). Audit `catalog.pages` summary (pages read, products, stopped reason).
- Queued jobs check `catalogSource` first; a brand now on SHOPIFY or WEBSITE stops, and its `CatalogPage.readAt` values are cleared so a later switch back re-reads.
- Ceiling (comment): one runner, ~1,000 pages × ~1.5 s ≈ 25 min/brand/day → ~55 brands/day per runner at full budget; raise the cap or parallelise across hosts past that. Bandwidth ~400 MB/brand/day on first fill, mostly 304s after.

- [ ] Tests: `NOT_A_FEED queues the page job, BLOCKED doesn't`; `second job for the same brand exits`; `brand budget and host budget stop the run`; `two brands on one host never fetch at once`; `spacing and Crawl-delay`; `404 archives only products no other page produces`; `403 stops without archiving`; `failed page tried once a day`; `304 keeps rows`; `cross-host redirect not parsed`; `SITE row fresh for 8 days`; `Shopify connected → chain stops and readAt cleared`; `Sync now after a stopped chain runs again`; db `crash mid-run resumes without duplicates`; db `other brand's pages untouched`.
- [ ] Commit: "Read products from a website's product pages when it has no Shopify feed, a little each day".

### Task 9: Links across the switch, status on screens (0.5 d)

**Files:** `server/catalog/linked.ts` (`otherSourceId` also matches SITE ↔ WEBSITE/SHOPIFY by link, then SKU), `saveRows` facts copy for new SHOPIFY/WEBSITE rows from SITE rows by link; web `products-board.tsx` (banner "Reading your website's product pages: 350 of 5,000 so far. More each day." / capped / no product pages / site refused; `SOURCE_LINE` for SITE; polling while `running`), en/fr; mobile `products.reason.*` + `products.source.site` in every locale; `npm run sync:shared`; `docs/HANDOVER.md`.

- [ ] Tests: `post linked to a SITE row resolves after switching to Shopify`; `facts copied from SITE`; web `reading banner with counts`; `capped note`.
- [ ] Commits per repo: "Keep product links and facts when a brand moves from website pages to Shopify, and show the reader's progress".
- [ ] **Merge 2:** four-lens branch review, fixes, live run on Camif in dev (discovery count, one page parsed, banner), HANDOVER, merge.

## Review changes (2026-11-24 four-lens plan review)

- **Correctness:** IMPORT stock always fresh and SITE fresh 8 days (else posts hit the availability gate after 50 h); prices/stock by import need `rules.approve`; advisory lock now wraps the save in a real transaction (`saveRows` takes `db`); SITE archives WEBSITE/SHOPIFY explicitly after a full read; re-import matches stored rows by SKU → link → title and keeps ids; IMPORT rows editable/deletable and person fields importable without blanking; budget counted from `CatalogPage.triedAt` (not the overwritten JSON); one chain per brand, day in payload, next step last, manual key after a stopped chain; archive only keys no other page produces; `catalogSource`/status say SITE and polling counts the page job; links and facts survive SITE → Shopify; batched UPDATE sets `updatedAt`/`archivedAt` with typed arrays; `amountOf` reused; xlsx two passes, rich text, sequential cells; UTF-16 BOM.
- **Security:** streaming inflate/gunzip with byte counting (zip/gzip headers can lie); limits enforced during parsing (sparse `XFD1` cells); pinned DNS lookup before Part B ships; per-host lock and budget; incomplete sitemaps never archive; same-site check on every sitemap child; cross-host product redirects not parsed; archive by key always filtered by `source`; robots own group first, failed robots = disallow; route order and per-user limit across brands; rows per page capped.
- **Performance:** `saveRows` `keys` mode for page batches (no full-source re-read); page reader in its own job type with its own cap of 1, not in the 2-runner `data.%` pool; `syncCatalogPages` in `unnest` batches; conditional requests and a 3 MB `safeFetchBytes` cap; catalogSync written once per chain; lock taken after parsing with a 60 s timeout; sitemap total size and time caps.
- **Maintainability:** shipped as two merges; one import route with `dryRun`; no template endpoint; robots parser extended instead of a second one; shared row builder for feed and page products; `AUTOMATIC` list in `archiveWhere` with a pinned test for today's behaviour; every type and `=== "MANUAL"` site named; estimates raised to 10 d.
