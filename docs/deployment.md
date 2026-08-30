# Deployment

OpenBot ships one image containing the app, API, computer runtime and optional PostgreSQL. In a
production-style raw Docker deployment, run the computer as a second container from that same image:
its browser and shell must not share the API process or attachment volume.

```sh
docker build -t openbot .
docker network create openbot-runtime
docker volume create openbot-workspace
docker volume create openbot-profiles
docker volume create openbot-attachments
export COMPUTER_TOKEN="$(openssl rand -hex 32)"

# The computer gets only its caller token, workspace and browser profile.
docker run -d --name openbot-computer --network openbot-runtime \
  --user pwuser:pwuser \
  -e PORT=4100 -e COMPUTER_TOKEN \
  -v openbot-workspace:/workspace \
  -v openbot-profiles:/profiles \
  --health-cmd="bun -e \"const r=await fetch('http://127.0.0.1:4100/health');process.exit(r.ok?0:1)\"" \
  --health-interval=10s --health-timeout=5s --health-retries=5 \
  --entrypoint /usr/local/bin/bun openbot agent-computer/src/index.ts

# The API uses a database from .env and is the only attachment-volume consumer.
docker run --name openbot-api --network openbot-runtime -p 3001:3001 --env-file .env \
  -e COMPUTER_TOKEN \
  -e EMBEDDED_COMPUTER=off \
  -e AGENT_COMPUTER_URL=http://openbot-computer:4100 \
  -e ATTACHMENT_STORAGE_DIR=/var/lib/openbot/attachments \
  -v openbot-attachments:/var/lib/openbot/attachments openbot

# To use the image's PostgreSQL instead, add these flags to the API command:
docker run --name openbot-api --network openbot-runtime -p 3001:3001 --env-file .env \
  -e COMPUTER_TOKEN \
  -e EMBEDDED_COMPUTER=off \
  -e AGENT_COMPUTER_URL=http://openbot-computer:4100 \
  -e EMBEDDED_POSTGRES=on \
  -e ATTACHMENT_STORAGE_DIR=/var/lib/openbot/attachments \
  -v openbot-data:/var/lib/postgresql \
  -v openbot-attachments:/var/lib/openbot/attachments openbot
```

A fresh Docker named volume inherits the image's private attachment directory, owned by `pwuser`
with mode `0700`, before the API drops privileges. For a host bind mount, create the directory with
equivalent ownership and permissions yourself. Never mount it into `openbot-computer`.

## What is in the image, and what is not

**In it:** the built app, API and Chromium. The API publishes port 3001. The separate computer
listens on 4100 only inside the Docker network: it holds real logins and accepts calls authenticated
with `COMPUTER_TOKEN`. `EMBEDDED_COMPUTER=off` ensures the API container does not also start a
co-resident browser process.

**PostgreSQL, if you ask for it.** `EMBEDDED_POSTGRES=on` starts one inside the container, creates
the database and the `vector` extension the first time, and runs the migrations on every start. It
listens on loopback only and is never published, so there is no password to manage.

Give it a volume at `/var/lib/postgresql` — the parent, not the data directory itself. Without one,
a redeploy takes the audit trail with it, and the audit trail is the product.

**Mount the parent, not `/var/lib/postgresql/data`.** On any platform whose volume is an ext4 mount,
and that is most of them, the mount arrives holding a `lost+found` directory. `initdb` will not
initialise into a directory that has anything in it, so mounting it directly on the data directory
leaves the cluster uncreated — and because `api` waits on `postgres` and `migrate`, the container
starts, the platform reports the deploy a success, and the URL serves a 502. Mounting the parent
leaves `data` as an ordinary subdirectory, which is what PostgreSQL asks for. A Docker named volume
works either way; a platform volume does not. Platforms that offer no persistent volume are the ones to
point at a managed database instead: set `DATABASE_URL` and leave `EMBEDDED_POSTGRES` off. The
`vector` extension must be enabled there; RDS, Cloud SQL and Azure Database all support it, none
enable it for you.

