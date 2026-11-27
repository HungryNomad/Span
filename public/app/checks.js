// @ts-check
/**
 * Plan-wide checks every view shares, so they all count the same: where
 * each person sleeps each night (the "Beds" line), the nights nobody has
 * booked, nights booked twice, and items with no price yet. Pure, so it
 * runs under `node --test`.
 *
 * @module
 */
import { ancestors, byId, counted, isPicked, kidsOf, typeOf } from './model.js';

/** @typedef {import('./model.js').PlanDoc} PlanDoc */
/** @typedef {import('./model.js').Item} Item */
/** @typedef {import('./model.js').Layout} Layout */

/**
 * Nights a..b (b exclusive) where the same stays are booked.
 * @typedef {object} BedRun
 * @property {number} a First night (day index).
 * @property {number} b Morning after the last night.
 * @property {string[]} ids Booked stays covering these nights (none: a gap; two or more: double-booked).
 * @property {string[]} maybe Unbooked (optional) stays covering them, such as a "not booked" placeholder.
 * @property {string} [where] On a person's own line: what they're doing apart from the others then ("Tokyo").
 */

/**
 * One person's nights, or everyone's when the plan names nobody.
 * @typedef {object} BedLine
 * @property {string | null} who
 * @property {BedRun[]} runs
 */

/**
 * The whole plan's nights.
 * @typedef {object} Beds
 * @property {number} a First night of the plan.
 * @property {number} b Morning after its last night.
 * @property {BedLine[]} lines One per person (one shared line when nobody is named).
 * @property {boolean} split Whether the people are ever apart (separate stays, or a part of the plan for one of them).
 */

/**
 * A run of nights with a problem, across everyone.
 * @typedef {object} Issue
 * @property {number} a
 * @property {number} b
 * @property {string[]} who People it applies to (empty: everyone).
 * @property {string[]} ids For a double booking, the stays booked twice; for a gap, the unbooked stays covering it.
 */

