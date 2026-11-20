import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { formatClock, textFor } from '../shared';
import type { Subtitle, Track } from '../shared';

interface Props {
  subtitles: Subtitle[];
  duration: number;
  time: number;
  selectedId: string | null;
  track: Track;
  /** URLs of the thumbnail strip and waveform (null when the video has none) */
  stripUrl: string | null;
  waveformUrl: string | null;
  disabled?: boolean;
  onSeek: (seconds: number) => void;
  onSelect: (id: string) => void;
  /** a caption was moved or resized; `final` is false while the pointer is still dragging */
  onTiming: (id: string, start: number, end: number) => void;
}

const MIN_LENGTH = 0.2;
const LANE_HEIGHT = 44;
const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
const round3 = (n: number) => Math.round(n * 1000) / 1000;

type DragMode = 'move' | 'start' | 'end';
interface Drag { id: string; mode: DragMode; originX: number; start: number; end: number; moved: boolean; pointerId: number }

/**
 * The two synchronized timelines of the editor:
 *  - video timeline: thumbnails and audio waveform
 *  - subtitle timeline: every caption as a block with its text and times; drag a block to move it,
 *    drag its left / right edge to change the start / end. Arrow keys also work on a focused block.
 * Both share one horizontal scroll area and one playhead, so they always line up.
 */
