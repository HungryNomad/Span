// @ts-check
/**
 * The zoom timeline: a horizontal Gantt that zooms from hours to years.
 * Each row is one item; items holding others expand in place (desktop) or
 * drill in (phone). Under the rows, a fare strip shows what each possible
 * departure day costs.
 *
 * @module
 */
import {
  ancestors, byId, clamp, counted, coverage, dateOf, departRoutes, fareOn, fmt, hhmm, inGroup, isRanged, kidsOf,
  layout, money, nowIdx, pivotOf, rangeOf, routeLabel, setRank, total, unitText, UNIT_DAYS,
} from './model.js';
import { $, drag, esc, heat, PLANE } from './ui.js';

/** @typedef {import('./ui.js').App} App */
/** @typedef {import('./model.js').Item} Item */
/** @typedef {import('./model.js').Placed} Placed */
/** @typedef {import('./model.js').PlanDoc} PlanDoc */
/** @typedef {{item: Item, depth: number}} Row */

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
/** Deepest level that expands in place on desktop (0-based); deeper items drill in. */
const MAX_OPEN_DEPTH = 1;
/** Long-press before a touch drag moves a bar, in ms. */
const HOLD_MS = 350;
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
 * Rows the timeline shows, in order: the whole plan's top level (or the
 * drilled-in item) plus whatever is open beneath.
 * @param {App} app
 * @returns {Row[]}
 */
export function visibleRows(app) {
  const { doc, drill } = app, root = byId(doc, drill ?? undefined);
  /** @type {Row[]} */
  const out = [];
  /** @param {Item} it @param {number} depth */
  const walk = (it, depth) => {
    out.push({ item: it, depth });
    if (isOpen(app, it, depth, !!root)) kidsOf(doc, it.id).forEach((k) => walk(k, depth + 1));
  };
  (root ? [root] : kidsOf(doc, undefined)).forEach((it) => walk(it, 0));
  return out;
}

/**
 * Whether an item's children show as rows under it.
 * @param {App} app
 * @param {Item} it
 * @param {number} depth Row depth (0 = top of the current view).
 * @param {boolean} drilled Whether the view is drilled into an item.
 * @returns {boolean}
 */
function isOpen(app, it, depth, drilled) {
  if (depth === 0 && drilled) return true;
  if (app.narrow) return depth === 0 && it.kind === 'group';
  return depth <= MAX_OPEN_DEPTH && app.open.has(it.id);
}

/**
 * What tapping an item's chevron does here: expand in place, or drill in.
 * @param {App} app
 * @param {number} depth
 * @returns {'toggle' | 'drill'}
 */
const chevronAction = (app, depth) => (!app.narrow && depth <= MAX_OPEN_DEPTH ? 'toggle' : 'drill');

/**
 * Earliest departure hour among routes leaving after an item, used to end
 * the item's bar a little before its flight.
 * @param {PlanDoc} doc
 * @param {string} id
 * @returns {number | undefined}
 */
function firstDeparture(doc, id) {
  const hours = departRoutes(doc, id).map((k) => doc.routes[k].depart);
  return hours.length ? Math.min(...hours) : undefined;
}

/**
 * The route an item arrives by: its first fare-priced cost.
 * @param {PlanDoc} doc
 * @param {Item} it
 * @returns {[string, import('./model.js').Route] | undefined}
 */
function arrival(doc, it) {
  const c = it.costs.find((l) => l.type === 'date' && l.route && doc.routes[l.route]);
  return c?.route ? [c.route, doc.routes[c.route]] : undefined;
}

/**
 * Where an item's bar starts and ends on screen, in fractional days. Nights
 * run from check-in (or the flight's arrival) to check-out (a little before
 * the next flight); days and hours are drawn exactly.
 * @param {PlanDoc} doc
 * @param {Placed} p
 * @returns {[number, number]}
 */
