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
/** Tick units from finest to coarsest: [unit, count]. */
const UNITS = /** @type {const} */ ([['h', 1], ['h', 3], ['h', 6], ['h', 12], ['d', 1], ['d', 2], ['w', 1], ['m', 1], ['m', 3], ['y', 1]]);
/** Days per unit. */
const SPAN = { h: 1 / 24, d: 1, w: 7, m: 30.44, y: 365.25 };
/** Most zoomed in: 96 px per hour. */
export const PPD_MAX = 24 * 96;
/** Zoom presets: visible span in days. */
export const PRESETS = { Hours: 1, Days: 9, Weeks: 42, Months: 124, Year: 365 };
/** @typedef {keyof typeof PRESETS} Preset */

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
 * Picks a tick unit for the zoom level and lists labelled ticks in [a, b].
 * @param {number} a First visible day.
 * @param {number} b Last visible day.
 * @param {number} ppd Pixels per day.
 * @returns {{k: string, n: number, minor: [number, string][], major: [number, string][]}}
 */
export function axisTicks(a, b, ppd) {
  const [k, n] = UNITS.find(([u, c]) => SPAN[u] * c * ppd >= 58) ?? UNITS[UNITS.length - 1];
  /** @type {[number, string][]} */
  const minor = [];
  /** @type {[number, string][]} */
  const major = [];
  const months = () => monthStarts(a, b).forEach((s) => major.push([s.i, `${MONL[s.m]} ${s.y}`]));
  if (k === 'h') {
    for (let H = Math.floor(a * 24 / n) * n; H / 24 <= b; H += n) minor.push([H / 24, `${String(((H % 24) + 24) % 24).padStart(2, '0')}:00`]);
    for (let i = Math.floor(a); i <= b; i++) major.push([i, fmt(i, { weekday: 'short' })]);
  } else if (k === 'd' || k === 'w') {
    let i = Math.floor(a);
    if (k === 'w') while (dateOf(i).getUTCDay() !== 1) i++;
    else if (n === 2 && i % 2) i++;
    const wide = ppd * n >= 76;
    for (; i <= b; i += k === 'w' ? 7 : n) {
      const dt = dateOf(i);
      minor.push([i, k === 'w' ? fmt(i) : (wide ? WD[dt.getUTCDay()] + ' ' : '') + dt.getUTCDate()]);
    }
    months();
  } else if (k === 'm') {
    monthStarts(a, b, n).forEach((s) => minor.push([s.i, MON[s.m]]));
    monthStarts(a, b, 12).forEach((s) => major.push([s.i, String(s.y)]));
  } else {
    monthStarts(a, b, 12).forEach((s) => minor.push([s.i, String(s.y)]));
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
 * Major labels stick to the left edge of the view until the next one
 * pushes them out.
 * @param {number} a First visible day.
 * @param {number} b Last visible day.
 * @param {number} ppd Pixels per day.
 * @param {(day: number) => number} x Pixel offset of a day on the axis.
 * @param {number} left Pixel offset (on the axis) of the view's left edge.
 * @param {number} [gx] Extra offset for the gridlines (when they're drawn in a wider layer).
 * @returns {{axis: string, grid: string, scale: string}} Axis and grid HTML, and the scale's name (Hours … Years).
 */
export function axisMarks(a, b, ppd, x, left, gx = 0) {
  const { k, n, minor, major } = axisTicks(a, b, ppd);
  let axis = '', grid = '';
  if ((k === 'h' || k === 'd') && ppd >= 14) {
    for (let i = Math.floor(a); i <= b; i++) {
      const wd = dateOf(i).getUTCDay();
      if (wd === 0 || wd === 6) grid += `<i class="we" style="left:${gx + x(i)}px;width:${ppd}px"></i>`;
    }
  }
  minor.forEach(([i, lab]) => {
    const X = x(i);
    axis += `<i class="tk" style="left:${X}px"></i><span class="tkl" style="left:${X + 4}px">${lab}</span>`;
    grid += `<i class="gl" style="left:${gx + X}px"></i>`;
  });
  major.forEach(([i, lab], j) => {
    const X = x(i), next = major[j + 1] ? x(major[j + 1][0]) : Infinity;
    axis += `<span class="mj" style="left:${Math.max(X + 6, Math.min(left + 6, next - 120))}px">${lab}</span>`;
    grid += `<i class="gl m" style="left:${gx + X}px"></i>`;
  });
  const today = nowIdx();
  if (today >= a && today <= b) axis += `<span class="todaytag" style="left:${x(today)}px">Today</span>`;
  const scale = { h: 'Hours', d: 'Days', w: 'Weeks', m: n === 3 ? 'Quarters' : 'Months', y: 'Years' }[k] ?? '';
  return { axis, grid, scale };
}

/**
 * Marks the preset that matches: the one picked last, else the one closest
 * to the axis scale.
 * @param {HTMLElement} group The presets group.
 * @param {string | null} active Preset picked last, if you haven't zoomed by hand since.
 * @param {string} scale Axis scale name from {@link axisMarks}.
 */
export function markPreset(group, active, scale) {
  const match = active ?? { Hours: 'Hours', Days: 'Days', Weeks: 'Weeks', Months: 'Months', Quarters: 'Year', Years: 'Year' }[scale];
  group.querySelectorAll('button').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.p === match)));
}
