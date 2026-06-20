# Podping Viewer Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Railway service that tails the full Hive podping firehose into Postgres, enriches feeds via Podcast Index, and serves a search + live-SSE HTTP API.

**Architecture:** Single Node 20 + TypeScript process in `viewer/`. A collector streams Hive blocks (dhive, Irreversible mode) and writes `pp_*` ops to Postgres; an enricher worker fills a per-feed metadata cache from Podcast Index; a Fastify API serves paginated search and a Server-Sent-Events live stream wired through an in-process event bus; a pruner deletes rows past the retention window. Deployed as its own Railway service (root `viewer/`) with a Railway Postgres plugin.

**Tech Stack:** Node 20, TypeScript, `@hiveio/dhive`, `pg`, `fastify`, `vitest` (tests), Docker.

## Global Constraints

- Node `>=20` (`engines.node`).
- Runtime deps only: `@hiveio/dhive`, `pg`, `fastify`. Dev deps: `typescript`, `@types/node`, `vitest`, `tsx`.
- Firehose filter is `op[0] === 'custom_json' && op[1].id.startsWith('pp_')` — never narrow to exact op-id strings.
- Enrichment is **per unique feed iri, cached** — never one Podcast Index call per podping.
- Default retention `RETENTION_DAYS=30`; empty/`0` means keep forever (pruner is a no-op).
- Podcast Index auth headers: `X-Auth-Key`, `X-Auth-Date` (unix seconds), `Authorization` = `sha1(key + secret + unixSeconds)` hex, plus a `User-Agent`.
- All code in `viewer/src/`; tests colocated as `*.test.ts`. Compiled output to `viewer/dist/`.
- DB integration tests run only when `TEST_DATABASE_URL` is set; otherwise they skip.
- `viewer/dist/` and `viewer/node_modules/` are gitignored.

---

### Task 1: Scaffold the service + config module

**Files:**
- Create: `viewer/package.json`
- Create: `viewer/tsconfig.json`
- Create: `viewer/.gitignore`
- Create: `viewer/src/config.ts`
- Test: `viewer/src/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config` where
  ```ts
  interface Config {
    databaseUrl: string;
    pi: { key: string; secret: string; userAgent: string };
    retentionDays: number | null;   // null = keep forever
    rpcNodes: string[];
    rewindBlocks: number;
    corsOrigins: string[];          // [] = allow none beyond same-origin
    port: number;
  }
  ```

- [ ] **Step 1: Create `viewer/package.json`**

```json
{
  "name": "msp-podping-viewer",
  "version": "1.0.0",
  "private": true,
  "description": "Hive podping firehose viewer: collector + enricher + search/SSE API.",
  "main": "dist/index.js",
  "type": "commonjs",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "@hiveio/dhive": "^1.3.6",
    "fastify": "^4.28.0",
    "pg": "^8.12.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/pg": "^8.11.0",
    "tsx": "^4.16.0",
    "typescript": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `viewer/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "node_modules", "dist"]
}
```

- [ ] **Step 3: Create `viewer/.gitignore`**

```
node_modules/
dist/
```

- [ ] **Step 4: Write the failing test `viewer/src/config.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from './config';

