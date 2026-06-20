import { Client } from '@hiveio/dhive';
import { classifyOp } from './podping';
import type { Db, PodpingRow } from './db';
import { bus } from './events';
import type { Config } from './config';

export async function processBlock(
  block: { transaction_ids: string[]; transactions: { operations: [string, any][] }[] },
  blockNum: number,
  deps: { db: Pick<Db, 'insertPodping' | 'getFeed'>; emit: (row: PodpingRow) => void },
): Promise<number> {
  let count = 0;
  const ts = new Date().toISOString();
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
      const from = stored ? stored + 1 : Math.max(1, lastIrr - cfg.rewindBlocks);
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
