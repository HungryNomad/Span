// @ts-check
/**
 * Where a plan's stays are: a small built-in table of cities (with airport
 * codes and other names) and helpers that name the place an item is in and
 * lay a plan out as stops along its picked route. Pure, so it runs under
 * `node --test`.
 *
 * @module
 */
import { ancestors, byId, kidsOf } from './model.js';
import { hops, sleeps } from './trip.js';

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
 * city, or else the nearest ancestor that isn't an either/or group.
 * @param {PlanDoc} doc
 * @param {Item} it
 * @returns {{name: string, city?: City}}
 */
export function placeOf(doc, it) {
  const chain = [it, ...ancestors(doc, it)];
  for (const a of chain) { const city = cityIn(a.name); if (city) return { name: city.name, city }; }
  const parent = byId(doc, it.parent);
  const named = chain.slice(1).find((a) => a.kind !== 'group') ?? parent;
  return { name: (named ?? it).name };
}

/**
 * A run of nights in one place.
 * @typedef {object} Stop
 * @property {string} name Place name.
 * @property {City} [city]
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
    } else stops.push({ name: pl.name, city: pl.city, start: p.start, end: p.end, stays: [p], hops: [] });
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
  const hourly = (/** @type {Item} */ it) => it.unit === 'hour' || (it.kind === 'group' && kidsOf(doc, it.id)[0]?.unit === 'hour');
  return kidsOf(doc, id).filter((k) => k.kind !== 'window' && !hourly(k)).map((k) => k.name);
}
