import { describe, it, expect, vi } from 'vitest';
import { blockTime, processBlock, resumeFrom } from './collector';

function block(timestamp?: string) {
  return {
    ...(timestamp === undefined ? {} : { timestamp }),
    transaction_ids: ['txA', 'txB'],
    transactions: [
      { operations: [['custom_json', { id: 'pp_music_update', json: '{"iris":["https://a/f.xml"]}', required_posting_auths: ['chadf'] }]] },
      { operations: [['transfer', {}], ['custom_json', { id: 'not_pp', json: '{}' }]] },
      { operations: [['custom_json', { id: 'pp_startup', json: '{}', required_posting_auths: ['chadf'] }]] },
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

describe('processBlock timestamps', () => {
  const deps = (inserted: any[]) => ({
    db: {
      insertPodping: vi.fn(async (r: any) => { inserted.push(r); return inserted.length; }),
      getFeed: vi.fn(async () => null),
    },
    emit: () => {},
  });

  // A replayed block must keep the time it happened. Stamped with the clock, a
  // month-old `live` podping counted as on air for /api/live's whole window.
  it('stamps each podping with its BLOCK time, not the clock', async () => {
    const inserted: any[] = [];
    await processBlock(block('2026-08-10T03:29:03') as any, 1, deps(inserted) as any);
    expect(inserted[0].ts).toBe('2026-08-10T03:29:03.000Z');
  });

  it('falls back to the clock for a block with no timestamp', async () => {
    const inserted: any[] = [];
    const before = Date.now();
    await processBlock(block() as any, 1, deps(inserted) as any);
    const t = Date.parse(inserted[0].ts);
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('blockTime', () => {
  it('reads Hive\'s zone-less timestamp as UTC', () => {
    expect(blockTime('2026-09-26T01:02:03')).toBe('2026-09-26T01:02:03.000Z');
  });
  it('keeps an explicit zone', () => {
    expect(blockTime('2026-09-26T01:02:03Z')).toBe('2026-09-26T01:02:03.000Z');
  });
  it('falls back to the clock for junk', () => {
    expect(Number.isNaN(Date.parse(blockTime('not a time')))).toBe(false);
    expect(Number.isNaN(Date.parse(blockTime(undefined)))).toBe(false);
  });
});

describe('resumeFrom', () => {
  it('starts near the head with nothing stored', () => {
    expect(resumeFrom(null, 10_000, 200, 28_800)).toEqual({ from: 9_800, skipped: null });
  });
  it('resumes after the stored block inside the catch-up limit', () => {
    expect(resumeFrom(9_000, 10_000, 200, 28_800)).toEqual({ from: 9_001, skipped: null });
  });
  // The viewer sat dead from 2026-08-10 to 2026-09-26, ~1.3 M blocks behind.
  it('skips to the head when the stored block is past the limit, and says what it skipped', () => {
    expect(resumeFrom(1_000, 100_000, 200, 28_800)).toEqual({ from: 99_800, skipped: [1_001, 99_799] });
  });
  it('never skips with no limit (MAX_CATCHUP_BLOCKS=0)', () => {
    expect(resumeFrom(1_000, 100_000, 200, null)).toEqual({ from: 1_001, skipped: null });
  });
  it('does not move backwards when the rewind reaches past the stored block', () => {
    expect(resumeFrom(9_950, 10_000, 200, 10)).toEqual({ from: 9_951, skipped: null });
  });
  it('never returns a block below 1', () => {
    expect(resumeFrom(null, 50, 200, 28_800)).toEqual({ from: 1, skipped: null });
  });
});