**Attachment bytes need their own durable volume.** Metadata is in PostgreSQL; the file itself is
under `ATTACHMENT_STORAGE_DIR`, `/var/lib/openbot/attachments` in the container examples and the
production Compose file. Mount that directory only into the API container. The routines worker,
Bots, and Bot computers receive attachments through authenticated server routes and must not receive
the storage volume directly.

**Not in it:**

**The supervisor.** It gives each Bot its own container, which needs a Docker socket, which no
serverless container platform permits. Without it, every Bot shares the one browser, exactly as they
do on a laptop with no supervisor configured. A shared browser means shared logins, shared files and
shared session between Bots, which is fine for a deployment where one team trusts its own Bots and
is not fine as a boundary between tenants.

**The routines schedule.** Nothing in this image is scheduled to fire a routine — there is no
worker service beside the API, and `worker/` (the looping local variant) is not in the image. The
sweep itself is: `bun scripts/fire-routines.ts` from `/app/server`, one pass then exit, which is what
the Helm chart's CronJob runs from this same image. So a one-container deployment needs something
outside the container to run it on a schedule — an external cron, a platform scheduled job, or a
second container of this image with that command — with `DATABASE_URL`, `SERVER_INTERNAL_URL` and
`WORKER_SHARED_SECRET` set. Until something does, a routine is stored, its next run time is computed,
the Routines page shows it, and it never fires. See [routines.md](routines.md).

## Minimum size

Measured on the real image, one Bot, arm64.

| | Measured | Minimum | Recommended |
| --- | --- | --- | --- |
| Memory | 409 MB idle, 498 MB after three page loads, 548 MB after a snapshot | **2 GB** | **4 GB** |
| vCPU | 3 to 6 percent at rest, bursty while a page renders | **1** | **2** |
| Disk | 1.4 GB image | **4 GB** | 8 GB with room for `/workspace` |

**Why 2 GB when it measures at 550 MB.** That figure is one Bot with one page open. Every additional
concurrent page is roughly another 100 to 200 MB, and Playwright's own guidance is to allow about
1 GB per concurrent browser. 2 GB is the floor at which one person using it does not meet the OOM
killer; 4 GB is where a handful of Bots working at once stays comfortable.

**Do not configure shared memory.** Chromium is launched with `--disable-dev-shm-usage`, so it writes
to `/tmp` rather than `/dev/shm` and the 64 MB default is irrelevant. This matters because **AWS
Fargate does not support `sharedMemorySize` at all**; without that flag Chromium would crash there
and the fix would not be available.

## Required configuration

| Variable | |
| --- | --- |
| `DATABASE_URL` | PostgreSQL with the `vector` extension. Not needed with `EMBEDDED_POSTGRES=on` |
| an identity provider | `GOOGLE_OAUTH_*`, `MICROSOFT_OAUTH_*` or `OKTA_OAUTH_*`, with `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` and `INITIAL_ADMIN_EMAILS`. See the README |
| `EMBEDDED_POSTGRES` | `on` to run the database inside the container. Off by default |
| `KEY_ENCRYPTION_KEY` | base64 32 bytes. `openssl rand -base64 32`. The example key is refused in production |
| `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, `INTELLIGENCE_API_KEY` | CopilotKit Intelligence. A free plan is available and it can be self-hosted |
| `COPILOTKIT_LICENSE_TOKEN` | from `npx copilotkit@latest license --write` |
| a model key | `OPENAI_API_KEY`, or the provider you configured |

`COMPUTER_TOKEN` is generated at start if you do not set one. Both processes that need it are inside
the container, so there is nothing to share it with.

`MANAGED_AGENT_AG_UI_URL` is not required here. The image does not carry `agent-langgraph` or
`agent-bot`. Leave it unset and the shipped Risk Analyst coworker is omitted rather than registered
against a host that is not there. Set it, with `MANAGED_AGENT_TOKEN`, only when a Bot is actually
reachable from this container. Unset it if your `.env` still has the laptop default
`http://localhost:4201/ag-ui`.

