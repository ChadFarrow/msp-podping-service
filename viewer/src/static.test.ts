import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { registerUi } from './static';

describe('registerUi', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-'));
  beforeAll(() => { writeFileSync(join(dir, 'index.html'), '<html>viewer</html>'); });

  it('serves index.html for a non-api route (SPA fallback)', async () => {
    const app = Fastify();
    app.get('/api/podpings', async () => ({ podpings: [] }));
    await registerUi(app, dir);
    await app.ready();
    const spa = await app.inject({ method: 'GET', url: '/anything' });
    expect(spa.body).toContain('viewer');
    const api = await app.inject({ method: 'GET', url: '/api/podpings' });
    expect(api.json()).toEqual({ podpings: [] });
    await app.close();
  });

  it('does nothing when uiDir is absent', async () => {
    const app = Fastify();
    await registerUi(app, '/no/such/dir');
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/anything' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
