// @ts-check
/**
 * Where a plan's stays are: a small built-in table of cities (with airport
 * codes and other names) and helpers that name the place an item is in and
 * lay a plan out as stops along its picked route. Pure, so it runs under
 * `node --test`.
 *
 * @module
 */
import { ancestors, byId, counted, fmt, isMoment, isPicked, kidsOf, layout, subtree, typeOf } from './model.js';
import { forkOf, hops, sleeps, withPick } from './trip.js';
import { nightRange, peopleOf, whoOf } from './checks.js';

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
  ['Mui Ne', 10.93, 108.29, 'Muine,Phan Thiet'], ['Vung Tau', 10.35, 107.08, ''], ['Can Tho', 10.03, 105.79, 'VCA'],
  ['Quy Nhon', 13.78, 109.22, 'UIH'], ['Ninh Binh', 20.25, 105.97, 'Tam Coc,Trang An'], ['Ha Giang', 22.82, 104.98, ''],
  ['Hai Phong', 20.86, 106.68, 'HPH'], ['Cat Ba', 20.73, 107.05, ''], ['Phong Nha', 17.59, 106.28, ''],
  ['Con Dao', 8.68, 106.61, 'VCS'], ['Pattaya', 12.93, 100.88, 'UTP'], ['Kanchanaburi', 14.02, 99.53, ''],
  ['Sukhothai', 17.01, 99.82, 'THS'], ['Udon Thani', 17.41, 102.79, 'UTH'], ['Hat Yai', 7.01, 100.47, 'HDY'],
  ['Khao Lak', 8.64, 98.25, ''], ['Koh Lanta', 7.62, 99.04, 'Lanta'], ['Koh Phi Phi', 7.74, 98.77, 'Phi Phi'],
  ['Koh Chang', 12.06, 102.33, ''], ['Battambang', 13.1, 103.2, ''], ['Sihanoukville', 10.63, 103.5, 'KOS'],
  ['Kep', 10.48, 104.32, ''], ['Koh Rong', 10.7, 103.24, ''], ['Vang Vieng', 18.92, 102.45, ''],
  ['Pakse', 15.12, 105.78, 'PKZ'], ['Yangon', 16.84, 96.17, 'RGN'], ['Mandalay', 21.97, 96.08, 'MDL'],
  ['Bagan', 21.17, 94.86, 'NYU'], ['Kuching', 1.55, 110.34, 'KCH'], ['Kota Kinabalu', 5.98, 116.07, 'BKI'],
  ['Langkawi', 6.35, 99.8, 'LGK'], ['Malacca', 2.19, 102.25, 'Melaka'], ['Ipoh', 4.6, 101.08, 'IPH'],
  ['Cameron Highlands', 4.47, 101.38, ''], ['Johor Bahru', 1.49, 103.74, 'JHB'], ['Bandar Seri Begawan', 4.89, 114.94, 'BWN,Brunei'],
  ['Yogyakarta', -7.8, 110.36, 'YIA,JOG,Jogja'], ['Surabaya', -7.25, 112.75, 'SUB'], ['Medan', 3.6, 98.67, 'KNO'],
  ['Lombok', -8.65, 116.32, 'LOP'], ['Gili Islands', -8.35, 116.04, 'Gili,Gili Trawangan'], ['Nusa Penida', -8.73, 115.54, ''],
  ['Labuan Bajo', -8.5, 119.89, 'LBJ,Komodo'], ['Boracay', 11.97, 121.92, 'MPH,Caticlan'], ['El Nido', 11.2, 119.4, 'ENI'],
  ['Puerto Princesa', 9.74, 118.74, 'PPS,Palawan'], ['Coron', 12.0, 120.2, 'USU,Busuanga'], ['Siargao', 9.85, 126.05, 'IAO,General Luna'],
  ['Bohol', 9.65, 123.85, 'TAG,Panglao,Tagbilaran'], ['Dumaguete', 9.31, 123.31, 'DGT'], ['Iloilo', 10.72, 122.56, 'ILO'],
  ['Davao', 7.07, 125.61, 'DVO'], ['Baguio', 16.41, 120.6, ''], ['Guangzhou', 23.13, 113.26, 'CAN'],
  ['Shenzhen', 22.54, 114.06, 'SZX'], ['Chengdu', 30.57, 104.07, 'CTU'], ['Jeju', 33.5, 126.53, 'CJU'],
  ['Nagoya', 35.18, 136.91, 'NGO'], ['Hiroshima', 34.39, 132.46, 'HIJ'], ['Nara', 34.68, 135.8, ''],
  ['Maldives', 4.18, 73.51, 'MLE'], ['Doha', 25.29, 51.53, 'DOH'], ['Abu Dhabi', 24.45, 54.38, 'AUH'],
  ['Perth', -31.95, 115.86, 'PER'], ['Darwin', -12.46, 130.84, 'DRW'], ['Brisbane', -27.47, 153.03, 'BNE'],
  ['Honolulu', 21.31, -157.86, 'HNL'], ['Ontario, CA', 34.06, -117.65, 'ONT,Ontario CA,Ontario California'],
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
 * A run of nights in one place on the map, for everyone or for one person
 * while the others are elsewhere. A stop with no name is nights with no bed
 * booked and no known place.
 * @typedef {object} MapStop
 * @property {string} name Place name, or '' when the place isn't known.
 * @property {City} [city]
 * @property {string | null} who The person, while people are apart; null for everyone.
 * @property {number} start First night, as a day index.
 * @property {number} end Morning you leave.
 * @property {{p: Placed, booked: boolean}[]} items What covers the nights (stays, or a place or part of the plan with no stay), in order.
 * @property {number} open Nights with no booked stay.
 */

