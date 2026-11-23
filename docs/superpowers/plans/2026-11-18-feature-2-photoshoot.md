# Feature 2 · Photoshoot on the web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person run, watch and review a product or fashion photoshoot on the website, with the phone's steps, choices and server calls, on one studio page `/photoshoot` and one page per shoot `/photoshoot/[id]`.

**Architecture:** The server moves the shoot types, option lists and tier prices into `shared/photoshoot.ts` (synced to web and mobile), opens library upload to `content.create`, and adds a download link per shot. On the web, pure helpers (`components/photoshoot/shoot.ts`) build requests, name shoots, give step states and handle the one-charge-per-press rule; `useJob` polls the list and the open shoot; two new kit controls (`Segmented`, `ChoiceCards`) carry every choice. Paywall on 402 is already automatic in `request()`.

**Tech Stack:** Next.js 15.5 / React 19.1, Tailwind 4, vitest in node (no jsdom). Server: Next.js route handlers, zod, Prisma, vitest, `@aws-sdk/s3-request-presigner`.

**Spec:** server repo `docs/superpowers/specs/2026-11-18-feature-2-photoshoot-design.md` (approved 2026-11-18). Parent: `docs/superpowers/specs/2026-11-17-foundations-design.md`.
**Phone source of truth (mobile repo):** `src/app/photoshoot/{product,fashion,generating,results,[id]}.tsx`, `src/ui/photoshoot/{options,start,describe}.ts`, `src/api/endpoints.ts:458-487`, copy in `src/i18n/locales/en/photoshoot.json`.

## Reuse map (don't rebuild)

| Need | Already there |
|---|---|
| Requests, 402 → paywall dialog, error text | `request()` / `ApiError` / `errorMessage` (`components/settings/api.ts`; 402 calls `openPaywall` itself) |
| "No answer" detection | `request()` rethrows `NetworkError` as `ApiError(0)`: status 0 = no answer; `ApiError` with status > 0 = it answered (Task 3 amendments) |
| Request id | `requestId()` (`lib/net.ts`) |
| Polling + shared cache | `useJob`, `JOB_INTERVALS.photoshoot` (5 s) / `.photoshootList` (10 s), `sharedAt`, `putShared` (`components/workspace/use-job.ts`) |
| Progress card | `JobProgress` + `JobStep` (`components/ui/job-progress.tsx`) |
| Photo source | `LibraryPicker` (`components/library/library-picker.tsx`, `onUse(photo: LibraryPhoto)`, `canUpload`, `children`) |
| Prices on buttons | `withPrice`, `creditsText` (`lib/plan-credits.ts`) |
| Page parts | `PageHeader`, `PageSection`, `PageSkeleton`, `EmptyState`, `StatusBadge`, `Button`, `Textarea`; page shell as `app/(shell)/library/page.tsx` |
| Flag + nav | `requireFeature("photoshoot", ws)`; nav entry and `Camera` icon exist |

## Global Constraints

- Repos side by side: `C:\Users\INTEL\Desktop\Social Media Agent\apps\{server,web,mobile}`. Create branch `feature-2-photoshoot` from `main` in all three first. Commit only in the repo the task names.
- Run npm inside the repo with `--prefix .`. Windows, Git Bash.
- Every task leaves its repo green: server `npm run typecheck|lint|test --prefix .`; web `npm run typecheck|lint|test --prefix .` (typecheck runs `check-shared`); mobile `npm run typecheck --prefix .`.
- Shared code: edit `shared/` in the server only, then `npm run sync:shared --prefix .` (server) and commit the copies in web and mobile. Never hand-edit `web/shared` or `mobile/src/shared`.
- Phone behaviour unchanged (anti-goal). Server changes are additive except the media permission (spec §5.0).
- No new dependencies. Web tests unit-test pure logic only; components are checked by build, `scripts/audit-ui.ts` and the owner.
- Copy is the phone's English (`photoshoot.json`); desktop-only labels follow its tone. Never show provider error text.
- `DESIGN_SYSTEM.md`: one primary button per view (Generate on the studio; Variation on a shoot page), cards `rounded-2xl border border-border bg-card shadow-sm`, inputs `rounded-xl`, buttons pill, `focus-visible:ring-2 ring-ring`, icons `aria-hidden` beside text.
- Commit messages: the change and why. No co-author lines, no tool or session URLs, no mention of tests.
- Don't call paid providers; don't touch port 3100's running process.

