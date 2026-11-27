// @ts-check
/**
 * The phone cards view: the picked trip as a stack of cards in time order,
 * one per place, with moves as boarding-pass strips between them and
 * unbooked nights as red cards. Where the plan still forks, a choice card
 * shows each trip with its total. Any stay or flight with rivals opens to
 * show them, with what each would change, and a tap makes one the pick.
 * Also holds the pure helpers the story and calendar share with it.
 *
 * @module
 */
import { MODES, ancestors, byId, fmt, hhmm, kidsOf, layout, money, pick, setRank, siteOf, total, typeOf } from './model.js';
import { legsOf, rivalsOf, stopsOf } from './places.js';
import { forkOf, hops, rateOf, ratesText, rivalDelta, valueOf } from './trip.js';
import { beds, gapRuns, isUnpriced, unpricedIn } from './checks.js';
import { esc } from './ui.js';

/** @typedef {import('./ui.js').App} App */
/** @typedef {import('./model.js').Item} Item */
/** @typedef {import('./model.js').PlanDoc} PlanDoc */
/** @typedef {import('./model.js').Layout} Layout */
/** @typedef {import('./model.js').CostFilter} CostFilter */
/** @typedef {import('./checks.js').Beds} Beds */
/** @typedef {import('./places.js').Stop} Stop */
/** @typedef {import('./trip.js').Hop} Hop */

/**
 * Nights when people are apart, with what each is doing.
 * @typedef {object} Apart
 * @property {number} a First night.
 * @property {number} b Morning after the last night.
 * @property {string} text e.g. "Sam: Tokyo · Alex: Berlin".
 */

/**
 * An unbooked stretch of nights.
 * @typedef {object} Gap
 * @property {number} a First night.
 * @property {number} b Morning after the last night.
 * @property {string[]} who People it applies to (empty: everyone).
 * @property {string[]} ids Unbooked placeholder stays covering it.
 * @property {string} apart What each person is doing then, when apart, else empty.
 */

/**
 * One thing in the trip at its place in time: a stop, a gap or a move.
 * @typedef {{at: number, stop?: Stop, gap?: Gap, hop?: Hop}} Entry
 */

/**
 * Runs of nights when people are apart (see `BedRun.where`).
 * @param {Beds | null} bd
 * @returns {Apart[]}
 */
export function apartRuns(bd) {
  /** @type {Apart[]} */
  const out = [];
  if (!bd?.split) return out;
  for (let d = bd.a; d < bd.b; d++) {
    const text = bd.lines.map((l) => {
      const where = l.runs.find((r) => r.a <= d && d < r.b)?.where;
      return where ? `${l.who}: ${where}` : '';
    }).filter(Boolean).join(' · ');
    const last = out.at(-1);
    if (!text) continue;
    if (last && last.b === d && last.text === text) last.b = d + 1;
    else out.push({ a: d, b: d + 1, text });
  }
  return out;
}

/**
 * Unbooked stretches from {@link gapRuns}, split where who is apart changes.
 * With `merge`, back-to-back runs for the same people join into one.
 * @param {Beds | null} bd
 * @param {boolean} [merge]
 * @returns {Gap[]}
 */
export function gapsOf(bd, merge = true) {
  const apart = apartRuns(bd);
  /** @type {Gap[]} */
  const out = [];
  for (const g of gapRuns(bd)) {
    for (let d = g.a; d < g.b; d++) {
      const text = apart.find((r) => r.a <= d && d < r.b)?.text ?? '', last = out.at(-1);
      const same = last && last.b === d && last.who.join() === g.who.join() && last.apart === text && (merge || last.ids.join() === g.ids.join());
      if (last && same) {
        last.b = d + 1;
        for (const id of g.ids) if (!last.ids.includes(id)) last.ids.push(id);
      } else out.push({ a: d, b: d + 1, who: g.who, ids: [...g.ids], apart: text });
    }
  }
  return out;
}

/**
 * The picked trip in time order: stops, unbooked stretches and moves. A
 * stop keeps only the stays the shared night check counts as beds, so a
 * container (a place, or an item holding others) never shows as a stay. A
 * stop or gap sits on the evening of its first night, so a move that day
 * comes first; a move sits at its departure.
 * @param {PlanDoc} doc
 * @param {Layout} at
 * @param {boolean} optional
 * @param {Beds | null} bd From `beds(doc, at, optional)`.
 * @returns {Entry[]}
 */
