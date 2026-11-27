// @ts-check
/**
 * Plan model: the JSON document saved per plan (v2: nested items), date
 * helpers, layout, what counts toward totals, cost math, coverage checks,
 * the v1 → v2 upgrade and the sample plan. Pure functions only, so it runs
 * the same in the browser and under `node --test`.
 *
 * @module
 */

/** @typedef {'night' | 'day' | 'hour'} Unit */
/** @typedef {'fixed' | 'per' | 'date'} CostType */

/**
 * One cost on an item.
 * - `fixed`: `amount` once.
 * - `per`: `amount` per unit of the item's length (per night, day or hour).
 * - `date`: the fare of `route` on the day the item starts (how you get there).
 * @typedef {object} CostLine
 * @property {string} label
 * @property {CostType} type
 * @property {number} amount Unused for `date`.
 * @property {string} [route] Key into `PlanDoc.routes` (`date` only).
 * @property {boolean} pp Per person: multiplied by the plan's headcount.
 */

/**
 * Anything on the timeline: a country, a room, a friend, a restaurant.
 * Siblings (same `parent`) keep their rank as their order in `PlanDoc.items`.
 *
 * Timing: starts at an anchor plus `offset` days. The anchor is the end of
 * `after`, else the date `start`, else the parent's start. Length is `len`
 * units; an item with children and no `len` stretches to fit them.
 *
 * - `item`: a span with costs; counts toward totals when `committed`.
 * - `group`: an either/or box; only its first (top-ranked) child counts.
 * - `window`: a fixed span like a visa; never costs anything.
 * @typedef {object} Item
 * @property {string} id
 * @property {'item' | 'group' | 'window'} kind
 * @property {string} name
 * @property {string} [parent] Id of the containing item or group.
 * @property {string} [after] Id of the item this one follows.
 * @property {string} [start] `YYYY-MM-DD`; used when `after` is unset.
 * @property {number} offset Days after the anchor (fractional for hour items).
 * @property {number} [at] Hour of day an hour item starts (not with `after`).
 * @property {Unit} unit
 * @property {number} [len] Length in units.
 * @property {number} [minLen] With `maxLen`, makes the length adjustable.
 * @property {number} [maxLen]
 * @property {boolean} committed False = optional (hatched, left out of totals by default).
 * @property {CostLine[]} costs
 * @property {string} color One of {@link COLORS}.
 * @property {string} [note]
 * @property {string[]} links Listing pages (http/https).
 * @property {string[]} images Ids of pictures stored through `/api/images`.
 */

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
 * @property {2} v Schema version.
 * @property {string} currency ISO code used for display.
 * @property {number} people Headcount for per-person costs.
 * @property {Item[]} items
 * @property {Record<string, Route>} routes
 */

/**
 * Where an item lands once anchors are resolved. `end` is what followers
 * start from (for a group, its pick's end); `show` is how far its bar draws.
 * @typedef {{item: Item, start: number, end: number, show: number}} Placed
 */

/** @typedef {Map<string, Placed>} Layout */
/** @typedef {'all' | 'stays' | 'travel' | 'none'} CostFilter */
/** @typedef {{stay: number, travel: number}} Split */

/** Milliseconds in a day. */
export const DAY = 864e5;

/** Bar colors; each maps to a `--c-<name>` CSS token. */
export const COLORS = ['green', 'orange', 'blue', 'pink', 'purple', 'teal', 'gray'];

/** Days per unit. */
export const UNIT_DAYS = { night: 1, day: 1, hour: 1 / 24 };

/** Singular and plural unit words. */
export const UNIT_WORDS = { night: ['night', 'nights'], day: ['day', 'days'], hour: ['hour', 'hours'] };

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
 * Short random id for new items.
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
 * "10 nights", "1 hour", "2.5 hours".
 * @param {number} n
 * @param {Unit} unit
 * @returns {string}
 */
export const unitText = (n, unit) => `${+n.toFixed(2)} ${UNIT_WORDS[unit][n === 1 ? 0 : 1]}`;

/**
 * Applies a cost filter to a stay/travel split.
 * @param {Split} c
 * @param {CostFilter} filter
 * @returns {number} The part the filter shows (both when hidden, for sorting).
 */
