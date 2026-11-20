import { ALIGNMENTS, FONT_FAMILIES, POSITIONS, PRESETS, STYLE_LIMITS, applyPreset, matchingPreset } from '../shared';
import type { SubtitleStyle } from '../shared';

interface Props {
  style: SubtitleStyle;
  disabled?: boolean;
  onChange: (next: SubtitleStyle, group: string) => void;
  onReset: () => void;
}

export function StylePanel({ style, disabled, onChange, onReset }: Props) {
  const set = <K extends keyof SubtitleStyle>(key: K, value: SubtitleStyle[K]) => onChange({ ...style, [key]: value }, `style-${String(key)}`);
  const num = (key: 'fontSize' | 'marginV' | 'backgroundOpacity' | 'outlineWidth') => (e: React.ChangeEvent<HTMLInputElement>) => set(key, Number(e.target.value));
  return (
    <fieldset className="style-panel" disabled={disabled}>
      <legend className="sr-only">Subtitle style</legend>
      <div className="presets" role="group" aria-label="Style presets">
        {PRESETS.map((preset) => {
          const full = applyPreset(preset.id);
          const on = matchingPreset(style) === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              className={`preset${on ? ' is-on' : ''}`}
              aria-pressed={on}
              data-testid={`preset-${preset.id}`}
              onClick={() => onChange(full, 'style-preset')}
            >
              <span
                className="preset-sample"
                style={{
                  fontFamily: full.fontFamily,
                  fontWeight: full.bold ? 700 : 400,
                  fontStyle: full.italic ? 'italic' : 'normal',
                  color: full.color,
                  backgroundColor: full.backgroundOpacity > 0 ? full.backgroundColor : 'transparent',
                  textShadow: full.backgroundOpacity > 0 ? 'none' : `0 0 3px ${full.outlineColor}, 1px 1px 2px ${full.outlineColor}`,
                }}
              >
                Aa
              </span>
              <span className="preset-name">{preset.label}</span>
            </button>
          );
        })}
      </div>
      <div className="grid-2">
        <div>
          <label htmlFor="st-font">Font</label>
          <select id="st-font" value={style.fontFamily} onChange={(e) => set('fontFamily', e.target.value)}>
            {FONT_FAMILIES.map((f) => <option key={f}>{f}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="st-size">Size ({style.fontSize}% of video height)</label>
          <input id="st-size" type="range" min={STYLE_LIMITS.fontSize.min} max={STYLE_LIMITS.fontSize.max} step={0.5} value={style.fontSize} onChange={num('fontSize')} />
        </div>
        <div>
          <label htmlFor="st-color">Text color</label>
          <input id="st-color" type="color" value={style.color} onChange={(e) => set('color', e.target.value)} />
        </div>
        <div className="check-row">
          <label className="check"><input type="checkbox" checked={style.bold} onChange={(e) => set('bold', e.target.checked)} /> Bold</label>
          <label className="check"><input type="checkbox" checked={style.italic} onChange={(e) => set('italic', e.target.checked)} /> Italic</label>
        </div>
        <div>
          <span className="label">Alignment</span>
          <div className="segmented" role="radiogroup" aria-label="Alignment">
            {ALIGNMENTS.map((a) => (
              <label key={a} className={style.align === a ? 'on' : ''}>
                <input type="radio" name="align" value={a} checked={style.align === a} onChange={() => set('align', a as SubtitleStyle['align'])} />
                {a[0].toUpperCase() + a.slice(1)}
              </label>
            ))}
          </div>
        </div>
        <div>
          <span className="label">Position</span>
          <div className="segmented" role="radiogroup" aria-label="Position">
            {POSITIONS.map((p) => (
              <label key={p} className={style.position === p ? 'on' : ''}>
                <input type="radio" name="position" value={p} checked={style.position === p} onChange={() => set('position', p as SubtitleStyle['position'])} />
                {p[0].toUpperCase() + p.slice(1)}
              </label>
            ))}
          </div>
        </div>
        {style.position !== 'middle' && (
          <div>
            <label htmlFor="st-margin">Distance from edge ({style.marginV}%)</label>
            <input id="st-margin" type="range" min={STYLE_LIMITS.marginV.min} max={STYLE_LIMITS.marginV.max} step={1} value={style.marginV} onChange={num('marginV')} />
          </div>
        )}
        <div>
          <label htmlFor="st-bg">Background color</label>
          <input id="st-bg" type="color" value={style.backgroundColor} onChange={(e) => set('backgroundColor', e.target.value)} />
        </div>
        <div>
          <label htmlFor="st-bgo">Background opacity ({Math.round(style.backgroundOpacity * 100)}%)</label>
          <input id="st-bgo" type="range" min={0} max={1} step={0.05} value={style.backgroundOpacity} onChange={num('backgroundOpacity')} />
        </div>
        <div>
          <label htmlFor="st-outc">Outline color</label>
          <input id="st-outc" type="color" value={style.outlineColor} onChange={(e) => set('outlineColor', e.target.value)} />
        </div>
        <div>
          <label htmlFor="st-outw">Outline width ({style.outlineWidth}%)</label>
          <input id="st-outw" type="range" min={STYLE_LIMITS.outlineWidth.min} max={STYLE_LIMITS.outlineWidth.max} step={1} value={style.outlineWidth} onChange={num('outlineWidth')} />
        </div>
        <div className="check-row">
          <label className="check"><input type="checkbox" checked={style.shadow} onChange={(e) => set('shadow', e.target.checked)} /> Shadow</label>
        </div>
      </div>
      <p className="muted small">
        The outline and shadow apply when there is no background box. Burned-in videos use fonts installed on the server, so a font may fall back to a similar one.
      </p>
      <button type="button" className="btn btn-sm" onClick={onReset}>Reset style</button>
    </fieldset>
  );
}
