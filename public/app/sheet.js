// @ts-check
/**
 * The detail sheet: what a tapped item or fare costs, what it holds, its
 * links and pictures, plus the forms to add, edit and delete items and to
 * enter fares.
 *
 * @module
 */
import * as api from './api.js';
import {
  anchorOf, ancestors, byId, COLORS, counted, coverage, dateOf, dayOf, fareOn, fmt, hhmm, inGroup, isLink, isoOf, isRanged, kidsOf,
  layout, lineCost, makeItem, MAX_IMAGES, MAX_LINKS, money, nowIdx, parseHhmm, pruneRoutes, removeItem, routeKey, routeLabel,
  setRank, siteOf, subtree, total, uid, unitText, unitsOf, UNIT_WORDS,
} from './model.js';
import { $, esc, heat } from './ui.js';

/** @typedef {import('./ui.js').App} App */
/** @typedef {import('./model.js').PlanDoc} PlanDoc */
/** @typedef {import('./model.js').Item} Item */
/** @typedef {import('./model.js').CostLine} CostLine */
/** @typedef {import('./model.js').Route} Route */
/** @typedef {import('./model.js').Placed} Placed */

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
 * @param {string} [cls] Class on the label (`full`, `only-item`…).
 * @returns {string} HTML.
 */
const input = (label, name, value, attrs = 'type="text"', cls = '') =>
  `<label class="${cls}"><span>${esc(label)}</span><input name="${name}" value="${esc(value ?? '')}" ${attrs}></label>`;

/**
 * Options for a select.
 * @param {[string, string][]} options Value and label pairs.
 * @param {string} value Selected value.
 * @returns {string} HTML.
 */
