import { lookupFeed, type FeedMeta } from './pi';
import type { Db } from './db';
import type { Config } from './config';

export async function enrichBatch(
  deps: {
    db: Pick<Db, 'irisNeedingEnrichment' | 'upsertFeed'>;
    lookup: (iri: string) => Promise<FeedMeta | null>;
  },
  batchSize: number,
): Promise<number> {
  const pending = await deps.db.irisNeedingEnrichment(batchSize);
  // Look feeds up concurrently. lookup() returns null ONLY on a transient failure
  // (rate-limit/5xx/network) — skip those so they stay queued and get retried,
  // rather than caching them as "not found". A real 200 (even an empty feed)
  // returns a FeedMeta and is cached.
  await Promise.all(
    pending.map(async (iri) => {
      const meta = await deps.lookup(iri);
      if (meta === null) return; // transient — leave queued for retry
      await deps.db.upsertFeed(iri, meta);
    }),
  );
  return pending.length;
}

export function startEnricher(cfg: Config, db: Db): void {
  const lookup = (iri: string) => lookupFeed(cfg.pi, iri);
  const batch = Number(process.env.ENRICH_BATCH || 8); // concurrent lookups/tick; keep modest to stay under PI rate limits
  const intervalMs = Number(process.env.ENRICH_INTERVAL_MS || 1000);
  let running = false;
  setInterval(async () => {
    if (running) return; // skip if the previous tick is still in flight
    running = true;
    try {
      const n = await enrichBatch({ db, lookup }, batch);
      if (n > 0) console.log(`[enricher] enriched ${n} feeds`);
    } catch (err) {
      console.error('[enricher] batch error:', err);
    } finally {
      running = false;
    }
  }, intervalMs);
}
