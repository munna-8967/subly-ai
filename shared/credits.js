// @ts-check
/**
 * Subly AI - what things cost in credits. Used by the server (to charge) and by the browser
 * (to show the price BEFORE the user starts), so the two can never disagree.
 *
 * Everything is counted in whole credits and in STARTED minutes: a 61-second video counts as 2 minutes.
 */

/** @typedef {{ transcribePerMinute: number, translateMinutesPerCredit: number, renderMinutesPerCredit: number }} CreditCosts */

/** Started minutes, at least 1. @param {number} seconds */
export function startedMinutes(seconds) {
  const s = Number.isFinite(seconds) ? seconds : 0;
  return Math.max(1, Math.ceil(s / 60 - 1e-9));
}

/** Speech-to-text. @param {number} seconds @param {CreditCosts} costs */
export function transcribeCost(seconds, costs) {
  return startedMinutes(seconds) * costs.transcribePerMinute;
}

/** Translating a whole project. @param {number} seconds @param {CreditCosts} costs */
export function translateCost(seconds, costs) {
  return Math.max(1, Math.ceil(startedMinutes(seconds) / costs.translateMinutesPerCredit));
}

/** Burned-in video export. @param {number} seconds @param {CreditCosts} costs */
export function renderCost(seconds, costs) {
  return Math.max(1, Math.ceil(startedMinutes(seconds) / costs.renderMinutesPerCredit));
}

/** Cost of "generate subtitles", with translation when a target language is chosen.
 * @param {number} seconds @param {boolean} withTranslation @param {CreditCosts} costs */
export function generationCost(seconds, withTranslation, costs) {
  return transcribeCost(seconds, costs) + (withTranslation ? translateCost(seconds, costs) : 0);
}

/** "YYYY-MM" of a date in UTC: the free credits are granted once per such period. @param {Date} [now] */
export function currentPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** ISO time of the first moment of the next UTC month. @param {Date} [now] */
export function nextPeriodStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}
