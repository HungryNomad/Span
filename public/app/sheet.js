// @ts-check
/**
 * The detail sheet: what a tapped bar or fare costs, plus the forms to add,
 * edit and delete bars and to enter fares.
 *
 * @module
 */
import {
  COLORS, clamp, dateOf, dayOf, descendants, fareOn, fmt, hhmm, isoOf, isRanged, layout, money, nowIdx, parseHhmm,
  pruneRoutes, removeBar, routeKey, routeLabel, stayCost, uid,
} from './model.js';
import { $, esc, heat } from './ui.js';

/** @typedef {import('./ui.js').App} App */
/** @typedef {import('./model.js').PlanDoc} PlanDoc */
/** @typedef {import('./model.js').Bar} Bar */
/** @typedef {import('./model.js').StayBar} StayBar */
/** @typedef {import('./model.js').Route} Route */

/**
 * What the sheet shows.
 * @typedef {object} SheetView
 * @property {string} k Small caption.
 * @property {string} t Title (plain text).
 * @property {string} c CSS color for the top border.
 * @property {string} body HTML.
 */

/**
 * Definition-list rows.
 * @param {[string, string][]} rows Label and (escaped) value pairs; a label of "Total" is bold.
 * @returns {string} HTML.
 */
const dl = (rows) =>
  `<dl>${rows.map(([k, v]) => `<div${k === 'Total' ? ' class="total"' : ''}><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;

/**
 * A labelled form input.
 * @param {string} label
 * @param {string} name
 * @param {string | number | undefined} value
 * @param {string} [attrs] Extra attributes (type, min, required…).
 * @param {string} [cls] Class on the label (`full`, `only-stay`…).
 * @returns {string} HTML.
 */
const input = (label, name, value, attrs = 'type="text"', cls = '') =>
  `<label class="${cls}">${esc(label)}<input name="${name}" value="${esc(value ?? '')}" ${attrs}></label>`;

/**
 * A labelled select.
 * @param {string} label
 * @param {string} name
 * @param {[string, string][]} options Value and label pairs.
 * @param {string} value Selected value.
 * @param {string} [cls] Class on the label.
 * @returns {string} HTML.
 */
