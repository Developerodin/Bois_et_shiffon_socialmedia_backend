# Server/Web split review: separation and simplicity

Branch `server-web-split` (head c2ea9c5) against `desktop-shell`. Read-only review; the only things run were `npm run lint`
and ESLint over stdin with no files written (`npx eslint --stdin --stdin-filename <path inside the app>`).

## Summary

The split is clean. No runtime import crosses the boundary in either direction: I grepped all three apps for
relative climbs, `@/server`, `@/auth`, `@/components` in the server, and the workspace package names. `npm run lint`
reports 0 errors (9 warnings, all from before this branch). No `eslint-disable no-restricted-imports` is left. The
shared package has no dependencies, and helpers moved into it rather than being copied. `vercel.json` and
`worker-dev.ts` are gone, and no script still uses `-w web`.

The guard rails have one real hole. npm workspaces symlink every app into the root `node_modules` under its package
name, so `import … from "server/…"` from the website resolves (confirmed with `require.resolve`). It also passes both
ESLint configs, and the shared package's config lets in any bare import. The rest are orphans the split left behind,
plus some stale paths in docs and comments.

Counts: **Critical 0 · Important 1 · Minor 8**.

## Critical findings

None.

## Important findings

### I1. The boundary lint rules miss workspace package names, `@/..` and `./..` climbs, and the shared package's imports

- **Where:** `apps/web/eslint.config.mjs:24-29`, `apps/server/eslint.config.mjs:22-26`,
  `packages/shared/eslint.config.mjs:9`.
- **What I ran** (ESLint over stdin, file names inside each app):

  | From | Import | Caught? |
  |---|---|---|
  | web `components/a.tsx` | `server/server/db/prisma` | **no** |
  | web `components/a.tsx` | `@/../server/server/db/prisma` | **no** |
  | web `components/a.tsx` | `./../../server/server/db/prisma` | **no** |
  | web `components/a.tsx` | `import("../../server/…")` (dynamic) | **no** |
  | web `components/x/a.tsx` | `../../../server/server/db/prisma` | yes |
  | web, 6 folders deep | `../../../../../../../server/auth` | yes |
  | web | `export * from "../../server/…"` | yes |
  | web | `next-auth` / `@prisma/client/edge` | yes; `next-auth/react` allowed, as intended |
  | server `server/x/a.ts` | `web-frontend/components/ui/button` | **no** |
  | server `server/x/a.ts` | `@/../web/lib/utils` | **no** |
  | server | `@/components/ui/button`, `../../../web/…` | yes |
  | shared `src/a.ts` | `fs`, `server/server/db/prisma`, `../../../apps/server/auth`, `@prisma/client/runtime/library` | **no** |
  | shared | `node:fs`, `process.env.X` | yes |

  `node -e "require.resolve('server/auth.ts')"` run from `apps/web` returns `apps/server/auth.ts`, and the same works
  for `web-frontend/…` from `apps/server` and for `server/…` from `packages/shared`. The server's `package.json` has
  no `exports` field, so every deep path resolves.
- **Failure scenario:** an editor's auto-import suggests `server/server/content/rules`, or someone adds a "small"
  helper import to `@espanda/shared` that reaches into `../../../apps/server`. Lint and tsc both pass, and the
  website bundle pulls in server code. `check:web-bundle` would catch it only if the code that comes along names
  `PrismaClient` or a listed secret. Nothing backstops the server → web direction. The shared package is a conduit:
  anything it imports reaches both apps, and its rule doesn't enforce the spec's "no dependencies".
