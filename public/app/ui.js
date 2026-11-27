// @ts-check
/**
 * Small DOM helpers shared by the views, plus the `App` contract the views
 * use to read state and request changes.
 *
 * @module
 */

/**
 * What every view gets: the current plan, UI state, and the only ways to
 * change them (each re-renders; `change` also saves).
 * @typedef {object} App
 * @property {import('./model.js').PlanDoc} doc Current plan document.
 * @property {import('./model.js').CostFilter} filter Which costs to show.
 * @property {boolean} optional Count optional items in totals.
 * @property {string | null} sel Selected thing: `item:<id>`, `fare:<route>:<day>`, `add:<kind>:<parent>`, or `edit:<id>`.
 * @property {Set<string>} open Items expanded in place (desktop).
 * @property {string | null} drill Item the timeline is drilled into, or null for the whole plan.
 * @property {boolean} narrow Phone-sized layout: children open by drilling in.
 * @property {'lanes' | 'calendar' | 'map' | 'cards' | 'story' | 'zoom'} view Which view is showing.
 * @property {string | null} planId Id of the open plan, or null when offline.
 * @property {string} planName Name of the open plan.
 * @property {(fn: (doc: import('./model.js').PlanDoc) => void) => void} change Mutates the plan, re-renders and schedules a save.
 * @property {(sel: string | null) => void} select Opens the sheet for something, or closes it.
 * @property {(id: string, len: number) => void} setLen Resizes an item (clamped to its range).
 * @property {(id: string) => void} toggle Expands or collapses an item in place.
 * @property {(id: string | null) => void} drillTo Focuses the timeline on an item (null = whole plan).
 * @property {(id: string, files: Iterable<Blob>) => Promise<void>} attach Adds pictures to an item.
 */

/**
 * First element matching a selector, typed loosely for brevity.
 * @param {string} sel CSS selector.
 * @param {ParentNode} [root]
 * @returns {HTMLElement}
 */
export const $ = (sel, root = document) => /** @type {HTMLElement} */ (root.querySelector(sel));

/**
 * Escapes text for safe use inside HTML (content and quoted attributes).
 * @param {unknown} s
 * @returns {string}
 */
export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/**
 * Heat styling for a value between lo and hi.
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {{style: string, cls: string}} Inline `--p` and a class that flips text color on dark cells.
 */
export function heat(v, lo, hi) {
  const p = hi > lo ? Math.round(6 + 86 * (v - lo) / (hi - lo)) : 30;
  return { style: `--p:${p}%`, cls: p > 58 ? ' hotx' : '' };
}

/** Plane icon used on flight tags. */
export const PLANE = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>';

/**
 * Round tick values covering [lo, hi], for chart axes.
 * @param {number} lo
 * @param {number} hi
 * @param {number} [count] Rough number of ticks.
 * @returns {number[]}
 */
export function niceTicks(lo, hi, count = 4) {
  if (hi <= lo) hi = lo + 1;
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag, out = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.5; v += step) out.push(v);
  return out;
}

/**
 * Tracks a pointer drag on the window until release.
 * @param {PointerEvent} e The pointerdown event.
 * @param {(ev: PointerEvent) => void} move Called on every move.
 * @param {() => void} [end] Called once on release.
 */
export function drag(e, move, end) {
  e.preventDefault();
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    end?.();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}
