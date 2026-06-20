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
  media: string[];
  live: boolean;
  onToggleLive: () => void;
  connected: boolean;
}) {
  const { value, onChange, media, live, onToggleLive, connected } = props;
  return (
    <div className="filters">
      <input
        className="f-input grow"
        placeholder="Feed URL or podcast:guid:…"
        value={value.feed ?? ''}
        onChange={(e) => onChange({ ...value, feed: e.target.value || undefined })}
      />
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
      <button className={`live ${live ? 'on' : 'off'}`} onClick={onToggleLive} title="Toggle live updates">
        <span className={`dot ${connected ? 'ok' : 'bad'}`} />
        {live ? 'Live' : 'Paused'}
      </button>
    </div>
  );
}