export const pick = (c, filter) =>
  filter === 'stays' ? c.stay : filter === 'travel' ? c.travel : c.stay + c.travel;

/**
 * Whether an item has an adjustable length.
 * @param {Item} it
 * @returns {it is Item & {minLen: number, maxLen: number, len: number}}
 */
export const isRanged = (it) =>
  it.kind === 'item' && Number.isFinite(it.len) && Number.isFinite(it.minLen) && Number.isFinite(it.maxLen) &&
  /** @type {number} */ (it.maxLen) > /** @type {number} */ (it.minLen);

/**
 * Lengths an adjustable item can take: its range, or its current length alone.
 * @param {Item} it
 * @returns {[number, number]}
 */
export const rangeOf = (it) => (isRanged(it) ? [it.minLen, it.maxLen] : [it.len ?? 1, it.len ?? 1]);

/**
 * Finds an item by id.
 * @param {PlanDoc} doc
 * @param {string | undefined} id
 * @returns {Item | undefined}
 */
export const byId = (doc, id) => (id === undefined ? undefined : doc.items.find((it) => it.id === id));

/**
 * Children of an item (or top-level items), in rank order.
 * @param {PlanDoc} doc
 * @param {string | undefined} parent
 * @returns {Item[]}
 */
export const kidsOf = (doc, parent) => doc.items.filter((it) => it.parent === parent);

/**
 * Whether an item is inside an either/or group.
 * @param {PlanDoc} doc
 * @param {Item} it
 * @returns {boolean}
 */
export const inGroup = (doc, it) => byId(doc, it.parent)?.kind === 'group';

/**
 * Ids of an item and everything nested inside it.
 * @param {PlanDoc} doc
 * @param {string} id
 * @returns {Set<string>}
 */
export function subtree(doc, id) {
  const out = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const it of doc.items) if (it.parent && out.has(it.parent) && !out.has(it.id)) out.add(it.id), (grew = true);
  }
  return out;
}

/**
 * Ancestors of an item, nearest first.
 * @param {PlanDoc} doc
 * @param {Item} it
 * @returns {Item[]}
 */
export function ancestors(doc, it) {
  /** @type {Item[]} */
  const out = [];
  for (let p = byId(doc, it.parent); p && !out.includes(p); p = byId(doc, p.parent)) out.push(p);
  return out;
}

/**
 * Resolves every item to calendar days.
 * @param {PlanDoc} doc
 * @param {Record<string, number>} [over] Lengths to use instead of the stored ones, by id.
 * @param {number} [fallback] Start day for items with no anchor (defaults to today).
 * @returns {Layout}
 */
export function layout(doc, over = {}, fallback = Math.floor(nowIdx())) {
  const ids = new Map(doc.items.map((it) => [it.id, it]));
  /** @type {Map<string, Item[]>} */
  const kids = new Map();
  for (const it of doc.items) if (it.parent) kids.set(it.parent, [...(kids.get(it.parent) ?? []), it]);
  /** @type {Map<string, number>} */
  const S = new Map(), E = new Map();
  const sBusy = new Set(), eBusy = new Set();

  /** @param {Item} it @returns {number} */
  const startOf = (it) => {
    const done = S.get(it.id);
    if (done !== undefined) return done;
    if (sBusy.has(it.id)) return fallback;
    sBusy.add(it.id);
    const a = it.after ? ids.get(it.after) : undefined, p = it.parent ? ids.get(it.parent) : undefined;
    const dated = dayOf(it.start ?? '');
    const base = a ? endOf(a) : !Number.isNaN(dated) ? dated : p ? startOf(p) : fallback;
    let s = base + it.offset;
    if (it.unit !== 'hour') s = Math.floor(s);
    else if (!a) s = Math.floor(base) + it.offset + (it.at ?? 0) / 24;
    S.set(it.id, s);
    return s;
  };

  /** @param {Item} it @returns {number} */
  const endOf = (it) => {
    const done = E.get(it.id);
    if (done !== undefined) return done;
    const s = startOf(it);
    if (eBusy.has(it.id)) return s + UNIT_DAYS[it.unit];
    eBusy.add(it.id);
    const ch = kids.get(it.id) ?? [], len = over[it.id] ?? it.len;
    const e = it.kind === 'group' ? (ch.length ? endOf(ch[0]) : s)
      : len !== undefined ? s + len * UNIT_DAYS[it.unit]
      : ch.length ? Math.max(s, ...stretchers(it, ch).map(endOf))
      : s + UNIT_DAYS[it.unit];
    E.set(it.id, e);
    return e;
  };

  /**
   * Children a parent with no length stretches over. A night or day parent
   * ignores hour-long children (a flight home on the last day), so it stays
   * a whole number of nights; they draw past its end.
   * @param {Item} it @param {Item[]} ch @returns {Item[]}
   */
  const stretchers = (it, ch) => {
    if (it.unit === 'hour') return ch;
    const whole = ch.filter((k) => k.unit !== 'hour' && !(k.kind === 'group' && (kids.get(k.id) ?? []).every((o) => o.unit === 'hour')));
    return whole.length ? whole : ch;
  };

  /** @type {Layout} */
  const out = new Map();
  for (const it of doc.items) {
    const start = startOf(it), end = endOf(it), ch = kids.get(it.id) ?? [];
    out.set(it.id, { item: it, start, end, show: it.kind === 'group' ? Math.max(end, ...ch.map(endOf)) : end });
  }
  return out;
}

