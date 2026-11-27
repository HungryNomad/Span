// @ts-check
/**
 * Zoom controls shared by the zoom timeline and the lanes view: the preset
 * buttons and log-scale slider, Ctrl+scroll and two-finger pinch around the
 * pointer, and the tick axis with weekend shading and gridlines, drawn for
 * the visible window only.
 *
 * @module
 */
import { dateOf, fmt, nowIdx } from './model.js';

const WD = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** @typedef {'h' | 'd' | 'w' | 'm' | 'y'} Unit */
/** @typedef {readonly [Unit, number, number]} TickStep A tick unit, how many per tick, and the least pixels per tick. */
/**
 * Tick steps each zoom level may use, finest first. The finest that has
 * room wins, else the last, so the axis always reads at the level's scale.
 * @type {Record<Preset, readonly TickStep[]>}
 */
const STEPS = {
  Hours: [['h', 1, 40], ['h', 3, 40], ['h', 6, 40], ['h', 12, 0]],
  Days: [['d', 1, 24], ['d', 2, 0]],
  Weeks: [['w', 1, 0]],
  Months: [['m', 1, 26], ['m', 3, 0]],
  Year: [['m', 1, 26], ['m', 3, 30], ['y', 1, 0]],
};
/** Days per unit. */
const SPAN = { h: 1 / 24, d: 1, w: 7, m: 30.44, y: 365.25 };
/** Most zoomed in: 96 px per hour. */
export const PPD_MAX = 24 * 96;
/** Zoom presets: visible span in days. */
export const PRESETS = { Hours: 1, Days: 9, Weeks: 42, Months: 124, Year: 365 };
/** @typedef {keyof typeof PRESETS} Preset */

/**
 * The zoom level a visible span reads as: the preset nearest to it on a log scale.
 * @param {number} days Days in view.
 * @returns {Preset}
 */
export function levelOf(days) {
  const names = /** @type {Preset[]} */ (Object.keys(PRESETS));
  const off = (/** @type {Preset} */ p) => Math.abs(Math.log(days / PRESETS[p]));
  return names.reduce((best, p) => (off(p) < off(best) ? p : best));
}

/**
 * First-of-month day indices in [a, b], every `step` months (aligned to January).
 * @param {number} a
 * @param {number} b
 * @param {number} [step]
 * @returns {{i: number, y: number, m: number}[]}
 */
function monthStarts(a, b, step = 1) {
  const d = dateOf(a), out = [];
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  m = Math.floor(m / step) * step;
  for (;;) {
    const i = Date.UTC(y, m, 1) / 864e5;
    if (i > b) break;
    if (i >= a) out.push({ i, y: new Date(i * 864e5).getUTCFullYear(), m: new Date(i * 864e5).getUTCMonth() });
    m += step;
    if (m > 11) y += Math.floor(m / 12), m %= 12;
  }
  return out;
}

/**
 * Lists labelled ticks in [a, b] at the zoom level's scale. Each list also
 * holds the tick just before `a`, so the period the view starts in keeps a
 * label.
 * @param {number} a First visible day.
 * @param {number} b Last visible day.
 * @param {number} ppd Pixels per day.
 * @param {Preset} level Zoom level, from {@link levelOf} or the preset picked.
 * @returns {{k: Unit, n: number, minor: [number, string][], major: [number, string][]}}
 */
export function axisTicks(a, b, ppd, level) {
  const steps = STEPS[level];
  const [k, n] = steps.find(([u, c, px]) => SPAN[u] * c * ppd >= px) ?? steps[steps.length - 1];
  /** @type {[number, string][]} */
  const minor = [];
  /** @type {[number, string][]} */
  const major = [];
  /** First-of-month (every `step` months) from the one at or before `a`. */
  const from = (/** @type {number} */ step) => monthStarts(a - SPAN.m * step - 1, b, step).filter((s, i, all) => s.i >= a || !all[i + 1] || all[i + 1].i > a);
  const months = () => from(1).forEach((s) => major.push([s.i, `${MONL[s.m]} ${s.y}`]));
  if (k === 'h') {
    for (let H = Math.floor(a * 24 / n) * n; H / 24 <= b; H += n) minor.push([H / 24, `${String(((H % 24) + 24) % 24).padStart(2, '0')}:00`]);
    for (let i = Math.floor(a); i <= b; i++) major.push([i, fmt(i, { weekday: 'short' })]);
  } else if (k === 'd' || k === 'w') {
    let i = Math.floor(a);
    if (k === 'w') while (dateOf(i).getUTCDay() !== 1) i--;
    else if (n === 2 && i % 2) i--;
    const step = k === 'w' ? 7 : n, wide = ppd * step >= 76, dated = ppd * step >= 52;
    for (; i <= b; i += step) {
      const dt = dateOf(i);
      minor.push([i, k === 'w' && dated ? fmt(i) : (wide ? WD[dt.getUTCDay()] + ' ' : '') + dt.getUTCDate()]);
    }
    months();
  } else if (k === 'm') {
    from(n).forEach((s) => minor.push([s.i, MON[s.m]]));
    from(12).forEach((s) => major.push([s.i, String(s.y)]));
  } else {
    from(12).forEach((s) => minor.push([s.i, String(s.y)]));
  }
  return { k, n, minor, major };
}

