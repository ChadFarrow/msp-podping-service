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
  // Records the backoff waits instead of sleeping.
  function sleeper() {
    const waits: number[] = [];
    return { waits, sleep: async (ms: number) => { waits.push(ms); } };
  }
  // One Response per call, in order; the last one repeats.
  function answers(...make: Array<() => Response | Promise<never>>) {
    let n = 0;
    return vi.fn(async () => make[Math.min(n++, make.length - 1)]());
  }
  const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

  it('calls byfeedurl for URL iris', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ feed: { id: 1, title: 'T', author: 'A', image: 'I', medium: 'music' } }), { status: 200 }));
    const r = await lookupFeed(pi, 'https://x/feed.xml', fetchImpl as any);
    expect(fetchImpl).toHaveBeenCalled();
    const url = (fetchImpl.mock.calls[0][0] as string);
    expect(url).toContain('/podcasts/byfeedurl');
    expect(url).toContain(encodeURIComponent('https://x/feed.xml'));
    expect(r).toEqual({ kind: 'found', meta: { piFeedId: 1, title: 'T', author: 'A', image: 'I', medium: 'music' } });
  });
  it('calls byguid for guid iris', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ feed: { id: 2 } }), { status: 200 }));
    await lookupFeed(pi, 'podcast:guid:g-1', fetchImpl as any);
    expect((fetchImpl.mock.calls[0][0] as string)).toContain('/podcasts/byguid?guid=g-1');
  });

  it('a 400 means not found, with no retry', async () => {
    // Podcast Index's real answer for a feed URL it does not know (checked 2026-11-28).
    const s = sleeper();
    const fetchImpl = answers(json({ status: 'false', description: 'Feed url not found.' }, 400));
    expect(await lookupFeed(pi, 'http://127.0.0.1:10095/feed/podcast/field-notes/', fetchImpl as any, s.sleep))
      .toEqual({ kind: 'not_found' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(s.waits).toEqual([]);
  });
  it.each([404, 410])('a %i means not found', async (status) => {
    const fetchImpl = answers(json({}, status));
    expect(await lookupFeed(pi, 'https://x/f.xml', fetchImpl as any, sleeper().sleep)).toEqual({ kind: 'not_found' });
  });
  it('a 200 with no feed (unknown guid) means not found', async () => {
    // Podcast Index's real answer for a guid it does not know (checked 2026-11-28).
    const fetchImpl = answers(json({ status: 'true', feed: [], description: 'No feeds match this guid.' }));
    expect(await lookupFeed(pi, 'podcast:guid:e678327c-d0a6-4eb7-a7cf-d7cd2620db88', fetchImpl as any, sleeper().sleep))
      .toEqual({ kind: 'not_found' });
  });

  it('retries a 429 with backoff, then returns the feed', async () => {
    const s = sleeper();
    const fetchImpl = answers(() => new Response('slow down', { status: 429 }), json({ feed: { id: 9, title: 'T' } }));
    const r = await lookupFeed(pi, 'https://x/f.xml', fetchImpl as any, s.sleep);
    expect(r.kind).toBe('found');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(s.waits).toEqual([2000]);
  });
  it('a 5xx that persists is transient after 3 tries, never not found', async () => {
    const s = sleeper();
    const fetchImpl = answers(() => new Response('nope', { status: 503 }));
    expect(await lookupFeed(pi, 'https://x/f.xml', fetchImpl as any, s.sleep)).toEqual({ kind: 'transient', reason: 'HTTP 503' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(s.waits).toEqual([2000, 8000]);
  });
  it('a 429 that persists is transient, never not found', async () => {
    const fetchImpl = answers(() => new Response('slow down', { status: 429 }));
    expect(await lookupFeed(pi, 'https://x/f.xml', fetchImpl as any, sleeper().sleep)).toEqual({ kind: 'transient', reason: 'HTTP 429' });
  });
  it('a network error or timeout is retried, then transient', async () => {
    const s = sleeper();
    const fetchImpl = answers(() => Promise.reject(new Error('ECONNRESET')));
    expect(await lookupFeed(pi, 'https://x/f.xml', fetchImpl as any, s.sleep)).toEqual({ kind: 'transient', reason: 'timeout/network' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it.each([401, 403])('a %i (our key, not the feed) is transient at once', async (status) => {
    // A bad key, secret or clock gives 401 for every feed. Marking them not found would empty the queue.
    const s = sleeper();
    const fetchImpl = answers(() => new Response('The X-Auth-Key header contains an invalid API key.', { status }));
    expect(await lookupFeed(pi, 'https://x/f.xml', fetchImpl as any, s.sleep)).toEqual({ kind: 'transient', reason: `HTTP ${status}` });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
