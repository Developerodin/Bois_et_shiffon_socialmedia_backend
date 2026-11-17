# Deploying to AWS EC2

The Server (`apps/server`) and the Web Frontend (`apps/web`) ship as separate Docker images and scale as separate
groups. `docker-compose.yml` runs everything on one box; this guide covers the scaled setup. Design:
`docs/superpowers/specs/2026-11-16-server-web-split-design.md`. Per-role variables: `docs/ENV_SETUP.md` section 8.

## Images

| Image | Build | Runs | Port |
|---|---|---|---|
| Server API | `docker build --target api .` (server repo) | `node server.js` | 3101 |
| Server worker | `... --target worker .` | `node dist/worker.js` (the job loop and the 05:00 UTC daily sweep) | none |
| Migrate | `... --target migrate .` | `prisma migrate deploy`, then exits | none |
| Web Frontend | `docker build .` (web repo) | `node server.js` | 3100 |

Build each from its own repo's root (server and web are separate repos). All are `linux/amd64` on `node:22-bookworm-slim`. **Instances must be x86_64**: `ffprobe-static`
ships no Linux arm64 binary, so Graviton is out until that changes. No env is baked into any image; every variable
arrives at run time (instance user data, SSM, or an env file).

## Public load balancer (ALB)

- Listener **443** (ACM certificate). Rule `/api/*` forwards to the **server-api** target group; the default action
  forwards to the **web** target group.
- Listener **80** redirects to 443 (301). Sessions use `__Secure-` cookies, which only work over https.
- **Idle timeout 330 s.** Chat streams and agent runs take up to 300 s. Both images set `KEEP_ALIVE_TIMEOUT=335000`
  so Node keeps idle connections open longer than the ALB does (with Node's 5 s default the ALB reuses a closed
  connection and returns a 502). Keep it above the idle timeout if you change either.
- **Access logs** (to S3) record the query string by default; ALB logs cannot drop it. Webhook secrets and OAuth codes
  travel in URLs, so either leave ALB access logs off, or restrict the bucket to the owner and set a short lifecycle.
  (nginx on the single box drops `$args` from its log format.)
- The phone uses the same public address (`EXPO_PUBLIC_API_URL`); `/api/*` reaches the Server with no change.

## Internal load balancer

The website's server-side rendering calls the Server at `SERVER_URL`. Put an **internal** ALB in front of the API group
and set `SERVER_URL=http://<internal-alb-dns>` on the web instances. Server-side rendering calls then reach the Server
through that ALB, so the Server sees the website's address for them. No rate-limited route is called that way, and the
admin "viewed" audit rows those calls write record no IP.

`SERVER_URL` is the Web Frontend's only variable. Next reads it at **build time** too, for the dev-only `/api` rewrite;
in production the ALB (or nginx) routes `/api/*`, so the website never proxies.

## Target groups

| Target group | Health check | Notes |
|---|---|---|
| server-api (3101), used by both ALBs | `GET /api/v1/health` | Answers without touching the database, so a Neon blip cannot replace every instance. **Deregistration delay 330 s.** |
| web (3100) | `GET /healthz` | Answers without calling the Server. |

## Security groups

- Server instances accept port 3101 **only from the two ALBs' security groups**. Nothing else reaches the Server
  directly, which is also why the Server trusts the right-most `X-Forwarded-For` entry (the one the ALB added).
- Web instances accept 3100 only from the public ALB.
- Workers need no inbound rule.

## Running the containers on an instance

Each instance runs one container, started from its user data (or a systemd unit) with these lines. `--init` gives Node
a proper PID 1 so SIGTERM reaches it, `--restart unless-stopped` brings a crashed process back, and `--stop-timeout`
is how long `docker stop` (and dockerd at shutdown) waits after SIGTERM before it kills the process. Docker's default
is 10 s.

