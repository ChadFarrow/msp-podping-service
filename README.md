# msp-podping-service

Self-hosted [podping-hivepinger](https://github.com/brianoflondon/podping-hivepinger) deployment for [MSP 2.0](https://github.com/ChadFarrow/MSP-2.0), fronted by Caddy for bearer-token auth, plus a **podping consumer** that watches Hive and forwards music podpings into [stablekraft-app](https://github.com/ChadFarrow/stablekraft-app).

## What it does

Two directions:

- **Out** (pusher): receives HTTP podping requests from MSP, validates a shared bearer token, and forwards to hivepinger which queues, dedups, and broadcasts `podping` `custom_json` ops to the Hive blockchain.
- **In** (consumer): tails the Hive blockchain for any `pp_music_*` podping (from any signer, not just MSP), and calls stablekraft-app's public feed endpoints. Tracked feeds get refreshed; untracked feeds get imported only when the podping was signed by our MSP Hive account.

## Architecture

Single container, three processes supervised by `entrypoint.sh`:

```
MSP (Vercel) ──Bearer──► Caddy :$PORT ──► hivepinger 127.0.0.1:8000 ──► Hive
                                                                         │
                                                                         ▼
                                             consumer (Node) ──► stablekraft.app
                                                ▲                  /api/feeds/exists
                                                │                  /api/feeds/refresh-by-url
                                           Hive block stream       /api/feeds
```

All three processes are supervised via `wait -n` + `trap 'kill 0'`: any crash terminates the container so Railway restarts it. `/health` is reverse-proxied to hivepinger's own health endpoint so a dead Python process turns Railway's probe red instead of silently returning `ok`.

## Prerequisites

- A funded Hive account (minimum ~20 HP so the account has Resource Credits to post; `hiveonboard.com?ref=podping` delegates enough to start). Any Hive account can send podpings — no notifier approval is required anymore.
- The account's **posting key** (STM… prefix, never the owner or active key).

## Deploy to Railway

1. Create a new Railway project pointing at this repo. Railway detects the `Dockerfile` and builds from it.
2. Set the following service variables:
   - `HIVE_ACCOUNT_NAME` — your Hive username (no `@`). Also used by the consumer as the "MSP signer" account for auto-imports.
   - `HIVE_POSTING_KEY` — posting key
   - `PODPING_SHARED_SECRET` — random 32+ char string. Generate with `openssl rand -hex 32`.
   - `STABLEKRAFT_BASE_URL` — e.g. `https://stablekraft.app`. Required for the consumer.
   - `HIVE_RPC_NODES` (optional) — comma-separated fallback list. Default: `https://api.hive.blog,https://api.deathwing.me,https://hive-api.arcange.eu`.
   - `CONSUMER_REWIND_BLOCKS` (optional) — how many blocks to rewind on boot. Default `200` (~10 min).
   - `CONSUMER_ENABLED` (optional) — set to `false` to keep the consumer idle on boot without a rebuild. Default `true`.
3. Deploy. Railway will build the Dockerfile, start the container, and expose it on the `$PORT` it injects.
4. Verify health: `curl https://<railway-url>/health` → JSON from hivepinger (200 when healthy).
5. Verify auth gate: `curl -i https://<railway-url>/` → `401 Unauthorized`
6. Verify pusher (no broadcast): `curl -H "Authorization: Bearer $SECRET" "https://<railway-url>/?url=https://example.com/feed.xml&reason=update&no_broadcast=true&detailed_response=true"` → 200 JSON
7. Verify consumer: check Railway logs for `[consumer] streaming from block …` within a few seconds of boot.

## Local development

```bash
export HIVE_ACCOUNT_NAME=youraccount
export HIVE_POSTING_KEY=STM...
export PODPING_SHARED_SECRET=$(openssl rand -hex 32)
export STABLEKRAFT_BASE_URL=http://host.docker.internal:3000  # your local stablekraft-app
docker compose up --build
# or: docker build -t msp-podping . && docker run -p 8080:8080 \
#       -e HIVE_ACCOUNT_NAME -e HIVE_POSTING_KEY -e PODPING_SHARED_SECRET -e STABLEKRAFT_BASE_URL msp-podping
```

To iterate on just the consumer without rebuilding Docker, run it directly:

```bash
cd consumer
npm install
npm run build
CONSUMER_ENABLED=true \
HIVE_ACCOUNT_NAME=youraccount \
STABLEKRAFT_BASE_URL=http://localhost:3000 \
CONSUMER_REWIND_BLOCKS=1000 \
node dist/index.js
```

Debug flag: setting `CONSUMER_SMOKE_ANY_PP=true` widens the filter from `pp_music_` to any `pp_` podping so you can see classification working when music podpings are too rare to catch during a short test.

## MSP environment variables

On the MSP Vercel project, set:
- `PODPING_ENDPOINT_URL` — Railway URL with trailing slash (e.g. `https://msp-podping-abc.up.railway.app/`)
- `PODPING_BEARER_TOKEN` — same value as `PODPING_SHARED_SECRET`

## Rollback

**Pusher only** (MSP stops podping): unset `PODPING_BEARER_TOKEN` or `PODPING_ENDPOINT_URL` on the MSP Vercel project. MSP's `notifyPodping()` silently no-ops. No redeploy needed.

**Consumer only** (stop reacting to Hive podpings): set `CONSUMER_ENABLED=false` on Railway. The consumer boots idle; pusher and Caddy keep working.

## Implementation notes

- **Base image**: `brianoflondon/podping-hivepinger:1.4.1` on Docker Hub. Pinned to a specific tag — never `:latest`. Check [Docker Hub tags](https://hub.docker.com/r/brianoflondon/podping-hivepinger/tags) before bumping.
- **Caddy binary**: installed in the Dockerfile from the official v2.8.4 tarball with a pinned SHA-256 (`a7e8306c…`). Keeps the Debian base from `python:3.13-slim` under `brianoflondon/podping-hivepinger`.
- **Node.js**: installed via NodeSource's apt repo in the Dockerfile (currently Node 20) so the consumer has a runtime.
- **Config rendering**: `entrypoint.sh` renders `Caddyfile.template` → `/etc/caddy/Caddyfile` via `sed` at container start, substituting `__PORT__` and `__PODPING_SHARED_SECRET__`. Avoids Caddy's placeholder quirks inside `header` matcher values.
- **Hivepinger invocation**: `python -m hivepinger.api --host 127.0.0.1 --port 8000` (the 1.4.x CLI is flat — no `serve` subcommand, and the module entry is `hivepinger.api`, not `hivepinger`).
- **Consumer Hive client**: `@hiveio/dhive` with multi-RPC failover. Streams blocks in `Irreversible` mode (~45s lag, no fork handling). Rewinds `CONSUMER_REWIND_BLOCKS` (default 200) on boot, uses an in-memory LRU of 5000 tx ids for dedup during the rewind window. No persistence — trade-off: downtime > 10 min loses podpings in the gap.
- **Consumer filter**: only `custom_json` ops with `id` starting `pp_music_`. For each URL in the podping's `iris` array: if stablekraft-app already tracks it (via `GET /api/feeds/exists?url=…`), refresh it; else if the podping was signed by our `HIVE_ACCOUNT_NAME` (the MSP account), import it as an album; else skip.
- **Health check**: `/health` proxies to hivepinger's own `/health` endpoint. Dead hivepinger → Caddy 502 → Railway restarts. No longer a static `ok`.
- **Process supervision**: `entrypoint.sh` uses `wait -n` + `trap 'kill 0'` so any child process exit terminates the container and triggers a Railway restart. No silent leaks.
- **Rotation**: to rotate the bearer token, update both `PODPING_SHARED_SECRET` on Railway and `PODPING_BEARER_TOKEN` on Vercel. Railway auto-redeploys on env change; Vercel needs an explicit redeploy for env changes to take effect.

## stablekraft-app dependency

The consumer calls three endpoints, all currently unauthenticated:

- `GET  /api/feeds/exists?url=<URL>` or `?guid=<GUID>` — returns `{ exists: boolean }`. Blacklisted URLs always return `exists: false`.
- `POST /api/feeds/refresh-by-url` with body `{ originalUrl }` — refreshes a tracked feed.
- `POST /api/feeds` with body `{ originalUrl, type: "album" }` — imports a new feed (MSP-signed podpings only).

If any of those endpoint shapes changes, update `consumer/src/index.ts` accordingly.
