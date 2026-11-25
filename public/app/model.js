// @ts-check
/**
 * Plan model: the JSON document saved per plan, date helpers, layout of
 * chained bars, cost math, and the sample plan. Pure functions only, so it
 * runs the same in the browser and under `node --test`.
 *
 * @module
 */

/**
 * A fixed time window, such as a visa. Never moves when other bars change.
 * @typedef {object} WindowBar
 * @property {string} id
 * @property {'window'} kind
 * @property {string} name
 * @property {string} lane Row label; bars with the same lane share a row.
 * @property {string} start First day, `YYYY-MM-DD`.
 * @property {number} days Length in days.
 * @property {string} [note]
 */

/**
 * A stay somewhere. Either starts on a date, or right after another bar ends
 * (`after`), arriving by an optional flight (`route`).
 * @typedef {object} StayBar
 * @property {string} id
 * @property {'stay'} kind
 * @property {string} name
 * @property {string} lane
 * @property {string} [start] First night, `YYYY-MM-DD`; ignored when `after` is set.
 * @property {string} [after] Id of the bar this stay follows.
 * @property {string} [route] Key into `PlanDoc.routes`: how you get here.
 * @property {number} nights
 * @property {number} [minNights] With `maxNights`, makes the stay adjustable within a range.
 * @property {number} [maxNights]
 * @property {number} night Room cost per night.
 * @property {number} daily Spending per day (food, transport, …).
 * @property {string} color One of {@link COLORS}.
 * @property {string} [note]
 */

/** @typedef {WindowBar | StayBar} Bar */

/**
 * A flight (or bus, train…) between two places. Fares vary by date: `fares`
 * holds the prices you entered per departure date, `fare` is the fallback.
 * @typedef {object} Route
 * @property {string} from Short code, e.g. `SGN`.
 * @property {string} to
 * @property {number} depart Departure hour (local), e.g. 10.5 for 10:30.
 * @property {number} hours Duration in hours.
 * @property {number} fare Default one-way fare.
 * @property {Record<string, number>} fares Fare by departure date (`YYYY-MM-DD`).
 */

/**
 * The document stored in D1 as a plan's `body`.
 * @typedef {object} PlanDoc
 * @property {1} v Schema version.
 * @property {string} currency ISO code used for display.
 * @property {Bar[]} bars
 * @property {Record<string, Route>} routes
 */

/**
 * Where a bar lands on the calendar once chains are resolved.
 * @typedef {{bar: Bar, start: number, end: number}} Placed
 */

/** @typedef {'all' | 'stays' | 'travel' | 'none'} CostFilter */

/** Milliseconds in a day. */
export const DAY = 864e5;

/** Bar colors; each maps to a `--c-<name>` CSS token. */
export const COLORS = ['green', 'orange', 'blue', 'pink', 'purple', 'teal', 'gray'];

/**
 * Day index (days since 1970-01-01) of an ISO date.
 * @param {string} iso `YYYY-MM-DD`.
 * @returns {number} Integer day index, or NaN for an invalid date.
 */
export function dayOf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY : NaN;
}

/**
 * ISO date of a day index (fractions are floored).
 * @param {number} day Day index.
 * @returns {string} `YYYY-MM-DD`.
 */
export const isoOf = (day) => new Date(Math.floor(day) * DAY).toISOString().slice(0, 10);

/**
 * UTC `Date` at the start of a day index.
 * @param {number} day Day index.
 * @returns {Date}
 */
export const dateOf = (day) => new Date(Math.floor(day) * DAY);

/**
 * Today in the browser's time zone as a fractional day index, so the
 * "today" line sits at the right hour.
 * @param {Date} [now] Defaults to the current time.
 * @returns {number}
 */
export function nowIdx(now = new Date()) {
  const date = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY;
  return date + (now.getHours() + now.getMinutes() / 60) / 24;
}

/**
 * Short date label, e.g. "Dec 28" or "Mon, Dec 28".
 * @param {number} day Day index.
 * @param {Intl.DateTimeFormatOptions} [opts] Extra format options.
 * @returns {string}
 */
