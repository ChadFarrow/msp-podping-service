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
