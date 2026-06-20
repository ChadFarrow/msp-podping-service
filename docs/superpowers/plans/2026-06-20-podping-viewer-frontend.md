# Podping Viewer Frontend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A standalone live-updating podping explorer UI at `pp.musicsideproject.com`, served same-origin by the Railway viewer service.

**Architecture:** A Vite + React + TS app in `viewer/ui/`, built to static files and served by the existing Fastify backend via `@fastify/static` (API routes take precedence; SPA fallback for the rest). Same-origin → relative `/api` calls, no CORS. Dockerfile becomes multi-stage (build UI + server).

**Tech Stack:** React 19, Vite 7, TypeScript, plain CSS (dark theme), native `fetch` + `EventSource`. No router, no state library.

## Global Constraints

- UI lives in `viewer/ui/`; its own `package.json`, gitignore `dist/` + `node_modules/`.
- All API calls are **relative** (`/api/podpings`, `/api/podpings/stream`) — never hardcode the host.
- Backend serves the built UI from `dist/ui` (copied during build); API + `/health` always win over static.
- Dark theme; match MSP's clean aesthetic. No new heavy deps.

---

### Task 1: Backend serves the static UI

**Files:**
- Modify: `viewer/package.json` (add `@fastify/static`)
- Modify: `viewer/src/index.ts` (register static + SPA fallback)
- Modify: `viewer/Dockerfile` (multi-stage build of UI)
- Test: `viewer/src/static.test.ts`

**Interfaces:**
- Produces: `registerUi(app, uiDir)` — registers static serving + SPA fallback only if `uiDir` exists.

- [ ] **Step 1: Add dep** — `cd viewer && npm install @fastify/static@^7`

- [ ] **Step 2: Write failing test `viewer/src/static.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { registerUi } from './static';

describe('registerUi', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-'));
  beforeAll(() => { writeFileSync(join(dir, 'index.html'), '<html>viewer</html>'); });

  it('serves index.html for a non-api route (SPA fallback)', async () => {
    const app = Fastify();
    app.get('/api/podpings', async () => ({ podpings: [] }));
    await registerUi(app, dir);
    await app.ready();
    const spa = await app.inject({ method: 'GET', url: '/anything' });
    expect(spa.body).toContain('viewer');
    const api = await app.inject({ method: 'GET', url: '/api/podpings' });
    expect(api.json()).toEqual({ podpings: [] });
    await app.close();
  });
});
```

- [ ] **Step 3: Run test → FAIL** (`npx vitest run src/static.test.ts`)

- [ ] **Step 4: Implement `viewer/src/static.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';

export async function registerUi(app: FastifyInstance, uiDir: string): Promise<void> {
  if (!existsSync(uiDir)) return;
  await app.register(fastifyStatic, { root: uiDir, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url === '/health') {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
}
```

- [ ] **Step 5: Run test → PASS**

- [ ] **Step 6: Wire into `viewer/src/index.ts`** — after `buildServer(...)`, before `listen`:

```ts
import { registerUi } from './static';
import { join } from 'node:path';
// ...
const app = buildServer({ db, corsOrigins: cfg.corsOrigins });
await registerUi(app, join(__dirname, 'ui'));
await app.listen({ host: '0.0.0.0', port: cfg.port });
```

- [ ] **Step 7: Update `viewer/Dockerfile`** to build the UI and place it at `dist/ui`:

```dockerfile
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
COPY ui ./ui
RUN cd ui && npm install && npm run build && mkdir -p /app/dist/ui && cp -r dist/* /app/dist/ui/

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js"]
```

- [ ] **Step 8: Commit** — `git add viewer/src/static.ts viewer/src/static.test.ts viewer/src/index.ts viewer/Dockerfile viewer/package.json viewer/package-lock.json && git commit -m "feat(viewer): serve static UI with SPA fallback"`

---

### Task 2: Scaffold the Vite UI app

**Files:** `viewer/ui/package.json`, `viewer/ui/vite.config.ts`, `viewer/ui/tsconfig.json`, `viewer/ui/index.html`, `viewer/ui/.gitignore`, `viewer/ui/src/main.tsx`

- [ ] **Step 1: `viewer/ui/package.json`**

```json
{
  "name": "msp-podping-viewer-ui",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "tsc -b && vite build", "preview": "vite preview" },
  "dependencies": { "react": "^19.2.0", "react-dom": "^19.2.0" },
  "devDependencies": {
    "@types/react": "^19.2.5", "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^5.1.1", "typescript": "~5.9.3", "vite": "^7.2.4"
  }
}
```

