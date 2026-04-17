# msp-podping-service

Self-hosted [podping-hivepinger](https://github.com/brianoflondon/podping-hivepinger) deployment for [MSP 2.0](https://github.com/ChadFarrow/MSP-2.0), fronted by Caddy for bearer-token auth.

## What it does

Receives HTTP podping requests from MSP, validates a shared bearer token, and forwards to hivepinger which queues, dedups, and broadcasts `podping` `custom_json` ops to the Hive blockchain. Podcast Index and other indexers watch whitelisted Hive accounts and re-crawl feeds when a podping lands.

## Architecture

```
MSP (Vercel) ──Bearer──► Caddy :8080 ──► hivepinger :1820 ──► Hive
```

## Prerequisites

- A Hive account on the [Podping notifier whitelist](https://github.com/Podcastindex-org/podping-hivewriter#accounts-whitelisted-to-send-podpings). Email `gethive@podping.org` to request whitelisting.
- The account's **posting key** (STM… prefix, never the owner or active key).

## Deploy to Railway

1. Create a new Railway project pointing at this repo.
2. Set the following service variables:
   - `HIVE_ACCOUNT_NAME` — your Hive username (no `@`)
   - `HIVE_POSTING_KEY` — posting key
   - `PODPING_SHARED_SECRET` — random 32+ char string. Generate with `openssl rand -hex 32`.
3. Deploy. Railway will build from the compose file and expose Caddy on a public URL.
4. Verify health: `curl https://<railway-url>/health` → `ok`
5. Verify auth gate: `curl -i https://<railway-url>/` → `401 Unauthorized`
6. Verify pass-through (no broadcast): `curl -H "Authorization: Bearer $SECRET" "https://<railway-url>/?url=https://example.com/feed.xml&reason=update&no_broadcast=true&detailed_response=true"` → 200 JSON

## MSP environment variables

On the MSP Vercel project, set:
- `PODPING_ENDPOINT_URL` — Railway URL with trailing slash (e.g. `https://msp-podping-abc.up.railway.app/`)
- `PODPING_BEARER_TOKEN` — same value as `PODPING_SHARED_SECRET`

## Rollback

Unset `PODPING_BEARER_TOKEN` or `PODPING_ENDPOINT_URL` on the MSP Vercel project. MSP's `notifyPodping()` silently no-ops. No redeploy needed.
