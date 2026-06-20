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
  for (const iri of pending) {
    const meta = await deps.lookup(iri);
    await deps.db.upsertFeed(iri, meta); // meta null => marked not_found
  }
  return pending.length;
}

export function startEnricher(cfg: Config, db: Db): void {
  const lookup = (iri: string) => lookupFeed(cfg.pi, iri);
  let running = false;
  setInterval(async () => {
    if (running) return; // avoid overlap
    running = true;
    try {
      const n = await enrichBatch({ db, lookup }, 10); // ~10/tick keeps PI well under rate limits
      if (n > 0) console.log(`[enricher] enriched ${n} feeds`);
    } catch (err) {
      console.error('[enricher] batch error:', err);
    } finally {
      running = false;
    }
  }, 1500);
}
