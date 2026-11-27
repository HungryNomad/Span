// @ts-check
/**
 * Trip-level reading of a plan, shared by the lanes view and the other
 * views: forks (either/or groups whose options are whole trips), totals as
 * if an option were picked, price ranges over every pick still open, where
 * you sleep, flights between places, and a still-deciding sample plan.
 * Pure functions only, so it runs in the browser and under `node --test`.
 *
 * @module
 */
import {
  ancestors, byId, counted, dayOf, itemCost, kidsOf, layout, makeItem, money, normalize, pick, routeLabel, setRank, total, typeOf, unitsOf,
} from './model.js';

/** @typedef {import('./model.js').PlanDoc} PlanDoc */
/** @typedef {import('./model.js').Item} Item */
/** @typedef {import('./model.js').Layout} Layout */
/** @typedef {import('./model.js').Placed} Placed */
/** @typedef {import('./model.js').CostFilter} CostFilter */

/**
 * A move between places: a transport item (a flight or train) or a stay's
 * fare-priced "getting here" line.
 * @typedef {object} Hop
 * @property {Item} item The transport item, or the stay it brings you to.
 * @property {number} at Departure as a fractional day index.
 * @property {number} hours Duration.
 * @property {string} label e.g. "SGN → BKK" or the item's name.
 * @property {string} [from] Place code, when known.
 * @property {string} [to]
 * @property {number} cost What it adds to the total.
 */

/**
 * Copy of a plan with one option ranked first in its group, so it's the pick.
 * @param {PlanDoc} doc Left untouched.
 * @param {string} id Option (child of a group).
 * @returns {PlanDoc}
 */
export function withPick(doc, id) {
  const copy = /** @type {PlanDoc} */ (structuredClone(doc));
  setRank(copy, id, 0);
  return copy;
}

/**
 * Whether a group is a fork: its options hold things of their own (whole
 * trips) rather than being single rooms or flights.
 * @param {PlanDoc} doc
 * @param {Item} it
 * @returns {boolean}
 */
export const isFork = (doc, it) => it.kind === 'group' && kidsOf(doc, it.id).some((k) => kidsOf(doc, k.id).length > 0);

/**
 * The plan's main fork: the shallowest fork, first in rank order.
 * @param {PlanDoc} doc
 * @returns {Item | undefined}
 */
export function forkOf(doc) {
  const forks = doc.items.filter((it) => isFork(doc, it) && kidsOf(doc, it.id).length > 1);
  return forks.sort((a, b) => ancestors(doc, a).length - ancestors(doc, b).length)[0];
}

/**
 * What an item and everything that counts inside it comes to.
 * @param {PlanDoc} doc
 * @param {string} id
 * @param {{optional: boolean, filter: CostFilter, at?: Layout}} o
 * @returns {number}
 */
export const valueOf = (doc, id, { optional, filter, at }) => pick(total(doc, { optional, root: id, at }), filter);

/**
 * The whole plan's total if `id` were the pick of its group.
 * @param {PlanDoc} doc
 * @param {string} id
 * @param {{optional: boolean, filter: CostFilter}} o
 * @returns {number}
 */
export const totalIfPicked = (doc, id, { optional, filter }) => pick(total(withPick(doc, id), { optional }), filter);

/**
 * How an option compares with the pick of its group, as short text: the
 * difference in what it adds ("+$40"), or, when the two last a different
 * number of nights (or days), the difference per night and the option's
 * length ("8n · −$5/night"), so a shorter stay doesn't look cheaper only
 * for being shorter.
 * @param {PlanDoc} doc
 * @param {string} id The option.
 * @param {string} pickId The group's pick.
 * @param {{optional: boolean, filter: CostFilter, at?: Layout}} o
 * @returns {string} Empty when costs are hidden, the option is the pick, or there's no difference.
 */
export function rivalDelta(doc, id, pickId, o) {
  if (o.filter === 'none' || id === pickId) return '';
  const at = o.at ?? layout(doc), a = at.get(id), b = at.get(pickId);
  if (!a || !b) return '';
  const va = valueOf(doc, id, { ...o, at }), vb = valueOf(doc, pickId, { ...o, at });
  const na = unitsOf(a), nb = unitsOf(b), cur = doc.currency;
  /** A signed amount. */
  const signed = (/** @type {number} */ d) => `${d > 0 ? '+' : '−'}${money(Math.abs(d), cur)}`;
  if (na === nb || a.item.unit === 'hour' || !na || !nb) return va === vb ? '' : signed(va - vb);
  const d = Math.round(va / na - vb / nb), unit = a.item.unit === 'night' ? 'night' : 'day';
  return `${+na.toFixed(2)}${unit[0]} vs ${+nb.toFixed(2)}${unit[0]}${d ? ` · ${signed(d)}/${unit}` : ''}`;
}

/**
 * Cheapest and dearest an item can come to over every pick still open
 * inside it (options are priced where they sit now).
 * @param {PlanDoc} doc
 * @param {string} id
 * @param {{optional: boolean, filter: CostFilter, at?: Layout}} o
 * @returns {[number, number]}
 */