const options = (options, value) =>
  options.map(([v, t]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(t)}</option>`).join('');

/**
 * A labelled select.
 * @param {string} label
 * @param {string} name
 * @param {[string, string][]} opts Value and label pairs.
 * @param {string} value Selected value.
 * @param {string} [cls] Class on the label.
 * @returns {string} HTML.
 */
const select = (label, name, opts, value, cls = '') =>
  `<label class="${cls}"><span>${esc(label)}</span><select name="${name}">${options(opts, value)}</select></label>`;

/**
 * The item a route leaves from: the one whose end decides when you take it.
 * Picking a fare day for that route means changing this item's length.
 * @param {PlanDoc} doc
 * @param {string} key Route key.
 * @returns {Item | undefined}
 */
function origin(doc, key) {
  for (const it of doc.items) {
    if (!it.costs.some((c) => c.route === key)) continue;
    const a = anchorOf(doc, it);
    if (a?.kind === 'item' && a.len !== undefined) return a;
  }
}

/**
 * Seven-day fare strip around a day. Each cell changes the origin item's
 * length so you leave that day.
 * @param {PlanDoc} doc
 * @param {string} key Route key.
 * @param {number} center Day index.
 * @returns {string} HTML (empty if the route has no origin item).
 */
function nearby(doc, key, center) {
  const r = doc.routes[key], from = origin(doc, key);
  if (!r || !from || from.unit === 'hour') return '';
  const fp = /** @type {Placed} */ (layout(doc).get(from.id));
  const [mn, mx] = isRanged(from) ? [from.minLen, from.maxLen] : [1, Infinity];
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
 * Human dates for a placed item.
 * @param {Placed} p
 * @returns {string}
 */
function datesOf(p) {
  const u = p.item.unit;
  if (u === 'hour') return `${fmt(p.start, { weekday: 'short' })} ${hhmm((p.start % 1) * 24)} – ${hhmm((p.end % 1) * 24)}${Math.floor(p.end) > Math.floor(p.start) ? ` (${fmt(p.end)})` : ''}`;
  return `${fmt(p.start)} – ${fmt(u === 'night' ? p.end : p.end - 1)}`;
}

/**
 * One cost line explained, e.g. "10 × $46 = $460".
 * @param {PlanDoc} doc
 * @param {CostLine} line
 * @param {Placed} p
 * @returns {[string, string]} Label and escaped value.
 */
function costRow(doc, line, p) {
  const cur = doc.currency, sum = money(lineCost(doc, line, p), cur), who = line.pp && doc.people > 1 ? ` × ${doc.people} people` : '';
  if (line.type === 'fixed') return [line.label || 'Cost', `${money(line.amount, cur)}${who} = ${sum}`];
  if (line.type === 'per') return [line.label || `Per ${UNIT_WORDS[p.item.unit][0]}`, `${+unitsOf(p).toFixed(2)} × ${money(line.amount, cur)}${who} = ${sum}`];
  const r = line.route ? doc.routes[line.route] : undefined;
  return [line.label || 'Getting here', `${r ? esc(routeLabel(r)) : '?'} ${fmt(p.start, { weekday: 'short' })} · ${money(r ? fareOn(r, p.start) : 0, cur)}${who}${who ? ` = ${sum}` : ''}`];
}

/**
 * Detail view for an item, group or window.
 * @param {App} app
 * @param {Item} it
 * @returns {SheetView}
 */
function itemView(app, it) {
  const { doc, optional } = app, cur = doc.currency, at = layout(doc), p = /** @type {Placed} */ (at.get(it.id));
  const kids = kidsOf(doc, it.id), sibs = kidsOf(doc, it.parent), rank = sibs.indexOf(it), parent = byId(doc, it.parent);
  const grouped = inGroup(doc, it), live = counted(doc, optional).has(it.id);
  const rankBtns = sibs.length > 1
    ? `<button class="btn" data-rank="${esc(it.id)}:${rank - 1}" ${rank === 0 ? 'disabled' : ''}>↑ Rank up</button><button class="btn" data-rank="${esc(it.id)}:${rank + 1}" ${rank === sibs.length - 1 ? 'disabled' : ''}>↓ Rank down</button>`
    : '';
  const actions = `<div class="sh-actions">${rankBtns}<span class="spacer"></span><button class="btn" data-go="edit:${esc(it.id)}">Edit</button><button class="btn danger" data-delete="${esc(it.id)}">Delete</button></div>`;
  const inside = it.kind === 'window' ? '' : `<div class="sh-sec"><div class="nb-h">${it.kind === 'group' ? 'Options (top one counts)' : 'Inside'}</div>${kids.length ? `<ol class="kids">${kids.map((k, i) => {
    const kp = /** @type {Placed} */ (at.get(k.id)), tag = it.kind === 'group' ? (i ? '' : 'pick') : k.kind === 'group' ? 'either/or' : k.committed ? '' : 'optional';
    return `<li><button data-go="item:${esc(k.id)}"><span class="sw c-${k.color}"></span><b>${esc(k.name)}</b><small>${esc(datesOf(kp))}${tag ? ` · ${tag}` : ''}</small></button></li>`;
  }).join('')}</ol>` : ''}<div class="sh-actions"><button class="btn" data-go="add:item:${esc(it.id)}">+ ${it.kind === 'group' ? 'Option' : 'Item inside'}</button>${it.kind === 'item' ? `<button class="btn" data-go="add:group:${esc(it.id)}">+ Either/or inside</button>` : ''}${kids.length ? `<button class="btn" data-drill="${esc(it.id)}">Open on its own</button>` : ''}</div></div>`;

  if (it.kind === 'window') {
    const left = Math.max(0, Math.ceil(p.end - nowIdx()));
    return {
      k: `Fixed · ${unitText(it.len ?? 1, 'day')}`, t: it.name, c: 'var(--ink)',
      body: dl([['Dates', `${fmt(p.start)} – ${fmt(p.end - 1, { year: 'numeric' })}`], ['Leave by', fmt(p.end - 1, { weekday: 'short' })], ['Days left from today', String(Math.min(left, it.len ?? 1))]]) +
        '<p class="sh-note">This never moves. Stays can stretch up to its last day.</p>' + actions,
    };
  }

  const sum = total(doc, { optional, root: it.id, at });
  if (it.kind === 'group') {
    return {
      k: `Either/or · ${kids.length} option${kids.length === 1 ? '' : 's'}`, t: it.name, c: 'var(--ink)',
      body: dl([['Dates', esc(datesOf(p))], ['Pick', kids[0] ? esc(kids[0].name) : 'none yet'], ['Total', `${money(sum.stay + sum.travel, cur)}${live ? '' : ' (not counted)'}`]]) +
        '<p class="sh-note">Only the top-ranked option counts toward totals. Drag options up or down, or use their Rank buttons.</p>' + inside + actions,
    };
  }

  const status = grouped ? (rank ? `Option ${rank + 1} in ${parent?.name}` : `Pick in ${parent?.name}`) : it.committed ? 'Committed' : 'Optional';
  const rows = /** @type {[string, string][]} */ ([
    ['Dates', esc(datesOf(p))],
    ['Length', it.len === undefined && kids.length ? `${unitText(unitsOf(p), it.unit)} (fits what's inside)` : `${unitText(unitsOf(p), it.unit)}${isRanged(it) ? ` (${it.minLen}–${it.maxLen})` : ''}`],
    ...it.costs.map((l) => costRow(doc, l, p)),
  ]);
  const own = it.costs.reduce((t, l) => t + lineCost(doc, l, p), 0);
  if (kids.length) rows.push(['Inside', money(sum.stay + sum.travel - own, cur)]);
  rows.push(['Total', `${money(sum.stay + sum.travel, cur)}${live ? '' : ' (not counted)'}`]);
  const c = coverage(doc, at, optional).get(it.id), word = UNIT_WORDS[it.unit][1];
  const warn = (/** @type {[number, number][]} */ list, /** @type {string} */ cls, /** @type {string} */ what) => {
    const n = list.reduce((t, [a, b]) => t + b - a, 0);
    return n ? `<p class="warn ${cls}">${n} ${n === 1 ? UNIT_WORDS[it.unit][0] : word} ${what}: ${list.map(([a, b]) => `${fmt(a)}${b - a > 1 ? `–${fmt(b - 1)}` : ''}`).join(', ')}</p>` : '';
  };
  const step = it.unit === 'hour' ? 0.25 : 1, [mn, mx] = isRanged(it) ? [it.minLen, it.maxLen] : [step, Infinity];
  const toggle = grouped
    ? (rank ? `<button class="btn primary" data-rank="${esc(it.id)}:0">Make this the pick</button>` : '')
    : `<button class="btn" data-commit="${esc(it.id)}">${it.committed ? 'Mark optional' : 'Mark committed'}</button>`;
  return {
    k: `${status}${isRanged(it) ? ` · ${it.minLen}–${unitText(it.maxLen, it.unit)}` : ''}`, t: it.name, c: `var(--c-${it.color})`,
    body: dl(rows) + (c ? warn(c.gaps, 'gap', 'with nothing booked') + warn(c.overlaps, 'ovl', 'booked twice') : '') +
      `<div class="steps">${toggle}${it.len !== undefined ? `<button data-set="${esc(it.id)}:${it.len - step}" ${it.len <= mn ? 'disabled' : ''}>One ${UNIT_WORDS[it.unit][0]} shorter</button><button data-set="${esc(it.id)}:${it.len + step}" ${it.len >= mx ? 'disabled' : ''}>One ${UNIT_WORDS[it.unit][0]} longer</button>` : ''}</div>` +
      it.costs.filter((l) => l.type === 'date' && l.route).map((l) => nearby(doc, /** @type {string} */ (l.route), Math.floor(p.start))).join('') +
      linksView(it) + picturesView(it) + inside + actions,
  };
}