- [ ] **Step 2: `viewer/ui/vite.config.ts`** (dev proxy to the live API)

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: process.env.VITE_API_TARGET || 'http://localhost:8080', changeOrigin: true },
      '/health': { target: process.env.VITE_API_TARGET || 'http://localhost:8080', changeOrigin: true },
    },
  },
});
```

- [ ] **Step 3: `viewer/ui/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022", "useDefineForClassFields": true, "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext", "skipLibCheck": true, "moduleResolution": "bundler",
    "allowImportingTsExtensions": true, "noEmit": true, "jsx": "react-jsx",
    "strict": true, "noUnusedLocals": true, "noUnusedParameters": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: `viewer/ui/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Podping Viewer · Music Side Project</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: `viewer/ui/.gitignore`** → `node_modules/` and `dist/`

- [ ] **Step 6: `viewer/ui/src/main.tsx`**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
```

- [ ] **Step 7: Commit** (after Task 3–5 produce App/CSS, or commit scaffold now and build incrementally).

---

### Task 3: API client + types

**Files:** `viewer/ui/src/api.ts`

- [ ] **Step 1: Implement `viewer/ui/src/api.ts`**

```ts
export interface Feed { iri: string; piFeedId: number | null; title: string | null; author: string | null; image: string | null; medium: string | null; }
export interface Podping {
  id: number; txId: string; blockNum: number; ts: string; signer: string;
  opId: string; medium: string | null; reason: string | null; iris: string[]; feed?: Feed | null;
}
export interface Filters { feed?: string; signer?: string; type?: string; }

export async function fetchPodpings(filters: Filters, before?: number, limit = 50): Promise<Podping[]> {
  const p = new URLSearchParams();
  if (filters.feed) p.set('feed', filters.feed);
  if (filters.signer) p.set('signer', filters.signer);
  if (filters.type) p.set('type', filters.type);
  if (before) p.set('before', String(before));
  p.set('limit', String(limit));
  const res = await fetch(`/api/podpings?${p.toString()}`);
  if (!res.ok) throw new Error(`api ${res.status}`);
  return (await res.json()).podpings as Podping[];
}

export function openStream(onPodping: (p: Podping) => void, onState: (ok: boolean) => void): () => void {
  const es = new EventSource('/api/podpings/stream');
  es.onmessage = (e) => { try { onPodping(JSON.parse(e.data)); } catch { /* ignore */ } };
  es.onopen = () => onState(true);
  es.onerror = () => onState(false);
  return () => es.close();
}
```

---

### Task 4: Components (filters, row, list)

**Files:** `viewer/ui/src/components/Filters.tsx`, `viewer/ui/src/components/PodpingRow.tsx`, `viewer/ui/src/lib/format.ts`

- [ ] **Step 1: `viewer/ui/src/lib/format.ts`**

```ts
export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
export function hostOf(iri: string): string {
  if (iri.startsWith('podcast:guid:')) return iri;
  try { return new URL(iri).host; } catch { return iri; }
}
```

- [ ] **Step 2: `viewer/ui/src/components/Filters.tsx`**

```tsx
import type { Filters } from '../api';

const TYPES = ['', 'pp_music', 'pp_podcast', 'pp_publisher', 'pp_video'];
const LABELS: Record<string, string> = { '': 'All types', pp_music: 'Music', pp_podcast: 'Podcast', pp_publisher: 'Publisher', pp_video: 'Video' };

export function FiltersBar(props: {
  value: Filters; onChange: (f: Filters) => void;
  live: boolean; onToggleLive: () => void; connected: boolean;
}) {
  const { value, onChange, live, onToggleLive, connected } = props;
  return (
    <div className="filters">
      <input className="f-input" placeholder="Feed URL or podcast:guid:…"
        value={value.feed ?? ''} onChange={(e) => onChange({ ...value, feed: e.target.value || undefined })} />
      <input className="f-input" placeholder="Signer (e.g. chadf)"
        value={value.signer ?? ''} onChange={(e) => onChange({ ...value, signer: e.target.value || undefined })} />
      <select className="f-input" value={value.type ?? ''}
        onChange={(e) => onChange({ ...value, type: e.target.value || undefined })}>
        {TYPES.map((t) => <option key={t} value={t}>{LABELS[t]}</option>)}
      </select>
      <button className={`live ${live ? 'on' : 'off'}`} onClick={onToggleLive}>
        <span className={`dot ${connected ? 'ok' : 'bad'}`} /> {live ? 'Live' : 'Paused'}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: `viewer/ui/src/components/PodpingRow.tsx`**

```tsx
import type { Podping } from '../api';
import { relativeTime, hostOf } from '../lib/format';

