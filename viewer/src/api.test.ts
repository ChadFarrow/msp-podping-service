import { describe, it, expect, vi } from 'vitest';
import { buildServer } from './api';

function deps(rows: any[] = []) {
  return {
    db: {
      searchPodpings: vi.fn(async (_p: any) => rows),
      lastBlock: vi.fn(async () => 12345),
    },
    corsOrigins: ['https://musicsideproject.com'],
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
    const res = await app.inject({ method: 'GET', url: '/api/podpings?feed=https://x/f.xml&signer=chadf&type=pp_music&limit=10&before=99' });
    expect(res.statusCode).toBe(200);
    expect(res.json().podpings).toHaveLength(1);
    expect(d.db.searchPodpings).toHaveBeenCalledWith({ feed: 'https://x/f.xml', signer: 'chadf', type: 'pp_music', limit: 10, before: 99 });
    await app.close();
  });

  it('sets CORS header for an allowed origin', async () => {
    const app = buildServer(deps());
    const res = await app.inject({ method: 'GET', url: '/api/podpings', headers: { origin: 'https://musicsideproject.com' } });
    expect(res.headers['access-control-allow-origin']).toBe('https://musicsideproject.com');
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
