// @ts-check
/**
 * Span's entry point: holds the app state, loads and saves plans through
 * the API, and redraws the controls, summary, timeline, cost panel and sheet.
 *
 * @module
 */
import * as api from './api.js';
import { Compare } from './compare.js';
import {
  clamp, emptyDoc, fmt, isRanged, layout, money, normalize, pathCost, pathName, pathsFrom, pick, pivotOf, sampleDoc, stayCost,
} from './model.js';
import { Sheet } from './sheet.js';
import { Timeline } from './timeline.js';
import { $, esc } from './ui.js';

/** @typedef {import('./model.js').CostFilter} CostFilter */
/** @typedef {import('./model.js').StayBar} StayBar */

/** Name given to the plan created on first visit. */
const SAMPLE_NAME = 'After Vietnam (sample)';
/** Delay before saving after the last change, in ms. */
const SAVE_DELAY = 700;

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

/** @type {import('./ui.js').App} */
const app = {
  doc: emptyDoc(),
  filter: /** @type {CostFilter} */ (['all', 'stays', 'travel', 'none'].includes(load('span-filter') ?? '') ? load('span-filter') : 'all'),
  sel: null,
  change(fn) {
    fn(app.doc);
    renderAll();
    scheduleSave();
  },
  select(sel) {
    app.sel = sel;
    renderAll();
  },
  setNights(id, n) {
    const s = app.doc.bars.find((b) => b.id === id);
    if (!s || s.kind !== 'stay') return;
    const nights = isRanged(s) ? clamp(n, s.minNights, s.maxNights) : Math.max(1, n);
    if (nights !== s.nights) app.change(() => { s.nights = nights; });
  },
};

const timeline = new Timeline($('#timeline'), app);
const compare = new Compare($('#compare'), app);
const sheet = new Sheet($('#sheet'), app);

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
  $('#plan').innerHTML = plans.map((p) => `<option value="${esc(p.id)}"${p.id === planId ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  for (const id of ['#plan', '#plan-rename', '#plan-delete']) /** @type {HTMLButtonElement} */ ($(id)).disabled = !planId;
}

/**
 * Opens a plan by id.
 * @param {string} id
 */
async function open(id) {
  if (saveTimer) await save();
  const rec = await api.getPlan(id);
  planId = rec.id;
  app.doc = normalize(rec.body);
  app.sel = null;
  store('span-plan', id);
  timeline.reset();
  renderPicker();
  renderAll();
  status('Saved');
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
    app.doc = sampleDoc();
    renderPicker();
    renderAll();
    status(`Can't reach the server (${/** @type {Error} */ (e).message}). Showing the sample; changes won't be saved.`, true);
  }
}

/** Draws the stay slider, cost chips, summary, and every view. */
function renderAll() {
  const { doc, filter } = app, cur = doc.currency, at = layout(doc), pivot = pivotOf(doc);
  const empty = !doc.bars.length;
  $('#empty').hidden = !empty;
  $('#timeline').hidden = empty;
  $('#compare').hidden = empty;

  // Stay slider for the pivot, when it has a range.
  const ranged = pivot && isRanged(pivot) ? pivot : null;
  $('#stayctl').hidden = !ranged;
  if (ranged) {
    const slider = /** @type {HTMLInputElement} */ ($('#stay')), p = /** @type {import('./model.js').Placed} */ (at.get(ranged.id));
    $('#stay-label').textContent = `${ranged.name} stay`;
    slider.min = String(ranged.minNights);
    slider.max = String(ranged.maxNights);
    slider.value = String(ranged.nights);
    $('#stay-out').textContent = `${ranged.nights} nights · leave ${fmt(p.end)}`;
  }
  document.querySelectorAll('#filter .chip').forEach((b) => b.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (b).dataset.f === filter)));

  // Summary: when you leave, visa days spare, and each option's total.
  const tag = { all: 'stays + travel', stays: 'stays only', travel: 'travel only', none: 'costs hidden' }[filter];
  let sum = '';
  if (pivot) {
    const p = /** @type {import('./model.js').Placed} */ (at.get(pivot.id));
    const win = [...at.values()].find((w) => w.bar.kind === 'window' && w.start <= p.start && p.start < w.end);
    let spare = '';
    if (win) {
      const left = win.end - 1 - p.end;
      spare = left >= 0 ? ` · ${left} day${left === 1 ? '' : 's'} spare on ${esc(win.bar.name)}` : ` · <b style="color:var(--danger)">${-left} day${left === -1 ? '' : 's'} past ${esc(win.bar.name)}</b>`;
    }
    sum += `<span class="sum-main"><span class="mono">Leave ${esc(pivot.name)}</span><b>${fmt(p.end, { weekday: 'short' })}</b><span>${pivot.nights} nights${spare}</span></span>`;
    if (filter !== 'none') {
      sum += pathsFrom(doc, pivot.id).slice(0, 4).map((path) => {
        const c = pathCost(doc, path, pivot.id, pivot.nights);
        return `<span class="sum-opt">Then ${esc(pathName(doc, path))} <b>${money(pick(c.stay, c.travel, filter), cur)}</b></span>`;
      }).join('');
    }
  } else if (!empty && filter !== 'none') {
    const stays = /** @type {StayBar[]} */ (doc.bars.filter((b) => b.kind === 'stay'));
    const total = stays.reduce((t, s) => t + stayCost(s).total, 0);
    sum += `<span class="sum-main"><span class="mono">All stays</span><b>${money(pick(total, 0, filter), cur)}</b></span>`;
  }
  $('#summary').innerHTML = sum + (empty ? '' : `<span class="sum-tag">${tag}</span>`);

  if (!empty) {
    timeline.render();
    compare.render();
  }
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
  if (pivot) app.setNights(pivot.id, +(/** @type {HTMLInputElement} */ (e.target).value));
});
$('#filter').addEventListener('click', (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest('.chip');
  if (!(b instanceof HTMLElement)) return;
  app.filter = /** @type {CostFilter} */ (b.dataset.f);
  store('span-filter', app.filter);
  renderAll();
});
$('#add').addEventListener('click', () => app.select('add'));
$('#empty').addEventListener('click', (e) => {
  const act = /** @type {HTMLElement} */ (e.target).closest('button')?.dataset.act;
  if (act === 'add') app.select('add');
  if (act === 'sample') app.change((doc) => Object.assign(doc, sampleDoc()));
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
    renderPicker();
  } catch (err) { status(`Couldn't rename: ${/** @type {Error} */ (err).message}`, true); }
});
$('#plan-delete').addEventListener('click', async () => {
  const rec = plans.find((p) => p.id === planId);
  if (!rec || !confirm(`Delete the plan "${rec.name}"? This can't be undone.`)) return;
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
// Keep the timeline and chart sized to the window.
let resizeRaf = 0;
addEventListener('resize', () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(renderAll); });

syncTheme();
boot();
