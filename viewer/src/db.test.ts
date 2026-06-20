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
