// @ts-check
/**
 * The cost panel: the options of the either/or group you're deciding on
 * (the one after the pivot), each with its total, the cheapest day to
 * leave, and a chart of how each total moves with your departure day.
 * Picking an option ranks it first, so it becomes the one that counts.
 *
 * @module
 */
import { focusGroupOf, fmt, insideName, kidsOf, layout, money, optionCost, pick, pivotOf, rangeOf, setRank, total } from './model.js';
import { $, drag, esc, niceTicks } from './ui.js';

/** @typedef {import('./ui.js').App} App */

/** Filter labels. */
const TAG = { all: 'stays + travel', stays: 'stays only', travel: 'travel only', none: 'costs hidden' };

export class Compare {
  /**
   * Builds the panel inside `el` and wires the chart scrubber and buttons.
   * @param {HTMLElement} el Container.
   * @param {App} app
   */
  constructor(el, app) {
    this.app = app;
    this.el = el;
    el.innerHTML = `<h2 id="s-h">Compare options</h2><p id="s-sub"></p><div class="s-list" id="s-list"></div>
<div class="s-chart card" id="s-card"><h3>Total by departure day</h3><p id="s-hint"></p><div class="plot" id="s-plot"></div></div>`;
    this.plot = $('#s-plot', el);
    /** @type {{inv: (px: number) => number} | null} Maps chart x to pivot length. */
    this.geo = null;
    const scrub = (/** @type {PointerEvent} */ e) => {
      const pivot = pivotOf(app.doc);
      if (!this.geo || !pivot) return;
      app.setLen(pivot.id, Math.round(this.geo.inv(e.clientX - this.plot.getBoundingClientRect().left)));
    };
    this.plot.addEventListener('pointerdown', (e) => { scrub(e); drag(e, scrub); });
    el.addEventListener('click', (e) => {
      const b = /** @type {HTMLElement} */ (e.target).closest('button');
      const pivot = pivotOf(app.doc);
      if (b?.dataset.len && pivot) app.setLen(pivot.id, +b.dataset.len);
      if (b?.dataset.pick) {
        const id = b.dataset.pick;
        app.change((doc) => setRank(doc, id, 0));
      }
      if (b?.dataset.sel) app.select(b.dataset.sel);
    });
  }

  /** Redraws the option rows and the chart for the current plan, pivot length and filter. */
  render() {
    const { doc, filter, optional } = this.app, pivot = pivotOf(doc), group = focusGroupOf(doc, pivot);
    const opts = group ? kidsOf(doc, group.id) : [];
    $('#s-card', this.el).hidden = !opts.length || !pivot;
    if (!group || !opts.length) {
      $('#s-h', this.el).textContent = 'Compare options';
      $('#s-sub', this.el).textContent = 'Add an either/or group (Add → Either/or group) and put the options inside it to compare them here.';
      $('#s-list', this.el).innerHTML = '';
      return;
    }
    const hide = filter === 'none', cur = doc.currency, at = layout(doc);
    const [mn, mx] = pivot ? rangeOf(pivot) : [0, 0], len = pivot?.len ?? 0;
    const colors = opts.map((o) => o.color);
    const series = opts.map((o) => {
      const v = [];
      for (let n = mn; n <= mx; n++) { const c = optionCost(doc, o.id, pivot?.id, n, optional); v.push({ ...c, total: pick(c, filter) }); }
      return v;
    });
    const now = series.map((v) => v[len - mn]);
    const low = Math.min(...now.map((c) => c.total));

    $('#s-h', this.el).textContent = `Compare: ${group.name}`;
    const head = pivot ? (() => { const ps = total(doc, { optional, root: pivot.id, at }); return ` ${pivot.name} itself: ${hide ? 'hidden' : money(pick(ps, filter), cur)}.`; })() : '';
    $('#s-sub', this.el).textContent = `What each option costs, ${TAG[filter]}${optional ? ', optional items included' : ''}. The top one is your pick and counts in totals.${head}`;
    $('#s-list', this.el).innerHTML = opts.map((o, j) => {
      const c = now[j], best = series[j].reduce((a, b, n) => (b.total < a.t ? { n: mn + n, t: b.total } : a), { n: len, t: c.total });
      const isLow = !hide && c.total === low && opts.length > 1, inside = insideName(doc, o, at);
      return `<article class="s-row card${isLow ? ' best' : ''}${j === 0 ? ' picked' : ''}">
  <div class="s-name"><span class="sw c-${colors[j]}"></span><button class="s-open" data-sel="item:${esc(o.id)}"><h3>${esc(o.name)}</h3></button>${j === 0 ? '<span class="pill">Pick</span>' : ''}${isLow ? '<span class="pill low">Lowest</span>' : ''}</div>
  <div class="s-break">${inside ? `${esc(inside)} · ` : ''}${hide ? '' : `Stays ${money(c.stay, cur)} · Travel ${money(c.travel, cur)} · `}${fmt(c.depart)} → ${fmt(c.end)}</div>
  <div class="s-total"><b>${hide ? '—' : money(c.total, cur)}</b><small>${TAG[filter]}</small></div>
  <div class="s-acts">${j ? `<button class="s-apply" data-pick="${esc(o.id)}">Make this the pick</button>` : ''}${pivot && !hide && best.n !== len ? `<button class="s-apply" data-len="${best.n}">Cheapest: leave ${fmt(c.depart - len + best.n, { weekday: 'short' })} for ${money(best.t, cur)}, saves ${money(c.total - best.t, cur)}</button>` : ''}</div>
</article>`;
    }).join('');
    if (!pivot) return;
    $('#s-hint', this.el).textContent = hide ? 'Turn costs back on to compare totals.' : 'Tap or drag the chart to change your departure day.';
    this.chart(series.map((v) => v.map((c) => c.total)), colors, opts.map((o) => o.name), mn, mx, len, now[0].depart - len, hide);
  }

