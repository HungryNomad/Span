// @ts-check
/**
 * The phone cards view: the picked trip as a stack of cards, one per place,
 * with flights as boarding-pass strips between them and unbooked nights as
 * red cards. Where the plan still forks, a choice card shows each trip with
 * its total. Any stay or flight with rivals opens to show them, with what
 * each would change, and a tap makes one the pick.
 *
 * @module
 */
import { ancestors, fmt, hhmm, kidsOf, layout, money, pick, setRank, siteOf, total } from './model.js';
import { legsOf, rivalsOf, stopsOf } from './places.js';
import { forkOf, rateOf, ratesText, rivalDelta, valueOf } from './trip.js';
import { esc } from './ui.js';

/** @typedef {import('./ui.js').App} App */
/** @typedef {import('./model.js').Item} Item */

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
    /** Money, or nothing when costs are hidden. */
    const hide = filter === 'none', $$ = (/** @type {number} */ n) => (hide ? '' : money(n, cur));
    const { stops, before } = stopsOf(doc, at, optional), fork = forkOf(doc);

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
    const pass = (/** @type {import('./trip.js').Hop} */ h) => `<div class="cd-pass"><button class="cd-pass-main" data-sel="item:${esc(h.item.id)}">
  <span class="cd-code">${esc(h.from ?? '✈')}</span><span class="cd-mid"><b>${esc(h.label)}</b><small>${fmt(h.at, { weekday: 'short' })} · ${hhmm((h.at % 1) * 24)} · ${+h.hours.toFixed(1)}h</small></span><span class="cd-code">${esc(h.to ?? '')}</span>
  ${hide ? '' : `<span class="mono">${money(h.cost, cur)}</span>`}</button>${h.item.unit === 'hour' ? rivals(h.item, 'flights') : ''}</div>`;

    // The choice card goes just before the first stay or move inside the fork's pick.
    let forkShown = !fork;
    /** The choice card, once, if `it` is inside the fork's pick. */
    const forkCard = (/** @type {Item} */ it) => {
      if (forkShown || !fork || !ancestors(doc, it).some((a) => a.id === fork.id)) return '';
      forkShown = true;
      const trips = kidsOf(doc, fork.id).map((k, i) => `<button class="cd-trip${i === 0 ? ' on' : ''}" style="--c:var(--c-${k.color})" data-pick="${esc(k.id)}" aria-pressed="${i === 0}">
  <b>${i === 0 ? '★ ' : ''}${esc(k.name)}</b><small>${legsOf(doc, k.id).map(esc).join(' → ')}</small>${hide ? '' : `<span class="mono">${money(valueOf(doc, k.id, opts), cur)}</span>`}</button>`).join('');
      return `<section class="cd cd-fork"><p class="k">Still deciding</p><h3>${esc(fork.name)}</h3><div class="cd-trips">${trips}</div><p class="hint">Tap a trip to plan with it. Each total is that trip on its own.</p></section>`;
    };
    /** Boarding-pass strips, with the choice card ahead of the first one inside the fork. */
    const moves = (/** @type {import('./trip.js').Hop[]} */ hs) => hs.map((h) => forkCard(h.item) + pass(h)).join('');

    let html = moves(before), prevEnd = /** @type {number | null} */ (null);
    for (const st of stops) {
      html += st.stays.map((q) => forkCard(q.item)).join('');
      if (prevEnd !== null && st.start > prevEnd + 0.01) {
        const n = Math.round(st.start - prevEnd);
        html += `<div class="cd cd-gap">${n} night${n === 1 ? '' : 's'} unbooked · ${fmt(prevEnd)} – ${fmt(st.start)}</div>`;
      }
      prevEnd = Math.max(prevEnd ?? -Infinity, st.end);
      const color = st.stays[0].item.color;
      const stays = st.stays.map((q) => {
        const r = ratesText(doc, q.item);
        return `<div class="cd-stay"><button class="lk" data-sel="item:${esc(q.item.id)}">${esc(q.item.name)}</button>
<small>${Math.round(q.end - q.start)} nights${r && !hide ? ` · ${esc(r)}` : ''}</small><span class="mono">${$$(valueOf(doc, q.item.id, opts))}</span>${rivals(q.item, 'places')}</div>`;
      }).join('');
      html += `<section class="cd" style="--c:var(--c-${color})"><p class="k">${fmt(st.start, { weekday: 'short' })} – ${fmt(st.end, { weekday: 'short' })}</p>
<h3>${esc(st.name)} <small>${Math.round(st.end - st.start)} nights</small></h3>${stays}</section>`;
      html += moves(st.hops);
    }
    if (!stops.length && !before.length) html = '<p class="hint">Add a stay with nights to see it as cards.</p>';
    const sum = total(doc, { optional, at });
    const span = stops.length ? `${fmt(stops[0].start)} – ${fmt(Math.max(...stops.map((s) => s.end)))}` : '';
    this.el.innerHTML = `<div class="cd-stack">${html}</div>
<div class="cd-foot"><span>${span}</span>${hide ? '' : `<b>${money(pick(sum, filter), cur)}</b>`}</div>`;
  }
}
