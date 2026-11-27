// @ts-check
/**
 * Where a plan's stays are: a small built-in table of cities (with airport
 * codes and other names) and helpers that name the place an item is in and
 * lay a plan out as stops along its picked route. Pure, so it runs under
 * `node --test`.
 *
 * @module
 */
import { ancestors, byId, fmt, isMoment, kidsOf, layout, subtree, typeOf } from './model.js';
import { forkOf, hops, sleeps, withPick } from './trip.js';

/** @typedef {import('./model.js').PlanDoc} PlanDoc */
/** @typedef {import('./model.js').Item} Item */
/** @typedef {import('./model.js').Layout} Layout */
/** @typedef {import('./model.js').Placed} Placed */
/** @typedef {import('./trip.js').Hop} Hop */

/**
 * A known city.
 * @typedef {object} City
 * @property {string} name Display name.
 * @property {number} lat
 * @property {number} lon
 * @property {string[]} also Other names and airport codes (upper-case codes match whole words only).
 */

/** @type {City[]} */
export const CITIES = [
  ['Hanoi', 21.03, 105.85, 'HAN'], ['Ha Long', 20.95, 107.08, 'Halong'], ['Sapa', 22.34, 103.84, 'Sa Pa'],
  ['Hue', 16.46, 107.59, 'HUI'], ['Da Nang', 16.05, 108.2, 'DAD,Danang'], ['Hoi An', 15.88, 108.33, 'Hoian'],
  ['Nha Trang', 12.24, 109.19, 'CXR'], ['Da Lat', 11.94, 108.44, 'DLI,Dalat'],
  ['Saigon', 10.78, 106.7, 'SGN,Ho Chi Minh,HCMC'], ['Phu Quoc', 10.29, 103.98, 'PQC'],
  ['Bangkok', 13.75, 100.5, 'BKK,DMK'], ['Chiang Mai', 18.79, 98.98, 'CNX'], ['Chiang Rai', 19.91, 99.84, 'CEI'],
  ['Pai', 19.36, 98.44, ''], ['Phuket', 7.88, 98.39, 'HKT'], ['Krabi', 8.09, 98.91, 'KBV,Ao Nang'],
  ['Koh Samui', 9.51, 100.01, 'USM,Samui'], ['Koh Phangan', 9.73, 100.01, 'Phangan'], ['Koh Tao', 10.1, 99.84, ''],
  ['Hua Hin', 12.57, 99.96, ''], ['Ayutthaya', 14.35, 100.57, ''],
  ['Taipei', 25.03, 121.57, 'TPE,TSA'], ['Taichung', 24.15, 120.67, 'RMQ'], ['Tainan', 22.99, 120.21, 'TNN'],
  ['Kaohsiung', 22.63, 120.3, 'KHH'], ['Hualien', 23.99, 121.6, 'HUN'], ['Jiufen', 25.11, 121.84, ''],
  ['Phnom Penh', 11.56, 104.92, 'PNH'], ['Siem Reap', 13.36, 103.86, 'REP,SAI'], ['Kampot', 10.61, 104.18, ''],
  ['Vientiane', 17.97, 102.63, 'VTE'], ['Luang Prabang', 19.89, 102.13, 'LPQ'],
  ['Kuala Lumpur', 3.14, 101.69, 'KUL,KL'], ['Penang', 5.41, 100.33, 'PEN,George Town'], ['Singapore', 1.35, 103.82, 'SIN'],
  ['Bali', -8.65, 115.22, 'DPS,Denpasar,Ubud,Canggu'], ['Jakarta', -6.2, 106.85, 'CGK'], ['Manila', 14.6, 120.98, 'MNL'],
  ['Cebu', 10.32, 123.89, 'CEB'], ['Hong Kong', 22.32, 114.17, 'HKG'], ['Macau', 22.2, 113.54, 'MFM'],
  ['Shanghai', 31.23, 121.47, 'PVG,SHA'], ['Beijing', 39.9, 116.4, 'PEK,PKX'], ['Seoul', 37.57, 126.98, 'ICN,GMP'],
  ['Busan', 35.18, 129.08, 'PUS'], ['Tokyo', 35.68, 139.69, 'NRT,HND'], ['Kyoto', 35.01, 135.77, ''],
  ['Osaka', 34.69, 135.5, 'KIX,ITM'], ['Fukuoka', 33.59, 130.4, 'FUK'], ['Sapporo', 43.06, 141.35, 'CTS'],
  ['Okinawa', 26.21, 127.68, 'OKA,Naha'], ['Delhi', 28.61, 77.21, 'DEL'], ['Mumbai', 19.08, 72.88, 'BOM'],
  ['Goa', 15.3, 74.12, 'GOI'], ['Kathmandu', 27.72, 85.32, 'KTM'], ['Colombo', 6.93, 79.86, 'CMB'],
  ['Dubai', 25.2, 55.27, 'DXB'], ['Istanbul', 41.01, 28.98, 'IST'], ['Athens', 37.98, 23.73, 'ATH'],
  ['Rome', 41.9, 12.5, 'FCO'], ['Barcelona', 41.39, 2.17, 'BCN'], ['Madrid', 40.42, -3.7, 'MAD'],
  ['Lisbon', 38.72, -9.14, 'LIS'], ['Porto', 41.15, -8.61, 'OPO'], ['Paris', 48.86, 2.35, 'CDG,ORY'],
  ['London', 51.51, -0.13, 'LHR,LGW'], ['Amsterdam', 52.37, 4.9, 'AMS'], ['Berlin', 52.52, 13.4, 'BER'],
  ['Prague', 50.08, 14.44, 'PRG'], ['Vienna', 48.21, 16.37, 'VIE'], ['Mexico City', 19.43, -99.13, 'MEX,CDMX'],
  ['New York', 40.71, -74.01, 'JFK,EWR,LGA,NYC'], ['San Francisco', 37.77, -122.42, 'SFO'],
  ['Los Angeles', 34.05, -118.24, 'LAX'], ['Seattle', 47.61, -122.33, 'SEA'], ['Vancouver', 49.28, -123.12, 'YVR'],
  ['Sydney', -33.87, 151.21, 'SYD'], ['Melbourne', -37.81, 144.96, 'MEL'],
].map(([name, lat, lon, also]) => ({
  name: /** @type {string} */ (name), lat: /** @type {number} */ (lat), lon: /** @type {number} */ (lon),
  also: /** @type {string} */ (also).split(',').filter(Boolean),
}));

