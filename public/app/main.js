// @ts-check
/**
 * Span's entry point: holds the app state, loads and saves plans through
 * the API, and redraws the controls, summary, timeline, compare panel and
 * sheet.
 *
 * @module
 */
import * as api from './api.js';
import { Calendar } from './calendar.js';
import { Cards } from './cards.js';
import { Compare } from './compare.js';
import { prepare } from './images.js';
import {
  ancestors, byId, clamp, coverage, emptyDoc, fixOverlaps, fmt, isPicked, isRanged, kidsOf, layout, MAX_IMAGES, money, normalize, pick,
  pivotOf, sampleDoc, total, unitText,
} from './model.js';
import { Lanes } from './lanes.js';
import { beds, doubleRuns, gapRuns, nightsIn, unpricedIn } from './checks.js';
import { missingMoves, pastWindows } from './places.js';
import { RouteMap } from './routemap.js';
import { Sheet } from './sheet.js';
import { Story } from './story.js';
import { Timeline } from './timeline.js';
import { decidingSample } from './trip.js';
import { $, esc } from './ui.js';

/** @typedef {import('./model.js').CostFilter} CostFilter */
/** @typedef {import('./model.js').Placed} Placed */

/** Name given to the plan created on first visit. */
const SAMPLE_NAME = 'After Vietnam (sample)';
/** Name of the still-deciding sample plan the Sample button makes. */
const DECIDING_NAME = 'Thailand or Taiwan (sample)';
/** The views, by id: lanes is the main one; zoom is the original timeline with the cost panel. */
const VIEWS = /** @type {const} */ (['lanes', 'calendar', 'map', 'cards', 'story', 'zoom']);
/** Delay before saving after the last change, in ms. */
const SAVE_DELAY = 700;
/** Below this width, children open by drilling in rather than in place. */
const NARROW = matchMedia('(max-width: 640px)');

/**
 * Reads a value from localStorage, tolerating private mode.
 * @param {string} k
 * @returns {string | null}
 */
function load(k) { try { return localStorage.getItem(k); } catch { return null; } }

/**
 * Writes a value to localStorage, tolerating private mode.
 * @param {string} k
 * @param {string} v
 */
function store(k, v) { try { localStorage.setItem(k, v); } catch { /* not persisted */ } }

/** @type {import('./api.js').PlanRecord[]} */
let plans = [];
/** Id of the open plan, or null when the server can't be reached. */
let planId = /** @type {string | null} */ (null);
/** Pending save timer. */
let saveTimer = 0;
/** Whether a plan (or the offline sample) has been shown yet; until then nothing plan-specific is drawn. */
let loaded = false;
/** How long the Undo toast stays, in ms. */
const UNDO_MS = 8000;
/** The pending undo: the plan as it was, and what to do once it can't be undone. */
let undo = /** @type {{before: import('./model.js').PlanDoc, expire: () => void, timer: number} | null} */ (null);

/** Saves which items are expanded, per plan. */
function storeOpen() { if (planId) store(`span-open:${planId}`, JSON.stringify([...app.open])); }

/** @type {import('./ui.js').App} */
const app = {
  doc: emptyDoc(),
  filter: /** @type {CostFilter} */ (['all', 'stays', 'travel', 'none'].includes(load('span-filter') ?? '') ? load('span-filter') : 'all'),
  optional: load('span-optional') === '1',
  sel: null,
  open: new Set(),
  drill: null,
  narrow: NARROW.matches,
  view: VIEWS.find((v) => v === load('span-view')) ?? 'lanes',
  planId: null,
  planName: '',
  change(fn) {
    fn(app.doc);
    renderAll();
    scheduleSave();
  },
  select(sel) {
    app.sel = sel;
    renderAll();
  },
  setLen(id, n) {
    const it = byId(app.doc, id);
    if (!it || it.kind === 'group') return;
    const min = it.unit === 'hour' ? 0.25 : 1;
    const len = isRanged(it) ? clamp(n, it.minLen, it.maxLen) : Math.max(min, n);
    if (len !== it.len) app.change(() => { it.len = len; });
  },
  toggle(id) {
    if (!app.open.delete(id)) app.open.add(id);
    storeOpen();
    renderAll();
  },
  drillTo(id) {
    app.drill = id && byId(app.doc, id) ? id : null;
    timeline.reset();
    renderAll();
  },
  undoable(text, before, expire = () => {}) {
    settleUndo();
    undo = { before, expire, timer: window.setTimeout(settleUndo, UNDO_MS) };
    $('#toast-t').textContent = text;
    $('#toast').hidden = false;
  },
  async attach(id, files) {
    const it = byId(app.doc, id);
    if (!it) return;
    for (const file of files) {
      if (!byId(app.doc, id) || it.images.length >= MAX_IMAGES) throw new Error(`up to ${MAX_IMAGES} pictures per item`);
      const { full, thumb } = await prepare(file);
      const { id: img } = await api.uploadImage(full, thumb);
      app.change(() => { it.images.push(img); });
    }
  },
};

