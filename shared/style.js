// @ts-check
/**
 * Subly AI - subtitle appearance settings, shared by the editor preview (browser)
 * and the video renderer (server), so the two agree on what each field means.
 *
 * Sizes are RELATIVE so the same style works for any video resolution:
 *   fontSize     - percent of the video height          (e.g. 5 = 5% of height)
 *   marginV      - percent of the video height from the chosen edge
 *   outlineWidth - percent of the font size
 */

/** @typedef {{
 *   fontFamily: string,
 *   fontSize: number,
 *   color: string,
 *   bold: boolean,
 *   italic: boolean,
 *   align: 'left' | 'center' | 'right',
 *   position: 'top' | 'middle' | 'bottom',
 *   marginV: number,
 *   backgroundColor: string,
 *   backgroundOpacity: number,
 *   outlineColor: string,
 *   outlineWidth: number,
 *   shadow: boolean
 * }} SubtitleStyle */

/** Fonts offered in the editor. Burned-in video uses fonts installed on the SERVER. */
export const FONT_FAMILIES = ['Arial', 'Roboto', 'Poppins', 'Verdana', 'Georgia', 'Courier New'];
export const ALIGNMENTS = ['left', 'center', 'right'];
export const POSITIONS = ['top', 'middle', 'bottom'];

export const STYLE_LIMITS = {
  fontSize: { min: 2, max: 12 },
  marginV: { min: 0, max: 30 },
  backgroundOpacity: { min: 0, max: 1 },
  outlineWidth: { min: 0, max: 20 },
};

/** @type {SubtitleStyle} */
export const DEFAULT_STYLE = Object.freeze({
  fontFamily: 'Arial',
  fontSize: 5,
  color: '#ffffff',
  bold: false,
  italic: false,
  align: 'center',
  position: 'bottom',
  marginV: 6,
  backgroundColor: '#000000',
  backgroundOpacity: 0,
  outlineColor: '#000000',
  outlineWidth: 8,
  shadow: true,
});

/**
 * One-click looks. Each preset only lists what differs from DEFAULT_STYLE; `applyPreset` fills in the rest.
 * Every preset is checked by normalizeStyle in the unit tests.
 * @type {{ id: string, label: string, style: Partial<SubtitleStyle> }[]}
 */
export const PRESETS = [
  { id: 'classic', label: 'Classic', style: {} },
  { id: 'bold-pop', label: 'Bold pop', style: { fontFamily: 'Poppins', fontSize: 6.5, color: '#ffe14d', bold: true, outlineWidth: 12 } },
  { id: 'boxed', label: 'Boxed', style: { fontFamily: 'Roboto', fontSize: 4.5, backgroundColor: '#000000', backgroundOpacity: 0.7, outlineWidth: 0, shadow: false } },
  { id: 'cinematic', label: 'Cinematic', style: { fontFamily: 'Georgia', fontSize: 4.5, italic: true, color: '#f3efe6', marginV: 8 } },
  { id: 'neon', label: 'Neon', style: { fontFamily: 'Poppins', fontSize: 5.5, color: '#b9a6ff', bold: true, outlineColor: '#1b1240', outlineWidth: 14 } },
  { id: 'minimal-top', label: 'Minimal top', style: { fontFamily: 'Verdana', fontSize: 4, position: 'top', marginV: 5, outlineWidth: 6 } },
];

/** A full style for a preset id (unknown ids give the default). @param {string} id @returns {SubtitleStyle} */
export function applyPreset(id) {
  const preset = PRESETS.find((p) => p.id === id);
  return /** @type {SubtitleStyle} */ ({ ...DEFAULT_STYLE, ...(preset ? preset.style : {}) });
}