const base = {
  DATABASE_URL: 'postgres://localhost/x',
  PODCASTINDEX_API_KEY: 'k',
  PODCASTINDEX_API_SECRET: 's',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ ...base } as any);
    expect(c.databaseUrl).toBe('postgres://localhost/x');
    expect(c.retentionDays).toBe(30);
    expect(c.rewindBlocks).toBe(200);
    expect(c.port).toBe(8080);
    expect(c.rpcNodes.length).toBeGreaterThan(0);
    expect(c.corsOrigins).toEqual([]);
    expect(c.pi.userAgent).toContain('msp-podping-viewer');
  });

  it('treats empty RETENTION_DAYS as keep-forever (null)', () => {
    expect(loadConfig({ ...base, RETENTION_DAYS: '' } as any).retentionDays).toBeNull();
    expect(loadConfig({ ...base, RETENTION_DAYS: '0' } as any).retentionDays).toBeNull();
    expect(loadConfig({ ...base, RETENTION_DAYS: '90' } as any).retentionDays).toBe(90);
  });

  it('parses lists and port', () => {
    const c = loadConfig({
      ...base,
      HIVE_RPC_NODES: 'https://a.com, https://b.com',
      CORS_ORIGINS: 'https://musicsideproject.com,https://www.musicsideproject.com',
      PORT: '3001',
    } as any);
    expect(c.rpcNodes).toEqual(['https://a.com', 'https://b.com']);
    expect(c.corsOrigins).toEqual(['https://musicsideproject.com', 'https://www.musicsideproject.com']);
    expect(c.port).toBe(3001);
  });

  it('throws when a required var is missing', () => {
    expect(() => loadConfig({ PODCASTINDEX_API_KEY: 'k', PODCASTINDEX_API_SECRET: 's' } as any))
      .toThrow(/DATABASE_URL/);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd viewer && npm install && npx vitest run src/config.test.ts`
Expected: FAIL (cannot find module `./config`).

- [ ] **Step 6: Implement `viewer/src/config.ts`**

```ts
export interface Config {
  databaseUrl: string;
  pi: { key: string; secret: string; userAgent: string };
  retentionDays: number | null;
  rpcNodes: string[];
  rewindBlocks: number;
  corsOrigins: string[];
  port: number;
}

const DEFAULT_RPC = [
  'https://api.hive.blog',
  'https://api.deathwing.me',
  'https://hive-api.arcange.eu',
];

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function list(v: string | undefined, fallback: string[]): string[] {
  if (v === undefined || v.trim() === '') return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const retentionRaw = env.RETENTION_DAYS;
  let retentionDays: number | null;
  if (retentionRaw === undefined) retentionDays = 30;
  else if (retentionRaw.trim() === '' || retentionRaw.trim() === '0') retentionDays = null;
  else retentionDays = Number(retentionRaw);

  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    pi: {
      key: required(env, 'PODCASTINDEX_API_KEY'),
      secret: required(env, 'PODCASTINDEX_API_SECRET'),
      userAgent: env.PI_USER_AGENT || 'msp-podping-viewer/1.0',
    },
    retentionDays,
    rpcNodes: list(env.HIVE_RPC_NODES, DEFAULT_RPC),
    rewindBlocks: env.REWIND_BLOCKS ? Number(env.REWIND_BLOCKS) : 200,
    corsOrigins: list(env.CORS_ORIGINS, []),
    port: env.PORT ? Number(env.PORT) : 8080,
  };
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd viewer && npx vitest run src/config.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 8: Commit**

```bash
git add viewer/package.json viewer/tsconfig.json viewer/.gitignore viewer/src/config.ts viewer/src/config.test.ts
git commit -m "feat(viewer): scaffold service and config loader"
```

---

### Task 2: Podping parsing (pure)

**Files:**
- Create: `viewer/src/podping.ts`
- Test: `viewer/src/podping.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface PodpingRecord {
    txId: string;
    opIdx: number;
    blockNum: number;
    ts: string;          // ISO timestamp
    signer: string;
    opId: string;        // e.g. pp_music_update
    medium: string | null;
    reason: string | null;
    iris: string[];
    raw: unknown;        // the original custom_json op[1]
  }
  // op shape: ['custom_json', { id, json, required_posting_auths?, required_auths? }]
  function classifyOp(op: [string, any], ctx: { txId: string; opIdx: number; blockNum: number; ts: string }): PodpingRecord | null;
  function parseOpId(id: string): { medium: string | null; reason: string | null };
  function extractIris(json: unknown): string[];
  ```

- [ ] **Step 1: Write the failing test `viewer/src/podping.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { classifyOp, parseOpId, extractIris } from './podping';

const ctx = { txId: 'tx1', opIdx: 0, blockNum: 100, ts: '2026-06-20T00:00:00Z' };

describe('parseOpId', () => {
  it('splits medium and reason', () => {
    expect(parseOpId('pp_music_update')).toEqual({ medium: 'music', reason: 'update' });
    expect(parseOpId('pp_podcast_update')).toEqual({ medium: 'podcast', reason: 'update' });
    expect(parseOpId('pp_publisher_update')).toEqual({ medium: 'publisher', reason: 'update' });
  });
  it('handles multi-word reasons', () => {
    expect(parseOpId('pp_music_liveitem')).toEqual({ medium: 'music', reason: 'liveitem' });
  });
});

describe('extractIris', () => {
  it('reads iris array', () => {
    expect(extractIris({ iris: ['https://a/feed.xml', 'podcast:guid:abc'] }))
      .toEqual(['https://a/feed.xml', 'podcast:guid:abc']);
  });
  it('falls back to urls/url', () => {
    expect(extractIris({ urls: ['https://b/f.xml'] })).toEqual(['https://b/f.xml']);
    expect(extractIris({ url: 'https://c/f.xml' })).toEqual(['https://c/f.xml']);
  });
  it('returns [] for missing/garbage', () => {
    expect(extractIris({})).toEqual([]);
    expect(extractIris(null)).toEqual([]);
  });
});

describe('classifyOp', () => {
  it('builds a record for a pp_ custom_json op', () => {
    const op: [string, any] = ['custom_json', {
      id: 'pp_music_update',
      json: JSON.stringify({ iris: ['https://x/feed.xml'] }),
      required_posting_auths: ['ChadF'],
    }];
    const r = classifyOp(op, ctx)!;
    expect(r.opId).toBe('pp_music_update');
    expect(r.medium).toBe('music');
    expect(r.signer).toBe('ChadF');
    expect(r.iris).toEqual(['https://x/feed.xml']);
    expect(r.txId).toBe('tx1');
  });
  it('ignores non-custom_json ops', () => {
    expect(classifyOp(['transfer', {}], ctx)).toBeNull();
  });
  it('ignores non-pp custom_json ops', () => {
    expect(classifyOp(['custom_json', { id: 'ssc-mainnet-hive', json: '{}' }], ctx)).toBeNull();
  });
  it('uses required_auths when posting auths absent', () => {
    const op: [string, any] = ['custom_json', {
      id: 'pp_podcast_update', json: '{"iris":[]}', required_auths: ['someacct'],
    }];
    expect(classifyOp(op, ctx)!.signer).toBe('someacct');
  });
  it('survives bad JSON by returning a record with empty iris', () => {
    const op: [string, any] = ['custom_json', { id: 'pp_music_update', json: '{bad', required_posting_auths: ['a'] }];
    const r = classifyOp(op, ctx)!;
    expect(r.iris).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd viewer && npx vitest run src/podping.test.ts`
Expected: FAIL (cannot find module `./podping`).

- [ ] **Step 3: Implement `viewer/src/podping.ts`**

```ts
export interface PodpingRecord {
  txId: string;
  opIdx: number;
  blockNum: number;
  ts: string;
  signer: string;
  opId: string;
  medium: string | null;
  reason: string | null;
  iris: string[];
  raw: unknown;
}

export function parseOpId(id: string): { medium: string | null; reason: string | null } {
  const rest = id.startsWith('pp_') ? id.slice(3) : id;
  const parts = rest.split('_').filter(Boolean);
  if (parts.length === 0) return { medium: null, reason: null };
  if (parts.length === 1) return { medium: null, reason: parts[0] };
  return { medium: parts[0], reason: parts.slice(1).join('_') };
}

export function extractIris(json: unknown): string[] {
  if (!json || typeof json !== 'object') return [];
  const j = json as Record<string, unknown>;
  if (Array.isArray(j.iris)) return j.iris.filter((x): x is string => typeof x === 'string');
  if (Array.isArray(j.urls)) return j.urls.filter((x): x is string => typeof x === 'string');
  if (typeof j.url === 'string') return [j.url];
  return [];
}

export function classifyOp(
  op: [string, any],
  ctx: { txId: string; opIdx: number; blockNum: number; ts: string },
): PodpingRecord | null {
  if (op[0] !== 'custom_json') return null;
  const cj = op[1] ?? {};
  const id: string | undefined = cj.id;
  if (!id || !id.startsWith('pp_')) return null;

  let parsed: unknown = {};
  try {
    parsed = typeof cj.json === 'string' ? JSON.parse(cj.json) : cj.json;
  } catch {
    parsed = {};
  }

  const signer =
    (Array.isArray(cj.required_posting_auths) && cj.required_posting_auths[0]) ||
    (Array.isArray(cj.required_auths) && cj.required_auths[0]) ||
    'unknown';

  const { medium, reason } = parseOpId(id);
  return {
    txId: ctx.txId,
    opIdx: ctx.opIdx,
    blockNum: ctx.blockNum,
    ts: ctx.ts,
    signer,
    opId: id,
    medium,
    reason,
    iris: extractIris(parsed),
    raw: cj,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd viewer && npx vitest run src/podping.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add viewer/src/podping.ts viewer/src/podping.test.ts
git commit -m "feat(viewer): pure podping op classifier and iri parser"
```

---

### Task 3: Podcast Index client (auth + mapping)

**Files:**
- Create: `viewer/src/pi.ts`
- Test: `viewer/src/pi.test.ts`

**Interfaces:**
- Consumes: `Config['pi']` from Task 1.
- Produces:
  ```ts
  interface FeedMeta { piFeedId: number | null; title: string | null; author: string | null; image: string | null; medium: string | null; }
  function buildAuthHeaders(pi: {key:string;secret:string;userAgent:string}, nowSeconds: number): Record<string,string>;
  function isGuidIri(iri: string): boolean;            // 'podcast:guid:...' => true
  function guidFromIri(iri: string): string;            // strips the 'podcast:guid:' prefix
  function mapPiFeed(body: any): FeedMeta;              // PI response -> FeedMeta (not_found => all nulls)
  async function lookupFeed(pi, iri: string, fetchImpl?: typeof fetch): Promise<FeedMeta | null>; // null = not found
  ```

- [ ] **Step 1: Write the failing test `viewer/src/pi.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildAuthHeaders, isGuidIri, guidFromIri, mapPiFeed, lookupFeed } from './pi';

const pi = { key: 'KEY', secret: 'SECRET', userAgent: 'ua/1.0' };

describe('buildAuthHeaders', () => {
  it('produces the sha1(key+secret+date) authorization header', () => {
    const h = buildAuthHeaders(pi, 1700000000);
    expect(h['X-Auth-Key']).toBe('KEY');
    expect(h['X-Auth-Date']).toBe('1700000000');
    expect(h['User-Agent']).toBe('ua/1.0');
    const expected = createHash('sha1').update('KEYSECRET1700000000').digest('hex');
    expect(h['Authorization']).toBe(expected);
  });
});

describe('iri guid helpers', () => {
  it('detects and strips guid iris', () => {
    expect(isGuidIri('podcast:guid:abc-123')).toBe(true);
    expect(isGuidIri('https://x/feed.xml')).toBe(false);
    expect(guidFromIri('podcast:guid:abc-123')).toBe('abc-123');
  });
});

describe('mapPiFeed', () => {
  it('maps a found feed', () => {
    const body = { status: 'true', feed: { id: 42, title: 'DEMO', author: 'Friend Catcher', image: 'https://x/a.jpg', medium: 'music' } };
    expect(mapPiFeed(body)).toEqual({ piFeedId: 42, title: 'DEMO', author: 'Friend Catcher', image: 'https://x/a.jpg', medium: 'music' });
  });
  it('maps an empty/not-found body to all nulls', () => {
    expect(mapPiFeed({ status: 'true', feed: [] })).toEqual({ piFeedId: null, title: null, author: null, image: null, medium: null });
  });
});

describe('lookupFeed', () => {
  it('calls byfeedurl for URL iris', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ feed: { id: 1, title: 'T', author: 'A', image: 'I', medium: 'music' } }), { status: 200 }));
    const meta = await lookupFeed(pi, 'https://x/feed.xml', fetchImpl as any);
    expect(fetchImpl).toHaveBeenCalled();
    const url = (fetchImpl.mock.calls[0][0] as string);
    expect(url).toContain('/podcasts/byfeedurl');
    expect(url).toContain(encodeURIComponent('https://x/feed.xml'));
    expect(meta).toEqual({ piFeedId: 1, title: 'T', author: 'A', image: 'I', medium: 'music' });
  });
  it('calls byguid for guid iris', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ feed: { id: 2 } }), { status: 200 }));
    await lookupFeed(pi, 'podcast:guid:g-1', fetchImpl as any);
    expect((fetchImpl.mock.calls[0][0] as string)).toContain('/podcasts/byguid?guid=g-1');
  });
  it('returns null on non-200', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    expect(await lookupFeed(pi, 'https://x/f.xml', fetchImpl as any)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd viewer && npx vitest run src/pi.test.ts`
Expected: FAIL (cannot find module `./pi`).

- [ ] **Step 3: Implement `viewer/src/pi.ts`**

```ts
import { createHash } from 'node:crypto';

export interface FeedMeta {
  piFeedId: number | null;
  title: string | null;
  author: string | null;
  image: string | null;
  medium: string | null;
}

const API = 'https://api.podcastindex.org/api/1.0';
const NOT_FOUND: FeedMeta = { piFeedId: null, title: null, author: null, image: null, medium: null };

export function buildAuthHeaders(
  pi: { key: string; secret: string; userAgent: string },
  nowSeconds: number,
): Record<string, string> {
  const date = String(nowSeconds);
  const authorization = createHash('sha1').update(pi.key + pi.secret + date).digest('hex');
  return {
    'X-Auth-Key': pi.key,
    'X-Auth-Date': date,
    Authorization: authorization,
    'User-Agent': pi.userAgent,
  };
}

export function isGuidIri(iri: string): boolean {
  return iri.startsWith('podcast:guid:');
}

export function guidFromIri(iri: string): string {
  return iri.slice('podcast:guid:'.length);
}

export function mapPiFeed(body: any): FeedMeta {
  const feed = body?.feed;
  if (!feed || Array.isArray(feed) || typeof feed !== 'object') return { ...NOT_FOUND };
  return {
    piFeedId: typeof feed.id === 'number' ? feed.id : null,
    title: feed.title ?? null,
    author: feed.author ?? null,
    image: feed.image ?? null,
    medium: feed.medium ?? null,
  };
}

export async function lookupFeed(
  pi: { key: string; secret: string; userAgent: string },
  iri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FeedMeta | null> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const headers = buildAuthHeaders(pi, nowSeconds);
  const url = isGuidIri(iri)
    ? `${API}/podcasts/byguid?guid=${encodeURIComponent(guidFromIri(iri))}`
    : `${API}/podcasts/byfeedurl?url=${encodeURIComponent(iri)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers });
  } catch {
    return null;
  }
  if (res.status !== 200) return null;
  try {
    return mapPiFeed(await res.json());
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd viewer && npx vitest run src/pi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add viewer/src/pi.ts viewer/src/pi.test.ts
git commit -m "feat(viewer): podcast index client with auth and feed mapping"
```

---

### Task 4: Database schema + repository

**Files:**
- Create: `viewer/src/schema.sql`
- Create: `viewer/src/db.ts`
- Test: `viewer/src/db.test.ts`

**Interfaces:**
- Consumes: `PodpingRecord` (Task 2), `FeedMeta` (Task 3).
- Produces:
  ```ts
  interface SearchParams { feed?: string; signer?: string; type?: string; limit?: number; before?: number; }
  interface PodpingRow extends PodpingRecord { id: number; feed?: FeedMeta & { iri: string } | null; }
  class Db {
    constructor(databaseUrl: string);
    migrate(): Promise<void>;
    insertPodping(r: PodpingRecord): Promise<number | null>;   // returns new id, or null if duplicate
    searchPodpings(p: SearchParams): Promise<PodpingRow[]>;
    irisNeedingEnrichment(limit: number): Promise<string[]>;    // iris not yet in feeds table
    upsertFeed(iri: string, meta: FeedMeta | null): Promise<void>; // null => mark not_found
    getFeed(iri: string): Promise<(FeedMeta & { iri: string }) | null>;
    prune(retentionDays: number | null): Promise<number>;       // rows deleted; 0 when null
    lastBlock(): Promise<number | null>;
    close(): Promise<void>;
  }
  ```

> **Note:** DB tests require a real Postgres. They run only when `TEST_DATABASE_URL` is set and operate against a throwaway schema. Locally: `docker run -e POSTGRES_PASSWORD=pw -p 5433:5432 -d postgres:16` then `export TEST_DATABASE_URL=postgres://postgres:pw@localhost:5433/postgres`.

- [ ] **Step 1: Create `viewer/src/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS podpings (
  id          BIGSERIAL PRIMARY KEY,
  tx_id       TEXT NOT NULL,
  op_idx      INT  NOT NULL,
  block_num   BIGINT NOT NULL,
  ts          TIMESTAMPTZ NOT NULL,
  signer      TEXT NOT NULL,
  op_id       TEXT NOT NULL,
  medium      TEXT,
  reason      TEXT,
  iris        TEXT[] NOT NULL,
  raw         JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_id, op_idx)
);
CREATE INDEX IF NOT EXISTS podpings_ts_idx ON podpings (ts DESC);
CREATE INDEX IF NOT EXISTS podpings_signer_idx ON podpings (signer);
CREATE INDEX IF NOT EXISTS podpings_op_id_idx ON podpings (op_id);

CREATE TABLE IF NOT EXISTS podping_iris (
  podping_id  BIGINT NOT NULL REFERENCES podpings(id) ON DELETE CASCADE,
  iri         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS podping_iris_iri_idx ON podping_iris (iri);
CREATE INDEX IF NOT EXISTS podping_iris_podping_idx ON podping_iris (podping_id);

CREATE TABLE IF NOT EXISTS feeds (
  iri          TEXT PRIMARY KEY,
  pi_feed_id   BIGINT,
  title        TEXT,
  author       TEXT,
  image        TEXT,
  medium       TEXT,
  last_checked TIMESTAMPTZ,
  not_found    BOOLEAN NOT NULL DEFAULT false
);
```

- [ ] **Step 2: Write the failing test `viewer/src/db.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from './db';
import type { PodpingRecord } from './podping';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

function rec(over: Partial<PodpingRecord> = {}): PodpingRecord {
  return {
    txId: 'tx-' + Math.random().toString(36).slice(2),
    opIdx: 0, blockNum: 100, ts: '2026-06-20T00:00:00Z',
    signer: 'chadf', opId: 'pp_music_update', medium: 'music', reason: 'update',
    iris: ['https://x/feed.xml'], raw: { id: 'pp_music_update' }, ...over,
  };
}

d('Db', () => {
  let db: Db;
  beforeAll(async () => { db = new Db(url!); await db.migrate(); });
  afterAll(async () => { await db.close(); });

  it('inserts and dedups by (tx_id, op_idx)', async () => {
    const r = rec();
    const id1 = await db.insertPodping(r);
    const id2 = await db.insertPodping(r);
    expect(id1).toBeTypeOf('number');
    expect(id2).toBeNull();
  });

  it('searches by feed iri', async () => {
    const r = rec({ iris: ['https://unique/abc.xml'] });
    await db.insertPodping(r);
    const rows = await db.searchPodpings({ feed: 'https://unique/abc.xml' });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].iris).toContain('https://unique/abc.xml');
  });

  it('filters by signer and type', async () => {
    await db.insertPodping(rec({ signer: 'zzz_signer', opId: 'pp_podcast_update', medium: 'podcast' }));
    const bySigner = await db.searchPodpings({ signer: 'zzz_signer' });
    expect(bySigner.every((x) => x.signer === 'zzz_signer')).toBe(true);
    const byType = await db.searchPodpings({ type: 'pp_podcast', signer: 'zzz_signer' });
    expect(byType.every((x) => x.opId.startsWith('pp_podcast'))).toBe(true);
  });

  it('tracks and enriches feeds', async () => {
    await db.insertPodping(rec({ iris: ['https://enrich/me.xml'] }));
    const pending = await db.irisNeedingEnrichment(50);
    expect(pending).toContain('https://enrich/me.xml');
    await db.upsertFeed('https://enrich/me.xml', { piFeedId: 7, title: 'T', author: 'A', image: 'I', medium: 'music' });
    const feed = await db.getFeed('https://enrich/me.xml');
    expect(feed?.title).toBe('T');
    const stillPending = await db.irisNeedingEnrichment(50);
    expect(stillPending).not.toContain('https://enrich/me.xml');
  });

  it('marks not-found feeds so they are not re-queried', async () => {
    await db.insertPodping(rec({ iris: ['https://gone/x.xml'] }));
    await db.upsertFeed('https://gone/x.xml', null);
    const feed = await db.getFeed('https://gone/x.xml');
    expect(feed?.title).toBeNull();
    expect((await db.irisNeedingEnrichment(50))).not.toContain('https://gone/x.xml');
  });

  it('prune is a no-op when retention is null', async () => {
    expect(await db.prune(null)).toBe(0);
  });

  it('prune deletes old rows', async () => {
    await db.insertPodping(rec({ ts: '2000-01-01T00:00:00Z' }));
    const deleted = await db.prune(30);
    expect(deleted).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd viewer && export TEST_DATABASE_URL=postgres://postgres:pw@localhost:5433/postgres && npx vitest run src/db.test.ts`
Expected: FAIL (cannot find module `./db`). (If `TEST_DATABASE_URL` is unset the suite skips — set it to actually drive this task.)

- [ ] **Step 4: Implement `viewer/src/db.ts`**

```ts
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PodpingRecord } from './podping';
import type { FeedMeta } from './pi';

export interface SearchParams { feed?: string; signer?: string; type?: string; limit?: number; before?: number; }
export interface PodpingRow extends PodpingRecord {
  id: number;
  feed?: (FeedMeta & { iri: string }) | null;
}

export class Db {
  private pool: Pool;
  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async migrate(): Promise<void> {
    const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
    await this.pool.query(sql);
  }

  async insertPodping(r: PodpingRecord): Promise<number | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `INSERT INTO podpings (tx_id, op_idx, block_num, ts, signer, op_id, medium, reason, iris, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (tx_id, op_idx) DO NOTHING
         RETURNING id`,
        [r.txId, r.opIdx, r.blockNum, r.ts, r.signer, r.opId, r.medium, r.reason, r.iris, JSON.stringify(r.raw)],
      );
      if (res.rowCount === 0) { await client.query('ROLLBACK'); return null; }
      const id = res.rows[0].id as number;
      for (const iri of r.iris) {
        await client.query('INSERT INTO podping_iris (podping_id, iri) VALUES ($1,$2)', [id, iri]);
      }
      await client.query('COMMIT');
      return id;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async searchPodpings(p: SearchParams): Promise<PodpingRow[]> {
    const limit = Math.min(p.limit ?? 50, 200);
    const where: string[] = [];
    const args: unknown[] = [];
    if (p.feed) {
      args.push(p.feed);
      where.push(`p.id IN (SELECT podping_id FROM podping_iris WHERE iri = $${args.length})`);
    }
    if (p.signer) { args.push(p.signer); where.push(`p.signer = $${args.length}`); }
    if (p.type) { args.push(p.type + '%'); where.push(`p.op_id LIKE $${args.length}`); }
    if (p.before) { args.push(p.before); where.push(`p.id < $${args.length}`); }
    args.push(limit);
    const sql = `
      SELECT p.*, f.iri AS f_iri, f.pi_feed_id, f.title, f.author, f.image, f.medium AS f_medium
      FROM podpings p
      LEFT JOIN LATERAL (
        SELECT fe.* FROM podping_iris pi JOIN feeds fe ON fe.iri = pi.iri
        WHERE pi.podping_id = p.id AND fe.not_found = false LIMIT 1
      ) f ON true
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY p.id DESC
      LIMIT $${args.length}`;
    const res = await this.pool.query(sql, args);
    return res.rows.map((row) => ({
      id: row.id, txId: row.tx_id, opIdx: row.op_idx, blockNum: Number(row.block_num),
      ts: row.ts instanceof Date ? row.ts.toISOString() : row.ts,
      signer: row.signer, opId: row.op_id, medium: row.medium, reason: row.reason,
      iris: row.iris, raw: row.raw,
      feed: row.f_iri ? { iri: row.f_iri, piFeedId: row.pi_feed_id, title: row.title, author: row.author, image: row.image, medium: row.f_medium } : null,
    }));
  }

  async irisNeedingEnrichment(limit: number): Promise<string[]> {
    const res = await this.pool.query(
      `SELECT DISTINCT pi.iri FROM podping_iris pi
       LEFT JOIN feeds f ON f.iri = pi.iri
       WHERE f.iri IS NULL
       LIMIT $1`, [limit]);
    return res.rows.map((r) => r.iri as string);
  }

  async upsertFeed(iri: string, meta: FeedMeta | null): Promise<void> {
    const m = meta ?? { piFeedId: null, title: null, author: null, image: null, medium: null };
    await this.pool.query(
      `INSERT INTO feeds (iri, pi_feed_id, title, author, image, medium, last_checked, not_found)
       VALUES ($1,$2,$3,$4,$5,$6, now(), $7)
       ON CONFLICT (iri) DO UPDATE SET
         pi_feed_id = EXCLUDED.pi_feed_id, title = EXCLUDED.title, author = EXCLUDED.author,
         image = EXCLUDED.image, medium = EXCLUDED.medium, last_checked = now(), not_found = EXCLUDED.not_found`,
      [iri, m.piFeedId, m.title, m.author, m.image, m.medium, meta === null],
    );
  }

  async getFeed(iri: string): Promise<(FeedMeta & { iri: string }) | null> {
    const res = await this.pool.query('SELECT * FROM feeds WHERE iri = $1', [iri]);
    if (res.rowCount === 0) return null;
    const r = res.rows[0];
    return { iri: r.iri, piFeedId: r.pi_feed_id, title: r.title, author: r.author, image: r.image, medium: r.medium };
  }

  async prune(retentionDays: number | null): Promise<number> {
    if (retentionDays === null) return 0;
    const res = await this.pool.query(
      `DELETE FROM podpings WHERE ts < now() - ($1 || ' days')::interval`, [String(retentionDays)]);
    return res.rowCount ?? 0;
  }

  async lastBlock(): Promise<number | null> {
    const res = await this.pool.query('SELECT max(block_num) AS b FROM podpings');
    return res.rows[0].b === null ? null : Number(res.rows[0].b);
  }

  async close(): Promise<void> { await this.pool.end(); }
}
```

- [ ] **Step 5: Ensure `schema.sql` is copied into `dist/`**

Because `db.ts` reads `schema.sql` from `__dirname`, add a postbuild copy. Edit `viewer/package.json` `scripts.build`:

```json
"build": "tsc && cp src/schema.sql dist/schema.sql",
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd viewer && npx vitest run src/db.test.ts`
Expected: PASS (with `TEST_DATABASE_URL` set).

- [ ] **Step 7: Commit**

```bash
git add viewer/src/schema.sql viewer/src/db.ts viewer/src/db.test.ts viewer/package.json
git commit -m "feat(viewer): postgres schema and repository layer"
```

---

### Task 5: Event bus + SSE frame formatting

**Files:**
- Create: `viewer/src/events.ts`
- Test: `viewer/src/events.test.ts`

**Interfaces:**
- Consumes: `PodpingRow` (Task 4).
- Produces:
  ```ts
  const bus: import('node:events').EventEmitter;       // emits 'podping' with a PodpingRow
  function sseFrame(row: PodpingRow): string;           // 'data: {...}\n\n'
  ```

- [ ] **Step 1: Write the failing test `viewer/src/events.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { bus, sseFrame } from './events';

describe('events', () => {
  it('bus relays a podping payload', async () => {
    const got = await new Promise((resolve) => {
      bus.once('podping', resolve);
      bus.emit('podping', { id: 1, signer: 'chadf' });
    });
    expect((got as any).signer).toBe('chadf');
  });

  it('sseFrame serializes as an SSE data frame', () => {
    const frame = sseFrame({ id: 5, opId: 'pp_music_update' } as any);
    expect(frame).toBe('data: {"id":5,"opId":"pp_music_update"}\n\n');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd viewer && npx vitest run src/events.test.ts`
Expected: FAIL (cannot find module `./events`).

- [ ] **Step 3: Implement `viewer/src/events.ts`**

```ts
import { EventEmitter } from 'node:events';
import type { PodpingRow } from './db';

export const bus = new EventEmitter();
bus.setMaxListeners(0); // many SSE clients

export function sseFrame(row: PodpingRow): string {
  return `data: ${JSON.stringify(row)}\n\n`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd viewer && npx vitest run src/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add viewer/src/events.ts viewer/src/events.test.ts
git commit -m "feat(viewer): in-process event bus and SSE frame helper"
```

---

### Task 6: Collector block processor

**Files:**
- Create: `viewer/src/collector.ts`
- Test: `viewer/src/collector.test.ts`

**Interfaces:**
- Consumes: `classifyOp` (Task 2), `Db.insertPodping`/`getFeed` (Task 4), `bus` (Task 5).
- Produces:
  ```ts
  // Pure-ish: process one decoded block's transactions, insert podpings, emit live rows.
  async function processBlock(
    block: { transaction_ids: string[]; transactions: { operations: [string, any][] }[] },
    blockNum: number,
    deps: { db: Pick<Db,'insertPodping'|'getFeed'>; emit: (row: PodpingRow) => void },
  ): Promise<number>;   // count of podpings ingested
  function startCollector(cfg: Config, db: Db): void;   // streams Hive; not unit-tested
  ```

> Only `processBlock` is unit-tested (deterministic, no network). `startCollector` wires dhive streaming around it and is covered by the Task 10 smoke test.

- [ ] **Step 1: Write the failing test `viewer/src/collector.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { processBlock } from './collector';

function block() {
  return {
    transaction_ids: ['txA', 'txB'],
    transactions: [
      { operations: [['custom_json', { id: 'pp_music_update', json: '{"iris":["https://a/f.xml"]}', required_posting_auths: ['chadf'] }]] },
      { operations: [['transfer', {}], ['custom_json', { id: 'not_pp', json: '{}' }]] },
    ],
  };
}

describe('processBlock', () => {
  it('ingests only pp_ ops and emits enriched live rows', async () => {
    const inserted: any[] = [];
    const emitted: any[] = [];
    const deps = {
      db: {
        insertPodping: vi.fn(async (r: any) => { inserted.push(r); return inserted.length; }),
        getFeed: vi.fn(async () => ({ iri: 'https://a/f.xml', piFeedId: 1, title: 'A', author: null, image: null, medium: 'music' })),
      },
      emit: (row: any) => emitted.push(row),
    };
    const n = await processBlock(block() as any, 555, deps as any);
    expect(n).toBe(1);
    expect(inserted[0].txId).toBe('txA');
    expect(inserted[0].blockNum).toBe(555);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].feed.title).toBe('A');
  });

  it('does not emit when insert is a duplicate (returns null)', async () => {
    const emitted: any[] = [];
    const deps = {
      db: { insertPodping: vi.fn(async () => null), getFeed: vi.fn(async () => null) },
      emit: (row: any) => emitted.push(row),
    };
    const n = await processBlock(block() as any, 1, deps as any);
    expect(n).toBe(0);
    expect(emitted).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd viewer && npx vitest run src/collector.test.ts`
Expected: FAIL (cannot find module `./collector`).

- [ ] **Step 3: Implement `viewer/src/collector.ts`**

```ts
import { Client } from '@hiveio/dhive';
import { classifyOp } from './podping';
import type { Db, PodpingRow } from './db';
import { bus } from './events';
import type { Config } from './config';

export async function processBlock(
  block: { transaction_ids: string[]; transactions: { operations: [string, any][] }[] },
  blockNum: number,
  deps: { db: Pick<Db, 'insertPodping' | 'getFeed'>; emit: (row: PodpingRow) => void },
): Promise<number> {
  let count = 0;
  const ts = new Date().toISOString();
  const txs = block.transactions ?? [];
  for (let t = 0; t < txs.length; t++) {
    const txId = block.transaction_ids[t] ?? `${blockNum}-${t}`;
    const ops = txs[t].operations ?? [];
    for (let o = 0; o < ops.length; o++) {
      const rec = classifyOp(ops[o], { txId, opIdx: o, blockNum, ts });
      if (!rec) continue;
      const id = await deps.db.insertPodping(rec);
      if (id === null) continue;
      count++;
      let feed = null;
      for (const iri of rec.iris) {
        const f = await deps.db.getFeed(iri);
        if (f && f.title) { feed = f; break; }
      }
      deps.emit({ ...rec, id, feed });
    }
  }
  return count;
}

export function startCollector(cfg: Config, db: Db): void {
  const client = new Client(cfg.rpcNodes, { failoverThreshold: 3, timeout: 8000 });
  (async function run() {
    try {
      const props = await client.database.getDynamicGlobalProperties();
      const lastIrr = (props as any).last_irreversible_block_num as number;
      const stored = await db.lastBlock();
      const from = stored ? stored + 1 : Math.max(1, lastIrr - cfg.rewindBlocks);
      console.log(`[collector] streaming from block ${from}`);
      let seen = 0;
      for await (const block of client.blockchain.getBlocks({ from, mode: 1 /* Irreversible */ })) {
        const blockNum = parseInt((block as any).block_id.slice(0, 8), 16);
        await processBlock(block as any, blockNum, { db, emit: (row) => bus.emit('podping', row) });
        if (++seen % 100 === 0) console.log(`[collector] processed ${seen} blocks, head=${blockNum}`);
      }
    } catch (err) {
      console.error('[collector] stream error, reconnecting in 5s:', err);
      setTimeout(run, 5000);
    }
  })();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd viewer && npx vitest run src/collector.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add viewer/src/collector.ts viewer/src/collector.test.ts
git commit -m "feat(viewer): block processor and hive collector loop"
```

---

### Task 7: Enricher worker

**Files:**
- Create: `viewer/src/enricher.ts`
- Test: `viewer/src/enricher.test.ts`

**Interfaces:**
- Consumes: `Db.irisNeedingEnrichment`/`upsertFeed` (Task 4), `lookupFeed` (Task 3).
- Produces:
  ```ts
  // Process one batch: look up each pending iri, cache result (or mark not_found). Returns count processed.
  async function enrichBatch(
    deps: { db: Pick<Db,'irisNeedingEnrichment'|'upsertFeed'>; lookup: (iri:string)=>Promise<FeedMeta|null> },
    batchSize: number,
  ): Promise<number>;
  function startEnricher(cfg: Config, db: Db): void;   // setInterval loop; not unit-tested
  ```

- [ ] **Step 1: Write the failing test `viewer/src/enricher.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { enrichBatch } from './enricher';

describe('enrichBatch', () => {
  it('looks up each pending iri and upserts the result', async () => {
    const upserts: any[] = [];
    const deps = {
      db: {
        irisNeedingEnrichment: vi.fn(async () => ['https://a/f.xml', 'podcast:guid:g1']),
        upsertFeed: vi.fn(async (iri: string, meta: any) => { upserts.push([iri, meta]); }),
      },
      lookup: vi.fn(async (iri: string) =>
        iri.includes('a/f') ? { piFeedId: 1, title: 'A', author: null, image: null, medium: 'music' } : null),
    };
    const n = await enrichBatch(deps as any, 50);
    expect(n).toBe(2);
    expect(deps.lookup).toHaveBeenCalledTimes(2);
    expect(upserts).toContainEqual(['https://a/f.xml', { piFeedId: 1, title: 'A', author: null, image: null, medium: 'music' }]);
    expect(upserts).toContainEqual(['podcast:guid:g1', null]); // not found => mark not_found
  });

  it('returns 0 when nothing pending', async () => {
    const deps = {
      db: { irisNeedingEnrichment: vi.fn(async () => []), upsertFeed: vi.fn() },
      lookup: vi.fn(),
    };
    expect(await enrichBatch(deps as any, 50)).toBe(0);
    expect(deps.lookup).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd viewer && npx vitest run src/enricher.test.ts`
Expected: FAIL (cannot find module `./enricher`).

- [ ] **Step 3: Implement `viewer/src/enricher.ts`**

```ts
import { lookupFeed, type FeedMeta } from './pi';
import type { Db } from './db';
import type { Config } from './config';

export async function enrichBatch(
  deps: {
    db: Pick<Db, 'irisNeedingEnrichment' | 'upsertFeed'>;
    lookup: (iri: string) => Promise<FeedMeta | null>;
  },
  batchSize: number,
): Promise<number> {
  const pending = await deps.db.irisNeedingEnrichment(batchSize);
  for (const iri of pending) {
    const meta = await deps.lookup(iri);
    await deps.db.upsertFeed(iri, meta); // meta null => marked not_found
  }
  return pending.length;
}

export function startEnricher(cfg: Config, db: Db): void {
  const lookup = (iri: string) => lookupFeed(cfg.pi, iri);
  let running = false;
  setInterval(async () => {
    if (running) return; // avoid overlap
    running = true;
    try {
      const n = await enrichBatch({ db, lookup }, 10); // ~10/tick keeps PI well under rate limits
      if (n > 0) console.log(`[enricher] enriched ${n} feeds`);
    } catch (err) {
      console.error('[enricher] batch error:', err);
    } finally {
      running = false;
    }
  }, 1500);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd viewer && npx vitest run src/enricher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add viewer/src/enricher.ts viewer/src/enricher.test.ts
git commit -m "feat(viewer): podcast index enricher worker"
```

---

### Task 8: API routes (search + SSE + health)

**Files:**
- Create: `viewer/src/api.ts`
- Test: `viewer/src/api.test.ts`

**Interfaces:**
- Consumes: `Db.searchPodpings`/`lastBlock` (Task 4), `bus`/`sseFrame` (Task 5).
- Produces:
  ```ts
  function buildServer(deps: { db: Pick<Db,'searchPodpings'|'lastBlock'>; corsOrigins: string[] }): FastifyInstance;
  // GET /api/podpings?feed&signer&type&limit&before  -> { podpings: PodpingRow[] }
  // GET /api/podpings/stream                          -> text/event-stream
  // GET /health                                       -> { ok, lastBlock }
  ```

- [ ] **Step 1: Write the failing test `viewer/src/api.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { buildServer } from './api';

function deps(rows: any[] = []) {
  return {
    db: {
      searchPodpings: vi.fn(async (_p: any) => rows),
      lastBlock: vi.fn(async () => 12345),
    },
    corsOrigins: ['https://musicsideproject.com'],
  };
}

describe('api', () => {
  it('GET /health reports lastBlock', async () => {
    const app = buildServer(deps());
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, lastBlock: 12345 });
    await app.close();
  });

  it('GET /api/podpings passes filters through and returns rows', async () => {
    const d = deps([{ id: 1, signer: 'chadf' }]);
    const app = buildServer(d);
    const res = await app.inject({ method: 'GET', url: '/api/podpings?feed=https://x/f.xml&signer=chadf&type=pp_music&limit=10&before=99' });
    expect(res.statusCode).toBe(200);
    expect(res.json().podpings).toHaveLength(1);
    expect(d.db.searchPodpings).toHaveBeenCalledWith({ feed: 'https://x/f.xml', signer: 'chadf', type: 'pp_music', limit: 10, before: 99 });
    await app.close();
  });

  it('sets CORS header for an allowed origin', async () => {
    const app = buildServer(deps());
    const res = await app.inject({ method: 'GET', url: '/api/podpings', headers: { origin: 'https://musicsideproject.com' } });
    expect(res.headers['access-control-allow-origin']).toBe('https://musicsideproject.com');
    await app.close();
  });

  it('SSE endpoint responds with event-stream content type', async () => {
    const app = buildServer(deps());
    const res = await app.inject({ method: 'GET', url: '/api/podpings/stream' });
    expect(res.headers['content-type']).toContain('text/event-stream');
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd viewer && npx vitest run src/api.test.ts`
Expected: FAIL (cannot find module `./api`).

- [ ] **Step 3: Implement `viewer/src/api.ts`**

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type { Db, PodpingRow, SearchParams } from './db';
import { bus, sseFrame } from './events';

export function buildServer(deps: {
  db: Pick<Db, 'searchPodpings' | 'lastBlock'>;
  corsOrigins: string[];
}): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && deps.corsOrigins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type');
      reply.code(204).send();
    }
  });

  app.get('/health', async () => ({ ok: true, lastBlock: await deps.db.lastBlock() }));

  app.get('/api/podpings', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const params: SearchParams = {
      feed: q.feed || undefined,
      signer: q.signer || undefined,
      type: q.type || undefined,
      limit: q.limit ? Number(q.limit) : undefined,
      before: q.before ? Number(q.before) : undefined,
    };
    const podpings = await deps.db.searchPodpings(params);
    return { podpings };
  });

  app.get('/api/podpings/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...(req.headers.origin && deps.corsOrigins.includes(req.headers.origin)
        ? { 'Access-Control-Allow-Origin': req.headers.origin }
        : {}),
    });
    reply.raw.write(': connected\n\n');
    const onPodping = (row: PodpingRow) => reply.raw.write(sseFrame(row));
    bus.on('podping', onPodping);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 30000);
    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off('podping', onPodping);
    });
  });

  return app;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd viewer && npx vitest run src/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add viewer/src/api.ts viewer/src/api.test.ts
