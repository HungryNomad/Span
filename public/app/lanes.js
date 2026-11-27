// @ts-check
/**
 * The lanes view (Span's main view): one row per item on a day grid, drawn
 * as rounded bubbles. Either/or groups collapse to a deck showing the pick;
 * forks (groups whose options are whole trips) collapse to one chain of
 * bubbles per option with its total. Open a row to see what's inside, and
 * tap an option's number to make it the pick. Zooms from hours to years
 * (presets, pinch or Ctrl+scroll), and a bubble's ends drag to change dates.
 * Transport and events draw as tags with their icon, and a change of place
 * with nothing booked between gets a red mark.
 *
 * @module
 */
import {
  ancestors, canStretch, clamp, coverage, dateOf, fmt, hhmm, isMoment, kidsOf, layout, MODES, money, nowIdx, setEdge, setRank,
  siteOf, typeOf, unitsOf, unitText,
} from './model.js';
import { missingMoves } from './places.js';
import { axisTicks } from './timeline.js';
import { costRange, forkOf, isFork, rateOf, totalIfPicked, valueOf } from './trip.js';
import { drag, esc } from './ui.js';

/** @typedef {import('./ui.js').App} App */
/** @typedef {import('./model.js').Item} Item */
/** @typedef {import('./model.js').Placed} Placed */
/** @typedef {import('./model.js').Layout} Layout */
/** @typedef {{dep: number, h: number, lab: string, trk: string, tint?: string}} Row */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Row height, and height of one option line in a closed fork. */
const ROW = 36, LINE = 28;
/** Pixels per day when fitting the plan: least and most. */
const FIT_MIN = 9, FIT_MAX = 24;
/** Most zoomed in (60 px an hour) and the least ever (a few years across a phone). */
const PPD_MAX = 24 * 60, PPD_MIN = 0.2;
/** Zoom presets: days in view. */
const PRESETS = { Day: 1, Week: 7, Month: 31, Year: 365 };
/** Narrowest bubble that gets drag handles on its ends. */
const HANDLES_MIN = 30;

/**
 * Icon for a moment on the line: the transport's mode, or a diamond for an event.
 * @param {Item} it
 * @returns {string}
 */
export const iconOf = (it) => (typeOf(it) === 'transport' ? MODES[it.mode ?? 'other'][1] : '◆');

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
 * with each trip's total; the pick is starred. Tapping one sends
 * `data-pick`, which every view handles by making it the pick.
 * @param {App} app
 * @returns {string} HTML, empty when there's no fork.
 */
