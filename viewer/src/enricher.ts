import { lookupFeed, type LookupResult } from './pi';
import type { Db } from './db';
import type { Config } from './config';

export interface BatchResult {
  pending: number;
  /** Found in Podcast Index and stored. */
  cached: number;
  /** Podcast Index does not know the feed; stored as not_found, so the queue goes on. */
  notFound: number;
  /** Rate limit, 5xx, network or credentials; left queued, nothing stored. */
  transient: number;
  /** The reason of one transient failure in the batch, for the log. */
  transientReason: string | null;
}

export async function enrichBatch(
  deps: {
    db: Pick<Db, 'irisNeedingEnrichment' | 'upsertFeed'>;
    lookup: (iri: string) => Promise<LookupResult>;
  },
  batchSize: number,
  notFoundRecheckDays: number,
): Promise<BatchResult> {
  const pending = await deps.db.irisNeedingEnrichment(batchSize, notFoundRecheckDays);
  const r: BatchResult = { pending: pending.length, cached: 0, notFound: 0, transient: 0, transientReason: null };
  // Look feeds up concurrently. A found feed is cached. A not-found feed is stored
  // as not_found (upsertFeed with null), which takes it out of the queue until the
  // recheck window passes. A transient failure stores nothing, so it stays queued.
  await Promise.all(
    pending.map(async (iri) => {
      const res = await deps.lookup(iri);
      if (res.kind === 'transient') {
        r.transient++;
        r.transientReason = res.reason;
        return;
      }
      if (res.kind === 'found') {
        await deps.db.upsertFeed(iri, res.meta);
        r.cached++;
      } else {
        await deps.db.upsertFeed(iri, null);
        r.notFound++;
      }
    }),
  );
  return r;
}

/**
 * The wait before the next batch. Any stored answer (found or not found) is progress
 * and resets to full speed; only a batch in which every lookup failed transiently
 * (e.g. Podcast Index throttles or blocks us) backs off, exponentially, to the cap.
 */
export function nextDelay(prev: number, r: BatchResult, baseMs: number, maxMs: number): number {
  if (r.pending === 0 || r.cached + r.notFound > 0) return baseMs;
  return Math.min(prev * 2, maxMs);
}

export function startEnricher(cfg: Config, db: Db): void {
  const lookup = (iri: string) => lookupFeed(cfg.pi, iri);
  const batch = Number(process.env.ENRICH_BATCH || 4); // concurrent lookups/tick; keep modest to stay under PI rate limits
  const baseMs = Number(process.env.ENRICH_INTERVAL_MS || 1000);
  const maxMs = Number(process.env.ENRICH_MAX_BACKOFF_MS || 5 * 60 * 1000);
  const recheckDays = Number(process.env.ENRICH_NOT_FOUND_RECHECK_DAYS || 7);
  let delay = baseMs;

  // Self-scheduling loop with adaptive backoff (see nextDelay).
  async function tick(): Promise<void> {
    try {
      const r = await enrichBatch({ db, lookup }, batch, recheckDays);
      const prev = delay;
      delay = nextDelay(delay, r, baseMs, maxMs);
      if (r.pending === 0) return;
      if (r.cached + r.notFound > 0) {
        if (prev !== baseMs) console.log(`[enricher] recovered, resuming full speed`);
        console.log(`[enricher] cached ${r.cached}/${r.pending}, not found ${r.notFound}, transient ${r.transient}`);
      } else {
        console.warn(`[enricher] 0/${r.pending} resolved (${r.transientReason}) — backing off ${Math.round(delay / 1000)}s`);
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
