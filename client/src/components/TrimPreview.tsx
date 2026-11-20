import { useCallback, useEffect, useRef, useState } from 'react';
import { formatClock } from '../shared';

export interface TrimValue { start: number; end: number }

interface Props {
  file: File;
  /** called once the browser knows the video length (0 when it cannot read the file) */
  onDuration: (seconds: number) => void;
  value: TrimValue;
  onChange: (value: TrimValue) => void;
  duration: number;
  disabled?: boolean;
}

const MIN_LENGTH = 1;

/** Local preview of the chosen video with start/end sliders. Nothing is uploaded or changed until Continue. */
export function TrimPreview({ file, onDuration, value, onChange, duration, disabled }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [unplayable, setUnplayable] = useState(false);
  const [time, setTime] = useState(0);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    setUnplayable(false);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  // Keep playback inside the selected range.
  const onTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setTime(video.currentTime);
    if (video.currentTime >= value.end - 0.02 && !video.paused) {
      video.pause();
      video.currentTime = value.end;
    }
  }, [value.end]);

  function play() {
    const video = videoRef.current;
    if (!video) return;
    if (video.currentTime < value.start || video.currentTime >= value.end - 0.05) video.currentTime = value.start;
    void video.play().catch(() => undefined);
  }

  function setStart(start: number) {
    const clamped = Math.min(Math.max(0, start), Math.max(0, value.end - MIN_LENGTH));
    onChange({ start: round(clamped), end: value.end });
    if (videoRef.current) videoRef.current.currentTime = clamped;
  }
  function setEnd(end: number) {
    const clamped = Math.max(Math.min(duration, end), Math.min(duration, value.start + MIN_LENGTH));
    onChange({ start: value.start, end: round(clamped) });
    if (videoRef.current) videoRef.current.currentTime = Math.max(value.start, clamped - 0.5);
  }

  const selected = Math.max(0, value.end - value.start);
  const pct = (t: number) => (duration > 0 ? `${(t / duration) * 100}%` : '0%');

  return (
    <div className="trim">
      <div className="trim-video">
        {url && (
          <video
            ref={videoRef}
            src={url}
            controls
            playsInline
            preload="metadata"
            aria-label="Preview of the selected video"
            onLoadedMetadata={(e) => onDuration(e.currentTarget.duration)}
            onTimeUpdate={onTimeUpdate}
            onError={() => { setUnplayable(true); onDuration(0); }}
          />
        )}
      </div>
      {unplayable ? (
        <p className="alert alert-warning" role="status">
          Your browser cannot play this file, so it cannot be previewed or trimmed here. You can still continue: the whole video will be uploaded and the server will make it playable.
        </p>
      ) : duration > 0 ? (
        <fieldset className="trim-controls" disabled={disabled}>
          <legend className="label">Trim</legend>
          <div className="trim-bar" aria-hidden="true">
            <div className="trim-range" style={{ left: pct(value.start), width: `calc(${pct(value.end)} - ${pct(value.start)})` }} />
            <div className="trim-playhead" style={{ left: pct(time) }} />
          </div>
          <div className="grid-2">
            <div>
              <label htmlFor="trim-start">Start: {formatClock(value.start)}</label>
              <input id="trim-start" type="range" min={0} max={duration} step={0.1} value={value.start} onChange={(e) => setStart(Number(e.target.value))} />
              <button type="button" className="btn btn-sm" onClick={() => setStart(videoRef.current?.currentTime ?? 0)}>Set start to playhead</button>
            </div>
            <div>
              <label htmlFor="trim-end">End: {formatClock(value.end)}</label>
              <input id="trim-end" type="range" min={0} max={duration} step={0.1} value={value.end} onChange={(e) => setEnd(Number(e.target.value))} />
              <button type="button" className="btn btn-sm" onClick={() => setEnd(videoRef.current?.currentTime ?? duration)}>Set end to playhead</button>
            </div>
          </div>
          <div className="row between wrap gap trim-summary">
            <span className="small" data-testid="trim-summary">Keeping {formatClock(selected)} of {formatClock(duration)}</span>
            <span className="row gap">
              <button type="button" className="btn btn-sm" onClick={play}>▶ Play selection</button>
              <button type="button" className="btn btn-sm" onClick={() => { onChange({ start: 0, end: round(duration) }); }}>Reset trim</button>
            </span>
          </div>
        </fieldset>
      ) : (
        <p className="muted small">Reading the video…</p>
      )}
    </div>
  );
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Length of an audio file as the browser sees it (0 when unreadable). */
export function audioLength(file: File): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const url = URL.createObjectURL(file);
    const done = (n: number) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(n) ? n : 0);
    };
    audio.onloadedmetadata = () => done(audio.duration);
    audio.onerror = () => done(0);
    audio.src = url;
  });
}
