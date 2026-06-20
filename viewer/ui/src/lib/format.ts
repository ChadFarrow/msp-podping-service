export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.round(diff / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function hostOf(iri: string): string {
  if (!iri) return '(no iri)';
  if (iri.startsWith('podcast:guid:')) return iri;
  try {
    return new URL(iri).host;
  } catch {
    return iri;
  }
}
