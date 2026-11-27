// @ts-check
/**
 * The route map view: the picked trip from its first night to the flight
 * home, drawn as gently bowed lines between the cities it stays in, with
 * numbered stops (a city visited twice gets a badge per visit). Unbooked
 * stays show as dashed stops, nights with nowhere booked as gaps, and when
 * people split up each person's own stops and legs show in their color.
 * Other trips still on the table are dashed routes. A day slider moves a
 * marker per person along the trip, and the list beside the map shows each
 * stop with its rival options.
 *
 * @module
 */
import { fmt, kidsOf, layout, money, setRank, typeOf } from './model.js';
import { mapDay, mapRoute, rivalsOf } from './places.js';
import { forkOf, rivalDelta, valueOf, withPick } from './trip.js';
import { leanBar } from './lanes.js';
import { esc } from './ui.js';

/** @typedef {import('./ui.js').App} App */
/** @typedef {import('./places.js').City} City */
/** @typedef {import('./places.js').MapRoute} MapRoute */
/** @typedef {import('./places.js').MapStop} MapStop */
/** @typedef {import('./places.js').MapPoint} MapPoint */
/** @typedef {import('./trip.js').Hop} Hop */

/** Map drawing width in SVG units. */
const W = 1000;

/** Colors for each person's own stops and legs, in order (the pick's color is skipped). */
const PERSON_COLORS = ['blue', 'purple', 'teal', 'orange', 'green'];

/**
 * A gently bowed line between two points. It always bows to the same side
 * of the direction of travel, and only a little, so a route never loops
 * back on itself and a there-and-back pair of legs stays apart.
 * @param {[number, number]} p
 * @param {[number, number]} q
 * @returns {string} Path data, or '' when the points are in the same spot.
 */