```
# server-api: 330 s lets a chat stream or agent run (up to 300 s) finish.
docker run -d --name server-api --init --restart unless-stopped --stop-timeout 330 \
  --env-file /etc/espanda/server.env -e RUN_JOBS_IN_API=false -p 3101:3101 espanda-server-api

# worker: 360 s, longer than the longest job (see Workers below).
docker run -d --name worker --init --restart unless-stopped --stop-timeout 360 \
  --env-file /etc/espanda/server.env espanda-server-worker

# web
docker run -d --name web --init --restart unless-stopped \
  -e SERVER_URL=http://<internal-alb-dns> -p 3100:3100 espanda-web
```

`--env-file` takes `KEY=value` lines literally: no quotes and no inline comments, or `AUTH_URL="https://…"` fails
the https check. `apps/server/.env.example` is written that way (unquoted, comments on their own lines), so a copy of it
works with `--env-file`, compose and dotenv alike.

## Workers (Auto Scaling group)

- Several workers are safe: job claiming is lease-based and the daily sweep is idempotent.
- The worker handles SIGTERM: it claims no new job, finishes the jobs in flight, and exits. Set the ASG **termination
  lifecycle hook to at least 360 s** (compose uses `stop_grace_period: 360s`).
- **The hook alone sends no SIGTERM.** It only holds the instance in `Terminating:Wait`; when it ends, the OS shuts
  down and the worker is killed mid-job (systemd gives dockerd about 90 s). Something on the instance has to stop the
  worker and then complete the hook. Create the hook (`worker-drain`, heartbeat timeout **420 s**, at least the stop
  timeout plus slack, default result `CONTINUE`), give the instance role `autoscaling:CompleteLifecycleAction`, and run
  this script as a systemd service on each worker instance (`ASG_NAME` set in the unit):

  ```
  #!/bin/sh
  # Waits for the termination hook, stops the worker gracefully, then lets the termination go ahead.
  token() { curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'; }
  md() { curl -s -H "X-aws-ec2-metadata-token: $(token)" "http://169.254.169.254/latest/meta-data/$1"; }
  until [ "$(md autoscaling/target-lifecycle-state)" = "Terminated" ]; do sleep 5; done
  docker stop -t 360 worker
  aws autoscaling complete-lifecycle-action --region "$(md placement/region)" --lifecycle-hook-name worker-drain \
    --auto-scaling-group-name "$ASG_NAME" --instance-id "$(md instance-id)" --lifecycle-action-result CONTINUE
  ```

  (An EventBridge rule on "EC2 Instance-terminate Lifecycle Action" that runs the same two commands through SSM Run
  Command works too.)
- **Nothing caps a job's run time** off Vercel, so the stop grace must exceed the longest job. A job killed mid-run is
  run again once its 5-minute lease expires, as a new attempt: paid agent or render work is paid for twice.
  Publishing is safe: each publish job claims its attempt (`SCHEDULED` → `PUBLISHING`) before posting and is allowed
  one attempt, so the rerun posts nothing and marks the attempt `PENDING_VERIFY` for a person to check the account.
  Measure the real longest job once in production (`updatedAt - createdAt` of completed `agent.run` and `reel.render`
  jobs) and raise the grace if it is near 360 s.
- `WORKER_INTERVAL_MS` sets the poll interval (default 15000). A short one keeps the Neon database awake, which costs money.
- `WORKER_CONCURRENCY` sets how many jobs one worker runs at once (default 4): that many independent claim loops, so a
  5-minute Research run doesn't hold up a password-reset email or a scheduled publish. With every loop busy on a long
  job, a short one waits for the first to finish; raise it or add worker instances if that happens. A value below 1 is
  read as 1, and one that isn't a number as 4.
- Each worker process has one Prisma pool (default `num_cpus × 2 + 1` connections, or `connection_limit` on
  `DATABASE_URL`): keep it at least `WORKER_CONCURRENCY + 2`, one per loop plus lease renewals. Every loop also polls on
  its own, so an idle worker runs `WORKER_CONCURRENCY` claim queries per `WORKER_INTERVAL_MS` (4 per 15 s by default).
