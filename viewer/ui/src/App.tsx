import { useEffect, useRef, useState, useCallback } from 'react';
import { fetchPodpings, fetchMedia, openStream, type Podping, type Filters } from './api';
import { FiltersBar } from './components/Filters';
import { PodpingRow } from './components/PodpingRow';
import mspLogo from './assets/msp-logo.png';

const hasFilter = (f: Filters) => Boolean(f.feed || f.signer || f.medium);

export function App() {
  const [filters, setFilters] = useState<Filters>({});
  const [rows, setRows] = useState<Podping[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [connected, setConnected] = useState(false);
  const [media, setMedia] = useState<string[]>([]);
  const freshIds = useRef<Set<number>>(new Set());
  const rowsRef = useRef<Podping[]>([]);
  rowsRef.current = rows;

  const load = useCallback(async (reset: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const last = reset ? undefined : rowsRef.current[rowsRef.current.length - 1];
      const cursor = last ? { ts: last.ts, id: last.id } : undefined;
      const next = await fetchPodpings(filters, cursor);
      setRows((prev) => (reset ? next : [...prev, ...next]));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  // (Re)load whenever filters change.
  useEffect(() => {
    void load(true);
  }, [load]);

  // Populate the medium dropdown from whatever mediums actually exist.
  useEffect(() => {
    void fetchMedia().then(setMedia).catch(() => setMedia([]));
  }, []);

  // Live stream: prepend new podpings only when live and viewing the unfiltered firehose.
  useEffect(() => {
    if (!live) return;
    const close = openStream((p) => {
      if (hasFilter(filters)) return;
      freshIds.current.add(p.id);
      setRows((prev) => (prev.some((r) => r.id === p.id) ? prev : [p, ...prev].slice(0, 500)));
    }, setConnected);
    return close;
  }, [live, filters]);

  return (
    <div className="app">
      <header className="head">
        <div className="brand">
          <img className="logo" src={mspLogo} alt="Music Side Project" />
          <div>
            <h1>Podping Viewer</h1>
            <p className="tag">Live Hive podping firehose</p>
          </div>
        </div>
      </header>

      <FiltersBar
        value={filters}
        onChange={setFilters}
        onSearch={(feed) => setFilters(feed ? { feed } : {})}
        media={media}
        live={live}
        onToggleLive={() => setLive((v) => !v)}
        connected={connected}
      />

      {error && <div className="error">Error: {error} — <button onClick={() => load(true)}>retry</button></div>}

      <main className="list">
        {rows.map((p) => (
          <PodpingRow key={`${p.id}-${p.txId}`} p={p} fresh={freshIds.current.has(p.id)} />
        ))}
        {rows.length === 0 && !loading && !error && <div className="empty">No podpings found.</div>}
      </main>

      <div className="more">
        <button disabled={loading} onClick={() => load(false)}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      </div>
    </div>
  );
}
