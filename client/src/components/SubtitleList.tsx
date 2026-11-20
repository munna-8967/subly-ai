import { memo } from 'react';
import { formatEditableTime } from '../shared';
import type { Subtitle } from '../shared';

interface Props {
  subtitles: Subtitle[];
  total: number;
  selectedId: string | null;
  checked: Set<string>;
  activeIds: Set<string>;
  overlaps: Set<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}

export const SubtitleList = memo(function SubtitleList({ subtitles, total, selectedId, checked, activeIds, overlaps, onSelect, onToggle }: Props) {
  if (total === 0) {
    return <p className="empty">No subtitles yet. Use "Add subtitle" to create one at the playhead{' '}- or generate them with AI.</p>;
  }
  if (subtitles.length === 0) return <p className="empty">No subtitles match your search.</p>;
  return (
    <ul className="sub-list" aria-label="Subtitles">
      {subtitles.map((sub) => (
        <li key={sub.id} className={`sub-row${sub.id === selectedId ? ' is-selected' : ''}${activeIds.has(sub.id) ? ' is-active' : ''}`}>
          <input
            type="checkbox"
            checked={checked.has(sub.id)}
            onChange={() => onToggle(sub.id)}
            aria-label={`Select subtitle at ${formatEditableTime(sub.start)} for merging`}
          />
          <button type="button" className="sub-main" onClick={() => onSelect(sub.id)} aria-current={sub.id === selectedId ? 'true' : undefined}>
            <span className="sub-time">
              {formatEditableTime(sub.start)} → {formatEditableTime(sub.end)}
              {overlaps.has(sub.id) && <span className="chip chip-failed" title="Overlaps the previous subtitle">overlap</span>}
            </span>
            <span className="sub-text">{sub.text}</span>
            {sub.translation && <span className="sub-translation">{sub.translation}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
});