/**
 * The zoom controls: preset buttons, then the slider between − and +.
 * Elements carry `data-zp` (presets group), `data-p` (a preset) and
 * `data-zs` (the slider) so a view can find them without ids.
 * @returns {string} HTML.
 */
export const zoomControls = () =>
  `<div class="seg" data-zp role="group" aria-label="Zoom presets">${Object.keys(PRESETS).map((p) => `<button data-p="${p}">${p}</button>`).join('')}</div>
  <label class="zoom"><span class="mono" aria-hidden="true">−</span><input data-zs type="range" min="0" max="1000" aria-label="Zoom level"><span class="mono" aria-hidden="true">+</span></label>`;

/**
 * Slider position (0..1000, log scale) for a zoom level.
 * @param {number} p Pixels per day.
 * @param {number} min Fully zoomed out.
 * @returns {number}
 */
export const toSlider = (p, min) => Math.round(1000 * Math.log(p / min) / Math.log(PPD_MAX / min));

/**
 * Zoom level for a slider position.
 * @param {number} v 0..1000.
 * @param {number} min Fully zoomed out.
 * @returns {number} Pixels per day.
 */
export const fromSlider = (v, min) => min * Math.pow(PPD_MAX / min, v / 1000);

/**
 * Wires Ctrl+scroll (also a trackpad pinch), two-finger pinch and the +/−
 * keys on a scroller, each zooming around the pointer.
 * @param {HTMLElement} sc The horizontal scroller.
 * @param {() => number} ppd Current pixels per day.
 * @param {(p: number, anchor?: number) => void} zoomTo Zooms to `p`, keeping the day at `anchor` (px inside `sc`) fixed.
 */
export function wireZoom(sc, ppd, zoomTo) {
  const at = (/** @type {number} */ clientX) => clientX - sc.getBoundingClientRect().left;
  sc.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomTo(ppd() * Math.exp(-e.deltaY * 0.01), at(e.clientX));
  }, { passive: false });
  /** @type {{d: number, p: number, cx: number} | null} */
  let pinch = null;
  const dist = (/** @type {TouchList} */ t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  sc.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) pinch = { d: dist(e.touches), p: ppd(), cx: at((e.touches[0].clientX + e.touches[1].clientX) / 2) };
  }, { passive: true });
  sc.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length === 2) { e.preventDefault(); zoomTo(pinch.p * dist(e.touches) / pinch.d, pinch.cx); }
  }, { passive: false });
  sc.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });
  sc.addEventListener('keydown', (e) => {
    if (e.target === sc && (e.key === '+' || e.key === '-' || e.key === '=')) zoomTo(ppd() * (e.key === '-' ? 0.7 : 1.4));
  });
}

/**
 * Axis ticks and labels, plus gridlines and weekend shading, for days a..b.
 * Labels of the period the view starts in stick to its left edge until the
 * next one pushes them out.
 * @param {number} a First visible day.
 * @param {number} b Last visible day.
 * @param {number} ppd Pixels per day.
 * @param {(day: number) => number} x Pixel offset of a day on the axis.
 * @param {number} left Pixel offset (on the axis) of the view's left edge.
 * @param {Preset} level Zoom level the axis reads at.
 * @param {number} [gx] Extra offset for the gridlines (when they're drawn in a wider layer).
 * @returns {{axis: string, grid: string}} Axis and grid HTML.
 */
export function axisMarks(a, b, ppd, x, left, level, gx = 0) {
  const { k, minor, major } = axisTicks(a, b, ppd, level);
  let axis = '', grid = '';
  if ((k === 'h' || k === 'd') && ppd >= 14) {
    for (let i = Math.floor(a); i <= b; i++) {
      const wd = dateOf(i).getUTCDay();
      if (wd === 0 || wd === 6) grid += `<i class="we" style="left:${gx + x(i)}px;width:${ppd}px"></i>`;
    }
  }
  /** Where a label goes: at its tick, or held at the view's left edge until the next tick (less `room`) pushes it out. */
  const at = (/** @type {[number, string][]} */ list, /** @type {number} */ j, /** @type {number} */ pad, /** @type {number} */ room) => {
    const X = x(list[j][0]), next = list[j + 1] ? x(list[j + 1][0]) : Infinity;
    return Math.max(X + pad, Math.min(left + pad, next - room));
  };
  minor.forEach(([i, lab], j) => {
    const X = x(i);
    if (i >= a) axis += `<i class="tk" style="left:${X}px"></i>`, grid += `<i class="gl" style="left:${gx + X}px"></i>`;
    axis += `<span class="tkl" style="left:${i >= a ? X + 4 : at(minor, j, 4, lab.length * 7 + 10)}px">${lab}</span>`;
  });
  major.forEach(([i, lab], j) => {
    if (i >= a) grid += `<i class="gl m" style="left:${gx + x(i)}px"></i>`;
    axis += `<span class="mj" style="left:${at(major, j, 6, lab.length * 7 + 16)}px">${lab}</span>`;
  });
  const today = nowIdx();
  if (today >= a && today <= b) axis += `<span class="todaytag" style="left:${x(today)}px">Today</span>`;
  return { axis, grid };
}

/**
 * Presses the button of the zoom level in view.
 * @param {HTMLElement} group The presets group.
 * @param {Preset} level
 */
export function markPreset(group, level) {
  group.querySelectorAll('button').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.p === level)));
}
