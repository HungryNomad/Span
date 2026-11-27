// @ts-check
/**
 * The lanes view (Span's main view): one row per item on a day grid, drawn
 * as rounded bubbles. Either/or groups collapse to a deck showing the pick;
 * forks (groups whose options are whole trips) collapse to one chain of
 * bubbles per option with its total. Tap a row's name to open or close it,
 * a bubble to see its details, and an option's number to make it the pick.
 * Zooms from hours to years with the zoom timeline's controls (presets,
 * slider, pinch, Ctrl+scroll), and a bubble's ends drag to change dates.
 * Transport and events draw as tags with their icon (just the icon when
 * they're too short to read at this zoom), and a change of place with
 * nothing booked between gets a red mark. The name column sizes itself to
 * the names and can be dragged wider or narrower.
 *
 * @module
 */
import {
  ancestors, canStretch, clamp, coverage, fmt, hhmm, isMoment, kidsOf, layout, MODES, money, nowIdx, pivotOf, setEdge, setRank,
  siteOf, typeOf, unitsOf, unitText,
} from './model.js';
import { missingMoves } from './places.js';
import { axisMarks, fromSlider, levelOf, markPreset, PPD_MAX, PRESETS, toSlider, wireZoom, zoomControls } from './zoomkit.js';
import { forkOf, isFork, rateOf, rivalDelta, valueOf } from './trip.js';
import { drag, esc } from './ui.js';

/** @typedef {import('./ui.js').App} App */
/** @typedef {import('./model.js').Item} Item */
/** @typedef {import('./model.js').Placed} Placed */
/** @typedef {import('./model.js').Layout} Layout */
/** @typedef {{dep: number, h: number, lab: string, labAttrs: string, trk: string, tint?: string}} Row */

/** Row height, and height of one option line in a closed fork. */
const ROW = 36, LINE = 28;
/** Pixels per day when a plan first opens fitted: least and most. */
const FIT_MIN = 9, FIT_MAX = 24;
/** Days in view when fully zoomed out, at least (as in the zoom timeline). */
const MIN_SPAN = 400;
/** Bubbles narrower than this keep their drag handles just outside their ends. */
const HANDLES_MIN = 30;
/** Bubbles narrower than this show a shortened name (the full text is on hover). */
const SHORT_MIN = 64;
/** A move or event this many pixels wide or more draws as wide as it lasts. */
const LONG_MIN = 56;
/** Below this many pixels per day, a short move or event shows only its icon. */
const TAG_PPD = 40;
/** Narrowest and widest the name column may be dragged, in pixels. */
const L_MIN = 96, L_MAX = 520;
/** Pixels a pointer must move before a drag on a bubble's end starts. */
const DRAG_SLOP = 4;

/**
 * Icon for a moment on the line: the transport's mode, or a diamond for an event.
 * @param {Item} it
 * @returns {string}
 */
export const iconOf = (it) => (typeOf(it) === 'transport' ? MODES[it.mode ?? 'other'][1] : '◆');

/**
 * Undoes {@link esc}, so text can be measured and cut.
 * @param {string} s HTML-escaped text.
 * @returns {string}
 */
const unesc = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, /** @type {string} */ e) => /** @type {Record<string, string>} */ ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e] ?? _);

/**
 * As much of a bubble's name as fits in `w` pixels: the part before " · ",
 * after any "Trip: " lead and move icons, cut without an ellipsis (which
 * would leave room for nothing else).
 * @param {string} text The bubble's plain text.
 * @param {number} w Bubble width in pixels.
 * @returns {string} Empty when not even two letters fit.
 */
export function shortName(text, w) {
  const name = (text.split(' · ')[0].split(': ').pop() ?? '').replace(/^[^\p{L}\p{N}]+/u, '');
  const fit = Math.floor((w - 8) / 6.6);
  return fit >= 2 ? [...name].slice(0, fit).join('').trimEnd() : '';
}

/**
 * Reads a value from localStorage, tolerating private mode.
 * @param {string} k
 * @returns {string | null}
 */
function load(k) { try { return localStorage.getItem(k); } catch { return null; } }

/**
 * Writes a value to localStorage, tolerating private mode.
 * @param {string} k
 * @param {string} v
 */
function store(k, v) { try { localStorage.setItem(k, v); } catch { /* not persisted */ } }

/**
 * The trips the plan is still choosing between (its first fork), as buttons
 * with each trip's own total (the same total its row shows); the pick is
 * starred. Tapping one sends
 * `data-pick`, which every view handles by making it the pick.
 * @param {App} app
 * @returns {string} HTML, empty when there's no fork.
 */