## Review Focus

1. **A press with no answer, pressed again with the same choices** must reuse the request id (one charge); a press after the server answered (any status), or with changed choices, gets a new id. → Task 3 tests `press reuses the id only after no answer`.
2. **Switching business while a shoot runs** must not poll the old brand's shoot against the new brand (phone bug). → URLs carry `w`/`b`; studio and detail remount on `key={brandId}`; Task 4 step.
3. **Signed links older than ~50 min** (page left open) must be re-read before showing or downloading. → Task 3 `stale()` test; used by both hooks.
4. **Custom scene with an empty or whitespace brief**, or no source photo, must block Generate with visible text and send nothing. → Task 3 `generateBlocker` tests.
5. **Try again / Variation price and payload** must come from the shoot's own `input` and tier, even when the setup on the left differs. → Task 3 `retryRequest` test.

---

### Task 1: Shared photoshoot contract (server → web, mobile copies)

**Files (server):** Create `shared/photoshoot.ts`; modify `shared/index.ts`, `server/photoshoot/tiers.ts`, `server/photoshoot/shoot.ts`; test `tests/photoshoot-contract.test.ts`. **Mobile:** modify `src/api/endpoints.ts:458-472`, synced `src/shared/**`. **Web:** synced `shared/**`.

**Interfaces — Produces (`@/shared`):**
```ts
export const SHOOT_TIER_IDS = ["base", "moderate", "higher", "ultra"] as const;
export type ShootTier = (typeof SHOOT_TIER_IDS)[number];
export const SHOOT_CREDITS: Readonly<Record<ShootTier, number>> = { base: 4, moderate: 6, higher: 12, ultra: 24 };
export const PRODUCT_RATIOS = ["1:1", "4:5", "9:16"] as const;
export const SCENES = ["studio", "interior", "custom"] as const;
export const FASHION_RATIOS = ["4:5", "9:16"] as const;
export const MODELS = ["natural", "editorial", "casual"] as const;
export const MODEL_NAMES: Readonly<Record<(typeof MODELS)[number], string>> = { natural: "Léa", editorial: "Inès", casual: "Hugo" };
export const POSES = ["fullBody", "threeQuarter", "closeUp"] as const;
export const BACKGROUNDS = ["studioMinimal", "urbanStreet", "naturalInterior"] as const;
export const BRIEF_MAX = 600;
export type ShootRequest =
  | { kind: "product"; tier: ShootTier; sourceKey: string; ratio: (typeof PRODUCT_RATIOS)[number]; scene: (typeof SCENES)[number]; brief: string }
  | { kind: "fashion"; tier: ShootTier; sourceKey: string; ratio: (typeof FASHION_RATIOS)[number]; model?: (typeof MODELS)[number]; pose: (typeof POSES)[number]; background: (typeof BACKGROUNDS)[number] };
export type ShootStatus = "RUNNING" | "DONE" | "FAILED";
export type Shoot = { id: string; kind: ShootRequest["kind"]; tier: ShootTier; status: ShootStatus; input: ShootRequest; credits: number; failed: boolean; createdAt: string; sourceUrl: string; shots: { key: string; url: string; downloadUrl?: string }[] };
```
(`downloadUrl` is filled by Task 2.)

