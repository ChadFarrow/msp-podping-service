import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { toLegacy, blockTs, flush } from './backfill';
import { Db } from './db';
import type { PodpingRecord } from './podping';

describe('toLegacy', () => {
  it('passes through legacy [type, value] arrays', () => {
    expect(toLegacy(['custom_json', { id: 'pp_x' }])).toEqual(['custom_json', { id: 'pp_x' }]);
  });
  it('converts new {type, value} op format', () => {
    expect(toLegacy({ type: 'custom_json_operation', value: { id: 'pp_music_update' } }))
      .toEqual(['custom_json', { id: 'pp_music_update' }]);
  });
});

describe('blockTs', () => {
  it('adds a Z when missing', () => {
    expect(blockTs('2026-06-20T12:00:00')).toBe('2026-06-20T12:00:00Z');
    expect(blockTs('2026-06-20T12:00:00Z')).toBe('2026-06-20T12:00:00Z');
  });
});

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

function rec(over: Partial<PodpingRecord> = {}): PodpingRecord {
  return {
    txId: 'bf-' + Math.random().toString(36).slice(2),
    opIdx: 0, blockNum: 500, ts: '2026-05-20T00:00:00Z',
    signer: 'podping.aaa', opId: 'pp_podcast_update', medium: 'podcast', reason: 'update',
    iris: ['https://bf/a.xml', 'https://bf/b.xml'], raw: { id: 'pp_podcast_update' }, ...over,
  };
}

d('flush', () => {
  let pool: Pool;
  beforeAll(async () => {
    await new Db(url!).migrate();
    pool = new Pool({ connectionString: url });
    await pool.query('TRUNCATE podpings, podping_iris, feeds RESTART IDENTITY CASCADE');
  });
  afterAll(async () => { await pool.end(); });

  it('batch-inserts podpings and their iris, and dedups', async () => {
    const recs = [rec(), rec(), rec()];
    const n1 = await flush(pool, recs);
    expect(n1).toBe(3);
    const again = await flush(pool, recs); // same tx ids -> all dedup
    expect(again).toBe(0);

    const pp = await pool.query('SELECT count(*)::int AS c FROM podpings');
    expect(pp.rows[0].c).toBe(3);
    const iris = await pool.query('SELECT count(*)::int AS c FROM podping_iris');
    expect(iris.rows[0].c).toBe(6); // 3 podpings x 2 iris
  });
});
