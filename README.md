# msp-podping-service

Self-hosted [podping-hivepinger](https://github.com/brianoflondon/podping-hivepinger) deployment for [MSP 2.0](https://github.com/ChadFarrow/MSP-2.0), fronted by Caddy for bearer-token auth.

## What it does

Receives HTTP podping requests from MSP, validates a shared bearer token, and forwards to hivepinger which queues, dedups, and broadcasts `podping` `custom_json` ops to the Hive blockchain. Podcast Index and other indexers watch Hive for podpings and re-crawl feeds when they land.

## Architecture

Single container — Caddy listens on the public port, validates the bearer token, and reverse-proxies to hivepinger bound to localhost:

```
MSP (Vercel) ──Bearer──► Caddy :$PORT ──► hivepinger 127.0.0.1:8000 ──► Hive
```

## Prerequisites

- A funded Hive account (minimum ~20 HP so the account has Resource Credits to post; `hiveonboard.com?ref=podping` delegates enough to start). Any Hive account can send podpings — no notifier approval is required anymore.
- The account's **posting key** (STM… prefix, never the owner or active key).

## Deploy to Railway

1. Create a new Railway project pointing at this repo. Railway detects the `Dockerfile` and builds from it.
2. Set the following service variables:
   - `HIVE_ACCOUNT_NAME` — your Hive username (no `@`)
   - `HIVE_POSTING_KEY` — posting key
   - `PODPING_SHARED_SECRET` — random 32+ char string. Generate with `openssl rand -hex 32`.
3. Deploy. Railway will build the Dockerfile, start the container, and expose it on the `$PORT` it injects.
4. Verify health: `curl https://<railway-url>/health` → `ok`. `/health` is intentionally unauthenticated so Railway's health probes can reach it without the bearer token.
5. Verify auth gate: `curl -i https://<railway-url>/` → `401 Unauthorized`
6. Verify pass-through (no broadcast): `curl -H "Authorization: Bearer $SECRET" "https://<railway-url>/?url=https://example.com/feed.xml&reason=update&no_broadcast=true&detailed_response=true"` → 200 JSON

## Local development

```bash
export HIVE_ACCOUNT_NAME=youraccount
export HIVE_POSTING_KEY=STM...
export PODPING_SHARED_SECRET=$(openssl rand -hex 32)
docker compose up --build
# or: docker build -t msp-podping . && docker run -p 8080:8080 -e HIVE_ACCOUNT_NAME -e HIVE_POSTING_KEY -e PODPING_SHARED_SECRET msp-podping
```

## MSP environment variables

On the MSP Vercel project, set:
- `PODPING_ENDPOINT_URL` — Railway URL with trailing slash (e.g. `https://msp-podping-abc.up.railway.app/`)
- `PODPING_BEARER_TOKEN` — same value as `PODPING_SHARED_SECRET`

## Rollback

Unset `PODPING_BEARER_TOKEN` or `PODPING_ENDPOINT_URL` on the MSP Vercel project. MSP's `notifyPodping()` silently no-ops. No redeploy needed.

## Implementation notes

- **Base image**: `brianoflondon/podping-hivepinger:1.4.1` on Docker Hub. Pinned to a specific tag — never `:latest`. Check [Docker Hub tags](https://hub.docker.com/r/brianoflondon/podping-hivepinger/tags) before bumping.
- **Caddy binary**: installed in the Dockerfile from the official v2.8.4 tarball (keeps the Debian base from `python:3.13-slim` under `brianoflondon/podping-hivepinger`).
- **Config rendering**: `entrypoint.sh` renders `Caddyfile.template` → `/etc/caddy/Caddyfile` via `sed` at container start, substituting `__PORT__` and `__PODPING_SHARED_SECRET__`. Avoids Caddy's placeholder quirks inside `header` matcher values.
- **Hivepinger invocation**: `python -m hivepinger.api --host 127.0.0.1 --port 8000` (the 1.4.x CLI is flat — no `serve` subcommand, and the module entry is `hivepinger.api`, not `hivepinger`).
- **Health check**: `/health` is unauthenticated so Railway's health probes can reach it. Every other path requires `Authorization: Bearer <PODPING_SHARED_SECRET>` or returns 401.
- **Rotation**: to rotate the bearer token, update both `PODPING_SHARED_SECRET` on Railway and `PODPING_BEARER_TOKEN` on Vercel. Railway auto-redeploys on env change; Vercel needs an explicit redeploy for env changes to take effect.