export function entriesOf(doc, at, optional, bd) {
  const night = (/** @type {number} */ d) => Math.floor(d) + 0.75;
  const bed = new Set(bd?.lines.flatMap((l) => l.runs.flatMap((r) => [...r.ids, ...r.maybe])));
  /** @type {Entry[]} */
  const out = [];
  for (const st of stopsOf(doc, at, optional).stops) {
    const stays = st.stays.filter((q) => bed.has(q.item.id));
    if (!stays.length) continue;
    const stop = { ...st, stays, start: Math.min(...stays.map((q) => q.start)), end: Math.max(...stays.map((q) => q.end)) };
    out.push({ at: night(stop.start), stop });
  }
  for (const gap of gapsOf(bd)) out.push({ at: night(gap.a), gap });
  for (const hop of hops(doc, at, optional)) out.push({ at: hop.at, hop });
  return out.sort((x, y) => x.at - y.at);
}

/**
 * Unpriced items counted toward a total (within `root`, or the whole plan),
 * keeping only the kind the cost filter shows.
 * @param {PlanDoc} doc
 * @param {boolean} optional
 * @param {CostFilter} filter
 * @param {string} [root]
 * @returns {number}
 */
export const unpricedCount = (doc, optional, filter, root) =>
  unpricedIn(doc, optional, root).filter((it) => filter === 'all' || (filter === 'stays') === (typeOf(it) === 'stay')).length;

/**
 * A total as text that owns up to missing prices: "$408", "$408 + 2
 * unpriced", or "no price" when nothing in it is priced.
 * @param {number} sum
 * @param {number} unpriced Items in it with no price yet.
 * @param {string} cur Currency code.
 * @returns {string}
 */
export const costText = (sum, unpriced, cur) => (!unpriced ? money(sum, cur) : sum ? `${money(sum, cur)} + ${unpriced} unpriced` : 'no price');

/**
 * The icon for how a move travels.
 * @param {Item} it A transport item, or a stay with a fare (a flight).
 * @returns {string}
 */
export const modeIcon = (it) => (typeOf(it) === 'transport' ? MODES[it.mode ?? 'other'][1] : MODES.plane[1]);

/**
 * "N nights" with the right plural.
 * @param {number} n
 * @returns {string}
 */
export const nightsText = (n) => `${n} night${n === 1 ? '' : 's'}`;

/**
 * Placeholder stays as links that open them.
 * @param {PlanDoc} doc
 * @param {string[]} ids
 * @returns {string} HTML, empty with none.
 */
export const placeholderLinks = (doc, ids) => ids.flatMap((id) => {
  const it = byId(doc, id);
  return it ? [`<button class="lk" data-sel="item:${esc(it.id)}">${esc(it.name)}</button>`] : [];
}).join(', ');