const timeline = new Timeline($('#timeline'), app);
const compare = new Compare($('#compare'), app);
const sheet = new Sheet($('#sheet'), app);
const lanes = new Lanes($('#lanes'), app);
/** Each view's container and how to draw it; zoom draws the timeline and the cost panel. */
const views = {
  lanes: { els: ['#lanes'], render: () => lanes.render() },
  calendar: { els: ['#calendar'], render: () => calendar.render() },
  map: { els: ['#routemap'], render: () => routemap.render() },
  cards: { els: ['#cards'], render: () => cards.render() },
  story: { els: ['#story'], render: () => story.render() },
  zoom: { els: ['#timeline', '#compare'], render: () => { timeline.render(); compare.render(); } },
};
const calendar = new Calendar($('#calendar'), app);
const routemap = new RouteMap($('#routemap'), app);
const cards = new Cards($('#cards'), app);
const story = new Story($('#story'), app);

/** Ends the chance to undo: hides the toast and runs what was waiting on it. */
function settleUndo() {
  if (!undo) return;
  clearTimeout(undo.timer);
  const { expire } = undo;
  undo = null;
  $('#toast').hidden = true;
  expire();
}

/**
 * Shows save/load state next to the plan picker.
 * @param {string} text
 * @param {boolean} [err]
 */
function status(text, err = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('err', err);
}

/** Saves the open plan after a short pause, so drags don't flood the API. */
function scheduleSave() {
  if (!planId) return;
  clearTimeout(saveTimer);
  status('Saving…');
  saveTimer = window.setTimeout(save, SAVE_DELAY);
}

/**
 * Saves the open plan now.
 * @param {boolean} [keepalive] Use a request that survives the page closing.
 */
async function save(keepalive = false) {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (!planId) return;
  try {
    await api.updatePlan(planId, { body: app.doc }, keepalive);
    status('Saved');
  } catch (e) {
    status(`Not saved: ${/** @type {Error} */ (e).message}`, true);
  }
}

