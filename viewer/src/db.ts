import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PodpingRecord } from './podping';
import type { FeedMeta } from './pi';

export interface SearchParams { feed?: string; signer?: string; medium?: string; limit?: number; beforeTs?: string; beforeId?: number; }
export interface PodpingRow extends PodpingRecord {
  id: number;
  feed?: (FeedMeta & { iri: string }) | null;
}

export class Db {
  private pool: Pool;
  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async migrate(): Promise<void> {
    const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
    await this.pool.query(sql);
  }

  async insertPodping(r: PodpingRecord): Promise<number | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `INSERT INTO podpings (tx_id, op_idx, block_num, ts, signer, op_id, medium, reason, iris, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (tx_id, op_idx) DO NOTHING
         RETURNING id`,
        [r.txId, r.opIdx, r.blockNum, r.ts, r.signer, r.opId, r.medium, r.reason, r.iris, JSON.stringify(r.raw)],
      );
      if (res.rowCount === 0) { await client.query('ROLLBACK'); return null; }
      const id = Number(res.rows[0].id);
      for (const iri of r.iris) {
        await client.query('INSERT INTO podping_iris (podping_id, iri) VALUES ($1,$2)', [id, iri]);
      }
      await client.query('COMMIT');
      return id;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async searchPodpings(p: SearchParams): Promise<PodpingRow[]> {
    const limit = Math.min(p.limit ?? 50, 200);
    const where: string[] = ['cardinality(p.iris) > 0']; // hide heartbeats (pp_startup) with no feed
    const args: unknown[] = [];
    if (p.feed) {
      args.push(p.feed);
      where.push(`p.id IN (SELECT podping_id FROM podping_iris WHERE iri = $${args.length})`);
    }
    if (p.signer) { args.push(p.signer); where.push(`p.signer = $${args.length}`); }
    // Filter by the feed's ACTUAL medium (from Podcast Index enrichment), not the
    // signer-declared op_id — a podping qualifies if any of its iris is that medium.
    if (p.medium) {
      args.push(p.medium);
      where.push(`p.id IN (SELECT pim.podping_id FROM podping_iris pim JOIN feeds fm ON fm.iri = pim.iri WHERE fm.medium = $${args.length})`);
    }
    // Keyset cursor over (ts, id) so pagination matches the time ordering below.
    if (p.beforeTs && p.beforeId) {
      args.push(p.beforeTs); const tsIdx = args.length;
      args.push(p.beforeId); const idIdx = args.length;
      where.push(`(p.ts, p.id) < ($${tsIdx}, $${idIdx})`);
    }
    args.push(limit);
    const sql = `
      SELECT p.*, f.iri AS f_iri, f.pi_feed_id, f.title, f.author, f.image, f.medium AS f_medium
      FROM podpings p
      LEFT JOIN LATERAL (
        SELECT fe.* FROM podping_iris pi JOIN feeds fe ON fe.iri = pi.iri
        WHERE pi.podping_id = p.id AND fe.not_found = false LIMIT 1
      ) f ON true
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY p.ts DESC, p.id DESC
      LIMIT $${args.length}`;
    const res = await this.pool.query(sql, args);
    return res.rows.map((row) => ({
      id: Number(row.id), txId: row.tx_id, opIdx: row.op_idx, blockNum: Number(row.block_num),
      ts: row.ts instanceof Date ? row.ts.toISOString() : row.ts,
      signer: row.signer, opId: row.op_id, medium: row.medium, reason: row.reason,
      iris: row.iris, raw: row.raw,
      feed: row.f_iri ? { iri: row.f_iri, piFeedId: row.pi_feed_id == null ? null : Number(row.pi_feed_id), title: row.title, author: row.author, image: row.image, medium: row.f_medium } : null,
    }));
  }

  async irisNeedingEnrichment(limit: number): Promise<string[]> {
    // NOT EXISTS + no DISTINCT lets Postgres short-circuit at LIMIT (~50ms vs ~6s
    // for a DISTINCT anti-join over the whole podping_iris table). Overfetch and
    // dedupe in app, since the same iri can appear on multiple podpings.
    const res = await this.pool.query(
      `SELECT pi.iri FROM podping_iris pi
       WHERE NOT EXISTS (SELECT 1 FROM feeds f WHERE f.iri = pi.iri)
       LIMIT $1`, [limit * 5]);
    const seen = new Set<string>();
    for (const r of res.rows) {
      seen.add(r.iri as string);
      if (seen.size >= limit) break;
    }
    return [...seen];
  }

  async upsertFeed(iri: string, meta: FeedMeta | null): Promise<void> {
    const m = meta ?? { piFeedId: null, title: null, author: null, image: null, medium: null };
    await this.pool.query(
      `INSERT INTO feeds (iri, pi_feed_id, title, author, image, medium, last_checked, not_found)
       VALUES ($1,$2,$3,$4,$5,$6, now(), $7)
       ON CONFLICT (iri) DO UPDATE SET
         pi_feed_id = EXCLUDED.pi_feed_id, title = EXCLUDED.title, author = EXCLUDED.author,
         image = EXCLUDED.image, medium = EXCLUDED.medium, last_checked = now(), not_found = EXCLUDED.not_found`,
      [iri, m.piFeedId, m.title, m.author, m.image, m.medium, meta === null],
    );
  }

  async getFeed(iri: string): Promise<(FeedMeta & { iri: string }) | null> {
    const res = await this.pool.query('SELECT * FROM feeds WHERE iri = $1', [iri]);
    if (res.rowCount === 0) return null;
    const r = res.rows[0];
    return { iri: r.iri, piFeedId: r.pi_feed_id == null ? null : Number(r.pi_feed_id), title: r.title, author: r.author, image: r.image, medium: r.medium };
  }

  async prune(retentionDays: number | null): Promise<number> {
    if (retentionDays === null) return 0;
    const res = await this.pool.query(
      `DELETE FROM podpings WHERE ts < now() - ($1 || ' days')::interval`, [String(retentionDays)]);
    return res.rowCount ?? 0;
  }

  /** Distinct feed mediums present (from enrichment), most common first. */
  async mediums(): Promise<string[]> {
    const res = await this.pool.query(
      `SELECT medium, count(*) AS c FROM feeds
       WHERE medium IS NOT NULL AND medium <> ''
       GROUP BY medium ORDER BY c DESC, medium ASC`,
    );
    return res.rows.map((r) => r.medium as string);
  }

  async lastBlock(): Promise<number | null> {
    const res = await this.pool.query('SELECT max(block_num) AS b FROM podpings');
    return res.rows[0].b === null ? null : Number(res.rows[0].b);
  }

  async close(): Promise<void> { await this.pool.end(); }
}
