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
