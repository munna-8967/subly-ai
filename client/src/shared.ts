// One place that imports the code shared with the server (shared/*.js), so the
// editor, the exports and the burned-in video all use the same rules.
export * from '../../shared/subtitles.js';
export * from '../../shared/style.js';
export type { Subtitle, SubtitleFormat, Track } from '../../shared/subtitles.js';
export type { SubtitleStyle } from '../../shared/style.js';
