// @ts-check
/**
 * The wall calendar view: the picked trip as highlighter strokes across
 * month grids, one stroke per stay, with moves marked on the day they
 * leave, unbooked nights ringed and barred in red (named for their
 * placeholder) and double-booked nights ringed in amber. Optional stays not
 * counted in totals show as dashed strokes. Nights and problems come from
 * the shared checks, so the counts match the rest of the app.
 *
 * @module
 */
import { COLORS, byId, dateOf, hhmm, layout, nowIdx, pick, setRank, total } from './model.js';
import { placeOf } from './places.js';
import { hops } from './trip.js';
import { leanBar } from './lanes.js';
import { beds, doubleRuns, gapRuns, nightsIn, whoOf } from './checks.js';
import { costText, gapsOf, modeIcon, unpricedCount } from './cards.js';
import { esc } from './ui.js';

/** @typedef {import('./ui.js').App} App */
/** @typedef {import('./model.js').Placed} Placed */
/** @typedef {{p: Placed, maybe: boolean}} Stroke */
/**
 * A bar to draw across the weeks: a stay's stroke or an unbooked stretch.
 * @typedef {object} Bar
 * @property {number} a First night.
 * @property {number} b Morning after the last night.
 * @property {string} label Same on every week's piece.
 * @property {string} cls Extra class: "", "maybe" or "gap".
 * @property {string} color Colour token name.
 * @property {string} [id] Item a click opens.
 */

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
    const bd = beds(doc, at, optional), gaps = gapsOf(bd, false), moves = hops(doc, at, optional);
    // Stays from the shared night check: booked ones as strokes, unbooked ones outside a gap as dashed maybes.
    const runs = bd?.lines.flatMap((l) => l.runs) ?? [], inGap = new Set(gaps.flatMap((g) => g.ids));
    const booked = new Set(runs.flatMap((r) => r.ids)), maybes = new Set(runs.flatMap((r) => r.maybe).filter((id) => !inGap.has(id)));
    /** Placed strokes for some stay ids. */
    const placed = (/** @type {Set<string>} */ ids, /** @type {boolean} */ maybe) => [...ids].flatMap((id) => { const p = at.get(id); return p ? [{ p, maybe }] : []; });
    const on = placed(booked, false).sort((x, y) => x.p.start - y.p.start);
    /** @type {Stroke[]} */
    const strokes = [...on, ...placed(maybes, true)].sort((x, y) => x.p.start - y.p.start);
    if (!strokes.length && !moves.length && !gaps.length) {
      this.el.innerHTML = `${leanBar(this.app)}<p class="hint">Nothing to put on the calendar yet: add a stay with nights.</p>`;
      return;
    }
    const all = [...strokes.map((s) => s.p.start), ...strokes.map((s) => s.p.end), ...moves.map((h) => h.at), ...(bd ? [bd.a, bd.b] : [])];
    const first = Math.floor(Math.min(...all)), last = Math.ceil(Math.max(...all));

    // Unbooked and double-booked nights, as the header counts them.
    const unbooked = gapRuns(bd), doubles = doubleRuns(bd);
    /** @type {Map<number, string>} */
    const ring = new Map();
    for (const [list, cls] of /** @type {[import('./checks.js').Issue[], string][]} */ ([[unbooked, 'gap'], [doubles, 'ovl']])) {
      for (const r of list) for (let d = r.a; d < r.b; d++) ring.set(d, cls);
    }
    /** @type {Map<number, string[]>} */
    const fly = new Map();
    for (const h of moves) {
      const d = Math.floor(h.at), full = `${h.label} ${hhmm((h.at % 1) * 24)}`;
      fly.set(d, [...(fly.get(d) ?? []), `<button class="cal-fl" data-sel="item:${esc(h.item.id)}" title="${esc(full)}" aria-label="${esc(full)}"><b>${modeIcon(h.item)} ${esc(h.to ?? h.label)}</b><small>${hhmm((h.at % 1) * 24)}</small></button>`]);
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

    /** A stroke's label: its place and name, and whose it is when people are apart. */
    const labelOf = (/** @type {Stroke} */ s) => {
      const it = s.p.item, pl = placeOf(doc, it), who = bd?.split ? whoOf(doc, it) : undefined;
      const name = !pl.sure || it.name.includes(pl.name) ? it.name : `${pl.name} · ${it.name}`;
      return `${s.maybe ? 'maybe: ' : ''}${who && !name.startsWith(who) ? `${who}: ` : ''}${name}`;
    };
    /** A gap's label: what people are doing apart, else its placeholders' names. */
    const gapLabel = (/** @type {import('./cards.js').Gap} */ g) => {
      const names = g.ids.map((id) => byId(doc, id)?.name).filter(Boolean).join(' / ');
      const what = g.apart ? `${g.apart} · ${g.who.length ? 'no bed booked' : 'nobody has a bed booked'}` : names || 'Unbooked';
      return `${g.who.length && !g.apart ? `${g.who.join(', ')}: ` : ''}${what}`;
    };
    /** @type {Bar[]} */
    const bars = [
      ...strokes.map((s) => ({ a: Math.floor(s.p.start), b: Math.floor(s.p.end), label: labelOf(s), cls: s.maybe ? 'maybe' : '', color: colorOf(s.p.item), id: s.p.item.id })),
      ...gaps.map((g) => ({ a: g.a, b: g.b, label: gapLabel(g), cls: 'gap', color: 'gray', id: g.ids[0] })),
    ];

    const today = Math.floor(nowIdx());
    let html = '';
    const d0 = dateOf(first), d1 = dateOf(last - 1);
    for (let y = d0.getUTCFullYear(), m = d0.getUTCMonth(); y < d1.getUTCFullYear() || (y === d1.getUTCFullYear() && m <= d1.getUTCMonth()); m === 11 ? (y++, m = 0) : m++) {
      const mStart = Math.round(Date.UTC(y, m, 1) / 864e5), mEnd = Math.round(Date.UTC(y, m + 1, 1) / 864e5);
      const lead = (dateOf(mStart).getUTCDay() + 6) % 7, gridStart = mStart - lead;
      let weeks = '';
      for (let w = gridStart; w < mEnd; w += 7) {
        // Bars crossing this week (within this month), stacked into lanes.
        /** @type {{a: number, b: number, bar: Bar, lane: number}[]} */
        const segs = [];
        for (const bar of bars) {
          const a = Math.max(bar.a, w, mStart), b = Math.min(bar.b, w + 7, mEnd);
          if (a >= b) continue;
          let lane = 0;
          while (segs.some((g) => g.lane === lane && g.a < b && a < g.b)) lane++;
          segs.push({ a, b, bar, lane });
        }
        let cells = '';
        for (let d = w; d < w + 7; d++) {
          if (d < mStart || d >= mEnd) { cells += '<div class="cal-d out"></div>'; continue; }
          const r = d >= first && d < last ? ring.get(d) : undefined;
          cells += `<div class="cal-d${r ? ` ${r}` : ''}${d === today ? ' now' : ''}${(dateOf(d).getUTCDay() % 6) === 0 ? ' wkend' : ''}"><span class="n">${dateOf(d).getUTCDate()}</span>${(fly.get(d) ?? []).join('')}</div>`;
        }
        const pieces = segs.map(({ a, b, bar, lane }) => {
          const tag = bar.id ? 'button' : 'span', cls = `cal-bar${bar.cls ? ` ${bar.cls}` : ''}${a === bar.a ? ' head' : ''}${b === bar.b ? ' tail' : ''}`;
          return `<${tag} class="${cls}"${bar.id ? ` data-sel="item:${esc(bar.id)}"` : ''}
  style="--c:var(--c-${bar.color});left:${((a - w) / 7) * 100}%;width:${((b - a) / 7) * 100}%;--lane:${lane}" title="${esc(bar.label)}"><span>${esc(bar.label)}</span></${tag}>`;
        }).join('');
        const lanes = Math.max(1, ...segs.map((g) => g.lane + 1));
        weeks += `<div class="cal-w" style="--lanes:${lanes}">${cells}<div class="cal-bars">${pieces}</div></div>`;
      }
      html += `<section class="cal-m"><h3>${MONTHS[m]} <small>${y}</small></h3>
<div class="cal-h">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => `<span>${x}</span>`).join('')}</div>${weeks}</section>`;
    }

    // Legend: each booked stay with nights, the problem counts, and the trip total.
    const legend = on.map((s) => `<button data-sel="item:${esc(s.p.item.id)}" style="--c:var(--c-${colorOf(s.p.item)})"><i></i>${esc(placeOf(doc, s.p.item).name)} <small>${Math.round(s.p.end - s.p.start)}n</small></button>`).join('');
    const gapN = nightsIn(unbooked), ovlN = nightsIn(doubles);
    const sum = filter === 'none' ? '' : `<b class="cal-tot">${costText(pick(total(doc, { optional, at }), filter), unpricedCount(doc, optional, filter), cur)}</b>`;
    this.el.innerHTML = `${leanBar(this.app)}<div class="cal-legend">${legend}${gapN ? `<span class="cal-key gap">${gapN} unbooked</span>` : ''}${ovlN ? `<span class="cal-key ovl">${ovlN} double-booked</span>` : ''}${strokes.some((s) => s.maybe) ? '<span class="cal-key maybe">dashed = maybe, not counted</span>' : ''}${sum}</div>
<div class="cal-grid">${html}</div>`;
  }
}