- [ ] **Step 1: Failing test** `tests/photoshoot-contract.test.ts`: `SHOOT_CREDITS` equals `{ base: 4, moderate: 6, higher: 12, ultra: 24 }`; `TIERS[id].credits === SHOOT_CREDITS[id]` for every id; `ShootRequest.parse({ kind: "product", tier: "base", sourceKey: "k", ratio: "4:5", scene: "custom", brief: "  " })` throws; a compile-time check that `z.output<typeof ShootRequest>` and the shared `ShootRequest` are mutually assignable (`expectTypeOf(...).toEqualTypeOf<...>()`).
- [ ] **Step 2:** Run `npm test --prefix . -- tests/photoshoot-contract.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Write `shared/photoshoot.ts` as above; export from `shared/index.ts`. In `tiers.ts` keep `export const SHOOT_TIERS = SHOOT_TIER_IDS` and `ShootTier` re-export (callers unchanged) and read each tier's `credits` from `SHOOT_CREDITS`. In `shoot.ts` build the zod enums from the shared tuples and `max(BRIEF_MAX)`; `shootView`'s return `satisfies Shoot`.
- [ ] **Step 4:** Server typecheck, lint, test green (incl. existing `photoshoot-tiers` and `photoshoot-request-id`).
- [ ] **Step 5:** `npm run sync:shared --prefix .`. Mobile: `SHOOT_TIERS = SHOOT_TIER_IDS.map((id) => ({ id, credits: SHOOT_CREDITS[id] }))`, `ShootTier`, `ShootRequest`, `Shoot` re-exported from `@/shared` (drop the hand copies; callers unchanged). Mobile typecheck green; web typecheck green.
- [ ] **Step 6:** Commit in server, then web (synced copy), then mobile.

### Task 2: Creators may upload; download links (server)

**Files:** modify `app/api/v1/workspaces/[workspaceId]/brands/[brandId]/media/route.ts:18`, `server/storage/media.ts` (`signedMediaUrl`), `server/photoshoot/shoot.ts` (`shootView`); test `tests/media-upload-permission.test.ts`, extend `tests/photoshoot-contract.test.ts`.

**Interfaces — Produces:** `signedMediaUrl(key: string, expiresInSeconds = 3600, downloadAs?: string): Promise<string>` — when `downloadAs` is given, the command carries `ResponseContentDisposition: \`attachment; filename="${downloadAs}"\``. `shootView` shots: `{ key, url, downloadUrl }` with `downloadAs = \`photoshoot-${shortId}-${index + 1}.jpg\`` (`shortId` = first 8 chars of the shoot id).

- [ ] **Step 1: Failing tests:** (a) media POST calls `authorizeBrandRoute` with `"content.create"` (mock it the way `tests/subscription-route.test.ts` mocks its auth, returning a 403 Response, and assert the permission argument); (b) with the presigner mocked, `signedMediaUrl("k", 3600, "a.jpg")` passes `ResponseContentDisposition: 'attachment; filename="a.jpg"'`, and without the third argument passes none.
- [ ] **Step 2:** Run both → FAIL.
- [ ] **Step 3:** Change the permission to `"content.create"`, with a one-line comment: Creators upload the photo they shoot (owner, 2026-11-18); every role with `publish.execute` also has `content.create`. Add the optional `downloadAs`; fill `downloadUrl` in `shootView`.
- [ ] **Step 4:** Server typecheck, lint, test green.
- [ ] **Step 5:** Commit (server).

### Task 2b: Lens fixes on the server, and the library's upload button (server + web)

Added after the four plan lenses (2026-11-18). **Files (server):** `server/photoshoot/shoot.ts` (`shootView`, `getShoot`, `listShoots`), `server/storage/media.ts`, `app/api/v1/workspaces/[workspaceId]/brands/[brandId]/media/route.ts`; tests in `tests/photoshoot-contract.test.ts`, `tests/media-upload-permission.test.ts`. **Web:** `app/(shell)/library/page.tsx`.

- [ ] **Step 1 (performance):** `shootView(s, { download = false } = {})`: fill `downloadUrl` only when `download` is true. `getShoot` (single read) passes `{ download: true }`; `listShoots` and the create response do not. `Shoot.shots[].downloadUrl` stays optional, so the phone is unaffected. Test: list view has no `downloadUrl`; single view has it.
- [ ] **Step 2 (security):** `signedMediaUrl(..., downloadAs)` throws when `downloadAs` doesn't match the module's existing `FILE_NAME` regex (`media.ts`). Test: `'a".html'` throws.
- [ ] **Step 3 (security):** media POST gets a per-user `hitRateLimit` (helper in `server/auth/rate-limit.ts`, used the way `publishing.ts` uses it): 60 uploads per hour per user, 429 past it. Test: the limit is checked with the user id and a 429 is returned when it says no.
- [ ] **Step 4:** server typecheck, lint, test green; commit (server).
- [ ] **Step 5 (keeps UI and server in step):** web `app/(shell)/library/page.tsx`: `canUpload={perms.has("content.create")}` (was `publish.execute`), plus any doc comment saying otherwise. Web typecheck, lint, test green; commit (web).


### Task 3: Photoshoot logic and data hooks (web)

**Files:** create `components/photoshoot/shoot.ts` (pure), `components/photoshoot/api.ts`, `components/photoshoot/use-shoots.ts`; test `tests/photoshoot.test.ts`; modify `lib/status.ts` (add `DONE` to the `good` group) and `tests/status.test.ts`.

