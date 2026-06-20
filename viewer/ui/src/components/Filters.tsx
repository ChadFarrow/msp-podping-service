import { useState, useEffect } from 'react';
import type { Filters } from '../api';

/** "musicL" -> "Music list", "music" -> "Music" */
function label(medium: string): string {
  const base = medium.endsWith('L') ? medium.slice(0, -1) : medium;
  const pretty = base.charAt(0).toUpperCase() + base.slice(1);
  return medium.endsWith('L') ? `${pretty} list` : pretty;
}

export function FiltersBar(props: {
  value: Filters;
  onChange: (f: Filters) => void;
  onSearch: (feed: string) => void;
  media: string[];
  mspAccount: string | null;
  live: boolean;
  onToggleLive: () => void;
  connected: boolean;
}) {
  const { value, onChange, onSearch, media, mspAccount, live, onToggleLive, connected } = props;
  const [feedInput, setFeedInput] = useState(value.feed ?? '');
  const mspActive = Boolean(mspAccount) && value.signer === mspAccount;

  // Keep the box in sync when filters are cleared/changed elsewhere.
  useEffect(() => { setFeedInput(value.feed ?? ''); }, [value.feed]);

  return (
    <div className="filters">
      <div className="search-group">
        <input
          className="f-input grow"
          placeholder="Feed URL or podcast:guid:…"
          value={feedInput}
          onChange={(e) => setFeedInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSearch(feedInput.trim()); }}
        />
        <button className="search-btn" onClick={() => onSearch(feedInput.trim())}>Search</button>
      </div>
      <input
        className="f-input"
        placeholder="Signer (e.g. chadf)"
        value={value.signer ?? ''}
        onChange={(e) => onChange({ ...value, signer: e.target.value || undefined })}
      />
      <select
        className="f-input"
        value={value.medium ?? ''}
        onChange={(e) => onChange({ ...value, medium: e.target.value || undefined })}
      >
        <option value="">All media</option>
        {media.map((m) => (
          <option key={m} value={m}>{label(m)}</option>
        ))}
      </select>
      {mspAccount && (
        <button
          className={`msp-btn ${mspActive ? 'on' : ''}`}
          onClick={() => onChange({ ...value, signer: mspActive ? undefined : mspAccount })}
          title={`Show only podpings signed by @${mspAccount}`}
        >
          MSP only
        </button>
      )}
      <button className={`live ${live ? 'on' : 'off'}`} onClick={onToggleLive} title="Toggle live updates">
        <span className={`dot ${connected ? 'ok' : 'bad'}`} />
        {live ? 'Live' : 'Paused'}
      </button>
    </div>
  );
}