**Authentication is required.** With no identity provider configured, the deployment refuses to start,
because a public URL where every visitor is an administrator fails silently: it looks like it works.
Configure Google, Microsoft or Okta, or set `OPENBOT_SINGLE_USER=true` to say you meant an open
deployment. `NODE_ENV` does not affect this.

**Put TLS in front of it.** Not only for the cookies. A page served from `http://<address>` is not a
secure context, which removes a set of browser APIs that are present on `http://localhost` and so
never missing on a laptop. The app does not depend on any of them, but sign-in cookies still want
`Secure`, and every platform below terminates TLS for you.

## Migrations

With `EMBEDDED_POSTGRES=on` they run at start and there is nothing to do. There is exactly one
process and no deploy pipeline, so the alternative would be a runbook.

With an external database, they are a release step, not a start step. Two replicas starting together
would race, and a failed migration should stop a deploy rather than leave a half-migrated database
serving traffic.

```sh
docker run --rm --env-file .env openbot \
  sh -c "cd /app/server && bun x drizzle-kit migrate --config=drizzle.config.ts"
```

## Replicas

The attachment backend currently writes to one local filesystem. Run exactly one API replica while
using it: two replicas can accept metadata for the same deployment while seeing different files, and
a `ReadWriteOnce` volume cannot safely make that filesystem horizontal. Object storage is required
before scaling the API horizontally; it needs a shared key namespace and coordinated deletion rather
than a filesystem path mounted into every replica.

Page snapshots and the rest of the application state already live in PostgreSQL. Attachment bytes
are the remaining local state that prevents horizontal replicas.

## Platform notes

**Google Cloud Run.** Set memory to at least 2 GB and cap the service at one instance while using the
local attachment backend (see Replicas above). Each instance has its own browser, so a Bot's logins
stay on whichever instance served them.
Cloud Run runs every
container under gVisor, which Chromium is sensitive to; test a navigation before trusting it.
`gcloud run compose up` will also deploy the whole compose file if you want a throwaway database
alongside.

**AWS.** ECS Express Mode provisions the cluster, load balancer, HTTPS and autoscaling from an image
in ECR, and is what AWS points App Runner users at now that App Runner takes no new customers.
Plain ECS on Fargate behind an ALB is the answer if you want task definitions and fine-grained IAM.
No shared-memory configuration is needed or possible.

**Kubernetes.** Everything above describes one container run by hand. A cluster is the other shape,
and it is the only one that gives a Bot a computer of its own, runs the routines schedule without
something outside the container, and provisions a persistent attachment volume for the singleton
API. That is the Helm chart:
[charts/openbot/README.md](../charts/openbot/README.md), which covers EKS, GKE, AKS and a plain
self-hosted cluster from the same templates.

**Azure Container Apps.** Managed ingress with TLS and custom domains. Note the **240-second request
timeout**: the live screen holds a long connection, so expect it to reconnect. Concurrent WebSockets
are capped at 350 per instance on the basic tier.

**Railway, Render, Fly.io.** All run this image directly and all provision PostgreSQL in a click,
which makes them the shortest path from nothing to a running deployment.

## Known costs

**The image is 1.4 GB**, and 595 MB of that is Firefox and WebKit, which the Playwright base ships
alongside the Chromium we use and nothing here ever launches. Deleting them afterwards does not help, because the bytes still ship in the layer
below. Building Chromium-only onto a slim base would cut this substantially and is not done yet.

**A strict content-security-policy needs a hash or a nonce.** `app/index.html` runs a small inline
script that decides the theme before the first paint. Nothing in this repo sends a CSP header, so it
works as shipped; a deployment that adds one at its proxy has to allow that script explicitly, or
`script-src` blocks it and the page renders with the wrong theme until the app boots. A `'sha256-'`
hash of the script body is the version that survives a rebuild without a per-request nonce.