**Interfaces — Produces:**
```ts
// shoot.ts (pure, no React)
export type ProductSetup = { sourceKey: string | null; sourceTitle: string | null; sourceUrl: string | null; ratio: (typeof PRODUCT_RATIOS)[number]; scene: (typeof SCENES)[number]; brief: string; tier: ShootTier };
export type FashionSetup = { sourceKey: string | null; sourceTitle: string | null; sourceUrl: string | null; ratio: (typeof FASHION_RATIOS)[number]; model: (typeof MODELS)[number] | null; pose: (typeof POSES)[number]; background: (typeof BACKGROUNDS)[number]; tier: ShootTier };
export const DEFAULT_PRODUCT: ProductSetup;   // { sourceKey: null, ratio: "1:1", scene: "studio", brief: "", tier: "base" }
export const DEFAULT_FASHION: FashionSetup;   // { sourceKey: null, ratio: "4:5", model: null, pose: "fullBody", background: "studioMinimal", tier: "base" }
export function generateBlocker(kind: "product" | "fashion", s: ProductSetup | FashionSetup): string | null;
export function toRequest(kind, s): ShootRequest;            // only when generateBlocker is null; omits model when null; trims brief
export function retryRequest(shoot: Shoot): ShootRequest;    // shoot.input as sent; price = SHOOT_CREDITS[shoot.input.tier]
export function shootTitle(input: ShootRequest): string;      // "Product · Studio" | "Fashion · Full body"
export function shootSteps(shoot: Shoot | null): JobStep[];   // phone generating.tsx:53-57 mapped to JobStep states
export function waitLine(tier: ShootTier): string;
export function stale(fetchedAtMs: number, now?: number): boolean; // older than 50 min
export function countByKind(shoots: Shoot[]): { all: number; product: number; fashion: number };
export const LABELS: { scenes: Record<Scene, string>; poses: Record<Pose, string>; backgrounds: Record<Background, string>;
  formats: Record<FashionRatio, string>; models: Record<Model, string>; tiers: Record<ShootTier, { name: string; desc: string }> };
// phone en strings: scenes Studio/Interior/Custom; poses Full body/Three-quarter/Close-up detail; backgrounds Studio minimal/
// Urban street/Natural interior; formats 4:5 "Feed portrait", 9:16 "Story / Reel"; models "Léa · natural styling" etc.
export function makePresser(send: (r: ShootRequest, requestId: string) => Promise<Shoot>, newId?: () => string):
  (r: ShootRequest) => Promise<Shoot>;
// api.ts
export const shootsUrl = (w: string, b: string) => string;   // /api/v1/workspaces/{w}/brands/{b}/photoshoots
export const shootUrl = (w: string, b: string, id: string) => string;
export const photoshootApi = { create(w, b, r: ShootRequest, requestId: string): Promise<Shoot> };  // POST, timeoutMs SLOW_MS, unwraps { shoot }
// use-shoots.ts
export function useShoots(w: string, b: string): { data: Shoot[] | null; failed; slow; reload };  // done: none RUNNING and !stale
export function useShoot(w: string, b: string, id: string): { data: Shoot | null; failed; slow; reload }; // done: status !== RUNNING and !stale
```

Copy fixed by the spec / phone (use verbatim):
- `generateBlocker`: product without photo → `"Choose a photo"`; custom scene with blank brief → `"Describe the scene to use Custom."`; fashion without photo → `"Upload a garment photo to enable generation"`.
- `shootSteps` labels: `"Processing catalog asset"`, `"Composing scene & lighting"`, `"Finishing & color calibration"`; `null` → active/waiting/waiting; RUNNING → done/active/waiting; DONE → done ×3; FAILED → done/failed/waiting.
- `waitLine`: ultra → `"Four photos at Ultra quality, usually ready in a few minutes."`; else `"Four photos, usually ready in about a minute."`
- Tier labels: Base "Quick drafts to try ideas", Moderate "Sharper detail and light", Higher "Campaign-ready quality", Ultra "Our best, for print and ads".