/** Folds accents and case so "Hồ Chí Minh" matches "Ho Chi Minh". */
const fold = (/** @type {string} */ s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * The known city a piece of text names, if any: a city name or other name
 * as whole words (any case), or an airport code in capitals.
 * @param {string} text e.g. "Sukhumvit condo, Bangkok" or "VietJet SGN → BKK".
 * @returns {City | undefined} The first one named.
 */
export function cityIn(text) {
  const t = ` ${fold(text).replace(/[^a-z0-9]+/g, ' ')} `;
  let best, at = Infinity;
  for (const c of CITIES) {
    for (const n of [c.name, ...c.also]) {
      const code = /^[A-Z]{3}$/.test(n);
      const i = code ? (text.match(new RegExp(`\\b${n}\\b`))?.index ?? -1) : t.indexOf(` ${fold(n)} `);
      if (i >= 0 && i < at) { best = c; at = i; }
    }
  }
  return best;
}

/**
 * The place an item is in: the first of it and its ancestors naming a known
 * city, else the nearest of them typed as a place (unless it holds known
 * cities, like a country), else the nearest ancestor that isn't an either/or
 * group. `sure` is false for that last guess.
 * @param {PlanDoc} doc
 * @param {Item} it
 * @returns {{name: string, city?: City, sure: boolean}}
 */
export function placeOf(doc, it) {
  const chain = [it, ...ancestors(doc, it)];
  for (const a of chain) { const city = cityIn(a.name); if (city) return { name: city.name, city, sure: true }; }
  // A place typed by hand (a town the table doesn't know), unless it holds known cities: then it's a country.
  const typed = chain.find((a) => typeOf(a) === 'place');
  if (typed && ![...subtree(doc, typed.id)].some((id) => id !== typed.id && cityIn(byId(doc, id)?.name ?? ''))) return { name: typed.name, sure: true };
  const parent = byId(doc, it.parent);
  const named = chain.slice(1).find((a) => a.kind !== 'group') ?? parent;
  return { name: (named ?? it).name, sure: false };
}

/**
 * A run of nights in one place.
 * @typedef {object} Stop
 * @property {string} name Place name.
 * @property {City} [city]
 * @property {boolean} sure Whether the place is known (a city, or an item typed as a place).
 * @property {number} start First night, as a day index.
 * @property {number} end Morning you leave.
 * @property {Placed[]} stays Where you sleep, in order.
 * @property {Hop[]} hops Moves that end the stop (and before the next).
 */

/**
 * The picked route as stops: consecutive nights in the same place merge,
 * and each move is filed under the stop it leaves from (the one you check
 * out of that day, else one you're in since before that day, else the last
 * one before it).
 * @param {PlanDoc} doc
 * @param {Layout} at
 * @param {boolean} optional
 * @returns {{stops: Stop[], before: Hop[]}} Stops in order, and moves before the first stop.
 */
export function stopsOf(doc, at, optional) {
  /** @type {Stop[]} */
  const stops = [];
  for (const p of sleeps(doc, at, optional)) {
    const pl = placeOf(doc, p.item), last = stops.at(-1);
    if (last && last.name === pl.name && p.start <= last.end + 0.01) {
      last.stays.push(p);
      last.end = Math.max(last.end, p.end);
    } else stops.push({ name: pl.name, city: pl.city, sure: pl.sure, start: p.start, end: p.end, stays: [p], hops: [] });
  }
  /** @type {Hop[]} */
  const before = [];
  for (const h of hops(doc, at, optional)) {
    const day = Math.floor(h.at), back = [...stops].reverse();
    const from = back.find((s) => Math.floor(s.end) === day) ?? back.find((s) => s.start < day && h.at < s.end)
      ?? back.find((s) => s.end <= h.at);
    (from ? from.hops : before).push(h);
  }
  return { stops, before };
}

/**
 * The options of the group an item is the pick of, if it has rivals.
 * @param {PlanDoc} doc
 * @param {Item} it
 * @returns {{group: Item, options: Item[]} | undefined}
 */
export function rivalsOf(doc, it) {
  const group = byId(doc, it.parent);
  if (group?.kind !== 'group') return undefined;
  const options = kidsOf(doc, group.id);
  return options.length > 1 ? { group, options } : undefined;
}

/**
 * A trip's parts in order, without its flights: "Bangkok → Chiang Mai".
 * @param {PlanDoc} doc
 * @param {string} id The trip (an option of a fork).
 * @returns {string[]} Names of its stays and other parts.
 */
export function legsOf(doc, id) {
  /** A flight, or a group of flights to pick from. */
  const hourly = (/** @type {Item} */ it) => isMoment(it) || (it.kind === 'group' && !!kidsOf(doc, it.id)[0] && isMoment(kidsOf(doc, it.id)[0]));
  return kidsOf(doc, id).filter((k) => k.kind !== 'window' && !hourly(k)).map((k) => k.name);
}

/**
 * A change of place with no transport booked between: you leave one known
 * place and next sleep in another, and nothing moves you.
 * @typedef {object} Missing
 * @property {string} from Place you leave.
 * @property {string} to Place you arrive in.
 * @property {number} day Day you arrive (the next place's first night).
 * @property {Item} stay First stay in the next place.
 */

/**
 * Moves the picked route needs but doesn't have. Stays in the same place
 * need none (walking or local transit); a stay whose place is only a guess
 * is skipped rather than flagged.
 * @param {PlanDoc} doc
 * @param {Layout} at
 * @param {boolean} optional
 * @returns {Missing[]}
 */
export function missingMoves(doc, at, optional) {
  const { stops } = stopsOf(doc, at, optional);
  /** @type {Missing[]} */
  const out = [];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    if (a.name === b.name || !a.sure || !b.sure || a.hops.length) continue;
    out.push({ from: a.name, to: b.name, day: Math.floor(b.start), stay: b.stays[0].item });
  }
  return out;
}

