// @ts-check
/**
 * The wall calendar view: the picked trip as highlighter strokes across
 * month grids, one stroke per stay, with flights marked on the day they
 * leave, unbooked nights ringed in red and double-booked nights in amber.
 * Optional stays not counted in totals show as dashed strokes.
 *
 * @module
 */
import { COLORS, dateOf, hhmm, layout, money, nowIdx, pick, setRank, total, typeOf } from './model.js';
import { placeOf } from './places.js';
import { hops, sleeps } from './trip.js';
import { iconOf, leanBar } from './lanes.js';
import { esc } from './ui.js';

/** @typedef {import('./ui.js').App} App */
/** @typedef {import('./model.js').Placed} Placed */
/** @typedef {{p: Placed, maybe: boolean}} Stroke */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export class Calendar {
  /**
   * Wires clicks inside `el`.
   * @param {HTMLElement} el Container.
   * @param {App} app
   */
  constructor(el, app) {
    this.el = el;
    this.app = app;
    el.addEventListener('click', (e) => {
      const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-sel],[data-pick]'));
      if (b?.dataset.pick) { const id = b.dataset.pick; app.change((doc) => setRank(doc, id, 0)); }
      else if (b?.dataset.sel) app.select(b.dataset.sel);
    });
  }

  /** Redraws the view. */
  render() {
    const { doc, optional, filter } = this.app, at = layout(doc), cur = doc.currency;
    const on = sleeps(doc, at, optional), ids = new Set(on.map((p) => p.item.id));
    /** @type {Stroke[]} */
    const strokes = [...on.map((p) => ({ p, maybe: false })),
      ...(optional ? [] : sleeps(doc, at, true).filter((p) => !ids.has(p.item.id)).map((p) => ({ p, maybe: true })))];
    const moves = hops(doc, at, optional);
    if (!strokes.length && !moves.length) {
      this.el.innerHTML = `${leanBar(this.app)}<p class="hint">Nothing to put on the calendar yet: add a stay with nights.</p>`;
      return;
    }
    const all = [...strokes.map((s) => s.p.start), ...strokes.map((s) => s.p.end), ...moves.map((h) => h.at)];
    const first = Math.floor(Math.min(...all)), last = Math.ceil(Math.max(...all));

    // Nights covered by counted stays: gaps and double bookings between the first and last night.
    /** @type {Map<number, number>} */
    const nights = new Map();
    for (const p of on) for (let d = Math.floor(p.start); d < Math.floor(p.end); d++) nights.set(d, (nights.get(d) ?? 0) + 1);
    const n0 = on.length ? Math.floor(on[0].start) : first, n1 = on.length ? Math.max(...on.map((p) => Math.floor(p.end))) : first;
    /** @type {Map<number, string>} */
    const ring = new Map();
    for (let d = n0; d < n1; d++) {
      const n = nights.get(d) ?? 0;
      if (n !== 1) ring.set(d, n ? 'ovl' : 'gap');
    }
    /** @type {Map<number, string[]>} */
    const fly = new Map();
    for (const h of moves) {
      const d = Math.floor(h.at);
      const icon = typeOf(h.item) === 'transport' ? iconOf(h.item) : '✈', full = `${h.label} ${hhmm((h.at % 1) * 24)}`;
      fly.set(d, [...(fly.get(d) ?? []), `<button class="cal-fl" data-sel="item:${esc(h.item.id)}" title="${esc(full)}" aria-label="${esc(full)}"><b>${icon} ${esc(h.to ?? h.label)}</b><small>${hhmm((h.at % 1) * 24)}</small></button>`]);
    }

    // One colour per place, so two stays in a row in the same trip colour (Taipei, then Tainan) still read apart.
    /** @type {Map<string, string>} */
    const tint = new Map();
    let prevTint = '';
    for (const s of strokes) {
      const place = placeOf(doc, s.p.item).name;
      if (!tint.has(place)) {
        const taken = new Set([...tint.values()]), own = s.p.item.color;
        tint.set(place, own !== prevTint && !taken.has(own) ? own : COLORS.find((c) => c !== 'gray' && !taken.has(c) && c !== prevTint) ?? own);
      }
      prevTint = /** @type {string} */ (tint.get(place));
    }
    /** The colour a stay's stroke is drawn in. */
    const colorOf = (/** @type {import('./model.js').Item} */ it) => tint.get(placeOf(doc, it).name) ?? it.color;

    const today = Math.floor(nowIdx());
    let html = '';
    const d0 = dateOf(first), d1 = dateOf(last - 1);
    for (let y = d0.getUTCFullYear(), m = d0.getUTCMonth(); y < d1.getUTCFullYear() || (y === d1.getUTCFullYear() && m <= d1.getUTCMonth()); m === 11 ? (y++, m = 0) : m++) {
      const mStart = Math.round(Date.UTC(y, m, 1) / 864e5), mEnd = Math.round(Date.UTC(y, m + 1, 1) / 864e5);
      const lead = (dateOf(mStart).getUTCDay() + 6) % 7, gridStart = mStart - lead;
      let weeks = '';
      for (let w = gridStart; w < mEnd; w += 7) {
        // Strokes crossing this week (within this month), stacked into lanes.
        /** @type {{a: number, b: number, s: Stroke, lane: number}[]} */
        const segs = [];
        for (const s of strokes) {
          const a = Math.max(Math.floor(s.p.start), w, mStart), b = Math.min(Math.floor(s.p.end), w + 7, mEnd);
          if (a >= b) continue;
          let lane = 0;
          while (segs.some((g) => g.lane === lane && g.a < b && a < g.b)) lane++;
          segs.push({ a, b, s, lane });
        }
        let cells = '';
        for (let d = w; d < w + 7; d++) {
          if (d < mStart || d >= mEnd) { cells += '<div class="cal-d out"></div>'; continue; }
          const r = d >= first && d < last ? ring.get(d) : undefined;
          cells += `<div class="cal-d${r ? ` ${r}` : ''}${d === today ? ' now' : ''}${(dateOf(d).getUTCDay() % 6) === 0 ? ' wkend' : ''}"><span class="n">${dateOf(d).getUTCDate()}</span>${(fly.get(d) ?? []).join('')}</div>`;
        }
        const bars = segs.map(({ a, b, s, lane }) => {
          const it = s.p.item, head = a === Math.floor(s.p.start);
          const place = placeOf(doc, it).name;
          const label = head ? esc(it.name.includes(place) ? it.name : `${place} · ${it.name}`) : b - a >= 3 ? esc(place) : '';
          return `<button class="cal-bar${s.maybe ? ' maybe' : ''}${head ? ' head' : ''}${Math.floor(s.p.end) === b ? ' tail' : ''}" data-sel="item:${esc(it.id)}"
  style="--c:var(--c-${colorOf(it)});left:${((a - w) / 7) * 100}%;width:${((b - a) / 7) * 100}%;--lane:${lane}" title="${esc(it.name)}${s.maybe ? ' (maybe)' : ''}"><span>${s.maybe && head ? 'maybe: ' : ''}${label}</span></button>`;
        }).join('');
        const lanes = Math.max(1, ...segs.map((g) => g.lane + 1));
        weeks += `<div class="cal-w" style="--lanes:${lanes}">${cells}<div class="cal-bars">${bars}</div></div>`;
      }
      html += `<section class="cal-m"><h3>${MONTHS[m]} <small>${y}</small></h3>
<div class="cal-h">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => `<span>${x}</span>`).join('')}</div>${weeks}</section>`;
    }

    // Legend: each counted stay with nights, and the trip total.
    const legend = on.map((p) => `<button data-sel="item:${esc(p.item.id)}" style="--c:var(--c-${colorOf(p.item)})"><i></i>${esc(placeOf(doc, p.item).name)} <small>${Math.round(p.end - p.start)}n</small></button>`).join('');
    const gaps = [...ring.values()].filter((v) => v === 'gap').length, ovl = [...ring.values()].filter((v) => v === 'ovl').length;
    const sum = filter === 'none' ? '' : `<b class="cal-tot">${money(pick(total(doc, { optional, at }), filter), cur)}</b>`;
    this.el.innerHTML = `${leanBar(this.app)}<div class="cal-legend">${legend}${gaps ? `<span class="cal-key gap">${gaps} unbooked</span>` : ''}${ovl ? `<span class="cal-key ovl">${ovl} double-booked</span>` : ''}${strokes.some((s) => s.maybe) ? '<span class="cal-key maybe">dashed = maybe, not counted</span>' : ''}${sum}</div>
<div class="cal-grid">${html}</div>`;
  }
}

