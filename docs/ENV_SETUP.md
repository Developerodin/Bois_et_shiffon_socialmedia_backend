# Environment setup (Windows / PowerShell)

Two apps: the **Server** (`apps/server`: API, worker, Next.js 15 + Prisma) and the **Web Frontend** (`apps/web`: pages). Database schema lives in **`apps/server/prisma`** — not at repo root.

**Database + media:** Neon — Postgres (Frankfurt, `aws-eu-central-1`) and Object Storage bucket `media` (private). Declared in root `neon.ts`; schema changes use Prisma Migrate — see DEC-025.

---

## 1. Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 22.19+ or 24.11+ | [nodejs.org](https://nodejs.org/) or `winget install OpenJS.NodeJS.LTS` |
| Neon account | — | Access to project `cmo-platform` (ask the owner for an invite) |
| Git | any | [git-scm.com](https://git-scm.com/download/win) |

No local database or Docker needed.

---

## 2. Install dependencies

```powershell
cd "C:\Users\INTEL\Desktop\Social Media Agent"
npm install
```

---

## 3. Neon credentials

```powershell
npx neon@latest login
npx neon@latest env pull     # writes DATABASE_URL, DATABASE_URL_UNPOOLED, AWS_* to repo-root .env.local
```

Prisma and the Server read **`apps/server/.env`**, so copy those variables there (`.env.local` and `.env` are both gitignored). The Web Frontend needs none of them.

`env pull` writes the storage credentials under the standard `AWS_*` names. The Server reads `STORAGE_*` instead (so an EC2 instance role cannot be picked up by mistake), so rename them when you copy:

| `env pull` writes | Put in `apps/server/.env` as |
|---|---|
| `AWS_ACCESS_KEY_ID` | `STORAGE_ACCESS_KEY_ID` |
| `AWS_SECRET_ACCESS_KEY` | `STORAGE_SECRET_ACCESS_KEY` |
| `AWS_ENDPOINT_URL_S3` | `STORAGE_ENDPOINT` |
| `AWS_REGION` | `STORAGE_REGION` |
| (bucket name, `media`) | `STORAGE_BUCKET` |

| Variable | Used for |
|----------|----------|
| `DATABASE_URL` | Pooled connection (`-pooler` host) — app queries |
| `DATABASE_URL_UNPOOLED` | Direct connection — `prisma migrate` (pooler breaks migrations) |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET` | Neon Object Storage (`apps/server/server/storage/media.ts`) |

Also set in `apps/server/.env`:

| Variable | How |
|----------|-----|
| `AUTH_SECRET` | Random 32+ bytes — e.g. `[Convert]::ToBase64String((1..32 \| ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]])` |
| `AUTH_URL` | `http://localhost:3100` (the **website**; production needs an https URL) |
| `SEED_OWNER_PASSWORD` | Dev-only password for seeded `owner@example.com` |

Paste **later** (Screens 5–11): AI keys, OAuth IDs, `CREDENTIALS_ENCRYPTION_KEY`. See `apps/server/.env.example`.

The Web Frontend's `apps/web/.env` holds only `SERVER_URL=http://localhost:3101` (copy `apps/web/.env.example`).

**Personal dev branch (recommended):** `npx neon@latest checkout dev-<name> --create` gives you an isolated copy of the database *and* bucket (expires after 7 days per `neon.ts`), then `env pull` again. Don't develop against `production`.

---

## 4. Migrate + seed

```powershell
npm run db:migrate    # prisma migrate dev — creates/applies migrations (direct URL)
npm run db:seed
```

Deploy environments run `npm run db:deploy` (`prisma migrate deploy`) instead.

Seed creates workspace + **Bois & Chiffons** brand from `apps/server/prisma/seeds/bc-brand.json` (fixture only — not hard-coded in app logic).

Live check of both Neon services (Postgres round-trip; storage put → presigned GET → delete):

```powershell
npm run smoke:neon -w server
```

---

## 5. Run the apps

```powershell
npm run dev:server   # Server on http://localhost:3101
npm run dev:web      # website on http://localhost:3100, proxies /api to the Server
```

Open [http://localhost:3100/login](http://localhost:3100/login) — seeded email `owner@example.com` and `SEED_OWNER_PASSWORD`.

Reddit Devvit app (unchanged): `npm run dev:reddit`

### Background jobs (scheduled posts, agent retries, emails)

Jobs wait in Postgres until something runs the queue. Locally, three things do:

1. **Any action that queues work** (Run agent, Publish now, invite) starts it straight away in the Server (`RUN_JOBS_IN_API` is on unless set to `false`).
2. **The open app**: while anyone has the workspace open, overdue jobs run within about 30 s.
3. **The worker**: `npm run worker:dev -w server` keeps the queue running and queues the daily sweep at 05:00 UTC (token refresh, daily agents).

In production only the worker does this (`RUN_JOBS_IN_API=false` on the API, `CRON_SECRET` unset, no external cron). See `docs/DEPLOY_EC2.md`.

Without `OPENAI_API_KEY`, agents use canned test output locally but **refuse to run in production** (set `AI_ALLOW_MOCK=1` only for a demo deployment).

---

## 6. Quality commands

```powershell
npm run lint
npm run typecheck
npm run test
npm run test:e2e   # Playwright, starts dev server
```

---

## 7. Troubleshooting

- **`prepared statement "s0" already exists` during migrate** — migrate is using the pooled URL. Check `DATABASE_URL_UNPOOLED` is set (schema `directUrl`).
- **First request slow after idle** — Neon scales to zero after 5 min; the first query wakes it.
- **`P1001` cannot reach database** — `apps/server/.env` missing Neon vars; re-run `env pull` and copy.
- **Ports:** the website runs on **3100** and the Server on **3101** (dev and start), to avoid clashing with other local projects on 3000/3001. Change `-p` in the app's `package.json` together with `AUTH_URL` (3100) or `SERVER_URL` (3101).

---

## 8. Environment per app and per role

Names only; never put values in docs or images. Full list of Server groups: `apps/server/.env.example`.

| Role | Runs | Variables |
|---|---|---|
| **Web Frontend** | `apps/web` image | `SERVER_URL` only (the Server's private address; `http://server-api:3101` under compose, the internal ALB on EC2). No database, no secrets. |
| **Server api** | `apps/server` image, target `api` | Everything: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `STORAGE_*`, `AUTH_SECRET`, `AUTH_URL` (https website URL), `CREDENTIALS_ENCRYPTION_KEY`, provider keys and OAuth apps, SMTP. Plus `RUN_JOBS_IN_API=false`, `NODE_ENV=production`. `CRON_SECRET` unset. |
| **Server worker** | target `worker` | The same as the api, because jobs call the same providers and send the same emails (`AUTH_URL`, `NODE_ENV=production` included). Plus optional `WORKER_INTERVAL_MS` (default 15000), `WORKER_CONCURRENCY` (jobs at once, default 4, at least 1) and `WORKER_DAILY_SWEEP` (queue the paid daily sweep; unset means on only with `NODE_ENV=production`; unset or `true` in production, `false` on any dev or local worker). |
| **migrate** | target `migrate` | `DATABASE_URL`, `DATABASE_URL_UNPOOLED` (migrations use the direct URL). |

`SEED_*`, `SMOKE_BASE_URL`, `*_TEST_TOKEN` are for scripts and tests, not for any deployed role.