export function PodpingRow({ p, fresh }: { p: Podping; fresh?: boolean }) {
  const title = p.feed?.title || hostOf(p.iris[0] ?? '(no iri)');
  const medium = p.medium ?? 'other';
  return (
    <div className={`row ${fresh ? 'fresh' : ''}`}>
      <div className="art">
        {p.feed?.image ? <img src={p.feed.image} alt="" loading="lazy" /> : <div className="art-ph" />}
      </div>
      <div className="meta">
        <div className="title">{title}</div>
        <div className="sub">
          <span className={`badge m-${medium}`}>{p.opId}</span>
          <span className="signer">@{p.signer}</span>
          <span className="time">{relativeTime(p.ts)}</span>
          <span className="block">#{p.blockNum}</span>
        </div>
        <div className="iris">
          {p.iris.map((iri) => (
            iri.startsWith('http')
              ? <a key={iri} href={iri} target="_blank" rel="noreferrer">{iri}</a>
              : <span key={iri}>{iri}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
```

---

### Task 5: App + styling + integrate

**Files:** `viewer/ui/src/App.tsx`, `viewer/ui/src/index.css`

- [ ] **Step 1: `viewer/ui/src/App.tsx`**

```tsx
import { useEffect, useRef, useState, useCallback } from 'react';
import { fetchPodpings, openStream, type Podping, type Filters } from './api';
import { FiltersBar } from './components/Filters';
import { PodpingRow } from './components/PodpingRow';

const hasFilter = (f: Filters) => Boolean(f.feed || f.signer || f.type);

export function App() {
  const [filters, setFilters] = useState<Filters>({});
  const [rows, setRows] = useState<Podping[]>([]);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(true);
  const [connected, setConnected] = useState(false);
  const freshIds = useRef<Set<number>>(new Set());

  const load = useCallback(async (reset: boolean) => {
    setLoading(true);
    try {
      const before = reset ? undefined : rows[rows.length - 1]?.id;
      const next = await fetchPodpings(filters, before);
      setRows((prev) => reset ? next : [...prev, ...next]);
    } finally { setLoading(false); }
  }, [filters, rows]);

  // Reload whenever filters change.
  useEffect(() => { void load(true); /* eslint-disable-next-line */ }, [filters]);

  // Live stream: only prepend when live AND no active filter (filtered views are query-driven).
  useEffect(() => {
    if (!live) return;
    const close = openStream((p) => {
      if (hasFilter(filters)) return;
      freshIds.current.add(p.id);
      setRows((prev) => prev.some((r) => r.id === p.id) ? prev : [p, ...prev].slice(0, 500));
    }, setConnected);
    return close;
  }, [live, filters]);

  return (
    <div className="app">
      <header className="head">
        <h1>Podping Viewer</h1>
        <p className="tag">Live Hive podping firehose · Music Side Project</p>
      </header>
      <FiltersBar value={filters} onChange={setFilters} live={live}
        onToggleLive={() => setLive((v) => !v)} connected={connected} />
      <main className="list">
        {rows.map((p) => <PodpingRow key={`${p.id}-${p.txId}`} p={p} fresh={freshIds.current.has(p.id)} />)}
        {rows.length === 0 && !loading && <div className="empty">No podpings found.</div>}
      </main>
      <div className="more">
        <button disabled={loading} onClick={() => load(false)}>{loading ? 'Loading…' : 'Load more'}</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `viewer/ui/src/index.css`** — dark theme (full styles for `.app`, `.head`, `.filters`, `.f-input`, `.live`, `.dot`, `.row`, `.art`, `.badge`, `.iris`, `.fresh` highlight animation, responsive). Write complete CSS, no placeholders.

- [ ] **Step 3: Build** — `cd viewer/ui && npm install && npm run build` → expect `dist/` created.

- [ ] **Step 4: Integrated smoke** — from `viewer/`: `npm run build` (server) then copy UI: `mkdir -p dist/ui && cp -r ui/dist/* dist/ui/`, run with prod `DATABASE_URL` + PI keys, then:
  - `curl localhost:8080/` → returns the HTML shell
  - `curl localhost:8080/api/podpings?limit=2` → JSON
  - Open in a browser → rows render, live dot connects.

- [ ] **Step 5: Commit** the whole UI.

---

## Self-Review

- Same-origin relative calls ✅ (api.ts). No CORS dependency.
- Live + pause + connection state ✅ (App, FiltersBar). Live suppressed under active filter ✅.
- Search by feed/signer/type ✅ (FiltersBar → fetchPodpings).
- Enriched rows w/ graceful not-enriched fallback ✅ (PodpingRow title/image fallback).
- Pagination via `before` cursor ✅.
- Backend serves UI + SPA fallback, API precedence ✅ (Task 1).
- Types consistent: `Podping`/`Feed`/`Filters` shared across api/components/App.
