// @ts-check
/**
 * The zoom timeline: a horizontal Gantt that zooms from hours to years.
 * Each lane is a row of bars (windows, stays, the flights between them);
 * under them, a fare strip shows what each possible departure day costs.
 *
 * @module
 */
import {
  childrenOf, clamp, dateOf, fareOn, fmt, hhmm, isRanged, layout, money, nowIdx, pivotOf, rangeOf, routeLabel, stayCost,
} from './model.js';
import { $, drag, esc, heat, PLANE } from './ui.js';

/** @typedef {import('./ui.js').App} App */
/** @typedef {import('./model.js').StayBar} StayBar */

const WD = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** Tick units from finest to coarsest: [unit, count]. */
const UNITS = /** @type {const} */ ([['h', 1], ['h', 3], ['h', 6], ['h', 12], ['d', 1], ['d', 2], ['w', 1], ['m', 1], ['m', 3], ['y', 1]]);
/** Days per unit. */
const SPAN = { h: 1 / 24, d: 1, w: 7, m: 30.44, y: 365.25 };
/** Row geometry in px. */
const AXIS = 48, ROW = 44, FARE = 24;
/** Most zoomed in: 96 px per hour. */
const PPD_MAX = 24 * 96;
/** Zoom presets: visible span in days. */
const PRESETS = { Hours: 1, Days: 9, Weeks: 42, Months: 124, Year: 365 };

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
function axisTicks(a, b, ppd) {
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
 * Earliest departure hour among routes leaving after a stay, used to end
 * the stay's bar a little before its flight.
 * @param {import('./model.js').PlanDoc} doc
 * @param {string} id
 * @returns {number | undefined}
 */
function firstDeparture(doc, id) {
  const hours = childrenOf(doc, id).flatMap((k) => (k.route && doc.routes[k.route] ? [doc.routes[k.route].depart] : []));
  return hours.length ? Math.min(...hours) : undefined;
}

export class Timeline {
  /**
   * Builds the timeline's controls and frame inside `el` and wires zoom,
   * pinch, drag and selection.
   * @param {HTMLElement} el Container.
   * @param {App} app
   */
  constructor(el, app) {
    this.app = app;
    /** Pixels per day; 0 until the first layout. */
    this.ppd = 0;
    /** First and last day drawn. */
    this.d0 = 0;
    this.d1 = 1;
    /** Set briefly after a drag so the trailing click doesn't select. */
    this.justDragged = false;
    el.innerHTML = `
<div class="tools">
  <div class="seg" id="g-pre" role="group" aria-label="Zoom presets">${Object.keys(PRESETS).map((p) => `<button data-p="${p}">${p}</button>`).join('')}</div>
  <label class="zoom"><span class="mono" aria-hidden="true">−</span><input id="g-zoom" type="range" min="0" max="1000" aria-label="Zoom level"><span class="mono" aria-hidden="true">+</span></label>
  <span class="hint">Pinch or Ctrl+scroll to zoom. Drag a bar's end to change its length. Tap a fare to leave that day.</span>
</div>
<div class="g-frame">
  <div class="g-labels" id="g-labels"></div>
  <div class="g-scroll" id="g-scroll"><div class="g-inner" id="g-inner">
    <div class="g-axis" id="g-axis"></div>
    <div class="g-rows"><div class="g-grid" id="g-grid"></div><div class="g-bars" id="g-bars"></div></div>
  </div></div>
</div>`;
    this.sc = $('#g-scroll', el);
    this.inner = $('#g-inner', el);
    this.axis = $('#g-axis', el);
    this.grid = $('#g-grid', el);
    this.bars = $('#g-bars', el);
    this.labels = $('#g-labels', el);
    this.zoom = /** @type {HTMLInputElement} */ ($('#g-zoom', el));
    this.pre = $('#g-pre', el);
    /** Lane count from the last render, for gridlines. */
    this.laneCount = 0;
    /** When true, the next render with a measurable width jumps to the Months preset. */
    this.fresh = true;
    /** Preset picked last, until you zoom by hand. */
    this.active = /** @type {string | null} */ (null);
    this.wire(el);
  }

  /**
   * Attaches all event listeners.
   * @param {HTMLElement} el Container.
   */
  wire(el) {
    let raf = 0;
    this.sc.addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => this.drawAxis()); }, { passive: true });
    this.zoom.addEventListener('input', () => this.zoomTo(this.fromSlider(+this.zoom.value)));
    this.pre.addEventListener('click', (e) => {
      const b = /** @type {HTMLElement} */ (e.target).closest('button');
      if (b) this.preset(/** @type {keyof typeof PRESETS} */ (b.dataset.p));
    });
    this.sc.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.zoomTo(this.ppd * Math.exp(-e.deltaY * 0.01), e.clientX - this.sc.getBoundingClientRect().left);
    }, { passive: false });

    /** @type {{d: number, p: number, cx: number} | null} */
    let pinch = null;
    const dist = (/** @type {TouchList} */ t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    this.sc.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        pinch = { d: dist(e.touches), p: this.ppd, cx: (e.touches[0].clientX + e.touches[1].clientX) / 2 - this.sc.getBoundingClientRect().left };
      }
    }, { passive: true });
    this.sc.addEventListener('touchmove', (e) => {
      if (pinch && e.touches.length === 2) { e.preventDefault(); this.zoomTo(pinch.p * dist(e.touches) / pinch.d, pinch.cx); }
    }, { passive: false });
    this.sc.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });

    this.bars.addEventListener('pointerdown', (e) => {
      const h = /** @type {HTMLElement} */ (e.target).closest('.handle');
      if (!(h instanceof HTMLElement)) return;
      const id = /** @type {string} */ (h.dataset.id), start = +(h.dataset.start ?? 0), frac = +(h.dataset.frac ?? 0);
      drag(e, (ev) => {
        const day = (ev.clientX - this.sc.getBoundingClientRect().left + this.sc.scrollLeft) / this.ppd + this.d0;
        this.app.setNights(id, Math.round(day - frac - start));
      }, () => { this.justDragged = true; setTimeout(() => { this.justDragged = false; }, 60); });
    });
    this.bars.addEventListener('click', (e) => {
      const t = /** @type {HTMLElement} */ (e.target).closest('[data-sel]');
      if (!(t instanceof HTMLElement) || this.justDragged) return;
      if (t.dataset.pivot) this.app.setNights(t.dataset.pivot, +(t.dataset.nights ?? 0));
      this.app.select(/** @type {string} */ (t.dataset.sel));
    });
    el.addEventListener('keydown', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (t.classList.contains('handle')) {
        const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
        const s = /** @type {StayBar | undefined} */ (this.app.doc.bars.find((b) => b.id === t.dataset.id));
        if (step && s) { e.preventDefault(); this.app.setNights(s.id, s.nights + step); }
      } else if (t === this.sc && (e.key === '+' || e.key === '-' || e.key === '=')) {
        this.zoomTo(this.ppd * (e.key === '-' ? 0.7 : 1.4));
      }
    });
  }

  /** @returns {number} Visible width of the scroller. */
  w() { return this.sc.clientWidth || 600; }
  /** @returns {number} Fully zoomed out: the whole range fits. */
  ppdMin() { return this.w() / (this.d1 - this.d0); }
  /**
   * Slider position (0..1000, log scale) for a zoom level.
   * @param {number} p Pixels per day.
   * @returns {number}
   */
  toSlider(p) { return Math.round(1000 * Math.log(p / this.ppdMin()) / Math.log(PPD_MAX / this.ppdMin())); }
  /**
   * Zoom level for a slider position.
   * @param {number} v 0..1000.
   * @returns {number} Pixels per day.
   */
  fromSlider(v) { return this.ppdMin() * Math.pow(PPD_MAX / this.ppdMin(), v / 1000); }
  /**
   * X position of a (fractional) day.
   * @param {number} i Day index.
   * @returns {number}
   */
  x(i) { return (i - this.d0) * this.ppd; }

  /**
   * Zooms while keeping the day under `anchor` fixed on screen.
   * @param {number} p New pixels per day.
   * @param {number} [anchor] Pixel offset inside the scroller.
   */
  zoomTo(p, anchor = this.w() / 2) {
    this.active = null;
    const day = (this.sc.scrollLeft + anchor) / this.ppd + this.d0;
    this.ppd = clamp(p, this.ppdMin(), PPD_MAX);
    this.render();
    this.sc.scrollLeft = (day - this.d0) * this.ppd - anchor;
    this.drawAxis();
  }

  /**
   * Jumps to a preset span, centred on what matters at that scale: the
   * departure day for short spans, the whole plan for long ones.
   * @param {keyof typeof PRESETS} name
   */
  preset(name) {
    const { doc } = this.app, at = layout(doc), placed = [...at.values()];
    const pivot = pivotOf(doc), today = nowIdx();
    const focus = pivot ? /** @type {import('./model.js').Placed} */ (at.get(pivot.id)).end : today;
    const mid = placed.length
      ? (Math.min(...placed.map((p) => p.start)) + Math.max(...placed.map((p) => p.end))) / 2
      : today;
    const center = { Hours: focus + 0.45, Days: focus + 2, Weeks: focus, Months: mid, Year: mid }[name];
    this.fresh = false;
    this.active = name;
    this.updateRange();
    this.ppd = clamp(this.w() / PRESETS[name], this.ppdMin(), PPD_MAX);
    this.render();
    this.sc.scrollLeft = this.x(center) - this.w() / 2;
    this.drawAxis();
  }

  /** Forgets the zoom so the next render starts at the Months preset. */
  reset() { this.fresh = true; }

  /**
   * Sets the drawn range: from the month before the first bar (or today) to
   * well past the last.
   * @returns {number} Pixels the content moved right, to keep the view steady.
   */
  updateRange() {
    const placed = [...layout(this.app.doc).values()], today = nowIdx();
    const lo = placed.length ? Math.min(...placed.map((p) => p.start)) : today;
    const hi = placed.length ? Math.max(...placed.map((p) => p.end), lo + 1) : today;
    const first = dateOf(Math.min(lo, today) - 14);
    const d0 = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1) / 864e5;
    const shift = this.ppd ? (this.d0 - d0) * this.ppd : 0;
    this.d0 = d0;
    this.d1 = Math.max(hi + 120, d0 + 400);
    return shift;
  }

  /** Redraws lanes, bars, flights and the fare strip for the current plan and zoom. */
  render() {
    if (this.fresh && this.app.doc.bars.length && this.sc.clientWidth) return this.preset('Months');
    const { doc, filter, sel } = this.app;
    const at = layout(doc), today = nowIdx();
    const showStay = filter === 'all' || filter === 'stays', showTravel = filter === 'all' || filter === 'travel';
    const shift = this.updateRange();
    this.ppd = this.ppd ? clamp(this.ppd, this.ppdMin(), PPD_MAX) : this.ppdMin();
    const p = this.ppd, x = (/** @type {number} */ i) => this.x(i);

    const lanes = [...new Set(doc.bars.map((b) => b.lane))];
    const pivot = pivotOf(doc), pp = pivot && at.get(pivot.id);
    const fareRoutes = pivot ? [...new Set(childrenOf(doc, pivot.id).flatMap((k) => (k.route ? [k.route] : [])))] : [];
    const height = AXIS + lanes.length * ROW + (fareRoutes.length ? fareRoutes.length * FARE + 12 : 0);
    this.laneCount = lanes.length;
    this.inner.style.width = `${(this.d1 - this.d0) * p}px`;
    this.inner.style.height = `${height}px`;
    this.zoom.value = String(this.toSlider(p));

    // Lane labels.
    this.labels.innerHTML = `<div class="g-lab"><small id="g-scale"></small></div>` + lanes.map((lane) => {
      const b = /** @type {import('./model.js').Bar} */ (doc.bars.find((x) => x.lane === lane));
      const sub = b.kind === 'window' ? 'fixed' : isRanged(b) ? `${b.minNights}–${b.maxNights} nights` : b.after ? 'option' : `${b.nights} nights`;
      return `<div class="g-lab"><span>${esc(lane)}</span><small>${sub}</small></div>`;
    }).join('') + fareRoutes.map((k, n) => `<div class="g-lab fare"${n ? '' : ' style="margin-top:8px"'}>${esc(doc.routes[k].to)} fares</div>`).join('');

    let h = '';
    /**
     * One bar button.
     * @param {string} id Selection key.
     * @param {string} cls Extra classes.
     * @param {number} l Left px.
     * @param {number} w Width px.
     * @param {number} top Top px.
     * @param {string} text Label (already escaped).
     */
    const bar = (id, cls, l, w, top, text) =>
      `<button class="bar ${cls}${w < 72 ? ' tight' : ''}${sel === id ? ' sel' : ''}" data-sel="${esc(id)}" style="left:${l}px;width:${Math.max(w, 2)}px;top:${top}px" title="${text}"><span>${text}</span></button>`;

    for (const b of doc.bars) {
      const pl = /** @type {import('./model.js').Placed} */ (at.get(b.id)), top = lanes.indexOf(b.lane) * ROW + 6;
      if (b.kind === 'window') {
        const l = x(pl.start), r = x(pl.end);
        h += bar(`bar:${b.id}`, 'window', l, r - l, top, esc(`${b.name} · ${b.days} days · ${fmt(pl.start)} – ${fmt(pl.end - 1)}`));
        h += `<div class="dl" style="left:${r}px"></div><span class="dlab" style="left:${r + 6}px;top:${top + 8}px">Leave by ${fmt(pl.end - 1)}</span>`;
        continue;
      }
      const route = b.route ? doc.routes[b.route] : undefined;
      const s0 = pl.start + (route ? (route.depart + route.hours) / 24 : 0);
      const frac = ((firstDeparture(doc, b.id) ?? 14) - 2) / 24, s1 = pl.end + frac;
      if (isRanged(b)) {
        h += `<div class="track c-${b.color}" style="left:${x(pl.start + b.minNights + frac)}px;width:${(b.maxNights - b.minNights) * p}px;top:${top}px"></div>`;
      }
      const cost = showStay ? ` · ${money(stayCost(b).total, doc.currency)}` : '';
      h += bar(`bar:${b.id}`, `c-${b.color}`, x(s0), x(s1) - x(s0), top, esc(`${b.name} · ${b.nights} night${b.nights === 1 ? '' : 's'}`) + cost);
      if (x(s1) - x(s0) > 28) {
        const [mn, mx] = isRanged(b) ? [b.minNights, b.maxNights] : [1, 999];
        h += `<div class="handle" data-id="${esc(b.id)}" data-start="${pl.start}" data-frac="${frac}" style="left:${x(s1) - 16}px;top:${top}px" role="slider" tabindex="0" aria-label="Length of ${esc(b.name)}" aria-valuemin="${mn}" aria-valuemax="${mx}" aria-valuenow="${b.nights}" aria-valuetext="${b.nights} nights, leave ${fmt(pl.end)}"></div>`;
      }
      if (route) {
        const f0 = x(pl.start + route.depart / 24), fw = Math.max(4, route.hours / 24 * p), fare = fareOn(route, pl.start);
        const id = `fare:${b.route}:${pl.start}`;
        const price = showTravel ? money(fare, doc.currency) : '';
        if (fw > 170) {
          h += `<button class="bar fl wide${sel === id ? ' sel' : ''}" data-sel="${esc(id)}" style="left:${f0}px;width:${fw}px;top:${top + 5}px"><span>${esc(routeLabel(route))} ${hhmm(route.depart)}–${hhmm(route.depart + route.hours)}${price && ' · ' + price}</span></button>`;
        } else {
          h += `<button class="bar fl" data-sel="${esc(id)}" style="left:${f0}px;width:${fw}px;top:${top + 11}px" aria-label="${esc(routeLabel(route))} flight"></button>`;
          h += `<button class="ftag" data-sel="${esc(id)}" style="left:${f0 - 4}px;top:${top + 6}px">${PLANE}${price}</button>`;
        }
      }
    }

    // Fare strip: one row per route leaving the pivot, one cell per possible departure day.
    if (pivot && pp) {
      const [mn, mx] = rangeOf(pivot), base = lanes.length * ROW + 10;
      fareRoutes.forEach((k, n) => {
        const r = doc.routes[k], top = base + n * FARE, vals = [];
        for (let i = mn; i <= mx; i++) vals.push(fareOn(r, pp.start + i));
        const flo = Math.min(...vals), fhi = Math.max(...vals);
        vals.forEach((v, j) => {
          const day = pp.start + mn + j, c = heat(v, flo, fhi);
          h += `<button class="fc${c.cls}${day === pp.end ? ' on' : ''}${showTravel ? '' : ' off'}" data-sel="fare:${esc(k)}:${day}" data-pivot="${esc(pivot.id)}" data-nights="${mn + j}" style="left:${x(day)}px;width:${p}px;top:${top}px;${c.style}" aria-label="${esc(routeLabel(r))} ${fmt(day)} ${money(v, doc.currency)}">${showTravel && p >= 36 ? money(v, doc.currency) : ''}</button>`;
        });
      });
    }
    h += `<div class="today" style="left:${x(today)}px"></div>`;
    this.bars.innerHTML = h;
    if (shift) this.sc.scrollLeft += shift;
    this.drawAxis();
  }

  /** Redraws the axis, gridlines and weekend shading for the visible window only. */
  drawAxis() {
    const p = this.ppd, sl = this.sc.scrollLeft, w = this.w();
    if (!p) return;
    const a = Math.max(this.d0, sl / p + this.d0 - 1), b = Math.min(this.d1, (sl + w) / p + this.d0 + 1);
    const { k, n, minor, major } = axisTicks(a, b, p);
    let ax = '', gr = '';
    if ((k === 'h' || k === 'd') && p >= 14) {
      for (let i = Math.floor(a); i <= b; i++) {
        const wd = dateOf(i).getUTCDay();
        if (wd === 0 || wd === 6) gr += `<i class="we" style="left:${this.x(i)}px;width:${p}px"></i>`;
      }
    }
    minor.forEach(([i, lab]) => {
      const X = this.x(i);
      ax += `<i class="tk" style="left:${X}px"></i><span class="tkl" style="left:${X + 4}px">${lab}</span>`;
      gr += `<i class="gl" style="left:${X}px"></i>`;
    });
    major.forEach(([i, lab], j) => {
      const X = this.x(i), next = major[j + 1] ? this.x(major[j + 1][0]) : Infinity;
      ax += `<span class="mj" style="left:${Math.max(X + 6, Math.min(sl + 6, next - 120))}px">${lab}</span>`;
      gr += `<i class="gl m" style="left:${X}px"></i>`;
    });
    ax += `<span class="todaytag" style="left:${this.x(nowIdx())}px">Today</span>`;
    for (let r = 1; r <= this.laneCount; r++) gr += `<i class="hl" style="top:${r * ROW}px"></i>`;
    this.axis.innerHTML = ax;
    this.grid.innerHTML = gr;
    const name = { h: 'Hours', d: 'Days', w: 'Weeks', m: n === 3 ? 'Quarters' : 'Months', y: 'Years' }[k] ?? '';
    const scale = document.getElementById('g-scale');
    if (scale) scale.textContent = name;
    const match = this.active ?? { Hours: 'Hours', Days: 'Days', Weeks: 'Weeks', Months: 'Months', Quarters: 'Year', Years: 'Year' }[name];
    this.pre.querySelectorAll('button').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.p === match)));
  }
}
