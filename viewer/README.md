# Podping Viewer (backend)

Standalone Railway service: tails the Hive podping firehose into Postgres,
enriches feeds via Podcast Index, and serves a search + live-SSE API.

The UI (separate plan) will live at **pp.musicsideproject.com**.

## Railway setup
1. New service in the existing project, **root directory = `viewer/`**.
2. Add the **Postgres** plugin; Railway injects `DATABASE_URL`.
3. Set service variables:
   - `PODCASTINDEX_API_KEY`, `PODCASTINDEX_API_SECRET`
   - `RETENTION_DAYS` (optional, default 30; empty = keep forever)
   - `CORS_ORIGINS=https://pp.musicsideproject.com,https://musicsideproject.com`
   - `PG_POOL_MAX` (optional, default 10) — caps this service's Postgres connection pool.
4. Deploy. Check logs for `[collector] streaming from block N` and `[viewer] API listening`.

## Postgres memory & cost (the `pp_database` plugin)

This DB is a disposable rolling ~30-day cache of podpings (re-derivable from Hive), so it
can be RAM-capped aggressively. If its Railway memory/cost climbs, note:

- **The DB is near-idle (CPU ~0).** Its memory is mostly OS page cache + Postgres buffers
  expanding to fill whatever RAM the container has ("free RAM is used as cache"). Railway
  bills on memory *used*, so a big container = a big bill even when the DB does nothing.
- **The real lever is capping the container's memory** (Postgres service → Settings →
  Resource Limits), not Postgres tuning. Start ~1 GB, then try 512 MB, watching Deployments
  for OOM restarts. This bounds the page cache, which bounds the bill.
- **Do NOT set `shared_buffers` / `work_mem` / `effective_cache_size` as service Variables.**
  Railway's stock Postgres image ignores bare GUC names from the environment (only `POSTGRES_*`
  init vars are read), so they take no effect. To tune the server itself, pass `-c` flags on
  the start command or mount a `postgresql.conf`. Note `effective_cache_size` allocates *zero*
  memory — it's only a planner hint, so don't lower it to save RAM.
- **Bloat reclaim:** the pruner DELETEs old rows; autovacuum reclaims lazily. A one-time
  `VACUUM (FULL, ANALYZE) podpings;` / `... podping_iris;` shrinks the on-disk files (and thus
  the cached working set).
- **Connection budget:** the running server uses `PG_POOL_MAX` (default 10). The one-shot
  `backfill.ts` opens its **own** pool of up to 10, so running backfill against prod while the
  server is live needs ~20 connections and can hit *"too many connections"* if Postgres
  `max_connections` is low (e.g. 20 minus ~3 reserved). Don't backfill concurrently, or raise
  `max_connections`/lower `PG_POOL_MAX` first.

> If `pp.musicsideproject.com` is pointed directly at this Railway service
> (custom domain) and also serves the UI, the API is same-origin and CORS is
> unnecessary.

## Endpoints
- `GET /api/podpings?feed=&signer=&type=&limit=&before=`
- `GET /api/podpings/stream` (SSE)
- `GET /health`

## Local dev
```bash
createdb podping_viewer   # local Postgres (Homebrew)
export DATABASE_URL=postgres://$(whoami)@localhost:5432/podping_viewer
export PODCASTINDEX_API_KEY=... PODCASTINDEX_API_SECRET=...
npm install && npm run dev
```

## Tests
```bash
npm test                                   # unit tests
createdb podping_viewer_test
export TEST_DATABASE_URL=postgres://$(whoami)@localhost:5432/podping_viewer_test
npm test                                   # includes db integration tests
```