function barSpan(doc, p) {
  const it = p.item;
  if (it.unit !== 'night' || it.kind !== 'item') return [p.start, p.show];
  const r = arrival(doc, it)?.[1];
  return [p.start + (r ? r.depart + r.hours : 14) / 24, p.end + ((firstDeparture(doc, it.id) ?? 12) - 2) / 24];
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
    /** True while a bar is being dragged by touch, so the page doesn't scroll. */
    this.touchDrag = false;
    /** Rows from the last render. */
    this.rows = /** @type {Row[]} */ ([]);
    el.innerHTML = `
<div class="tools">
  <div class="seg" id="g-pre" role="group" aria-label="Zoom presets">${Object.keys(PRESETS).map((p) => `<button data-p="${p}">${p}</button>`).join('')}</div>
  <label class="zoom"><span class="mono" aria-hidden="true">−</span><input id="g-zoom" type="range" min="0" max="1000" aria-label="Zoom level"><span class="mono" aria-hidden="true">+</span></label>
  <span class="hint" id="g-hint"></span>
</div>
<nav class="crumbs" id="g-crumbs" aria-label="Where you are" hidden></nav>
<div class="g-frame">
  <div class="g-labels" id="g-labels"></div>
  <div class="g-scroll" id="g-scroll"><div class="g-inner" id="g-inner">
    <div class="g-axis" id="g-axis"></div>
    <div class="g-rows" id="g-rows"><div class="g-grid" id="g-grid"></div><div class="g-bars" id="g-bars"></div></div>
  </div></div>
</div>`;
    this.sc = $('#g-scroll', el);
    this.inner = $('#g-inner', el);
    this.axis = $('#g-axis', el);
    this.grid = $('#g-grid', el);
    this.bars = $('#g-bars', el);
    this.labels = $('#g-labels', el);
    this.crumbs = $('#g-crumbs', el);
    this.zoom = /** @type {HTMLInputElement} */ ($('#g-zoom', el));
    this.pre = $('#g-pre', el);
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
      if (this.touchDrag) e.preventDefault();
      else if (pinch && e.touches.length === 2) { e.preventDefault(); this.zoomTo(pinch.p * dist(e.touches) / pinch.d, pinch.cx); }
    }, { passive: false });
    this.sc.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });
    this.bars.addEventListener('contextmenu', (e) => { if (/** @type {HTMLElement} */ (e.target).closest('.bar')) e.preventDefault(); });

    this.bars.addEventListener('pointerdown', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      const h = t.closest('.handle');
      if (h instanceof HTMLElement) return this.resize(e, h);
      const b = t.closest('.bar[data-id]');
      if (b instanceof HTMLElement && e.button === 0) this.grab(e, b);
    });
    this.bars.addEventListener('click', (e) => {
      const t = /** @type {HTMLElement} */ (e.target).closest('[data-sel]');
      if (!(t instanceof HTMLElement) || this.justDragged) return;
      if (t.dataset.pivot) this.app.setLen(t.dataset.pivot, +(t.dataset.len ?? 0));
      this.app.select(/** @type {string} */ (t.dataset.sel));
    });
    this.labels.addEventListener('click', (e) => {
      const t = /** @type {HTMLElement} */ (e.target).closest('button');
      if (!t) return;
      if (t.dataset.tw) (t.dataset.act === 'toggle' ? this.app.toggle : this.app.drillTo)(t.dataset.tw);
      else if (t.dataset.sel) this.app.select(t.dataset.sel);
    });
    this.crumbs.addEventListener('click', (e) => {
      const t = /** @type {HTMLElement} */ (e.target).closest('button');
      if (t) this.app.drillTo(t.dataset.drill || null);
    });
    el.addEventListener('keydown', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (t.classList.contains('handle')) {
        const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
        const it = byId(this.app.doc, t.dataset.id);
        if (step && it?.len !== undefined) { e.preventDefault(); this.app.setLen(it.id, it.len + step * (it.unit === 'hour' ? 0.25 : 1)); }
      } else if (t === this.sc && (e.key === '+' || e.key === '-' || e.key === '=')) {
        this.zoomTo(this.ppd * (e.key === '-' ? 0.7 : 1.4));
      }
    });
  }

  /**
   * Fractional day under a pointer.
   * @param {PointerEvent} ev
   * @returns {number}
   */
  dayAt(ev) { return (ev.clientX - this.sc.getBoundingClientRect().left + this.sc.scrollLeft) / this.ppd + this.d0; }

  /** Marks a drag as just finished, so its trailing click doesn't select. */
  dropped() {
    this.justDragged = true;
    this.touchDrag = false;
    setTimeout(() => { this.justDragged = false; }, 60);
  }

  /**
   * Drags a bar's end handle to change its length.
   * @param {PointerEvent} e
   * @param {HTMLElement} h
   */
  resize(e, h) {
    const id = /** @type {string} */ (h.dataset.id), start = +(h.dataset.start ?? 0), frac = +(h.dataset.frac ?? 0);
    const it = byId(this.app.doc, id);
    if (!it) return;
    const per = UNIT_DAYS[it.unit], snap = it.unit === 'hour' ? 4 : 1;
    this.touchDrag = e.pointerType === 'touch';
    drag(e, (ev) => this.app.setLen(id, Math.round((this.dayAt(ev) - frac - start) / per * snap) / snap), () => this.dropped());
  }

  /**
   * Drags a bar: sideways moves it in time, up or down changes its rank
   * among its siblings. On touch, the bar needs a long press first so the
   * timeline still scrolls under a quick swipe.
   * @param {PointerEvent} e
   * @param {HTMLElement} b The bar.
   */
  grab(e, b) {
    const app = this.app, id = /** @type {string} */ (b.dataset.id), it = byId(app.doc, id);
    if (!it) return;
    const x0 = e.clientX, y0 = e.clientY, orig = it.offset, touch = e.pointerType === 'touch';
    const sibRows = this.rows.flatMap((r, i) => (r.item.parent === it.parent ? [{ i, item: r.item }] : []));
    const rowsTop = () => this.inner.getBoundingClientRect().top + AXIS;
    let armed = !touch, mode = /** @type {'move' | 'rank' | null} */ (null), target = -1;
    if (!touch) e.preventDefault();
    const timer = touch ? setTimeout(() => { armed = true; this.touchDrag = true; b.classList.add('lift'); navigator.vibrate?.(8); }, HOLD_MS) : 0;
    const move = (/** @type {PointerEvent} */ ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!armed) { if (Math.hypot(dx, dy) > 8) end(); return; }
      if (!mode) {
        if (Math.hypot(dx, dy) < 6) return;
        mode = Math.abs(dy) > Math.abs(dx) && sibRows.length > 1 ? 'rank' : 'move';
      }
      if (mode === 'move') {
        const days = dx / this.ppd, step = it.unit === 'hour' ? 96 : 1;
        const next = orig + Math.round(days * step) / step;
        app.change((doc) => { const cur = byId(doc, id); if (cur) cur.offset = next; });
        return;
      }
      b.style.transform = `translateY(${dy}px)`;
      const row = (ev.clientY - rowsTop()) / ROW - 0.5;
      const best = sibRows.reduce((a, s) => (Math.abs(s.i - row) < Math.abs(a.i - row) ? s : a), sibRows[0]);
      target = kidsOf(app.doc, it.parent).indexOf(best.item);
      this.bars.querySelector('.rank-mark')?.remove();
      this.bars.insertAdjacentHTML('beforeend', `<div class="rank-mark" style="top:${best.i * ROW + 2}px"></div>`);
    };
    const end = () => {
      clearTimeout(timer);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
      b.classList.remove('lift');
      b.style.transform = '';
      this.bars.querySelector('.rank-mark')?.remove();
      if (mode === 'rank' && target >= 0) app.change((doc) => setRank(doc, id, target));
      if (mode) this.dropped();
      else this.touchDrag = false;
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
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
   * departure day for short spans, everything in view for long ones.
   * @param {keyof typeof PRESETS} name
   */
  preset(name) {
    const { doc } = this.app, at = layout(doc), shown = this.viewPlaced(at);
    const pivot = pivotOf(doc), today = nowIdx();
    const focus = pivot && !this.app.drill ? /** @type {Placed} */ (at.get(pivot.id)).end : shown.length ? shown[0].start : today;
    const mid = shown.length ? (Math.min(...shown.map((p) => p.start)) + Math.max(...shown.map((p) => p.show))) / 2 : today;
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
   * Placed items in the current view (all, or the drilled-in item's subtree).
   * @param {import('./model.js').Layout} at
   * @returns {Placed[]}
   */
  viewPlaced(at) {
    const rows = visibleRows(this.app);
    return rows.map((r) => /** @type {Placed} */ (at.get(r.item.id)));
  }

  /**
   * Sets the drawn range: from the month before the first item (or today)
   * to well past the last.
   * @returns {number} Pixels the content moved right, to keep the view steady.
   */
  updateRange() {
    const placed = [...layout(this.app.doc).values()], today = nowIdx();
    const lo = placed.length ? Math.min(...placed.map((p) => p.start)) : today;
    const hi = placed.length ? Math.max(...placed.map((p) => p.show), lo + 1) : today;
    const first = dateOf(Math.min(lo, today) - 14);
    const d0 = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1) / 864e5;
    const shift = this.ppd ? (this.d0 - d0) * this.ppd : 0;
    this.d0 = d0;
    this.d1 = Math.max(hi + 120, d0 + 400);
    return shift;
  }

  /** Redraws rows, bars, flights, coverage marks and the fare strip. */
  render() {
    if (this.fresh && this.app.doc.items.length && this.sc.clientWidth) return this.preset('Months');
    const { doc, filter, sel, optional, drill } = this.app;
    const at = layout(doc), today = nowIdx(), cov = coverage(doc, at, optional), live = counted(doc, optional);
    const showStay = filter === 'all' || filter === 'stays', showTravel = filter === 'all' || filter === 'travel';
    const shift = this.updateRange();
    this.ppd = this.ppd ? clamp(this.ppd, this.ppdMin(), PPD_MAX) : this.ppdMin();
    const p = this.ppd, x = (/** @type {number} */ i) => this.x(i);

    const rows = this.rows = visibleRows(this.app);
    const pivot = drill ? undefined : pivotOf(doc), pp = pivot && at.get(pivot.id);
    const fareRoutes = pivot ? departRoutes(doc, pivot.id) : [];
    const height = AXIS + rows.length * ROW + (fareRoutes.length ? fareRoutes.length * FARE + 12 : 0);
    this.inner.style.width = `${(this.d1 - this.d0) * p}px`;
    this.inner.style.height = `${height}px`;
    this.zoom.value = String(this.toSlider(p));
    $('#g-hint').textContent = this.app.narrow
      ? 'Pinch to zoom. Hold a bar, then drag it. Tap › to open what an item holds.'
      : 'Ctrl+scroll to zoom. Drag a bar to move it, up or down to rank it, or its end to resize.';

    // Breadcrumb when drilled in.
    const root = byId(doc, drill ?? undefined);
    this.crumbs.hidden = !root;
    if (root) {
      const trail = [...ancestors(doc, root)].reverse();
      this.crumbs.innerHTML = `<button data-drill="">Whole plan</button>` +
        trail.map((a) => `<span aria-hidden="true">›</span><button data-drill="${esc(a.id)}">${esc(a.name)}</button>`).join('') +
        `<span aria-hidden="true">›</span><b>${esc(root.name)}</b>`;
    }

    // Row labels.
    this.labels.innerHTML = `<div class="g-lab"><small id="g-scale"></small></div>` + rows.map(({ item: it, depth }) => {
      const kids = kidsOf(doc, it.id), alt = inGroup(doc, it) ? kidsOf(doc, it.parent).indexOf(it) : -1;
      const sub = it.kind === 'window' ? 'fixed' : it.kind === 'group' ? `either/or · ${kids.length}`
        : alt > 0 ? `option ${alt + 1}` : alt === 0 ? 'pick'
        : !it.committed ? 'optional' : isRanged(it) ? `${it.minLen}–${unitText(it.maxLen, it.unit)}`
        : it.len === undefined && kids.length ? `${kids.length} inside` : unitText(it.len ?? 1, it.unit);
      const open = kids.length && isOpen(this.app, it, depth, !!root);
      const act = chevronAction(this.app, depth);
      const tw = !kids.length || (depth === 0 && root) ? '<span class="tw-sp"></span>'
        : `<button class="tw${act === 'drill' ? ' drill' : ''}" data-tw="${esc(it.id)}" data-act="${act}" aria-expanded="${act === 'toggle' ? !!open : 'false'}" aria-label="${act === 'toggle' ? (open ? 'Collapse' : 'Expand') : 'Open'} ${esc(it.name)}">${act === 'toggle' ? (open ? '▾' : '▸') : '›'}</button>`;
      return `<div class="g-lab" style="--d:${depth}">${tw}<button class="lab-n" data-sel="item:${esc(it.id)}"><span>${esc(it.name)}</span><small>${sub}</small></button></div>`;
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
     * @param {string} [attrs] Extra attributes.
     */
    const bar = (id, cls, l, w, top, text, attrs = '') =>
      `<button class="bar ${cls}${w < 72 ? ' tight' : ''}${sel === id ? ' sel' : ''}" data-sel="${esc(id)}" ${attrs} style="left:${l}px;width:${Math.max(w, 2)}px;top:${top}px" title="${text}"><span>${text}</span></button>`;

    rows.forEach(({ item: it }, r) => {
      const pl = /** @type {Placed} */ (at.get(it.id)), top = r * ROW + 6, data = `data-id="${esc(it.id)}"`;
      if (it.kind === 'window') {
        const l = x(pl.start), rr = x(pl.end);
        h += bar(`item:${it.id}`, 'window', l, rr - l, top, esc(`${it.name} · ${unitText(it.len ?? 1, 'day')} · ${fmt(pl.start)} – ${fmt(pl.end - 1)}`), data);
        h += `<div class="dl" style="left:${rr}px"></div><span class="dlab" style="left:${rr + 6}px;top:${top + 8}px">Leave by ${fmt(pl.end - 1)}</span>`;
        return;
      }
      if (it.kind === 'group') {
        const winner = kidsOf(doc, it.id)[0];
        h += bar(`item:${it.id}`, 'grp', x(pl.start), x(pl.show) - x(pl.start), top, esc(`Either/or · ${it.name}${winner ? ` · pick: ${winner.name}` : ''}`), data);
        return;
      }
      const [s0, s1] = barSpan(doc, pl), alt = inGroup(doc, it) ? kidsOf(doc, it.parent).indexOf(it) : -1;
      if (isRanged(it)) {
        const frac = s1 - pl.end, per = UNIT_DAYS[it.unit];
        h += `<div class="track c-${it.color}" style="left:${x(pl.start + it.minLen * per + frac)}px;width:${(it.maxLen - it.minLen) * per * p}px;top:${top}px"></div>`;
      }
      const sum = total(doc, { optional, root: it.id, at });
      const cost = showStay && sum.stay ? ` · ${money(sum.stay, doc.currency)}` : '';
      const cls = `c-${it.color}${alt > 0 ? ' alt' : ''}${alt < 0 && !it.committed ? ' opt' : ''}${live.has(it.id) ? '' : ' out'}`;
      const len = it.len === undefined && kidsOf(doc, it.id).length ? '' : ` · ${unitText(it.len ?? 1, it.unit)}`;
      const time = it.unit === 'hour' ? ` · ${hhmm((pl.start % 1) * 24)}` : '';
      h += bar(`item:${it.id}`, cls, x(s0), x(s1) - x(s0), top, (alt > 0 ? `#${alt + 1} ` : '') + esc(`${it.name}${time}${len}`) + cost, data);
      if (it.len !== undefined && x(s1) - x(s0) > 28) {
        const [mn, mx] = isRanged(it) ? [it.minLen, it.maxLen] : [it.unit === 'hour' ? 0.25 : 1, 9999];
        h += `<div class="handle" data-id="${esc(it.id)}" data-start="${pl.start}" data-frac="${s1 - pl.end}" style="left:${x(s1) - 16}px;top:${top}px" role="slider" tabindex="0" aria-label="Length of ${esc(it.name)}" aria-valuemin="${mn}" aria-valuemax="${mx}" aria-valuenow="${it.len}" aria-valuetext="${unitText(it.len, it.unit)}, ends ${fmt(pl.end)}"></div>`;
      }
      const c = cov.get(it.id);
      if (c) {
        const mark = (/** @type {[number, number]} */ [a, b], /** @type {string} */ kind, /** @type {string} */ what) =>
          `<i class="cov ${kind}" style="left:${x(a)}px;width:${Math.max(3, (b - a) * p)}px;top:${top + 33}px" title="${what} ${fmt(a)} – ${fmt(b)}"></i>`;
        h += c.gaps.map((g) => mark(g, 'gap', `Nothing booked`)).join('') + c.overlaps.map((o) => mark(o, 'ovl', 'Overlap')).join('');
      }
      const arr = arrival(doc, it);
      if (arr) {
        const [key, route] = arr, f0 = x(Math.floor(pl.start) + route.depart / 24), fw = Math.max(4, route.hours / 24 * p);
        const fare = fareOn(route, pl.start), id = `fare:${key}:${Math.floor(pl.start)}`;
        const price = showTravel ? money(fare * (it.costs.find((l) => l.route === key)?.pp ? doc.people : 1), doc.currency) : '';
        if (fw > 170) {
          h += `<button class="bar fl wide${sel === id ? ' sel' : ''}" data-sel="${esc(id)}" style="left:${f0}px;width:${fw}px;top:${top + 5}px"><span>${esc(routeLabel(route))} ${hhmm(route.depart)}–${hhmm(route.depart + route.hours)}${price && ' · ' + price}</span></button>`;
        } else {
          h += `<button class="bar fl" data-sel="${esc(id)}" style="left:${f0}px;width:${fw}px;top:${top + 11}px" aria-label="${esc(routeLabel(route))} flight"></button>`;
          h += `<button class="ftag" data-sel="${esc(id)}" style="left:${f0 - 4}px;top:${top + 6}px">${PLANE}${price}</button>`;
        }
      }
    });

    // Fare strip: one row per route leaving the pivot, one cell per possible departure day.
    if (pivot && pp) {
      const [mn, mx] = rangeOf(pivot), base = rows.length * ROW + 10;
      fareRoutes.forEach((k, n) => {
        const r = doc.routes[k], top = base + n * FARE, vals = [];
        for (let i = mn; i <= mx; i++) vals.push(fareOn(r, pp.start + i));
        const flo = Math.min(...vals), fhi = Math.max(...vals);
        vals.forEach((v, j) => {
          const day = pp.start + mn + j, c = heat(v, flo, fhi);
          h += `<button class="fc${c.cls}${day === pp.end ? ' on' : ''}${showTravel ? '' : ' off'}" data-sel="fare:${esc(k)}:${day}" data-pivot="${esc(pivot.id)}" data-len="${mn + j}" style="left:${x(day)}px;width:${p}px;top:${top}px;${c.style}" aria-label="${esc(routeLabel(r))} ${fmt(day)} ${money(v, doc.currency)}">${showTravel && p >= 36 ? money(v, doc.currency) : ''}</button>`;
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
    for (let r = 1; r <= this.rows.length; r++) gr += `<i class="hl" style="top:${r * ROW}px"></i>`;
    this.axis.innerHTML = ax;
    this.grid.innerHTML = gr;
    const name = { h: 'Hours', d: 'Days', w: 'Weeks', m: n === 3 ? 'Quarters' : 'Months', y: 'Years' }[k] ?? '';
    const scale = document.getElementById('g-scale');
    if (scale) scale.textContent = name;
    const match = this.active ?? { Hours: 'Hours', Days: 'Days', Weeks: 'Weeks', Months: 'Months', Quarters: 'Year', Years: 'Year' }[name];
    this.pre.querySelectorAll('button').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.p === match)));
  }
}
