import { Client } from '@hiveio/dhive';
import { Pool } from 'pg';
import { classifyOp, type PodpingRecord } from './podping';

const DEFAULT_RPC = [
  'https://api.hive.blog',
  'https://api.deathwing.me',
  'https://hive-api.arcange.eu',
];

const BLOCKS_PER_DAY = 28800; // 3s blocks
const RANGE = 100; // blocks fetched per get_block_range call
const BATCH = 500; // podpings per DB flush

/** Normalize an op to the legacy [type, value] shape classifyOp expects. */
export function toLegacy(op: any): [string, any] {
  if (Array.isArray(op)) return op as [string, any];
  return [String(op.type).replace(/_operation$/, ''), op.value];
}

/** Block timestamps from Hive are UTC without a zone suffix; make them explicit. */
export function blockTs(ts: string): string {
  return ts.endsWith('Z') ? ts : ts + 'Z';
}

/** Batch-insert podpings + their iris. Dedups via ON CONFLICT. Returns count newly inserted. */
export async function flush(pool: Pool, recs: PodpingRecord[]): Promise<number> {
  if (recs.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cols = 10;
    const values: unknown[] = [];
    const tuples = recs.map((r, idx) => {
      const b = idx * cols;
      values.push(r.txId, r.opIdx, r.blockNum, r.ts, r.signer, r.opId, r.medium, r.reason, r.iris, JSON.stringify(r.raw));
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`;
    });
    const ins = await client.query(
      `INSERT INTO podpings (tx_id, op_idx, block_num, ts, signer, op_id, medium, reason, iris, raw)
       VALUES ${tuples.join(',')}
       ON CONFLICT (tx_id, op_idx) DO NOTHING
       RETURNING id, tx_id, op_idx`,
      values,
    );
    const byKey = new Map(recs.map((r) => [`${r.txId}|${r.opIdx}`, r]));
    const iriVals: unknown[] = [];
    const iriTuples: string[] = [];
    let k = 0;
    for (const row of ins.rows) {
      const r = byKey.get(`${row.tx_id}|${row.op_idx}`);
      if (!r) continue;
      for (const iri of r.iris) {
        iriVals.push(Number(row.id), iri);
        iriTuples.push(`($${k * 2 + 1},$${k * 2 + 2})`);
        k++;
      }
    }
    if (iriTuples.length) {
      await client.query(`INSERT INTO podping_iris (podping_id, iri) VALUES ${iriTuples.join(',')}`, iriVals);
    }
    await client.query('COMMIT');
    return ins.rowCount ?? 0;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing DATABASE_URL');
  const rpc = (process.env.HIVE_RPC_NODES || DEFAULT_RPC.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const days = Number(process.env.BACKFILL_DAYS || 30);

  const pool = new Pool({ connectionString: databaseUrl });
  const client = new Client(rpc, { failoverThreshold: 3, timeout: 12000 });

  const props = await client.database.getDynamicGlobalProperties();
  const head = (props as any).last_irreversible_block_num as number;
  const start = process.env.BACKFILL_FROM
    ? Number(process.env.BACKFILL_FROM)
    : Math.max(1, head - days * BLOCKS_PER_DAY);
  console.log(`[backfill] from ${start} to ${head} (${head - start} blocks, ~${days}d)`);

  let buffer: PodpingRecord[] = [];
  let inserted = 0;
  let scanned = 0;
  let lastLog = 0;

  for (let from = start; from <= head; from += RANGE) {
    const count = Math.min(RANGE, head - from + 1);
    let res: any;
    try {
      res = await client.call('block_api', 'get_block_range', { starting_block_num: from, count });
    } catch (err) {
      console.error(`[backfill] fetch error at ${from}, retrying in 3s:`, (err as Error).message);
      await new Promise((r) => setTimeout(r, 3000));
      from -= RANGE; // retry this range
      continue;
    }
    const blocks = res?.blocks ?? [];
    for (let i = 0; i < blocks.length; i++) {
      const blk = blocks[i];
      const blockNum = from + i;
      const ts = blockTs(blk.timestamp);
      const txIds: string[] = blk.transaction_ids ?? [];
      const txs = blk.transactions ?? [];
      for (let t = 0; t < txs.length; t++) {
        const ops = txs[t].operations ?? [];
        for (let o = 0; o < ops.length; o++) {
          const rec = classifyOp(toLegacy(ops[o]), { txId: txIds[t] ?? `${blockNum}-${t}`, opIdx: o, blockNum, ts });
          if (rec && rec.iris.length > 0) buffer.push(rec); // skip empty-iris heartbeats
        }
      }
      scanned++;
    }
    if (buffer.length >= BATCH) {
      inserted += await flush(pool, buffer);
      buffer = [];
    }
    if (scanned - lastLog >= 5000) {
      lastLog = scanned;
      console.log(`[backfill] scanned ${scanned} blocks (at ${from}), inserted ${inserted} podpings`);
    }
  }
  if (buffer.length) inserted += await flush(pool, buffer);
  console.log(`[backfill] DONE: scanned ${scanned} blocks, inserted ${inserted} podpings`);
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[backfill] fatal:', err);
    process.exit(1);
  });
}