- **Fix (a few lines per config):**
  - Web: add `"server", "web-frontend", "mobile-app"` to `paths` and `"server/*", "mobile-app/*"` to the `group`.
    Add `{ regex: "^@/\\.\\.(/|$)" }`, and widen the climb regex to `^(\\./)?(\\.\\./){N,}`.
  - Server: the mirror, `"web-frontend", "web-frontend/*", "mobile-app", "mobile-app/*"`, plus the same `@/..` and
    `./..` regexes.
  - Shared: allow only relative imports that stay inside `src`. With
    `patterns: [{ regex: "^(?!\\./|\\.\\./)" }, { regex: "^(\\.\\./){2,}" }]` (files sit at most one folder deep),
    "no dependencies" holds by construction, and the `node:*`, `zod` and `@prisma/client` entries become redundant.
  - Dynamic `import()` isn't covered by `no-restricted-imports`. It isn't worth a plugin; the bundle check covers the
    web side.
  - I tried `import/no-restricted-paths` (from eslint-config-next's import plugin) as a sturdier replacement. It
    caught the plain relative forms but not `server/…` or `@/../…` with the current resolver setup, so it is not a
    drop-in fix.

## Minor findings

### M1. `PendingButton` is orphaned
- **Where:** `apps/web/components/auth/pending-button.tsx` (whole file).
- Its only user was the old server-action `/login` page (`desktop-shell:apps/web/app/login/page.tsx:2`). The new
  `login-form.tsx` doesn't use it, and nothing else does (`grep PendingButton` finds only the definition). It is also
  the only `useFormStatus` user, a leftover from server actions.
- **Fix:** delete the file.

### M2. `requirePlatformAdminPage` is dead on the Server
- **Where:** `apps/server/server/auth/platform-admin.ts:26-35`, plus the imports it alone needs at lines 1-3
  (`notFound`/`redirect` from `next/navigation`, `cache` from `react`, `auth` from `@/auth`).
- It guarded admin *pages* with `redirect("/login")` and `notFound()`. Pages now live on the website, which guards
  them through the API's 404, so nothing calls it. A future route that reaches for it would 307 to a `/login` the
  Server doesn't serve.
- **Fix:** delete the function and those three imports.

### M3. Types and a re-export orphaned by the move to shared types
- **Where:** `apps/server/server/services/platform-admin.ts:332` (`SpendBreakdown`), `:424` (`LogRow`) and `:445`
  (`PickerOptions`); `apps/server/server/services/activity.ts:107` (`export { NO_WORKSPACE }`).
- The website's admin components used to import these. They now read `@espanda/shared`'s `AdminSpend`,
  `AdminLogRow` and so on. Grep finds no importer in any app.
- **Fix:** delete them. Optionally inline `PAGE = ADMIN_PAGE_SIZE` (`platform-admin.ts:16`), an alias that only
  renames the shared constant.

### M4. The Server's `authorized` callback, and its middleware's redirect pass-through, can no longer fire
- **Where:** `apps/server/auth.config.ts:13-33`, and `apps/server/middleware.ts:12`.
- The Server's middleware matcher is `/api/v1/:path*`, so `isVersionedApi` is always true and the callback always
  returns `true`. Its public page list (`/login`, `/invite/`, …) duplicates the web middleware's `PUBLIC_PATHS`
  (`apps/web/middleware.ts:5`), which is the one that matters. The `3xx` pass-through in the Server's middleware is
  then unreachable. *Uncertain:* I don't know of another way Auth.js's `auth` middleware returns a redirect here.
- **Failure scenario:** someone edits the dead list, expecting it to change which pages are public.
- **Fix:** replace the callback with `authorized: () => true`, or drop it, and keep `pages.signIn` for any Auth.js
  redirect links. Keep or drop the pass-through as you prefer.

### M5. Shared holds a few one-sided runtime exports, and `PERMISSIONS`, which the spec excluded
- **Where:** only the Server uses `domainOf` (`packages/shared/src/website.ts:39`), `stepsText`
  (`by-hand-steps.ts:16`) and `SHELL_COOKIE_MAX_AGE` (`shell-cookies.ts:4`). `PERMISSIONS`
  (`packages/shared/src/permissions.ts`) is shared, but spec §Shared code line 165 says "Not shared: `PERMISSIONS`".
  The website now uses it for permission descriptions (`apps/web/components/admin/access.tsx:2`,
  `apps/web/app/(shell)/admin/workspaces/[workspaceId]/roles/page.tsx:1`).
- All of these are small, dependency-free and kept with their siblings, so there's no runtime cost. The
  `PERMISSIONS` change is a reasonable call: the admin pages need descriptions, and the alternative is a second
  fetch per page.
- **Fix:** note the `PERMISSIONS` decision in the spec or ledger. Moving the three server-only helpers back is
  optional and low value; I'd leave them.

### M6. A React Vite plugin with no React to transform
- **Where:** `apps/server/vitest.config.ts:2,6` and `apps/server/package.json` devDependency `@vitejs/plugin-react`.
  The same pattern is in `apps/web/vitest.config.ts:2,6`, but there it predates the branch.
- The Server has no `.tsx` files, and both configs include only `tests/**/*.test.ts`.
- **Fix:** drop the plugin and the server's devDependency. The web one is optional.

### M7. The web `check:net` script borrowed the Server's `react-server` condition
- **Where:** `apps/web/package.json:13`, `tsx --conditions=react-server scripts/check-net.ts`. On `desktop-shell`
  it was `tsx scripts/check-net.ts`.
- The script tests `lib/net.ts`, which is browser code. The condition exists for server modules that import
  `server-only`, so it is just noise here.
- **Fix:** revert to `tsx scripts/check-net.ts`.

### M8. Stale `apps/web` paths that now mean the Server
- **Where:**
  - `README.md:31,39`: `apps/web` is still "Next.js 15 platform (Prisma in `apps/web/prisma`)", Neon vars are copied
    into `apps\web\.env`, and only `npm run dev:web` is started.
  - `NOTICE.md:15-21`: attribution paths `apps/web/server/seo/checks.ts`, `…/prompts/seo-geo.ts` and
    `…/server/reels`.
  - 11 comments in `apps/mobile/src` (e.g. `src/ui/stories/limits.ts:3-4`, `src/api/endpoints.ts:152`,
    `src/app/onboarding/password.tsx:16`) that point at `apps/web/server/…`.
  - `docs/ARCHITECTURE.md` is being refreshed separately (Task 9), so I left it out.
- **Failure scenario:** a new developer following the root README starts only the website and gets 502s on every
  `/api` call. The attribution notice points at files that don't exist.
- **Fix:** `sed s#apps/web/server#apps/server/server#` over NOTICE.md and the mobile comments, and rewrite the
  README's table row and quick start to match `apps/server/README.md`.

## Deferred-minor triage

| Item | Verdict |
|---|---|
| `PendingButton` possibly unused | **Confirmed unused.** Delete (M1). |
| LF vs CRLF in new shared files | **No action.** `git ls-files --eol` shows every new shared file is `i/lf`. Some working copies are CRLF only because `core.autocrlf=true` on this machine. The repo is consistent, and `.gitattributes` pins LF where it matters (Dockerfiles, compose, `deploy/**`, `*.sh`). |
| `PINTEREST_PIN: 500` hard-coded in the draft editor (`apps/web/components/workspace/draft-editor.tsx:16`) | **Minor, optional.** The Server never had a named constant for it either: it truncates at `apps/server/server/integrations/publishers.ts:152` (`p.text.slice(0, 500)`), and `apps/server/server/services/publishing.ts:62` repeats `500`/`2200` literals. The split made this better (Threads now reads `CAPTION_LIMITS.threadsMax`). To finish it, add `pinDescriptionMax: 500` to `CAPTION_LIMITS` (`packages/shared/src/content-limits.ts:2`) and use it in those three places. It isn't a split regression. |
| Web middleware `healthz` matcher not anchored (`apps/web/middleware.ts:32`) | **Cosmetic.** `(?!api/|healthz|…)` skips the cookie check for any path starting with `healthz` (`/healthzz`, `/healthz/x`). No page lives there, and any page's data still comes from `serverFetch`, which turns a 401 into `/login`, so nothing is exposed. Write `healthz$` for clarity. `favicon.ico` and `icon.png` in the same pattern were unanchored before this branch. |

## What you checked and found sound

- **No cross-boundary imports.** Grepped all three apps for relative climbs, `@/server`, `@/auth`, `@prisma`,
  `@/components`/`@/lib` in the server, and the workspace names `server/`, `web-frontend/` and `mobile-app/`. The
  only hits are comments and the eslint configs. The mobile app imports none of the others; its diff is the package
  name, the `:3101` fallback and two env-path comments.
- **Lint and the existing rules.** `npm run lint` (server, web, shared) gives 0 errors. The depth-based climb rule
  catches deep relative imports at depth 0, 1 and 6 in the website and at depth 1 in the server. The 2-character
  subpath fix holds: `../ai/rsc` from `server/ai/` is allowed. `export … from` is caught. `next-auth` is banned while
  `next-auth/react` is allowed. `@prisma/*`, `@auth/*` and `@aws-sdk/*` subpaths are caught. No
  `eslint-disable no-restricted-imports` remains.
- **The shared package** has no runtime dependencies; its devDependencies are only for its own lint. It uses no
  `process`, `node:*`, zod or Prisma. It contains types and plain functions over plain types. Everything else in it
  is used by both apps, or by the Server plus the website's e2e tests (`SHELL_COOKIE_*`). Each app lists it in
  `transpilePackages`.
- **Nothing duplicated.** `period`/`PERIODS`, `normalizeWebsite`, `zoneCity`, `offerPercents`, the product-name
  helpers, `BY_HAND_STEPS` and `CAPTION_LIMITS` each have exactly one definition, in shared (I grepped both apps for
  definitions). `apps/web/components/admin/ui.tsx` re-exports `period` rather than copying it. The website's
  `stockLabel` next to the Server's `stockState` predates the branch; they are deliberate parallel rules, pinned by
  matching tests (`apps/web/tests/stock-label.test.ts`). The two `tests/stubs/server-only.ts` files are identical
  two-line stubs, which is fine.
- **Dependencies.** Every runtime dependency the website lists is imported, apart from `tailwindcss`, which loads
  via CSS. The website carries no Prisma, zod, jose, AWS or nodemailer; `next-auth` is there only for
  `next-auth/react`. Every Server dependency is imported. `server-only` guards `apps/web/lib/server-fetch.ts`, and no
  client component imports it.
- **No leftovers** of `vercel.json`, `scripts/worker-dev.ts`, `app/(shell)/actions/shell-context.ts` or `-w web` in
  scripts. `/api/v1/jobs/run` stays on purpose (spec line 229), and fails closed without `CRON_SECRET`.
  Build artefacts (`apps/server/dist`, `tsconfig.tsbuildinfo`, `apps/web/test-results`) are git-ignored.
- **Nothing over-built for its need.** The `api` template tag, `serverFetch` and the cached `getShell`, and the two
  health routes (web `/healthz` with no upstream call, Server `/api/v1/health` with no database) each have real
  callers in the compose health checks. The 12 per-depth eslint blocks look heavy, but they are the minimum
  `no-restricted-imports` allows. The resolver-based rule was weaker here (I1).
- **Not caused by the split:** `apps/server/server/services/publication-package.ts` has no importer, and had none on
  `desktop-shell` either.
