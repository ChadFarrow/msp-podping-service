# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`msp-podping-service` does two related things on a single Railway container:

1. **Pusher** (original): receives HTTP podping requests from [MSP 2.0](https://github.com/ChadFarrow/MSP-2.0), validates a shared bearer token, and forwards to hivepinger, which broadcasts `podping` `custom_json` ops to the Hive blockchain.
2. **Consumer** (added later): tails the Hive blockchain for `pp_music_*` podpings (from *any* signer, not just MSP), and forwards them to [stablekraft-app](https://github.com/ChadFarrow/stablekraft-app) so it can refresh its music-feed database in near-real-time.

## Architecture

```
                                                    ┌─► Hive (writes)
MSP (Vercel) ──Bearer──► Caddy :$PORT ──► hivepinger─┘
                                           127.0.0.1:8000

consumer (Node) ──reads──► Hive block stream
     │
     └─POST──► stablekraft.app /api/feeds/exists
                            /api/feeds/refresh-by-url   (tracked feed → refresh)
                            /api/feeds                   (MSP-signed untracked → import)
```

Single container, **three processes** supervised by `entrypoint.sh`:

- **hivepinger** (Python, upstream image `brianoflondon/podping-hivepinger:1.4.1`) — binds to `127.0.0.1:8000`, never public
- **consumer** (Node 20, built from `consumer/` in this repo) — outbound only, no bindings
- **Caddy v2** — binds to Railway's `$PORT`, reverse-proxies `/health` and bearer-auth-gated traffic to hivepinger

All three run in the background under a single bash entrypoint; `wait -n` returns as soon as any one exits so Railway's container supervisor restarts the whole container. There's no silent-hivepinger-death failure mode.

## Repository Layout

```
.
├── Dockerfile              # Layers Caddy + Node + consumer onto the hivepinger base image
├── entrypoint.sh           # Renders Caddyfile from template, supervises all three processes
├── Caddyfile.template      # Caddy config with __PORT__ and __PODPING_SHARED_SECRET__ placeholders
├── compose.yml             # Local-dev wrapper around the Dockerfile
├── consumer/               # Node/TypeScript consumer (built into the Docker image)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/index.ts        # Hive block stream → classifier → stablekraft-app HTTP poster
├── .gitignore
├── README.md               # User-facing deploy instructions
└── CLAUDE.md               # (this file)
```

## Why a Template + sed Render?

Caddy's placeholder substitution (`{$VAR}`, `{env.VAR}`) has quirks inside `header` matcher values — depending on syntax position it may not expand, or may expand into invalid CEL. Rather than fight it, `entrypoint.sh` renders `Caddyfile.template` with plain `sed` into `/etc/caddy/Caddyfile` at container start, substituting `__PORT__` and `__PODPING_SHARED_SECRET__` with the real env values before Caddy ever loads. Caddy only ever parses literal values — no placeholder surprises.

The `sed` delimiter is `|`. Safe because `PODPING_SHARED_SECRET` is generated via `openssl rand -hex 32`, which emits only `[0-9a-f]`. If the secret source ever changes to allow arbitrary characters, swap to a delimiter the value can't contain or use `envsubst` (not installed in the base image by default).

## Entrypoint Flow

`entrypoint.sh` (shebang is `#!/bin/bash` — needs bash for `wait -n`):

1. Logs presence + lengths (not values) of the expected env vars. Diagnostic for missing-env issues on Railway.
2. Fails fast with `set -e` and `: "${PODPING_SHARED_SECRET:?...}"` if the secret is unset. Prevents a silent public deploy.
3. Renders `Caddyfile.template` → `/etc/caddy/Caddyfile`.
4. Installs `trap 'kill 0' EXIT INT TERM` so a dying child reaps its siblings when the trap fires on exit.
5. Starts hivepinger in the background: `(cd /hivepinger && python -m hivepinger.api --host 127.0.0.1 --port 8000) &`. The 1.4.x CLI is flat — no `serve` subcommand; module entry is `hivepinger.api`, not `hivepinger`.
6. Starts the consumer: `node /consumer/dist/index.js &`.
7. Starts Caddy: `caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &`.
8. `wait -n` returns when any child exits; `exit $?` propagates the non-zero code so Railway restarts the container.

None of the three processes is PID 1 anymore — bash is. Don't add `exec` to any of the child launches; it breaks the `wait -n` pattern.

## Required Env Vars (Railway Service Variables)

| Name | Required | Purpose |
|---|---|---|
| `HIVE_ACCOUNT_NAME` | Yes | Hive username (no `@`) for signing ops. Also used by the consumer to detect MSP-signed podpings for auto-import. |
| `HIVE_POSTING_KEY` | Yes | Hive posting key (STM… prefix, never owner/active) |
| `PODPING_SHARED_SECRET` | Yes | Bearer token shared with MSP (Vercel stores the same value as `PODPING_BEARER_TOKEN`) |
| `STABLEKRAFT_BASE_URL` | Yes* | e.g. `https://stablekraft.app`. Required when `CONSUMER_ENABLED=true`. |
| `HIVE_RPC_NODES` | No | Comma-separated Hive RPC fallback list. Default: `https://api.hive.blog,https://api.deathwing.me,https://hive-api.arcange.eu`. |
| `CONSUMER_REWIND_BLOCKS` | No | How many irreversible blocks to rewind on boot. Default `200` (~10 min). |
| `CONSUMER_ENABLED` | No | Set to `false` to idle the consumer on boot without a rebuild. Default `true`. |
| `PORT` | No | Railway auto-injects; Caddy defaults to `:8080` if unset |

Debug-only:

| Name | Purpose |
|---|---|
| `CONSUMER_SMOKE_ANY_PP` | If `true`, broadens the consumer's filter from `pp_music_` to any `pp_` podping. Useful for smoke tests — music podpings are rare and might not show up in a short window. Never set this in production. |

## Caddy Auth Gate

`Caddyfile.template`:

```
:__PORT__ {
    # Public, unauthenticated: proxied to hivepinger's /health so a dead
    # Python process turns Railway's probe red.
    handle /health {
        reverse_proxy 127.0.0.1:8000
    }

    # Bearer-authenticated: reverse-proxy everything else to hivepinger.
    @authorized header Authorization "Bearer __PODPING_SHARED_SECRET__"
    handle @authorized {
        reverse_proxy 127.0.0.1:8000
    }

    respond "Unauthorized" 401
}
```

After rendering, the `__PLACEHOLDER__` tokens are replaced with literal values. The `@authorized` matcher does exact-value header match (case-insensitive name, case-sensitive value). `/health` is unauthenticated by design so Railway can probe without the bearer; it proxies to hivepinger's own `/health` endpoint so a dead backend surfaces as a 502 rather than a lying `ok`.

## Consumer Design

Single file: `consumer/src/index.ts`. Only runtime dep: `@hiveio/dhive`.

- **Boot**: reads `HIVE_ACCOUNT_NAME` (the MSP signer), `STABLEKRAFT_BASE_URL`, optional RPC/rewind config. Constructs a dhive `Client` with multi-node failover.
- **Block stream**: `client.blockchain.getBlocks({ from, mode: Irreversible })` — irreversible mode lags head by ~45 seconds but eliminates fork/reorg handling. Music-feed refresh tolerates a minute of latency fine.
- **Rewind**: on boot, reads `last_irreversible_block_num` from `get_dynamic_global_properties`, subtracts `CONSUMER_REWIND_BLOCKS`, starts streaming from there. Processed `tx id`s are kept in an in-memory bounded LRU (`MAX_DEDUP_SIZE = 5000`) so replays during the rewind window are no-ops.
- **Persistence: none.** If the container is down more than the rewind window (~10 min by default), podpings in the gap are lost. Acceptable for a music cache. Bump `CONSUMER_REWIND_BLOCKS` or add a Railway Volume + checkpoint file if that changes.
- **Filter**: `op[0] === 'custom_json' && op[1].id.startsWith('pp_music_')`. Accepts future variants like `pp_music_liveitem` — do not narrow to exact-string match.
- **Classification per tx**: decode `op[1].json` into `{ iris: string[] }`. For each iri (URL or `podcast:guid:<guid>`):
  - If stablekraft-app already tracks it (`GET /api/feeds/exists`) → `POST /api/feeds/refresh-by-url`
  - Else if the podping's `required_posting_auths[0]` (lowercased) === `HIVE_ACCOUNT_NAME.toLowerCase()` → `POST /api/feeds` with `type: 'album'`
  - Else → skip silently. Don't log one line per skipped iri; it's too chatty.
- **Error policy**: per-URL retry ×2 with 2s/8s backoff on 5xx or network error; log-and-skip on 4xx; `setTimeout(reconnect, 5000)` on stream drop. Bad JSON in a podping: log tx id and skip. Never halt the stream.
- **Observability**: `[consumer] streaming from block N` on connect; `[consumer] processed N blocks, head=X` every 100 blocks; `[txid] pp_music_update signer=... iris=N` per matched op; `[txid] refresh 200 <url>` or `[txid] import(msp) 201 <url>` on success.

## stablekraft-app Dependency

The consumer depends on three HTTP endpoints on stablekraft-app:

- `GET  /api/feeds/exists?url=<URL>` or `?guid=<GUID>` — returns `{ exists: boolean }`. Blacklisted URLs always return `exists: false`.
- `POST /api/feeds/refresh-by-url` — body `{ originalUrl: string }` — refresh a tracked feed.
- `POST /api/feeds` — body `{ originalUrl: string, type: string }` — import a new feed.

All three are currently unauthenticated. If that changes, the consumer will need matching credentials added as env vars. The consumer does **not** share stablekraft-app's database credentials by design — it stays stateless and interacts only through HTTP.

## Upstream Dependencies

- **hivepinger**: `brianoflondon/podping-hivepinger` on Docker Hub. Current pin: `1.4.1`. Check [tags](https://hub.docker.com/r/brianoflondon/podping-hivepinger/tags) before bumping. Never `:latest`. CLI invocation changes between minor versions (`1.3 → 1.4` required dropping the `serve` subcommand); revalidate the `python -m hivepinger.api` line after any bump.
- **Caddy**: v2.8.4, downloaded as a binary from the official GitHub release in the Dockerfile with a pinned SHA-256 (`a7e8306c…`). To bump, fetch the new checksum with `curl -sfL https://github.com/caddyserver/caddy/releases/download/vX.Y.Z/caddy_X.Y.Z_linux_amd64.tar.gz | shasum -a 256`.
- **Node.js**: currently Node 20 via NodeSource apt repo. Bump by changing `NODE_MAJOR` in the Dockerfile ARG.
- **@hiveio/dhive**: only runtime dep in the consumer. Official TypeScript Hive client. Check `consumer/package.json` for the pinned range.

## Hive / Podping Notes

- Podping is permissionless — no notifier whitelist required. Any funded Hive account (~20 HP for Resource Credits) can broadcast.
- Account setup: `v4v.app` (Lightning-funded) or `hiveonboard.com?ref=podping` are both fine.
- On-chain proof: check `https://api.hive.blog` RPC or any Hive block explorer (`peakd.com/@<account>`, `hivescan.io/@<account>`) for `custom_json` ops with `id` like `pp_music_update`, `pp_podcast_update`.
- Podcast Index runs high-volume aggregator accounts (`podping.aaa` through `podping.eee`) that re-emit podpings from their own watchers. The consumer should see their ops frequently during a smoke test with `CONSUMER_SMOKE_ANY_PP=true`.

## Rotating the Bearer Token

1. Generate a new secret: `openssl rand -hex 32`
2. Update `PODPING_SHARED_SECRET` on Railway (auto-redeploys).
3. Update `PODPING_BEARER_TOKEN` on the MSP Vercel project to the same value, then redeploy MSP (Vercel doesn't auto-apply env changes to existing deployments).

If MSP still has the old token during the redeploy window, its podping calls will return 401 until it picks up the new env — that's expected.

## Rollback

**Pusher only** (MSP stops podping): unset `PODPING_ENDPOINT_URL` or `PODPING_BEARER_TOKEN` on MSP's Vercel project. MSP's `notifyPodping()` silently no-ops. No redeploy on this side.

**Consumer only** (stop reacting to Hive): set `CONSUMER_ENABLED=false` on Railway. The consumer boots idle. Pusher and Caddy keep working.

**Full**: pause or delete the Railway service. MSP's podping calls error out but its primary flow continues (podping is best-effort).

## Git Workflow

- Main branch: `main` (single branch, no PR workflow for this infra repo)
- Commits directly to `main` are fine — Railway watches `main` and auto-deploys on push
- Commit style: imperative tense, include `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` for Claude-assisted commits
- Do not commit the bearer token or posting key; they live only on Railway
- `consumer/dist/` and `consumer/node_modules/` are gitignored — never commit either

## Local Development

```bash
# container
export HIVE_ACCOUNT_NAME=youraccount
export HIVE_POSTING_KEY=STM...
export PODPING_SHARED_SECRET=$(openssl rand -hex 32)
export STABLEKRAFT_BASE_URL=http://host.docker.internal:3000
docker compose up --build
# Test pusher: curl -H "Authorization: Bearer $PODPING_SHARED_SECRET" \
#   "http://localhost:8080/?url=https://example.com/feed.xml&reason=update&no_broadcast=true&detailed_response=true"
# Test health: curl http://localhost:8080/health  (proxied from hivepinger)

# consumer only (faster iteration)
cd consumer
npm install
npm run build
CONSUMER_ENABLED=true \
CONSUMER_SMOKE_ANY_PP=true \
HIVE_ACCOUNT_NAME=youraccount \
STABLEKRAFT_BASE_URL=http://localhost:3000 \
CONSUMER_REWIND_BLOCKS=2000 \
node dist/index.js
# Expect: "[consumer] streaming from block N" within ~1s, periodic "processed N blocks",
# and "[txid] pp_* signer=... iris=..." lines as podpings appear.
```

Use `no_broadcast=true` on pusher requests to exercise the auth + queue path without actually posting to Hive.
