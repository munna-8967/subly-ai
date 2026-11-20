// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTime,
  formatSrtTime,
  formatVttTime,
  formatEditableTime,
  formatClock,
  validateSubtitle,
  validateSubtitles,
  sortSubtitles,
  formatSubtitles,
  toSrt,
  toVtt,
  toTxt,
  splitSubtitle,
  mergeSubtitles,
  sanitizeFileName,
  findOverlaps,
  activeSubtitles,
  textFor,
  createId,
  ID_PATTERN,
} from '../../shared/subtitles.js';
import { DEFAULT_STYLE, PRESETS, applyPreset, matchingPreset, normalizeStyle, previewCss } from '../../shared/style.js';
import { currentPeriod, generationCost, nextPeriodStart, renderCost, startedMinutes, translateCost } from '../../shared/credits.js';

const sample = [
  { id: 'a', start: 0, end: 3, text: 'Welcome to my video.' },
  { id: 'b', start: 3, end: 6.5, text: "Let's start learning!" },
];

test('parseTime accepts the supported formats', () => {
  assert.equal(parseTime('12'), 12);
  assert.equal(parseTime('12.5'), 12.5);
  assert.equal(parseTime('1:05'), 65);
  assert.equal(parseTime('1:05.250'), 65.25);
  assert.equal(parseTime('01:02:03.5'), 3723.5);
  assert.equal(parseTime('00:00:03,500'), 3.5);
  assert.equal(parseTime('  00:03 '), 3);
});

test('parseTime rejects invalid input', () => {
  for (const bad of ['', 'abc', '1:2:3:4', '-1', '1:75', '1::5', '00:61', '1.2345', ':30', null, undefined, 5]) {
    assert.ok(Number.isNaN(parseTime(/** @type {any} */ (bad))), `should reject ${String(bad)}`);
  }
});

test('timestamp formatting: SRT uses comma, VTT uses period', () => {
  assert.equal(formatSrtTime(0), '00:00:00,000');
  assert.equal(formatSrtTime(3.5), '00:00:03,500');
  assert.equal(formatSrtTime(3723.007), '01:02:03,007');
  assert.equal(formatVttTime(3.5), '00:00:03.500');
  // rounding must never produce 1000 ms
  assert.equal(formatSrtTime(1.9996), '00:00:02,000');
  assert.equal(formatSrtTime(-4), '00:00:00,000');
  assert.equal(formatSrtTime(NaN), '00:00:00,000');
});

test('editable / clock formatting', () => {
  assert.equal(formatEditableTime(65.25), '01:05.250');
  assert.equal(formatEditableTime(3723.5), '1:02:03.500');
  assert.equal(formatClock(65), '1:05');
  assert.equal(formatClock(3725), '1:02:05');
  assert.equal(parseTime(formatEditableTime(3723.5)), 3723.5);
});

test('validateSubtitle: valid entry passes', () => {
  assert.deepEqual(validateSubtitle(sample[0]), []);
});

test('validateSubtitle: rejects bad timing, text and ids', () => {
  assert.ok(validateSubtitle({ id: 'x', start: -1, end: 2, text: 'hi' }).length > 0, 'negative start');
  assert.ok(validateSubtitle({ id: 'x', start: 2, end: 2, text: 'hi' }).length > 0, 'end == start');
  assert.ok(validateSubtitle({ id: 'x', start: 3, end: 2, text: 'hi' }).length > 0, 'end < start');
  assert.ok(validateSubtitle({ id: 'x', start: NaN, end: 2, text: 'hi' }).length > 0, 'NaN start');
  assert.ok(validateSubtitle({ id: 'x', start: 0, end: Infinity, text: 'hi' }).length > 0, 'infinite end');
  assert.ok(validateSubtitle({ id: 'x', start: '0', end: 2, text: 'hi' }).length > 0, 'string start');
  assert.ok(validateSubtitle({ id: 'x', start: 0, end: 2, text: '   ' }).length > 0, 'blank text');
  assert.ok(validateSubtitle({ id: 'x', start: 0, end: 2, text: 'a'.repeat(1001) }).length > 0, 'long text');
  assert.ok(validateSubtitle({ id: '../etc', start: 0, end: 2, text: 'hi' }).length > 0, 'bad id');
  assert.ok(validateSubtitle(null).length > 0, 'null');
  assert.ok(validateSubtitle({ id: 'x', start: 0, end: 2, text: 'hi', translation: 5 }).length > 0, 'bad translation');
});

