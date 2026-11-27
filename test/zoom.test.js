import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../public/app/model.js';
import * as T from '../public/app/trip.js';
import * as Z from '../public/app/zoomkit.js';
import { shortName } from '../public/app/lanes.js';

/** Units each zoom level's axis may draw in. */
const UNITS = { Hours: ['h'], Days: ['d'], Weeks: ['w'], Months: ['m'], Year: ['m', 'y'] };

test('each preset reads as itself, and spans between read as the nearest', () => {
  for (const [name, days] of Object.entries(Z.PRESETS)) assert.equal(Z.levelOf(days), name);
  assert.equal(Z.levelOf(4), 'Days');
  assert.equal(Z.levelOf(90), 'Months');
  assert.equal(Z.levelOf(2000), 'Year');
});

test('the axis draws at the preset scale on phone and desktop widths', () => {
  const a = M.dayOf('2026-12-10');
  for (const w of [220, 330, 1180]) {
    for (const [name, days] of /** @type {[Z.Preset, number][]} */ (Object.entries(Z.PRESETS))) {
      const ppd = w / days, { k, minor } = Z.axisTicks(a, a + days, ppd, name);
      assert.ok(UNITS[name].includes(k), `${name} at ${w}px drew ${k}`);
      assert.ok(minor.length >= 2, `${name} at ${w}px has ${minor.length} ticks`);
    }
  }
});

test('the period the view starts in keeps a label', () => {
  const a = M.dayOf('2026-12-10'), { minor, major } = Z.axisTicks(a, a + 365, 3, 'Year');
  assert.equal(minor[0][1], 'Dec');
  assert.equal(major[0][1], '2026');
  const days = Z.axisTicks(a, a + 9, 30, 'Days');
  assert.equal(days.major[0][1], 'December 2026');
});

test('a gap inside an option you did not pick is not counted as picked', () => {
  const doc = M.normalize(T.decidingSample()), fork = /** @type {M.Item} */ (T.forkOf(doc));
  const [first, second] = M.kidsOf(doc, fork.id);
  const inFirst = M.kidsOf(doc, first.id)[0];
  assert.ok(M.isPicked(doc, inFirst));
  M.setRank(doc, second.id, 0);
  assert.equal(M.isPicked(doc, inFirst), false);
  assert.ok(M.isPicked(doc, M.kidsOf(doc, second.id)[0]));
});

test('narrow bubbles show as much of the name as fits', () => {
  assert.equal(shortName('★ Taiwan: ✈ Bangkok · 14n', 40), 'Bang');
  assert.equal(shortName('Chiang Mai · 11n', 74), 'Chiang Mai');
  assert.equal(shortName('Chiang Mai · 11n', 16), '');
});

test('a leading label with no room is dropped, not cut off under the names', () => {
  const a = M.dayOf('2026-12-20'), ppd = 330 / 365, x = (/** @type {number} */ d) => (d - a) * ppd;
  const { axis } = Z.axisMarks(a, a + 365, ppd, x, 0, 'Year');
  assert.ok(!axis.includes('>2026<'), 'squeezed 2026 is dropped');
  assert.ok(axis.includes('>2027<'));
  const b = M.dayOf('2026-12-01'), wide = Z.axisMarks(b, b + 365, 1180 / 365, (d) => (d - b) * 1180 / 365, 0, 'Year');
  assert.ok(wide.axis.includes('>2026<'), 'with room it stays');
});