export function costRange(doc, id, { optional, filter, at = layout(doc) }) {
  /** @param {Item} it @param {number} guard @returns {[number, number]} */
  const walk = (it, guard) => {
    if (guard > 40) return [0, 0];
    const kids = kidsOf(doc, it.id);
    if (it.kind === 'group') {
      if (!kids.length) return [0, 0];
      const rs = kids.map((k) => walk(k, guard + 1));
      return [Math.min(...rs.map((r) => r[0])), Math.max(...rs.map((r) => r[1]))];
    }
    const p = at.get(it.id);
    const own = it.kind === 'item' && p ? pick(itemCost(doc, p), filter) : 0;
    let lo = own, hi = own;
    for (const k of kids) {
      if (k.kind !== 'group' && !k.committed && !optional) continue;
      const [a, b] = walk(k, guard + 1);
      lo += a;
      hi += b;
    }
    return [lo, hi];
  };
  const it = byId(doc, id);
  return it ? walk(it, 0) : [0, 0];
}

/**
 * Where you sleep: counted night items with no counted night item inside,
 * in time order.
 * @param {PlanDoc} doc
 * @param {Layout} at
 * @param {boolean} optional
 * @returns {Placed[]}
 */
export function sleeps(doc, at, optional) {
  const c = counted(doc, optional);
  /** A stay counted by the night. */
  const nightly = (/** @type {Item} */ it) => it.kind === 'item' && it.unit === 'night' && typeOf(it) !== 'transport' && typeOf(it) !== 'event';
  const inner = new Set();
  for (const it of doc.items) if (c.has(it.id) && nightly(it)) for (const a of ancestors(doc, it)) inner.add(a.id);
  return doc.items.filter((it) => c.has(it.id) && nightly(it) && !inner.has(it.id))
    .map((it) => /** @type {Placed} */ (at.get(it.id))).sort((a, b) => a.start - b.start);
}

/** Pulls airport codes out of a name like "VietJet SGN → BKK". */
const HOP_CODES = /\b([A-Z]{3})\s*(?:→|->|–|\bto\b)\s*([A-Z]{3})\b/;
/** Pulls places out of a name like "Taipei to Tainan". */
const HOP_NAME = /^\s*(.+?)\s*(?:→|->|–|\bto\b)\s*(.+?)\s*$/i;

/**
 * Counted moves between places, in time order.
 * @param {PlanDoc} doc
 * @param {Layout} at
 * @param {boolean} optional
 * @returns {Hop[]}
 */
