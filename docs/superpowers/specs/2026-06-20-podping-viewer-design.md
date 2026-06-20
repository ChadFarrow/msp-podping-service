# Podping Viewer — Design

**Date:** 2026-06-20
**Status:** Approved design, pending implementation plan

## Goal

A public web page on **musicsideproject.com** that shows the **entire Hive podping firehose** (every `pp_*` `custom_json` op from any signer) with **live updates** and **search/filter**. Each row is **enriched** with the feed's title and artwork via Podcast Index.

This grew out of debugging why a feed wasn't being picked up by some apps — there was no good way to *watch* podpings. Block explorers don't show `custom_json` ops; the only lens today is ad-hoc Hive RPC queries.

## Requirements (from brainstorming)

- **Scope:** the full network firehose — all podping types, all signers.
- **Live updates:** real-time push preferred.
- **Retention:** default **30 days**, configurable via `RETENTION_DAYS` env var (empty/0 = keep forever). Railway Postgres has no practical limit; retention is a cost dial, not a constraint.
- **Search/filter by:** feed URL/GUID, signer account, podping type/medium.
- **Display:** enriched rows — feed title + artwork + medium from Podcast Index, alongside raw podping fields.
- **Home:** new page in MSP-2.0; backend as a **separate Railway service** in the existing Railway project, isolated from the pusher/consumer.

## Architecture

```
Hive firehose ──► Collector ──► Postgres ◄── API (HTTP + SSE)
                      │                            ▲
                      └──► Enricher (PI lookup, cached)
                                                   │  CORS
                          MSP-2.0 /podpings page ──┘
                          (table + live SSE + filters)
```

- **New service:** a `viewer/` directory in *this* repo (`msp-podping-service`), deployed as its **own Railway service** (Railway service root = `viewer/`), separate from the pusher/consumer container so a viewer bug cannot affect podping forwarding.
- **Storage:** **Railway Postgres** plugin in the same project.
- **Frontend:** new `/podpings` route in **MSP-2.0** (Vite + React SPA on Vercel), talking to the Railway API over HTTPS with CORS.

Rationale for a separate service (vs. a 4th process in the existing container): full isolation from the production podping path; independent deploy/restart. Approach A (everything on Railway) was chosen over a Vercel-serverless API because Vercel functions are short-lived and cannot hold the Hive stream or a live SSE connection.

### Why Postgres (not SQLite)

Firehose volume is meaningful (~50k–150k podpings/day) and a separate service shouldn't rely on a shared filesystem volume. Railway Postgres is a one-click plugin and gives us indexed search and a clean connection model.

## Components (new service)

