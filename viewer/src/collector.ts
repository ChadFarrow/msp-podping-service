import { Client } from '@hiveio/dhive';
import { classifyOp } from './podping';
import type { Db, PodpingRow } from './db';
import { bus } from './events';
import type { Config } from './config';

/**
 * When a podping happened: its block's own timestamp. Hive writes it in UTC
 * with no zone suffix ("2026-08-10T03:29:03"). The clock is only the fallback
 * for a block that carries none.
 *
 * NOT the time the collector saw it. After an outage the collector replays old
 * blocks, and a clock stamp made every replayed podping look new: a month-old
 * `live` podping counted as on air for /api/live's whole window, and the pruner
 * kept it for another RETENTION_DAYS.
 */
export function blockTime(timestamp: unknown): string {
  if (typeof timestamp === 'string' && timestamp) {
    const iso = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(timestamp) ? timestamp : `${timestamp}Z`;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/**
 * The block to stream from.
 *
 * After the stored block, unless that is more than `maxCatchupBlocks` behind
 * the chain: then from near the head, and the caller logs the range skipped.
 * The viewer is a rolling cache, not an archive — it sat dead from 2026-08-10
 * to 2026-09-26, and resuming meant replaying ~1.3 M blocks, most of them older
 * than RETENTION_DAYS, before the first podping anyone could use. `null`
 * (MAX_CATCHUP_BLOCKS=0) always resumes.
 */
export function resumeFrom(
  stored: number | null,
  lastIrr: number,
  rewindBlocks: number,
  maxCatchupBlocks: number | null,
): { from: number; skipped: [number, number] | null } {
  const head = Math.max(1, lastIrr - rewindBlocks);
  if (!stored) return { from: head, skipped: null };
  if (maxCatchupBlocks !== null && lastIrr - stored > maxCatchupBlocks && head > stored + 1) {
    return { from: head, skipped: [stored + 1, head - 1] };
  }
  return { from: stored + 1, skipped: null };
}

export async function processBlock(
  block: { timestamp?: string; transaction_ids: string[]; transactions: { operations: [string, any][] }[] },
  blockNum: number,
  deps: { db: Pick<Db, 'insertPodping' | 'getFeed'>; emit: (row: PodpingRow) => void },
): Promise<number> {
  let count = 0;
  const ts = blockTime(block.timestamp);
  const txs = block.transactions ?? [];
  for (let t = 0; t < txs.length; t++) {
    const txId = block.transaction_ids[t] ?? `${blockNum}-${t}`;
    const ops = txs[t].operations ?? [];
    for (let o = 0; o < ops.length; o++) {
      const rec = classifyOp(ops[o], { txId, opIdx: o, blockNum, ts });
      if (!rec) continue;
      if (rec.iris.length === 0) continue; // skip heartbeats (pp_startup) with no feed
      const id = await deps.db.insertPodping(rec);
      if (id === null) continue;
      count++;
      let feed = null;
      for (const iri of rec.iris) {
        const f = await deps.db.getFeed(iri);
        if (f && f.title) { feed = f; break; }
      }
      deps.emit({ ...rec, id, feed });
    }
  }
  return count;
}

export function startCollector(cfg: Config, db: Db): void {
  const client = new Client(cfg.rpcNodes, { failoverThreshold: 3, timeout: 8000 });
  (async function run() {
    try {
      const props = await client.database.getDynamicGlobalProperties();
      const lastIrr = (props as any).last_irreversible_block_num as number;
      const stored = await db.lastBlock();
      const { from, skipped } = resumeFrom(stored, lastIrr, cfg.rewindBlocks, cfg.maxCatchupBlocks);
      if (skipped) {
        console.log(`[collector] last stored block ${stored} is ${lastIrr - stored!} blocks behind; `
          + `skipping ${skipped[0]}-${skipped[1]} (MAX_CATCHUP_BLOCKS=${cfg.maxCatchupBlocks})`);
      }
      console.log(`[collector] streaming from block ${from}`);
      let seen = 0;
      for await (const block of client.blockchain.getBlocks({ from, mode: 1 /* Irreversible */ })) {
        const blockNum = parseInt((block as any).block_id.slice(0, 8), 16);
        await processBlock(block as any, blockNum, { db, emit: (row) => bus.emit('podping', row) });
        if (++seen % 100 === 0) console.log(`[collector] processed ${seen} blocks, head=${blockNum}`);
      }
    } catch (err) {
      console.error('[collector] stream error, reconnecting in 5s:', err);
      setTimeout(run, 5000);
    }
  })();
}