/**
 * A point a route line passes: a stop's city, or where a move leaves from or lands.
 * @typedef {object} MapPoint
 * @property {City} city
 * @property {number} at When you get there, as a fractional day index.
 * @property {boolean} open Whether getting there, or staying there, isn't booked.
 * @property {Hop} [hop] The move leaving from or landing here, when the point isn't a stop.
 */

/**
 * A plan laid out for the map.
 * @typedef {object} MapRoute
 * @property {number} a First night.
 * @property {number} b Morning after the last night.
 * @property {number} last Last day to show: the day of the last move (the flight home) or the last night.
 * @property {MapStop[]} stops In order of first night.
 * @property {{who: string | null, points: MapPoint[]}[]} lines Each person's route (one line, who null, when nobody is named).
 */

/**
 * The whole plan as map stops, from its first night to the last move,
 * per person. Each night goes to the best of what covers it: a person's
 * own stay over everyone's, booked (committed) over not, a known place,
 * then a stay over a place with none. A part of the plan for one person in
 * another place ("Sam: Tokyo") moves them there, and names their nights
 * when only an unbooked stay or a place covers them. Unbooked placeholder
 * stays are stops too, with their nights counted as open.
 * @param {PlanDoc} doc
 * @param {Layout} at
 * @returns {MapRoute | null} Null when the plan has no nights.
 */
