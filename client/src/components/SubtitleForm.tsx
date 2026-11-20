import { useEffect, useState } from 'react';
import { formatEditableTime, parseTime, roundMs, validateSubtitle } from '../shared';
import type { Subtitle } from '../shared';

export interface FormApi {
  /** Validate the form against the selected subtitle; returns the new subtitle or null (errors are shown). */
  apply: () => Subtitle | null;
  /** True when the form differs from the selected subtitle. */
  isDirty: () => boolean;
}

interface Props {
  subtitle: Subtitle | null;
  duration: number;
  time: number;
  showTranslation: boolean;
  disabled?: boolean;
  registerApi: (api: FormApi | null) => void;
  onUpdate: (sub: Subtitle) => void;
  onDelete: () => void;
  onSplit: () => void;
  onAdd: () => void;
  canMerge: boolean;
  onMerge: () => void;
}

export function SubtitleForm({ subtitle, duration, time, showTranslation, disabled, registerApi, onUpdate, onDelete, onSplit, onAdd, canMerge, onMerge }: Props) {
  const [text, setText] = useState('');
  const [translation, setTranslation] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  // Reload the fields whenever a different subtitle is selected or it changed elsewhere.
  useEffect(() => {
    setText(subtitle?.text ?? '');
    setTranslation(subtitle?.translation ?? '');
    setStart(subtitle ? formatEditableTime(subtitle.start) : '');
    setEnd(subtitle ? formatEditableTime(subtitle.end) : '');
    setErrors([]);
  }, [subtitle]);

  function build(): { sub: Subtitle | null; problems: string[] } {
    if (!subtitle) return { sub: null, problems: ['Select a subtitle first.'] };
    const s = parseTime(start);
    const e = parseTime(end);
    const problems: string[] = [];
    if (Number.isNaN(s)) problems.push('Start time is not valid. Use mm:ss.mmm, for example 01:05.250.');
    if (Number.isNaN(e)) problems.push('End time is not valid. Use mm:ss.mmm, for example 01:08.000.');
    if (problems.length) return { sub: null, problems };
    const next: Subtitle = { id: subtitle.id, start: roundMs(s), end: roundMs(e), text: text.trim() };
    if (translation.trim() !== '') next.translation = translation.trim();
    problems.push(...validateSubtitle(next, { duration }));
    return { sub: problems.length ? null : next, problems };
  }

  const dirty = () => {
    if (!subtitle) return false;
    const s = parseTime(start);
    const e = parseTime(end);
    return text.trim() !== subtitle.text || translation.trim() !== (subtitle.translation ?? '') || s !== subtitle.start || e !== subtitle.end;
  };

  const apply = () => {
    const { sub, problems } = build();
    setErrors(problems);
    return sub;
  };

  useEffect(() => {
    registerApi({ apply, isDirty: dirty });
    return () => registerApi(null);
  });

  function submit() {
    const sub = apply();
    if (sub) onUpdate(sub);
  }

  const none = !subtitle;
  return (
    <fieldset className="sub-form" disabled={disabled}>
      <legend className="sr-only">Edit subtitle</legend>
      <div className="row gap wrap">
        <button type="button" className="btn btn-sm" onClick={onAdd} title="Alt+N">+ Add subtitle</button>
        <button type="button" className="btn btn-sm" onClick={onSplit} disabled={none} title="Alt+S: split at the playhead">Split at playhead</button>
        <button type="button" className="btn btn-sm" onClick={onMerge} disabled={!canMerge} title="Tick two or more subtitles in the list">Merge selected</button>
      </div>

      <label htmlFor="sub-text">Subtitle text</label>
      <textarea
        id="sub-text"
        rows={3}
        value={text}
        disabled={none}
        maxLength={1000}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); } }}
        placeholder={none ? 'Select a subtitle in the list or timeline' : ''}
      />
      {showTranslation && (
        <>
          <label htmlFor="sub-translation">Translation</label>
          <textarea id="sub-translation" rows={2} value={translation} disabled={none} maxLength={1000} onChange={(e) => setTranslation(e.target.value)} />
        </>
      )}

      <div className="grid-2">
        <div>
          <label htmlFor="sub-start">Start time</label>
          <div className="input-group">
            <input id="sub-start" value={start} disabled={none} inputMode="decimal" onChange={(e) => setStart(e.target.value)} placeholder="00:00.000" />
            <button type="button" className="btn btn-sm" disabled={none} onClick={() => setStart(formatEditableTime(time))} title="Use the current playhead time">Playhead</button>
          </div>
        </div>
        <div>
          <label htmlFor="sub-end">End time</label>
          <div className="input-group">
            <input id="sub-end" value={end} disabled={none} inputMode="decimal" onChange={(e) => setEnd(e.target.value)} placeholder="00:03.000" />
            <button type="button" className="btn btn-sm" disabled={none} onClick={() => setEnd(formatEditableTime(time))} title="Use the current playhead time">Playhead</button>
          </div>
        </div>
      </div>

      {errors.length > 0 && (
        <ul className="field-error-list" role="alert">
          {errors.map((message) => <li key={message}>{message}</li>)}
        </ul>
      )}

      <div className="row gap">
        <button type="button" className="btn btn-primary" onClick={submit} disabled={none}>Update subtitle</button>
        <button type="button" className="btn btn-ghost-danger" onClick={onDelete} disabled={none}>Delete subtitle</button>
      </div>
    </fieldset>
  );
}
