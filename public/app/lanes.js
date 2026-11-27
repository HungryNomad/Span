// @ts-check
/**
 * The lanes view (Span's main view): one row per item on a day grid, drawn
 * as rounded bubbles. Either/or groups collapse to a deck showing the pick;
 * forks (groups whose options are whole trips) collapse to one chain of
 * bubbles per option with its total. Open a row to see what's inside, and
 * tap an option's number to make it the pick.
 *
 * @module
 */
import {
  coverage, dateOf, fmt, hhmm, kidsOf, layout, money, nowIdx, setRank, siteOf, unitsOf,
} from './model.js';
import { costRange, forkOf, isFork, rateOf, totalIfPicked, valueOf } from './trip.js';
import { esc } from './ui.js';

/** @typedef {import('./ui.js').App} App */
/** @typedef {import('./model.js').Item} Item */
/** @typedef {import('./model.js').Placed} Placed */
/** @typedef {import('./model.js').Layout} Layout */
/** @typedef {{dep: number, h: number, lab: string, trk: string, tint?: string}} Row */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Row height, and height of one option line in a closed fork. */
const ROW = 36, LINE = 28;
/** Pixels per day: smallest when fitting, and the "Days" zoom. */
const MIN_PPD = 9, DAYS_PPD = 24;

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
    this.zoom = load('span-lanes-zoom') === 'days' ? 'days' : 'fit';
    el.addEventListener('click', (e) => this.click(/** @type {HTMLElement} */ (e.target)));
  }

  /** Forgets what was open, for a newly opened plan. */
  reset() { this.open = null; }

  /** @returns {string} localStorage key for the open rows of this plan. */
  get key() { return `span-lanes:${this.app.planId ?? 'local'}`; }

  /**
   * Handles a click anywhere in the view.
   * @param {HTMLElement} t Click target.
   */
  click(t) {
    const b = /** @type {HTMLElement | null} */ (t.closest('[data-tg],[data-pick],[data-all],[data-zoom],[data-sel]'));
    if (!b || !this.open) return;
    const { app } = this, d = b.dataset;
    if (d.pick) { const id = d.pick; app.change((doc) => setRank(doc, id, 0)); return; }
    if (d.sel) { app.select(d.sel); return; }
    if (d.zoom) { this.zoom = d.zoom === 'days' ? 'days' : 'fit'; store('span-lanes-zoom', this.zoom); }
    else if (d.all) {
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
    const d1 = span.length ? Math.ceil(Math.max(...span.map((p) => p.show))) + 2 : d0 + 30;
    const L = narrow ? 138 : 214, TAIL = hide ? 24 : 96;
    const avail = (this.el.clientWidth || innerWidth) - L - TAIL - 4;
    const ppd = this.zoom === 'days' ? DAYS_PPD : Math.max(MIN_PPD, Math.min(DAYS_PPD, avail / (d1 - d0)));
    const W = Math.ceil((d1 - d0) * ppd) + TAIL;
    /** Pixel offset of a day in the track. */
    const x = (/** @type {number} */ d) => (d - d0) * ppd;

    /** A bubble from day a to b. */
    const pill = (/** @type {number} */ a, /** @type {number} */ b, /** @type {string} */ color, /** @type {string} */ text, cls = '', attrs = '', top = 6) => {
      const l = Math.max(x(a), 0) + 1, r = Math.min(x(b), x(d1)) - 1;
      return `<button class="ln-p ${cls}" style="left:${l}px;width:${Math.max(r - l, 8)}px;top:${top}px;--c:var(--c-${color})" ${attrs}><span>${text}</span></button>`;
    };
    /** A flight tag at a moment. */
    const flight = (/** @type {number} */ d, /** @type {string} */ text, cls = '', attrs = '', top = 7) =>
      `<button class="ln-fl ${cls}" style="left:${x(d)}px;top:${top}px" ${attrs}>✈ ${text}</button>`;
    /** A small plane on the line where a move happens. */
    const dot = (/** @type {number} */ d, /** @type {number} */ top) => `<i class="ln-dot" style="left:${x(d)}px;top:${top}px">✈</i>`;
    /** A total just after day d. */
    const totAt = (/** @type {number} */ d, /** @type {number} */ n, top = 10, small = '') =>
      hide ? '' : `<span class="ln-tot" style="left:${x(d) + 12}px;top:${top}px">${money(n, cur)}${small ? `<small>${small}</small>` : ''}</span>`;
    /** A line of grey text after day d. */
    const note = (/** @type {number} */ d, /** @type {string} */ text, cls = '', top = 11) => `<span class="ln-note ${cls}" style="left:${x(d) + 6}px;top:${top}px">${text}</span>`;
    /** Whether an item is a flight or other hour-long move. */
    const isHop = (/** @type {Item} */ it) => it.kind === 'item' && it.unit === 'hour';
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
        if (isHop(pk)) return flight(P(pk.id).start, `${esc(pk.name)}${more}`, '', `data-tg="${esc(it.id)}"`, top + 1);
        const r = rateOf(pk);
        const text = named ? `${esc(it.name)} · ${nightsTxt(it)}` : `${esc(pk.name)}${r && !hide ? ` · ${money(r, cur)}` : ''}`;
        return pill(p.start, p.end, pk.color, `${lead}${text}${more}`, `${ks.length > 1 ? 'deck' : ''} ${cls}`, `data-tg="${esc(it.id)}"`, top);
      }
      if (isHop(it)) return flight(p.start, esc(it.name), '', `data-sel="item:${esc(it.id)}"`, top + 1);
      const has = kidsOf(doc, it.id).length > 0;
      return pill(p.start, p.end, it.color, `${lead}${esc(it.name)} · ${nightsTxt(it)}`, cls, has ? `data-tg="${esc(it.id)}"` : `data-sel="item:${esc(it.id)}"`, top)
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
        if (pk && isHop(pk)) { h += dot(P(pk.id).start, top + (sm ? 1 : 3)); continue; }
        const one = k.kind === 'group' || !kidsOf(doc, k.id).length ? bubble(k, top, sm, first ? lead : '', true)
          : pill(P(k.id).start, P(k.id).end, k.color, `${first ? lead : ''}${esc(k.name)} · ${nightsTxt(k)}`, `${sm ? 'sm' : ''}`, `data-tg="${esc(it.id)}"`, top);
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
            : pill(p.start, p.end, pk?.color ?? 'gray', `pick 1 of ${kids.length}${pk ? ` · ${nightsTxt(it)}` : ''}`, 'span', `data-tg="${esc(it.id)}"`);
        } else trk += bubble(it, 6, false, '');
      } else if (isHop(it)) {
        const v = val(it.id);
        if (group && !picked) {
          const dl = v - val(kidsOf(doc, group.id)[0].id);
          trk += flight(p.start, esc(it.name), 'ghost', `data-sel="item:${esc(it.id)}"`)
            + (hide || !dl ? '' : note(p.start + 7 / ppd + it.name.length * 7.2 / ppd, `${dl > 0 ? '+' : '−'}${money(Math.abs(dl), cur)}`));
        } else trk += flight(p.start, `${esc(it.name)}${hide ? '' : ` · ${money(v, cur)}`}`, '', `data-sel="item:${esc(it.id)}"`);
        if (it.note) trk += note(p.start + (it.name.length * 7.2 + 150) / ppd, esc(it.note), 'red');
      } else if (has && !isOpen) {
        trk += chain(it, 6, false, '') + (narrow && group ? totAt(extent(it), val(it.id)) : '');
      } else if (has) {
        const [lo, hi] = costRange(doc, it.id, opts);
        trk += pill(p.start, p.end, it.color, `${esc(it.name)}${hide ? '' : lo === hi ? ` · ${money(lo, cur)}` : ` · ${money(lo, cur)}–${money(hi, cur)} depending on picks`}`, 'span', `data-tg="${esc(it.id)}"`)
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
        trk += pill(p.start, p.end, it.color, text, `${picked ? '' : 'ghost'} ${it.committed ? '' : 'opt'}`, `data-sel="item:${esc(it.id)}"`)
          + (arrival(it) ? dot(p.start, 9) : '');
      }
      rows.push({ dep, h, lab, trk, tint: dep ? tint : undefined });
      if (!isOpen) return;
      kids.forEach((k, i) => visit(k, dep + 1, it.kind === 'group' ? it : undefined, i, dep ? tint : k.color));
    };
    kidsOf(doc, undefined).forEach((it) => visit(it, 0, undefined, 0, it.color));

    // Axis and weekend shading.
    let ax = '', shade = '';
    for (let i = d0; i < d1; i++) {
      const dt = dateOf(i), wd = dt.getUTCDay(), we = wd === 0 || wd === 6;
      if (ppd >= 16 || (ppd >= 9 && wd === 1)) ax += `<span class="${we ? 'wk' : ''}" style="left:${x(i)}px;width:${ppd}px">${dt.getUTCDate()}</span>`;
      if (i === d0 || dt.getUTCDate() === 1) ax += `<b style="left:${x(i)}px">${MON[dt.getUTCMonth()]} ${dt.getUTCFullYear()}</b>`;
      if (we && ppd >= 6) shade += `<i style="left:${L + x(i)}px;width:${ppd}px"></i>`;
    }
    const today = nowIdx();
    if (today > d0 && today < d1) shade += `<i class="today" style="left:${L + x(today)}px"></i>`;

    this.el.innerHTML = `<div class="ln-top">${leanBar(this.app)}
  <div class="seg ln-all"><button data-all="1">Expand all</button><button data-all="0">Collapse all</button></div>
  <div class="seg ln-zoom" role="group" aria-label="Zoom"><button data-zoom="fit" aria-pressed="${this.zoom === 'fit'}">Fit</button><button data-zoom="days" aria-pressed="${this.zoom === 'days'}">Days</button></div></div>
<p class="ln-hint">Tap a row's arrow or a bubble to open it. Tap a number to make that option the pick, and the totals follow. ★ marks the trip you're leaning toward. Tap a name to see or edit it.</p>
<div class="ln-scroll"><div class="ln-grid" style="--L:${L}px;width:${L + W}px">
  <div class="ln-shade" aria-hidden="true">${shade}</div>
  <div class="ln-row ln-ax"><div class="ln-lab"></div><div class="ln-trk" style="width:${W}px">${ax}</div></div>
  ${rows.map((r) => `<div class="ln-row d${Math.min(r.dep, 3)}" style="height:${r.h}px${r.tint ? `;--t:var(--c-${r.tint})` : ''}"><div class="ln-lab" style="--dep:${r.dep}">${r.lab}</div><div class="ln-trk" style="width:${W}px">${r.trk}</div></div>`).join('')}
</div></div>`;
  }
}
