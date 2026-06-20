import type { Podping } from '../api';
import { relativeTime, hostOf } from '../lib/format';

function mediumClass(medium: string | null): string {
  return `m-${medium ?? 'other'}`;
}

export function PodpingRow({ p, fresh }: { p: Podping; fresh?: boolean }) {
  const title = p.feed?.title || hostOf(p.iris[0] ?? '');
  return (
    <div className={`row ${fresh ? 'fresh' : ''}`}>
      <div className="art">
        {p.feed?.image ? (
          <img src={p.feed.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <div className="art-ph" aria-hidden>♪</div>
        )}
      </div>
      <div className="meta">
        <div className="title">
          {title}
          {p.feed?.author && <span className="author"> · {p.feed.author}</span>}
        </div>
        <div className="sub">
          <span className={`badge ${mediumClass(p.medium)}`}>{p.opId}</span>
          <span className="signer">@{p.signer}</span>
          <span className="time">{relativeTime(p.ts)}</span>
          <span className="block">#{p.blockNum.toLocaleString()}</span>
        </div>
        <div className="iris">
          {p.iris.map((iri) =>
            iri.startsWith('http') ? (
              <a key={iri} href={iri} target="_blank" rel="noreferrer">{iri}</a>
            ) : (
              <span key={iri}>{iri}</span>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