/** Refills the plan picker. */
function renderPicker() {
  /** When a plan was made (or last changed), to tell plans with the same name apart. */
  const when = (/** @type {import('./api.js').PlanRecord} */ p) =>
    new Date((p.created_at ?? p.updated_at) * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const labels = plans.map((p) => (plans.filter((q) => q.name === p.name).length > 1 ? `${p.name} · made ${when(p)}` : p.name));
  const seen = new Map();
  const unique = labels.map((l) => { const n = (seen.get(l) ?? 0) + 1; seen.set(l, n); return n > 1 ? `${l} (${n})` : l; });
  $('#plan').innerHTML = plans.map((p, i) => `<option value="${esc(p.id)}"${p.id === planId ? ' selected' : ''}>${esc(unique[i])}</option>`).join('');
  for (const id of ['#plan', '#plan-rename', '#plan-delete']) /** @type {HTMLButtonElement} */ ($(id)).disabled = !planId;
}

/**
 * Shows a plan: resets selection and drill, and restores what was expanded
 * (everything with something inside, the first time).
 * @param {unknown} body Stored plan document (any version).
 */
function show(body) {
  settleUndo();
  loaded = true;
  app.doc = normalize(body);
  app.sel = null;
  app.drill = null;
  let saved = null;
  try { saved = JSON.parse(load(`span-open:${planId}`) ?? 'null'); } catch { /* ignore */ }
  app.open = new Set(Array.isArray(saved) ? saved : app.doc.items.filter((it) => kidsOf(app.doc, it.id).length).map((it) => it.id));
  app.planId = planId;
  app.planName = plans.find((p) => p.id === planId)?.name ?? '';
  timeline.reset();
  lanes.reset();
}

/**
 * Opens a plan by id.
 * @param {string} id
 */
async function open(id) {
  if (saveTimer) await save();
  const rec = await api.getPlan(id);
  planId = rec.id;
  show(rec.body);
  store('span-plan', id);
  renderPicker();
  renderAll();
  status('');
}

/**
 * Creates a plan and opens it.
 * @param {string} name
 * @param {import('./model.js').PlanDoc} body
 */
async function create(name, body) {
  const rec = await api.createPlan(name, body);
  plans.unshift(rec);
  await open(rec.id);
}

/** Loads the plan list (seeding the sample on first visit) and opens the last plan used. */
async function boot() {
  renderAll();
  try {
    plans = await api.listPlans();
    if (!plans.length) return await create(SAMPLE_NAME, sampleDoc());
    const last = load('span-plan');
    await open(plans.some((p) => p.id === last) ? /** @type {string} */ (last) : plans[0].id);
  } catch (e) {
    planId = null;
    show(sampleDoc());
    renderPicker();
    renderAll();
    status(`Can't reach the server (${/** @type {Error} */ (e).message}). Showing the sample; changes won't be saved.`, true);
  }
}

/** Which issue in the summary is open to show its list, by kind. */
let issueOpen = /** @type {string | null} */ (null);

/**
 * One problem the summary lists: a short chip, and the entries it opens to,
 * each jumping to its dates (in Lanes) or selecting its item.
 * @typedef {object} SumIssue
 * @property {string} key
 * @property {'gap' | 'ovl'} tone
 * @property {string} label Chip text.
 * @property {{text: string, a?: number, b?: number, sel?: string, fix?: string}[]} rows
 */

/**
 * Night range as text: "Jan 8" for one night, "Dec 29 – Jan 3" for more
 * (the morning you leave, as a booking reads).
 * @param {number} a First night.
 * @param {number} b Morning after the last.
 * @returns {string}
 */
const nightsText = (a, b) => `${fmt(a)} – ${fmt(b)} · ${b - a} night${b - a === 1 ? '' : 's'}`;

/**
 * The plan's problems, worked out the same way every view counts them.
 * @returns {SumIssue[]}
 */
function issuesOf() {
  const { doc, optional } = app, at = layout(doc), bd = beds(doc, at, optional), out = /** @type {SumIssue[]} */ ([]);
  const name = (/** @type {string} */ id) => byId(doc, id)?.name ?? '';
  const whoText = (/** @type {string[]} */ who) => (who.length ? `${who.join(', ')}: ` : '');
  const gaps = gapRuns(bd);
  if (gaps.length) {
    const n = nightsIn(gaps);
    out.push({
      key: 'gap', tone: 'gap', label: `${n} night${n === 1 ? '' : 's'} unbooked`,
      rows: gaps.map((g) => ({ text: `${whoText(g.who)}${nightsText(g.a, g.b)}${g.ids.length ? ` · ${g.ids.map(name).join(', ')}` : ''}`, a: g.a, b: g.b, sel: g.ids[0] && `item:${g.ids[0]}` })),
    });
  }
  // Nights booked twice in what you've picked, named; Fix when the stays sit side by side in one place.
  const cov = coverage(doc, at, optional), dbl = doubleRuns(bd);
  if (dbl.length) {
    const n = nightsIn(dbl);
    out.push({
      key: 'dbl', tone: 'ovl', label: `${n} night${n === 1 ? '' : 's'} booked twice`,
      rows: dbl.map((r) => {
        const its = r.ids.map((id) => byId(doc, id)), par = its[0]?.parent;
        const fix = par && its.every((it) => it?.parent === par) && cov.get(par)?.overlaps.length ? par : undefined;
        return { text: `${whoText(r.who)}${r.ids.map(name).join(' and ')} · ${nightsText(r.a, r.b)}`, a: r.a, b: r.b, sel: `item:${r.ids[1] ?? r.ids[0]}`, fix };
      }),
    });
  }
  // Inside a trip you haven't picked, a night booked twice is still worth fixing before you pick it.
  for (const [id, c] of cov) {
    const it = byId(doc, id);
    if (!it || isPicked(doc, it) || !c.overlaps.length) continue;
    const trip = ([it, ...ancestors(doc, it)].find((a) => byId(doc, a.parent)?.kind === 'group') ?? it).name, n = c.overlaps.reduce((t, [a, b]) => t + b - a, 0);
    out.push({ key: `ovl:${id}`, tone: 'ovl', label: `${n} booked twice in ${trip}`, rows: c.overlaps.map(([a, b]) => ({ text: `${it.name} · ${nightsText(a, b)}`, a, b, sel: `item:${id}`, fix: id })) });
  }
  for (const w of pastWindows(doc, optional)) {
    out.push({ key: `win:${w.item.id}`, tone: 'gap', label: `After ${w.window.name}`, rows: [{ text: `${w.text}${w.trip ? ` (${w.trip})` : ''}`, sel: `item:${w.item.id}` }] });
  }
  const miss = missingMoves(doc, at, optional);
  if (miss.length) {
    out.push({
      key: 'move', tone: 'gap', label: `${miss.length} move${miss.length === 1 ? '' : 's'} not booked`,
      rows: miss.map((m) => ({ text: `${m.from} to ${m.to} · ${fmt(m.day)}`, a: m.day, b: m.day + 1, sel: `item:${m.stay.id}` })),
    });
  }
  return out;
}

/**
 * Summary line: when you leave the pivot and how much of its window is
 * left, the plan (or drilled item) total with how many items have no price
 * yet, and the plan's problems as chips that open a list of where each is.
 * @returns {string} HTML.
 */
function summary() {
  const { doc, filter, optional, drill } = app, cur = doc.currency, at = layout(doc), pivot = pivotOf(doc);
  let out = '';
  if (pivot) {
    const p = /** @type {Placed} */ (at.get(pivot.id));
    const win = [...at.values()].find((w) => w.item.kind === 'window' && w.start <= p.start && p.start < w.end);
    let spare = '';
    if (win) {
      const last = Math.ceil(win.end) - 1, left = Math.floor(last - p.end);
      spare = left >= 0
        ? ` · ${esc(win.item.name)} ends ${fmt(last, { weekday: 'short' })}, ${left} day${left === 1 ? '' : 's'} after you leave`
        : ` · <b class="bad">you leave ${-left} day${left === -1 ? '' : 's'} after ${esc(win.item.name)} ends</b>`;
    }
    out += `<span class="sum-main"><span class="mono">Leave ${esc(pivot.name)}</span><b>${fmt(p.end, { weekday: 'short' })}</b><span>${unitText(pivot.len ?? 1, pivot.unit)}${spare}</span></span>`;
  }
  if (filter !== 'none') {
    const root = drill ? byId(doc, drill) : undefined, sum = total(doc, { optional, root: root?.id, at }), np = unpricedIn(doc, optional, root?.id).length;
    out += `<span class="sum-opt">${root ? esc(root.name) : 'Plan total'} <b>${money(pick(sum, filter), cur)}</b>${np ? `<small title="Stays or moves with no price yet, left out of the total">+ ${np} unpriced</small>` : ''}</span>`;
  }
  const issues = issuesOf();
  if (issueOpen && !issues.some((i) => i.key === issueOpen)) issueOpen = null;
  if (issues.length) {
    out += `<span class="sum-issues">${issues.map((i) => `<button class="sum-warn ${i.tone}" data-iss="${esc(i.key)}" aria-expanded="${issueOpen === i.key}" title="${esc(i.label)}">${esc(i.label)}</button>`).join('')}</span>`;
  }
  const tag = { all: 'stays + travel', stays: 'stays only', travel: 'travel only', none: 'costs hidden' }[filter];
  out += `<span class="sum-tag">${tag}${optional && filter !== 'none' ? ', optional in' : ''}</span>`;
  const shown = issues.find((i) => i.key === issueOpen);
  if (shown) {
    out += `<ul class="sum-list">${shown.rows.map((r) =>
      `<li><button class="sum-go" ${r.a !== undefined ? `data-go="${r.a},${r.b}"` : ''} ${r.sel ? `data-sel="${esc(r.sel)}"` : ''}>${esc(r.text)}</button>${r.fix ? `<button class="sum-fix" data-fix="${esc(r.fix)}">Fix</button>` : ''}</li>`).join('')}</ul>`;
  }
  return out;
}

/** Draws the controls, summary, and every view. */
function renderAll() {
  const { doc, filter, optional } = app, at = layout(doc), pivot = pivotOf(doc);
  const empty = !doc.items.length, view = views[app.view];
  $('#empty').hidden = !empty || !loaded;
  for (const v of Object.values(views)) for (const sel of v.els) $(sel).hidden = !loaded || empty || v !== view;
  document.querySelectorAll('#views button').forEach((b) => b.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (b).dataset.v === app.view)));

  // Length slider for the pivot, when it has a range.
  const ranged = pivot && isRanged(pivot) ? pivot : null;
  $('#stayctl').hidden = !ranged;
  if (ranged) {
    const slider = /** @type {HTMLInputElement} */ ($('#stay')), p = /** @type {Placed} */ (at.get(ranged.id));
    $('#stay-label').textContent = ranged.name;
    slider.min = String(ranged.minLen);
    slider.max = String(ranged.maxLen);
    slider.step = ranged.unit === 'hour' ? '0.25' : '1';
    slider.value = String(ranged.len);
    $('#stay-out').textContent = `${unitText(ranged.len, ranged.unit)} · leave ${fmt(p.end)}`;
  }
  document.querySelectorAll('#filter .chip').forEach((b) => b.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (b).dataset.f === filter)));
  $('#optional').setAttribute('aria-pressed', String(optional));
  const people = /** @type {HTMLInputElement} */ ($('#people'));
  if (document.activeElement !== people) people.value = loaded ? String(doc.people) : '';
  $('#more-sum').textContent = loaded
    ? `Costs: ${{ all: 'all', stays: 'stays', travel: 'travel', none: 'hidden' }[filter]}${optional ? ' + optional' : ''} · ${doc.people} ${doc.people === 1 ? 'person' : 'people'}`
    : 'Costs and people';

  $('#summary').innerHTML = empty || !loaded ? '' : summary();
  if (!empty && loaded) view.render();
  sheet.render();
}