export function leanBar(app) {
  const { doc, optional, filter } = app, fork = forkOf(doc);
  if (!fork) return '';
  const opts = { optional, filter }, cur = doc.currency;
  const btns = kidsOf(doc, fork.id).map((k, i) =>
    `<button class="${i === 0 ? 'on' : ''}" style="--c:var(--c-${k.color})" data-pick="${esc(k.id)}" aria-pressed="${i === 0}" title="Make ${esc(k.name)} the pick">${i === 0 ? '★ ' : ''}${esc(k.name)}${filter === 'none' ? '' : `<b>${money(valueOf(doc, k.id, opts), cur)}</b>`}</button>`).join('');
  return `<div class="lean"><span class="lean-k">${esc(fork.name)}</span>${btns}</div>`;
}

export class Lanes {
  /**
   * Wires clicks inside `el`; drawing happens in {@link Lanes#render}.
   * @param {HTMLElement} el Container.
   * @param {App} app
   */
  constructor(el, app) {
    this.el = el;
    this.app = app;
    /** Rows opened in this view, per plan; null until the plan's first render. */
    this.open = /** @type {Set<string> | null} */ (null);
    /** `fit` (fit the plan, as when it first opens) or pixels per day. */
    this.zoom = /** @type {'fit' | number} */ ('fit');
    /** Preset picked last, until you zoom by hand. It keeps its span when the window resizes. */
    this.active = /** @type {import('./zoomkit.js').Preset | null} */ (null);
    /** Geometry of the last render: first and last day, pixels per day, label width, the most zoomed out, and the track's width. */
    this.geo = { d0: 0, d1: 1, ppd: FIT_MAX, L: 214, min: 1, vw: 0 };
    /** Day to keep at a pixel of the track on the next render (after a zoom). */
    this.keep = /** @type {{day: number, ax: number} | null} */ (null);
    /** Pending zoom frame, so a pinch draws at most once per frame. */
    this.raf = 0;
    /** Set briefly after a drag so the trailing click doesn't select. */
    this.justDragged = false;
    /** Whether the grid has been drawn (so there's a scroll position to keep). */
    this.drawn = false;
    /** Name column widths dragged by hand on phone and wider screens (0 fits the names). */
    this.labW = { narrow: Number(load('span-lanes-L-narrow')) || 0, wide: Number(load('span-lanes-L')) || 0 };
    /** Whether the help line has been closed (it shows on the first visit only). */
    this.hintSeen = load('span-lanes-hint') === '1';
    if (!this.hintSeen) store('span-lanes-hint', '1');
    el.innerHTML = `<div class="ln-lean"></div>
<div class="tools ln-tools">${zoomControls()}<div class="seg ln-all"><button data-all="1">Expand all</button><button data-all="0">Collapse all</button></div></div>
<p class="ln-hint"${this.hintSeen ? ' hidden' : ''}></p><div class="ln-scroll"></div><div class="ln-tip" role="status" hidden></div>`;
    this.lean = /** @type {HTMLElement} */ (el.querySelector('.ln-lean'));
    this.hint = /** @type {HTMLElement} */ (el.querySelector('.ln-hint'));
    this.pre = /** @type {HTMLElement} */ (el.querySelector('[data-zp]'));
    this.slider = /** @type {HTMLInputElement} */ (el.querySelector('[data-zs]'));
    this.sc = /** @type {HTMLElement} */ (el.querySelector('.ln-scroll'));
    this.tip = /** @type {HTMLElement} */ (el.querySelector('.ln-tip'));
    this.wire();
  }

