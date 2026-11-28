import { describe, it, expect, vi } from 'vitest';
import { enrichBatch, nextDelay } from './enricher';

const META = { piFeedId: 1, title: 'A', author: null, image: null, medium: 'music' };

describe('enrichBatch', () => {
  it('caches found feeds, marks not-found feeds, and leaves transient failures queued', async () => {
    const upserts: any[] = [];
    const deps = {
      db: {
        irisNeedingEnrichment: vi.fn(async () => ['https://a/f.xml', 'http://10.0.0.1/?feed=podcast', 'podcast:guid:g1']),
        upsertFeed: vi.fn(async (iri: string, meta: any) => { upserts.push([iri, meta]); }),
      },
      lookup: vi.fn(async (iri: string) => {
        if (iri.includes('a/f')) return { kind: 'found' as const, meta: META };
        if (iri.includes('10.0.0.1')) return { kind: 'not_found' as const };
        return { kind: 'transient' as const, reason: 'HTTP 429' };
      }),
    };
    const r = await enrichBatch(deps as any, 50, 7);
    expect(r).toEqual({ pending: 3, cached: 1, notFound: 1, transient: 1, transientReason: 'HTTP 429' });
    expect(deps.db.irisNeedingEnrichment).toHaveBeenCalledWith(50, 7);
    // not found → upsertFeed(iri, null), which stores not_found = true; transient → no write.
    expect(upserts).toEqual([['https://a/f.xml', META], ['http://10.0.0.1/?feed=podcast', null]]);
  });

  it('returns 0 when nothing pending', async () => {
    const deps = {
      db: { irisNeedingEnrichment: vi.fn(async () => []), upsertFeed: vi.fn() },
      lookup: vi.fn(),
    };
    expect(await enrichBatch(deps as any, 50, 7)).toEqual({ pending: 0, cached: 0, notFound: 0, transient: 0, transientReason: null });
    expect(deps.lookup).not.toHaveBeenCalled();
  });
});

describe('nextDelay', () => {
  const base = 1000, max = 300_000;
  const r = (o: Partial<{ pending: number; cached: number; notFound: number; transient: number }>) =>
    ({ pending: 4, cached: 0, notFound: 0, transient: 0, transientReason: null, ...o });

  it('a batch of only not-found feeds is progress: full speed, no backoff', () => {
    // Before the fix this case backed off to 300 s and the queue moved 4 feeds per 5 minutes.
    expect(nextDelay(max, r({ notFound: 4 }), base, max)).toBe(base);
  });
  it('found feeds reset the delay', () => {
    expect(nextDelay(64_000, r({ cached: 1, transient: 3 }), base, max)).toBe(base);
  });
  it('an empty queue checks again at the base delay', () => {
    expect(nextDelay(64_000, r({ pending: 0 }), base, max)).toBe(base);
  });
  it('backs off exponentially, to the cap, when every lookup was transient', () => {
    expect(nextDelay(1000, r({ transient: 4 }), base, max)).toBe(2000);
    expect(nextDelay(200_000, r({ transient: 4 }), base, max)).toBe(max);
  });
});