/* ---------- Theme toggle ---------- */

const SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1z"/></svg>';
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

/** @returns {boolean} Whether the page is dark, by explicit choice or system setting. */
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : darkQuery.matches;
}

/** Updates the toggle to offer the opposite mode, and the browser chrome color. */
function syncTheme() {
  const dark = isDark(), btn = $('#theme');
  btn.innerHTML = `${dark ? SUN : MOON}${dark ? 'Light' : 'Dark'}`;
  btn.setAttribute('aria-pressed', String(dark));
  btn.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} mode`);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0D1517' : '#ECF1F0');
}

/* ---------- Wiring ---------- */

$('#theme').addEventListener('click', () => {
  const mode = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = mode;
  store('span-theme', mode);
  syncTheme();
  renderAll();
});
darkQuery.addEventListener('change', syncTheme);

$('#stay').addEventListener('input', (e) => {
  const pivot = pivotOf(app.doc);
  if (pivot) app.setLen(pivot.id, +(/** @type {HTMLInputElement} */ (e.target).value));
});
$('#filter').addEventListener('click', (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest('.chip');
  if (!(b instanceof HTMLElement) || !b.dataset.f) return;
  app.filter = /** @type {CostFilter} */ (b.dataset.f);
  store('span-filter', app.filter);
  renderAll();
});
$('#optional').addEventListener('click', () => {
  app.optional = !app.optional;
  store('span-optional', app.optional ? '1' : '0');
  renderAll();
});
$('#people').addEventListener('change', (e) => {
  const n = Math.round(+(/** @type {HTMLInputElement} */ (e.target).value));
  if (n >= 1 && n <= 99 && n !== app.doc.people) app.change((doc) => { doc.people = n; });
  else renderAll();
});
$('#add').addEventListener('click', () => app.select(`add:item:${app.drill ?? ''}`));
$('#summary').addEventListener('click', (e) => {
  const d = /** @type {HTMLElement} */ (e.target).closest('button')?.dataset;
  if (!d) return;
  if (d.fix) { const id = d.fix; app.change((doc) => { fixOverlaps(doc, id, app.optional); }); }
  else if (d.iss) { issueOpen = issueOpen === d.iss ? null : d.iss; renderAll(); }
  else if (d.go && app.view === 'lanes') {
    // In Lanes, jump to the dates and light them up; the item opens too, when there is one.
    const [a, b] = d.go.split(',').map(Number);
    if (d.sel) app.select(d.sel);
    lanes.focus(a, b);
  } else if (d.sel) app.select(d.sel);
});
$('#toast-undo').addEventListener('click', () => {
  if (!undo) return;
  const { before } = undo;
  clearTimeout(undo.timer);
  undo = null;
  $('#toast').hidden = true;
  app.change((doc) => { Object.assign(doc, before); });
});
$('#empty').addEventListener('click', (e) => {
  const act = /** @type {HTMLElement} */ (e.target).closest('button')?.dataset.act;
  if (act === 'add') app.select('add:item:');
  if (act === 'sample') app.change((doc) => Object.assign(doc, sampleDoc()));
  if (act === 'deciding') app.change((doc) => Object.assign(doc, decidingSample()));
});

$('#views').addEventListener('click', (e) => {
  const v = VIEWS.find((x) => x === /** @type {HTMLElement} */ (e.target).closest('button')?.dataset.v);
  if (!v || v === app.view) return;
  app.view = v;
  store('span-view', v);
  renderAll();
});
$('#plan-sample').addEventListener('click', async () => {
  try { await create(DECIDING_NAME, decidingSample()); } catch (err) { status(`Couldn't create: ${/** @type {Error} */ (err).message}`, true); }
});

