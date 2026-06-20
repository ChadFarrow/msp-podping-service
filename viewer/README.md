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
4. Deploy. Check logs for `[collector] streaming from block N` and `[viewer] API listening`.

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
