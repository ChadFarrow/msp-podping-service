import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';

/** Serve the built UI (if present) with an SPA fallback. API routes and /health always win. */
export async function registerUi(app: FastifyInstance, uiDir: string): Promise<void> {
  if (!existsSync(uiDir)) return;
  await app.register(fastifyStatic, { root: uiDir, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url === '/health') {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
}
