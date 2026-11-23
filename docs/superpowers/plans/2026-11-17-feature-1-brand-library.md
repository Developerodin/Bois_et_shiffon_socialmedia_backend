# Feature 1 · Brand look & feel and photo library on the web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person do on the website what the phone's Business › Brand settings (M07) and Business › Photo assets (M08) screens do: see and edit the brand palette, see the logo, pick creative tones, browse the website photos and their own uploads, add photos, remove uploads and refresh. The steps, choices and server calls are the same as the phone's, laid out for desktop on one flagged page. It also ships the reusable library picker (the phone's F04 source picker) that the photoshoot (feature 2) opens next.

**Architecture:** Additive on 0b/0c. One shared contract file `shared/brand-look.ts` (view and edit types, tones, palette helpers, upload limits, `libraryPhotos`) is owned by the server and synced to web and mobile. On the web, the brand view is read through `useJob`'s shared per-URL cache. It fetches once, and again when the signed links are over 50 minutes old. Edits put the server's answer back into the same cache with a new `putShared`, so every part of the page shows it at once. A `/library` page behind the `library` flag holds a Photos section and a Brand look column. The grid and source switch are shared by the page and by `LibraryPicker`.

**Tech Stack:** Next.js 15.5 / React 19.1, Tailwind 4, Radix Dialog (`components/ui/dialog.tsx`), vitest in node (no jsdom, no testing library). Server: Next.js 15 route handlers, zod, vitest.

**Spec:** server repo `docs/superpowers/specs/2026-11-17-foundations-design.md` §1, §2 (feature 1 owns the media picker), §9 (no owner decision held for feature 1). Kit: `docs/DESIGN_SYSTEM.md` §4, §7, §8, §12; `docs/HANDOVER.md` "Foundations 0c".
**Phone source of truth (mobile repo):** `src/app/business/brand.tsx`, `src/app/business/photos.tsx`, `src/app/photoshoot/source.tsx`, `src/ui/use-current-brand.ts` (`libraryPhotos`, `siteLabel`, 50 min staleness), `src/ui/onboarding/color-sheet.tsx` (colour editor and helpers), `src/ui/onboarding/tones.ts`, `src/api/endpoints.ts:73-118` (`BrandAssetsView`, `BrandDetailsEdit`), `:442-453` (`uploadPhoto`).

## Owner questions — defaults taken (controller rulings; owner may overturn)

1. One `/library` page holds Photos (main column) and Brand look (side column); nav label renamed "Photo library" → **"Brand & photos"**.
2. Photos over 4 MB are refused in the browser with the server's wording ("Images can be up to 4 MB"); no client downscale.
3. Server permissions kept: add photo = `publish.execute`; remove photo, colours, tones = `context.edit`. Controls the role can't use are hidden with a one-line reason.
4. Logo read-only; fonts, tagline, audience not shown (phone parity).

Mobile switching to the shared `brand-look.ts` is left for later; mobile only commits the synced copy here.

## Where the web already touches this (reuse, don't rebuild)

| Need | Already on the web | Used how |
|---|---|---|
| Multipart upload through `/api` | `components/workspace/release-panel.tsx:322-341` (`request(`${base}/media`, { method: "POST", body: FormData, headers: {} })`); `request()` sets no content type for `FormData` (`components/settings/api.ts`) | Same call, plus `library=1` and `title`, `timeoutMs: 60_000` |
| Shared per-URL read cache | `fetchShared` / `subscribeShared` / `useJob` (`components/workspace/use-job.ts`) | `useBrandLook` on `useJob`; add `putShared`, `sharedAt` |
| Flag, route name, nav entry | `featuresOn`, `requireFeature` (`lib/features.ts`); `NAV` `library` entry in `lib/nav.ts`, `Images` icon (`components/shell/sidebar.tsx`) | Page calls `requireFeature("library", ws)` |
| Page parts | `PageHeader`, `PageSection`, `PageSkeleton`, `EmptyState`, `LoadError`, `Dialog*`, `Button`, `Input` | As is |
| Page shell pattern | `app/(shell)/products/page.tsx` | Copied for `/library` |
| Image tags | `<img>` with the documented `no-img-element` disable (`products-board.tsx`, `release-panel.tsx`) | Same |
| Brand look read/edit | **None** on the web | New |