  /** Attaches clicks, the zoom controls and gestures, and edge drags (delegated, since content is redrawn). */
  wire() {
    const { el, sc } = this;
    el.addEventListener('click', (e) => this.click(/** @type {HTMLElement} */ (e.target)));
    sc.addEventListener('pointerdown', (e) => {
      const t = /** @type {HTMLElement} */ (e.target), h = t.closest('.ln-h');
      if (h instanceof HTMLElement && e.button === 0) this.edge(e, h);
      else if (t.closest('.ln-rsz') && e.button === 0) this.resize(e);
    });
    sc.addEventListener('dblclick', (e) => {
      if (!/** @type {HTMLElement} */ (e.target).closest('.ln-rsz')) return;
      this.setLabW(0);
      this.render();
    });
    sc.addEventListener('keydown', (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if ((e.key === 'Enter' || e.key === ' ') && t.matches('.ln-lab[data-tg]')) { e.preventDefault(); this.click(t); }
    });
    this.slider.addEventListener('input', () => this.zoomTo(fromSlider(+this.slider.value, this.geo.min)));
    wireZoom(sc, () => this.geo.ppd, (p, anchor) => this.zoomTo(p, anchor));
    let raf = 0;
    sc.addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => this.drawAxis()); }, { passive: true });
  }

  /** @returns {number} Width of the visible track (the scroller minus the labels). */
  view() { return Math.max(120, (this.sc.clientWidth || this.el.clientWidth || innerWidth) - this.geo.L); }

  /**
   * Fractional day under a screen x position.
   * @param {number} clientX
   * @returns {number}
   */
  dayAt(clientX) {
    const { d0, ppd, L } = this.geo;
    return (clientX - this.sc.getBoundingClientRect().left - L + this.sc.scrollLeft) / ppd + d0;
  }

  /**
   * Zooms while keeping the day under `anchor` where it is. Redraws on the
   * next frame, so a fast pinch draws once per frame.
   * @param {number} ppd New pixels per day.
   * @param {number} [anchor] Pixel offset inside the scroller (the track's middle by default).
   */
  zoomTo(ppd, anchor) {
    const { d0, L } = this.geo, w = this.view();
    const ax = anchor === undefined || anchor < L ? w / 2 : anchor - L;
    this.keep = { day: (this.sc.scrollLeft + ax) / this.geo.ppd + d0, ax };
    this.zoom = clamp(ppd, this.geo.min, PPD_MAX);
    this.active = null;
    this.raf ||= requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  /**
   * Jumps to a preset span, centred as the zoom timeline does: on the
   * departure day for short spans, on the whole plan for long ones.
   * @param {import('./zoomkit.js').Preset} name
   */
  preset(name) {
    const { doc } = this.app, at = layout(doc), pivot = pivotOf(doc), w = this.view();
    const body = [...at.values()].filter((p) => p.item.kind !== 'window');
    const lo = body.length ? Math.min(...body.map((p) => p.start)) : nowIdx();
    const hi = body.length ? Math.max(...body.map((p) => p.show)) : lo;
    const focus = pivot ? /** @type {Placed} */ (at.get(pivot.id)).end : lo, mid = (lo + hi) / 2;
    const center = { Hours: focus + 0.45, Days: focus + 2, Weeks: focus, Months: mid, Year: mid }[name];
    this.zoom = clamp(w / PRESETS[name], this.geo.min, PPD_MAX);
    this.keep = { day: center, ax: w / 2 };
    this.active = name;
    this.render();
  }

  /**
   * Drags one end of a bubble to change its dates, with a tip showing where
   * it lands.
   * @param {PointerEvent} e
   * @param {HTMLElement} h The handle.
   */
  edge(e, h) {
    const { app } = this, id = /** @type {string} */ (h.dataset.edge), side = h.dataset.side === 'start' ? 'start' : 'end';
    const p0 = layout(app.doc).get(id);
    if (!p0) return;
    e.stopPropagation();
    // The edge moves by whole days as far as the pointer moves, wherever on the handle you grabbed it.
    const x0 = e.clientX, from = side === 'start' ? Math.floor(p0.start) : Math.round(p0.end), ppd = this.geo.ppd;
    let last = from, moved = false;
    this.el.classList.add('dragging');
    drag(e, (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < DRAG_SLOP) return;
      moved = true;
      const day = from + Math.round((ev.clientX - x0) / ppd);
      if (day !== last) {
        last = day;
        app.change((doc) => { setEdge(doc, id, side, day); });
      }
      const p = layout(app.doc).get(id), kid = p && (p.item.kind === 'group' ? kidsOf(app.doc, id)[0] : p.item);
      if (!p || !kid) return;
      const at = side === 'start' ? p.start : p.end, shift = Math.round(at - (side === 'start' ? p0.start : p0.end));
      this.tip.textContent = `${side === 'start' ? 'From' : 'To'} ${fmt(at, { weekday: 'short' })} · ${unitText(unitsOf({ ...p, item: kid }), kid.unit)}${shift ? ` (${shift > 0 ? '+' : '−'}${Math.abs(shift)}d)` : ''}`;
      this.tip.style.left = `${ev.clientX}px`;
      this.tip.style.top = `${ev.clientY - 44}px`;
      this.tip.hidden = false;
    }, () => {
      this.tip.hidden = true;
      this.el.classList.remove('dragging');
      this.justDragged = true;
      setTimeout(() => { this.justDragged = false; }, 60);
    });
  }

  /**
   * Drags the name column's edge to make it wider or narrower; the width is
   * kept for next time (double-click the edge to fit the names again).
   * @param {PointerEvent} e
   */
  resize(e) {
    e.preventDefault();
    const x0 = e.clientX, w0 = this.geo.L;
    drag(e, (ev) => {
      this.setLabW(clamp(Math.round(w0 + ev.clientX - x0), L_MIN, L_MAX));
      this.raf ||= requestAnimationFrame(() => { this.raf = 0; this.render(); });
    }, () => {
      this.justDragged = true;
      setTimeout(() => { this.justDragged = false; }, 60);
    });
  }

  /**
   * Keeps a hand-set name column width for this screen size.
   * @param {number} w Pixels, or 0 to fit the names again.
   */
  setLabW(w) {
    const k = this.app.narrow ? 'narrow' : 'wide';
    this.labW[k] = w;
    store(k === 'narrow' ? 'span-lanes-L-narrow' : 'span-lanes-L', w ? String(w) : '');
  }

  /**
   * Width of the name column: as dragged by hand, else wide enough for the
   * longest name showing, within limits that leave room for the chart.
   * @param {Set<string>} open Rows that are open.
   * @returns {number} Pixels.
   */
  labelWidth(open) {
    const { doc, narrow } = this.app, vw = this.sc.clientWidth || this.el.clientWidth || innerWidth;
    const set = this.labW[narrow ? 'narrow' : 'wide'];
    if (set) return clamp(set, L_MIN, Math.max(L_MIN, vw - 120));
    let need = 0;
    /** Measures the rows under `parent`, and under those that are open. */
    const walk = (/** @type {string | undefined} */ parent, /** @type {number} */ dep, /** @type {boolean} */ ranked) => {
      for (const it of kidsOf(doc, parent)) {
        need = Math.max(need, 14 + dep * 13 + (ranked ? 24 : 0) + 24 + [...it.name].length * 7.3 + (narrow ? 0 : 72));
        if (open.has(it.id)) walk(it.id, dep + 1, it.kind === 'group');
      }
    };
    walk(undefined, 0, false);
    const base = narrow ? 138 : 214, cap = narrow ? Math.min(240, vw * 0.55) : Math.min(L_MAX, vw * 0.4);
    return Math.round(clamp(need, base, Math.max(base, cap)));
  }

  /** Forgets what was open, for a newly opened plan. */
  reset() { this.open = null; this.drawn = false; this.zoom = 'fit'; this.active = null; this.sc.scrollLeft = 0; }

  /** @returns {string} localStorage key for the open rows of this plan. */
  get key() { return `span-lanes:${this.app.planId ?? 'local'}`; }

  /**
   * Handles a click anywhere in the view.
   * @param {HTMLElement} t Click target.
   */
  click(t) {
    if (t.closest('.ln-hint-x')) { this.hintSeen = true; this.hint.hidden = true; return; }
    const b = /** @type {HTMLElement | null} */ (t.closest('[data-tg],[data-pick],[data-all],[data-p],[data-sel]'));
    if (!b || !this.open || this.justDragged) return;
    const { app } = this, d = b.dataset;
    if (d.pick) { const id = d.pick; app.change((doc) => setRank(doc, id, 0)); return; }
    if (d.sel) { app.select(d.sel); return; }
    if (d.p) { this.preset(/** @type {import('./zoomkit.js').Preset} */ (d.p)); return; }
    if (d.all) {
      this.open.clear();
      if (d.all === '1') for (const it of app.doc.items) if (kidsOf(app.doc, it.id).length) this.open.add(it.id);
    } else if (d.tg) {
      if (!this.open.delete(d.tg)) this.open.add(d.tg);
    }
    store(this.key, JSON.stringify([...this.open]));
    this.render();
  }

  /** Redraws the view from the app state. */
  render() {
    const { doc, filter, optional, narrow } = this.app, cur = doc.currency, hide = filter === 'none';
    if (!this.open) {
      let saved = null;
      try { saved = JSON.parse(load(this.key) ?? 'null'); } catch { /* ignore */ }
      this.open = new Set(Array.isArray(saved) ? saved : doc.items.filter((it) => it.kind === 'group' && !it.parent).map((it) => it.id));
    }
    const open = this.open, at = layout(doc), cov = coverage(doc, at, optional), opts = { optional, filter, at };
    // Changes of place with nothing booked between, and the rows that hold their arriving stay.
    const miss = missingMoves(doc, at, optional).map((m) => ({ ...m, up: new Set(ancestors(doc, m.stay).map((a) => a.id)) }));
    /** Where an item sits. */
    const P = (/** @type {string} */ id) => /** @type {Placed} */ (at.get(id));
    /** What an item adds to the total, with what's counted inside it. */
    const val = (/** @type {string} */ id) => valueOf(doc, id, opts);
    /** Money, or nothing when costs are hidden. */
    const $$ = (/** @type {number} */ n) => (hide ? '' : money(n, cur));

    // Day range: everything but fixed windows (a visa can start months earlier).
    const placed = [...at.values()];
    const body = placed.filter((p) => p.item.kind !== 'window');
    const span = body.length ? body : placed;
    const d0 = span.length ? Math.floor(Math.min(...span.map((p) => p.start))) - 1 : Math.floor(nowIdx());
    let d1 = span.length ? Math.ceil(Math.max(...span.map((p) => p.show))) + 2 : d0 + 30;
    const L = this.labelWidth(open), TAIL = hide ? 24 : 96;
    const was = this.geo;
    this.geo = { ...was, L };
    const vw = this.view(), avail = vw - TAIL - 4, min = vw / Math.max(MIN_SPAN, d1 - d0);
    // After a resize, a preset keeps its span around the same middle day, so the button, slider and axis still agree.
    if (this.active && was.vw && vw !== was.vw && !this.keep) {
      this.keep = { day: (this.sc.scrollLeft + was.vw / 2) / was.ppd + was.d0, ax: vw / 2 };
      this.zoom = vw / PRESETS[this.active];
    }
    const ppd = this.zoom === 'fit' ? clamp(clamp(avail / (d1 - d0), FIT_MIN, FIT_MAX), min, PPD_MAX) : clamp(this.zoom, min, PPD_MAX);
    // The fitted zoom stays put once drawn, so editing or opening a row doesn't zoom the chart under you.
    if (this.zoom === 'fit') this.zoom = ppd;
    // Where the view was, as a day at the track's left edge, so a redraw doesn't jump and a zoom keeps its anchor.
    const left = this.keep ? this.keep.day - this.keep.ax / ppd : this.sc.scrollLeft / was.ppd + was.d0;
    d1 = Math.max(d1, d0 + Math.ceil(vw / ppd));
    const W = Math.ceil((d1 - d0) * ppd) + TAIL;
    /** Handles on a bubble's ends, when its item can stretch (a narrow bubble's sit just outside it, see `.tiny`). */
    const ends = (/** @type {Item} */ it, /** @type {number} */ a) =>
      canStretch(doc, it)
        ? `${a >= d0 ? `<i class="ln-h s" data-edge="${esc(it.id)}" data-side="start" title="Drag to change the start"></i>` : ''}<i class="ln-h e" data-edge="${esc(it.id)}" data-side="end" title="Drag to change the end"></i>`
        : '';
    /** Pixel offset of a day in the track. */
    const x = (/** @type {number} */ d) => (d - d0) * ppd;

    /**
     * A bubble from day a to b; `edge` is the item its end handles stretch.
     * Too narrow for its text, it shows as much of the name as fits, with
     * the full text on hover.
     */
    const pill = (/** @type {number} */ a, /** @type {number} */ b, /** @type {string} */ color, /** @type {string} */ text, cls = '', attrs = '', top = 6, /** @type {Item | null} */ edge = null) => {
      const l = Math.max(x(a), 0) + 1, r = Math.min(x(b), x(d1)) - 1, w = Math.max(r - l, 8);
      const plain = unesc(text.replace(/<em>/g, ' ').replace(/<[^>]*>/g, '')), tiny = w < HANDLES_MIN ? ' tiny' : '';
      const shown = w < SHORT_MIN ? esc(shortName(plain, w)) : text;
      return `<button class="ln-p ${cls}${tiny}${w < SHORT_MIN ? ' short' : ''}" style="left:${l}px;width:${w}px;top:${top}px;--c:var(--c-${color})" title="${esc(plain)}" ${attrs}><span>${shown}</span>${edge ? ends(edge, a) : ''}</button>`;
    };
    /**
     * A transport or event tag at its real time: as wide as it lasts when
     * zoomed in enough, a labelled tag when a day is wide enough to read
     * it, else just its icon (the full text is its title).
     */
    const flight = (/** @type {Item} */ it, /** @type {string} */ text, cls = '', attrs = '', top = 7) => {
      const p = P(it.id), w = (p.end - p.start) * ppd, ev = typeOf(it) === 'event' ? ' ev' : '';
      const plain = unesc(text.replace(/<em>/g, ' ').replace(/<[^>]*>/g, ''));
      if (w < LONG_MIN && ppd < TAG_PPD) {
        const more = /<em>([^<]*)<\/em>/.exec(text)?.[1] ?? '';
        return `<button class="ln-fl icon ${cls}${ev}" style="left:${x(p.start)}px;top:${top}px" title="${esc(plain)}" aria-label="${esc(plain)}" ${attrs}>${iconOf(it)}${more ? `<em>${more}</em>` : ''}</button>`;
      }
      return `<button class="ln-fl ${cls}${ev}${w >= LONG_MIN ? ' long' : ''}" style="left:${x(p.start)}px;top:${top}px${w >= LONG_MIN ? `;width:${w}px` : ''}" title="${esc(plain)}" ${attrs}>${iconOf(it)} <span>${text}</span></button>`;
    };
    /** Pixels a tag drawn by {@link flight} takes, roughly, for placing what follows it. */
    const flightW = (/** @type {Item} */ it, /** @type {string} */ text) => {
      const p = P(it.id), w = (p.end - p.start) * ppd;
      return w >= LONG_MIN ? w : ppd < TAG_PPD ? 26 : 24 + text.length * 7.2;
    };
    /** A small icon on the line where a move or event happens. */
    const dot = (/** @type {number} */ d, /** @type {number} */ top, /** @type {string} */ icon) => `<i class="ln-dot" style="left:${x(d)}px;top:${top}px">${icon}</i>`;
    /** A red mark where you change place with nothing booked to get there. */
    const missMark = (/** @type {typeof miss[number]} */ m, /** @type {number} */ top) =>
      `<button class="ln-miss" style="left:${x(m.day)}px;top:${top}px" data-sel="item:${esc(m.stay.id)}" title="No transport from ${esc(m.from)} to ${esc(m.to)}" aria-label="No transport from ${esc(m.from)} to ${esc(m.to)}">!</button>`;
    /** A total just after day d. */
    const totAt = (/** @type {number} */ d, /** @type {number} */ n, top = 10, small = '') =>
      hide ? '' : `<span class="ln-tot" style="left:${x(d) + 12}px;top:${top}px">${money(n, cur)}${small ? `<small>${small}</small>` : ''}</span>`;
    /** A line of grey text after day d. */
    const note = (/** @type {number} */ d, /** @type {string} */ text, cls = '', top = 11) => `<span class="ln-note ${cls}" style="left:${x(d) + 6}px;top:${top}px">${text}</span>`;
    /** Whether an item is a move or an event that happens at a time. */
    const isHop = isMoment;
    /** Short length: "14n", "3d", or the clock time for an hour item. */
    const nightsTxt = (/** @type {Item} */ it) => {
      const p = P(it.id), n = it.kind === 'group' ? unitsOf({ ...p, item: kidsOf(doc, it.id)[0] ?? it }) : unitsOf(p);
      return it.unit === 'hour' ? hhmm((p.start % 1) * 24) : `${n}${it.unit === 'night' ? 'n' : 'd'}`;
    };
    /** Whether an item's cost includes a fare to get there. */
    const arrival = (/** @type {Item} */ it) => it.costs.some((l) => l.type === 'date' && l.route && doc.routes[l.route]);
    /** Last day an item or anything directly inside it shows. */
    const extent = (/** @type {Item} */ it) => {
      const ks = kidsOf(doc, it.id), p = P(it.id);
      return Math.max(p.show, ...ks.map((k) => P(k.id).show));
    };

    /**
     * One option or stay as a single bubble: the pick of a group as a deck,
     * labelled with the pick (or, inside a closed chain, the group's name).
     * @param {Item} it @param {number} top @param {boolean} sm @param {string} lead @param {boolean} [named]
     */
    const bubble = (it, top, sm, lead, named = false) => {
      const p = P(it.id), cls = `${sm ? 'sm ' : ''}${it.committed ? '' : 'opt'}`;
      if (it.kind === 'group') {
        const ks = kidsOf(doc, it.id), pk = ks[0];
        if (!pk) return '';
        const more = ks.length > 1 ? `<em>+${ks.length - 1}</em>` : '';
        if (isHop(pk)) return flight(pk, `${esc(pk.name)}${more}`, '', `data-sel="item:${esc(it.id)}"`, top + 1);
        const r = rateOf(pk);
        const text = named ? `${esc(it.name)} · ${nightsTxt(it)}` : `${esc(pk.name)}${r && !hide ? ` · ${money(r, cur)}` : ''}`;
        return pill(p.start, p.end, pk.color, `${lead}${text}${more}`, `${ks.length > 1 ? 'deck' : ''} ${cls}`, `data-sel="item:${esc(it.id)}"`, top, it);
      }
      if (isHop(it)) return flight(it, esc(it.name), '', `data-sel="item:${esc(it.id)}"`, top + 1);
      return pill(p.start, p.end, it.color, `${lead}${arrival(it) ? '✈ ' : ''}${esc(it.name)} · ${nightsTxt(it)}`, `${cls}${typeOf(it) === 'event' ? ' ev' : ''}`, `data-sel="item:${esc(it.id)}"`, top, it);
    };

    /**
     * An item's children as one chain of bubbles in time order. A move
     * shows as its icon at the start of the bubble that begins the day it
     * happens (so it never covers a name), or on the line when no bubble
     * begins that day (a flight home).
     * @param {Item} it @param {number} top @param {boolean} sm @param {string} lead
     */
    const chain = (it, top, sm, lead) => {
      const ks = kidsOf(doc, it.id).filter((k) => k.kind !== 'window').sort((a, b) => P(a.id).start - P(b.id).start);
      chainEnd = x(extent(it));
      if (!ks.length) return bubble(it, top, sm, lead);
      /** The move an item is, or the pick of a group of moves. */
      const hopOf = (/** @type {Item} */ k) => { const pk = k.kind === 'group' ? kidsOf(doc, k.id)[0] : k; return pk && isHop(pk) ? pk : undefined; };
      const stays = ks.filter((k) => !hopOf(k));
      /** @type {Map<string, string>} */
      const icons = new Map();
      let h = '';
      let end = -Infinity;
      for (const k of ks) {
        const hop = hopOf(k);
        if (!hop) continue;
        const day = Math.floor(P(hop.id).start), to = stays.find((s) => Math.floor(P(s.id).start) === day);
        if (to) { icons.set(to.id, `${icons.get(to.id) ?? ''}${iconOf(hop)} `); continue; }
        // On the line, clear of the bubble before it (whose name it would cover) and of the last mark.
        const before = stays.filter((s) => P(s.id).start <= P(hop.id).start).map((s) => x(P(s.id).end) + 11);
        const at = Math.max(x(P(hop.id).start), end + 20, ...before);
        h += dot(d0 + at / ppd, top + (sm ? 1 : 3), iconOf(hop));
        end = at;
      }
      chainEnd = Math.max(end + 12, ...stays.map((s) => x(P(s.id).end)));
      stays.forEach((k, i) => {
        const pre = `${i === 0 ? lead : ''}${icons.get(k.id) ?? ''}`;
        h += k.kind === 'group' || !kidsOf(doc, k.id).length ? bubble(k, top, sm, pre, true)
          : pill(P(k.id).start, P(k.id).end, k.color, `${pre}${esc(k.name)} · ${nightsTxt(k)}`, `${sm ? 'sm' : ''}`, `data-sel="item:${esc(k.id)}"`, top, k);
      });
      return h;
    };

    /** Right edge, in pixels, of what the last {@link chain} drew (so a total after it doesn't sit on a mark). */
    let chainEnd = 0;
    /** A total just after the last chain drawn. */
    const totAfter = (/** @type {number} */ n, top = 10) => totAt(d0 + (chainEnd - 4) / ppd, n, top);

    /** @type {Row[]} */
    const rows = [];

    /**
     * Adds an item's row (and its children's rows when open).
     * @param {Item} it @param {number} dep @param {Item | undefined} group Group it's an option of.
     * @param {number} rank @param {string} tint Color of the trip it's inside.
     */
    const visit = (it, dep, group, rank, tint) => {
      const p = P(it.id), kids = kidsOf(doc, it.id), has = kids.length > 0, isOpen = has && open.has(it.id);
      const picked = group ? rank === 0 : true;
      // Label: rank number, caret, name, and a short summary.
      let sub = '';
      if (it.kind === 'group') sub = `pick 1 of ${kids.length}`;
      else if (it.kind === 'window') sub = `to ${fmt(p.end - 1)}`;
      else if (group && isFork(doc, group)) sub = $$(val(it.id));
      else if (isHop(it)) sub = `${fmt(p.start)} ${hhmm((p.start % 1) * 24)}`;
      else sub = `${nightsTxt(it)}${hide ? '' : ` · ${money(val(it.id), cur)}`}`;
      const rk = group ? `<button class="ln-rk${picked ? ' pk' : ''}" style="--c:var(--c-${it.color})" data-pick="${esc(it.id)}" aria-label="Make ${esc(it.name)} the pick" aria-pressed="${picked}">${rank + 1}</button>` : '';
      const car = `<span class="ln-car${has ? '' : ' none'}${isOpen ? ' open' : ''}" aria-hidden="true">${has ? '▶' : ''}</span>`;
      // The whole name cell opens and closes the row; details open from the bubbles.
      const lab = `${rk}${car}<span class="ln-n">${esc(it.name)}</span><small>${sub}</small>`;
      const labAttrs = has ? ` data-tg="${esc(it.id)}" role="button" tabindex="0" aria-expanded="${isOpen}" aria-label="${isOpen ? 'Close' : 'Open'} ${esc(it.name)}"` : '';

      let trk = '', h = ROW;
      for (const m of miss) if (m.stay.id === it.id || (!isOpen && m.up.has(it.id))) trk += missMark(m, 7);
      const c = cov.get(it.id);
      if (c) {
        for (const [a, b] of c.gaps) trk += `<i class="ln-cov gap" style="left:${x(a)}px;width:${(b - a) * ppd}px"></i>`;
        for (const [a, b] of c.overlaps) trk += `<i class="ln-cov ovl" style="left:${x(a)}px;width:${(b - a) * ppd}px"></i>`;
      }
      if (it.kind === 'window') {
        const before = p.start < d0;
        trk += pill(p.start, p.end, 'gray', `${before ? '◂ ' : ''}${esc(it.name)} · ends ${fmt(p.end - 1)}`, 'win', `data-sel="item:${esc(it.id)}"`, 9);
      } else if (it.kind === 'group' && isFork(doc, it) && !isOpen) {
        // Closed fork: each trip as a chain of bubbles with its total.
        kids.forEach((k, i) => {
          const top = 6 + i * LINE;
          trk += chain(k, top, true, `${i === 0 ? '★ ' : ''}${esc(k.name)}: `);
          trk += totAfter(val(k.id), top + 3);
        });
        h = 12 + kids.length * LINE;
      } else if (it.kind === 'group') {
        const pk = kids[0];
        if (isOpen && isFork(doc, it) && kids.length > 1) {
          trk += note(p.start, kids.map((k) => esc(k.name)).join(' or '));
        } else if (isOpen) {
          trk += pk && isHop(pk) ? note(P(pk.id).start + 0.3, `pick 1 of ${kids.length}`)
            : pill(p.start, p.end, pk?.color ?? 'gray', `pick 1 of ${kids.length}${pk ? ` · ${nightsTxt(it)}` : ''}`, 'span', `data-sel="item:${esc(it.id)}"`, 6, it);
        } else trk += bubble(it, 6, false, '');
      } else if (isHop(it)) {
        const v = val(it.id);
        const text = group && !picked ? esc(it.name) : `${esc(it.name)}${hide ? '' : ` · ${money(v, cur)}`}`;
        let tail = p.start + flightW(it, unesc(text)) / ppd;
        if (group && !picked) {
          const dl = rivalDelta(doc, it.id, kidsOf(doc, group.id)[0].id, opts);
          trk += flight(it, text, 'ghost', `data-sel="item:${esc(it.id)}"`) + (dl ? note(tail, esc(dl)) : '');
          if (dl) tail += (dl.length * 7 + 14) / ppd;
        } else trk += flight(it, text, '', `data-sel="item:${esc(it.id)}"`);
        if (it.note) trk += note(tail, esc(it.note), 'red');
      } else if (has && !isOpen) {
        trk += chain(it, 6, false, '');
        if (narrow && group) trk += totAfter(val(it.id));
      } else if (has) {
        trk += pill(p.start, p.end, it.color, esc(it.name), 'span', `data-sel="item:${esc(it.id)}"`, 6, it) + totAt(extent(it), val(it.id));
      } else {
        // A leaf: a stay, or one option among several.
        const v = val(it.id), r = rateOf(it), site = it.links[0] ? siteOf(it.links[0]) : '';
        const unit = it.unit === 'night' ? '/night' : it.unit === 'day' ? '/day' : '';
        let text = esc(it.name);
        if (group) {
          const dl = rivalDelta(doc, it.id, kidsOf(doc, group.id)[0].id, opts);
          text = `${site ? `${esc(site)} · ` : ''}${r !== undefined && !hide ? `${money(r, cur)}${unit}` : esc(it.name)}${hide ? '' : picked ? ` · ${money(v, cur)}` : dl ? ` · ${esc(dl)}` : ''}`;
        } else if (r !== undefined && !hide) text += ` · ${money(r, cur)}${unit}`;
        trk += pill(p.start, p.end, it.color, `${arrival(it) ? '✈ ' : ''}${text}`, `${picked ? '' : 'ghost'} ${it.committed ? '' : 'opt'}${typeOf(it) === 'event' ? ' ev' : ''}`, `data-sel="item:${esc(it.id)}"`, 6, it);
      }
      rows.push({ dep, h, lab, labAttrs, trk, tint: dep ? tint : undefined });
      if (!isOpen) return;
      kids.forEach((k, i) => visit(k, dep + 1, it.kind === 'group' ? it : undefined, i, dep ? tint : k.color));
    };
    kidsOf(doc, undefined).forEach((it) => visit(it, 0, undefined, 0, it.color));

    this.lean.innerHTML = leanBar(this.app);
    this.slider.value = String(toSlider(ppd, min));
    if (!this.hintSeen) {
      this.hint.innerHTML = `<span>${narrow ? 'Pinch to zoom.' : 'Ctrl+scroll or pinch the trackpad to zoom.'} Tap a name to open or close its row, a bubble to see or edit it, a number to make that option the pick. Drag a bubble's ends to change its dates.${miss.length ? ' <b class="ln-miss-k">!</b> marks a change of place with no transport.' : ''}</span><button class="ln-hint-x" aria-label="Hide this help">×</button>`;
    }
    // The axis and gridlines are drawn for the visible window by drawAxis().
    this.sc.innerHTML = `<div class="ln-grid" style="--L:${L}px;width:${L + W}px">
  <div class="ln-shade" aria-hidden="true"></div>
  <div class="ln-row ln-ax"><div class="ln-lab"><small class="ln-scale"></small><i class="ln-rsz" title="Drag to widen the names; double-click to fit them" aria-hidden="true"></i></div><div class="ln-trk" style="width:${W}px"></div></div>
  ${rows.map((r) => `<div class="ln-row d${Math.min(r.dep, 3)}" style="height:${r.h}px${r.tint ? `;--t:var(--c-${r.tint})` : ''}"><div class="ln-lab${r.labAttrs ? ' tg' : ''}" style="--dep:${r.dep}"${r.labAttrs}>${r.lab}</div><div class="ln-trk" style="width:${W}px">${r.trk}</div></div>`).join('')}
</div>`;
    if (this.drawn) this.sc.scrollLeft = (left - d0) * ppd;
    this.geo = { d0, d1, ppd, L, min, vw };
    this.keep = null;
    this.drawn = true;
    this.drawAxis();
  }

  /** Redraws the axis, gridlines, weekend shading and today line for the visible window only. */
  drawAxis() {
    const { d0, d1, ppd, L } = this.geo, sc = this.sc, sl = sc.scrollLeft, w = this.view();
    const axt = sc.querySelector('.ln-ax .ln-trk'), shade = sc.querySelector('.ln-shade'), label = sc.querySelector('.ln-scale');
    if (!axt || !shade || !label) return;
    const a = Math.max(d0, sl / ppd + d0 - 1), b = Math.min(d1, (sl + w) / ppd + d0 + 1);
    const x = (/** @type {number} */ d) => (d - d0) * ppd;
    const level = this.active ?? levelOf(w / ppd);
    const { axis, grid } = axisMarks(a, b, ppd, x, sl, level, L);
    const today = nowIdx();
    axt.innerHTML = axis;
    shade.innerHTML = grid + (today >= a && today <= b ? `<i class="today" style="left:${L + x(today)}px"></i>` : '');
    label.textContent = level;
    markPreset(this.pre, level);
  }
}
