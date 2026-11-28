import { createHash } from 'node:crypto';

export interface FeedMeta {
  piFeedId: number | null;
  title: string | null;
  author: string | null;
  image: string | null;
  medium: string | null;
}

const API = 'https://api.podcastindex.org/api/1.0';
const NOT_FOUND: FeedMeta = { piFeedId: null, title: null, author: null, image: null, medium: null };

// Sampled diagnostic logging so we can see WHY lookups fail (429 vs timeout)
// without spamming a line per request.
let _piLogN = 0;
function piSample(msg: string): void {
  if (_piLogN++ % 25 === 0) console.warn(msg);
}

export function buildAuthHeaders(
  pi: { key: string; secret: string; userAgent: string },
  nowSeconds: number,
): Record<string, string> {
  const date = String(nowSeconds);
  const authorization = createHash('sha1').update(pi.key + pi.secret + date).digest('hex');
  return {
    'X-Auth-Key': pi.key,
    'X-Auth-Date': date,
    Authorization: authorization,
    'User-Agent': pi.userAgent,
  };
}

export function isGuidIri(iri: string): boolean {
  return iri.startsWith('podcast:guid:');
}

export function guidFromIri(iri: string): string {
  return iri.slice('podcast:guid:'.length);
}

/** True when a Podcast Index answer holds a feed object (an unknown guid gives `feed: []`). */
function hasFeed(body: any): boolean {
  const feed = body?.feed;
  return !!feed && !Array.isArray(feed) && typeof feed === 'object';
}

export function mapPiFeed(body: any): FeedMeta {
  if (!hasFeed(body)) return { ...NOT_FOUND };
  const feed = body.feed;
  return {
    piFeedId: typeof feed.id === 'number' ? feed.id : null,
    title: feed.title ?? null,
    author: feed.author ?? null,
    image: feed.image ?? null,
    medium: feed.medium ?? null,
  };
}

/**
 * - `found`: Podcast Index returned the feed.
 * - `not_found`: Podcast Index does not know the feed. The enricher stores that, and the
 *   queue goes on; the feed is checked again after a recheck window.
 * - `transient`: rate limit, server error, network, or our own credentials. The feed stays
 *   queued, and nothing is stored.
 */
export type LookupResult =
  | { kind: 'found'; meta: FeedMeta }
  | { kind: 'not_found' }
  | { kind: 'transient'; reason: string };

/** Waits before the 2nd and the 3rd try of a 429, a 5xx, a timeout or a network error. */
export const RETRY_DELAYS_MS = [2000, 8000];

/**
 * What a non-200 status means for one feed. Podcast Index's answers, checked 2026-11-28:
 * an unknown feed URL gives 400 {"status":"false","description":"Feed url not found."},
 * an unknown guid gives 200 with `feed: []`, and a bad key, secret or X-Auth-Date gives 401.
 * So a 4xx is about this request, except 401/403 (our credentials: true for every feed,
 * so never "not found") and 408/429 (try again later).
 */
function classifyStatus(status: number): 'retry' | 'auth' | 'not_found' | 'other' {
  if (status === 429 || status === 408 || status >= 500) return 'retry';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 400) return 'not_found';
  return 'other';
}

/** Free the connection of a response whose body we do not read. */
function discard(res: Response): void {
  res.body?.cancel().catch(() => {});
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function lookupFeed(
  pi: { key: string; secret: string; userAgent: string },
  iri: string,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<LookupResult> {
  const url = isGuidIri(iri)
    ? `${API}/podcasts/byguid?guid=${encodeURIComponent(guidFromIri(iri))}`
    : `${API}/podcasts/byfeedurl?url=${encodeURIComponent(iri)}`;
  let reason = '';
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    const headers = buildAuthHeaders(pi, Math.floor(Date.now() / 1000));
    let res: Response;
    try {
      // Without a timeout a single hung connection never settles, which would
      // deadlock the enricher's Promise.all and stop all enrichment.
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(8000) });
    } catch {
      reason = 'timeout/network';
      continue;
    }
    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        reason = 'bad JSON';
        continue;
      }
      return hasFeed(body) ? { kind: 'found', meta: mapPiFeed(body) } : { kind: 'not_found' };
    }
    discard(res);
    reason = `HTTP ${res.status}`;
    const what = classifyStatus(res.status);
    if (what === 'not_found') return { kind: 'not_found' };
    if (what === 'retry') continue;
    // 'auth' or an unexpected status: a retry in a few seconds does not help.
    break;
  }
  piSample(`[pi] lookup failed: ${reason}`);
  return { kind: 'transient', reason };
}