- `WORKER_DAILY_SWEEP` decides whether the worker queues the daily sweep, which starts paid work (scheduled agent runs,
  plan renewals, catalog syncs). It reads `true`/`1` and `false`/`0` in any case, quotes ignored. Unset, it is on only
  with `NODE_ENV=production`, which the images set. Leave it unset (or `true`) on the production workers:
  `apps/server/.env.example` ships it commented out, so a copy keeps the production default. Any other worker pointed at
  a shared database, a local docker worker included, must set it to `false`. A production worker with it off logs a
  warning at each day's sweep time.

## Environment that must be right

| Variable | Where | Value |
|---|---|---|
| `NODE_ENV` | api and worker | `production` (the images set it). Without it, emails carry `localhost` links and the Higgsfield webhook is skipped. |
| `AUTH_URL` | api, worker, migrate | The **website's public https URL**. The api and the worker refuse to start without it in production. |
| `RUN_JOBS_IN_API` | api | `false`. Renders and publishing run in the workers, not inside API requests. |
| `WORKER_DAILY_SWEEP` | worker | Unset or `true` in production, or the daily sweep (plan renewals, token refreshes, scheduled agents, catalog syncs) never runs; the worker then warns once a day. `false` on any other worker. |
| `CRON_SECRET` | api | **Unset.** `/api/v1/jobs/run` then refuses every call; the worker replaces the old cron. |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | api, worker, migrate | Pooled for the app, direct for migrations. |
| `CSRF_MODE` | api | `log` on the first deploy that has the cross-origin check: cookie writes from another origin are logged (`csrf.crossOrigin`) but let through. Read the logs, add any real origin to `WEB_ORIGINS`, then unset it (refuses with 403). |
| `WEB_ORIGINS` | api | Extra website origins allowed to make cookie writes (comma list). `AUTH_URL`'s origin is always allowed; usually unset in production. |
| `PAID_STARTS_OFF_FOR` | api | Unset. `web` pauses paid starts (render, photoshoot, clone, presenter, preview, agent runs) from the website only, with a 503, while the phone keeps working; `paid.start` log lines show what each client starts. |
| `STORAGE_*` | api, worker | Object storage. Deliberately not `AWS_*`, which would clash with the instance role. The api and the worker refuse to start in production without `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY`. |

Provider callback URLs stay on the website's origin: `<website>/api/auth/callback/google` and
`<website>/api/v1/integrations/<provider>/callback`. Any `<PROVIDER>_REDIRECT_URI` set in production must point at the
same public address.

## Deploy order

Run the api in the same AWS region as the database (Neon is in eu-central-1): every API request makes several
database round trips.

1. **Migrate**: run the migrate image once (`docker compose run --rm migrate`, or a one-off task).
2. **Workers**: roll the worker group (lifecycle hook above).
3. **API**: roll the server-api group (the 330 s deregistration delay and `--stop-timeout 330` let streams finish).
4. **Web**: roll the web group last.

Schema changes must be **compatible with the previous release for one release**: add columns and tables first, remove
them in a later release. Old workers and API containers keep running against the new schema during steps 2 to 4. A
worker that meets a job type it does not know puts the job back to pending, so a newer release's jobs wait for a newer worker.

## Single box with docker compose

```
docker compose build
docker compose run --rm migrate
docker compose up -d worker server-api web nginx
```

`deploy/env/server.env` holds the Server's variables (git-ignored); `deploy/certs/fullchain.pem` and `privkey.pem`
hold the certificate. `deploy/nginx.conf` is the whole `nginx.conf`, mounted over the image's, so its query-string-free log is the only access log. nginx sends `/api/` to the Server and the rest to the website, overwrites `X-Forwarded-For` with
the client address, allows 330 s reads and 5 MB bodies, and does not buffer `/api/`.

## Known ceilings

- A rolling website deploy can break a browser tab still open on the old version; the tab reloads.
- Private subnets need a NAT gateway. Video traffic (render input and output, publishing) pays per GB through it; watch the NAT bill.
- nginx's error log prints query strings on upstream errors, so the single-box config logs only critical entries.
