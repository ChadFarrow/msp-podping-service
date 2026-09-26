import { describe, it, expect, vi } from 'vitest';
import { buildServer } from './api';

function deps(rows: any[] = []) {
  return {
    db: {
      searchPodpings: vi.fn(async (_p: any) => rows),
      lastBlock: vi.fn(async () => 12345),
      mediums: vi.fn(async () => ['podcast', 'music', 'video']),
      liveFeeds: vi.fn(async (_h: number, _l: number) => [{ iri: 'https://x/live.xml', ts: '2026-09-26T00:00:00.000Z', piFeedId: 7, title: 'L', image: null, medium: 'podcast' }]),
    },
    corsOrigins: ['https://musicsideproject.com'],
    mspAccount: 'chadf',
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
    const res = await app.inject({ method: 'GET', url: '/api/podpings?feed=https://x/f.xml&signer=chadf&medium=music&limit=10&beforeTs=2026-06-20T00:00:00Z&beforeId=99' });
    expect(res.statusCode).toBe(200);
    expect(res.json().podpings).toHaveLength(1);
    expect(d.db.searchPodpings).toHaveBeenCalledWith({ feed: 'https://x/f.xml', signer: 'chadf', medium: 'music', limit: 10, beforeTs: '2026-06-20T00:00:00Z', beforeId: 99 });
    await app.close();
  });

  it('GET /api/live returns live feeds with a 24 h default window', async () => {
    const d = deps();
    const app = buildServer(d);
    const res = await app.inject({ method: 'GET', url: '/api/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json().hours).toBe(24);
    expect(res.json().feeds[0].piFeedId).toBe(7);
    expect(d.db.liveFeeds).toHaveBeenCalledWith(24, 200);
    await app.close();
  });

  it('GET /api/live clamps the window and ignores junk', async () => {
    const d = deps();
    const app = buildServer(d);
    await app.inject({ method: 'GET', url: '/api/live?hours=1000' });
    expect(d.db.liveFeeds).toHaveBeenLastCalledWith(48, 200);
    await app.inject({ method: 'GET', url: '/api/live?hours=abc' });
    expect(d.db.liveFeeds).toHaveBeenLastCalledWith(24, 200);
    await app.close();
  });

  it('sets CORS header for an allowed origin', async () => {
    const app = buildServer(deps());
    const res = await app.inject({ method: 'GET', url: '/api/podpings', headers: { origin: 'https://musicsideproject.com' } });
    expect(res.headers['access-control-allow-origin']).toBe('https://musicsideproject.com');
    await app.close();
  });

  it('GET /api/media returns the distinct mediums', async () => {
    const app = buildServer(deps());
    const res = await app.inject({ method: 'GET', url: '/api/media' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ media: ['podcast', 'music', 'video'] });
    await app.close();
  });

  it('GET /api/config returns the msp account', async () => {
    const app = buildServer(deps());
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.json()).toEqual({ mspAccount: 'chadf' });
    await app.close();
  });

  it('SSE endpoint responds with event-stream content type', async () => {
    // SSE never ends, so app.inject() would hang; use a real socket and abort.
    const app = buildServer(deps());
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as any;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/podpings/stream`, { signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    ac.abort();
    await res.body?.cancel().catch(() => {});
    await app.close();
  });
});
