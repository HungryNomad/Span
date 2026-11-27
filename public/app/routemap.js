// @ts-check
/**
 * The route map view: the picked trip drawn as arcs between the cities it
 * stays in, numbered in order, with the other trips still on the table as
 * dashed routes. A day slider moves a marker along the trip, and the list
 * beside the map shows each stop with its rival options.
 *
 * @module
 */
import { fmt, kidsOf, layout, money, setRank } from './model.js';
import { cityIn, rivalsOf, stopsOf } from './places.js';
import { forkOf, valueOf, withPick } from './trip.js';
import { leanBar } from './lanes.js';
import { esc } from './ui.js';

/** @typedef {import('./ui.js').App} App */
/** @typedef {import('./model.js').PlanDoc} PlanDoc */
/** @typedef {import('./places.js').City} City */
/** @typedef {import('./places.js').Stop} Stop */
/** @typedef {{city: City, start: number, end: number, stop?: Stop}} Point */

/** Map drawing width in SVG units. */
const W = 1000;

/**
 * The cities a trip passes through, in order: where it starts if a move
 * comes first, each stop, and where the last move lands.
 * @param {PlanDoc} doc
 * @param {boolean} optional
 * @returns {{points: Point[], lost: string[]}} Points, and stop names not on the map.
 */
function route(doc, optional) {
  const { stops, before } = stopsOf(doc, layout(doc), optional);
  /** @type {Point[]} */
  const points = [];
  /** @type {string[]} */
  const lost = [];
  /** Adds a city unless the route is already there. */
  const push = (/** @type {City | undefined} */ city, /** @type {number} */ start, /** @type {number} */ end, /** @type {Stop | undefined} */ stop = undefined) => {
    if (city && points.at(-1)?.city !== city) points.push({ city, start, end, stop });
  };
  stops.forEach((s, i) => {
    // Where the move into this stop leaves from, when that place isn't a stop itself.
    for (const h of i ? stops[i - 1].hops : before) {
      const from = h.from ? cityIn(h.from) : undefined;
      if (from && from !== s.city) push(from, h.at, h.at);
    }
    if (s.city) push(s.city, s.start, s.end, s);
    else lost.push(s.name);
  });
  const lastHop = stops.at(-1)?.hops.at(-1);
  const home = lastHop?.to ? cityIn(lastHop.to) : undefined;
  if (home && lastHop) push(home, lastHop.at, lastHop.at);
  return { points, lost };
}

