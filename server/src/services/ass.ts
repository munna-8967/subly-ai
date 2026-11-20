import { textFor, usableSubtitles } from '../../../shared/subtitles.js';
import type { Track } from '../../../shared/subtitles.js';
import type { Subtitle, SubtitleStyle } from '../types.ts';

/**
 * Builds an Advanced SubStation Alpha (.ass) file from the project's subtitles
 * and style. FFmpeg's `subtitles` filter (libass) burns it into the video.
 *
 * Style fields are relative (see shared/style.js), so they are converted here to
 * pixels of the actual video. The browser preview uses the same proportions, but
 * it is an approximation: fonts and text rendering differ slightly between a
 * browser and libass.
 */

/** "#rrggbb" + opacity (1 = solid) -> ASS "&HAABBGGRR" (alpha 00 = solid, FF = invisible). */
export function toAssColor(hex: string, opacity = 1): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  const alpha = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255)
    .toString(16)
    .padStart(2, '0');
  return `&H${alpha}${b}${g}${r}`.toUpperCase();
}

/** Seconds -> ASS time "H:MM:SS.cc" (centiseconds). */
export function toAssTime(seconds: number): string {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(totalCs / 360000);
  const m = Math.floor((totalCs % 360000) / 6000);
  const s = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Make user text safe inside an ASS Dialogue line. Backslashes and braces have
 * special meaning (override codes), so they are swapped for look-alike characters.
 */
export function escapeAssText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝'))
    .join('\\N');
}

const ALIGNMENT: Record<SubtitleStyle['position'], Record<SubtitleStyle['align'], number>> = {
  bottom: { left: 1, center: 2, right: 3 },
  middle: { left: 4, center: 5, right: 6 },
  top: { left: 7, center: 8, right: 9 },
};

export interface AssInput {
  subtitles: Subtitle[];
  style: SubtitleStyle;
  width: number;
  height: number;
  track: Track;
}

export function buildAss({ subtitles, style, width, height, track }: AssInput): string {
  const fontPx = Math.max(1, Math.round((style.fontSize / 100) * height));
  const boxed = style.backgroundOpacity > 0;
  const outlinePx = boxed ? Math.round(fontPx * 0.3) : Math.round(((style.outlineWidth / 100) * fontPx) * 10) / 10;
  const shadowPx = !boxed && style.shadow ? Math.max(1, Math.round(fontPx * 0.06)) : 0;
  const marginV = Math.round((style.marginV / 100) * height);
  const marginH = Math.round(width * 0.05);

  const styleLine = [
    'Default',
    style.fontFamily,
    fontPx,
    toAssColor(style.color),
    '&H000000FF',
    // With a box, OutlineColour is the box colour; otherwise it is the text outline.
    boxed ? toAssColor(style.backgroundColor, style.backgroundOpacity) : toAssColor(style.outlineColor),
    '&H80000000', // shadow colour
    style.bold ? -1 : 0,
    style.italic ? -1 : 0,
    0, 0, 100, 100, 0, 0,
    boxed ? 3 : 1,
    outlinePx,
    shadowPx,
    ALIGNMENT[style.position][style.align],
    marginH, marginH, marginV,
    1,
  ].join(',');

  const events = usableSubtitles(subtitles).map(
    (sub) =>
      `Dialogue: 0,${toAssTime(sub.start)},${toAssTime(sub.end)},Default,,0,0,0,,${escapeAssText(textFor(sub, track))}`,
  );

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${styleLine}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
