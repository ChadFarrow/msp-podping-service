import { lookupFeed, type FeedMeta } from './pi';
import type { Db } from './db';
import type { Config } from './config';

export async function enrichBatch(
  deps: {
    db: Pick<Db, 'irisNeedingEnrichment' | 'upsertFeed'>;
    lookup: (iri: string) => Promise<FeedMeta | null>;
  },
  batchSize: number,
): Promise<{ pending: number; cached: number }> {
  const pending = await deps.db.irisNeedingEnrichment(batchSize);
  // Look feeds up concurrently. lookup() returns null ONLY on a transient failure
  // (rate-limit/5xx/network) — skip those so they stay queued and get retried,
  // rather than caching them as "not found". A real 200 (even an empty feed)
  // returns a FeedMeta and is cached.
  let cached = 0;
  await Promise.all(
    pending.map(async (iri) => {
      const meta = await deps.lookup(iri);
      if (meta === null) return; // transient — leave queued for retry
      await deps.db.upsertFeed(iri, meta);
      cached++;
    }),
  );
  return { pending: pending.length, cached };
}

export function startEnricher(cfg: Config, db: Db): void {
  const lookup = (iri: string) => lookupFeed(cfg.pi, iri);
  const batch = Number(process.env.ENRICH_BATCH || 4); // concurrent lookups/tick; keep modest to stay under PI rate limits
  const baseMs = Number(process.env.ENRICH_INTERVAL_MS || 1000);
  const maxMs = Number(process.env.ENRICH_MAX_BACKOFF_MS || 5 * 60 * 1000);
  let delay = baseMs;

  // Self-scheduling loop with adaptive backoff: when every lookup fails (e.g.
  // Podcast Index temporarily blocks our IP), exponentially back off so we stop
  // hammering — and snap back to full speed the moment a lookup succeeds.
  async function tick(): Promise<void> {
    try {
      const { pending, cached } = await enrichBatch({ db, lookup }, batch);
      if (pending === 0) {
        delay = baseMs; // nothing to do; check again soon
      } else if (cached > 0) {
        if (delay !== baseMs) console.log(`[enricher] recovered, resuming full speed`);
        delay = baseMs;
        console.log(`[enricher] cached ${cached}/${pending}`);
      } else {
        delay = Math.min(delay * 2, maxMs);
        console.warn(`[enricher] 0/${pending} cached (PI likely throttling) — backing off ${Math.round(delay / 1000)}s`);
      }
    } catch (err) {
      delay = Math.min(delay * 2, maxMs);
      console.error('[enricher] batch error, backing off:', (err as Error).message);
    } finally {
      setTimeout(tick, delay);
    }
  }
  void tick();
}