const select = (label, name, options, value, cls = '') =>
  `<label class="${cls}">${esc(label)}<select name="${name}">${options.map(([v, t]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;

/**
 * The stay a route leaves from, when the route is used right after a stay.
 * Picking a fare day for that route means changing this stay's length.
 * @param {PlanDoc} doc
 * @param {string} key Route key.
 * @returns {StayBar | undefined}
 */
function origin(doc, key) {
  for (const b of doc.bars) {
    if (b.kind !== 'stay' || b.route !== key || !b.after) continue;
    const p = doc.bars.find((x) => x.id === b.after);
    if (p && p.kind === 'stay') return p;
  }
}

/**
 * Seven-day fare strip around a day. Each cell changes the origin stay's
 * length so you leave that day.
 * @param {PlanDoc} doc
 * @param {string} key Route key.
 * @param {number} center Day index.
 * @returns {string} HTML (empty if the route has no origin stay).
 */
function nearby(doc, key, center) {
  const r = doc.routes[key], from = origin(doc, key);
  if (!r || !from) return '';
  const fp = /** @type {import('./model.js').Placed} */ (layout(doc).get(from.id));
  const [mn, mx] = isRanged(from) ? [from.minNights, from.maxNights] : [1, Infinity];
  const days = [];
  for (let i = center - 3; i <= center + 3; i++) days.push(i);
  const vals = days.map((i) => fareOn(r, i)), lo = Math.min(...vals), hi = Math.max(...vals);
  const cells = days.map((i, j) => {
    const n = i - fp.start;
    if (n < mn || n > mx) return '<span></span>';
    const c = heat(vals[j], lo, hi), dt = dateOf(i);
    return `<button class="nb-c${c.cls}${i === fp.end ? ' on' : ''}" style="${c.style}" data-set="${esc(from.id)}:${n}" data-go="fare:${esc(key)}:${i}"><small>${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][dt.getUTCDay()]} ${dt.getUTCDate()}</small><b>${money(vals[j], doc.currency)}</b></button>`;
  }).join('');
  return `<div class="nb-h">${esc(routeLabel(r))} around ${fmt(center)} · tap to leave ${esc(from.name)} that day</div><div class="nb">${cells}</div>`;
}

/**
 * Detail view for a bar.
 * @param {App} app
 * @param {Bar} b
 * @returns {SheetView}
 */
function barView(app, b) {
  const { doc } = app, cur = doc.currency, p = /** @type {import('./model.js').Placed} */ (layout(doc).get(b.id));
  const actions = `<div class="sh-actions"><button class="btn" data-go="edit:${esc(b.id)}">Edit</button><span class="spacer"></span><button class="btn danger" data-delete="${esc(b.id)}">Delete</button></div>`;
  if (b.kind === 'window') {
    const left = Math.max(0, Math.ceil(p.end - nowIdx()));
    return {
      k: `Fixed · ${b.days} days`, t: b.name, c: 'var(--ink)',
      body: dl([['Dates', `${fmt(p.start)} – ${fmt(p.end - 1, { year: 'numeric' })}`], ['Leave by', fmt(p.end - 1, { weekday: 'short' })], ['Days left from today', String(Math.min(left, b.days))]]) +
        '<p class="sh-note">This bar never moves. Stays can stretch up to its last day.</p>' + actions,
    };
  }
  const s = stayCost(b), r = b.route ? doc.routes[b.route] : undefined, fare = r ? fareOn(r, p.start) : 0;
  const [mn, mx] = isRanged(b) ? [b.minNights, b.maxNights] : [1, Infinity];
  const rows = /** @type {[string, string][]} */ ([
    ['Dates', `${fmt(p.start)} – ${fmt(p.end)}`],
    ['Nights', `${b.nights}${isRanged(b) ? ` (${mn}–${mx})` : ''}`],
    ['Rooms', `${b.nights} × ${money(b.night, cur)} = ${money(s.rooms, cur)}`],
    ['Daily spend', `${b.nights} × ${money(b.daily, cur)} = ${money(s.spend, cur)}`],
  ]);
  if (r) rows.push([`Getting here ${routeLabel(r)}`, `${fmt(p.start, { weekday: 'short' })} · ${money(fare, cur)}`]);
  rows.push(['Total', money(s.total + fare, cur)]);
  return {
    k: isRanged(b) ? `Adjustable · ${mn}–${mx} nights` : b.after ? 'Option' : 'Stay',
    t: b.name, c: `var(--c-${b.color})`,
    body: dl(rows) +
      `<div class="steps"><button data-set="${esc(b.id)}:${b.nights - 1}" ${b.nights <= mn ? 'disabled' : ''}>One night shorter</button><button data-set="${esc(b.id)}:${b.nights + 1}" ${b.nights >= mx ? 'disabled' : ''}>One night longer</button></div>` +
      (b.route ? nearby(doc, b.route, p.start) : '') + actions,
  };
}

/**
 * Detail view for a route on a departure day, with a form to enter fares.
 * @param {App} app
 * @param {string} key Route key.
 * @param {number} day Departure day index.
 * @returns {SheetView | null}
 */
function fareView(app, key, day) {
  const { doc } = app, r = doc.routes[key], cur = doc.currency;
  if (!r) return null;
  const from = origin(doc, key);
  let cheapest = '';
  if (from && isRanged(from)) {
    const fp = /** @type {import('./model.js').Placed} */ (layout(doc).get(from.id));
    let best = fp.start + from.minNights;
    for (let i = best; i <= fp.start + from.maxNights; i++) if (fareOn(r, i) < fareOn(r, best)) best = i;
    cheapest = `${fmt(best)} · ${money(fareOn(r, best), cur)}`;
  }
  const own = r.fares[isoOf(day)];
  const rows = /** @type {[string, string][]} */ ([
    ['Date', fmt(day, { weekday: 'short', year: 'numeric' })],
    ['Time', `${hhmm(r.depart)} → ${hhmm(r.depart + r.hours)} (${Math.floor(r.hours)}h ${String(Math.round((r.hours % 1) * 60)).padStart(2, '0')}m)`],
    ['Fare', `${money(fareOn(r, day), cur)}${own === undefined ? ' (usual)' : ''}`],
  ]);
  if (cheapest) rows.push(['Cheapest in window', cheapest]);
  return {
    k: 'Travel · one way', t: routeLabel(r), c: 'var(--ink)',
    body: dl(rows) + nearby(doc, key, day) + `
