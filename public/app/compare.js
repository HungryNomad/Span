// @ts-check
/**
 * The cost panel: every way to continue after the stay you're deciding on
 * (the pivot), with its total, the cheapest day to leave, and a chart of how
 * each total moves with your departure day.
 *
 * @module
 */
import { fmt, money, pathCost, pathName, pathsFrom, pick, pivotOf, rangeOf, stayCost } from './model.js';
import { $, drag, esc, niceTicks } from './ui.js';

/** @typedef {import('./ui.js').App} App */

/** Line colors for multi-stop paths (single stops use their stay's color). */
const MULTI = ['pink', 'purple', 'teal', 'gray'];

/** Filter labels. */
const TAG = { all: 'stays + travel', stays: 'stays only', travel: 'travel only', none: 'costs hidden' };

export class Compare {
  /**
   * Builds the panel inside `el` and wires the chart scrubber.
   * @param {HTMLElement} el Container.
   * @param {App} app
   */
  constructor(el, app) {
    this.app = app;
    this.el = el;
    el.innerHTML = `<h2>Cost by plan</h2><p id="s-sub"></p><div class="s-list" id="s-list"></div>
<div class="s-chart card" id="s-card"><h3>Total by departure day</h3><p id="s-hint"></p><div class="plot" id="s-plot"></div></div>`;
    this.plot = $('#s-plot', el);
    /** @type {{inv: (px: number) => number} | null} Maps chart x to pivot nights. */
    this.geo = null;
    const scrub = (/** @type {PointerEvent} */ e) => {
      const pivot = pivotOf(app.doc);
      if (!this.geo || !pivot) return;
      app.setNights(pivot.id, Math.round(this.geo.inv(e.clientX - this.plot.getBoundingClientRect().left)));
    };
    this.plot.addEventListener('pointerdown', (e) => { scrub(e); drag(e, scrub); });
    el.addEventListener('click', (e) => {
      const b = /** @type {HTMLElement} */ (e.target).closest('[data-nights]');
      const pivot = pivotOf(app.doc);
      if (b instanceof HTMLElement && pivot) app.setNights(pivot.id, +(b.dataset.nights ?? 0));
    });
  }

  /** Redraws the plan rows and the chart for the current plan, pivot length and filter. */
  render() {
    const { doc, filter } = this.app, pivot = pivotOf(doc);
    const paths = pivot ? pathsFrom(doc, pivot.id) : [];
    $('#s-card', this.el).hidden = !paths.length;
    if (!pivot || !paths.length) {
      $('#s-sub', this.el).textContent = 'Add stays that follow another stay (Add bar → "Starts after") to compare where to go next.';
      $('#s-list', this.el).innerHTML = '';
      return;
    }
    const hide = filter === 'none', cur = doc.currency, [mn, mx] = rangeOf(pivot);
    const colors = paths.map((path, j) => {
      const s = path.length === 1 && doc.bars.find((b) => b.id === path[0]);
      return s && s.kind === 'stay' ? s.color : MULTI[j % MULTI.length];
    });
    const series = paths.map((path) => {
      const v = [];
      for (let n = mn; n <= mx; n++) { const c = pathCost(doc, path, pivot.id, n); v.push({ ...c, total: pick(c.stay, c.travel, filter) }); }
      return v;
    });
    const now = series.map((v) => v[pivot.nights - mn]);
    const low = Math.min(...now.map((c) => c.total));

    const ps = stayCost(pivot);
    $('#s-sub', this.el).textContent = `What each option costs after ${pivot.name}, ${TAG[filter]}. ${pivot.name} itself: ${hide ? 'hidden' : money(pick(ps.total, 0, filter), cur)} for ${pivot.nights} nights.`;
    $('#s-list', this.el).innerHTML = paths.map((path, j) => {
      const c = now[j], best = series[j].reduce((a, b, n) => (b.total < a.t ? { n: mn + n, t: b.total } : a), { n: pivot.nights, t: c.total });
      const isLow = !hide && c.total === low && paths.length > 1;
      return `<article class="s-row card${isLow ? ' best' : ''}">
  <div class="s-name"><span class="sw c-${colors[j]}"></span><h3>${esc(pathName(doc, path))}</h3>${isLow ? '<span class="pill">Lowest</span>' : ''}</div>
  <div class="s-break">${hide ? '' : `Stays ${money(c.stay, cur)} · Travel ${money(c.travel, cur)} · `}${fmt(c.depart)} → ${fmt(c.end)}</div>
  <div class="s-total"><b>${hide ? '—' : money(c.total, cur)}</b><small>${TAG[filter]}</small></div>
  ${!hide && best.n !== pivot.nights ? `<button class="s-apply" data-nights="${best.n}">Cheapest: leave ${fmt(c.depart - pivot.nights + best.n, { weekday: 'short' })} for ${money(best.t, cur)}, saves ${money(c.total - best.t, cur)}</button>` : ''}
</article>`;
    }).join('');
    $('#s-hint', this.el).textContent = hide ? 'Turn costs back on to compare totals.' : 'Tap or drag the chart to change your departure day.';
    this.chart(series.map((v) => v.map((c) => c.total)), colors, paths.map((p) => pathName(doc, p)), mn, mx, pivot.nights, now[0].depart - pivot.nights, hide);
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
