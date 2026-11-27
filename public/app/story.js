// @ts-check
/**
 * The story view: the picked trip told in time order as chapters, one per
 * place, with the stay, its notes, links and pictures, what the rival
 * options would cost instead, boarding-pass stubs for the moves between
 * places, and a callout for every unbooked stretch. A fork in the plan
 * gets a chapter of its own with each trip's total.
 *
 * @module
 */
import { imageUrl } from './api.js';
import { ancestors, fmt, hhmm, kidsOf, layout, money, pick, setRank, siteOf, total } from './model.js';
import { legsOf, rivalsOf } from './places.js';
import { forkOf, ratesText, rivalDelta, valueOf } from './trip.js';
import { beds, isUnpriced } from './checks.js';
import { apartRuns, costText, entriesOf, modeIcon, nightsText, placeholderLinks, unpricedCount } from './cards.js';
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
    const hide = filter === 'none', fork = forkOf(doc), bd = beds(doc, at, optional);

    /** A move as a boarding-pass stub. */
    const stub = (/** @type {import('./trip.js').Hop} */ h) => `<button class="st-stub" data-sel="item:${esc(h.item.id)}">
  <span class="st-from">${esc(h.from ?? '')}</span><span class="st-plane">${modeIcon(h.item)}</span><span class="st-to">${esc(h.to ?? '')}</span>
  <span class="st-det"><b>${esc(h.label)}</b>${fmt(h.at, { weekday: 'short' })} · ${hhmm((h.at % 1) * 24)}${hide ? '' : ` · ${isUnpriced(h.item) ? 'no price' : money(h.cost, cur)}`}</span></button>`;

    // The fork's chapter goes just before the first stay or move inside its pick.
    let forkShown = !fork;
    /** The fork's chapter, once, if `it` is inside the fork's pick. */
    const forkCh = (/** @type {import('./model.js').Item} */ it) => {
      if (forkShown || !fork || !ancestors(doc, it).some((a) => a.id === fork.id)) return '';
      forkShown = true;
      const trips = kidsOf(doc, fork.id).map((k, i) => `<button class="st-trip${i === 0 ? ' on' : ''}" style="--c:var(--c-${k.color})" data-pick="${esc(k.id)}" aria-pressed="${i === 0}"><b>${i === 0 ? '★ ' : ''}${esc(k.name)}</b><span>${legsOf(doc, k.id).map(esc).join(' → ')}</span>${hide ? '' : `<em>${costText(valueOf(doc, k.id, opts), unpricedCount(doc, optional, filter, k.id), cur)} for the trip</em>`}</button>`).join('');
      return `<section class="st-ch st-fork"><p class="st-k">The fork</p><h3>${esc(fork.name)}</h3><p>Nothing's decided yet. The story below follows the starred trip; tap another to read that one instead.</p><div class="st-trips">${trips}</div></section>`;
    };

    /** An unbooked stretch as a callout. */
    const gapNote = (/** @type {import('./cards.js').Gap} */ g) => {
      const who = g.who.length ? `${g.who.join(' and ')}: ` : '', links = placeholderLinks(doc, g.ids);
      const apart = g.apart ? ` ${esc(g.apart)}, and ${g.who.length ? 'no bed is booked' : 'nobody has a bed booked'}.` : '';
      return `<aside class="st-gap"><b>${esc(who)}${nightsText(g.b - g.a)} with nowhere to sleep</b> ${fmt(g.a)} – ${fmt(g.b)}.${apart}${links ? ` Placeholder${g.ids.length > 1 ? 's' : ''}: ${links}.` : ''}</aside>`;
    };

    let n = 0;
    /** A stop as a chapter. */
    const chapter = (/** @type {import('./places.js').Stop} */ st) => {
      n++;
      const color = st.stays[0].item.color, nights = Math.round(st.end - st.start);
      let cost = 0, unpriced = 0;
      const paras = st.stays.map((q) => {
        const it = q.item, r = ratesText(doc, it), rv = rivalsOf(doc, it);
        cost += valueOf(doc, it.id, opts);
        unpriced += unpricedCount(doc, optional, filter, it.id);
        const alts = rv ? rv.options.slice(1).map((o) => {
          const d = rivalDelta(doc, o.id, it.id, opts);
          return `<button class="lk" data-pick="${esc(o.id)}">${esc(o.name)}</button>${d ? ` (${esc(d)})` : ''}`;
        }) : [];
        const links = it.links.map((u) => `<a class="st-link" href="${esc(u)}" target="_blank" rel="noopener">${esc(siteOf(u))}</a>`).join('');
        const pics = it.images.slice(0, 4).map((id) => `<img src="${imageUrl(id, true)}" alt="Picture of ${esc(it.name)}" loading="lazy">`).join('');
        return `<p>${nightsText(Math.round(q.end - q.start))} at <button class="lk" data-sel="item:${esc(it.id)}">${esc(it.name)}</button>${r && !hide ? `, ${esc(r)}` : ''}.${alts.length ? ` Or ${alts.join(', or ')}.` : ''}${it.committed ? '' : ' <em>Maybe.</em>'}${isUnpriced(it) && !hide ? ' <em>No price yet.</em>' : ''}</p>
${it.note ? `<p class="st-note">${esc(it.note)}</p>` : ''}${links ? `<p class="st-links">${links}</p>` : ''}${pics ? `<div class="st-pics">${pics}</div>` : ''}`;
      }).join('');
      return `${st.stays.map((q) => forkCh(q.item)).join('')}<section class="st-ch" style="--c:var(--c-${color})"><p class="st-k">Chapter ${n} · ${fmt(st.start)} – ${fmt(st.end)}</p>
<h3>${esc(st.name)}</h3>${hide ? '' : `<span class="st-margin">${costText(cost, unpriced, cur)}<small>${nights} nights</small></span>`}${paras}</section>`;
    };

    const entries = entriesOf(doc, at, optional, bd);
    const body = entries.map((e) => (e.stop ? chapter(e.stop) : e.gap ? gapNote(e.gap) : e.hop ? forkCh(e.hop.item) + stub(e.hop) : '')).join('');
    const sum = costText(pick(total(doc, { optional, at }), filter), unpricedCount(doc, optional, filter), cur);
    const apartPlaces = apartRuns(bd).flatMap((r) => r.text.split(' · ').map((t) => t.replace(/^[^:]+:\s*/, '')));
    const places = new Set([...entries.flatMap((e) => (e.stop ? [e.stop.name] : [])), ...apartPlaces]).size;
    const nights = bd ? bd.b - bd.a : 0;
    const span = bd ? `${fmt(bd.a, { weekday: 'short' })} – ${fmt(bd.b, { weekday: 'short' })}` : 'No stays yet';
    this.el.innerHTML = `<article class="st">
  <header class="st-cover"><p class="st-k">${esc(span)}</p><h2>${esc(this.app.planName || 'Your trip')}</h2>
    <div class="st-stats"><span><b>${nights}</b>nights</span><span><b>${places}</b>place${places === 1 ? '' : 's'}</span><span><b>${doc.people}</b>${doc.people === 1 ? 'person' : 'people'}</span>${hide ? '' : `<span><b>${sum}</b>in all</span>`}</div></header>
  ${body || '<p class="hint">Add a stay with nights to start the story.</p>'}
</article>`;
  }
}