export function leanBar(app) {
  const { doc, optional, filter } = app, fork = forkOf(doc);
  if (!fork) return '';
  const opts = { optional, filter }, cur = doc.currency;
  const btns = kidsOf(doc, fork.id).map((k, i) =>
    `<button class="${i === 0 ? 'on' : ''}" style="--c:var(--c-${k.color})" data-pick="${esc(k.id)}" aria-pressed="${i === 0}" title="Make ${esc(k.name)} the pick">${i === 0 ? '★ ' : ''}${esc(k.name)}${filter === 'none' ? '' : `<b>${money(totalIfPicked(doc, k.id, opts), cur)}</b>`}</button>`).join('');
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
    const z = load('span-lanes-zoom');
    /** `fit`, or pixels per day ("days" was the old fixed zoom). */
    this.zoom = /** @type {'fit' | number} */ (z === 'days' ? FIT_MAX : Number(z) > 0 ? Number(z) : 'fit');
    /** Preset picked last, until you zoom by hand. */
    this.active = /** @type {string | null} */ (null);
    /** Geometry of the last render: first day, pixels per day, label width. */
    this.geo = { d0: 0, ppd: FIT_MAX, L: 214 };
    /** Day to keep at a pixel of the track on the next render (after a zoom). */
    this.keep = /** @type {{day: number, ax: number} | null} */ (null);
    /** Set briefly after a drag so the trailing click doesn't select. */
    this.justDragged = false;
    /** Whether the grid has been drawn (so there's a scroll position to keep). */
    this.drawn = false;
    el.innerHTML = '<div class="ln-top"></div><p class="ln-hint"></p><div class="ln-scroll"></div><div class="ln-tip" role="status" hidden></div>';
    this.top = /** @type {HTMLElement} */ (el.querySelector('.ln-top'));
    this.sc = /** @type {HTMLElement} */ (el.querySelector('.ln-scroll'));
    this.tip = /** @type {HTMLElement} */ (el.querySelector('.ln-tip'));
    this.wire();
  }

  /** Attaches clicks, zoom gestures and edge drags (all delegated, since content is redrawn). */
  wire() {
    const { el, sc } = this;
    el.addEventListener('click', (e) => this.click(/** @type {HTMLElement} */ (e.target)));
    sc.addEventListener('pointerdown', (e) => {
      const h = /** @type {HTMLElement} */ (e.target).closest('.ln-h');
      if (h instanceof HTMLElement && e.button === 0) this.edge(e, h);
    });
    sc.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.zoomTo(this.geo.ppd * Math.exp(-e.deltaY * 0.01), e.clientX - sc.getBoundingClientRect().left);
    }, { passive: false });
    /** @type {{d: number, p: number, cx: number} | null} */
    let pinch = null;
    const dist = (/** @type {TouchList} */ t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    sc.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) pinch = { d: dist(e.touches), p: this.geo.ppd, cx: (e.touches[0].clientX + e.touches[1].clientX) / 2 - sc.getBoundingClientRect().left };
    }, { passive: true });
    sc.addEventListener('touchmove', (e) => {
      if (pinch && e.touches.length === 2) { e.preventDefault(); this.zoomTo(pinch.p * dist(e.touches) / pinch.d, pinch.cx); }
    }, { passive: false });
    sc.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });
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
   * Zooms while keeping the day under `anchor` where it is.
   * @param {number} ppd New pixels per day.
   * @param {number} [anchor] Pixel offset inside the scroller (the track's middle by default).
   */
  zoomTo(ppd, anchor) {
    const { d0, L } = this.geo, w = this.view();
    const ax = anchor === undefined || anchor < L ? w / 2 : anchor - L;
    this.keep = { day: (this.sc.scrollLeft + ax) / this.geo.ppd + d0, ax };
    this.zoom = clamp(ppd, PPD_MIN, PPD_MAX);
    this.active = null;
    store('span-lanes-zoom', String(this.zoom));
    this.render();
  }

  /**
   * Jumps to a preset (days in view) or back to fitting the plan, keeping
   * the middle of the view where it is.
   * @param {string} name `fit` or a key of {@link PRESETS}.
   */
  preset(name) {
    const days = PRESETS[/** @type {keyof typeof PRESETS} */ (name)];
    if (!days) {
      this.zoom = 'fit';
      this.active = null;
      store('span-lanes-zoom', 'fit');
      this.render();
      this.sc.scrollLeft = 0;
      return;
    }
    const w = this.view();
    this.keep = { day: (this.sc.scrollLeft + w / 2) / this.geo.ppd + this.geo.d0, ax: w / 2 };
    this.zoom = clamp(w / days, PPD_MIN, PPD_MAX);
    this.active = name;
    store('span-lanes-zoom', String(this.zoom));
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
    e.stopPropagation();
    let last = NaN;
    this.el.classList.add('dragging');
    drag(e, (ev) => {
      const day = Math.round(this.dayAt(ev.clientX));
      if (day === last) return;
      last = day;
      app.change((doc) => { setEdge(doc, id, side, day); });
      const p = layout(app.doc).get(id), kid = p && (p.item.kind === 'group' ? kidsOf(app.doc, id)[0] : p.item);
      if (!p || !kid) return;
      this.tip.textContent = `${side === 'start' ? 'From' : 'To'} ${fmt(side === 'start' ? p.start : p.end, { weekday: 'short' })} · ${unitText(unitsOf({ ...p, item: kid }), kid.unit)}`;
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

  /** Forgets what was open, for a newly opened plan. */
  reset() { this.open = null; this.drawn = false; this.sc.scrollLeft = 0; }

  /** @returns {string} localStorage key for the open rows of this plan. */
  get key() { return `span-lanes:${this.app.planId ?? 'local'}`; }

  /**
   * Handles a click anywhere in the view.
   * @param {HTMLElement} t Click target.
   */
  click(t) {
    const b = /** @type {HTMLElement | null} */ (t.closest('[data-tg],[data-pick],[data-all],[data-zoom],[data-step],[data-sel]'));
    if (!b || !this.open || this.justDragged) return;
    const { app } = this, d = b.dataset;
    if (d.pick) { const id = d.pick; app.change((doc) => setRank(doc, id, 0)); return; }
    if (d.sel) { app.select(d.sel); return; }
    if (d.zoom) { this.preset(d.zoom); return; }
    if (d.step) { this.zoomTo(this.geo.ppd * (d.step === 'in' ? 1.6 : 1 / 1.6)); return; }
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
    const L = narrow ? 138 : 214, TAIL = hide ? 24 : 96;
    // Where the view was, as a day at the track's left edge, so a redraw (or a zoom) doesn't jump.
    const was = this.geo, left = this.keep ? this.keep.day - this.keep.ax / was.ppd : this.sc.scrollLeft / was.ppd + was.d0;
    this.geo = { ...was, L };
    const vw = this.view(), avail = vw - TAIL - 4;
    const ppd = this.zoom === 'fit' ? clamp(avail / (d1 - d0), FIT_MIN, FIT_MAX) : clamp(this.zoom, Math.max(PPD_MIN, vw / Math.max(730, d1 - d0)), PPD_MAX);
    d1 = Math.max(d1, d0 + Math.ceil(vw / ppd));
    const W = Math.ceil((d1 - d0) * ppd) + TAIL;
    /** Handles on a bubble's ends, when its item can stretch. */
    const ends = (/** @type {Item} */ it, /** @type {number} */ a, /** @type {number} */ b) =>
      (b - a) * ppd >= HANDLES_MIN && canStretch(doc, it)
        ? `${a >= d0 ? `<i class="ln-h s" data-edge="${esc(it.id)}" data-side="start" title="Drag to change the start"></i>` : ''}<i class="ln-h e" data-edge="${esc(it.id)}" data-side="end" title="Drag to change the end"></i>`
        : '';
    /** Pixel offset of a day in the track. */
    const x = (/** @type {number} */ d) => (d - d0) * ppd;

    /** A bubble from day a to b; `edge` is the item its end handles stretch. */
    const pill = (/** @type {number} */ a, /** @type {number} */ b, /** @type {string} */ color, /** @type {string} */ text, cls = '', attrs = '', top = 6, /** @type {Item | null} */ edge = null) => {
      const l = Math.max(x(a), 0) + 1, r = Math.min(x(b), x(d1)) - 1;
      return `<button class="ln-p ${cls}" style="left:${l}px;width:${Math.max(r - l, 8)}px;top:${top}px;--c:var(--c-${color})" ${attrs}><span>${text}</span>${edge ? ends(edge, a, b) : ''}</button>`;
    };
    /** A transport or event tag: at a moment, or as wide as it lasts when zoomed in enough. */
    const flight = (/** @type {Item} */ it, /** @type {string} */ text, cls = '', attrs = '', top = 7) => {
      const p = P(it.id), w = (p.end - p.start) * ppd, ev = typeOf(it) === 'event' ? ' ev' : '';
      return `<button class="ln-fl ${cls}${ev}${w >= 56 ? ' long' : ''}" style="left:${x(p.start)}px;top:${top}px${w >= 56 ? `;width:${w}px` : ''}" ${attrs}>${iconOf(it)} <span>${text}</span></button>`;
    };
    /** A small icon on the line where a move (✈ by default) or event happens. */
    const dot = (/** @type {number} */ d, /** @type {number} */ top, icon = '✈') => `<i class="ln-dot" style="left:${x(d)}px;top:${top}px">${icon}</i>`;
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
        if (isHop(pk)) return flight(pk, `${esc(pk.name)}${more}`, '', `data-tg="${esc(it.id)}"`, top + 1);
        const r = rateOf(pk);
        const text = named ? `${esc(it.name)} · ${nightsTxt(it)}` : `${esc(pk.name)}${r && !hide ? ` · ${money(r, cur)}` : ''}`;
        return pill(p.start, p.end, pk.color, `${lead}${text}${more}`, `${ks.length > 1 ? 'deck' : ''} ${cls}`, `data-tg="${esc(it.id)}"`, top, it);
      }
      if (isHop(it)) return flight(it, esc(it.name), '', `data-sel="item:${esc(it.id)}"`, top + 1);
      const has = kidsOf(doc, it.id).length > 0;
      return pill(p.start, p.end, it.color, `${lead}${esc(it.name)} · ${nightsTxt(it)}`, `${cls}${typeOf(it) === 'event' ? ' ev' : ''}`, has ? `data-tg="${esc(it.id)}"` : `data-sel="item:${esc(it.id)}"`, top, it)
        + (arrival(it) ? dot(p.start, top + (sm ? 1 : 3)) : '');
    };

    /**
     * An item's children as one chain of bubbles in time order.
     * @param {Item} it @param {number} top @param {boolean} sm @param {string} lead
     */
    const chain = (it, top, sm, lead) => {
      const ks = kidsOf(doc, it.id).filter((k) => k.kind !== 'window').sort((a, b) => P(a.id).start - P(b.id).start);
      if (!ks.length) return bubble(it, top, sm, lead);
      let first = true, h = '';
      for (const k of ks) {
        const pk = k.kind === 'group' ? kidsOf(doc, k.id)[0] : k;
        if (pk && isHop(pk)) { h += dot(P(pk.id).start, top + (sm ? 1 : 3), iconOf(pk)); continue; }
        const one = k.kind === 'group' || !kidsOf(doc, k.id).length ? bubble(k, top, sm, first ? lead : '', true)
          : pill(P(k.id).start, P(k.id).end, k.color, `${first ? lead : ''}${esc(k.name)} · ${nightsTxt(k)}`, `${sm ? 'sm' : ''}`, `data-tg="${esc(it.id)}"`, top, k);
        h += one;
        first = false;
      }
      return h;
    };

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
      const car = has ? `<button class="ln-car${isOpen ? ' open' : ''}" data-tg="${esc(it.id)}" aria-expanded="${isOpen}" aria-label="${isOpen ? 'Close' : 'Open'} ${esc(it.name)}">▶</button>` : '<span class="ln-car none"></span>';
      const lab = `${rk}${car}<button class="ln-n" data-sel="item:${esc(it.id)}" title="${esc(it.name)}">${esc(it.name)}</button><small>${sub}</small>`;

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
          trk += chain(k, top, true, `${i === 0 ? '★ ' : ''}${esc(k.name)}: `) + totAt(extent(k), totalIfPicked(doc, k.id, opts), top + 3);
        });
        h = 12 + kids.length * LINE;
      } else if (it.kind === 'group') {
        const pk = kids[0];
        if (isOpen && isFork(doc, it) && kids.length > 1) {
          const t0 = totalIfPicked(doc, kids[0].id, opts), t1 = totalIfPicked(doc, kids[1].id, opts), dl = t1 - t0;
          trk += note(p.start, `${kids.map((k) => esc(k.name)).join(' or ')}${hide || !dl ? '' : ` · ${esc(kids[1].name)} is ${dl > 0 ? '+' : '−'}${money(Math.abs(dl), cur)} with its picks`}`);
        } else if (isOpen) {
          trk += pk && isHop(pk) ? note(P(pk.id).start + 0.3, `pick 1 of ${kids.length}`)
            : pill(p.start, p.end, pk?.color ?? 'gray', `pick 1 of ${kids.length}${pk ? ` · ${nightsTxt(it)}` : ''}`, 'span', `data-tg="${esc(it.id)}"`, 6, it);
        } else trk += bubble(it, 6, false, '');
      } else if (isHop(it)) {
        const v = val(it.id);
        if (group && !picked) {
          const dl = v - val(kidsOf(doc, group.id)[0].id);
          const tail = Math.max(p.end, p.start + (24 + it.name.length * 7.2) / ppd);
          trk += flight(it, esc(it.name), 'ghost', `data-sel="item:${esc(it.id)}"`)
            + (hide || !dl ? '' : note(tail, `${dl > 0 ? '+' : '−'}${money(Math.abs(dl), cur)}`));
        } else trk += flight(it, `${esc(it.name)}${hide ? '' : ` · ${money(v, cur)}`}`, '', `data-sel="item:${esc(it.id)}"`);
        if (it.note) trk += note(Math.max(p.end, p.start + (it.name.length * 7.2 + 150) / ppd), esc(it.note), 'red');
      } else if (has && !isOpen) {
        trk += chain(it, 6, false, '') + (narrow && group ? totAt(extent(it), val(it.id)) : '');
      } else if (has) {
        const [lo, hi] = costRange(doc, it.id, opts);
        trk += pill(p.start, p.end, it.color, `${esc(it.name)}${hide ? '' : lo === hi ? ` · ${money(lo, cur)}` : ` · ${money(lo, cur)}–${money(hi, cur)} depending on picks`}`, 'span', `data-tg="${esc(it.id)}"`, 6, it)
          + totAt(extent(it), val(it.id));
      } else {
        // A leaf: a stay, or one option among several.
        const v = val(it.id), r = rateOf(it), site = it.links[0] ? siteOf(it.links[0]) : '';
        const unit = it.unit === 'night' ? '/night' : it.unit === 'day' ? '/day' : '';
        let text = esc(it.name);
        if (group) {
          const dl = v - val(kidsOf(doc, group.id)[0].id);
          text = `${site ? `${esc(site)} · ` : ''}${r !== undefined && !hide ? `${money(r, cur)}${unit}` : esc(it.name)}${hide ? '' : picked ? ` · ${money(v, cur)}` : dl ? ` · ${dl > 0 ? '+' : '−'}${money(Math.abs(dl), cur)}` : ''}`;
        } else if (r !== undefined && !hide) text += ` · ${money(r, cur)}${unit}`;
        trk += pill(p.start, p.end, it.color, text, `${picked ? '' : 'ghost'} ${it.committed ? '' : 'opt'}${typeOf(it) === 'event' ? ' ev' : ''}`, `data-sel="item:${esc(it.id)}"`, 6, it)
          + (arrival(it) ? dot(p.start, 9) : '');
      }
      rows.push({ dep, h, lab, trk, tint: dep ? tint : undefined });
      if (!isOpen) return;
      kids.forEach((k, i) => visit(k, dep + 1, it.kind === 'group' ? it : undefined, i, dep ? tint : k.color));
    };
    kidsOf(doc, undefined).forEach((it) => visit(it, 0, undefined, 0, it.color));

    // Axis and weekend shading.
    // Axis: day numbers under month names between 9 and 150 px a day; hours above, months or years below.
    let ax = '', shade = '';
    const daily = ppd >= FIT_MIN && ppd < 150;
    for (let i = d0; i < d1; i++) {
      const dt = dateOf(i), wd = dt.getUTCDay(), we = wd === 0 || wd === 6;
      if (daily && (ppd >= 16 || wd === 1)) ax += `<span class="${we ? 'wk' : ''}" style="left:${x(i)}px;width:${ppd}px">${dt.getUTCDate()}</span>`;
      if (daily && (i === d0 || dt.getUTCDate() === 1)) ax += `<b style="left:${x(i)}px">${MON[dt.getUTCMonth()]} ${dt.getUTCFullYear()}</b>`;
      if (we && ppd >= 6) shade += `<i style="left:${L + x(i)}px;width:${ppd}px"></i>`;
    }
    if (!daily) {
      const t = axisTicks(d0, d1, ppd);
      for (const [d, label] of t.minor) ax += `<span class="tk" style="left:${x(d)}px">${esc(label)}</span>`;
      for (const [d, label] of t.major) ax += `<b style="left:${x(d)}px">${esc(label)}</b>`;
      if (t.k === 'h') for (const [d] of t.minor) shade += `<i class="hr" style="left:${L + x(d)}px"></i>`;
    }
    const today = nowIdx();
    if (today > d0 && today < d1) shade += `<i class="today" style="left:${L + x(today)}px"></i>`;

    const zb = (/** @type {string} */ k, /** @type {string} */ label) => `<button data-zoom="${k}" aria-pressed="${k === 'fit' ? this.zoom === 'fit' : this.active === k}">${label}</button>`;
    this.top.innerHTML = `${leanBar(this.app)}
  <div class="seg ln-all"><button data-all="1">Expand all</button><button data-all="0">Collapse all</button></div>
  <div class="seg ln-zoom" role="group" aria-label="Zoom"><button class="ln-step" data-step="out" aria-label="Zoom out">−</button>${zb('fit', 'Fit')}${Object.keys(PRESETS).map((k) => zb(k, k)).join('')}<button class="ln-step" data-step="in" aria-label="Zoom in">+</button></div>`;
    /** @type {HTMLElement} */ (this.top.nextElementSibling).innerHTML = `Tap a row's arrow or a bubble to open it, a number to make that option the pick, a name to see or edit it. Drag a bubble's ends to change its dates; pinch or ${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'}+scroll to zoom.${miss.length ? ' <b class="ln-miss-k">!</b> marks a change of place with no transport.' : ''}`;
    this.sc.innerHTML = `<div class="ln-grid" style="--L:${L}px;width:${L + W}px">
  <div class="ln-shade" aria-hidden="true">${shade}</div>
  <div class="ln-row ln-ax"><div class="ln-lab"></div><div class="ln-trk" style="width:${W}px">${ax}</div></div>
  ${rows.map((r) => `<div class="ln-row d${Math.min(r.dep, 3)}" style="height:${r.h}px${r.tint ? `;--t:var(--c-${r.tint})` : ''}"><div class="ln-lab" style="--dep:${r.dep}">${r.lab}</div><div class="ln-trk" style="width:${W}px">${r.trk}</div></div>`).join('')}
</div>`;
    if (this.drawn) this.sc.scrollLeft = (left - d0) * ppd;
    this.geo = { d0, ppd, L };
    this.keep = null;
    this.drawn = true;
  }
}