/**
 * Length of a placed item in its own units.
 * @param {Placed} p
 * @returns {number}
 */
export const unitsOf = (p) => Math.round((p.end - p.start) / UNIT_DAYS[p.item.unit] * 100) / 100;

/**
 * Ids that count toward totals: committed items (or every item when
 * `optional`), inside counted parents, and only the pick of each group.
 * @param {PlanDoc} doc
 * @param {boolean} optional Count optional items too.
 * @param {string} [root] Count within this item only, treating it as counted.
 * @returns {Set<string>}
 */
export function counted(doc, optional, root) {
  const out = new Set();
  /** @param {Item} it @param {boolean} forced */
  const visit = (it, forced) => {
    if (out.has(it.id)) return;
    const parent = byId(doc, it.parent);
    const ok = forced || (parent?.kind === 'group' ? kidsOf(doc, parent.id)[0] === it : it.committed || optional);
    if (!ok) return;
    out.add(it.id);
    kidsOf(doc, it.id).forEach((k) => visit(k, false));
  };
  if (root) { const r = byId(doc, root); if (r) visit(r, true); } else kidsOf(doc, undefined).forEach((it) => visit(it, false));
  return out;
}

/**
 * What one cost line comes to.
 * @param {PlanDoc} doc
 * @param {CostLine} line
 * @param {Placed} p Where its item sits.
 * @returns {number}
 */
export function lineCost(doc, line, p) {
  const mult = line.pp ? doc.people : 1;
  if (line.type === 'fixed') return line.amount * mult;
  if (line.type === 'per') return line.amount * unitsOf(p) * mult;
  const r = line.route ? doc.routes[line.route] : undefined;
  return r ? fareOn(r, p.start) * mult : 0;
}

/**
 * An item's own costs, split into travel (fares) and everything else.
 * @param {PlanDoc} doc
 * @param {Placed} p
 * @returns {Split}
 */
export function itemCost(doc, p) {
  const c = { stay: 0, travel: 0 };
  for (const line of p.item.costs) c[line.type === 'date' ? 'travel' : 'stay'] += lineCost(doc, line, p);
  return c;
}

/**
 * Total of everything that counts.
 * @param {PlanDoc} doc
 * @param {{optional?: boolean, root?: string, over?: Record<string, number>, at?: Layout}} [opts]
 * @returns {Split}
 */
export function total(doc, { optional = false, root, over, at = layout(doc, over) } = {}) {
  const c = { stay: 0, travel: 0 };
  for (const id of counted(doc, optional, root)) {
    const one = itemCost(doc, /** @type {Placed} */ (at.get(id)));
    c.stay += one.stay;
    c.travel += one.travel;
  }
  return c;
}

/**
 * Nights (or days) inside an item that no child covers, and that two or
 * more children cover. Only children in the same unit count, and optional
 * ones only when `optional` is set; in a group, only the pick.
 * @param {PlanDoc} doc
 * @param {Layout} at
 * @param {boolean} optional
 * @returns {Map<string, {gaps: [number, number][], overlaps: [number, number][]}>}
 */