<form class="form" data-form="fare" data-key="${esc(key)}" data-day="${day}">
  ${input(`Fare on ${fmt(day)}`, 'dayFare', own, `type="number" min="0" step="1" inputmode="decimal" placeholder="${r.fare}"`)}
  ${input('Usual fare', 'fare', r.fare, 'type="number" min="0" step="1" inputmode="decimal" required')}
  ${input('From', 'from', r.from, 'type="text" maxlength="8" required')}
  ${input('To', 'to', r.to, 'type="text" maxlength="8" required')}
  ${input('Departs', 'depart', hhmm(r.depart), 'type="time" required')}
  ${input('Duration (hours)', 'hours', r.hours, 'type="number" min="0" step="0.05" required')}
  <p class="sh-note full" style="grid-column:1/-1;margin:0">Leave "Fare on" empty to use the usual fare that day. Changes apply to every stay that uses ${esc(routeLabel(r))}.</p>
  <div class="sh-actions"><button class="btn primary" type="submit">Save fares</button></div>
</form>`,
  };
}

/**
 * Add/edit form for a bar.
 * @param {App} app
 * @param {Bar | null} b Bar to edit, or null to add one.
 * @returns {SheetView}
 */
function formView(app, b) {
  const { doc } = app, today = isoOf(nowIdx());
  const s = b?.kind === 'stay' ? b : null, w = b?.kind === 'window' ? b : null;
  const banned = b ? descendants(doc, b.id) : new Set();
  const after = doc.bars.filter((x) => !banned.has(x.id))
    .map((x) => /** @type {[string, string]} */ ([`after:${x.id}`, `After ${x.name}${x.lane !== x.name ? ` (${x.lane})` : ''}`]));
  const routes = Object.entries(doc.routes).map(([k, r]) => /** @type {[string, string]} */ ([k, routeLabel(r)]));
  const route = s?.route ? doc.routes[s.route] : undefined;
  const lanes = [...new Set(doc.bars.map((x) => x.lane))];
  const kind = b?.kind ?? 'stay';
  return {
    k: b ? 'Edit' : 'New bar', t: b ? b.name : 'Add a bar', c: s ? `var(--c-${s.color})` : 'var(--ink)',
    body: `
<form class="form" data-form="bar" data-id="${esc(b?.id ?? '')}" data-kind="${kind}">
  ${b ? '' : select('Type', 'kind', [['stay', 'Stay'], ['window', 'Fixed window (visa, lease…)']], kind, 'full')}
  ${input('Name', 'name', b?.name, 'type="text" maxlength="60" required placeholder="Bangkok"')}
  ${input('Row', 'lane', b?.lane, 'type="text" maxlength="40" list="lanes" placeholder="Same as name"')}
  <datalist id="lanes">${lanes.map((l) => `<option value="${esc(l)}">`).join('')}</datalist>
  ${select('Starts', 'starts', [['date', 'On a date'], ...after], s?.after ? `after:${s.after}` : 'date', 'full only-stay')}
  ${input('Start date', 'start', w?.start ?? s?.start ?? today, 'type="date"', 'only-date')}
  ${input('Days', 'days', w?.days ?? 90, 'type="number" min="1" step="1"', 'only-window')}
  ${input('Nights', 'nights', s?.nights ?? 7, 'type="number" min="1" step="1"', 'only-stay')}
  ${input('Fewest nights (optional)', 'minNights', s?.minNights, 'type="number" min="1" step="1"', 'only-stay')}
  ${input('Most nights (optional)', 'maxNights', s?.maxNights, 'type="number" min="1" step="1"', 'only-stay')}
  ${input('Room per night', 'night', s?.night ?? 40, 'type="number" min="0" step="1" inputmode="decimal"', 'only-stay')}
  ${input('Spend per day', 'daily', s?.daily ?? 25, 'type="number" min="0" step="1" inputmode="decimal"', 'only-stay')}
  ${select('Color', 'color', COLORS.map((c) => [c, c[0].toUpperCase() + c.slice(1)]), s?.color ?? 'teal', 'only-stay')}
  ${select('Getting here', 'route', [['', 'No flight'], ...routes, ['new', 'New flight…']], s?.route ?? '', 'only-stay')}
  <fieldset class="only-route"><legend>Flight (shared by every stay that uses it)</legend>
    ${input('From', 'from', route?.from, 'type="text" maxlength="8" placeholder="SGN"')}
    ${input('To', 'to', route?.to, 'type="text" maxlength="8" placeholder="BKK"')}
    ${input('Departs', 'depart', route ? hhmm(route.depart) : '10:00', 'type="time"')}
    ${input('Duration (hours)', 'hours', route?.hours ?? 2, 'type="number" min="0" step="0.05"')}
    ${input('Usual fare', 'fare', route?.fare ?? 100, 'type="number" min="0" step="1" inputmode="decimal"')}
  </fieldset>
  <p class="err" hidden></p>
  <div class="sh-actions"><button class="btn primary" type="submit">${b ? 'Save' : 'Add'}</button><button class="btn" type="button" data-go="${b ? `bar:${esc(b.id)}` : ''}">Cancel</button></div>
