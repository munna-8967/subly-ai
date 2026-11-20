import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { previewCss } from '../shared';
import type { SubtitleStyle } from '../shared';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  src: string | null;
  width: number;
  height: number;
  style: SubtitleStyle;
  /** Lines to show right now (empty = nothing). Chosen from the video's current time by the parent. */
  lines: string[];
  onTime: (seconds: number) => void;
  onError: () => void;
}

/**
 * The video with the subtitle overlay on top. The overlay is sized from the displayed video
 * height with the same formula the server uses for burned-in subtitles (shared/style.js),
 * so what you see here is a close match to the rendered result.
 */
export function VideoStage({ videoRef, src, width, height, style, lines, onTime, onError }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const [stageHeight, setStageHeight] = useState(360);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setStageHeight(el.clientHeight || 360));
    observer.observe(el);
    setStageHeight(el.clientHeight || 360);
    return () => observer.disconnect();
  }, []);

  // Keep the overlay in step with the real playback position: a frame loop while playing
  // (timeupdate alone only fires about 4 times a second), plus seek/pause events.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    let last = -1;
    const tick = () => {
      if (Math.abs(video.currentTime - last) > 0.02) {
        last = video.currentTime;
        onTime(last);
      }
      if (!video.paused && !video.ended) raf = requestAnimationFrame(tick);
    };
    const sync = () => {
      last = video.currentTime;
      onTime(last);
    };
    const onPlay = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    video.addEventListener('play', onPlay);
    for (const name of ['pause', 'seeked', 'seeking', 'timeupdate', 'loadedmetadata', 'ended']) video.addEventListener(name, sync);
    if (!video.paused) onPlay();
    return () => {
      cancelAnimationFrame(raf);
      video.removeEventListener('play', onPlay);
      for (const name of ['pause', 'seeked', 'seeking', 'timeupdate', 'loadedmetadata', 'ended']) video.removeEventListener(name, sync);
    };
  }, [videoRef, onTime, src]);

  const css = previewCss(style, stageHeight);
  const vertical: React.CSSProperties =
    style.position === 'top' ? { top: css.verticalOffset } : style.position === 'middle' ? { top: '50%', transform: 'translateY(-50%)' } : { bottom: css.verticalOffset };
  const ratio = width > 0 && height > 0 ? width / height : 16 / 9;

  return (
    <div className="stage-wrap">
      <div ref={stage} className="stage" style={{ aspectRatio: `${ratio}`, width: `min(100%, calc(68vh * ${ratio}))` }}>
        {src ? (
          <video ref={videoRef} src={src} controls playsInline preload="metadata" onError={onError} aria-label="Video preview" />
        ) : (
          <div className="stage-empty">Video not available</div>
        )}
        {lines.length > 0 && (
          <div className="subtitle-layer" style={{ ...vertical, textAlign: css.textAlign as 'left' }} aria-hidden="true">
            <span
              data-testid="subtitle-overlay"
              className="subtitle-text"
              style={{
                fontFamily: css.fontFamily,
                fontSize: css.fontSize,
                color: css.color,
                fontWeight: css.fontWeight,
                fontStyle: css.fontStyle,
                textShadow: css.textShadow,
                backgroundColor: css.backgroundColor,
                padding: css.padding,
              }}
            >
              {lines.map((line, i) => (
                <span key={i}>{line}{i < lines.length - 1 && <br />}</span>
              ))}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