/** Which preset (if any) exactly matches this style? @param {SubtitleStyle} style @returns {string | null} */
export function matchingPreset(style) {
  for (const preset of PRESETS) {
    const full = applyPreset(preset.id);
    if (Object.keys(full).every((k) => /** @type {any} */ (full)[k] === /** @type {any} */ (style)[k])) return preset.id;
  }
  return null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Validate a style object. Missing fields take their default; wrong types or
 * out-of-range values are reported as errors.
 * @param {any} input
 * @returns {{ ok: true, style: SubtitleStyle } | { ok: false, errors: string[] }}
 */
export function normalizeStyle(input) {
  if (input === undefined || input === null) return { ok: true, style: { ...DEFAULT_STYLE } };
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['Style must be an object.'] };

  /** @type {string[]} */
  const errors = [];
  const style = { ...DEFAULT_STYLE, ...input };

  if (!FONT_FAMILIES.includes(style.fontFamily)) errors.push(`fontFamily must be one of: ${FONT_FAMILIES.join(', ')}.`);
  for (const key of /** @type {const} */ (['fontSize', 'marginV', 'backgroundOpacity', 'outlineWidth'])) {
    const { min, max } = STYLE_LIMITS[key];
    if (typeof style[key] !== 'number' || !Number.isFinite(style[key]) || style[key] < min || style[key] > max) {
      errors.push(`${key} must be a number from ${min} to ${max}.`);
    }
  }
  for (const key of /** @type {const} */ (['color', 'backgroundColor', 'outlineColor'])) {
    if (typeof style[key] !== 'string' || !HEX.test(style[key])) errors.push(`${key} must be a #RRGGBB color.`);
  }
  for (const key of /** @type {const} */ (['bold', 'italic', 'shadow'])) {
    if (typeof style[key] !== 'boolean') errors.push(`${key} must be true or false.`);
  }
  if (!ALIGNMENTS.includes(style.align)) errors.push(`align must be one of: ${ALIGNMENTS.join(', ')}.`);
  if (!POSITIONS.includes(style.position)) errors.push(`position must be one of: ${POSITIONS.join(', ')}.`);

  if (errors.length > 0) return { ok: false, errors };
  // Return only known keys so unknown input can never be stored.
  /** @type {SubtitleStyle} */
  const clean = {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    color: style.color.toLowerCase(),
    bold: style.bold,
    italic: style.italic,
    align: style.align,
    position: style.position,
    marginV: style.marginV,
    backgroundColor: style.backgroundColor.toLowerCase(),
    backgroundOpacity: style.backgroundOpacity,
    outlineColor: style.outlineColor.toLowerCase(),
    outlineWidth: style.outlineWidth,
    shadow: style.shadow,
  };
  return { ok: true, style: clean };
}

/** "#rrggbb" + opacity -> "rgba(r, g, b, a)" for CSS.
 * @param {string} hex @param {number} [opacity] */
export function hexToRgba(hex, opacity = 1) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * CSS for the live preview overlay. `stageHeight` is the displayed video height
 * in CSS pixels; everything scales from it so preview and output share proportions.
 * @param {SubtitleStyle} style
 * @param {number} stageHeight
 */
export function previewCss(style, stageHeight) {
  const fontPx = Math.max(8, (style.fontSize / 100) * stageHeight);
  const outlinePx = (style.outlineWidth / 100) * fontPx;
  const boxed = style.backgroundOpacity > 0;

  const shadows = [];
  if (!boxed && outlinePx > 0.2) {
    const o = Math.max(0.5, outlinePx);
    for (const [x, y] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      shadows.push(`${(x * o).toFixed(2)}px ${(y * o).toFixed(2)}px 0 ${style.outlineColor}`);
    }
  }
  if (!boxed && style.shadow) shadows.push(`${(fontPx * 0.06).toFixed(2)}px ${(fontPx * 0.06).toFixed(2)}px ${(fontPx * 0.05).toFixed(2)}px rgba(0, 0, 0, 0.6)`);

  const vertical = (style.marginV / 100) * stageHeight;
  return {
    fontFamily: `"${style.fontFamily}", "Liberation Sans", "DejaVu Sans", sans-serif`,
    fontSize: `${fontPx.toFixed(2)}px`,
    color: style.color,
    fontWeight: style.bold ? '700' : '400',
    fontStyle: style.italic ? 'italic' : 'normal',
    textAlign: style.align,
    textShadow: shadows.length ? shadows.join(', ') : 'none',
    backgroundColor: boxed ? hexToRgba(style.backgroundColor, style.backgroundOpacity) : 'transparent',
    padding: boxed ? `${(fontPx * 0.15).toFixed(2)}px ${(fontPx * 0.35).toFixed(2)}px` : '0',
    /** vertical offset in px from the chosen edge */
    verticalOffset: `${vertical.toFixed(2)}px`,
  };
}