</form>`,
  };
}

/**
 * Shows or hides form fields to match the current choices.
 * @param {HTMLFormElement} f
 */
function syncForm(f) {
  const kind = /** @type {HTMLSelectElement | null} */ (f.elements.namedItem('kind'))?.value ?? f.dataset.kind;
  const starts = /** @type {HTMLSelectElement} */ (f.elements.namedItem('starts')).value;
  const route = /** @type {HTMLSelectElement} */ (f.elements.namedItem('route')).value;
  const show = (/** @type {string} */ sel, /** @type {boolean} */ on) => f.querySelectorAll(sel).forEach((el) => { /** @type {HTMLElement} */ (el).hidden = !on; });
  show('.only-stay', kind === 'stay');
  show('.only-window', kind === 'window');
  show('.only-date', kind === 'window' || starts === 'date');
  show('.only-route', kind === 'stay' && route !== '');
}

/**
 * Reads the bar form and applies it to the plan.
 * @param {App} app
 * @param {HTMLFormElement} f
 * @returns {string | null} An error message, or null when saved.
 */
function saveBar(app, f) {
  const v = Object.fromEntries(new FormData(f));
  const str = (/** @type {string} */ k) => String(v[k] ?? '').trim();
  const int = (/** @type {string} */ k) => (str(k) === '' ? NaN : Math.round(+str(k)));
  const kind = str('kind') || f.dataset.kind, id = f.dataset.id || uid(), name = str('name');
  if (!name) return 'Give it a name.';
  const lane = str('lane') || name;
  /** @type {Bar} */
  let bar;
  /** @type {[string, Route] | null} */
  let flight = null;
  if (kind === 'window') {
    if (Number.isNaN(dayOf(str('start')))) return 'Pick a start date.';
    if (!(int('days') >= 1)) return 'Days must be 1 or more.';
    bar = { id, kind: 'window', name, lane, start: str('start'), days: int('days') };
  } else {
    const nights = int('nights'), mn = int('minNights'), mx = int('maxNights');
    if (!(nights >= 1)) return 'Nights must be 1 or more.';
    if (Number.isNaN(mn) !== Number.isNaN(mx)) return 'Set both fewest and most nights, or neither.';
    if (!Number.isNaN(mn) && !(mn >= 1 && mx > mn)) return 'Most nights must be more than fewest nights.';
    const night = +str('night') || 0, daily = +str('daily') || 0;
    /** @type {StayBar} */
    const s = { id, kind: 'stay', name, lane, nights, night: Math.max(0, night), daily: Math.max(0, daily), color: str('color') || 'gray' };
    if (!Number.isNaN(mn)) Object.assign(s, { minNights: mn, maxNights: mx, nights: clamp(nights, mn, mx) });
    const starts = str('starts');
    if (starts.startsWith('after:')) s.after = starts.slice(6);
    else if (Number.isNaN(dayOf(str('start')))) return 'Pick a start date.';
    else s.start = str('start');
    const rk = str('route');
    if (rk) {
      const from = str('from').toUpperCase(), to = str('to').toUpperCase(), depart = parseHhmm(str('depart'));
      if (!from || !to) return 'Give the flight a From and To.';
      if (Number.isNaN(depart)) return 'Departure time looks wrong.';
      const key = rk === 'new' ? routeKey(from, to) : rk, old = app.doc.routes[key];
      if (rk === 'new' && old) return `${routeLabel(old)} already exists; pick it under "Getting here".`;
      s.route = key;
      flight = [key, { from, to, depart, hours: Math.max(0, +str('hours') || 0), fare: Math.max(0, +str('fare') || 0), fares: old?.fares ?? {} }];
    }
    bar = s;
  }
  app.change((doc) => {
    if (flight) doc.routes[flight[0]] = flight[1];
    const i = doc.bars.findIndex((x) => x.id === id);
    if (i >= 0) doc.bars[i] = bar;
    else doc.bars.push(bar);
    pruneRoutes(doc);
  });
  app.select(`bar:${id}`);
  return null;
}

/**
 * Reads the fare form and applies it to the route.
 * @param {App} app
 * @param {HTMLFormElement} f
 * @returns {string | null} An error message, or null when saved.
 */
function saveFare(app, f) {
  const v = Object.fromEntries(new FormData(f)), key = /** @type {string} */ (f.dataset.key), day = +(f.dataset.day ?? 0);
  const str = (/** @type {string} */ k) => String(v[k] ?? '').trim();
  const depart = parseHhmm(str('depart'));
  if (Number.isNaN(depart)) return 'Departure time looks wrong.';
  if (!str('from') || !str('to')) return 'Give the flight a From and To.';
  app.change((doc) => {
    const r = doc.routes[key];
    Object.assign(r, { from: str('from').toUpperCase(), to: str('to').toUpperCase(), depart, hours: Math.max(0, +str('hours') || 0), fare: Math.max(0, +str('fare') || 0) });
    if (str('dayFare') === '') delete r.fares[isoOf(day)];
    else r.fares[isoOf(day)] = Math.max(0, +str('dayFare'));
  });
  return null;
}

export class Sheet {
  /**
   * Wires the sheet's buttons and forms (all delegated, since content is redrawn).
   * @param {HTMLElement} el The `<aside>` element.
   * @param {App} app
   */
  constructor(el, app) {
    this.el = el;
    this.app = app;
    /** Selection the sheet last drew, so open forms aren't redrawn under you. */
    this.shown = /** @type {string | null} */ (null);
    $('#sh-x', el).addEventListener('click', () => app.select(null));
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.hidden) app.select(null); });
    el.addEventListener('click', (e) => {
      const t = /** @type {HTMLElement} */ (e.target).closest('button');
      if (!t) return;
      if (t.dataset.set) {
        const [id, n] = t.dataset.set.split(/:(?=[^:]*$)/);
        app.setNights(id, +n);
      }
      if (t.dataset.go !== undefined) app.select(t.dataset.go || null);
      if (t.dataset.delete) {
        const b = app.doc.bars.find((x) => x.id === t.dataset.delete);
        if (b && confirm(`Delete "${b.name}"? Stays that follow it keep their dates.`)) {
          app.change((doc) => removeBar(doc, b.id));
          app.select(null);
        }
      }
    });
    el.addEventListener('change', (e) => {
      const f = /** @type {HTMLElement} */ (e.target).closest('form');
      if (f?.dataset.form !== 'bar') return;
      const t = /** @type {HTMLInputElement} */ (e.target);
      if (t.name === 'route' && t.value && t.value !== 'new') {
        const r = app.doc.routes[t.value];
        for (const [k, val] of Object.entries({ from: r.from, to: r.to, depart: hhmm(r.depart), hours: r.hours, fare: r.fare })) {
          /** @type {HTMLInputElement} */ (f.elements.namedItem(k)).value = String(val);
        }
      }
      syncForm(f);
    });
    el.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = /** @type {HTMLFormElement} */ (e.target);
      const err = f.dataset.form === 'fare' ? saveFare(app, f) : saveBar(app, f);
      const box = /** @type {HTMLElement | null} */ (f.querySelector('.err'));
      if (err && box) { box.textContent = err; box.hidden = false; } else if (err) alert(err);
    });
  }

  /**
   * Redraws the sheet for the current selection. Forms aren't redrawn while
   * open (that would wipe what you're typing) unless `force` is set.
   * @param {boolean} [force]
   */
  render(force = false) {
    const { doc, sel } = this.app;
    const key = sel ?? '';
    if (!force && this.shown === key && /^(add|edit:)/.test(key)) return;
    this.shown = key;
    /** @type {SheetView | null} */
    let v = null;
    if (sel === 'add') v = formView(this.app, null);
    else if (sel?.startsWith('edit:') || sel?.startsWith('bar:')) {
      const b = doc.bars.find((x) => x.id === sel.slice(sel.indexOf(':') + 1));
      if (b) v = sel.startsWith('edit:') ? formView(this.app, b) : barView(this.app, b);
    } else if (sel?.startsWith('fare:')) {
      const m = /^fare:(.+):(-?\d+)$/.exec(sel);
      if (m) v = fareView(this.app, m[1], +m[2]);
    }
    this.el.hidden = !v;
    if (!v) return;
    this.el.style.setProperty('--c', v.c);
    $('#sh-k', this.el).textContent = v.k;
    $('#sh-t', this.el).textContent = v.t;
    $('#sh-b', this.el).innerHTML = v.body;
    const f = /** @type {HTMLFormElement | null} */ (this.el.querySelector('form[data-form="bar"]'));
    if (f) syncForm(f);
  }
}
