import { describe, it, expect, vi } from 'vitest';
import { processBlock } from './collector';

function block() {
  return {
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