/** A leading "Name: " on an item, as in "Kaylee: Tokyo". */
const LEAD = /^(\p{Lu}[\p{Ll}'-]+):\s/u;

/**
 * People named by the plan's structure: siblings whose names lead with two
 * or more different first names ("Kaylee: Tokyo" beside "Loren: Berlin").
 * A lone "Trip: …" lead is a label, not a person.
 * @param {PlanDoc} doc
 * @returns {Map<string, string>} Person by item id.
 */
function namedLeads(doc) {
  const out = new Map(), parents = new Set(doc.items.map((it) => it.parent));
  for (const parent of parents) {
    const leads = kidsOf(doc, parent).map((k) => [k.id, LEAD.exec(k.name)?.[1]]).filter((e) => e[1]);
    if (new Set(leads.map((e) => e[1])).size < 2) continue;
    for (const [id, who] of leads) out.set(/** @type {string} */ (id), /** @type {string} */ (who));
  }
  return out;
}

/**
 * Who an item is for: its own `who`, else its nearest ancestor's, else a
 * person its name or an ancestor's leads with (see {@link namedLeads}).
 * @param {PlanDoc} doc
 * @param {Item} it
 * @param {Map<string, string>} [leads] From {@link namedLeads}, to save working it out again.
 * @returns {string | undefined} Undefined means everyone.
 */
export function whoOf(doc, it, leads = namedLeads(doc)) {
  for (const a of [it, ...ancestors(doc, it)]) {
    if (a.who) return a.who;
    const lead = leads.get(a.id);
    if (lead) return lead;
  }
  return undefined;
}

/**
 * Everyone the plan names, in the order they first appear.
 * @param {PlanDoc} doc
 * @returns {string[]}
 */
export function peopleOf(doc) {
  const leads = namedLeads(doc), out = new Set();
  for (const it of doc.items) { const w = it.who ?? leads.get(it.id); if (w) out.add(w); }
  return [...out];
}

/**
 * Nights the plan spans: from the first night of its top-level parts to
 * the last, counting only parts measured in nights.
 * @param {PlanDoc} doc
 * @param {Layout} at
 * @returns {[number, number] | null} First night and the morning after the last, or null with no nights.
 */
export function nightRange(doc, at) {
  let a = Infinity, b = -Infinity;
  for (const it of doc.items) {
    if (it.kind === 'window' || it.unit !== 'night' || typeOf(it) === 'event' || typeOf(it) === 'transport') continue;
    if (!isPicked(doc, it)) continue;
    const p = at.get(it.id);
    if (!p) continue;
    a = Math.min(a, Math.floor(p.start));
    b = Math.max(b, Math.floor(p.end));
  }
  return b > a ? [a, Math.min(b, a + 3000)] : null;
}

/**
 * Where each person sleeps each night of the plan. A stay counts when it's
 * picked (or in no either/or group) and booked (committed, or any stay when
 * `optional` is set); unbooked picked stays are kept as `maybe`, so a gap
 * can name its placeholder. A stay holding other stays defers to them.
 * @param {PlanDoc} doc
 * @param {Layout} at
 * @param {boolean} optional
 * @returns {Beds | null} Null when the plan has no nights.
 */
export function beds(doc, at, optional) {
  const range = nightRange(doc, at);
  if (!range) return null;
  const [a, b] = range, leads = namedLeads(doc);
  const isStay = (/** @type {Item} */ it) => it.kind === 'item' && it.unit === 'night' && typeOf(it) === 'stay';
  const stays = doc.items.filter((it) => isStay(it) && isPicked(doc, it) && !kidsOf(doc, it.id).some(isStay))
    .map((it) => ({ it, p: /** @type {import('./model.js').Placed} */ (at.get(it.id)), who: whoOf(doc, it, leads), booked: it.committed || optional }));
  const people = peopleOf(doc), whos = people.length ? people : [null];
  // Parts of the plan for one person only (a week in Tokyo), to say where they are.
  const own = doc.items.filter((it) => it.kind === 'item' && it.unit !== 'hour' && typeOf(it) !== 'stay' && typeOf(it) !== 'transport' && isPicked(doc, it))
    .map((it) => ({ it, p: /** @type {import('./model.js').Placed} */ (at.get(it.id)), who: whoOf(doc, it, leads) })).filter((o) => o.who);
  const lines = whos.map((who) => {
    const mine = stays.filter((s) => !s.who || s.who === who);
    const apart = own.filter((o) => o.who === who);
    /** @type {BedRun[]} */
    const runs = [];
    for (let d = a; d < b; d++) {
      const on = mine.filter((s) => s.p.start <= d && d < s.p.end);
      const ids = on.filter((s) => s.booked).map((s) => s.it.id), maybe = on.filter((s) => !s.booked).map((s) => s.it.id);
      const away = apart.find((o) => o.p.start <= d && d < o.p.end), where = away ? away.it.name.replace(LEAD, '') : undefined;
      const last = runs.at(-1);
      if (last && last.b === d && last.ids.join() === ids.join() && last.maybe.join() === maybe.join() && last.where === where) last.b = d + 1;
      else runs.push({ a: d, b: d + 1, ids, maybe, ...(where && { where }) });
    }
    return { who, runs };
  });
  const key = (/** @type {BedLine} */ l) => l.runs.map((r) => `${r.a}:${r.b}:${r.ids}:${r.where ?? ''}`).join('|');
  return { a, b, lines, split: lines.some((l) => key(l) !== key(lines[0])) };
}

/**
 * Merges per-night flags into runs across everyone.
 * @param {Beds} bd
 * @param {(r: BedRun) => boolean} bad Whether a person's night has the problem.
 * @param {(r: BedRun) => string[]} ids What to list for it.
 * @returns {Issue[]}
 */
function runsOf(bd, bad, ids) {
  /** @type {Issue[]} */
  const out = [];
  for (let d = bd.a; d < bd.b; d++) {
    const hit = bd.lines.map((l) => ({ l, r: l.runs.find((r) => r.a <= d && d < r.b) })).filter((e) => e.r && bad(e.r));
    if (!hit.length) continue;
    const who = hit.length === bd.lines.length ? [] : hit.map((e) => /** @type {string} */ (e.l.who));
    const list = [...new Set(hit.flatMap((e) => ids(/** @type {BedRun} */ (e.r))))];
    const last = out.at(-1);
    if (last && last.b === d && last.who.join() === who.join() && last.ids.join() === list.join()) last.b = d + 1;
    else out.push({ a: d, b: d + 1, who, ids: list });
  }
  return out;
}

/**
 * Runs of nights someone has nowhere booked to sleep.
 * @param {Beds | null} bd
 * @returns {Issue[]}
 */
export const gapRuns = (bd) => (bd ? runsOf(bd, (r) => !r.ids.length, (r) => r.maybe) : []);

/**
 * Runs of nights someone has two or more stays booked.
 * @param {Beds | null} bd
 * @returns {Issue[]}
 */
export const doubleRuns = (bd) => (bd ? runsOf(bd, (r) => r.ids.length > 1, (r) => r.ids) : []);

/**
 * Nights in a list of runs.
 * @param {Issue[]} runs
 * @returns {number}
 */
export const nightsIn = (runs) => runs.reduce((n, r) => n + r.b - r.a, 0);

/**
 * Whether an item should have a price and has none: a stay or transport
 * with no cost lines (an event can be free).
 * @param {Item} it
 * @returns {boolean}
 */
export const isUnpriced = (it) => it.kind === 'item' && (typeOf(it) === 'stay' || typeOf(it) === 'transport') && !it.costs.length;

/**
 * Items counted toward a total (within `root`, or the whole plan) that
 * have no price yet, so a total can say it's missing them.
 * @param {PlanDoc} doc
 * @param {boolean} optional
 * @param {string} [root]
 * @returns {Item[]}
 */
export function unpricedIn(doc, optional, root) {
  return [...counted(doc, optional, root)].map((id) => /** @type {Item} */ (byId(doc, id)))
    .filter((it) => isUnpriced(it) && !kidsOf(doc, it.id).length);
}
