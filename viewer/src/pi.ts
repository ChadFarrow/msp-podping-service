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

export function mapPiFeed(body: any): FeedMeta {
  const feed = body?.feed;
  if (!feed || Array.isArray(feed) || typeof feed !== 'object') return { ...NOT_FOUND };
  return {
    piFeedId: typeof feed.id === 'number' ? feed.id : null,
    title: feed.title ?? null,
    author: feed.author ?? null,
    image: feed.image ?? null,
    medium: feed.medium ?? null,
  };
}

export async function lookupFeed(
  pi: { key: string; secret: string; userAgent: string },
  iri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FeedMeta | null> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const headers = buildAuthHeaders(pi, nowSeconds);
  const url = isGuidIri(iri)
    ? `${API}/podcasts/byguid?guid=${encodeURIComponent(guidFromIri(iri))}`
    : `${API}/podcasts/byfeedurl?url=${encodeURIComponent(iri)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers });
  } catch {
    return null;
  }
  if (res.status !== 200) return null;
  try {
    return mapPiFeed(await res.json());
  } catch {
    return null;
  }
}
