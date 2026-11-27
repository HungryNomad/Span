// @ts-check
/**
 * The story view: the picked trip told as chapters, one per place, with
 * the stay, its notes, links and pictures, what the rival options would
 * cost instead, boarding-pass stubs for the moves between places, and a
 * callout for every unbooked stretch. A fork in the plan gets a chapter of
 * its own with each trip's total.
 *
 * @module
 */
import { imageUrl } from './api.js';
import { ancestors, fmt, hhmm, kidsOf, layout, money, pick, setRank, siteOf, total } from './model.js';
import { legsOf, rivalsOf, stopsOf } from './places.js';
import { forkOf, ratesText, rivalDelta, valueOf } from './trip.js';
import { esc } from './ui.js';

/** @typedef {import('./ui.js').App} App */

export class Story {
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
    const { doc, optional, filter } = this.app, cur = doc.currency, at = layout(doc), opts = { optional, filter, at };
    const hide = filter === 'none';
    const { stops, before } = stopsOf(doc, at, optional), fork = forkOf(doc);

    /** A move as a boarding-pass stub. */
    const stub = (/** @type {import('./trip.js').Hop} */ h) => `<button class="st-stub" data-sel="item:${esc(h.item.id)}">
  <span class="st-from">${esc(h.from ?? '')}</span><span class="st-plane">✈</span><span class="st-to">${esc(h.to ?? '')}</span>
  <span class="st-det"><b>${esc(h.label)}</b>${fmt(h.at, { weekday: 'short' })} · ${hhmm((h.at % 1) * 24)}${hide ? '' : ` · ${money(h.cost, cur)}`}</span></button>`;

    // The fork's chapter goes just before the first stay or move inside its pick.
    let forkShown = !fork;
    /** The fork's chapter, once, if `it` is inside the fork's pick. */
    const forkCh = (/** @type {import('./model.js').Item} */ it) => {
      if (forkShown || !fork || !ancestors(doc, it).some((a) => a.id === fork.id)) return '';
      forkShown = true;
      const trips = kidsOf(doc, fork.id).map((k, i) => `<button class="st-trip${i === 0 ? ' on' : ''}" style="--c:var(--c-${k.color})" data-pick="${esc(k.id)}" aria-pressed="${i === 0}"><b>${i === 0 ? '★ ' : ''}${esc(k.name)}</b><span>${legsOf(doc, k.id).map(esc).join(' → ')}</span>${hide ? '' : `<em>${money(valueOf(doc, k.id, opts), cur)} for the trip</em>`}</button>`).join('');
      return `<section class="st-ch st-fork"><p class="st-k">The fork</p><h3>${esc(fork.name)}</h3><p>Nothing's decided yet. The story below follows the starred trip; tap another to read that one instead.</p><div class="st-trips">${trips}</div></section>`;
    };
    /** Boarding-pass stubs, with the fork's chapter ahead of the first one inside the fork. */
    const moves = (/** @type {import('./trip.js').Hop[]} */ hs) => hs.map((h) => forkCh(h.item) + stub(h)).join('');

    let body = moves(before), n = 0, prevEnd = /** @type {number | null} */ (null);
    for (const st of stops) {
      body += st.stays.map((q) => forkCh(q.item)).join('');
      if (prevEnd !== null && st.start > prevEnd + 0.01) {
        const g = Math.round(st.start - prevEnd);
        body += `<aside class="st-gap"><b>${g} night${g === 1 ? '' : 's'} with nowhere to sleep</b> ${fmt(prevEnd)} – ${fmt(st.start)}</aside>`;
      }
      prevEnd = Math.max(prevEnd ?? -Infinity, st.end);
      n++;
      const color = st.stays[0].item.color, nights = Math.round(st.end - st.start);
      let cost = 0;
      const paras = st.stays.map((q) => {
        const it = q.item, r = ratesText(doc, it), v = valueOf(doc, it.id, opts), rv = rivalsOf(doc, it);
        cost += v;
        const alts = rv ? rv.options.slice(1).map((o) => {
          const d = rivalDelta(doc, o.id, it.id, opts);
          return `<button class="lk" data-pick="${esc(o.id)}">${esc(o.name)}</button>${d ? ` (${esc(d)})` : ''}`;
        }) : [];
        const links = it.links.map((u) => `<a class="st-link" href="${esc(u)}" target="_blank" rel="noopener">${esc(siteOf(u))}</a>`).join('');
        const pics = it.images.slice(0, 4).map((id) => `<img src="${imageUrl(id, true)}" alt="Picture of ${esc(it.name)}" loading="lazy">`).join('');
        const nn = Math.round(q.end - q.start);
        return `<p>${nn} night${nn === 1 ? '' : 's'} at <button class="lk" data-sel="item:${esc(it.id)}">${esc(it.name)}</button>${r && !hide ? `, ${esc(r)}` : ''}.${alts.length ? ` Or ${alts.join(', or ')}.` : ''}${it.committed ? '' : ' <em>Maybe.</em>'}</p>
${it.note ? `<p class="st-note">${esc(it.note)}</p>` : ''}${links ? `<p class="st-links">${links}</p>` : ''}${pics ? `<div class="st-pics">${pics}</div>` : ''}`;
      }).join('');
      body += `<section class="st-ch" style="--c:var(--c-${color})"><p class="st-k">Chapter ${n} · ${fmt(st.start)} – ${fmt(st.end)}</p>
<h3>${esc(st.name)}</h3>${hide ? '' : `<span class="st-margin">${money(cost, cur)}<small>${nights} nights</small></span>`}${paras}</section>`;
      body += moves(st.hops);
    }

    const sum = total(doc, { optional, at }), places = new Set(stops.map((s) => s.name)).size;
    const nights = stops.reduce((t, s) => t + Math.round(s.end - s.start), 0);
    const span = stops.length ? `${fmt(stops[0].start, { weekday: 'short' })} – ${fmt(Math.max(...stops.map((s) => s.end)), { weekday: 'short' })}` : 'No stays yet';
    this.el.innerHTML = `<article class="st">
  <header class="st-cover"><p class="st-k">${esc(span)}</p><h2>${esc(this.app.planName || 'Your trip')}</h2>
    <div class="st-stats"><span><b>${nights}</b>nights</span><span><b>${places}</b>place${places === 1 ? '' : 's'}</span><span><b>${doc.people}</b>${doc.people === 1 ? 'person' : 'people'}</span>${hide ? '' : `<span><b>${money(pick(sum, filter), cur)}</b>in all</span>`}</div></header>
  ${body || '<p class="hint">Add a stay with nights to start the story.</p>'}
</article>`;
  }
}
