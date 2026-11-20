import { createId, roundMs } from '../../../shared/subtitles.js';
import type { Subtitle } from '../types.ts';

export interface RawSegment {
  start: number;
  end: number;
  text: string;
}

export interface SegmentOptions {
  /** longest allowed subtitle in characters before it is split */
  maxChars?: number;
  /** shortest duration given to a subtitle, in seconds */
  minDuration?: number;
}

/** Greedy word wrap into `count` roughly equal chunks, never exceeding maxChars when avoidable. */
function chunkWords(text: string, count: number, maxChars: number): string[] {
  const words = text.split(' ');
  const target = Math.min(maxChars, Math.ceil(text.length / count));
  const chunks: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && candidate.length > target && chunks.length < count - 1) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Turn raw speech-to-text segments into clean, editable subtitles:
 * trims text, drops empties, splits over-long lines (time is shared in proportion
 * to text length), enforces a minimum duration and removes overlaps.
 */
export function segmentsToSubtitles(segments: RawSegment[], options: SegmentOptions = {}): Subtitle[] {
  const maxChars = options.maxChars ?? 84;
  const minDuration = options.minDuration ?? 0.4;
  const pieces: { start: number; end: number; text: string }[] = [];

  for (const segment of segments) {
    const text = String(segment.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)) continue;
    const start = Math.max(0, segment.start);
    const end = Math.max(segment.end, start + minDuration);

    if (text.length <= maxChars) {
      pieces.push({ start, end, text });
      continue;
    }
    const chunks = chunkWords(text, Math.ceil(text.length / maxChars), maxChars);
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    let cursor = start;
    chunks.forEach((chunk, i) => {
      const share = (chunk.length / total) * (end - start);
      const chunkEnd = i === chunks.length - 1 ? end : cursor + share;
      pieces.push({ start: cursor, end: chunkEnd, text: chunk });
      cursor = chunkEnd;
    });
  }

  pieces.sort((a, b) => a.start - b.start || a.end - b.end);

  // Remove overlaps by trimming the earlier subtitle, but keep it visible for a moment.
  for (let i = 0; i < pieces.length - 1; i += 1) {
    const current = pieces[i];
    const next = pieces[i + 1];
    if (current.end > next.start) current.end = Math.max(current.start + 0.1, next.start);
  }

  const used = new Set<string>();
  const result: Subtitle[] = [];
  for (const piece of pieces) {
    const start = roundMs(piece.start);
    let end = roundMs(piece.end);
    if (end <= start) end = roundMs(start + 0.1);
    let id = createId();
    while (used.has(id)) id = createId();
    used.add(id);
    result.push({ id, start, end, text: piece.text });
  }
  return result;
}