$('#plan').addEventListener('change', (e) => {
  open(/** @type {HTMLSelectElement} */ (e.target).value).catch((err) => status(`Couldn't open: ${err.message}`, true));
});
$('#plan-new').addEventListener('click', async () => {
  const name = prompt('Name for the new plan', 'New plan')?.trim();
  if (!name) return;
  try { await create(name.slice(0, 200), emptyDoc()); } catch (err) { status(`Couldn't create: ${/** @type {Error} */ (err).message}`, true); }
});
$('#plan-rename').addEventListener('click', async () => {
  const rec = plans.find((p) => p.id === planId);
  const name = rec && prompt('Rename plan', rec.name)?.trim();
  if (!rec || !name || name === rec.name) return;
  try {
    await api.updatePlan(rec.id, { name: name.slice(0, 200) });
    rec.name = name.slice(0, 200);
    app.planName = rec.name;
    renderPicker();
    renderAll();
  } catch (err) { status(`Couldn't rename: ${/** @type {Error} */ (err).message}`, true); }
});
$('#plan-delete').addEventListener('click', async () => {
  const rec = plans.find((p) => p.id === planId);
  if (!rec || !confirm(`Delete the plan "${rec.name}" and its pictures? This can't be undone.`)) return;
  try {
    clearTimeout(saveTimer);
    saveTimer = 0;
    await api.deletePlan(rec.id);
    plans = plans.filter((p) => p !== rec);
    if (plans.length) await open(plans[0].id);
    else await create('My plan', emptyDoc());
  } catch (err) { status(`Couldn't delete: ${/** @type {Error} */ (err).message}`, true); }
});

// Flush a pending save if the tab is hidden or closed mid-edit.
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveTimer) save(true); });
// Keep the timeline and chart sized to the window; switch phone/desktop behavior.
let resizeRaf = 0;
addEventListener('resize', () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(renderAll); });
NARROW.addEventListener('change', (e) => {
  app.narrow = e.matches;
  /** @type {HTMLDetailsElement} */ ($('#more')).open = !e.matches;
  /** @type {HTMLDetailsElement} */ ($('#planmenu')).open = !e.matches;
  renderAll();
});
/** @type {HTMLDetailsElement} */ ($('#more')).open = !NARROW.matches;
// The plan buttons sit in a row on wider screens; on a phone they're a menu that closes after a pick.
/** @type {HTMLDetailsElement} */ ($('#planmenu')).open = !NARROW.matches;
$('#planmenu').addEventListener('click', (e) => {
  if (NARROW.matches && /** @type {HTMLElement} */ (e.target).closest('.planmenu-in button')) /** @type {HTMLDetailsElement} */ ($('#planmenu')).open = false;
});

syncTheme();
boot();