`makePresser` (the phone's `startShoot` rule, `mobile/src/ui/photoshoot/start.ts`): keep `{ key: JSON.stringify(request), id }` of the last unanswered press; reuse `id` when the new request's key matches; clear it on success or when the error is an `ApiError` (the server answered); keep it on `NetworkError`; rethrow every error.

- [ ] **Step 1: Failing tests** `tests/photoshoot.test.ts`:
  - `press reuses the id only after no answer`: send rejects `new NetworkError("timeout")` then resolves → both calls got the same id; after a resolve, the next press gets a new id; after an `ApiError(402)` the next press gets a new id; a changed request gets a new id.
  - `generateBlocker` cases above, plus `brief: "   "` blocks and a filled custom brief passes; `toRequest` drops `model: null` and trims the brief.
  - `retryRequest` returns the shoot's `input` (tier "ultra") even though `DEFAULT_PRODUCT.tier` is "base".
  - `shootSteps` for null / RUNNING / DONE / FAILED; `shootTitle` for both kinds; `waitLine`; `stale` at 49 and 51 minutes; `countByKind`.
  - `tests/status.test.ts`: `toneOf("DONE") === "good"`.
- [ ] **Step 2:** Run `npm test --prefix . -- tests/photoshoot.test.ts tests/status.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Hooks use `useJob` with `JOB_INTERVALS.photoshootList` / `.photoshoot`, `pick` unwrapping `{ shoots }` / `{ shoot }`, and `stale(sharedAt(url))` in `done` so an idle page re-reads old links.
- [ ] **Step 4:** Web typecheck, lint, test green.
- [ ] **Step 5:** Commit (web).

**Amendments (four plan lenses, 2026-11-18). These override the text above where they differ:**
- **Critical: what "no answer" means on the web.** `request()` rethrows every `NetworkError` as `ApiError(0, …)` (`components/settings/api.ts:128-133`), so the presser clears the pending id **only on success or on `e instanceof ApiError && e.status > 0`**, and keeps it on `ApiError` with status 0 and on any non-`ApiError` (the phone's rule, `mobile/src/ui/photoshoot/start.ts:25`). The test's mocked send rejects with `new ApiError(0, "timeout")` (the shape `request()` really throws), plus one raw `NetworkError` case, plus `ApiError(402)`, `ApiError(503)` and `ApiError(429)` → new id next time.
- **Record before send.** `makePresser` stores `{ key, id }` **before** `await send(...)`. Test: two overlapping calls with the same request (send unresolved) get the same id.
- **Presser lifetime.** Export one module-level presser for the studio and shoot page (`press.ts`: `export const pressShoot = makePresser(...)` bound to `photoshootApi.create`), like the phone's module state, so leaving and coming back keeps an unanswered id. Put a comment in `press.ts` and in `mobile/src/ui/photoshoot/start.ts` pointing at each other ("same rule, keep in step"); that comment is the only mobile change (commit in mobile).
- **File split.** `shoot.ts` (pure: setups, defaults, blocker, toRequest, retryRequest, steps, countByKind, keepLinks, isShootId), `labels.ts` (LABELS, shootTitle, waitLine), `press.ts` (makePresser, pressShoot). Share `type Source = { sourceKey: string | null; sourceTitle: string | null; sourceUrl: string | null }` in both setups.
- **One stale rule.** Don't add `stale()` to `shoot.ts`. In `components/workspace/use-job.ts` beside `sharedAt`, add `export const SIGNED_LINK_STALE_MS = 50 * 60_000` and pure `export function stale(fetchedAtMs: number, now = Date.now()): boolean`; `components/library/use-brand-look.ts` uses them instead of its own `STALE_MS` (no behaviour change). The 49/51-minute test lives with it.
- **Idle pages must re-read.** `useShoots`/`useShoot` set a one-shot timer for `sharedAt(url) + SIGNED_LINK_STALE_MS` that calls `reload()` (cleared on unmount / url change), because `done` is only evaluated on render.
- **Stable image links.** Pure `keepLinks(prev: Shoot | undefined, next: Shoot, prevFetchedAt: number, now?: number): Shoot` keeps `prev`'s `sourceUrl`, and each shot's `url`/`downloadUrl` for the same `key`, while `prev` is not stale, so `<img src>` doesn't change on every poll. The hooks apply it per shoot id. Tests: same key + fresh → old url kept; stale → new url; new key → new url.
- **`useJob` stop on 404 (additive).** Add an optional `stopOn?: readonly number[]` option and an additive `status: number | null` (last error's HTTP status, from `ApiError.status`) to `useJob`'s return. When an error's status is in `stopOn`, polling stops and `failed` is true. Existing callers pass nothing and behave exactly as before. Both shoot hooks pass `stopOn: [403, 404]`.
- **Prices.** Export `creditsText` from `lib/plan-credits.ts` (additive). Add `shootPrice(sub, tier): number | null` beside `agentRunPrice` (null when `sub` unread or `sub.unlimited`, else `SHOOT_CREDITS[tier]`) with cases in `tests/plan-credits.test.ts`. Every Generate / Try again / Variation label uses `withPrice(label, shootPrice(sub, tier))`.
- **Charged vs refunded amounts** shown on a shoot ("Processing · N credits", "Didn't work · N credits refunded", "Your N credits are back") come from `shoot.credits` via `creditsText`; `SHOOT_CREDITS`/`shootPrice` only price a new press.
- **Labels.** `LABELS.models` built from `MODEL_NAMES` (`${MODEL_NAMES[m]} · ${style}`), not a second copy of the names.
- **Brief length.** `generateBlocker` also blocks `brief.trim().length > BRIEF_MAX` with "Keep the brief under 600 characters." (build the number from `BRIEF_MAX`).
- **URLs.** `shootUrl` encodes the id with `encodeURIComponent`. Pure `isShootId(s: unknown): s is string` (UUID shape) for reading `?shoot=` and `[id]`.


### Task 4: Kit controls and the studio page (web)

**Files:** create `components/ui/segmented.tsx`, `components/ui/choice-cards.tsx`, `components/photoshoot/{studio,product-setup,fashion-setup,current-shoot,past-shoots,shoot-card}.tsx`, `app/(shell)/photoshoot/page.tsx`; modify `app/(shell)/library/page.tsx` (`canUpload={perms.has("content.create")}`), `scripts/audit-ui.ts` (add `/photoshoot`).

**Interfaces — Produces:**
```ts
// segmented.tsx — a radio group drawn as a pill switch
export function Segmented<T extends string>(p: { label: string; value: T; onChange: (v: T) => void; options: readonly { value: T; label: string }[]; name: string }): JSX.Element;
// choice-cards.tsx — radio cards
export function ChoiceCards<T extends string>(p: { legend: string; value: T | null; onChange: (v: T) => void; name: string; columns?: 2 | 3 | 4;
  options: readonly { value: T; title: string; description?: string; meta?: string }[] }): JSX.Element;
// studio.tsx (client)
export function Studio(p: { workspaceId: string; brandId: string; canCreate: boolean; canUpload: boolean; initialShootId: string | null }): JSX.Element;
```
Both controls: `<fieldset>` + `<legend>`, native `<input type="radio" class="sr-only">` inside each `<label>` (arrow keys and one tab stop come free), selected = ring + check icon, focus via `has-[:focus-visible]:ring-2 ring-ring`.

Layout and behaviour (spec §5.2): `PageHeader` "Photoshoot" / "Create product photos and style apparel on models."; `Segmented` Product | Fashion; `grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]` (stacks below `lg`); left `PageSection` "Setup", right "This shoot"; below, "Past photoshoots" with `Segmented` filter `All (n) | Product (n) | Fashion (n)` and a grid of `ShootCard` links to `/photoshoot/{id}` (first shot, or the source photo while running; `shootTitle`; date; `StatusBadge`: RUNNING "Processing · N credits", DONE "Ready", FAILED "Didn't work · N credits refunded").
- Studio state: one `ProductSetup` and one `FashionSetup` kept side by side; the switch only changes which one shows.
- Source photo row: thumbnail + title + "Change" opening `LibraryPicker` (`canUpload`); for fashion, the garment hint and the three upload requirements as text inside the picker's `children` and under the row.
- Generate: `withPrice("Generate photoshoot", SHOOT_CREDITS[tier])`; disabled while pressing or when `generateBlocker` is non-null, the reason shown as text under it (`aria-describedby`). On success: set the current shoot id and `router.replace("/photoshoot?shoot=" + id)` (survives reload). Errors other than 402 (paywall opens itself): `errorMessage(e)` in a `role="alert"` line; a 503 shows the server's sentence.
- Current shoot (`current-shoot.tsx`, `useShoot`): `JobProgress` with `shootSteps`, title `waitLine`; DONE → four thumbnails + "Open shoot" link; FAILED → `"This photoshoot didn't work"` + `"Your N credits are back. Try again, or pick another quality."` + secondary button `withPrice("Try again", SHOOT_CREDITS[shoot.input.tier])` pressing `retryRequest(shoot)` through the same presser.
- `canCreate` false: no Setup column; the line "Your role can view photoshoots but not start them." above Past photoshoots.
- Page: copy `/library`'s no-business and no-`brand.read` states; `canCreate = perms.has("content.create")`, `canUpload` the same; `initialShootId` from `searchParams.shoot`; render `<Studio key={brandId} …/>`.

- [ ] **Step 1:** Build the two kit controls; web typecheck + lint green.
- [ ] **Step 2:** Build the studio parts and page as above.
- [ ] **Step 3:** `npm run build --prefix .` and `npm run check:bundle --prefix .` pass; typecheck, lint, test green.
- [ ] **Step 4:** Commit (web).

**Amendments (four plan lenses, 2026-11-18). These override the text above where they differ:**
- **No implicit submit.** Setup is not a `<form>`; Generate is `type="button"` with `onClick`. Enter on a radio card or switch never starts a shoot.
- **Double click.** Besides `disabled`, guard Generate and Try again with a ref (`pressingRef`) so a second click in the same frame returns early; the presser's record-before-send rule (Task 3) is the second guard.
- **Kit naming and reuse.** No second export named `Segmented` (`components/admin/ui.tsx` has a link version). Build `SegmentedRadios` in `components/ui/segmented-radios.tsx` from `SourceSwitch`'s markup (`components/library/photo-grid.tsx`), with an optional per-option count, and make `SourceSwitch` a thin wrapper over it (visual no-op). `ChoiceCards` stays its own file; its relation to `PhotoGrid`'s pick tiles is noted in DESIGN_SYSTEM (Task 6), no PhotoGrid refactor.
- **URL tied to brand.** After Generate: `router.replace("/photoshoot?shoot=" + id + "&b=" + brandId)`. The page passes `initialShootId` only when `isShootId(searchParams.shoot)` and `searchParams.b === brandId`. Ignore a create result if the studio unmounted or its brand changed (alive ref): no navigation, no state set.
- **New shoot shows at once.** On a successful create: `putShared(shootUrl(w,b,id), { shoot })` and `putShared(shootsUrl(w,b), { shoots: [shoot, ...old without that id] })` so the card and Past photoshoots show it and the list starts polling (it now holds a RUNNING shoot). Then `void loadPlanCredits(workspaceId, true)`.
- **Credits chip.** Also `void loadPlanCredits(workspaceId, true)` once when the current shoot turns FAILED (refund).
- **Completion announced.** Keep `JobProgress` mounted on DONE and FAILED, with the photos / failed text below it, so its polite live region announces completion.
- **Images.** `ShootCard` is `React.memo`; grid and thumbnail `<img>` get `loading="lazy" decoding="async"`. Load `LibraryPicker` with `next/dynamic` (opened on demand).
- **Brief.** `Textarea maxLength={BRIEF_MAX}` as well as the blocker.
- **Prices** via `shootPrice` (Task 3); unlimited workspaces show no price.
- **Ceiling (comment in `studio.tsx`):** while a shoot runs, the studio polls the list (10 s) and the shoot (5 s); fine at today's scale; upgrade path is to drop the list's poll while the current card tracks the only RUNNING shoot.


### Task 5: One shoot page (web)

**Files:** create `components/photoshoot/shoot-detail.tsx`, `app/(shell)/photoshoot/[id]/page.tsx`; modify `scripts/audit-ui.ts` (add `/photoshoot/[id]` only if a fixture id exists; otherwise note it in the handover).

**Interfaces — Consumes:** `useShoot`, `shootTitle`, `retryRequest`, `makePresser`, `photoshootApi`, `shootSteps`, `waitLine`, `LABELS`, `MODEL_NAMES`. **Produces:** `ShootDetail(p: { workspaceId; brandId; shootId; canCreate: boolean })`.

Behaviour (spec §5.3): `PageHeader` with `shootTitle`, date, `StatusBadge`, back link "Back to photoshoots". Four photos in a grid of `<button>`s, each `aria-label` "Photo {i} of 4, {title}", `aria-pressed` on the selected one; selected shown large. "Compare original" toggle button (`aria-pressed`) shows the source photo beside the selected one, alt "Original photo". "Download photo": `<a href={shot.downloadUrl ?? shot.url} download>`; check before each click with `stale()` and reload first if stale. "Variation" primary button `withPrice("Variation", SHOOT_CREDITS[shoot.input.tier])` with the visible text "Runs the same setup again and is charged again." beside it; on success `router.push("/photoshoot?shoot=" + newId)`. Staging summary list: Format ("{ratio} format"), scene / pose / background / model ("A model chosen for the garment" when none), brief or "No art direction: staged as the scene style describes.", Creation cost (`creditsText`). RUNNING → `JobProgress`; FAILED → the refunded line. `canCreate` false → no Variation. Unknown id → the server's 404 through `LoadError`. Page remounts on `key={brandId}`.

- [ ] **Step 1:** Build as above.
- [ ] **Step 2:** Build, bundle check, typecheck, lint, test green.
- [ ] **Step 3:** Commit (web).

**Amendments (four plan lenses, 2026-11-18). These override the text above where they differ:**
- **Download.** A `<button>` (not a bare anchor): if the shoot's data is stale, `await reload()` and read the fresh shot from `sharedResponse(url)`; then `location.assign(downloadUrl)` (the attachment disposition keeps the page in place). Only the shoot page offers Download (only `getShoot` returns `downloadUrl`); if `downloadUrl` is missing, the control reads "Open full size" and opens `url` in a new tab.
- **Not found.** `useShoot` with `stopOn: [403, 404]`: on `status === 404` show "Photoshoot not found" with a link back to `/photoshoot`; no polling loop. `isShootId(params.id)` false → the same state without a request.
- **Variation.** Through the module-level `pressShoot` with `retryRequest(shoot)`; double-click guard by ref; on success `putShared` the new shoot and the list (as Task 4), `void loadPlanCredits(workspaceId, true)`, then `router.push("/photoshoot?shoot=" + newId + "&b=" + brandId)`. Ignore the result if unmounted.
- **Amounts.** Creation cost and refund lines use `shoot.credits` via `creditsText`; Variation's price `shootPrice(sub, shoot.input.tier)`.
- **Bundle note.** `check:bundle` does not measure size; record `/photoshoot` and `/photoshoot/[id]` first-load JS from the `next build` route table in this task's report.


### Task 6: Documentation and whole-slice check

**Files (server):** `docs/HANDOVER.md` (new "Feature 2: photoshoot on the web" section at the top: what was built, the calls made in the spec, manual checks below, not-checked-live list; fix feature 1's "add photo = publish.execute" line), `docs/DESIGN_SYSTEM.md` (add `Segmented`, `ChoiceCards`; `JobProgress`/`LibraryPicker` now have their consumer).

Owner's manual checks to list: flag off → `/photoshoot` 404, no nav entry; double-click Generate → one shoot, one charge; 402 → paywall; Custom with blank brief blocks Generate with text; Creator can upload in the picker; Viewer sees read-only studio; keyboard through every radio group; 375 px no horizontal scroll; switch business mid-shoot → no 404 loop; Download saves a file; reload with `?shoot=` keeps the card.

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** All three repos green (server typecheck/lint/test; web typecheck/lint/test/build/check:bundle; mobile typecheck).
- [ ] **Step 3:** Commit (server).

**Amendments (four plan lenses, 2026-11-18):**
- Grep `docs/HANDOVER.md` and `docs/DESIGN_SYSTEM.md` for `JobProgress`, `publish.execute`, `LibraryPicker`, `SourceSwitch`, `Segmented`, `STALE_MS` and fix every stale line (e.g. "JobProgress has no consumer yet").
- DESIGN_SYSTEM: `SegmentedRadios` (and `SourceSwitch` now wrapping it; admin `Segmented` is the link version), `ChoiceCards` and its relation to `PhotoGrid` pick tiles, `useJob`'s `stopOn`/`status`, `SIGNED_LINK_STALE_MS`, `shootPrice`.
- Handover adds: custom roles need `content.create` to upload (dev DB has none); Creators can fill the brand library (60) that only `context.edit` can empty; media upload limit 60/hour/user; the press rule lives on web (`press.ts`) and phone (`start.ts`), keep in step; the phone's option lists in `mobile/src/ui/photoshoot/options.ts` are `satisfies`-checked only, not derived from shared; first-load JS for the two routes; no bundle size check exists.
- Owner's manual checks add: Enter on a radio card doesn't start a shoot; switching business on `/photoshoot?shoot=…` shows an empty "This shoot", no loop; a new shoot appears in Past photoshoots at once; the credits chip drops after Generate and rises after a refund; a page left open over an hour still shows photos and downloads.