  /**
   * Draws totals by departure day as an SVG line chart.
   * @param {number[][]} series One array of totals per path, indexed by nights - mn.
   * @param {string[]} colors Color name per path.
   * @param {string[]} names Label per path.
   * @param {number} mn Fewest pivot nights.
   * @param {number} mx Most pivot nights.
   * @param {number} cur Current pivot nights.
   * @param {number} start Pivot's first day (departure day = start + nights).
   * @param {boolean} hide Costs hidden.
   */
  chart(series, colors, names, mn, mx, cur, start, hide) {
    const W = this.plot.clientWidth || 600, H = 230, narrow = W < 480;
    const m = { l: 50, r: narrow ? 92 : 120, t: 12, b: 26 }, max = narrow ? 12 : 16;
    const span = Math.max(1, mx - mn);
    const X = (/** @type {number} */ n) => m.l + (n - mn) / span * (W - m.l - m.r);
    this.geo = { inv: (px) => mn + (px - m.l) / (W - m.l - m.r) * span };
    let s = `<svg width="${W}" height="${H}" role="img" aria-label="Plan totals by departure day">`;
    if (hide) {
      this.plot.innerHTML = `${s}<text class="svg-m" x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="12">Costs hidden</text></svg>`;
      return;
    }
    const all = series.flat(), yt = niceTicks(Math.min(...all), Math.max(...all));
    const y0 = yt[0], y1 = yt[yt.length - 1];
    const Y = (/** @type {number} */ v) => m.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
    yt.forEach((v) => { s += `<line class="svg-g" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="svg-m" x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end" font-size="10.5">${money(v)}</text>`; });
    const every = Math.max(1, Math.ceil(span / (narrow ? 4 : 6)));
    for (let n = mn; n <= mx; n += every) s += `<text class="svg-m" x="${X(n)}" y="${H - 8}" text-anchor="middle" font-size="10.5">${fmt(start + n)}</text>`;
    s += `<line x1="${X(cur)}" x2="${X(cur)}" y1="${m.t}" y2="${H - m.b}" stroke="var(--ink)" stroke-width="1.5"/>`;
    const ends = series.map((v, j) => ({ j, y: Y(v[v.length - 1]) })).sort((a, b) => a.y - b.y);
    for (let q = 1; q < ends.length; q++) if (ends[q].y - ends[q - 1].y < 14) ends[q].y = ends[q - 1].y + 14;
    series.forEach((v, j) => {
      const c = `var(--c-${colors[j]})`;
      s += `<polyline points="${v.map((val, n) => `${X(mn + n).toFixed(1)},${Y(val).toFixed(1)}`).join(' ')}" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/>`;
      s += `<circle cx="${X(cur)}" cy="${Y(v[cur - mn])}" r="4.5" fill="${c}" stroke="var(--surface)" stroke-width="2"/>`;
    });
    ends.forEach((e) => {
      const label = names[e.j].length > max ? names[e.j].slice(0, max - 1) + '…' : names[e.j];
      s += `<text class="svg-t" x="${W - m.r + 8}" y="${e.y + 4}" font-size="11.5" font-weight="600" fill="var(--c-${colors[e.j]})">${esc(label)}</text>`;
    });
    this.plot.innerHTML = s + '</svg>';
  }
}