/**
 * Link chips plus a box to paste a new link.
 * @param {Item} it
 * @returns {string} HTML.
 */
function linksView(it) {
  const chips = it.links.map((u, i) => `<span class="link-chip"><a href="${esc(u)}" target="_blank" rel="noopener noreferrer" title="${esc(u)}">${esc(siteOf(u))} ↗</a><button data-unlink="${esc(it.id)}:${i}" aria-label="Remove ${esc(siteOf(u))} link">×</button></span>`).join('');
  return `<div class="sh-sec"><div class="nb-h">Links</div>${chips ? `<div class="links">${chips}</div>` : ''}${it.links.length < MAX_LINKS
    ? `<form class="linkform" data-form="link" data-id="${esc(it.id)}"><input name="url" type="url" inputmode="url" placeholder="Paste a Booking, Agoda or Airbnb link" aria-label="Link to add" required><button class="btn" type="submit">Add</button></form>` : ''}</div>`;
}

/**
 * Picture thumbnails plus a paste/drop/choose area.
 * @param {Item} it
 * @returns {string} HTML.
 */
function picturesView(it) {
  const thumbs = it.images.map((id) => `<span class="pic"><a href="${api.imageUrl(id)}" target="_blank" rel="noopener"><img src="${api.imageUrl(id, true)}" alt="Picture of ${esc(it.name)}" loading="lazy"></a><button data-unimg="${esc(it.id)}:${esc(id)}" aria-label="Remove picture">×</button></span>`).join('');
  return `<div class="sh-sec"><div class="nb-h">Pictures</div>${thumbs ? `<div class="pics">${thumbs}</div>` : ''}${it.images.length < MAX_IMAGES
    ? `<label class="drop" data-drop="${esc(it.id)}">Paste or drop a picture here, or <u>choose one</u><input type="file" accept="image/*" multiple data-file="${esc(it.id)}"></label><p class="err" data-pic-err hidden></p>` : ''}</div>`;
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
    const fp = /** @type {Placed} */ (layout(doc).get(from.id));
    let best = fp.start + from.minLen;
    for (let i = best; i <= fp.start + from.maxLen; i++) if (fareOn(r, i) < fareOn(r, best)) best = i;
    cheapest = `${fmt(best)} · ${money(fareOn(r, best), cur)}`;
  }
  const own = r.fares[isoOf(day)];
  const rows = /** @type {[string, string][]} */ ([
    ['Date', fmt(day, { weekday: 'short', year: 'numeric' })],
    ['Time', `${hhmm(r.depart)} → ${hhmm(r.depart + r.hours)} (${Math.floor(r.hours)}h ${String(Math.round((r.hours % 1) * 60)).padStart(2, '0')}m)`],
    ['Fare', `${money(fareOn(r, day), cur)}${own === undefined ? ' (usual)' : ''} each`],
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
  <p class="sh-note full">Leave "Fare on" empty to use the usual fare that day. Changes apply to every item that uses ${esc(routeLabel(r))}.</p>
  <div class="sh-actions"><button class="btn primary" type="submit">Save fares</button></div>
</form>`,
  };
}

/**
 * One editable cost row in the item form.
 * @param {PlanDoc} doc
 * @param {CostLine} line
 * @returns {string} HTML.
 */
function costEditor(doc, line) {
  const routes = Object.entries(doc.routes).map(([k, r]) => /** @type {[string, string]} */ ([k, routeLabel(r)]));
  return `<div class="cost-row">
  <input name="c-label" value="${esc(line.label)}" placeholder="Room, dinner, flight…" maxlength="40" aria-label="Cost name">
  <select name="c-type" aria-label="Cost type">${options([['fixed', 'Fixed'], ['per', 'Per night'], ['date', 'Fare by date']], line.type)}</select>
  <input name="c-amount" type="number" min="0" step="any" inputmode="decimal" value="${line.type === 'date' ? '' : line.amount}" placeholder="0" aria-label="Amount">
  <select name="c-route" aria-label="Route">${options([['', 'Pick a route'], ...routes, ['new', 'New route…']], line.route ?? '')}</select>
  <label class="pp"><input type="checkbox" name="c-pp"${line.pp ? ' checked' : ''}> each person</label>
  <button type="button" class="x" data-rmcost aria-label="Remove this cost">×</button>
</div>`;
}

/**
 * Add/edit form for an item, group or window.
 * @param {App} app
 * @param {Item | null} it Item to edit, or null to add one.
 * @param {Item['kind']} kind Kind to add (ignored when editing).
 * @param {string | undefined} parentId Where to add it (ignored when editing).
 * @returns {SheetView}
 */
function formView(app, it, kind, parentId) {
  const { doc } = app, today = isoOf(nowIdx());
  kind = it?.kind ?? kind;
  const parent = it ? it.parent : parentId;
  const banned = it ? subtree(doc, it.id) : new Set();
  /** @param {Item} x @returns {string} */
  const label = (x) => `${'· '.repeat(ancestors(doc, x).length)}${x.name}${x.kind === 'group' ? ' (either/or)' : ''}`;
  const parents = doc.items.filter((x) => x.kind !== 'window' && !banned.has(x.id)).map((x) => /** @type {[string, string]} */ ([x.id, label(x)]));
  const above = new Set(ancestors(doc, it ?? /** @type {Item} */ ({ parent })).map((a) => a.id));
  const afters = doc.items.filter((x) => !banned.has(x.id) && !above.has(x.id) && x.id !== parent)
    .map((x) => /** @type {[string, string]} */ ([`after:${x.id}`, `After ${label(x).replace(/^(· )+/, '')}`]));
  const at = it ? layout(doc).get(it.id) : undefined;
  const starts = it?.after ? `after:${it.after}` : it?.start || kind === 'window' || !parent ? 'date' : 'parent';
  const date = it?.start ? isoOf(dayOf(it.start) + Math.floor(it.offset)) : at ? isoOf(at.start) : today;
  const time = it?.unit === 'hour' && at ? hhmm((at.start % 1) * 24) : '09:00';
  const costs = it?.costs.length ? it.costs : kind === 'item' ? [{ label: '', type: /** @type {const} */ ('per'), amount: 0, pp: false }] : [];
  const title = { item: 'item', group: 'either/or group', window: 'fixed window' }[kind];
  return {
    k: it ? 'Edit' : byId(doc, parent) ? `New, inside ${byId(doc, parent)?.name}` : 'New', t: it ? it.name : `Add ${byId(doc, parent)?.kind === 'group' && kind === 'item' ? 'an option' : `a ${title}`}`,
    c: it?.kind === 'item' ? `var(--c-${it.color})` : 'var(--ink)',
    body: `
<form class="form" data-form="item" data-id="${esc(it?.id ?? '')}" data-kind="${kind}">
  ${it ? '' : select('Type', 'kind', [['item', 'Item (stay, room, plan, place…)'], ['group', 'Either/or group (options, top one counts)'], ['window', 'Fixed window (visa, lease…)']], kind, 'full')}
  ${input('Name', 'name', it?.name, 'type="text" maxlength="80" required placeholder="Bangkok"', 'full')}
  ${select('Inside', 'parent', [['', 'Top level'], ...parents], parent ?? '', 'full not-window')}
  ${select('Starts', 'starts', [['parent', 'When what it\'s inside starts'], ['date', 'On a date'], ...afters], starts, 'full not-window')}
  ${input('Start date', 'start', date, 'type="date"', 'only-date')}
  ${input('Days later', 'offset', it && !it.start ? Math.floor(it.offset) : 0, 'type="number" step="1"', 'only-offset')}
  ${input('Time', 'at', time, 'type="time"', 'only-time')}
  ${select('Measured in', 'unit', [['night', 'Nights'], ['day', 'Days'], ['hour', 'Hours']], it?.unit ?? 'night', 'only-item')}
  ${input('Length', 'len', it?.len ?? (kind === 'window' ? 90 : it ? '' : 7), 'type="number" min="0.25" step="any"', 'not-group len')}
  ${input('Fewest (optional)', 'minLen', it?.minLen, 'type="number" min="0.25" step="any"', 'only-item')}
  ${input('Most (optional)', 'maxLen', it?.maxLen, 'type="number" min="0.25" step="any"', 'only-item')}
  <label class="check only-commit"><input type="checkbox" name="committed"${it?.committed === false ? '' : ' checked'}> Committed (counts in totals)</label>
  ${select('Color', 'color', COLORS.map((c) => [c, c[0].toUpperCase() + c.slice(1)]), it?.color ?? 'teal', 'only-item')}
  <fieldset class="only-item costs"><legend>Costs</legend><div class="cost-rows">${costs.map((l) => costEditor(doc, l)).join('')}</div>
    <button type="button" class="btn" data-addcost>+ Add a cost</button></fieldset>
  <fieldset class="only-route"><legend>New route (shared by every item that uses it)</legend>
    ${input('From', 'from', '', 'type="text" maxlength="8" placeholder="SGN"')}
    ${input('To', 'to', '', 'type="text" maxlength="8" placeholder="BKK"')}
    ${input('Departs', 'depart', '10:00', 'type="time"')}
    ${input('Duration (hours)', 'hours', 2, 'type="number" min="0" step="0.05"')}
    ${input('Usual fare', 'fare', 100, 'type="number" min="0" step="1" inputmode="decimal"')}
  </fieldset>
  <p class="sh-note full only-fit">Leave Length empty to stretch it over what's inside.</p>
  <p class="err" hidden></p>
  <div class="sh-actions"><button class="btn primary" type="submit">${it ? 'Save' : 'Add'}</button><button class="btn" type="button" data-go="${it ? `item:${esc(it.id)}` : parent ? `item:${esc(parent)}` : ''}">Cancel</button></div>
</form>`,
  };
}

/**
 * Shows or hides form fields to match the current choices.
 * @param {HTMLFormElement} f
 * @param {PlanDoc} doc
 */
function syncForm(f, doc) {
  const val = (/** @type {string} */ n) => /** @type {HTMLInputElement | null} */ (f.elements.namedItem(n))?.value ?? '';
  const kind = val('kind') || /** @type {string} */ (f.dataset.kind), unit = kind === 'window' ? 'day' : val('unit');
  const startsEl = /** @type {HTMLSelectElement} */ (f.elements.namedItem('starts'));
  const parent = byId(doc, val('parent') || undefined);
  const parentOpt = /** @type {HTMLOptionElement} */ (startsEl.querySelector('option[value="parent"]'));
  parentOpt.disabled = !parent;
  if (!parent && startsEl.value === 'parent') startsEl.value = 'date';
  const starts = kind === 'window' ? 'date' : startsEl.value;
  const show = (/** @type {string} */ sel, /** @type {boolean} */ on) => f.querySelectorAll(sel).forEach((el) => { /** @type {HTMLElement} */ (el).hidden = !on; });
  show('.only-item', kind === 'item');
  show('.not-window', kind !== 'window');
  show('.not-group', kind !== 'group');
  show('.only-date', starts === 'date');
  show('.only-offset', starts !== 'date');
  show('.only-time', kind === 'item' && unit === 'hour' && !starts.startsWith('after:'));
  show('.only-commit', kind === 'item' && parent?.kind !== 'group');
  show('.only-fit', kind === 'item' && !!f.dataset.id && kidsOf(doc, f.dataset.id).length > 0);
  /** @type {HTMLElement} */ (f.querySelector('.len span')).textContent = `Length (${UNIT_WORDS[/** @type {'night'} */ (unit)]?.[1] ?? 'nights'})`;
  let newRoute = false;
  f.querySelectorAll('.cost-row').forEach((row) => {
    const q = (/** @type {string} */ n) => /** @type {HTMLInputElement} */ (row.querySelector(`[name="${n}"]`));
    const date = q('c-type').value === 'date';
    q('c-amount').hidden = date;
    q('c-route').hidden = !date;
    /** @type {HTMLOptionElement} */ (q('c-type').querySelector('option[value="per"]')).textContent = `Per ${UNIT_WORDS[/** @type {'night'} */ (unit)]?.[0] ?? 'night'}`;
    if (date && q('c-route').value === 'new') newRoute = true;
  });
  show('.only-route', kind === 'item' && newRoute);
}

/**
 * Reads the item form and applies it to the plan.
 * @param {App} app
 * @param {HTMLFormElement} f
 * @returns {string | null} An error message, or null when saved.
 */
function saveItem(app, f) {
  const v = Object.fromEntries(new FormData(f));
  const str = (/** @type {string} */ k) => String(v[k] ?? '').trim();
  const numOrNaN = (/** @type {string} */ k) => (str(k) === '' ? NaN : +str(k));
  const doc = app.doc, old = byId(doc, f.dataset.id || undefined);
  const kind = /** @type {Item['kind']} */ (str('kind') || f.dataset.kind), id = old?.id ?? uid(), name = str('name');
  if (!name) return 'Give it a name.';
  const parentId = kind === 'window' ? undefined : str('parent') || undefined, parent = byId(doc, parentId);
  if (parentId && (!parent || (old && subtree(doc, old.id).has(parentId)))) return 'It can\'t go inside that.';
  const it = makeItem({ id, name, kind, ...(parentId && { parent: parentId }), ...(old && { links: old.links, images: old.images, ...(old.note && { note: old.note }) }) });
  const starts = kind === 'window' ? 'date' : str('starts'), unit = kind === 'item' ? /** @type {Item['unit']} */ (str('unit')) : kind === 'window' ? 'day' : 'night';
  it.unit = unit;
  if (starts.startsWith('after:')) it.after = starts.slice(6);
  else if (starts === 'date') {
    if (Number.isNaN(dayOf(str('start')))) return 'Pick a start date.';
    it.start = str('start');
  } else if (!parent) return 'Pick a start date for top-level items.';
  if (starts !== 'date') it.offset = Math.round(numOrNaN('offset')) || 0;
  if (unit === 'hour' && !it.after) {
    const h = parseHhmm(str('at'));
    if (Number.isNaN(h)) return 'The time looks wrong.';
    it.at = h;
  }
  /** @type {[string, Route] | null} */
  let route = null;
  if (kind === 'window') {
    const len = Math.round(numOrNaN('len'));
    if (!(len >= 1)) return 'Days must be 1 or more.';
    it.len = len;
  } else if (kind === 'item') {
    const len = numOrNaN('len'), mn = numOrNaN('minLen'), mx = numOrNaN('maxLen');
    if (!Number.isNaN(len) && !(len > 0)) return 'Length must be more than 0.';
    if (Number.isNaN(mn) !== Number.isNaN(mx)) return 'Set both fewest and most, or neither.';
    if (!Number.isNaN(mn)) {
      if (!(mn > 0 && mx > mn)) return 'Most must be more than fewest.';
      if (Number.isNaN(len)) return 'Set a length too.';
      Object.assign(it, { minLen: mn, maxLen: mx });
    }
    if (!Number.isNaN(len)) it.len = it.minLen !== undefined ? Math.min(Math.max(len, mn), mx) : len;
    it.committed = parent?.kind === 'group' ? (old?.committed ?? true) : v.committed === 'on';
    it.color = COLORS.includes(str('color')) ? str('color') : 'gray';
    for (const row of f.querySelectorAll('.cost-row')) {
      const q = (/** @type {string} */ n) => /** @type {HTMLInputElement} */ (row.querySelector(`[name="${n}"]`));
      const type = /** @type {CostLine['type']} */ (q('c-type').value), label = q('c-label').value.trim(), amount = Math.max(0, +q('c-amount').value || 0);
      /** @type {CostLine} */
      const line = { label, type, amount: type === 'date' ? 0 : amount, pp: q('c-pp').checked };
      if (type === 'date') {
        let key = q('c-route').value;
        if (!key) return 'Pick a route for each fare, or remove that cost.';
        if (key === 'new') {
          const from = str('from').toUpperCase(), to = str('to').toUpperCase(), depart = parseHhmm(str('depart'));
          if (!from || !to) return 'Give the new route a From and To.';
          if (Number.isNaN(depart)) return 'The departure time looks wrong.';
          key = routeKey(from, to);
          if (doc.routes[key] && !route) return `${routeLabel(doc.routes[key])} already exists; pick it from the list.`;
          route = [key, { from, to, depart, hours: Math.max(0, +str('hours') || 0), fare: Math.max(0, +str('fare') || 0), fares: {} }];
        }
        line.route = key;
      } else if (!amount && !label) continue;
      it.costs.push(line);
    }
  }
  app.change((d) => {
    if (route) d.routes[route[0]] = route[1];
    const i = d.items.findIndex((x) => x.id === id);
    if (i >= 0) d.items[i] = it;
    else d.items.push(it);
    pruneRoutes(d);
  });
  if (parentId) app.open.add(parentId);
  if (kind === 'group') app.open.add(id);
  app.select(`item:${id}`);
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

/**
 * Adds a link to an item, if it's a new http(s) link and there's room.
 * @param {App} app
 * @param {string} id
 * @param {string} url
 * @returns {string | null} An error message, or null when added.
 */
function addLink(app, id, url) {
  url = url.trim();
  if (!isLink(url)) return 'That doesn\'t look like a web link.';
  const it = byId(app.doc, id);
  if (!it || it.links.includes(url)) return null;
  if (it.links.length >= MAX_LINKS) return `Up to ${MAX_LINKS} links per item.`;
  app.change(() => { it.links.push(url); });
  return null;
}

export class Sheet {
  /**
   * Wires the sheet's buttons, forms, paste and drop (all delegated, since
   * content is redrawn).
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
    el.addEventListener('click', (e) => this.onClick(e));
    el.addEventListener('change', (e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      if (t.dataset.file) { this.attach(t.dataset.file, t.files ?? []); t.value = ''; return; }
      const f = t.closest('form');
      if (f?.dataset.form === 'item') syncForm(f, app.doc);
    });
    el.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = /** @type {HTMLFormElement} */ (e.target);
      const err = f.dataset.form === 'fare' ? saveFare(app, f)
        : f.dataset.form === 'link' ? addLink(app, /** @type {string} */ (f.dataset.id), String(new FormData(f).get('url') ?? ''))
        : saveItem(app, f);
      const box = /** @type {HTMLElement | null} */ (f.querySelector('.err'));
      if (err && box) { box.textContent = err; box.hidden = false; } else if (err) alert(err);
    });
    // Pictures: drop onto the sheet, or paste anywhere while an item is open.
    el.addEventListener('dragover', (e) => { if (this.itemId() && e.dataTransfer?.types.includes('Files')) { e.preventDefault(); el.classList.add('dropping'); } });
    el.addEventListener('dragleave', (e) => { if (e.target === el) el.classList.remove('dropping'); });
    el.addEventListener('drop', (e) => {
      el.classList.remove('dropping');
      const id = this.itemId();
      if (!id || !e.dataTransfer?.files.length) return;
      e.preventDefault();
      this.attach(id, e.dataTransfer.files);
    });
    document.addEventListener('paste', (e) => {
      const id = this.itemId(), data = e.clipboardData;
      if (!id || !data) return;
      const files = [...data.files].filter((x) => x.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); this.attach(id, files); return; }
      const typing = /** @type {HTMLElement} */ (e.target).closest?.('input, textarea, select');
      const text = data.getData('text/plain').trim();
      if (!typing && isLink(text)) { e.preventDefault(); addLink(app, id, text); }
    });
  }

  /** @returns {string | null} Id of the item whose details are open, if any. */
  itemId() {
    const sel = this.app.sel;
    return !this.el.hidden && sel?.startsWith('item:') ? sel.slice(5) : null;
  }

  /**
   * Uploads pictures for an item and shows any error in the sheet.
   * @param {string} id
   * @param {Iterable<Blob>} files
   */
  async attach(id, files) {
    const box = /** @type {HTMLElement | null} */ (this.el.querySelector('[data-pic-err]'));
    const drop = this.el.querySelector('.drop');
    drop?.classList.add('busy');
    try {
      await this.app.attach(id, files);
    } catch (err) {
      const msg = `Couldn't add the picture: ${/** @type {Error} */ (err).message}`;
      const b = /** @type {HTMLElement | null} */ (this.el.querySelector('[data-pic-err]')) ?? box;
      if (b) { b.textContent = msg; b.hidden = false; } else alert(msg);
    } finally {
      this.el.querySelector('.drop')?.classList.remove('busy');
    }
  }

  /**
   * Handles every button in the sheet.
   * @param {MouseEvent} e
   */
  onClick(e) {
    const app = this.app, t = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!t) return;
    const d = t.dataset;
    /** @param {string} s @returns {[string, string]} */
    const split = (s) => /** @type {[string, string]} */ (s.split(/:(?=[^:]*$)/));
    if (d.set) { const [id, n] = split(d.set); app.setLen(id, +n); }
    if (d.rank) { const [id, n] = split(d.rank); app.change((doc) => setRank(doc, id, +n)); }
    if (d.commit) app.change((doc) => { const it = byId(doc, d.commit); if (it) it.committed = !it.committed; });
    if (d.drill) { app.drillTo(d.drill); app.select(null); }
    if (d.go !== undefined) app.select(d.go || null);
    if (d.unlink) { const [id, i] = split(d.unlink); app.change((doc) => { byId(doc, id)?.links.splice(+i, 1); }); }
    if (d.unimg) {
      const [id, img] = split(d.unimg);
      app.change((doc) => { const it = byId(doc, id); if (it) it.images = it.images.filter((x) => x !== img); });
      api.deleteImage(img).catch(() => { /* orphaned in storage; harmless */ });
    }
    if (d.addcost !== undefined) {
      const f = /** @type {HTMLFormElement} */ (t.closest('form'));
      $('.cost-rows', f).insertAdjacentHTML('beforeend', costEditor(app.doc, { label: '', type: 'fixed', amount: 0, pp: false }));
      syncForm(f, app.doc);
    }
    if (d.rmcost !== undefined) {
      const f = /** @type {HTMLFormElement} */ (t.closest('form'));
      t.closest('.cost-row')?.remove();
      syncForm(f, app.doc);
    }
    if (d.delete) {
      const it = byId(app.doc, d.delete);
      const n = it ? subtree(app.doc, it.id).size - 1 : 0;
      if (it && confirm(`Delete "${it.name}"${n ? ` and the ${n} item${n === 1 ? '' : 's'} inside it` : ''}? Items that follow it keep their dates.`)) {
        let imgs = /** @type {string[]} */ ([]);
        app.change((doc) => { imgs = removeItem(doc, it.id); });
        imgs.forEach((img) => api.deleteImage(img).catch(() => {}));
        if (app.drill && !byId(app.doc, app.drill)) app.drillTo(null);
        app.select(null);
      }
    }
  }

  /**
   * Redraws the sheet for the current selection. Forms aren't redrawn while
   * open (that would wipe what you're typing) unless `force` is set.
   * @param {boolean} [force]
   */
  render(force = false) {
    const { doc, sel } = this.app;
    const key = sel ?? '';
    if (!force && this.shown === key && /^(add|edit):/.test(key)) return;
    this.shown = key;
    /** @type {SheetView | null} */
    let v = null;
    const add = /^add:(item|group|window):(.*)$/.exec(key);
    if (add) v = formView(this.app, null, /** @type {Item['kind']} */ (add[1]), add[2] || undefined);
    else if (key.startsWith('edit:') || key.startsWith('item:')) {
      const it = byId(doc, key.slice(5));
      if (it) v = key.startsWith('edit:') ? formView(this.app, it, it.kind, it.parent) : itemView(this.app, it);
    } else if (key.startsWith('fare:')) {
      const m = /^fare:(.+):(-?\d+)$/.exec(key);
      if (m) v = fareView(this.app, m[1], +m[2]);
    }
    this.el.hidden = !v;
    if (!v) return;
    this.el.style.setProperty('--c', v.c);
    $('#sh-k', this.el).textContent = v.k;
    $('#sh-t', this.el).textContent = v.t;
    $('#sh-b', this.el).innerHTML = v.body;
    const f = /** @type {HTMLFormElement | null} */ (this.el.querySelector('form[data-form="item"]'));
    if (f) syncForm(f, doc);
  }
}