/**
 * Where a new transport for a missing move goes: inside the nearest item
 * holding the arriving stay (never directly in an either/or group, where it
 * would become an option), or at the top level.
 * @param {PlanDoc} doc
 * @param {Item} stay
 * @returns {string | undefined} Parent id.
 */
export function moveParent(doc, stay) {
  return ancestors(doc, stay).find((a) => a.kind === 'item')?.id;
}

/**
 * Something that happens after a fixed window (a visa) has closed, in a
 * place the window covers.
 * @typedef {object} PastWindow
 * @property {Item} window The window.
 * @property {Item} item The stay or move that's too late.
 * @property {number} day Day it happens (a stay's last morning, a move's day).
 * @property {string} text e.g. "KHH → SGN on Tue, Jan 19 is after Vietnam e-visa ends Sun, Jan 17".
 * @property {string} [trip] The fork option it's in, when that trip isn't the pick.
 */

/**
 * Items a window speaks for: everything under the window's parent, without
 * going into either/or groups (those choose somewhere else to go).
 * @param {PlanDoc} doc
 * @param {Item} w
 * @returns {Set<string>}
 */
function homeOf(doc, w) {
  const out = new Set(), todo = kidsOf(doc, w.parent);
  for (let k = todo.shift(); k; k = todo.shift()) {
    if (k.kind === 'group' || out.has(k.id)) continue;
    out.add(k.id);
    todo.push(...kidsOf(doc, k.id));
  }
  return out;
}