test('validateSubtitle: respects video duration when given', () => {
  assert.ok(validateSubtitle({ id: 'x', start: 9, end: 12, text: 'hi' }, { duration: 10 }).length > 0);
  assert.ok(validateSubtitle({ id: 'x', start: 11, end: 12, text: 'hi' }, { duration: 10 }).length > 0);
  assert.deepEqual(validateSubtitle({ id: 'x', start: 8, end: 10, text: 'hi' }, { duration: 10 }), []);
});

test('validateSubtitles: duplicate ids and non-arrays are rejected', () => {
  assert.equal(validateSubtitles(sample).ok, true);
  const dup = validateSubtitles([sample[0], { ...sample[1], id: 'a' }]);
  assert.equal(dup.ok, false);
  assert.match(dup.errors[0].message, /Duplicate/);
  assert.equal(validateSubtitles('nope').ok, false);
  assert.equal(validateSubtitles(new Array(5001).fill(sample[0])).ok, false);
});

test('sortSubtitles is deterministic and does not mutate', () => {
  const input = [
    { id: 'c', start: 5, end: 6, text: 'c' },
    { id: 'b', start: 1, end: 3, text: 'b' },
    { id: 'a', start: 1, end: 3, text: 'a' },
    { id: 'd', start: 1, end: 2, text: 'd' },
  ];
  const sorted = sortSubtitles(input);
  assert.deepEqual(sorted.map((s) => s.id), ['d', 'a', 'b', 'c']);
  assert.deepEqual(input.map((s) => s.id), ['c', 'b', 'a', 'd']);
});

test('SRT export: numbered cues, comma milliseconds', () => {
  assert.equal(
    toSrt(sample),
    "1\n00:00:00,000 --> 00:00:03,000\nWelcome to my video.\n\n2\n00:00:03,000 --> 00:00:06,500\nLet's start learning!\n",
  );
});

test('VTT export: WEBVTT header, period milliseconds, escaped markup', () => {
  const out = toVtt([{ id: 'a', start: 0, end: 1, text: 'Fish & <chips> -->' }]);
  assert.ok(out.startsWith('WEBVTT\n\n'));
  assert.ok(out.includes('00:00:00.000 --> 00:00:01.000'));
  assert.ok(out.includes('Fish &amp; &lt;chips&gt; --&gt;'));
  assert.ok(!out.includes('00:00:00,000'));
});

test('TXT export: text only, no timestamps', () => {
  const out = toTxt(sample);
  assert.equal(out, "Welcome to my video.\nLet's start learning!\n");
  assert.ok(!/\d{2}:\d{2}/.test(out));
});

test('exports: blank lines inside a cue cannot split the cue', () => {
  const out = toSrt([{ id: 'a', start: 0, end: 1, text: 'line one\n\n\nline two' }]);
  assert.equal(out, '1\n00:00:00,000 --> 00:00:01,000\nline one\nline two\n');
});

test('exports: empty project gives empty/minimal output', () => {
  assert.equal(toSrt([]), '');
  assert.equal(toTxt([]), '');
  assert.equal(toVtt([]), 'WEBVTT\n');
  assert.equal(formatSubtitles('srt', []).count, 0);
});