export class RouteMap {
  /**
   * Wires clicks and the day slider inside `el`.
   * @param {HTMLElement} el Container.
   * @param {App} app
   */
  constructor(el, app) {
    this.el = el;
    this.app = app;
    /** Day the slider shows, or null for the trip's first day. */
    this.day = /** @type {number | null} */ (null);
    /** @type {Point[]} */
    this.points = [];
    /** @type {(c: City) => [number, number]} */
    this.xy = () => [0, 0];
    el.addEventListener('click', (e) => {
      const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-sel],[data-pick]'));
      if (b?.dataset.pick) { const id = b.dataset.pick; app.change((doc) => setRank(doc, id, 0)); }
      else if (b?.dataset.sel) app.select(b.dataset.sel);
    });
    el.addEventListener('input', (e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      if (t.matches('.rm-day')) { this.day = +t.value; this.mark(); }
    });
  }

  /** Redraws the view. */
  render() {
    const { doc, optional, filter } = this.app, cur = doc.currency, at = layout(doc), opts = { optional, filter, at };
    const main = route(doc, optional);
    const fork = forkOf(doc);
    const ghosts = fork ? kidsOf(doc, fork.id).slice(1).map((k) => ({ k, ...route(withPick(doc, k.id), optional) })) : [];
    const cities = [...new Set([...main.points, ...ghosts.flatMap((g) => g.points)].map((p) => p.city))];
    this.points = main.points;
    if (!cities.length) {
      this.el.innerHTML = `${leanBar(this.app)}<p class="hint">None of this plan's places are on the map yet. Stays named after a city (like “Bangkok” or “Hoi An homestay”) show up here.</p>`;
      return;
    }

    // Fit the cities into the drawing, keeping distances true at their middle latitude.
    const lat0 = Math.min(...cities.map((c) => c.lat)), lat1 = Math.max(...cities.map((c) => c.lat));
    const k = Math.cos(((lat0 + lat1) / 2) * Math.PI / 180);
    const lon0 = Math.min(...cities.map((c) => c.lon)), lon1 = Math.max(...cities.map((c) => c.lon));
    const spanX = Math.max((lon1 - lon0) * k, 2), spanY = Math.max(lat1 - lat0, 2);
    const H = Math.round(Math.min(Math.max(W * spanY / spanX, W * 0.55), W * 1.15));
    const pad = 70, s = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
    const cx = (lon0 + lon1) / 2, cy = (lat0 + lat1) / 2;
    this.xy = (c) => [W / 2 + (c.lon - cx) * k * s, H / 2 - (c.lat - cy) * s];
    const xy = this.xy;

    // Graticule every 1, 2, 5 or 10 degrees.
    const step = [1, 2, 5, 10, 20].find((g) => Math.max(spanX / k, spanY) / g <= 8) ?? 30;
    let grid = '';
    for (let lo = Math.ceil((cx - W / 2 / k / s) / step) * step; lo <= cx + W / 2 / k / s; lo += step) {
      const x = W / 2 + (lo - cx) * k * s;
      grid += `<line x1="${x}" y1="0" x2="${x}" y2="${H}"/><text x="${x + 4}" y="${H - 8}">${lo}°</text>`;
    }
    for (let la = Math.ceil((cy - H / 2 / s) / step) * step; la <= cy + H / 2 / s; la += step) {
      const y = H / 2 - (la - cy) * s;
      grid += `<line x1="0" y1="${y}" x2="${W}" y2="${y}"/><text x="6" y="${y - 4}">${la}°</text>`;
    }

    /** A gently curved line through the points. */
    const arcs = (/** @type {Point[]} */ pts, /** @type {string} */ cls, /** @type {string} */ color) => pts.slice(1).map((p, i) => {
      const [x1, y1] = xy(pts[i].city), [x2, y2] = xy(p.city), dx = x2 - x1, dy = y2 - y1;
      const mx = (x1 + x2) / 2 - dy * 0.18, my = (y1 + y2) / 2 + dx * 0.18;
      return `<path class="${cls}" style="--c:var(--c-${color})" d="M${x1.toFixed(1)} ${y1.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}"/>`;
    }).join('');
    const pickColor = fork ? kidsOf(doc, fork.id)[0]?.color ?? 'pink' : 'pink';
    const lines = ghosts.map((g) => arcs(g.points, 'rm-ghost', g.k.color)).join('') + arcs(main.points, 'rm-arc', pickColor);

    // Cities: numbered when on the picked route (a city visited twice gets both numbers).
    /** @type {Map<City, number[]>} */
    const nums = new Map();
    main.points.forEach((p, i) => nums.set(p.city, [...(nums.get(p.city) ?? []), i + 1]));
    const dots = cities.map((c) => {
      const [x, y] = xy(c), n = nums.get(c), right = x < W - 160;
      return `<g class="rm-city${n ? '' : ' off'}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle r="${n ? 11 : 5}"/>${n ? `<text class="num" dy="4">${n[0]}</text>` : ''}
<text class="lab" x="${right ? 16 : -16}" dy="4" text-anchor="${right ? 'start' : 'end'}">${esc(c.name)}${n && n.length > 1 ? ` (${n.join(', ')})` : ''}</text></g>`;
    }).join('');

    // Stops list with each stay's rival options.
    const list = main.points.map((p, i) => {
      const st = p.stop;
      if (!st) return `<li><span class="rm-n">${i + 1}</span><div><b>${esc(p.city.name)}</b><small>${fmt(p.start)}</small></div></li>`;
      const stays = st.stays.map((q) => {
        const r = rivalsOf(doc, q.item), v = valueOf(doc, q.item.id, opts);
        const alts = r ? r.options.slice(1).map((o) => {
          const d = valueOf(doc, o.id, opts) - v;
          return `<button class="rm-alt" data-pick="${esc(o.id)}">or ${esc(o.name)}${filter === 'none' || !d ? '' : ` ${d > 0 ? '+' : '−'}${money(Math.abs(d), cur)}`}</button>`;
        }).join('') : '';
        return `<div class="rm-stay"><button class="lk" data-sel="item:${esc(q.item.id)}">${esc(q.item.name)}</button>${filter === 'none' ? '' : ` <span class="mono">${money(v, cur)}</span>`}${alts}</div>`;
      }).join('');
      return `<li><span class="rm-n" style="--c:var(--c-${st.stays[0].item.color})">${i + 1}</span><div><b>${esc(st.name)}</b><small>${fmt(st.start)} – ${fmt(st.end)} · ${Math.round(st.end - st.start)} nights</small>${stays}</div></li>`;
    }).join('');
    const lost = main.lost.length ? `<p class="hint">Not on the map: ${main.lost.map(esc).join(', ')}. Put a city in the name to place it.</p>` : '';
    const ghostKey = ghosts.length ? `<p class="rm-key">${ghosts.map((g) => `<span style="--c:var(--c-${g.k.color})"><i></i>${esc(g.k.name)}</span>`).join('')} dashed: the trips you haven't picked</p>` : '';
    const first = Math.floor(main.points[0]?.start ?? 0), last = Math.ceil(main.points.at(-1)?.end ?? first);
    if (this.day === null || this.day < first || this.day > last) this.day = first;

    this.el.innerHTML = `${leanBar(this.app)}<div class="rm">
  <div class="rm-map"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of the route"><g class="rm-grid">${grid}</g>${lines}${dots}<g class="rm-me"><circle r="18"/><circle r="6"/></g></svg>
    <div class="rm-scrub"><input class="rm-day" type="range" min="${first}" max="${Math.max(last - 1, first)}" step="1" value="${this.day}" aria-label="Day"><output class="rm-out"></output></div>
  </div>
  <div class="rm-side">${ghostKey}<ol class="rm-list">${list}</ol>${lost}</div>
</div>`;
    this.mark();
  }

  /** Moves the marker and its caption to the slider's day. */
  mark() {
    const day = this.day ?? 0, me = this.el.querySelector('.rm-me'), out = this.el.querySelector('.rm-out');
    if (!me || !out) return;
    const pts = this.points;
    const here = [...pts].reverse().find((p) => p.start <= day + 0.99) ?? pts[0];
    if (!here) return;
    const [x, y] = this.xy(here.city);
    me.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    const st = here.stop, stay = st?.stays.find((q) => q.start <= day && day < q.end);
    const night = st && day < st.end ? ` · night ${day - Math.floor(st.start) + 1} of ${Math.round(st.end - st.start)}` : '';
    out.textContent = `${fmt(day, { weekday: 'short' })} · ${here.city.name}${stay ? ` · ${stay.item.name}` : ''}${night}`;
  }
}