export const fmt = (day, opts = {}) =>
  dateOf(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC', ...opts });

/**
 * Clock time for a fractional hour, wrapping past midnight.
 * @param {number} h Hour, e.g. 13.5.
 * @returns {string} `HH:MM`.
 */
export function hhmm(h) {
  const m = Math.round(h * 60);
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${p(Math.floor(m / 60) % 24)}:${p(m % 60)}`;
}

/**
 * Parses `HH:MM` into a fractional hour.
 * @param {string} s Clock time.
 * @returns {number} Hour, or NaN if malformed.
 */
export function parseHhmm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  return m && +m[1] < 24 && +m[2] < 60 ? +m[1] + +m[2] / 60 : NaN;
}

/**
 * Formats money in the plan's currency, rounded to whole units.
 * @param {number} n Amount.
 * @param {string} [currency] ISO code, USD by default.
 * @returns {string}
 */
export const money = (n, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);

/**
 * Clamps a number into a range.
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Short random id for new bars.
 * @returns {string}
 */
export const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * Route key for a pair of place codes.
 * @param {string} from
 * @param {string} to
 * @returns {string} e.g. `SGN-BKK`.
 */
export const routeKey = (from, to) => `${from}-${to}`.toUpperCase();

/**
 * Display label for a route.
 * @param {Route} r
 * @returns {string} e.g. `SGN → BKK`.
 */
export const routeLabel = (r) => `${r.from} → ${r.to}`;

/**
 * Fare for leaving on a given day: the price entered for that date, else the default.
 * @param {Route} r
 * @param {number} day Departure day index.
 * @returns {number}
 */
export const fareOn = (r, day) => r.fares[isoOf(day)] ?? r.fare;

/**
 * Room plus daily spending for a stay.
 * @param {StayBar} s
 * @param {number} [nights] Overrides `s.nights`.
 * @returns {{rooms: number, spend: number, total: number}}
 */
export function stayCost(s, nights = s.nights) {
  const rooms = s.night * nights, spend = s.daily * nights;
  return { rooms, spend, total: rooms + spend };
}

/**
 * Applies a cost filter to a stay/travel split.
 * @param {number} stay Stay cost.
 * @param {number} travel Travel cost.
 * @param {CostFilter} filter
 * @returns {number} The part the filter shows (both when hidden, for sorting).
 */
export const pick = (stay, travel, filter) =>
  filter === 'stays' ? stay : filter === 'travel' ? travel : stay + travel;

/**
 * Whether a stay has an adjustable range.
 * @param {Bar} b
 * @returns {b is StayBar & {minNights: number, maxNights: number}}
 */
export const isRanged = (b) =>
  b.kind === 'stay' && Number.isFinite(b.minNights) && Number.isFinite(b.maxNights) &&
  /** @type {number} */ (b.maxNights) > /** @type {number} */ (b.minNights);

/**
 * Resolves every bar to calendar days, following `after` chains.
 * @param {PlanDoc} doc
 * @param {Record<string, number>} [over] Night counts to use instead of the stored ones, by bar id.
 * @param {number} [fallback] Start day for bars with no valid start (defaults to today).
 * @returns {Map<string, Placed>}
 */
export function layout(doc, over = {}, fallback = Math.floor(nowIdx())) {
  const byId = new Map(doc.bars.map((b) => [b.id, b]));
  /** @type {Map<string, Placed>} */
  const out = new Map();
  /**
   * @param {Bar} b
   * @param {Set<string>} path Ids on the current chain, to break cycles.
   * @returns {Placed}
   */
  const place = (b, path) => {
    const done = out.get(b.id);
    if (done) return done;
    const parent = b.kind === 'stay' && b.after ? byId.get(b.after) : undefined;
    let start;
    if (parent && !path.has(parent.id)) start = place(parent, path.add(b.id)).end;
    else {
      start = dayOf(b.start ?? '');
      if (Number.isNaN(start)) start = fallback;
    }
    const len = b.kind === 'window' ? b.days : (over[b.id] ?? b.nights);
    const r = { bar: b, start, end: start + len };
    out.set(b.id, r);
    return r;
  };
  doc.bars.forEach((b) => place(b, new Set()));
  return out;
}

/**
 * Stays that directly follow a bar.
 * @param {PlanDoc} doc
 * @param {string} id
 * @returns {StayBar[]}
 */
export const childrenOf = (doc, id) =>
  /** @type {StayBar[]} */ (doc.bars.filter((b) => b.kind === 'stay' && b.after === id));

/**
 * Ids of a bar and everything chained after it.
 * @param {PlanDoc} doc
 * @param {string} id
 * @returns {Set<string>}
 */
export function descendants(doc, id) {
  const out = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const b of doc.bars) {
      if (b.kind === 'stay' && b.after && out.has(b.after) && !out.has(b.id)) out.add(b.id), (grew = true);
    }
  }
  return out;
}

/**
 * The stay whose length you are deciding: the first adjustable stay with
 * options after it (else the first stay with options).
 * @param {PlanDoc} doc
 * @returns {StayBar | undefined}
 */
export function pivotOf(doc) {
  const withKids = /** @type {StayBar[]} */ (doc.bars.filter((b) => b.kind === 'stay' && childrenOf(doc, b.id).length));
  return withKids.find(isRanged) ?? withKids[0];
}

/**
 * Night counts the pivot can take: its range, or its current length alone.
 * @param {StayBar} s
 * @returns {[number, number]}
 */
export const rangeOf = (s) => (isRanged(s) ? [s.minNights, s.maxNights] : [s.nights, s.nights]);

/**
 * Every way to continue after a bar: each path runs from one of its
 * children to a stay with nothing after it.
 * @param {PlanDoc} doc
 * @param {string} id Root bar (usually the pivot).
 * @returns {string[][]} Paths of stay ids.
 */
export function pathsFrom(doc, id) {
  /** @type {string[][]} */
  const out = [];
  /**
   * @param {string} at
   * @param {string[]} trail
   */
  const walk = (at, trail) => {
    const kids = childrenOf(doc, at).filter((k) => k.id !== id && !trail.includes(k.id));
    if (!kids.length && trail.length) out.push(trail);
    kids.forEach((k) => walk(k.id, [...trail, k.id]));
  };
  walk(id, []);
  return out;
}

/**
 * Cost of following one path after the pivot, if the pivot lasts `nights`.
 * @param {PlanDoc} doc
 * @param {string[]} path Stay ids from {@link pathsFrom}.
 * @param {string} pivotId
 * @param {number} nights Pivot length to price.
 * @returns {{stay: number, travel: number, depart: number, end: number}}
 */
export function pathCost(doc, path, pivotId, nights) {
  const at = layout(doc, { [pivotId]: nights });
  let stay = 0, travel = 0;
  for (const id of path) {
    const p = /** @type {Placed} */ (at.get(id)), s = /** @type {StayBar} */ (p.bar);
    stay += stayCost(s).total;
    const r = s.route ? doc.routes[s.route] : undefined;
    if (r) travel += fareOn(r, p.start);
  }
  const last = at.get(path[path.length - 1]);
  return { stay, travel, depart: /** @type {Placed} */ (at.get(pivotId)).end, end: last ? last.end : 0 };
}

/**
 * Display name for a path, e.g. "Bangkok → Taipei".
 * @param {PlanDoc} doc
 * @param {string[]} path
 * @returns {string}
 */
export const pathName = (doc, path) =>
  path.map((id) => doc.bars.find((b) => b.id === id)?.name ?? '?').join(' → ');

/**
 * An empty plan.
 * @returns {PlanDoc}
 */
export const emptyDoc = () => ({ v: 1, currency: 'USD', bars: [], routes: {} });

/**
 * Coerces untrusted JSON (from the API) into a valid plan, dropping bars
 * that can't be drawn rather than failing.
 * @param {unknown} raw
 * @returns {PlanDoc}
 */
export function normalize(raw) {
  const src = /** @type {any} */ (raw && typeof raw === 'object' ? raw : {});
  const num = (/** @type {unknown} */ v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const str = (/** @type {unknown} */ v, d = '') => (typeof v === 'string' ? v : d);
  /** @type {Record<string, Route>} */
  const routes = {};
  for (const [k, r] of Object.entries(src.routes ?? {})) {
    if (!r || typeof r !== 'object') continue;
    const fares = Object.fromEntries(
      Object.entries(/** @type {any} */ (r).fares ?? {}).filter(([d, v]) => !Number.isNaN(dayOf(d)) && num(v, -1) >= 0),
    );
    routes[k] = {
      from: str(/** @type {any} */ (r).from, '?'), to: str(/** @type {any} */ (r).to, '?'),
      depart: clamp(num(/** @type {any} */ (r).depart, 12), 0, 23.99), hours: Math.max(0, num(/** @type {any} */ (r).hours, 1)),
      fare: Math.max(0, num(/** @type {any} */ (r).fare)), fares: /** @type {Record<string, number>} */ (fares),
    };
  }
  /** @type {Bar[]} */
  const bars = [];
  for (const b of Array.isArray(src.bars) ? src.bars : []) {
    if (!b || typeof b !== 'object' || typeof b.id !== 'string') continue;
    const base = { id: b.id, name: str(b.name, 'Untitled'), lane: str(b.lane) || str(b.name, 'Untitled'), ...(str(b.note) && { note: b.note }) };
    if (b.kind === 'window') {
      if (Number.isNaN(dayOf(b.start))) continue;
      bars.push({ ...base, kind: 'window', start: b.start, days: Math.max(1, Math.round(num(b.days, 1))) });
    } else if (b.kind === 'stay') {
      const s = /** @type {StayBar} */ ({
        ...base, kind: 'stay', nights: Math.max(1, Math.round(num(b.nights, 1))),
        night: Math.max(0, num(b.night)), daily: Math.max(0, num(b.daily)),
        color: COLORS.includes(b.color) ? b.color : 'gray',
      });
      if (typeof b.after === 'string') s.after = b.after;
      else if (!Number.isNaN(dayOf(b.start))) s.start = b.start;
      if (typeof b.route === 'string' && routes[b.route]) s.route = b.route;
      if (Number.isFinite(b.minNights) && Number.isFinite(b.maxNights) && b.maxNights > b.minNights) {
        s.minNights = Math.max(1, Math.round(b.minNights));
        s.maxNights = Math.max(s.minNights + 1, Math.round(b.maxNights));
        s.nights = clamp(s.nights, s.minNights, s.maxNights);
      }
      bars.push(s);
    }
  }
  const ids = new Set(bars.map((b) => b.id));
  for (const b of bars) if (b.kind === 'stay' && b.after && !ids.has(b.after)) delete b.after;
  return { v: 1, currency: /^[A-Z]{3}$/.test(src.currency) ? src.currency : 'USD', bars, routes };
}

/**
 * Removes routes no stay uses any more.
 * @param {PlanDoc} doc Mutated in place.
 */
export function pruneRoutes(doc) {
  const used = new Set(doc.bars.map((b) => (b.kind === 'stay' ? b.route : undefined)));
  for (const k of Object.keys(doc.routes)) if (!used.has(k)) delete doc.routes[k];
}

/**
 * Deletes a bar. Stays that followed it keep their dates and become
 * free-standing.
 * @param {PlanDoc} doc Mutated in place.
 * @param {string} id
 */
export function removeBar(doc, id) {
  const at = layout(doc);
  for (const k of childrenOf(doc, id)) {
    delete k.after;
    k.start = isoOf(/** @type {Placed} */ (at.get(k.id)).start);
  }
  doc.bars = doc.bars.filter((b) => b.id !== id);
  pruneRoutes(doc);
}

/**
 * Deterministic pseudo-random number in [0, 1), for sample fares.
 * @param {number} x Seed.
 * @returns {number}
 */
function noise(x) {
  const s = Math.sin(x * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Sample fares around a base price: weekday swing plus Christmas and New
 * Year peaks, for each day in [from, to].
 * @param {number} base Typical fare.
 * @param {number} from First departure day index.
 * @param {number} to Last departure day index.
 * @returns {Record<string, number>}
 */
function sampleFares(base, from, to) {
  const nye = dayOf('2026-12-30'), xmas = dayOf('2026-12-22');
  /** @type {Record<string, number>} */
  const out = {};
  for (let i = from; i <= to; i++) {
    const week = [0.14, 0, -0.08, -0.07, 0, 0.12, 0.04][dateOf(i).getUTCDay()];
    const peak = 0.55 * Math.exp(-((i - nye) ** 2) / 32) + 0.22 * Math.exp(-((i - xmas) ** 2) / 8);
    out[isoOf(i)] = Math.round(base * (1 + week + peak + (noise(i * 3.1 + base) - 0.5) * 0.16));
  }
  return out;
}

/**
 * The sample plan from the mockups: a 90-day Vietnam visa from Oct 20 2026,
 * a 60–90 day stay, and three ways to continue (Bangkok, Taipei, or both).
 * Prices are made up.
 * @returns {PlanDoc}
 */
export function sampleDoc() {
  const arrive = dayOf('2026-10-20'), first = arrive + 59, last = arrive + 89;
  return {
    v: 1,
    currency: 'USD',
    routes: {
      'SGN-BKK': { from: 'SGN', to: 'BKK', depart: 10 + 25 / 60, hours: 1.6, fare: 88, fares: sampleFares(88, first, last) },
      'SGN-TPE': { from: 'SGN', to: 'TPE', depart: 8 + 50 / 60, hours: 3.4, fare: 168, fares: sampleFares(168, first, last) },
      'BKK-TPE': { from: 'BKK', to: 'TPE', depart: 13.5, hours: 3.75, fare: 132, fares: sampleFares(132, first + 5, last + 5) },
    },
    bars: [
      { id: 'visa', kind: 'window', name: 'Vietnam e-visa', lane: 'Visa', start: '2026-10-20', days: 90 },
      { id: 'vn', kind: 'stay', name: 'Vietnam', lane: 'Vietnam', start: '2026-10-20', nights: 69, minNights: 59, maxNights: 89, night: 32, daily: 22, color: 'green' },
      { id: 'bkk', kind: 'stay', name: 'Bangkok', lane: 'Bangkok', after: 'vn', route: 'SGN-BKK', nights: 10, night: 46, daily: 30, color: 'orange' },
      { id: 'tpe', kind: 'stay', name: 'Taipei', lane: 'Taipei', after: 'vn', route: 'SGN-TPE', nights: 10, night: 74, daily: 38, color: 'blue' },
      { id: 'both-bkk', kind: 'stay', name: 'Bangkok', lane: 'Both', after: 'vn', route: 'SGN-BKK', nights: 5, night: 46, daily: 30, color: 'orange' },
      { id: 'both-tpe', kind: 'stay', name: 'Taipei', lane: 'Both', after: 'both-bkk', route: 'BKK-TPE', nights: 5, night: 74, daily: 38, color: 'blue' },
    ],
  };
}
