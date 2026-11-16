# Server (`apps/server`, package `server`)

Next.js **15** app with **only** API routes: `/api/v1/*` (website and phone), `/api/auth/*` (Auth.js sign-in), the
integration callbacks and the Higgsfield webhook. It holds everything the Web Frontend must not: `server/` (agents,
jobs, database, rendering), Prisma, Auth.js, and every secret. Pages live in the Web Frontend (`apps/web`), which
reaches this app only over HTTP.

The folder `server/` inside this app keeps its name (`apps/server/server/`): renaming it would touch every
`@/server/…` import.

- Dev port **3101**. The website (3100) rewrites `/api/*` here, so the browser sees one origin; `AUTH_URL` stays the
  website's address (`http://localhost:3100` in dev).
- `middleware.ts` runs on `/api/v1/*` only: it rolls the session cookie forward on each call.
- Env: copy `.env.example` to `.env` (see [`docs/ENV_SETUP.md`](../../docs/ENV_SETUP.md)).

## Prisma / database

- Schema: `prisma/schema.prisma` (Postgres on Neon — DEC-025)
- Migrations: `prisma/migrations/` via `npm run db:migrate`
- Seed: `npm run db:seed` (fixture `prisma/seeds/bc-brand.json`)
- Media: `server/storage/media.ts` (Neon Object Storage, private bucket `media`)

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Dev server (Turbopack), port 3101 |
| `npm run build` | Production build (`output: "standalone"`) |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest |
| `npm run db:migrate` | `prisma migrate dev` (direct URL) |
| `npm run db:deploy` | `prisma migrate deploy` (CI / hosted) |
| `npm run worker:dev` | Runs the job queue locally |
| `npm run seed:story` | Seeds a story on the dev brand (used by the website's e2e) |
| `npm run smoke:neon` | Live Postgres + Object Storage check |

From the repo root: `npm run dev:server`, `npm run db:migrate`, etc. Here: `npm run <script> -w server`.