export function coverage(doc, at, optional) {
  const out = new Map();
  for (const it of doc.items) {
    if (it.kind !== 'item' || it.unit === 'hour') continue;
    const spans = kidsOf(doc, it.id)
      .filter((k) => (k.kind === 'group' ? kidsOf(doc, k.id)[0]?.unit === it.unit : k.kind === 'item' && k.unit === it.unit && (k.committed || optional)))
      .map((k) => /** @type {Placed} */ (at.get(k.id)));
    if (!spans.length) continue;
    const p = /** @type {Placed} */ (at.get(it.id)), a = Math.floor(p.start);
    // A night parent stretched by an hour-long child (a flight home) ends mid-day: that day's night isn't part of it.
    const b = Math.min(it.unit === 'night' ? Math.floor(p.end) : Math.ceil(p.end), a + 3000);
    /** @type {[number, number][]} */
    const gaps = [];
    /** @type {[number, number][]} */
    const overlaps = [];
    /** @param {[number, number][]} list @param {number} d */
    const add = (list, d) => { const last = list[list.length - 1]; if (last && last[1] === d) last[1] = d + 1; else list.push([d, d + 1]); };
    for (let d = a; d < b; d++) {
      const n = spans.filter((s) => s.start <= d && d < s.end).length;
      if (n === 0) add(gaps, d);
      else if (n > 1) add(overlaps, d);
    }
    if (gaps.length || overlaps.length) out.set(it.id, { gaps, overlaps });
  }
  return out;
}

/**
 * The item whose end this one starts at, following parents with no offset
 * of their own (a room inside a stay that follows Vietnam starts when
 * Vietnam ends).
 * @param {PlanDoc} doc
 * @param {Item} it
 * @returns {Item | undefined}
 */
export function anchorOf(doc, it) {
  const seen = new Set();
  for (let cur = /** @type {Item | undefined} */ (it); cur && !seen.has(cur.id); cur = byId(doc, cur.parent)) {
    seen.add(cur.id);
    if (cur.offset) return;
    if (cur.after) return byId(doc, cur.after);
    if (cur.start) return;
  }
}

/**
 * Items that start right when `id` ends.
 * @param {PlanDoc} doc
 * @param {string} id
 * @returns {Item[]}
 */
export const followersOf = (doc, id) => doc.items.filter((it) => it.id !== id && anchorOf(doc, it)?.id === id);

/**
 * The item whose length you are deciding: the first adjustable item that
 * something follows (else the first item that something follows).
 * @param {PlanDoc} doc
 * @returns {Item | undefined}
 */
export function pivotOf(doc) {
  const led = doc.items.filter((it) => it.kind === 'item' && doc.items.some((f) => f.after === it.id));
  return led.find(isRanged) ?? led[0];
}

/**
 * The either/or group whose options the cost panel compares: the one that
 * follows the pivot, else the first group.
 * @param {PlanDoc} doc
 * @param {Item | undefined} pivot
 * @returns {Item | undefined}
 */
export const focusGroupOf = (doc, pivot) =>
  (pivot && doc.items.find((it) => it.kind === 'group' && anchorOf(doc, it)?.id === pivot.id)) ??
  doc.items.find((it) => it.kind === 'group' && kidsOf(doc, it.id).length);

/**
 * Routes priced by the day you leave `id`: fares of items that start when it ends.
 * @param {PlanDoc} doc
 * @param {string} id
 * @returns {string[]} Route keys.
 */
export const departRoutes = (doc, id) => [...new Set(followersOf(doc, id).flatMap((it) =>
  it.costs.flatMap((c) => (c.type === 'date' && c.route && doc.routes[c.route] ? [c.route] : []))))];

/**
 * Cost of choosing one option, everything inside it included, if the pivot
 * lasts `len` units.
 * @param {PlanDoc} doc
 * @param {string} optId Child of the focus group.
 * @param {string | undefined} pivotId
 * @param {number} len Pivot length to price.
 * @param {boolean} optional
 * @returns {Split & {depart: number, end: number}}
 */
export function optionCost(doc, optId, pivotId, len, optional) {
  const at = layout(doc, pivotId ? { [pivotId]: len } : {});
  const c = total(doc, { optional, root: optId, at }), p = /** @type {Placed} */ (at.get(optId));
  return { ...c, depart: pivotId ? /** @type {Placed} */ (at.get(pivotId)).end : p.start, end: p.show };
}

