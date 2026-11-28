import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
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
  beforeAll(async () => {
    db = new Db(url!);
    await db.migrate();
    // Isolate each run: the local Postgres persists between runs (unlike a throwaway container).
    const pool = new Pool({ connectionString: url });
    await pool.query('TRUNCATE podpings, podping_iris, feeds RESTART IDENTITY CASCADE');
    await pool.end();
  });
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

  it('filters by signer', async () => {
    await db.insertPodping(rec({ signer: 'zzz_signer' }));
    const bySigner = await db.searchPodpings({ signer: 'zzz_signer' });
    expect(bySigner.length).toBeGreaterThanOrEqual(1);
    expect(bySigner.every((x) => x.signer === 'zzz_signer')).toBe(true);
  });

  it('filters by the feed medium from enrichment, not the op_id', async () => {
    // A podping the signer tagged as music, but whose feed PI classifies as video.
    await db.insertPodping(rec({ signer: 'medtest', opId: 'pp_music_update', iris: ['https://med/vid.xml'] }));
    await db.upsertFeed('https://med/vid.xml', { piFeedId: 1, title: 'V', author: null, image: null, medium: 'video' });
    const asMusic = await db.searchPodpings({ signer: 'medtest', medium: 'music' });
    expect(asMusic.length).toBe(0); // op_id says music, but real medium is video
    const asVideo = await db.searchPodpings({ signer: 'medtest', medium: 'video' });
    expect(asVideo.length).toBe(1);
  });

  it('tracks and enriches feeds', async () => {
    await db.insertPodping(rec({ iris: ['https://enrich/me.xml'] }));
    const pending = await db.irisNeedingEnrichment(50);
    expect(pending).toContain('https://enrich/me.xml');
    await db.upsertFeed('https://enrich/me.xml', { piFeedId: 7, title: 'T', author: 'A', image: 'I', medium: 'music' });
    const feed = await db.getFeed('https://enrich/me.xml');
    expect(feed?.title).toBe('T');
    expect(feed?.piFeedId).toBe(7); // BIGINT coerced to number, not "7"
    const stillPending = await db.irisNeedingEnrichment(50);
    expect(stillPending).not.toContain('https://enrich/me.xml');
  });

  it('a feed marked not_found leaves the queue, so the feeds behind it come up', async () => {
    // Production, 2026-09-30 to 2026-11-28: the queue head was feeds that Podcast
    // Index does not know (HTTP 400). They stayed pending, so the same ones came
    // back on every tick and no feed behind them was ever looked up.
    const bad = ['https://nf/a.xml', 'https://nf/b.xml', 'https://nf/c.xml'];
    await db.insertPodping(rec({ iris: bad }));
    await db.insertPodping(rec({ iris: ['https://nf/next.xml'] }));
    for (const iri of bad) await db.upsertFeed(iri, null);
    const pending = await db.irisNeedingEnrichment(50);
    for (const iri of bad) expect(pending).not.toContain(iri);
    expect(pending).toContain('https://nf/next.xml');
  });

  it('re-checks a not_found feed once the recheck window has passed', async () => {
    const iri = 'https://nf/later.xml';
    await db.insertPodping(rec({ iris: [iri] }));
    await db.upsertFeed(iri, null);
    expect(await db.irisNeedingEnrichment(50, 7)).not.toContain(iri);
    // Podcast Index may index the feed later: after the window it is pending again.
    const pool = new Pool({ connectionString: url });
    await pool.query(`UPDATE feeds SET last_checked = now() - interval '8 days' WHERE iri = $1`, [iri]);
    await pool.end();
    expect(await db.irisNeedingEnrichment(50, 7)).toContain(iri);
    // A successful re-check resolves it and removes it from the queue for good.
    await db.upsertFeed(iri, { piFeedId: 1, title: 'T', author: null, image: null, medium: 'music' });
    expect(await db.irisNeedingEnrichment(50, 0)).not.toContain(iri);
  });

  it('liveFeeds: newest live/liveEnd podping per feed decides, inside the window', async () => {
    const now = Date.now();
    const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
    const live = (iri: string, minAgo: number, opId = 'pp_podcast_live') =>
      db.insertPodping(rec({ iris: [iri], ts: at(minAgo), opId, medium: 'podcast', reason: opId.split('_').slice(2).join('_') }));
    await live('https://lf/on.xml', 30);
    await live('https://lf/ended.xml', 60);
    await live('https://lf/ended.xml', 10, 'pp_podcast_liveEnd');
    await live('https://lf/restarted.xml', 90);
    await live('https://lf/restarted.xml', 60, 'pp_podcast_liveEnd');
    await live('https://lf/restarted.xml', 5);
    await live('https://lf/old.xml', 60 * 30);
    await live('https://lf/lower.xml', 20, 'pp_podcast_liveend');
    await db.insertPodping(rec({ iris: ['https://lf/update.xml'], ts: at(1), opId: 'pp_podcast_update', reason: 'update' }));
    await db.upsertFeed('https://lf/on.xml', { piFeedId: 42, title: 'On', author: null, image: null, medium: 'podcast' });

    const rows = await db.liveFeeds(24, 200);
    const iris = rows.map((r) => r.iri).filter((i) => i.startsWith('https://lf/'));
    expect(iris).toEqual(['https://lf/restarted.xml', 'https://lf/on.xml']);
    expect(rows.find((r) => r.iri === 'https://lf/on.xml')?.piFeedId).toBe(42);
    expect(rows.find((r) => r.iri === 'https://lf/restarted.xml')?.piFeedId).toBeNull();
  });

  it('lastBlock is the highest block_num, read from an index rather than the table', async () => {
    const ts = new Date().toISOString(); // inside retention, so the prune tests below keep it
    await db.insertPodping(rec({ blockNum: 110_000_001, ts }));
    await db.insertPodping(rec({ blockNum: 110_000_000, ts }));
    expect(await db.lastBlock()).toBe(110_000_001);

    // /health and every collector (re)start run this. With no index on block_num
    // it read the whole table: 3.1 s against the 225 MB production table on
    // 2026-10-04, which shared_buffers (128 MB) cannot hold. Seq scans are off so
    // the plan says whether an index COULD answer it, whatever the table's size.
    const pool = new Pool({ connectionString: url });
    const client = await pool.connect();
    try {
      await client.query('SET enable_seqscan = off');
      const res = await client.query('EXPLAIN SELECT max(block_num) AS b FROM podpings');
      const plan = res.rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/Index (Only )?Scan.* on podpings/);
      expect(plan).not.toMatch(/Seq Scan/);
    } finally {
      client.release();
      await pool.end();
    }
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