git commit -m "feat(viewer): fastify search/SSE/health API"
```

---

### Task 9: Pruner loop

**Files:**
- Create: `viewer/src/pruner.ts`
- Test: `viewer/src/pruner.test.ts`

**Interfaces:**
- Consumes: `Db.prune` (Task 4), `Config.retentionDays` (Task 1).
- Produces:
  ```ts
  async function runPrune(db: Pick<Db,'prune'>, retentionDays: number | null): Promise<number>;
  function startPruner(cfg: Config, db: Db): void;   // daily setInterval; not unit-tested
  ```

- [ ] **Step 1: Write the failing test `viewer/src/pruner.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { runPrune } from './pruner';

describe('runPrune', () => {
  it('calls db.prune with the retention value and returns count', async () => {
    const db = { prune: vi.fn(async () => 7) };
    expect(await runPrune(db as any, 30)).toBe(7);
    expect(db.prune).toHaveBeenCalledWith(30);
  });
  it('passes null through (keep forever)', async () => {
    const db = { prune: vi.fn(async () => 0) };
    expect(await runPrune(db as any, null)).toBe(0);
    expect(db.prune).toHaveBeenCalledWith(null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd viewer && npx vitest run src/pruner.test.ts`
Expected: FAIL (cannot find module `./pruner`).

- [ ] **Step 3: Implement `viewer/src/pruner.ts`**

```ts
import type { Db } from './db';
import type { Config } from './config';

export async function runPrune(db: Pick<Db, 'prune'>, retentionDays: number | null): Promise<number> {
  return db.prune(retentionDays);
}

export function startPruner(cfg: Config, db: Db): void {
  const tick = async () => {
    try {
      const n = await runPrune(db, cfg.retentionDays);
      if (n > 0) console.log(`[pruner] deleted ${n} podpings older than ${cfg.retentionDays} days`);
    } catch (err) {
      console.error('[pruner] error:', err);
    }
  };
  void tick();
  setInterval(tick, 24 * 60 * 60 * 1000);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd viewer && npx vitest run src/pruner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add viewer/src/pruner.ts viewer/src/pruner.test.ts
git commit -m "feat(viewer): retention pruner"
```

---

### Task 10: Wire-up, Dockerfile, deploy docs

**Files:**
- Create: `viewer/src/index.ts`
- Create: `viewer/Dockerfile`
- Create: `viewer/.dockerignore`
- Create: `viewer/README.md`

**Interfaces:**
- Consumes: every prior module.

- [ ] **Step 1: Implement `viewer/src/index.ts`**

```ts
import { loadConfig } from './config';
import { Db } from './db';
import { startCollector } from './collector';
import { startEnricher } from './enricher';
import { startPruner } from './pruner';
import { buildServer } from './api';

async function main() {
  const cfg = loadConfig(process.env);
  const db = new Db(cfg.databaseUrl);
  await db.migrate();
  console.log('[viewer] migrated; starting workers');

  startCollector(cfg, db);
  startEnricher(cfg, db);
  startPruner(cfg, db);

  const app = buildServer({ db, corsOrigins: cfg.corsOrigins });
  await app.listen({ host: '0.0.0.0', port: cfg.port });
  console.log(`[viewer] API listening on :${cfg.port}`);
}

main().catch((err) => {
  console.error('[viewer] fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Create `viewer/.dockerignore`**

```
node_modules
dist
*.test.ts
```

- [ ] **Step 3: Create `viewer/Dockerfile`**

```dockerfile
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js"]
```

- [ ] **Step 4: Create `viewer/README.md`**

````markdown
# Podping Viewer (backend)

Standalone Railway service: tails the Hive podping firehose into Postgres,
enriches feeds via Podcast Index, and serves a search + live-SSE API.

## Railway setup
1. New service in the existing project, **root directory = `viewer/`**.
2. Add the **Postgres** plugin; Railway injects `DATABASE_URL`.
3. Set service variables:
   - `PODCASTINDEX_API_KEY`, `PODCASTINDEX_API_SECRET`
   - `RETENTION_DAYS` (optional, default 30; empty = keep forever)
   - `CORS_ORIGINS=https://musicsideproject.com,https://www.musicsideproject.com`
4. Deploy. Check logs for `[collector] streaming from block N` and `[viewer] API listening`.

## Endpoints
- `GET /api/podpings?feed=&signer=&type=&limit=&before=`
- `GET /api/podpings/stream` (SSE)
- `GET /health`

## Local dev
```bash
docker run -e POSTGRES_PASSWORD=pw -p 5433:5432 -d postgres:16
export DATABASE_URL=postgres://postgres:pw@localhost:5433/postgres
export PODCASTINDEX_API_KEY=... PODCASTINDEX_API_SECRET=...
npm install && npm run dev
```

## Tests
```bash
npm test                                   # unit tests
export TEST_DATABASE_URL=postgres://postgres:pw@localhost:5433/postgres
npm test                                   # includes db integration tests
```
````

- [ ] **Step 5: Build and run the full test suite**

Run: `cd viewer && npm run build && npx vitest run`
Expected: build succeeds; all unit tests PASS (db tests skip unless `TEST_DATABASE_URL` set).

- [ ] **Step 6: Smoke test against live Hive (manual)**

Run (with a local Postgres + real PI keys):
```bash
cd viewer && npm run build && node dist/index.js
```
Expected within ~30s: `[collector] streaming from block N`, periodic `processed N blocks`, then:
```bash
curl "http://localhost:8080/api/podpings?limit=5"      # returns recent podpings
curl http://localhost:8080/health                       # {"ok":true,"lastBlock":...}
```

- [ ] **Step 7: Commit**

```bash
git add viewer/src/index.ts viewer/Dockerfile viewer/.dockerignore viewer/README.md
git commit -m "feat(viewer): entrypoint wiring, Dockerfile, and deploy docs"
```

---

## Self-Review

**Spec coverage:**
- Full firehose (`pp_*`, any signer) → Tasks 2, 6 ✅
- 30-day configurable retention → Tasks 1, 9 ✅
- Search by feed/signer/type → Tasks 4, 8 ✅
- Enriched display (PI title/art/medium, per-feed cache) → Tasks 3, 4, 7 ✅
- Live updates (SSE) → Tasks 5, 6, 8 ✅
- Postgres storage, separate Railway service → Tasks 4, 10 ✅
- Error handling (stream drop reconnect, bad JSON skip, PI/DB resilience) → Tasks 2, 6, 7, 9 ✅
- Frontend page → **out of scope here; separate plan** (intentional split).

**Type consistency:** `PodpingRecord` (Task 2) → extended by `PodpingRow` (Task 4) → consumed by events/collector/api consistently. `FeedMeta` (Task 3) used by db/enricher consistently. `SearchParams` shared by db/api.

**Placeholder scan:** none — every step has full code and exact commands.

**Known follow-ups (not blocking):** head-mode streaming and first-deploy backfill remain out of scope per the spec; `mode: 1` is the dhive `BlockchainMode.Irreversible` enum value.