**Server calls (identical to the phone's):** `GET …/brands/:b/assets` (`brand.read`); `PATCH …/brands/:b/assets` `{ colors }`, `{ tones }`, `{ removeUpload }` (`context.edit`, returns the view); `POST …/brands/:b/media` multipart `file`, `library=1`, `title="Photo"` (`publish.execute`, 201 `{ key, previewUrl }`, 413 over 4 MB, 409 library full (60) or no profile). **No server route behaviour changes.** `/api/*` is excluded from the web middleware and is a rewrite, so there is no body-clone limit; browser writes carry `Sec-Fetch-Site: same-origin` and pass CSRF.

## Decisions

1. **One contract file** `shared/brand-look.ts` (see Task 2). The server uses the shared `TONES`, `normalizeHex`, `LIBRARY_MAX`, `MEDIA_MAX_BYTES`, and types the assets view with `satisfies BrandAssetsView`.
2. **Data:** `useBrandLook(w, b)` = `useJob(url, { pick, done: () => Date.now() - sharedAt(url) < STALE_MS, intervals: JOB_INTERVALS.always })`. `STALE_MS = 50 min`. `set(view)` = `putShared(url, view)` with the URL taken when the edit started. Page remounts on `key={brandId}`.
3. **Colours save on the dialog's Save colour; tones save with Save changes** (phone `brand.tsx:38-54`). Removing the last colour isn't offered; duplicates refused before sending. Before Research has read the website the palette shows "Your brand colours appear here once Research has read your website." with no Add.
4. **Upload batch = phone's:** at most 10 files per pick; wrong type or over 4 MB refused per file in the browser; uploads one at a time titled "Photo"; view reloaded in `finally`; switch flips to Uploads when the batch starts.
5. **Picker = phone F04 minus the photoshoot tip** (feature text via `children`). Ships with no production consumer; photoshoot is the first.
6. **Keyboard/SR:** source switch, picker grid and tone chips are native `<input type="radio|checkbox" class="sr-only">` inside labels; focus `has-[:focus-visible]:ring-2 ring-ring`; selection = ring plus check icon. Each section has one always-mounted polite status line and one `role="alert"` line. After removing a photo, focus goes to "Add photos" and status says "Removed Photo."
7. **Layout:** `max-w-7xl`; `PageHeader` (title, description, Refresh). Then `grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]`: Photos `PageSection` left, Brand look right; stacks below `lg`. Tiles `aspect-[4/5]`, `grid-cols-2 sm:grid-cols-3 xl:grid-cols-4`.
8. **JobProgress notices (0c open item):** slow and failed notices sit in always-mounted live regions (`role="status"`, `role="alert"`); `aria-valuenow` clamped like the bar width.

## Global Constraints

- Run npm inside each repo with `--prefix .`: `npm test --prefix . -- tests/x.test.ts`. Windows; Git Bash. Paths are relative to the repo the task names. Repos: `C:\Users\INTEL\Desktop\Social Media Agent\apps\{server,web,mobile}`.
- Branch `feature-1-brand-library` already exists and is checked out in server, web and mobile. Commit only in the repo the task names.
- Every web task leaves `npm run typecheck --prefix .` (runs `check-shared` first), `npm run lint --prefix .` and `npm test --prefix .` green. Server task leaves server typecheck, lint, test green. Mobile: `npm run typecheck --prefix .` green after the sync.
- Web tests run in node without jsdom; no test library. Unit-test pure logic. Component glue is checked by build, `scripts/audit-ui.ts` and the owner's manual check.
- Commit messages: the change and why. No co-author lines, no tool or session URLs, no mention of tests.
- Shared code: edit `shared/` in the server repo only, then `npm run sync:shared --prefix .` (server) and commit the copy in web and mobile. Never edit `web/shared` or `mobile/src/shared` by hand.
- No new dependencies. Follow `DESIGN_SYSTEM.md`: cards `rounded-2xl border border-border bg-card shadow-sm`, `px-5`, `text-lg` section titles, `focus-visible:ring-2 ring-ring`; every icon `aria-hidden` next to text or with an `aria-label`.
- English copy, taken from the phone's `en` strings.
- Do not run anything needing the owner's admin credentials; do not call paid providers; do not touch port 3100's existing process.

## Review Focus

1. An answer for the old business after a switch must not show on the new one (`putShared` keyed by URL taken at start; `key={brandId}`).
2. Partly failed batch: photos uploaded before the failure appear (reload in `finally`), the error names the file or says the library is full, nothing sent twice.
3. Palette edge cases: duplicate refused, last colour can't be removed, `#abc` → `#AABBCC`, a 409 keeps the dialog open with the message.
4. Tones: untouched → Save off and nothing sent; zero picked → Save off with "Pick at least one tone."; after saving, chips show the server's answer.
5. Picker by keyboard: Tab → switch → grid; arrows move choice (ring + check); Tab → "Use photo"; Escape returns focus to opener.

---

### Task 1: JobProgress notices in live regions (web)

**Files:** Modify `components/ui/job-progress.tsx`; Test `tests/job-progress.test.ts` (extend).

**Interfaces:** Props unchanged. After the change:
- `const pct = value === null ? null : Math.min(100, Math.max(0, value));` used for `aria-valuenow={pct === null ? undefined : Math.round(pct)}` and the bar width.
- `<div role="status" className={showSlow ? "mt-3 flex flex-wrap items-center gap-2 text-sm" : "sr-only"}>{showSlow && (<>…today's slow content…</>)}</div>` with `showSlow = job.slow && !dismissed`.
- `<div role="alert" className={job.failed ? "mt-3 flex flex-wrap items-center gap-2 text-sm text-destructive" : "sr-only"}>{job.failed && (<>…today's failed content…</>)}</div>`.

- [ ] **Step 1: Failing test** (append to `tests/job-progress.test.ts`; reuse its existing `steps` helper — adapt names to the file):
  ```ts
  import { createElement } from "react";
  import { renderToStaticMarkup } from "react-dom/server";
  import { JobProgress } from "@/components/ui/job-progress";
  const html = (job: { slow: boolean; failed: boolean }, value: number | null = null) =>
    renderToStaticMarkup(createElement(JobProgress, { title: "Shoot", steps: steps("active"), value, job: { ...job, reload: async () => {} } }));
  describe("JobProgress notices", () => {
    it("keeps both live regions mounted while quiet", () => {
      const h = html({ slow: false, failed: false });
      expect(h).toContain('role="status"');
      expect(h).toContain('role="alert"');
      expect(h).not.toContain("Couldn");
    });
    it("puts the failure inside the alert region", () => {
      expect(html({ slow: false, failed: true })).toMatch(/role="alert"[^>]*>[^]*Couldn/);
    });
    it("clamps aria-valuenow", () => {
      expect(html({ slow: false, failed: false }, 140)).toContain('aria-valuenow="100"');
      expect(html({ slow: false, failed: false }, -5)).toContain('aria-valuenow="0"');
    });
  });
  ```
- [ ] **Step 2:** `npm test --prefix . -- tests/job-progress.test.ts` → Expected FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; typecheck, lint, full test green.
- [ ] **Step 5: Commit** (web) "Announce the job card's slow and failed notices through always-present live regions, and keep its progress value between 0 and 100".

### Task 2: Shared brand-look contract (server, then copies in web and mobile)

**Files:**
- Create `shared/brand-look.ts`; Modify `shared/index.ts` (`export * from "./brand-look";`), `shared/website.ts` (add `siteLabel`).
- Modify `server/research/brand-summary.ts` (delete local `TONES`; `import { TONES } from "@/shared"; export { TONES };`).
- Modify `app/api/v1/workspaces/[workspaceId]/brands/[brandId]/assets/route.ts` (`import { normalizeHex, type BrandAssetsView } from "@/shared"`; `Hex` keeps its regex and message, `.transform((h) => normalizeHex(h)!)`; `view()` returns `{ … } satisfies BrandAssetsView`).
- Modify `app/api/v1/workspaces/[workspaceId]/brands/[brandId]/media/route.ts` (`LIBRARY_MAX`, `MEDIA_MAX_BYTES` from `@/shared`; delete local constants).
- Test `tests/contract.test.ts` (extend). Then sync and commit copies in web and mobile.

**Interfaces** (`shared/brand-look.ts`; plain TS, no zod, no Node imports):
```ts
/** Brand look and photo library: GET/PATCH …/brands/:b/assets, POST …/brands/:b/media (library=1). */
export type StoredImage = { key: string; url: string };
export const TONES = [
  "Warm", "Playful", "Bold", "Calm", "Romantic", "Edgy",
  "Modern", "Minimalist", "Rustic", "Vintage", "Bohemian", "Industrial", "Scandinavian", "Coastal",
  "Luxurious", "Premium", "Elegant", "Affordable", "Artisanal", "Sustainable", "Natural", "Family-friendly",
] as const;   // must equal the server's current TONES exactly — check brand-summary.ts and the phone's tones.ts; if they differ, the server's list wins and record it
export type Tone = (typeof TONES)[number];
export const TONE_GROUPS: readonly { key: "feel" | "style" | "positioning"; tones: readonly Tone[] }[] = [
  { key: "feel", tones: TONES.slice(0, 6) },
  { key: "style", tones: TONES.slice(6, 14) },
  { key: "positioning", tones: TONES.slice(14) },
];   // grouping must match mobile src/ui/onboarding/tones.ts
export type BrandAssetsView = { /* exactly mobile endpoints.ts BrandAssetsView, with preferences.tones: Tone[] | null */ };
export type BrandDetailsEdit = { colors?: string[]; tagline?: string; audience?: string; tones?: Tone[]; contentLanguage?: "fr" | "en"; removeUpload?: string };
export const MAX_COLORS = 5;
/** A cap so the profile's JSON list stays small. */
export const LIBRARY_MAX = 60;
/** Largest image POST …/media takes (hosting caps bodies at 4.5 MB). */
export const MEDIA_MAX_BYTES = 4 * 1024 * 1024;
export function normalizeHex(raw: string): string | null; // verbatim from mobile color-sheet.tsx
export const hslToHex: (h: number, s: number, l: number) => string; // verbatim, exported
export function shade(hex: string, step: number): string;          // verbatim (hexToHsl private)
export const HUES: readonly { key: string; h: number; s: number }[]; // verbatim
export const SHADES: readonly { key: string; l: number }[];          // verbatim
export function nearestHue(hex: string | null): number;              // verbatim
export type LibraryPhoto = { key: string; url: string; title: string; kind: string | null };
/** Website product photos and the owner's uploads (newest first, as the server sends them). */
export function libraryPhotos(view: BrandAssetsView | null | undefined): { website: LibraryPhoto[]; uploads: LibraryPhoto[] };
```
(Check the server's actual MAX colours / LIBRARY_MAX / media cap values and the phone's helper code; where the plan's number differs from the code, the code wins — record a Ruling.)
`shared/website.ts` += `export const siteLabel = (url: string | null | undefined) => (url ? url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") : null);`

- [ ] **Step 1: Failing tests** in `tests/contract.test.ts`:
  - `TONE_GROUPS.flatMap((g) => g.tones)` equals `[...TONES]`; `TONE_GROUPS[0].tones` equals `["Warm","Playful","Bold","Calm","Romantic","Edgy"]`; `TONE_GROUPS[2].tones[0] === "Luxurious"`.
  - `normalizeHex("7c6754") === "#7C6754"`, `normalizeHex("#abc") === "#AABBCC"`, `normalizeHex("#12345") === null`, `normalizeHex(" #fff ") === "#FFFFFF"`.
  - `shade("#7C6754", 8)` is lighter; `shade("#F5F5F5", 8) === "#F5F5F5"`.
  - `HUES[nearestHue("#808080")].key === "grey"`; `HUES[nearestHue("#3366CC")].key === "blue"`; `nearestHue(null) === 0`. (Adjust key names to the phone's actual HUES keys.)
  - `libraryPhotos` with one website product with image, one without, one upload → website `[{ key: "k1", url: "s1", title: "Chair", kind: "Furniture" }]`, uploads `[{ key: "k2", url: "s2", title: "Photo", kind: null }]`; `libraryPhotos(null)` → both empty.
  - `siteLabel("https://www.boisetchiffons.fr/") === "boisetchiffons.fr"`, `siteLabel(null) === null`.
- [ ] **Step 2:** `npm test --prefix . -- tests/contract.test.ts` → FAIL.
- [ ] **Step 3:** Implement the file and server edits.
- [ ] **Step 4:** PASS; server typecheck, lint, full test green.
- [ ] **Step 5: Commit** (server) "Move the brand look's types, tones, colour helpers and photo library limits into the shared contract, and have the brand routes use them".
- [ ] **Step 6: Sync.** Server `npm run sync:shared --prefix .`. Web typecheck green; commit (web) "Take the shared brand look contract". Mobile typecheck green; commit (mobile) "Take the shared brand look contract". Also commit the server's updated `shared/.hash` if the sync changed it.

### Task 3: Brand view cache and library helpers (web)

**Files:** Modify `components/workspace/use-job.ts` (add `putShared`, `sharedAt`); Create `components/library/api.ts`, `components/library/use-brand-look.ts` (`"use client"`); Tests `tests/library.test.ts` (new), extend `tests/use-job.test.ts`.

**Interfaces:**
- `use-job.ts`:
  ```ts
  /** An answer the server gave for `url` another way (a PATCH that returns the new view): every subscriber shows it. */
  export function putShared(url: string, d: unknown): void { lastResponse.set(url, d); fetchedAt.set(url, Date.now()); listeners.get(url)?.forEach((fn) => fn(d)); }
  /** When `url` last got an answer (0: never). */
  export const sharedAt = (url: string): number => fetchedAt.get(url) ?? 0;
  ```
  (Adapt to the module's actual internal map names; add a `fetchedAt` map if none exists and set it wherever a fetch answer is stored.)
- `components/library/api.ts` (no React):
  - `brandLookUrl(w, b)` = `` `/api/v1/workspaces/${enc(w)}/brands/${enc(b)}/assets` ``; `mediaUrl(w, b)` = `…/media`.
  - `libraryApi.edit(w, b, edit: BrandDetailsEdit) => request<BrandAssetsView>(brandLookUrl(w, b), { method: "PATCH", body: JSON.stringify(edit) })`.
  - `libraryApi.upload(w, b, file: File)` → FormData `file`, `library=1`, `title="Photo"` → `request<{ key: string; previewUrl: string }>(mediaUrl(w, b), { method: "POST", body, headers: {}, timeoutMs: 60_000 })`.
  - `MAX_PER_PICK = 10`; `pickUploads(files: readonly File[]): { files: File[]; errors: string[] }`: wrong type (not `image/jpeg`/`image/png`) → `` `${name} isn't a JPG or PNG.` ``; `size > MEDIA_MAX_BYTES` → `` `${name} is over 4 MB. Images can be up to 4 MB.` ``; keep first 10 valid; if more → `"Up to 10 photos at a time; the first 10 are being added."`
  - `initialSource(lib, selectedKey?)`: `"uploads"` when `selectedKey` is an upload, or no website photos and some uploads; else `"website"`.
  - `paletteAfter(colors, index: number | "new", hex: string | null): string[]`: `"new"` appends; number replaces, or removes when `hex` null.
  - `colorHint(text, colors, index)`: invalid → `"Use a hex code like #7C6754"`; already at another index → `"That colour is already in the palette"`; else null.
  - `photoCount(n)` → `"1 photo"` / `` `${n} photos` ``.
- `use-brand-look.ts`:
  ```ts
  const STALE_MS = 50 * 60_000; // signed links last an hour (the phone reads again after 50 min)
  const pick = (d: never) => d as BrandAssetsView;
  export function useBrandLook(workspaceId: string, brandId: string) {
    const url = brandLookUrl(workspaceId, brandId);
    const done = useCallback(() => Date.now() - sharedAt(url) < STALE_MS, [url]);
    const { data, failed, reload } = useJob(url, { pick, done, intervals: JOB_INTERVALS.always });
    // The URL is fixed when the edit starts: an answer for this brand never lands on another.
    const set = useCallback((view: BrandAssetsView) => putShared(url, view), [url]);
    return { view: data, failed, reload, set };
  }
  ```
  (Adapt to `useJob`'s real options/return names.)

- [ ] **Step 1: Failing tests.** `use-job.test.ts`: `putShared("/a", 1)` → `sharedResponse("/a") === 1`, a `subscribeShared("/a")` listener gets 1, `sharedAt("/a")` ≈ now; listener on `"/b"` not called; `sharedAt("/never") === 0`. `library.test.ts`: `pickUploads` (HEIC → type error; PNG of `MEDIA_MAX_BYTES + 1` → size error; twelve 1-byte JPEGs → 10 + "Up to 10" message; three good → 3, no errors); `initialSource` four cases; `paletteAfter` three cases; `colorHint` three cases (`"#"`, duplicate at other index, own slot → null); `photoCount(1)`, `photoCount(0)`; `brandLookUrl("w 1", "b") === "/api/v1/workspaces/w%201/brands/b/assets"`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** PASS; typecheck, lint, full test green.
- [ ] **Step 5: Commit** (web) "Read the brand's look and photo library through the shared request cache, and let an edit's answer update every part of the page at once".

### Task 4: The Brand & photos page with the Photos section (web)

**Files:** Create `app/(shell)/library/page.tsx`, `components/library/library-board.tsx`, `components/library/photo-grid.tsx` (`PhotoGrid`, `SourceSwitch`); Modify `lib/nav.ts` (label "Brand & photos") and `tests/nav.test.ts` expectation; Modify `scripts/audit-ui.ts` (`PRIVATE` adds `/library`; note in header comment it renders only with `WEB_FEATURES` containing `library`).

**Interfaces:**
- `page.tsx` (server): `export const metadata = { title: navFor("/library").title };` `getShell()`; `requireFeature("library", shell.activeWorkspaceId)` first. No workspace/brand or no `brand.read` → the same two `EmptyState`s as `products/page.tsx` (icon `Images`; "Photos belong to a business. Create or pick one from the sidebar, then its photos show here." / "Your role cannot see this business's photos. Ask a workspace admin for access."). Else `<LibraryBoard key={brandId} workspaceId brandId canEdit={perms.has("context.edit")} canUpload={perms.has("publish.execute")} />` (adapt to how products/page reads permissions).
- `SourceSwitch({ name, value, counts, onChange })`: `<fieldset>` + `<legend className="sr-only">Source</legend>`, two `<label>` pills `Website (n)`, `Uploads (n)`, each with `<input type="radio" className="peer sr-only">`; styled like the Settings tablist (`rounded-full border bg-card p-1`; `has-[:checked]:bg-primary has-[:checked]:text-primary-foreground`; `has-[:focus-visible]:ring-2 ring-ring`).
- `PhotoGrid(props)` = `{ photos: LibraryPhoto[]; label: string; empty: { title: string; body: string } } & ({ mode: "browse"; onRemove?: (p) => void; busyKey?: string | null } | { mode: "pick"; name: string; selected: string | null; onSelect: (key: string) => void })`:
  - Empty: `EmptyState` (`icon={Images}`).
  - Browse: `<ul aria-label={label} className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">`, each `<li><figure>` with `aspect-[4/5]` `<img alt="" loading="lazy" className="size-full rounded-xl bg-muted object-cover">`, kind chip (`absolute bottom-2 right-2 rounded-full bg-foreground/80 px-2 text-xs text-background`), `<figcaption className="truncate pt-2 text-center text-xs">`. With `onRemove`: top-right icon button `aria-label={`Remove ${title}`}` (`size-8`, `X`, spinner while `busyKey === key`, disabled while any `busyKey`).
  - Pick: `<fieldset><legend className="sr-only">{label}</legend>`, same grid of `<label>`s with `<input type="radio" name value={key} checked onChange className="peer sr-only">`, image `alt=""`, visible title, check icon when checked, `has-[:checked]:ring-2 has-[:checked]:ring-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ring-offset-2`.
- `LibraryBoard({ workspaceId, brandId, canEdit, canUpload })`:
  - `useBrandLook`. Loading → `PageSkeleton header={false}`. Failed, no view → `LoadError` ("Couldn't load your brand and photos.", `reload`).
  - `PageHeader title={navFor("/library").title}`, description "Your brand's colours and tone, and the photos every module draws from. Nothing is published without your approval.", action `Button variant="outline"` "Refresh" (`RefreshCw`), disabled while busy → `reload`.
  - Decision 7 grid. Left: `PageSection id="photos" title="Photos"`, description `` `${siteLabel(view.website) ?? "Source website"} · ${photoCount(shown.length)}` ``, action "Add photos" (`ImagePlus`, ref for focus return) when `canUpload`, else muted "Your role can't add photos." Body: `SourceSwitch`, status `<p aria-live="polite" className="text-sm text-muted-foreground">`, `<p role="alert" className="text-sm text-destructive">`, then `PhotoGrid` browse (`onRemove` only for uploads and only when `canEdit`). Empty copy: website "No website photos" / "Product photos read from your website appear here. Add your website in onboarding, or upload your own."; uploads "No uploads yet" / "Photos you upload appear here, and the writers and reels can use them."
  - Upload: hidden `<input type="file" accept="image/jpeg,image/png" multiple className="sr-only" tabIndex={-1} aria-hidden>`. `pickUploads` first, errors → alert. Switch to Uploads; sequentially `await libraryApi.upload` with status "Uploading 2 of 5…". An `ApiError` stops the batch with its message. `finally`: `await reload()`, status "Added n photos." for those that made it, clear the input.
  - Remove: `busyKey = key`; `set(await libraryApi.edit(w, b, { removeUpload: key }))`; status `` `Removed ${title}.` ``; focus "Add photos" (or the section heading with `tabIndex={-1}` when no Add button).
  - Right column: placeholder for Task 5 (render nothing).

- [ ] **Step 1:** Implement. **Step 2:** typecheck, lint, full test, `npm run build --prefix .` green.
- [ ] **Step 3: Manual (owner)** — listed in HANDOVER by Task 7.
- [ ] **Step 4: Commit** (web) "Add the Brand & photos page: the website's product photos and your own uploads, with add, remove and refresh as on the phone, behind the library flag".

### Task 5: Brand look: palette, logo and creative tone (web)

**Files:** Create `components/library/brand-look.tsx` (`BrandLook`), `components/library/color-dialog.tsx` (`ColorDialog`); Modify `library-board.tsx` (render `BrandLook` in the right column).

**Interfaces:**
- `BrandLook({ workspaceId, brandId, view, canEdit, set })`, two `PageSection`s in `flex flex-col gap-6`:
  - `PageSection id="palette" title="Brand colour palette"`, action "Add colour" (`Plus`) when `canEdit && view.assets && colors.length < MAX_COLORS`. Body: `!view.assets` → "Your brand colours appear here once Research has read your website." Else `<ul className="flex flex-wrap gap-3">` of swatches: `<button aria-label={`Edit colour ${hex}`}>` with `size-8 rounded-full border` dot (`style={{ backgroundColor: hex }}`, `aria-hidden`) and hex in `font-mono text-xs` (plain `div` when not `canEdit`). When `view.assets.logo`: `<img src={logo.url} alt={`${view.name} logo`} className="size-10 rounded-lg bg-foreground object-contain p-1">`, "Outro watermark logo" (`text-sm font-medium`), "Applied to video reel endings and photo borders" (muted). `ColorDialog` with `colors`, `index={editing}`, `onClose`, `onSave={async (hexes) => set(await libraryApi.edit(w, b, { colors: hexes }))}`.
  - `PageSection id="tone" title="Creative tone"`: per `TONE_GROUPS` a `<fieldset disabled={!canEdit || saving}>` with `<legend className="text-xs text-muted-foreground">` (`GROUP_LABEL = { feel: "Feel", style: "Style", positioning: "Positioning" }`), `flex flex-wrap gap-2` chips: `<label className="inline-flex min-h-11 items-center gap-2 rounded-2xl border px-3 text-sm has-[:checked]:border-2 has-[:checked]:border-primary has-[:checked]:bg-accent has-[:checked]:text-primary-strong has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">` with `<input type="checkbox" className="sr-only">`, tone, `Check` icon when on (verify `text-primary-strong` exists in the tokens; else use the nearest existing token). `picked: Tone[] | null` (null = saved tones). Below: `<p aria-live="polite">` ("Pick at least one tone." when `picked?.length === 0`, "Saved." after save), `<p role="alert">`, `Button` "Save changes"/"Saving…" disabled when `!canEdit || saving || picked === null || picked.length === 0`. Save: `set(await libraryApi.edit(w, b, { tones: picked }))`, then `setPicked(null)`. Not `canEdit`: fieldsets disabled plus muted "Your role can't change the brand look."
- `ColorDialog({ colors, index, onClose, onSave })`: `Dialog open={index !== null}`; `onOpenChange` ignored while saving; content keyed per opening. `DialogTitle` "Add colour"/"Edit colour". "Pick a colour": `HUES` as `<button aria-pressed={i === hue} aria-label={HUE_LABEL[key]}>` (`size-9 rounded-full`, selected `ring-2 ring-foreground ring-offset-2`), five `SHADES` buttons `aria-label={`${HUE_LABEL[hue]}, ${shadeKey}`}` `aria-pressed={h === hex}`. Preview square (`aria-hidden`), "Lighter"/"Darker" outline buttons (`shade(hex, ±8)`). `<label htmlFor="color-hex">Or type a hex code</label>` + `Input id="color-hex" maxLength={7} placeholder="#7C6754" aria-describedby="color-hint"` + `<p id="color-hint" aria-live="polite">`. `DialogFooter`: "Save colour" (disabled `!hex || duplicate || saving`) → `onSave(paletteAfter(colors, index, hex))` then `onClose()`; "Remove colour" (only when `index !== "new" && colors.length > 1`) → `onSave(paletteAfter(colors, index, null))`; "Cancel" (`DialogClose`). Failure keeps dialog open: `errorMessage(e, "Couldn't save. Your colours are unchanged. Try again.")`. `HUE_LABEL` = phone's English hue names.

- [ ] **Step 1:** Implement. **Step 2:** typecheck, lint, full test, build green.
- [ ] **Step 3: Commit** (web) "Show and edit the brand's colour palette and creative tone beside its photos, with the logo used on reel endings, as on the phone".

### Task 6: `LibraryPicker`, the reusable photo picker (web)

**Files:** Create `components/library/library-picker.tsx`.

**Interfaces:** `LibraryPicker({ workspaceId, brandId, open, onOpenChange, selectedKey = null, canUpload, title = "Choose a photo", onUse, children })`:
- `Dialog` with `DialogContent className="max-w-3xl"`, body keyed per opening. `useBrandLook` (shared cache). `lib = libraryPhotos(view)`; `source` starts at `initialSource(lib, selectedKey)`; `selected` starts at `selectedKey`.
- Header: `DialogTitle`, `DialogDescription` "From your website or your uploads.", "Upload new" (`Upload` icon; single file; `pickUploads`; `libraryApi.upload` → `reload()` → `setSource("uploads")` → `setSelected(key)`; status and alert lines) when `canUpload`.
- Body: `SourceSwitch name="picker-source"`; on Website with `view.website`, a row "{view.name} · Website" with a `siteLabel` chip; `PhotoGrid mode="pick" name="picker-photo" label="Photos"` in `max-h-[60vh] overflow-y-auto`, empty copy "No product photos from your website yet. Upload one instead." / "No uploads yet. Use Upload new to add one."; `children` last. Loading → `ListSkeleton label="Loading photos"` (or nearest existing skeleton); failed → `LoadError`.
- `DialogFooter`: chosen title or "No photo selected", muted "1 photo selected"/"Select a photo", `Button` "Use photo" (`ArrowRight`) disabled with no choice → `onUse(chosen); onOpenChange(false)`.

- [ ] **Step 1:** Implement. **Step 2:** typecheck, lint, full test, build green.
- [ ] **Step 3: Commit** (web) "Add the library picker the photoshoot will open: website photos or uploads, one choice, upload a new one in place, by keyboard too".

### Task 7: Documentation and whole-slice check

**Files (server):** `docs/DESIGN_SYSTEM.md` §7 rows for `LibraryPicker` and `PhotoGrid`/`SourceSwitch`; `docs/HANDOVER.md` "Feature 1: brand look and photo library on the web" entry above 0c: branches; shared `brand-look.ts` (mobile took only the copy); flag `WEB_FEATURES=library`; the defaults taken for the owner questions; manual checks for the owner (flag off → 404 and no nav entry; add 3 JPEGs; HEIC/6 MB refused without a request; remove → focus on Add photos; Refresh = one GET; keyboard on switch/grid/tones/colour dialog; 375 px no horizontal scroll; switch business; role without `context.edit`); not checked live: 60-photo 409, signed links after an hour, the picker until the photoshoot; close the 0c minor "JobProgress … needs a live role".

- [ ] **Step 1:** Edit both; commit (server) "Record the brand look and photo library on the website in the design system and the handover".
- [ ] **Step 2:** Web typecheck, lint, test, build, check:bundle; server typecheck, lint, test; mobile typecheck → all green.
