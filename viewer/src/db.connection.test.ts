import { createServer, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { Db, guardCheckedOutClient } from './db';
import { flush } from './backfill';
import type { PodpingRecord } from './podping';

// A dropped connection during a query killed the whole process, because a client
// out of the pool has no 'error' listener. Ten of those used up Railway's restart
// limit, and the viewer stayed down from 2026-10-10 to 2026-10-23.
//
// This stands in for Postgres so the case runs without a database: it accepts the
// login, then destroys the socket on the first query.
function droppingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const authOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
  const readyForQuery = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    let loggedIn = false;
    sock.on('data', () => {
      if (loggedIn) {
        sock.destroy();
        return;
      }
      loggedIn = true;
      sock.write(Buffer.concat([authOk, readyForQuery]));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `postgres://x@127.0.0.1:${port}/x`,
        close: () => new Promise((done) => {
          for (const s of sockets) s.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

const rec: PodpingRecord = {
  txId: 'tx', opIdx: 0, blockNum: 1, ts: '2026-10-10T02:02:57.000Z', signer: 'chadf',
  opId: 'pp_music_update', medium: 'music', reason: 'update', iris: ['https://a/f.xml'], raw: {},
};

describe('a connection lost during a query', () => {
  let server: Awaited<ReturnType<typeof droppingServer>>;
  const uncaught = vi.fn();

  beforeEach(async () => {
    uncaught.mockClear();
    process.on('uncaughtException', uncaught);
    server = await droppingServer();
  });

  afterEach(async () => {
    process.off('uncaughtException', uncaught);
    await server.close();
  });

  // Long enough for the socket's close event, which is what used to throw.
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it('rejects insertPodping and leaves the process running', async () => {
    const db = new Db(server.url);

    await expect(db.insertPodping(rec)).rejects.toThrow(/Connection terminated/);
    await settle();

    expect(uncaught).not.toHaveBeenCalled();
    await db.close();
  });

  it('rejects backfill flush and leaves the process running', async () => {
    const pool = new Pool({ connectionString: server.url });

    await expect(flush(pool, [rec])).rejects.toThrow(/Connection terminated/);
    await settle();

    expect(uncaught).not.toHaveBeenCalled();
    await pool.end();
  });
});

describe('guardCheckedOutClient', () => {
  const client = () => new EventEmitter() as unknown as PoolClient;

  it('absorbs an error event, which would otherwise throw', () => {
    const c = client();
    guardCheckedOutClient(c);
    expect(() => c.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
  });

  // Pooled clients are reused, so a listener left behind would pile up on each insert.
  it('removes its listener when stopped', () => {
    const c = client();
    const stop = guardCheckedOutClient(c);
    expect(c.listenerCount('error')).toBe(1);
    stop();
    expect(c.listenerCount('error')).toBe(0);
  });
});