/**
 * Names of an option's children in time order, e.g. "Bangkok → Taipei".
 * @param {PlanDoc} doc
 * @param {Item} it
 * @param {Layout} at
 * @returns {string}
 */
export const insideName = (doc, it, at) =>
  kidsOf(doc, it.id).sort((a, b) => /** @type {Placed} */ (at.get(a.id)).start - /** @type {Placed} */ (at.get(b.id)).start)
    .map((k) => k.name).join(' → ');

/**
 * Moves an item among its siblings.
 * @param {PlanDoc} doc Mutated in place.
 * @param {string} id
 * @param {number} rank New position among siblings (0 = top), clamped.
 */
export function setRank(doc, id, rank) {
  const it = byId(doc, id);
  if (!it) return;
  const sibs = kidsOf(doc, it.parent), from = sibs.indexOf(it), to = clamp(Math.round(rank), 0, sibs.length - 1);
  if (from === to) return;
  const target = sibs[to];
  doc.items.splice(doc.items.indexOf(it), 1);
  doc.items.splice(doc.items.indexOf(target) + (to > from ? 1 : 0), 0, it);
}

/**
 * Removes routes no cost line uses any more.
 * @param {PlanDoc} doc Mutated in place.
 */
export function pruneRoutes(doc) {
  const used = new Set(doc.items.flatMap((it) => it.costs.map((c) => c.route)));
  for (const k of Object.keys(doc.routes)) if (!used.has(k)) delete doc.routes[k];
}

/**
 * Deletes an item and everything inside it. Items that followed any of them
 * keep their dates and become free-standing.
 * @param {PlanDoc} doc Mutated in place.
 * @param {string} id
 * @returns {string[]} Picture ids that belonged to the removed items.
 */
export function removeItem(doc, id) {
  const gone = subtree(doc, id), at = layout(doc);
  for (const it of doc.items) {
    if (gone.has(it.id) || !it.after || !gone.has(it.after)) continue;
    const p = /** @type {Placed} */ (at.get(it.id));
    delete it.after;
    it.start = isoOf(p.start);
    it.offset = it.unit === 'hour' ? p.start - Math.floor(p.start) - (it.at ?? 0) / 24 : 0;
  }
  const images = doc.items.filter((it) => gone.has(it.id)).flatMap((it) => it.images);
  doc.items = doc.items.filter((it) => !gone.has(it.id));
  pruneRoutes(doc);
  return images;
}

/** Known listing sites by domain, for link chips. */
const SITES = /** @type {[RegExp, string][]} */ ([
  [/(^|\.)booking\.com$/, 'Booking'], [/(^|\.)agoda\.com$/, 'Agoda'], [/(^|\.)airbnb\.[a-z.]+$/, 'Airbnb'],
  [/(^|\.)hotels\.com$/, 'Hotels.com'], [/(^|\.)expedia\.[a-z.]+$/, 'Expedia'], [/(^|\.)vrbo\.com$/, 'Vrbo'],
  [/(^|\.)hostelworld\.com$/, 'Hostelworld'], [/(^|\.)tripadvisor\.[a-z.]+$/, 'Tripadvisor'],
  [/(^|\.)trip\.com$/, 'Trip.com'], [/(^|\.)google\.[a-z.]+$|^goo\.gl$|^maps\.app\.goo\.gl$/, 'Google'],
]);

/**
 * Short site name for a link chip: a known listing site, else the bare host.
 * @param {string} url
 * @returns {string} e.g. "Agoda", or "example.com".
 */
export function siteOf(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return 'Link'; }
  return SITES.find(([re]) => re.test(host))?.[1] ?? host.replace(/^www\./, '');
}

/**
 * Whether a string is a link worth keeping (http or https only).
 * @param {unknown} s
 * @returns {s is string}
 */
export function isLink(s) {
  if (typeof s !== 'string' || s.length > 2000) return false;
  try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; }
}

/** Shape of a picture id (a UUID from the Worker). */
export const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Most links and pictures per item. */
export const MAX_LINKS = 8, MAX_IMAGES = 8;

/**
 * An empty plan.
 * @returns {PlanDoc}
 */
export const emptyDoc = () => ({ v: 2, currency: 'USD', people: 1, items: [], routes: {} });