export function mapRoute(doc, at) {
  const range = nightRange(doc, at);
  if (!range) return null;
  const [a, b] = range, people = peopleOf(doc), whos = people.length ? people : [null];
  const booked = counted(doc, false);
  /** What a night might be spent in, with its rank. */
  const cand = (/** @type {Placed} */ p) => {
    const who = whoOf(doc, p.item) ?? null, pl = placeOf(doc, p.item);
    // A place holding nothing is somewhere to sleep too, as on the Beds line.
    const stay = typeOf(p.item) === 'stay' || (typeOf(p.item) === 'place' && !kidsOf(doc, p.item.id).length);
    const ok = stay && booked.has(p.item.id), known = !!pl.city || pl.sure;
    return { p, who, pl, ok, known, rank: (who ? 8 : 0) + (ok ? 4 : 0) + (known ? 2 : 0) + (stay ? 1 : 0) };
  };
  const beds = sleeps(doc, at, true).map(cand);
  const own = doc.items.filter((it) => it.kind === 'item' && it.unit !== 'hour' && typeOf(it) !== 'stay' && typeOf(it) !== 'transport' && isPicked(doc, it))
    .map((it) => cand(/** @type {Placed} */ (at.get(it.id)))).filter((c) => c.who && c.known);
  /** Latest-starting first, so a new check-in wins over the one you're leaving. */
  const covering = (/** @type {ReturnType<typeof cand>[]} */ list, /** @type {number} */ d) =>
    list.filter((c) => c.p.start <= d && d < c.p.end).sort((x, y) => y.p.start - x.p.start);
  /** Where one person spends night `d`. */
  const night = (/** @type {string | null} */ w, /** @type {number} */ d) => {
    const mine = covering(beds, d).filter((c) => !c.who || c.who === w);
    let best = mine.sort((x, y) => y.rank - x.rank)[0];
    const away = covering(own, d).find((c) => c.who === w);
    if (away && (!best || (!best.who && (!best.ok || best.pl.name !== away.pl.name)))) best = away;
    if (!best) return { name: '' };
    const pick = { p: best.p, booked: best.ok };
    return best.known ? { name: best.pl.name, city: best.pl.city, pick } : { name: '', pick };
  };

  /** @type {MapStop[]} */
  const stops = [];
  /** @type {Map<string | null, MapStop>} */
  const current = new Map();
  for (let d = a; d < b; d++) {
    const ns = whos.map((w) => night(w, d));
    const apart = ns.some((n) => n.name !== ns[0].name);
    const runs = /** @type {[string | null, typeof ns][]} */ (apart ? whos.map((w, i) => [w, [ns[i]]]) : [[null, ns]]);
    for (const [w, here] of runs) {
      let s = current.get(w);
      if (!s || s.end !== d || s.name !== here[0].name) {
        s = { name: here[0].name, city: here[0].city, who: w, start: d, end: d, items: [], open: 0 };
        stops.push(s);
        current.set(w, s);
      }
      s.end = d + 1;
      for (const n of here) if (n.pick && !s.items.some((q) => q.p === n.pick?.p)) s.items.push(n.pick);
      if (!here.every((n) => n.pick?.booked)) s.open++;
    }
  }

  const moves = hops(doc, at, true);
  const lines = whos.map((w) => {
    /** @type {MapPoint[]} */
    const seen = stops.filter((s) => s.city && (s.who === null || s.who === w))
      .map((s) => ({ city: /** @type {City} */ (s.city), at: s.start + 0.999, open: s.open === s.end - s.start }));
    for (const h of moves) {
      const who = whoOf(doc, h.item);
      if (w !== null && who && who !== w) continue;
      const from = h.from ? cityIn(h.from) : undefined, to = h.to ? cityIn(h.to) : undefined;
      if (from) seen.push({ city: from, at: h.at, open: false, hop: h });
      if (to) seen.push({ city: to, at: h.at + h.hours / 24, open: !booked.has(h.item.id), hop: h });
    }
    /** @type {MapPoint[]} */
    const points = [];
    for (const p of seen.sort((x, y) => x.at - y.at)) {
      const last = points.at(-1);
      if (last?.city === p.city) last.open ||= p.open;
      else points.push(p);
    }
    return { who: w, points };
  });
  const ends = lines.map((l) => l.points.at(-1)?.hop?.at ?? -Infinity);
  return { a, b, last: Math.max(b - 1, ...ends.map(Math.floor)), stops, lines };
}

/**
 * Where one person is on a day of a map route: the stop they sleep in,
 * else (after the last night) where the last move takes them, else the
 * last place they reached.
 * @param {MapRoute} r
 * @param {string | null} who
 * @param {number} day
 * @returns {{stop?: MapStop, city?: City, hop?: Hop}}
 */
export function mapDay(r, who, day) {
  const stop = r.stops.find((s) => (s.who === null || s.who === who) && s.start <= day && day < s.end);
  const pts = r.lines.find((l) => l.who === who)?.points ?? [], end = pts.at(-1);
  if (!stop && end?.hop && day >= r.b - 1 && day >= Math.floor(end.hop.at)) return { city: end.city, hop: end.hop };
  return { stop, city: stop?.city ?? [...pts].reverse().find((p) => p.at < day + 1)?.city };
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
  // Moves already planned but not booked (optional placeholders) aren't missing: they show as unbooked.
  const planned = doc.items.filter((it) => it.kind === 'item' && typeOf(it) === 'transport' && isPicked(doc, it))
    .map((it) => Math.floor(/** @type {Placed} */ (at.get(it.id)).start));
  /** @type {Missing[]} */
  const out = [];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    if (a.name === b.name || !a.sure || !b.sure || a.hops.length) continue;
    if (planned.some((d) => d >= Math.floor(a.end) - 1 && d <= Math.floor(b.start))) continue;
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
 * @property {string} where The place it happens in, e.g. "Saigon".
 * @property {number} last The window's last day.
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
        out.push({ window: w, item, day: Math.floor(s.end), where: s.name, last, text: `${s.name} until ${fmt(s.end, { weekday: 'short' })} is after ${ends}`, trip });
      }
      for (const h of hops(d, at, optional)) {
        const to = cityIn(h.to ?? h.label.split(/→|->/).pop() ?? '');
        if (!to || !covered.has(to.name) || Math.floor(h.at) <= last) continue;
        out.push({ window: w, item: h.item, day: Math.floor(h.at), where: to.name, last, text: `${h.label} on ${fmt(h.at, { weekday: 'short' })} is after ${ends}`, trip });
      }
    }
  }
  return out;
}
