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
  type?: string;
}

export async function fetchPodpings(filters: Filters, before?: number, limit = 50): Promise<Podping[]> {
  const p = new URLSearchParams();
  if (filters.feed) p.set('feed', filters.feed.trim());
  if (filters.signer) p.set('signer', filters.signer.trim());
  if (filters.type) p.set('type', filters.type);
  if (before) p.set('before', String(before));
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