export class Cards {
  /**
   * Wires clicks and opened cards inside `el`.
   * @param {HTMLElement} el Container.
   * @param {App} app
   */
  constructor(el, app) {
    this.el = el;
    this.app = app;
    /** Cards whose options are showing, kept across redraws. */
    this.shown = /** @type {Set<string>} */ (new Set());
    el.addEventListener('click', (e) => {
      const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-sel],[data-pick]'));
      if (b?.dataset.pick) { const id = b.dataset.pick; app.change((doc) => setRank(doc, id, 0)); }
      else if (b?.dataset.sel) app.select(b.dataset.sel);
    });
    el.addEventListener('toggle', (e) => {
      const d = /** @type {HTMLDetailsElement} */ (e.target), k = d.dataset.k;
      if (k) d.open ? this.shown.add(k) : this.shown.delete(k);
    }, true);
  }

  /** Redraws the view. */
  render() {
    const { doc, optional, filter } = this.app, cur = doc.currency, at = layout(doc), opts = { optional, filter, at };
    const hide = filter === 'none', fork = forkOf(doc), bd = beds(doc, at, optional);
    /** What an item and everything in it comes to, or nothing when costs are hidden. */
    const cost = (/** @type {string} */ id) => (hide ? '' : costText(valueOf(doc, id, opts), unpricedCount(doc, optional, filter, id), cur));

    /**
     * The other options for a picked item, as a drawer under it.
     * @param {Item} it @param {string} what e.g. "rooms"
     */
    const rivals = (it, what) => {
      const r = rivalsOf(doc, it);
      if (!r) return '';
      const k = `r:${r.group.id}`;
      const rows = r.options.slice(1).map((o) => `<div class="cd-alt"><div><b>${esc(o.name)}</b><small>${o.links[0] ? `${esc(siteOf(o.links[0]))} · ` : ''}${rateOf(o) !== undefined && !hide ? `${money(/** @type {number} */ (rateOf(o)), cur)}${o.unit === 'night' ? '/night' : ''}` : esc(o.note ?? '')}</small></div>
<span class="mono">${esc(rivalDelta(doc, o.id, it.id, opts))}</span><button class="btn" data-pick="${esc(o.id)}">Pick</button></div>`).join('');
      return `<details data-k="${esc(k)}"${this.shown.has(k) ? ' open' : ''}><summary>1 of ${r.options.length} ${what} · see the others</summary>${rows}</details>`;
    };

    /** A move as a boarding-pass strip. */
    const pass = (/** @type {Hop} */ h) => `<div class="cd-pass"><button class="cd-pass-main" data-sel="item:${esc(h.item.id)}">
  <span class="cd-code">${esc(h.from ?? modeIcon(h.item))}</span><span class="cd-mid"><b>${esc(h.label)}</b><small>${fmt(h.at, { weekday: 'short' })} · ${hhmm((h.at % 1) * 24)} · ${+h.hours.toFixed(1)}h</small></span><span class="cd-code">${esc(h.to ?? '')}</span>
  ${hide ? '' : `<span class="mono">${isUnpriced(h.item) ? 'no price' : money(h.cost, cur)}</span>`}</button>${h.item.unit === 'hour' ? rivals(h.item, 'flights') : ''}</div>`;

    // The choice card goes just before the first stay or move inside the fork's pick.
    let forkShown = !fork;
    /** The choice card, once, if `it` is inside the fork's pick. */
    const forkCard = (/** @type {Item} */ it) => {
      if (forkShown || !fork || !ancestors(doc, it).some((a) => a.id === fork.id)) return '';
      forkShown = true;
      const trips = kidsOf(doc, fork.id).map((k, i) => `<button class="cd-trip${i === 0 ? ' on' : ''}" style="--c:var(--c-${k.color})" data-pick="${esc(k.id)}" aria-pressed="${i === 0}">
  <b>${i === 0 ? '★ ' : ''}${esc(k.name)}</b><small>${legsOf(doc, k.id).map(esc).join(' → ')}</small>${hide ? '' : `<span class="mono">${cost(k.id)}</span>`}</button>`).join('');
      return `<section class="cd cd-fork"><p class="k">Still deciding</p><h3>${esc(fork.name)}</h3><div class="cd-trips">${trips}</div><p class="hint">Tap a trip to plan with it. Each total is that trip on its own.</p></section>`;
    };

    /** A stop as a card. */
    const stopCard = (/** @type {Stop} */ st) => {
      const stays = st.stays.map((q) => {
        const r = ratesText(doc, q.item);
        return `<div class="cd-stay"><button class="lk" data-sel="item:${esc(q.item.id)}">${esc(q.item.name)}</button>
<small>${Math.round(q.end - q.start)} nights${r && !hide ? ` · ${esc(r)}` : ''}</small><span class="mono">${cost(q.item.id)}</span>${rivals(q.item, 'places')}</div>`;
      }).join('');
      return `${st.stays.map((q) => forkCard(q.item)).join('')}<section class="cd" style="--c:var(--c-${st.stays[0].item.color})"><p class="k">${fmt(st.start, { weekday: 'short' })} – ${fmt(st.end, { weekday: 'short' })}</p>
<h3>${esc(st.name)} <small>${Math.round(st.end - st.start)} nights</small></h3>${stays}</section>`;
    };

    /** An unbooked stretch as a red card. */
    const gapCard = (/** @type {Gap} */ g) => {
      const links = placeholderLinks(doc, g.ids), who = g.who.length ? `${g.who.join(' and ')}: ` : '';
      const apart = g.apart ? `${esc(g.apart)} · ${g.who.length ? 'no bed booked' : 'nobody has a bed booked'}` : '';
      const sub = [apart, links].filter(Boolean).join('<br>');
      return `<div class="cd cd-gap">${esc(who)}${nightsText(g.b - g.a)} unbooked · ${fmt(g.a)} – ${fmt(g.b)}${sub ? `<small>${sub}</small>` : ''}</div>`;
    };

    const entries = entriesOf(doc, at, optional, bd);
    let html = entries.map((e) => (e.stop ? stopCard(e.stop) : e.gap ? gapCard(e.gap) : e.hop ? forkCard(e.hop.item) + pass(e.hop) : '')).join('');
    if (!entries.length) html = '<p class="hint">Add a stay with nights to see it as cards.</p>';
    const sum = costText(pick(total(doc, { optional, at }), filter), unpricedCount(doc, optional, filter), cur);
    const span = bd ? `${fmt(bd.a)} – ${fmt(bd.b)}` : '';
    this.el.innerHTML = `<div class="cd-stack">${html}</div>
<div class="cd-foot"><span>${span}</span>${hide ? '' : `<b>${sum}</b>`}</div>`;
  }
}