export function hops(doc, at, optional) {
  const c = counted(doc, optional);
  /** @type {Hop[]} */
  const out = [];
  for (const it of doc.items) {
    if (!c.has(it.id) || it.kind !== 'item') continue;
    const p = /** @type {Placed} */ (at.get(it.id));
    if (typeOf(it) === 'transport') {
      const m = HOP_CODES.exec(it.name) ?? HOP_NAME.exec(it.name);
      const cost = itemCost(doc, p);
      out.push({ item: it, at: p.start, hours: (p.end - p.start) * 24, label: it.name, from: m?.[1], to: m?.[2], cost: cost.stay + cost.travel });
      continue;
    }
    for (const line of it.costs) {
      const r = line.type === 'date' && line.route ? doc.routes[line.route] : undefined;
      if (!r) continue;
      const fare = itemCost(doc, p).travel;
      out.push({ item: it, at: Math.floor(p.start) + r.depart / 24, hours: r.hours, label: routeLabel(r), from: r.from, to: r.to, cost: fare });
      break;
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The first "per" cost of an item (its nightly rate, usually).
 * @param {Item} it
 * @returns {number | undefined}
 */
export const rateOf = (it) => it.costs.find((l) => l.type === 'per' && !l.pp)?.amount ?? it.costs.find((l) => l.type === 'per')?.amount;

/**
 * Every per-night (or per-day) cost of an item in one phrase, with
 * per-person lines multiplied out: "$38 room + $44 daily spend a night".
 * @param {PlanDoc} doc
 * @param {Item} it
 * @returns {string} Empty when it has no per-night costs.
 */
export function ratesText(doc, it) {
  const lines = it.costs.filter((l) => l.type === 'per');
  if (!lines.length) return '';
  const unit = it.unit === 'night' ? 'night' : it.unit === 'day' ? 'day' : 'hour';
  const parts = lines.map((l) => `${money(l.amount * (l.pp ? doc.people : 1), doc.currency)}${lines.length > 1 && l.label ? ` ${l.label.toLowerCase()}` : ''}`);
  return `${parts.join(' + ')} a ${unit}`;
}

/**
 * A plan that hasn't decided where to go after Saigon: Thailand or Taiwan,
 * each with its own flights in, stays (with room options) and flight home.
 * Two people, Dec 10 2026 to Jan 12 2027. Names and prices are made up.
 * @returns {PlanDoc}
 */
export function decidingSample() {
  /** @type {Partial<Item>[]} */
  const raw = [];
  /** A per-night (or per-day) cost line. */
  const per = (/** @type {number} */ amount, label = 'Room', pp = false) => ({ label, type: /** @type {const} */ ('per'), amount, pp });
  /** A one-off fare per person. */
  const fare = (/** @type {number} */ amount) => ({ label: 'Fare', type: /** @type {const} */ ('fixed'), amount, pp: true });
  /** Adds an item. @param {Partial<Item> & {id: string, name: string}} f */
  const add = (f) => raw.push(makeItem(f));
  /**
   * A flight or train: hour item at a clock time, or right after `after`.
   * @param {string} id @param {string} name @param {string} parent @param {number} at Hour.
   * @param {number} hours @param {number} pp Fare per person. @param {Partial<Item>} [more]
   */
  const hop = (id, name, parent, at, hours, pp, more = {}) =>
    add({ id, name, parent, unit: 'hour', len: hours, costs: [fare(pp)], ...(more.after ? { offset: at / 24 } : { at }), ...more });
  /**
   * An either/or of rooms for `nights`, each room `[id, name, rate, link]`.
   * @param {string} id @param {string} name @param {string} parent @param {number} nights
   * @param {string} color @param {[string, string, number, string][]} rooms @param {Partial<Item>} [more]
   */
  const stay = (id, name, parent, nights, color, rooms, more = {}) => {
    add({ id, name, parent, kind: 'group', color, ...more });
    for (const [rid, rname, rate, link] of rooms) add({ id: rid, name: rname, parent: id, len: nights, color, costs: [per(rate)], links: [link] });
  };

  add({ id: 'visa', name: 'Vietnam e-visa', kind: 'window', unit: 'day', start: '2026-10-20', len: 90 });
  add({ id: 'sgn', name: 'Saigon', start: '2026-12-10', len: 8, color: 'green', costs: [per(38), per(22, 'Daily spend', true)], links: ['https://www.airbnb.com/'], note: 'Apartment in District 1, walking distance to the river.' });
  add({ id: 'next', name: 'Where next?', kind: 'group', after: 'sgn' });

  add({ id: 'th', name: 'Thailand', parent: 'next', color: 'orange', costs: [per(30, 'Daily spend', true)] });
  add({ id: 'th-in', name: 'Flight in', parent: 'th', kind: 'group', color: 'orange' });
  hop('th-vj', 'VietJet SGN → BKK', 'th-in', 10 + 25 / 60, 1.6, 96);
  hop('th-aa', 'AirAsia SGN → BKK', 'th-in', 15 + 40 / 60, 1.6, 78);
  stay('th-bkk', 'Bangkok', 'th', 14, 'orange', [
    ['th-suk', 'Sukhumvit studio', 42, 'https://www.agoda.com/'], ['th-ari', 'Ari loft', 35, 'https://www.airbnb.com/'],
    ['th-riv', 'Riverside suite', 68, 'https://www.booking.com/']]);
  hop('th-hop', 'BKK → CNX', 'th', 11, 1.2, 45, { after: 'th-bkk' });
  stay('th-cnx', 'Chiang Mai', 'th', 11, 'orange', [
    ['th-nim', 'Nimman condo', 30, 'https://www.airbnb.com/'], ['th-old', 'Old City guesthouse', 24, 'https://www.agoda.com/']], { after: 'th-bkk' });
  hop('th-home', 'CNX → SGN', 'th', 14 + 20 / 60, 2, 110, { after: 'th-cnx' });

  add({ id: 'tw', name: 'Taiwan', parent: 'next', color: 'blue', costs: [per(38, 'Daily spend', true)] });
  add({ id: 'tw-in', name: 'Flight in', parent: 'tw', kind: 'group', color: 'blue' });
  hop('tw-eva', 'EVA SGN → TPE', 'tw-in', 8 + 40 / 60, 3.4, 170);
  hop('tw-vj', 'VietJet SGN → TPE', 'tw-in', 23 + 40 / 60, 3.4, 120, { note: 'Red-eye: a night on the plane.' });
  stay('tw-tpe', 'Taipei', 'tw', 15, 'blue', [
    ['tw-daan', "Da'an apartment", 70, 'https://www.airbnb.com/'], ['tw-zs', 'Zhongshan hotel', 85, 'https://www.agoda.com/']]);
  hop('tw-train', 'Taipei → Tainan', 'tw', 10 + 10 / 60, 1.8, 45, { after: 'tw-tpe', mode: 'train' });
  stay('tw-tnn', 'Tainan', 'tw', 10, 'blue', [
    ['tw-old', 'Old town house', 55, 'https://www.airbnb.com/'], ['tw-anp', 'Anping hotel', 62, 'https://www.booking.com/']], { after: 'tw-tpe' });
  hop('tw-home', 'KHH → SGN', 'tw', 12 + 5 / 60, 2.5, 150, { after: 'tw-tnn' });

  return normalize({ v: 2, currency: 'USD', people: 2, items: raw, routes: {} });
}

/** Day index of the still-deciding sample's first day, for tests. */
export const DECIDING_START = dayOf('2026-12-10');
