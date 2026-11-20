// @ts-check
/**
 * Subly AI - shared subtitle library.
 *
 * This file is imported by BOTH the Node server and the browser pages, so it
 * must stay free of Node-only and DOM-only APIs. It contains:
 *   - the subtitle data model + validation
 *   - time parsing and formatting
 *   - SRT / WebVTT / TXT generation
 *   - split / merge helpers used by the editor
 *
 * Data model (all times are in SECONDS, rounded to milliseconds):
 *   { id: string, start: number, end: number, text: string, translation?: string }
 */

/** @typedef {{ id: string, start: number, end: number, text: string, translation?: string }} Subtitle */
/** @typedef {'srt' | 'vtt' | 'txt'} SubtitleFormat */
/** @typedef {'original' | 'translation'} Track */

export const MAX_SUBTITLES = 5000;
export const MAX_TEXT_LENGTH = 1000;
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const FORMATS = /** @type {const} */ (['srt', 'vtt', 'txt']);

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** Round to whole milliseconds so floating-point noise never reaches a file.
 * @param {number} seconds */
export function roundMs(seconds) {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * Parse a user-typed time into seconds.
 * Accepted: "12", "12.5", "1:05", "1:05.250", "01:02:03.5", "00:00:03,500".
 * @param {string} input
 * @returns {number} seconds, or NaN when the text is not a valid time
 */
export function parseTime(input) {
  if (typeof input !== 'string') return NaN;
  const text = input.trim().replace(',', '.');
  if (text === '') return NaN;

  const parts = text.split(':');
  if (parts.length > 3) return NaN;

  // Only the last part may contain a decimal fraction.
  for (let i = 0; i < parts.length; i += 1) {
    const pattern = i === parts.length - 1 ? /^\d{1,}(\.\d{1,3})?$/ : /^\d{1,}$/;
    if (!pattern.test(parts[i])) return NaN;
  }

  const numbers = parts.map(Number);
  if (numbers.some((n) => !Number.isFinite(n))) return NaN;

  // Minutes and seconds must be < 60 when a larger unit is present.
  for (let i = 1; i < numbers.length; i += 1) {
    if (numbers[i] >= 60) return NaN;
  }

  let seconds = 0;
  for (const n of numbers) seconds = seconds * 60 + n;
  return roundMs(seconds);
}

/** @param {number | string} value @param {number} length */
function pad(value, length) {
  return String(value).padStart(length, '0');
}

/** Split seconds into whole-ms parts. @param {number} seconds */
function clockParts(seconds) {
  const totalMs = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  return {
    hours: Math.floor(totalMs / 3600000),
    minutes: Math.floor((totalMs % 3600000) / 60000),
    seconds: Math.floor((totalMs % 60000) / 1000),
    ms: totalMs % 1000,
  };
}

/** "00:00:03,500" - SubRip timestamp. @param {number} seconds */
export function formatSrtTime(seconds) {
  const p = clockParts(seconds);
  return `${pad(p.hours, 2)}:${pad(p.minutes, 2)}:${pad(p.seconds, 2)},${pad(p.ms, 3)}`;
}

/** "00:00:03.500" - WebVTT timestamp. @param {number} seconds */
export function formatVttTime(seconds) {
  return formatSrtTime(seconds).replace(',', '.');
}

/** "01:03.500" or "1:01:03.500" - what the editor shows in its time inputs. @param {number} seconds */
export function formatEditableTime(seconds) {
  const p = clockParts(seconds);
  const base = `${pad(p.minutes, 2)}:${pad(p.seconds, 2)}.${pad(p.ms, 3)}`;
  return p.hours > 0 ? `${p.hours}:${base}` : base;
}

/** "1:05" - short clock for playback displays. @param {number} seconds */
export function formatClock(seconds) {
  const p = clockParts(seconds);
  const base = `${p.hours > 0 ? pad(p.minutes, 2) : p.minutes}:${pad(p.seconds, 2)}`;
  return p.hours > 0 ? `${p.hours}:${base}` : base;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate one subtitle. Returns a list of human-readable problems (empty = valid).
 * @param {any} sub
 * @param {{ duration?: number }} [options]
 * @returns {string[]}
 */
export function validateSubtitle(sub, options = {}) {
  const errors = [];
  if (sub === null || typeof sub !== 'object' || Array.isArray(sub)) {
    return ['Subtitle must be an object.'];
  }
  if (typeof sub.id !== 'string' || !ID_PATTERN.test(sub.id)) {
    errors.push('Subtitle id must be 1-64 characters (letters, digits, "_" or "-").');
  }
  if (typeof sub.start !== 'number' || !Number.isFinite(sub.start)) {
    errors.push('Start time must be a finite number.');
  } else if (sub.start < 0) {
    errors.push('Start time cannot be negative.');
  }
  if (typeof sub.end !== 'number' || !Number.isFinite(sub.end)) {
    errors.push('End time must be a finite number.');
  } else if (typeof sub.start === 'number' && Number.isFinite(sub.start) && sub.end <= sub.start) {
    errors.push('End time must be after the start time.');
  }
  if (typeof sub.text !== 'string' || sub.text.trim() === '') {
    errors.push('Subtitle text cannot be empty.');
  } else if (sub.text.length > MAX_TEXT_LENGTH) {
    errors.push(`Subtitle text is longer than ${MAX_TEXT_LENGTH} characters.`);
  }
  if (sub.translation !== undefined) {
    if (typeof sub.translation !== 'string') {
      errors.push('Translation must be text.');
    } else if (sub.translation.length > MAX_TEXT_LENGTH) {
      errors.push(`Translation is longer than ${MAX_TEXT_LENGTH} characters.`);
    }
  }
  const duration = options.duration;
  if (
    typeof duration === 'number' &&
    Number.isFinite(duration) &&
    duration > 0 &&
    typeof sub.end === 'number' &&
    Number.isFinite(sub.end) &&
    typeof sub.start === 'number'
  ) {
    if (sub.start >= duration) errors.push('Start time is after the end of the video.');
    else if (sub.end > duration + 0.05) errors.push('End time is after the end of the video.');
  }
  return errors;
}

/**
 * Validate a whole list: every entry valid, ids unique, size bounded.
 * @param {any} list
 * @returns {{ ok: boolean, errors: { index: number, id?: string, message: string }[] }}
 */
export function validateSubtitles(list) {
  /** @type {{ index: number, id?: string, message: string }[]} */
  const errors = [];
  if (!Array.isArray(list)) {
    return { ok: false, errors: [{ index: -1, message: 'Subtitles must be an array.' }] };
  }
  if (list.length > MAX_SUBTITLES) {
    errors.push({ index: -1, message: `A project can hold at most ${MAX_SUBTITLES} subtitles.` });
    return { ok: false, errors };
  }
  const seen = new Set();
  list.forEach((sub, index) => {
    for (const message of validateSubtitle(sub)) errors.push({ index, id: sub?.id, message });
    if (sub && typeof sub.id === 'string') {
      if (seen.has(sub.id)) errors.push({ index, id: sub.id, message: 'Duplicate subtitle id.' });
      seen.add(sub.id);
    }
  });
  return { ok: errors.length === 0, errors };
}

/** Deterministic ordering: start, then end, then id. Returns a new array.
 * @param {Subtitle[]} list
 * @returns {Subtitle[]} */
export function sortSubtitles(list) {
  return [...list].sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Keep only entries that are safe to write to a file (used defensively by the
 * exporters so one bad entry can never produce a corrupt file).
 * @param {any[]} list
 * @returns {Subtitle[]}
 */
export function usableSubtitles(list) {
  if (!Array.isArray(list)) return [];
  return sortSubtitles(list.filter((sub) => validateSubtitle(sub).length === 0));
}

/** Ids of subtitles that overlap the one before them (in time order).
 * @param {Subtitle[]} list
 * @returns {Set<string>} */
export function findOverlaps(list) {
  const sorted = sortSubtitles(list);
  /** @type {Set<string>} */
  const ids = new Set();
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].start < sorted[i - 1].end - 0.0005) ids.add(sorted[i].id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Ids and text selection
// ---------------------------------------------------------------------------

/** Short unique id that satisfies ID_PATTERN. */
export function createId() {
  const random = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `s${Date.now().toString(36)}${random}`;
}

/**
 * The text to show/export for a track. The translation track falls back to the
 * original text for entries that have no translation yet (never silently empty).
 * @param {Subtitle} sub
 * @param {Track} track
 */
export function textFor(sub, track = 'original') {
  if (track === 'translation' && typeof sub.translation === 'string' && sub.translation.trim() !== '') {
    return sub.translation;
  }
  return sub.text;
}

/** True when the entry has its own translation text. @param {Subtitle} sub */
export function hasTranslation(sub) {
  return typeof sub.translation === 'string' && sub.translation.trim() !== '';
}

/**
 * Subtitles visible at a playback time (several when they overlap).
 * @param {Subtitle[]} sortedList
 * @param {number} time
 */
export function activeSubtitles(sortedList, time) {
  return sortedList.filter((sub) => time >= sub.start && time < sub.end);
}

// ---------------------------------------------------------------------------
// Export formats
// ---------------------------------------------------------------------------

/** Collapse a cue's text into clean lines (blank lines would end an SRT/VTT cue). @param {string} text */
function cueLines(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** @param {Subtitle[]} list @param {Track} track */
export function toSrt(list, track = 'original') {
  const usable = usableSubtitles(list);
  if (usable.length === 0) return '';
  const cues = usable.map(
    (sub, index) =>
      `${index + 1}\n${formatSrtTime(sub.start)} --> ${formatSrtTime(sub.end)}\n${cueLines(textFor(sub, track)).join('\n')}`,
  );
  return `${cues.join('\n\n')}\n`;
}

/** @param {string} line */
function escapeVtt(line) {
  return line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @param {Subtitle[]} list @param {Track} track */
export function toVtt(list, track = 'original') {
  const cues = usableSubtitles(list).map(
    (sub) =>
      `${formatVttTime(sub.start)} --> ${formatVttTime(sub.end)}\n${cueLines(textFor(sub, track)).map(escapeVtt).join('\n')}`,
  );
  return cues.length ? `WEBVTT\n\n${cues.join('\n\n')}\n` : 'WEBVTT\n';
}

/** One cue per line, no timestamps. @param {Subtitle[]} list @param {Track} track */
export function toTxt(list, track = 'original') {
  const lines = usableSubtitles(list).map((sub) => cueLines(textFor(sub, track)).join(' '));
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * Build a subtitle file from the project's saved subtitles.
 * @param {SubtitleFormat} format
 * @param {any[]} list
 * @param {{ track?: Track }} [options]
 * @returns {{ content: string, count: number, skipped: number, missingTranslations: number, mimeType: string }}
 */
export function formatSubtitles(format, list, options = {}) {
  if (!FORMATS.includes(format)) throw new Error(`Unsupported format: ${format}`);
  const track = options.track === 'translation' ? 'translation' : 'original';
  const usable = usableSubtitles(list);
  const content = format === 'srt' ? toSrt(usable, track) : format === 'vtt' ? toVtt(usable, track) : toTxt(usable, track);
  const mimeTypes = {
    srt: 'application/x-subrip',
    vtt: 'text/vtt',
    txt: 'text/plain',
  };
  return {
    content,
    count: usable.length,
    skipped: (Array.isArray(list) ? list.length : 0) - usable.length,
    missingTranslations: track === 'translation' ? usable.filter((s) => !hasTranslation(s)).length : 0,
    mimeType: mimeTypes[format],
  };
}

// ---------------------------------------------------------------------------
// Editing helpers
// ---------------------------------------------------------------------------

/** Split text into two parts near a proportional position, on a word boundary.
 * @param {string} text @param {number} ratio
 * @returns {[string, string] | null} */
function splitTextByRatio(text, ratio) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  const index = Math.min(words.length - 1, Math.max(1, Math.round(words.length * ratio)));
  return [words.slice(0, index).join(' '), words.slice(index).join(' ')];
}

/**
 * Split a subtitle in two at a time inside it.
 * @param {Subtitle} sub
 * @param {number} at seconds
 * @param {() => string} [makeId]
 * @returns {{ ok: true, parts: [Subtitle, Subtitle] } | { ok: false, error: string }}
 */
export function splitSubtitle(sub, at, makeId = createId) {
  const minLength = 0.1;
  if (!Number.isFinite(at) || at <= sub.start + minLength || at >= sub.end - minLength) {
    return { ok: false, error: 'Move the playhead inside the subtitle (at least 0.1s from either edge) to split it.' };
  }
  const ratio = (at - sub.start) / (sub.end - sub.start);
  const text = splitTextByRatio(sub.text, ratio);
  if (!text) return { ok: false, error: 'This subtitle needs at least two words to be split.' };

  const first = { id: sub.id, start: sub.start, end: roundMs(at), text: text[0] };
  const second = { id: makeId(), start: roundMs(at), end: sub.end, text: text[1] };

  if (hasTranslation(sub)) {
    const translation = splitTextByRatio(/** @type {string} */ (sub.translation), ratio);
    if (translation) {
      /** @type {Subtitle} */ (first).translation = translation[0];
      /** @type {Subtitle} */ (second).translation = translation[1];
    } else {
      /** @type {Subtitle} */ (first).translation = sub.translation;
    }
  }
  return { ok: true, parts: [first, second] };
}

/**
 * Merge several subtitles into one that spans them all (text joined in time order).
 * @param {Subtitle[]} subs at least two
 * @returns {Subtitle | null}
 */
export function mergeSubtitles(subs) {
  if (!Array.isArray(subs) || subs.length < 2) return null;
  const ordered = sortSubtitles(subs);
  const merged = {
    id: ordered[0].id,
    start: Math.min(...ordered.map((s) => s.start)),
    end: Math.max(...ordered.map((s) => s.end)),
    text: ordered.map((s) => s.text.trim()).filter(Boolean).join(' '),
  };
  if (ordered.some(hasTranslation)) {
    /** @type {Subtitle} */ (merged).translation = ordered
      .map((s) => (s.translation ?? '').trim())
      .filter(Boolean)
      .join(' ');
  }
  return /** @type {Subtitle} */ (merged);
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Make a user-typed file name safe on Windows, macOS and Linux (without extension).
 * Returns the fallback when nothing usable is left.
 * @param {string} raw
 * @param {string} [fallback]
 */
export function sanitizeFileName(raw, fallback = 'subtitles') {
  let name = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/g, '');
  if (name === '' || RESERVED_NAMES.test(name)) name = fallback;
  return name;
}