Node 20 + TypeScript. Runtime deps: `@hiveio/dhive` (reuse the consumer's streaming pattern), `pg`, `fastify`. Four concerns:

### 1. Collector
- dhive `Client` with multi-node failover (reuse `consumer/src/index.ts` pattern).
- Streams blocks in **Irreversible mode** (~45s behind head; no reorg handling). Head-mode for lower latency is a documented future option.
- Filter: `op[0] === 'custom_json' && op[1].id.startsWith('pp_')` — all podping types.
- For each matched op: parse `json`, extract `iris` (URLs and `podcast:guid:<guid>`), derive `medium` from `op_id`, capture `signer` (`required_posting_auths[0]`), `block_num`, `ts`.
- Upsert into `podpings` + `podping_iris` (dedup on `(tx_id, op_idx)`).
- Enqueue any **unseen** iri for enrichment.
- Rewind-on-boot like the consumer; the retention window fills forward. (Optional one-time backfill script if immediate history is wanted — see Out of Scope.)

### 2. Enricher
- Background worker drains the unseen-iri queue.
- Calls **Podcast Index** (`byfeedurl` for URLs, `byguid` for `podcast:guid:` iris) using **its own PI API keys** (env vars — self-contained, not coupled to MSP's keys).
- Caches `title`, `author`, `image`, `medium`, `pi_feed_id` in the `feeds` table. Marks `not_found = true` for feeds PI doesn't have, so they aren't re-queried.
- Rate-limited (~1 req/sec). **Enrichment is per unique feed, never per podping** — essential given firehose volume.
- PI failures never block ingestion; failed lookups retry later.

### 3. API (Fastify)
- `GET /api/podpings?feed=&signer=&type=&limit=&before=` — paginated list (default limit 50, cursor via `before` timestamp/id), each row joined with `feeds` enrichment.
  - `feed` matches an exact iri (URL or guid) via `podping_iris`.
  - `signer` exact match; `type` matches `op_id` (prefix-aware, e.g. `pp_music`).
- `GET /api/podpings/stream` — **Server-Sent Events**. Collector emits each newly-ingested (enriched if available) podping in-process to all connected clients. Browser `EventSource` auto-reconnects.
- `GET /health` — DB connectivity + collector heartbeat (last block processed).
- **CORS** allowing the MSP origin(s).

### 4. Pruner
- Periodic job (e.g. daily `setInterval`): `DELETE FROM podpings WHERE ts < now() - (RETENTION_DAYS || ' days')::interval`. Cascades to `podping_iris`. No-op when `RETENTION_DAYS` is empty. The small `feeds` cache is retained.

## Data model (Postgres)

```sql
-- one row per matched op
podpings (
  id           bigserial primary key,
  tx_id        text not null,
  op_idx       int  not null,
  block_num    bigint not null,
  ts           timestamptz not null,
  signer       text not null,
  op_id        text not null,          -- e.g. pp_music_update
  medium       text,                   -- derived from op_id (music/podcast/publisher/...)
  reason       text,
  iris         text[] not null,
  raw          jsonb not null,
  created_at   timestamptz default now(),
  unique (tx_id, op_idx)
)
-- indexes: ts desc, signer, op_id

-- normalized iris for fast feed lookup
podping_iris (
  podping_id   bigint references podpings(id) on delete cascade,
  iri          text not null
)
-- index: iri

-- enrichment cache (one row per unique feed)
feeds (
  iri          text primary key,
  pi_feed_id   bigint,
  title        text,
  author       text,
  image        text,
  medium       text,
  last_checked timestamptz,
  not_found    boolean default false
)
```

## Realtime mechanism

In-process `EventEmitter`: the collector emits a `podping` event after each successful insert; the API's SSE handler broadcasts it to connected clients as a JSON `data:` frame. If enrichment for a feed isn't ready yet, the row streams raw and the frontend can fill in title/art on a later poll or via a follow-up enrichment event. Single-process service, so no cross-process pub/sub needed.

## Frontend (MSP-2.0)

- New route `/podpings`.
- On load: `GET /api/podpings` (recent page) → render enriched cards/rows: artwork, title, signer, `op_id`/medium badge, relative time, block, and the feed iri (linked).
- Subscribe to `/api/podpings/stream` (SSE) → prepend new rows live, with a **Live / Pause** toggle.
- Filter controls: feed URL/guid input, signer input, type dropdown → re-query the API.
- Config: `VITE_PODPING_API_URL` points at the Railway service.

## Configuration (env vars, new service)

| Name | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | Railway Postgres connection string |
| `PODCASTINDEX_API_KEY` | Yes | Podcast Index enrichment |
| `PODCASTINDEX_API_SECRET` | Yes | Podcast Index enrichment |
| `RETENTION_DAYS` | No | Prune threshold in days; empty/0 = keep forever. Default `30`. |
| `HIVE_RPC_NODES` | No | Comma-separated RPC fallback list (same default as consumer) |
| `REWIND_BLOCKS` | No | Blocks to rewind on boot. Default ~200. |
| `CORS_ORIGINS` | No | Allowed origins for the API (MSP). |
| `PORT` | No | Railway-injected HTTP port. |

MSP-2.0 frontend adds `VITE_PODPING_API_URL`.

## Error handling

- **Stream drop:** reconnect with backoff (consumer pattern); never halt.
- **Bad JSON in a podping:** log tx id, skip.
- **PI errors (4xx/5xx/network):** skip enrichment, retry later; ingestion continues.
- **DB errors:** log + retry with backoff; avoid hard crash-loops.
- **SSE client disconnect:** clean up listener.

## Testing

- **Unit (vitest):** op→record classification, iri parsing (URL vs `podcast:guid:`), medium derivation from `op_id`, PI-response mapping (mocked PI), pruner SQL interval logic.
- **API:** filter combinations (feed/signer/type), pagination cursor, empty results.
- **Smoke:** point at Hive RPC, confirm `streaming from block N` and rows landing; confirm SSE delivers a live event.

## Out of scope (future)

- Head-mode streaming for sub-15s latency (adds reorg handling).
- One-time 7/30-day **backfill** on first deploy (heavy block scan).
- Free-text payload search and arbitrary time-range filters.
- Authentication / write actions (read-only public viewer for now).
- Analytics/charts (podpings over time, top notifiers).