test('exports: invalid entries are skipped, never written', () => {
  const result = formatSubtitles('srt', [
    sample[0],
    { id: 'bad', start: 5, end: 4, text: 'broken' },
    { id: 'bad2', start: NaN, end: 4, text: 'broken' },
  ]);
  assert.equal(result.count, 1);
  assert.equal(result.skipped, 2);
  assert.ok(!result.content.includes('broken'));
});

test('exports: entries come out in time order', () => {
  const out = toTxt([sample[1], sample[0]]);
  assert.equal(out.split('\n')[0], 'Welcome to my video.');
});

test('translation track: uses translation, falls back to original and reports it', () => {
  const list = [
    { id: 'a', start: 0, end: 1, text: 'Hello', translation: 'Hola' },
    { id: 'b', start: 1, end: 2, text: 'World' },
  ];
  const result = formatSubtitles('txt', list, { track: 'translation' });
  assert.equal(result.content, 'Hola\nWorld\n');
  assert.equal(result.missingTranslations, 1);
  assert.equal(formatSubtitles('txt', list, { track: 'original' }).content, 'Hello\nWorld\n');
  assert.equal(textFor(list[1], 'translation'), 'World');
});

test('formatSubtitles rejects unknown formats', () => {
  assert.throws(() => formatSubtitles(/** @type {any} */ ('ass'), sample));
});

test('splitSubtitle splits text and time on a word boundary', () => {
  const result = splitSubtitle({ id: 'a', start: 0, end: 4, text: 'one two three four' }, 2, () => 'new1');
  assert.ok(result.ok);
  if (!result.ok) return;
  const [first, second] = result.parts;
  assert.deepEqual([first.id, first.start, first.end, first.text], ['a', 0, 2, 'one two']);
  assert.deepEqual([second.id, second.start, second.end, second.text], ['new1', 2, 4, 'three four']);
});

test('splitSubtitle refuses impossible splits', () => {
  assert.equal(splitSubtitle({ id: 'a', start: 0, end: 4, text: 'one two' }, 0.05).ok, false);
  assert.equal(splitSubtitle({ id: 'a', start: 0, end: 4, text: 'one two' }, 9).ok, false);
  assert.equal(splitSubtitle({ id: 'a', start: 0, end: 4, text: 'single' }, 2).ok, false);
});

test('splitSubtitle keeps the translation attached', () => {
  const result = splitSubtitle({ id: 'a', start: 0, end: 4, text: 'one two three four', translation: 'uno dos tres cuatro' }, 2, () => 'n');
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.parts[0].translation, 'uno dos');
  assert.equal(result.parts[1].translation, 'tres cuatro');
});

test('mergeSubtitles spans all entries and joins text in time order', () => {
  const merged = mergeSubtitles([
    { id: 'b', start: 3, end: 5, text: 'second' },
    { id: 'a', start: 0, end: 2, text: 'first' },
  ]);
  assert.ok(merged);
  assert.deepEqual([merged.id, merged.start, merged.end, merged.text], ['a', 0, 5, 'first second']);
  assert.equal(mergeSubtitles([sample[0]]), null);
});

test('findOverlaps flags only the later overlapping entry', () => {
  const overlaps = findOverlaps([
    { id: 'a', start: 0, end: 3, text: 'a' },
    { id: 'b', start: 2, end: 4, text: 'b' },
    { id: 'c', start: 4, end: 5, text: 'c' },
  ]);
  assert.deepEqual([...overlaps], ['b']);
});

test('activeSubtitles uses the playback time (start inclusive, end exclusive)', () => {
  assert.deepEqual(activeSubtitles(sample, 0).map((s) => s.id), ['a']);
  assert.deepEqual(activeSubtitles(sample, 2.999).map((s) => s.id), ['a']);
  assert.deepEqual(activeSubtitles(sample, 3).map((s) => s.id), ['b']);
  assert.deepEqual(activeSubtitles(sample, 6.5), []);
});

