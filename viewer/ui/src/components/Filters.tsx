import type { Filters } from '../api';

const TYPES = ['', 'pp_music', 'pp_podcast', 'pp_publisher', 'pp_video'];
const LABELS: Record<string, string> = {
  '': 'All types',
  pp_music: 'Music',
  pp_podcast: 'Podcast',
  pp_publisher: 'Publisher',
  pp_video: 'Video',
};

export function FiltersBar(props: {
  value: Filters;
  onChange: (f: Filters) => void;
  live: boolean;
  onToggleLive: () => void;
  connected: boolean;
}) {
  const { value, onChange, live, onToggleLive, connected } = props;
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
        value={value.type ?? ''}
        onChange={(e) => onChange({ ...value, type: e.target.value || undefined })}
      >
        {TYPES.map((t) => (
          <option key={t} value={t}>{LABELS[t]}</option>
        ))}
      </select>
      <button className={`live ${live ? 'on' : 'off'}`} onClick={onToggleLive} title="Toggle live updates">
        <span className={`dot ${connected ? 'ok' : 'bad'}`} />
        {live ? 'Live' : 'Paused'}
      </button>
    </div>
  );
}
