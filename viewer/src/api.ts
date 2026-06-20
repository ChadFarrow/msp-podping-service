import Fastify, { type FastifyInstance } from 'fastify';
import type { Db, PodpingRow, SearchParams } from './db';
import { bus, sseFrame } from './events';

export function buildServer(deps: {
  db: Pick<Db, 'searchPodpings' | 'lastBlock'>;
  corsOrigins: string[];
}): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && deps.corsOrigins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type');
      reply.code(204).send();
    }
  });

  app.get('/health', async () => ({ ok: true, lastBlock: await deps.db.lastBlock() }));

  app.get('/api/podpings', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const params: SearchParams = {
      feed: q.feed || undefined,
      signer: q.signer || undefined,
      type: q.type || undefined,
      limit: q.limit ? Number(q.limit) : undefined,
      beforeTs: q.beforeTs || undefined,
      beforeId: q.beforeId ? Number(q.beforeId) : undefined,
    };
    const podpings = await deps.db.searchPodpings(params);
    return { podpings };
  });

  app.get('/api/podpings/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...(req.headers.origin && deps.corsOrigins.includes(req.headers.origin)
        ? { 'Access-Control-Allow-Origin': req.headers.origin }
        : {}),
    });
    reply.raw.write(': connected\n\n');
    const onPodping = (row: PodpingRow) => reply.raw.write(sseFrame(row));
    bus.on('podping', onPodping);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 30000);
    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off('podping', onPodping);
    });
  });

  return app;
}
