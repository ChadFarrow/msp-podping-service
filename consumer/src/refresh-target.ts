/**
 * Which URL to send to stablekraft's refresh-by-url for a podping.
 *
 * A podping names a feed by URL or as `podcast:guid:<guid>`. refresh-by-url
 * needs a URL, and a guid cannot be turned into one locally (it is a UUIDv5
 * hash of the URL). stablekraft already stores the URL of every feed it knows
 * by guid, and `GET /api/feeds/exists?guid=` returns it as `url`. Before that,
 * every guid-only podping for a tracked feed was skipped.
 *
 * Pure, so it can be tested without Hive or the network.
 */

export interface ExistsAnswer {
  exists: boolean;
  /** Present on a guid lookup from a stablekraft that returns it. */
  url?: string;
}

/** Read an `/api/feeds/exists` body defensively: only http(s) URLs are kept. */
export function parseExistsBody(body: unknown): ExistsAnswer {
  const b = (body ?? {}) as { exists?: unknown; url?: unknown };
  const answer: ExistsAnswer = { exists: Boolean(b.exists) };
  if (typeof b.url === 'string' && /^https?:\/\//i.test(b.url)) answer.url = b.url;
  return answer;
}

/**
 * The URL to refresh, or null when there is nothing to refresh: the feed is not
 * tracked, or it was named by guid and stablekraft gave no URL (an older
 * stablekraft — the caller then logs the skip as before).
 */
export function refreshUrlFor(q: { url?: string; guid?: string }, answer: ExistsAnswer): string | null {
  if (!answer.exists) return null;
  if (q.url) return q.url;
  return answer.url ?? null;
}