/**
 * A new item with defaults filled in.
 * @param {Partial<Item> & {id: string, name: string}} fields
 * @returns {Item}
 */
export const makeItem = (fields) => ({
  kind: 'item', offset: 0, unit: 'night', committed: true, costs: [], color: 'gray', links: [], images: [], ...fields,
});

/**
 * Turns a v1 plan (flat bars chained with `after`) into a v2 one. Several
 * stays that follow the same bar become an either/or group; an option that
 * is itself a chain (Bangkok then Taipei) becomes an item holding the chain.
 * @param {any} src v1 document (untrusted).
 * @returns {object} v2-shaped document, still to be normalized.
 */
export function upgradeV1(src) {
  const bars = (Array.isArray(src.bars) ? src.bars : [])
    .filter((/** @type {any} */ b) => b && typeof b === 'object' && typeof b.id === 'string' && (b.kind === 'window' || b.kind === 'stay'));
  const known = new Set(bars.map((/** @type {any} */ b) => b.id)), taken = new Set(known), placed = new Set();
  /** @type {object[]} */
  const items = [];
  /** @param {string} base @returns {string} */
  const fresh = (base) => { let id = base; for (let n = 2; taken.has(id); n++) id = `${base}-${n}`; taken.add(id); return id; };
  /** @param {string} id @returns {any[]} */
  const follows = (id) => bars.filter((/** @type {any} */ b) => b.kind === 'stay' && b.after === id && !placed.has(b.id));
  /** @param {string} id @returns {string} */
  const nameOf = (id) => bars.find((/** @type {any} */ b) => b.id === id)?.name ?? '?';
  /** @param {any} b @param {object} extra */
  const push = (b, extra) => {
    placed.add(b.id);
    const base = { id: b.id, name: b.name, ...(typeof b.note === 'string' && b.note && { note: b.note }), ...extra };
    if (b.kind === 'window') return items.push({ ...base, kind: 'window', start: b.start, unit: 'day', len: b.days });
    const costs = [];
    if (b.night > 0) costs.push({ label: 'Room', type: 'per', amount: b.night, pp: false });
    if (b.daily > 0) costs.push({ label: 'Daily spend', type: 'per', amount: b.daily, pp: true });
    if (typeof b.route === 'string') costs.push({ label: 'Getting here', type: 'date', amount: 0, route: b.route, pp: true });
    items.push({
      ...base, kind: 'item', unit: 'night', len: b.nights, minLen: b.minNights, maxLen: b.maxNights, color: b.color, costs,
      ...(!('after' in extra) && !('parent' in extra) && { start: b.start }),
    });
  };
  /** @param {any} b @returns {string} */
  const chainName = (b) => {
    const names = [b.name];
    for (let f = follows(b.id); f.length === 1 && names.length < 8; f = follows(f[0].id)) names.push(f[0].name);
    return names.join(' → ');
  };
  /** @param {string} id @param {string | undefined} parent */
  const place = (id, parent) => {
    const fs = follows(id);
    if (fs.length === 1) {
      push(fs[0], { after: id, ...(parent && { parent }) });
      return place(fs[0].id, parent);
    }
    if (!fs.length) return;
    const g = fresh(`g-${id}`);
    items.push({ id: g, kind: 'group', name: `After ${nameOf(id)}`, after: id, ...(parent && { parent }) });
    for (const f of fs) {
      if (placed.has(f.id)) continue;
      if (!follows(f.id).length) { push(f, { parent: g }); continue; }
      const c = fresh(`c-${f.id}`);
      items.push({ id: c, kind: 'item', name: f.lane && f.lane !== f.name ? f.lane : chainName(f), parent: g, color: 'pink' });
      push(f, { parent: c });
      place(f.id, c);
    }
  };
  for (const b of bars) {
    if (placed.has(b.id) || (b.kind === 'stay' && known.has(b.after))) continue;
    push(b, {});
    place(b.id, undefined);
  }
  for (const b of bars) if (!placed.has(b.id)) push(b, { after: b.after }); // cycles: layout breaks them
  return { v: 2, currency: src.currency, people: 1, items, routes: src.routes };
}

/**
 * Coerces untrusted JSON (from the API) into a valid v2 plan, upgrading v1
 * plans and dropping what can't be drawn rather than failing.
 * @param {unknown} raw
 * @returns {PlanDoc}
 */