export const TimelinePanel = memo(function TimelinePanel({ subtitles, duration, time, selectedId, track, stripUrl, waveformUrl, disabled, onSeek, onSelect, onTiming }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [viewWidth, setViewWidth] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [stripOk, setStripOk] = useState(true);
  const [waveOk, setWaveOk] = useState(true);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewWidth(Math.max(200, el.clientWidth)));
    observer.observe(el);
    setViewWidth(Math.max(200, el.clientWidth));
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setStripOk(true); }, [stripUrl]);
  useEffect(() => { setWaveOk(true); }, [waveformUrl]);

  const pps = (viewWidth / Math.max(1, duration)) * zoom; // pixels per second
  const width = Math.max(viewWidth, duration * pps);

  const { blocks, lanes } = useMemo(() => {
    const sorted = [...subtitles].sort((a, b) => a.start - b.start || a.end - b.end);
    const laneEnds: number[] = [];
    const out = sorted.map((sub) => {
      let lane = laneEnds.findIndex((end) => end <= sub.start + 0.0005);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = sub.end;
      return { sub, lane };
    });
    return { blocks: out, lanes: Math.max(1, laneEnds.length) };
  }, [subtitles]);

  const ticks = useMemo(() => {
    const step = TICK_STEPS.find((s) => s * pps >= 80) ?? TICK_STEPS[TICK_STEPS.length - 1];
    const out: number[] = [];
    for (let t = 0; t <= duration + 1e-6; t += step) out.push(round3(t));
    return out;
  }, [pps, duration]);

  // Keep the playhead visible while the video plays and the timeline is zoomed in.
  useEffect(() => {
    const el = scroller.current;
    if (!el || drag || zoom <= 1) return;
    const x = time * pps;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 30) el.scrollLeft = Math.max(0, x - el.clientWidth * 0.3);
  }, [time, pps, zoom, drag]);

  const secondsAt = useCallback((clientX: number) => {
    const el = scroller.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.min(duration, Math.max(0, (clientX - rect.left + el.scrollLeft) / pps));
  }, [duration, pps]);

  function onBackgroundClick(event: React.MouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('[data-block]')) return;
    onSeek(secondsAt(event.clientX));
  }

  // ---- dragging captions
  function begin(event: ReactPointerEvent<HTMLElement>, sub: Subtitle, mode: DragMode) {
    if (disabled || event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id: sub.id, mode, originX: event.clientX, start: sub.start, end: sub.end, moved: false, pointerId: event.pointerId });
    onSelect(sub.id);
  }

  function computeDrag(d: Drag, clientX: number): { start: number; end: number } {
    const delta = (clientX - d.originX) / pps;
    if (d.mode === 'move') {
      const length = d.end - d.start;
      const start = Math.min(Math.max(0, d.start + delta), Math.max(0, duration - length));
      return { start: round3(start), end: round3(start + length) };
    }
    if (d.mode === 'start') return { start: round3(Math.min(Math.max(0, d.start + delta), d.end - MIN_LENGTH)), end: d.end };
    return { start: d.start, end: round3(Math.max(Math.min(duration, d.end + delta), d.start + MIN_LENGTH)) };
  }

  const [preview, setPreview] = useState<{ start: number; end: number } | null>(null);
  function onMove(event: ReactPointerEvent<HTMLElement>) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.abs(event.clientX - drag.originX) < 3) return;
    if (!drag.moved) setDrag({ ...drag, moved: true });
    setPreview(computeDrag(drag, event.clientX));
  }
  function end(event: ReactPointerEvent<HTMLElement>) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.moved) {
      const result = computeDrag(drag, event.clientX);
      if (result.start !== drag.start || result.end !== drag.end) onTiming(drag.id, result.start, result.end);
    } else {
      onSeek(drag.start);
    }
    setDrag(null);
    setPreview(null);
  }

  function onKey(event: ReactKeyboardEvent<HTMLElement>, sub: Subtitle) {
    if (disabled) return;
    const step = event.shiftKey ? 0.5 : 0.1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      const dir = event.key === 'ArrowRight' ? 1 : -1;
      if (event.ctrlKey || event.metaKey) {
        // Ctrl + arrows change the END only
        onTiming(sub.id, sub.start, round3(Math.min(duration, Math.max(sub.start + MIN_LENGTH, sub.end + dir * step))));
      } else {
        const length = sub.end - sub.start;
        const start = round3(Math.min(Math.max(0, sub.start + dir * step), Math.max(0, duration - length)));
        onTiming(sub.id, start, round3(start + length));
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      onSelect(sub.id);
      onSeek(sub.start);
    }
  }

  const x = (t: number) => t * pps;

  return (
    <section className="timeline-panel" aria-label="Timelines">
      <div className="timeline-toolbar">
        <span className="small muted">Drag a caption to move it, drag its edges to retime. Focus a caption and use ←/→ (Shift = bigger step, Ctrl = end only).</span>
        <span className="row gap zoom-controls">
          <button type="button" className="btn btn-sm" onClick={() => setZoom((z) => Math.max(1, round3(z / 1.5)))} aria-label="Zoom out" disabled={zoom <= 1}>−</button>
          <input type="range" min={1} max={20} step={0.5} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Timeline zoom" className="zoom-range" />
          <button type="button" className="btn btn-sm" onClick={() => setZoom((z) => Math.min(20, round3(z * 1.5)))} aria-label="Zoom in" disabled={zoom >= 20}>+</button>
          <button type="button" className="btn btn-sm" onClick={() => setZoom(1)}>Fit</button>
        </span>
      </div>
      <div className="timeline-scroll" ref={scroller} data-testid="timeline-scroll">
        <div className="timeline-content" style={{ width }} onClick={onBackgroundClick}>
          <div className="ruler" aria-hidden="true">
            {ticks.map((t) => (
              <span key={t} className="tick" style={{ left: x(t) }}><i />{formatClock(t)}</span>
            ))}
          </div>

          <div className="track-label">Video</div>
          <div className="video-track" data-testid="video-track">
            {stripUrl && stripOk && <img className="strip" src={stripUrl} alt="" draggable={false} onError={() => setStripOk(false)} />}
            {waveformUrl && waveOk && <img className="wave" src={waveformUrl} alt="" draggable={false} onError={() => setWaveOk(false)} />}
            {!(stripUrl && stripOk) && !(waveformUrl && waveOk) && <span className="muted small track-empty">Thumbnails are not available for this video.</span>}
          </div>

          <div className="track-label">Subtitles <span className="muted">({subtitles.length})</span></div>
          <div className="subtitle-track" style={{ height: lanes * LANE_HEIGHT + 8 }} data-testid="subtitle-track">
            {blocks.map(({ sub, lane }) => {
              const live = drag?.id === sub.id && drag.moved && preview ? preview : sub;
              const selected = sub.id === selectedId;
              const text = textFor(sub, track).replace(/\s*\n\s*/g, ' ');
              return (
                <div
                  key={sub.id}
                  data-block={sub.id}
                  role="button"
                  tabIndex={0}
                  className={`cap${selected ? ' is-selected' : ''}${drag?.id === sub.id && drag.moved ? ' is-dragging' : ''}${disabled ? ' is-disabled' : ''}`}
                  style={{ left: x(live.start), width: Math.max(14, x(live.end) - x(live.start)), top: lane * LANE_HEIGHT + 4, height: LANE_HEIGHT - 6 }}
                  title={`${formatClock(live.start)} → ${formatClock(live.end)}\n${text}`}
                  aria-label={`Caption ${formatClock(live.start)} to ${formatClock(live.end)}: ${text}`}
                  onPointerDown={(e) => begin(e, sub, 'move')}
                  onPointerMove={onMove}
                  onPointerUp={end}
                  onPointerCancel={() => { setDrag(null); setPreview(null); }}
                  onKeyDown={(e) => onKey(e, sub)}
                  onFocus={() => { if (!selected) onSelect(sub.id); }}
                >
                  <span className="cap-handle cap-handle-start" onPointerDown={(e) => begin(e, sub, 'start')} onPointerMove={onMove} onPointerUp={end} aria-hidden="true" />
                  <span className="cap-time">{formatClock(live.start)}–{formatClock(live.end)}</span>
                  <span className="cap-text">{text}</span>
                  <span className="cap-handle cap-handle-end" onPointerDown={(e) => begin(e, sub, 'end')} onPointerMove={onMove} onPointerUp={end} aria-hidden="true" />
                </div>
              );
            })}
            {subtitles.length === 0 && <span className="muted small track-empty">No subtitles yet. Generate them with AI or add one at the playhead.</span>}
          </div>
          <div className="playhead-line" style={{ left: x(time) }} aria-hidden="true" data-testid="playhead" />
        </div>
      </div>
    </section>
  );
});