/**
 * Stays and moves that fall after a window ends, in places the window
 * covers: the places of the stays beside it (see {@link homeOf}) that begin
 * inside it. A stay is too late
 * when you'd still be there the morning after the window's last day; a move
 * is too late when it arrives in a covered place after that day. Checks the
 * picked route and, for the plan's fork, every other trip as if picked.
 * @param {PlanDoc} doc
 * @param {boolean} optional
 * @returns {PastWindow[]}
 */
export function pastWindows(doc, optional) {
  const fork = forkOf(doc), alts = fork ? kidsOf(doc, fork.id).slice(1) : [];
  /** @type {PastWindow[]} */
  const out = [];
  for (const [d, trip] of /** @type {[PlanDoc, string | undefined][]} */ ([[doc, undefined], ...alts.map((k) => [withPick(doc, k.id), k.name])])) {
    const at = layout(d), { stops } = stopsOf(d, at, optional);
    for (const w of d.items.filter((it) => it.kind === 'window')) {
      const p = /** @type {Placed} */ (at.get(w.id)), last = Math.ceil(p.end) - 1;
      const home = homeOf(d, w);
      const covered = new Set(stops.filter((s) => s.sure && s.start >= p.start && s.start <= last && s.stays.some((q) => home.has(q.item.id))).map((s) => s.name));
      if (!covered.size) continue;
      const ends = `${w.name} ends ${fmt(last, { weekday: 'short' })}`;
      for (const s of stops) {
        if (!covered.has(s.name) || Math.floor(s.end) <= last) continue;
        const item = /** @type {Placed} */ (s.stays.at(-1)).item;
        out.push({ window: w, item, day: Math.floor(s.end), text: `${s.name} until ${fmt(s.end, { weekday: 'short' })} is after ${ends}`, trip });
      }
      for (const h of hops(d, at, optional)) {
        const to = cityIn(h.to ?? h.label.split(/→|->/).pop() ?? '');
        if (!to || !covered.has(to.name) || Math.floor(h.at) <= last) continue;
        out.push({ window: w, item: h.item, day: Math.floor(h.at), text: `${h.label} on ${fmt(h.at, { weekday: 'short' })} is after ${ends}`, trip });
      }
    }
  }
  return out;
}