function bow([x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
  if (len < 1) return '';
  const k = Math.min(0.08, 24 / len), mx = (x1 + x2) / 2 - dy * k, my = (y1 + y2) / 2 + dx * k;
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

/**
 * A number of nights in words.
 * @param {number} n
 * @returns {string} e.g. "1 night", "5 nights".
 */
const nightsText = (n) => `${n} night${n === 1 ? '' : 's'}`;

/**
 * Whether no night of a stop has a booked stay.
 * @param {MapStop} s
 * @returns {boolean}
 */
const unbooked = (s) => s.open === s.end - s.start;

/**
 * What the slider says about one person's day: the place, the bed and
 * which night, that no bed is booked, or the move that ends the trip.
 * @param {{stop?: MapStop, hop?: Hop}} where From {@link mapDay}.
 * @param {number} day
 * @returns {string}
 */
function dayText({ stop, hop }, day) {
  if (hop && !stop) return hop.label;
  const on = stop?.items.filter((q) => q.p.start <= day && day < q.p.end).at(-1);
  if (!stop?.name) return `No bed booked${on ? ` · ${on.p.item.name}` : ''}`;
  const name = on?.p.item.name ?? '';
  const bed = !on || (!on.booked && typeOf(on.p.item) !== 'stay') ? 'no bed booked'
    : name === stop.name ? '' : `${name}${on.booked || /not booked/i.test(name) ? '' : ' (not booked)'}`;
  return [stop.name, bed, `night ${day - stop.start + 1} of ${stop.end - stop.start}`].filter(Boolean).join(' · ');
}

/**
 * How far apart a set of cities spreads, in degrees of latitude.
 * @param {City[]} cs
 * @param {(c: City) => number} lonOf
 * @returns {number}
 */
function spread(cs, lonOf) {
  const lats = cs.map((c) => c.lat), lons = cs.map(lonOf);
  const k = Math.cos(((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI / 180);
  return Math.max((Math.max(...lons) - Math.min(...lons)) * k, Math.max(...lats) - Math.min(...lats));
}

/**
 * The cities to fit the map to: the base ones, plus each other city near
 * enough not to shrink them (the spread stays within 40 degrees, or two
 * and a half times the base's own). The rest sit on the map's edge.
 * Longitudes of other cities wrap to the side of the globe nearest the
 * base, so a flight home across the Pacific heads east.
 * @param {City[]} base Places everyone stays in and passes through.
 * @param {City[]} all Every city to draw.
 * @returns {{fit: City[], lonOf: (c: City) => number}}
 */
function framing(base, all) {
  if (!base.length) return { fit: all, lonOf: (c) => c.lon };
  const mid = (Math.min(...base.map((c) => c.lon)) + Math.max(...base.map((c) => c.lon))) / 2;
  const own = new Set(base);
  /** Longitude, wrapped toward the base. */
  const lonOf = (/** @type {City} */ c) => (own.has(c) ? c.lon : c.lon + 360 * Math.round((mid - c.lon) / 360));
  const fit = [...base], limit = Math.max(40, 2.5 * spread(base, lonOf));
  const near = (/** @type {City} */ c) => Math.hypot(lonOf(c) - mid, c.lat - base[0].lat);
  for (const c of all.filter((x) => !own.has(x)).sort((x, y) => near(x) - near(y))) {
    if (spread([...fit, c], lonOf) <= limit) fit.push(c);
  }
  return { fit, lonOf };
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
    /** Day the slider shows, or null for the trip's first night. */
    this.day = /** @type {number | null} */ (null);
    /** @type {MapRoute | null} */
    this.route = null;
    /** Marker color per route line, when people split up. @type {string[]} */
    this.colors = [];
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
    const r = mapRoute(doc, at), fork = forkOf(doc);
    const ghosts = r && fork ? kidsOf(doc, fork.id).slice(1).map((k) => {
      const d = withPick(doc, k.id);
      return { k, points: mapRoute(d, layout(d))?.lines[0]?.points ?? [] };
    }) : [];
    const cities = [...new Set([...(r?.lines.flatMap((l) => l.points) ?? []), ...ghosts.flatMap((g) => g.points)].map((p) => p.city))];
    this.route = r;
    if (!r || !cities.length) {
      this.el.innerHTML = `${leanBar(this.app)}<p class="hint">None of this plan's places are on the map yet. Stays named after a city (like “Bangkok” or “Hoi An homestay”) show up here.</p>`;
      return;
    }

    // Fit the places everyone stays in (and nearby ones) into the drawing, keeping distances true at their
    // middle latitude. A far-off place (one person's week away, the flight home) sits on the edge, in its direction.
    const together = r.stops.filter((st) => st.city && !st.who).map((st) => /** @type {City} */ (st.city));
    const vias = r.lines.flatMap((l) => l.points.slice(1, -1).filter((p) => p.hop).map((p) => p.city));
    const { fit, lonOf } = framing([...new Set([...together, ...vias])], cities);
    const lat0 = Math.min(...fit.map((c) => c.lat)), lat1 = Math.max(...fit.map((c) => c.lat));
    const k = Math.cos(((lat0 + lat1) / 2) * Math.PI / 180);
    const lon0 = Math.min(...fit.map(lonOf)), lon1 = Math.max(...fit.map(lonOf));
    const spanX = Math.max((lon1 - lon0) * k, 2), spanY = Math.max(lat1 - lat0, 2);
    const H = Math.round(Math.min(Math.max(W * spanY / spanX, W * 0.55), W * 1.15));
    const pad = 70, s = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
    const cx = (lon0 + lon1) / 2, cy = (lat0 + lat1) / 2;
    this.xy = (c) => {
      const dx = (lonOf(c) - cx) * k * s, dy = (cy - c.lat) * s;
      const t = Math.min(1, (W / 2 - pad / 2) / Math.max(Math.abs(dx), 1e-9), (H / 2 - pad / 2) / Math.max(Math.abs(dy), 1e-9));
      return [W / 2 + dx * t, H / 2 + dy * t];
    };
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

    // Legs: shared ones in the pick's color, each person's own in theirs, dashed where not booked.
    const pickColor = fork ? kidsOf(doc, fork.id)[0]?.color ?? 'pink' : 'pink';
    const palette = PERSON_COLORS.filter((c) => c !== pickColor);
    const color = new Map(r.lines.map((l, i) => [l.who, palette[i % palette.length]]));
    this.colors = r.lines.map((l) => /** @type {string} */ (color.get(l.who)));
    /** @type {Map<string, {p: MapPoint, q: MapPoint, who: (string | null)[]}>} */
    const legs = new Map();
    for (const l of r.lines) {
      l.points.slice(1).forEach((q, i) => {
        const p = l.points[i], key = `${p.city.name}@${p.at}>${q.city.name}@${q.at}`;
        const leg = legs.get(key) ?? { p, q, who: [] };
        leg.who.push(l.who);
        legs.set(key, leg);
      });
    }
    const shared = (/** @type {{who: unknown[]}} */ leg) => leg.who.length === r.lines.length;
    const lines = ghosts.map((g) => g.points.slice(1).map((q, i) => {
      const d = bow(xy(g.points[i].city), xy(q.city));
      return d && `<path class="rm-ghost" style="--c:var(--c-${g.k.color})" d="${d}"/>`;
    }).join('')).join('') + [...legs.values()].sort((a, b) => +shared(b) - +shared(a)).map((leg) => {
      const d = bow(xy(leg.p.city), xy(leg.q.city));
      return d && `<path class="rm-arc${leg.q.open ? ' open' : ''}" style="--c:var(--c-${shared(leg) ? pickColor : color.get(leg.who[0])})" d="${d}"/>`;
    }).join('');

    // Cities: a numbered badge per visit (dashed when not booked), a plain dot for places only passed through.
    const placed = r.stops.filter((st) => st.city);
    const num = new Map(placed.map((st, i) => [st, i + 1]));
    const spots = cities.map(xy);
    /** Whether another city sits where a label on that side would go. */
    const crowded = (/** @type {number} */ i, /** @type {number} */ side) =>
      spots.some(([x, y], j) => j !== i && Math.abs(y - spots[i][1]) < 22 && (x - spots[i][0]) * side >= 0 && Math.abs(x - spots[i][0]) < 160);
    const dots = cities.map((c, ci) => {
      const [x, y] = spots[ci], vs = placed.filter((st) => st.city === c);
      const right = x < W - 200 && (x < 200 || !crowded(ci, 1) || crowded(ci, -1));
      const pins = vs.map((st, i) => `<g class="rm-pin${unbooked(st) ? ' open' : ''}"${st.who ? ` style="--c:var(--c-${color.get(st.who)})"` : ''} transform="translate(${(i - (vs.length - 1) / 2) * 25} 0)"><circle r="11"/><text class="num" dy="4">${num.get(st)}</text></g>`).join('');
      const whos = new Set(vs.map((st) => st.who)), open = vs.filter(unbooked);
      const notes = [...(vs.length && !whos.has(null) ? whos : []),
        ...(!open.length ? [] : open.length === vs.length ? ['not booked'] : [`not booked: ${open.map((st) => num.get(st)).join(', ')}`])];
      const off = vs.length ? (vs.length - 1) * 12.5 + 17 : 11;
      return `<g class="rm-city${vs.length ? '' : ' off'}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">${vs.length ? pins : '<circle r="5"/>'}
<text class="lab" x="${right ? off : -off}" dy="5" text-anchor="${right ? 'start' : 'end'}">${esc(c.name)}${notes.map((n) => ` · ${esc(String(n))}`).join('')}</text></g>`;
    }).join('');

    // Stops list with each stay's rival options, gaps between, and where the trip starts and ends.
    /** One thing a stop sleeps in, with its rival options when it's a stay. */
    const row = (/** @type {MapStop['items'][number]} */ q) => {
      const it = q.p.item;
      if (typeOf(it) !== 'stay' && !q.booked) return `<div class="rm-stay"><button class="lk" data-sel="item:${esc(it.id)}">${esc(it.name)}</button></div>`;
      const rv = rivalsOf(doc, it), v = valueOf(doc, it.id, opts);
      const alts = rv ? rv.options.slice(1).map((o) => {
        const d = rivalDelta(doc, o.id, it.id, opts);
        return `<button class="rm-alt" data-pick="${esc(o.id)}">or ${esc(o.name)}${d ? ` ${esc(d)}` : ''}</button>`;
      }).join('') : '';
      return `<div class="rm-stay"><button class="lk" data-sel="item:${esc(it.id)}">${esc(it.name)}</button>${filter === 'none' ? '' : ` <span class="mono">${money(v, cur)}</span>`}${alts}</div>`;
    };
    const list = r.stops.map((st) => {
      const n = st.end - st.start, i = num.get(st);
      const status = !st.name ? '' : unbooked(st) ? ' · not booked' : st.open ? ` · ${st.open} not booked` : '';
      const who = st.who ? ` <span class="rm-who" style="--c:var(--c-${color.get(st.who)})">${esc(st.who)}</span>` : '';
      const lead = i ? `<span class="rm-n${unbooked(st) ? ' open' : ''}" style="--c:var(--c-${st.items[0]?.p.item.color ?? 'gray'})">${i}</span>` : '<span class="rm-n none"></span>';
      return `<li${st.name ? '' : ' class="rm-gap"'}>${lead}<div><b>${st.name ? esc(st.name) : 'No bed booked'}${who}</b><small>${fmt(st.start)} – ${fmt(st.end)} · ${nightsText(n)}${status}</small>${st.items.map(row).join('')}</div></li>`;
    });
    /** A row for where a move starts the trip or ends it. */
    const end = (/** @type {MapPoint} */ p) => `<li class="rm-end"><span class="rm-n none"></span><div><b>${esc(p.city.name)}</b><small>${fmt(p.hop?.at ?? p.at)} · ${esc(p.hop?.label ?? '')}</small></div></li>`;
    const starts = r.lines.map((l) => l.points[0]).filter((p) => p?.hop && p.at < r.a);
    const homes = r.lines.map((l) => l.points.at(-1)).filter((p) => p?.hop && p.at >= r.b - 1);
    /** Rows for points, once each. */
    const rows = (/** @type {(MapPoint | undefined)[]} */ ps) => [...new Set(ps.map((p) => p && end(p)))];
    const lostNames = [...new Set(r.stops.filter((st) => st.name && !st.city).map((st) => st.name))];
    const lost = lostNames.length ? `<p class="hint">Not on the map: ${lostNames.map(esc).join(', ')}. Put a city in the name to place it.</p>` : '';
    const ghostKey = ghosts.length ? `<p class="rm-key">${ghosts.map((g) => `<span style="--c:var(--c-${g.k.color})"><i></i>${esc(g.k.name)}</span>`).join('')} dashed: the trips you haven't picked</p>` : '';
    const peopleKey = r.stops.some((st) => st.who) ? `<p class="rm-key">${r.lines.map((l) => `<span style="--c:var(--c-${color.get(l.who)})"><i class="solid"></i>${esc(l.who ?? '')}</span>`).join('')} on their own</p>` : '';
    const openKey = r.stops.some((st) => st.open) ? '<p class="rm-key"><span class="rm-open-key"><i></i>Dashed: not booked yet</span></p>' : '';
    if (this.day === null || this.day < r.a || this.day > r.last) this.day = r.a;

    const markers = r.lines.map(() => '<g class="rm-me"><circle r="18"/><circle r="6"/></g>').join('');
    this.el.innerHTML = `${leanBar(this.app)}<div class="rm">
  <div class="rm-map"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of the route"><g class="rm-grid">${grid}</g>${lines}${dots}${markers}</svg>
    <div class="rm-scrub"><input class="rm-day" type="range" min="${r.a}" max="${r.last}" step="1" value="${this.day}" aria-label="Day"><output class="rm-out"></output></div>
  </div>
  <div class="rm-side">${ghostKey}${peopleKey}${openKey}<ol class="rm-list">${[...rows(starts), ...list, ...rows(homes)].join('')}</ol>${lost}</div>
</div>`;
    this.mark();
  }

  /** Moves each person's marker and the caption to the slider's day. */
  mark() {
    const r = this.route, out = this.el.querySelector('.rm-out'), mes = [...this.el.querySelectorAll('.rm-me')];
    if (!r || !out) return;
    const day = this.day ?? r.a;
    const where = r.lines.map((l) => ({ who: l.who, ...mapDay(r, l.who, day) }));
    const together = where.every((w) => w.stop === where[0].stop && w.city === where[0].city);
    where.forEach((w, i) => {
      const me = mes[i];
      if (!me) return;
      me.setAttribute('visibility', w.city && (i === 0 || !together) ? 'visible' : 'hidden');
      me.classList.toggle('lost', !w.stop?.city && !w.hop);
      me.setAttribute('style', together ? '' : `--mc:var(--c-${this.colors[i]})`);
      if (w.city) { const [x, y] = this.xy(w.city); me.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`); }
    });
    const when = fmt(day, { weekday: 'short' });
    out.textContent = together ? `${when} · ${dayText(where[0], day)}` : `${when} · ${where.map((w) => `${w.who}: ${dayText(w, day)}`).join('; ')}`;
  }
}