test('sanitizeFileName strips unsafe characters and reserved names', () => {
  assert.equal(sanitizeFileName('my:file/name?'), 'my-file-name-');
  assert.equal(sanitizeFileName('  ...trim.  '), 'trim');
  assert.equal(sanitizeFileName(''), 'subtitles');
  assert.equal(sanitizeFileName('CON'), 'subtitles');
  // path separators are replaced and leading dots stripped, so it can never escape a folder
  const traversal = sanitizeFileName('../../etc/passwd');
  assert.equal(traversal, '-..-etc-passwd');
  assert.ok(!traversal.includes('/') && !traversal.startsWith('.'));
  assert.equal(sanitizeFileName('x'.repeat(200)).length, 80);
  assert.equal(sanitizeFileName('???', 'fallback'), '---');
  assert.equal(sanitizeFileName('...', 'fallback'), 'fallback');
});

test('createId produces valid, distinct ids', () => {
  const ids = new Set(Array.from({ length: 500 }, createId));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, ID_PATTERN);
});

test('normalizeStyle: defaults, validation and unknown-key stripping', () => {
  const defaults = normalizeStyle(undefined);
  assert.ok(defaults.ok);
  const partial = normalizeStyle({ fontSize: 7, color: '#FFAA00', hacker: 'x' });
  assert.ok(partial.ok);
  if (partial.ok) {
    assert.equal(partial.style.fontSize, 7);
    assert.equal(partial.style.color, '#ffaa00');
    assert.ok(!('hacker' in partial.style));
  }
  for (const bad of [{ fontSize: 99 }, { color: 'red' }, { align: 'justify' }, { bold: 'yes' }, { fontFamily: 'Comic Sans' }, { backgroundOpacity: 2 }, [], 'str']) {
    assert.equal(normalizeStyle(bad).ok, false, JSON.stringify(bad));
  }
});

test('previewCss scales with the stage height and reflects style options', () => {
  const css = previewCss({ ...DEFAULT_STYLE, fontSize: 5, bold: true, italic: true }, 400);
  assert.equal(css.fontSize, '20.00px');
  assert.equal(css.fontWeight, '700');
  assert.equal(css.fontStyle, 'italic');
  assert.notEqual(css.textShadow, 'none');
  const boxed = previewCss({ ...DEFAULT_STYLE, backgroundOpacity: 0.5, backgroundColor: '#ff0000' }, 400);
  assert.equal(boxed.backgroundColor, 'rgba(255, 0, 0, 0.5)');
  assert.equal(boxed.textShadow, 'none');
});

test('style presets are all valid, distinct, and recognised again', () => {
  const seen = new Set();
  for (const preset of PRESETS) {
    const result = normalizeStyle(applyPreset(preset.id));
    assert.equal(result.ok, true, `${preset.id}: ${JSON.stringify(result)}`);
    assert.equal(matchingPreset(applyPreset(preset.id)), preset.id);
    seen.add(JSON.stringify(applyPreset(preset.id)));
  }
  assert.equal(seen.size, PRESETS.length, 'no two presets are identical');
  assert.equal(matchingPreset({ ...DEFAULT_STYLE, fontSize: 7.7 }), null);
  assert.deepEqual(applyPreset('does-not-exist'), { ...DEFAULT_STYLE });
});

test('credit costs: started minutes, rounding up, and calendar periods', () => {
  const costs = { transcribePerMinute: 2, translateMinutesPerCredit: 3, renderMinutesPerCredit: 4 };
  assert.equal(startedMinutes(0), 1);
  assert.equal(startedMinutes(120), 2);
  assert.equal(startedMinutes(121), 3);
  assert.equal(generationCost(180, false, costs), 6);
  assert.equal(translateCost(180, costs), 1);
  assert.equal(translateCost(181, costs), 2);
  assert.equal(renderCost(600, costs), 3);
  assert.equal(currentPeriod(new Date('2026-12-31T23:59:59Z')), '2026-12');
  assert.equal(nextPeriodStart(new Date('2026-12-31T23:59:59Z')), '2027-01-01T00:00:00.000Z');
});
