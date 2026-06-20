export interface Feed {
  iri: string;
  piFeedId: number | null;
  title: string | null;
  author: string | null;
  image: string | null;
  medium: string | null;
}

export interface Podping {
  id: number;
  txId: string;
  blockNum: number;
  ts: string;
  signer: string;
  opId: string;
  medium: string | null;
  reason: string | null;
  iris: string[];
  feed?: Feed | null;
}

export interface Filters {
  feed?: string;
  signer?: string;
  medium?: string;
}

export async function fetchMedia(): Promise<string[]> {
  const res = await fetch('/api/media');
  if (!res.ok) return [];
  return ((await res.json()) as { media: string[] }).media;
}

export async function fetchMspAccount(): Promise<string | null> {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return null;
    return ((await res.json()) as { mspAccount: string | null }).mspAccount;
  } catch {
    return null;
  }
}

export interface Cursor { ts: string; id: number; }

export async function fetchPodpings(filters: Filters, cursor?: Cursor, limit = 50): Promise<Podping[]> {
  const p = new URLSearchParams();
  if (filters.feed) p.set('feed', filters.feed.trim());
  if (filters.signer) p.set('signer', filters.signer.trim());
  if (filters.medium) p.set('medium', filters.medium);
  if (cursor) { p.set('beforeTs', cursor.ts); p.set('beforeId', String(cursor.id)); }
  p.set('limit', String(limit));
  const res = await fetch(`/api/podpings?${p.toString()}`);
  if (!res.ok) throw new Error(`api ${res.status}`);
  const body = (await res.json()) as { podpings: Podping[] };
  return body.podpings;
}

export function openStream(onPodping: (p: Podping) => void, onState: (ok: boolean) => void): () => void {
  const es = new EventSource('/api/podpings/stream');
  es.onmessage = (e) => {
    try {
      onPodping(JSON.parse(e.data) as Podping);
    } catch {
      /* ignore malformed frame */
    }
  };
  es.onopen = () => onState(true);
  es.onerror = () => onState(false);
  return () => es.close();
}