export function normalize(raw) {
  let src = /** @type {any} */ (raw && typeof raw === 'object' ? raw : {});
  if (src.v !== 2 && Array.isArray(src.bars)) src = upgradeV1(src);
  const num = (/** @type {unknown} */ v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const str = (/** @type {unknown} */ v, d = '') => (typeof v === 'string' ? v : d);
  const pos = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

  /** @type {Record<string, Route>} */
  const routes = {};
  for (const [k, r] of Object.entries(src.routes && typeof src.routes === 'object' ? src.routes : {})) {
    if (!r || typeof r !== 'object') continue;
    const q = /** @type {any} */ (r);
    const fares = Object.fromEntries(Object.entries(q.fares ?? {}).filter(([d, v]) => !Number.isNaN(dayOf(d)) && num(v, -1) >= 0));
    routes[k] = {
      from: str(q.from, '?'), to: str(q.to, '?'), depart: clamp(num(q.depart, 12), 0, 23.99),
      hours: Math.max(0, num(q.hours, 1)), fare: Math.max(0, num(q.fare)), fares: /** @type {Record<string, number>} */ (fares),
    };
  }

  /** @type {Item[]} */
  const items = [];
  const seen = new Set();
  for (const r of Array.isArray(src.items) ? src.items : []) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    const kind = r.kind === 'group' || r.kind === 'window' ? r.kind : 'item';
    const unit = kind === 'window' ? 'day' : r.unit === 'day' || r.unit === 'hour' ? r.unit : 'night';
    const round = (/** @type {number} */ n) => (unit === 'hour' ? Math.round(n * 4) / 4 : Math.round(n)) || (unit === 'hour' ? 0.25 : 1);
    const it = makeItem({ id: r.id, name: str(r.name).slice(0, 80) || 'Untitled', kind, unit });
    for (const k of /** @type {const} */ (['parent', 'after'])) if (typeof r[k] === 'string' && r[k] !== r.id) it[k] = r[k];
    if (!it.after && !Number.isNaN(dayOf(r.start))) it.start = r.start;
    it.offset = unit === 'hour' ? clamp(num(r.offset), -3650, 3650) : clamp(Math.round(num(r.offset)), -3650, 3650);
    if (unit === 'hour' && !it.after) it.at = clamp(num(r.at), 0, 23.75);
    const len = pos(r.len);
    if (kind === 'window') it.len = round(len ?? 1);
    else if (kind === 'item' && len !== undefined) {
      it.len = round(len);
      const mn = pos(r.minLen), mx = pos(r.maxLen);
      if (mn !== undefined && mx !== undefined && round(mx) > round(mn)) {
        it.minLen = round(mn);
        it.maxLen = round(mx);
        it.len = clamp(it.len, it.minLen, it.maxLen);
      }
    }
    if (kind !== 'window') it.committed = r.committed !== false;
    if (COLORS.includes(r.color)) it.color = r.color;
    if (str(r.note)) it.note = str(r.note).slice(0, 2000);
    if (kind === 'item' && Array.isArray(r.costs)) {
      for (const c of r.costs.slice(0, 12)) {
        if (!c || typeof c !== 'object') continue;
        const type = c.type === 'fixed' || c.type === 'date' ? c.type : 'per';
        if (type === 'date' && !(typeof c.route === 'string' && routes[c.route])) continue;
        it.costs.push({
          label: str(c.label).slice(0, 40), type, amount: type === 'date' ? 0 : Math.max(0, num(c.amount)), pp: c.pp === true,
          ...(type === 'date' && { route: c.route }),
        });
      }
    }
    if (Array.isArray(r.links)) it.links = [...new Set(r.links.filter(isLink))].slice(0, MAX_LINKS);
    if (Array.isArray(r.images)) it.images = [...new Set(r.images.filter((/** @type {unknown} */ s) => typeof s === 'string' && IMAGE_ID.test(s)))].slice(0, MAX_IMAGES);
    items.push(it);
  }

  // Drop dangling references and parent loops.
  const ids = new Map(items.map((it) => [it.id, it]));
  for (const it of items) {
    if (it.after && !ids.has(it.after)) delete it.after;
    const p = it.parent ? ids.get(it.parent) : undefined;
    if (!p || p.kind === 'window') delete it.parent;
  }
  for (const it of items) {
    const path = new Set([it.id]);
    for (let p = it.parent ? ids.get(it.parent) : undefined; p; p = p.parent ? ids.get(p.parent) : undefined) {
      if (path.has(p.id)) { delete it.parent; break; }
      path.add(p.id);
    }
  }
  return {
    v: 2,
    currency: /^[A-Z]{3}$/.test(src.currency) ? src.currency : 'USD',
    people: clamp(Math.round(num(src.people, 1)), 1, 99),
    items,
    routes,
  };
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
 * The round-1 sample as a v1 document (kept to test the upgrade).
 * @returns {object}
 */
export function sampleV1() {
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

/**
 * The sample plan: a 90-day Vietnam visa from Oct 20 2026, a 59–89 night
 * stay split across rooms (one optional, with a gap at the end), and an
 * either/or group of three ways to continue, with room options in Bangkok
 * and Taipei. Prices are made up.
 * @returns {PlanDoc}
 */
export function sampleDoc() {
  const doc = normalize(sampleV1());
  const vn = /** @type {Item} */ (byId(doc, 'vn'));
  vn.costs = vn.costs.filter((c) => c.label !== 'Room');
  const room = (/** @type {string} */ id, /** @type {string} */ name, /** @type {number} */ offset, /** @type {number} */ len, /** @type {number} */ rate, committed = true) =>
    makeItem({ id, name, parent: 'vn', offset, len, committed, color: 'green', costs: [{ label: 'Room', type: 'per', amount: rate, pp: false }] });
  doc.items.splice(doc.items.indexOf(vn) + 1, 0,
    room('vn-hanoi', 'Hanoi apartment', 0, 28, 26),
    room('vn-hoian', 'Hoi An homestay', 28, 30, 38),
    room('vn-saigon', 'Saigon studio', 54, 30, 31, false));
  addRooms(doc);
  return doc;
}

/**
 * Sample room options for the Bangkok and Taipei stays: an either/or pick of
 * three Bangkok rooms, and a Taipei stay split into an apartment then a pick
 * of two places for the last nights. The rooms carry the room price, so the
 * stays' own Room lines are dropped. Names and prices are made up.
 * @param {PlanDoc} doc Plan holding the `bkk` and `tpe` stays.
 */
function addRooms(doc) {
  /** @type {(id: string, name: string, parent: string, rate: number, color: string, offset: number, len: number) => Item} */
  const room = (id, name, parent, rate, color, offset, len) =>
    makeItem({ id, name, parent, offset, len, color, costs: [{ label: 'Room', type: 'per', amount: rate, pp: false }] });
  /** @type {(id: string, name: string, parent: string, offset: number) => Item} */
  const group = (id, name, parent, offset) => makeItem({ id, kind: 'group', name, parent, offset });
  const bkk = /** @type {Item} */ (byId(doc, 'bkk')), tpe = /** @type {Item} */ (byId(doc, 'tpe'));
  const nb = bkk.len ?? 10, nt = tpe.len ?? 10, first = Math.ceil(nt / 2);
  for (const it of [bkk, tpe]) it.costs = it.costs.filter((c) => c.label !== 'Room');
  doc.items.splice(doc.items.indexOf(bkk) + 1, 0,
    group('bkk-rooms', 'Bangkok room', 'bkk', 0),
    room('bkk-sukhumvit', 'Sukhumvit condo', 'bkk-rooms', 42, 'orange', 0, nb),
    room('bkk-ari', 'Ari studio', 'bkk-rooms', 35, 'orange', 0, nb),
    room('bkk-riverside', 'Riverside hotel', 'bkk-rooms', 68, 'orange', 0, nb));
  doc.items.splice(doc.items.indexOf(tpe) + 1, 0,
    room('tpe-daan', "Da'an apartment", 'tpe', 70, 'blue', 0, first),
    group('tpe-last', `Last ${nt - first} nights`, 'tpe', first),
    room('tpe-zhongshan', 'Zhongshan hotel', 'tpe-last', 85, 'blue', 0, nt - first),
    room('tpe-beitou', 'Beitou hot spring inn', 'tpe-last', 115, 'blue', 0, nt - first));
}
