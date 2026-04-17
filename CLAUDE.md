# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`msp-podping-service` is a self-hosted [podping-hivepinger](https://github.com/brianoflondon/podping-hivepinger) deployment for [MSP 2.0](https://github.com/ChadFarrow/MSP-2.0). It runs on Railway as a single Docker container: a Caddy reverse proxy validates a shared bearer token and forwards authenticated requests to hivepinger, which queues feed-update notifications and broadcasts them as `podping` `custom_json` ops on the Hive blockchain.

## Architecture

```
MSP (Vercel) ──Bearer──► Caddy :$PORT ──► hivepinger 127.0.0.1:8000 ──► Hive
```

Single container, two processes managed by a shell entrypoint:
- **hivepinger** (Python, upstream image `brianoflondon/podping-hivepinger:1.4.1`) — binds to `127.0.0.1:8000`, never public
- **Caddy v2** — binds to Railway's `$PORT`, handles `/health` (public) and bearer-auth-gated proxy to hivepinger for everything else

## Repository Layout

```
.
├── Dockerfile            # Layers Caddy onto the hivepinger base image
├── entrypoint.sh         # Renders Caddyfile from template, starts both processes
├── Caddyfile.template    # Caddy config with __PORT__ and __PODPING_SHARED_SECRET__ placeholders
├── compose.yml           # Local-dev wrapper around the Dockerfile
├── .gitignore
├── README.md             # User-facing deploy instructions
└── CLAUDE.md             # (this file)
```

## Why a Template + sed Render?

Caddy's placeholder substitution (`{$VAR}`, `{env.VAR}`) has quirks inside `header` matcher values — depending on syntax position it may not expand, or may expand into invalid CEL. Rather than fight it, `entrypoint.sh` renders `Caddyfile.template` with plain `sed` into `/etc/caddy/Caddyfile` at container start, substituting `__PORT__` and `__PODPING_SHARED_SECRET__` with the real env values before Caddy ever loads. This means Caddy only ever parses literal values — no placeholder surprises.

The `sed` delimiter is `|`. Safe because `PODPING_SHARED_SECRET` is generated via `openssl rand -hex 32`, which emits only `[0-9a-f]`. If the secret source ever changes to allow arbitrary characters, swap to a delimiter the value can't contain (e.g., a sentinel char) or use `envsubst` (not installed in the base image by default).

## Entrypoint Flow

`entrypoint.sh`:
1. Logs presence + lengths (not values) of the four expected env vars (`PORT`, `PODPING_SHARED_SECRET`, `HIVE_ACCOUNT_NAME`, `HIVE_POSTING_KEY`) — diagnostic for missing-env issues on Railway.
2. Fails fast with `set -e` and `: "${PODPING_SHARED_SECRET:?...}"` if the secret is unset. Prevents a silent public deploy with an empty bearer value.
3. Renders `Caddyfile.template` → `/etc/caddy/Caddyfile`.
4. Starts hivepinger in the background: `python -m hivepinger.api --host 127.0.0.1 --port 8000`. Note: the 1.4.x CLI is flat (no `serve` subcommand) and the module entry is `hivepinger.api`, not `hivepinger`.
5. `exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile` in the foreground. Caddy inherits env from the shell and becomes PID 1.

## Required Env Vars (Railway Service Variables)

| Name | Required | Purpose |
|---|---|---|
| `HIVE_ACCOUNT_NAME` | Yes | Hive username (no `@`) for signing ops |
| `HIVE_POSTING_KEY` | Yes | Hive posting key (STM… prefix, never owner/active) |
| `PODPING_SHARED_SECRET` | Yes | Bearer token shared with MSP (Vercel stores the same value as `PODPING_BEARER_TOKEN`) |
| `PORT` | No | Railway auto-injects; Caddy defaults to `:8080` if unset |

## Caddy Auth Gate

`Caddyfile.template`:

```
:__PORT__ {
    handle /health { respond "ok" 200 }

    @authorized header Authorization "Bearer __PODPING_SHARED_SECRET__"
    handle @authorized { reverse_proxy 127.0.0.1:8000 }

    respond "Unauthorized" 401
}
```

After rendering, the `__PLACEHOLDER__` tokens are replaced with literal values. The `@authorized` matcher does exact-value header match (case-insensitive name, case-sensitive value). `/health` is unauthenticated by design — Railway needs to probe it.

## Upstream Dependencies

- **hivepinger**: `brianoflondon/podping-hivepinger` on Docker Hub. Current pin: `1.4.1`. Tags on Docker Hub follow `<major>.<minor>.<patch>` (no `v` prefix). Check [tags](https://hub.docker.com/r/brianoflondon/podping-hivepinger/tags) before bumping. Never `:latest`.
- **Caddy**: v2.8.4, downloaded as a binary from the official GitHub release in the Dockerfile. Layered on top of hivepinger's Debian-based (`python:3.13-slim`) image.

## Hive / Podping Notes

- Podping is permissionless — no notifier whitelist required. Any funded Hive account (~20 HP for Resource Credits) can broadcast.
- Account setup: `v4v.app` (Lightning-funded) or `hiveonboard.com?ref=podping` are both fine.
- On-chain proof: check `https://api.hive.blog` RPC or any Hive block explorer (`peakd.com/@<account>`, `hivescan.io/@<account>`) for `custom_json` ops with `id` like `pp_music_update`, `pp_podcast_update`, etc.

## Rotating the Bearer Token

1. Generate a new secret: `openssl rand -hex 32`
2. Update `PODPING_SHARED_SECRET` on Railway (auto-redeploys).
3. Update `PODPING_BEARER_TOKEN` on the MSP Vercel project to the same value, then redeploy MSP (Vercel doesn't auto-apply env changes to existing deployments).

If MSP still has the old token during the redeploy window, its podping calls will return 401 until it picks up the new env — that's expected.

## Rollback

Unset either `PODPING_ENDPOINT_URL` or `PODPING_BEARER_TOKEN` on MSP's Vercel project. MSP's `notifyPodping()` silently no-ops (it short-circuits when either is missing). The Railway service keeps running; it's just unused. No code change or redeploy needed on either side.

## Git Workflow

- Main branch: `main` (single branch, no PR workflow for this infra repo)
- Commits directly to `main` are fine — Railway watches `main` and auto-deploys on push
- Commit style: imperative tense, include `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` for Claude-assisted commits
- Do not commit the bearer token or posting key; they live only on Railway

## Local Development

```bash
export HIVE_ACCOUNT_NAME=youraccount
export HIVE_POSTING_KEY=STM...
export PODPING_SHARED_SECRET=$(openssl rand -hex 32)
docker compose up --build
# Test: curl -H "Authorization: Bearer $PODPING_SHARED_SECRET" \
#   "http://localhost:8080/?url=https://example.com/feed.xml&reason=update&no_broadcast=true&detailed_response=true"
```

Use `no_broadcast=true` to exercise the full path (auth + queue) without actually posting to Hive.
