import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../public/app/model.js';
import * as C from '../public/app/checks.js';
import { apartRuns, costText, entriesOf, gapsOf, modeIcon, unpricedCount } from '../public/app/cards.js';

/** A made-up plan from item fields, normalized. */
const plan = (/** @type {object[]} */ items) => M.normalize({ v: 2, currency: 'USD', people: 2, items: items.map((f) => M.makeItem(/** @type {any} */ (f))), routes: {} });
const per = (/** @type {number} */ amount) => ({ label: 'Room', type: 'per', amount, pp: false });
const day = M.dayOf;

/** Two stays with an unbooked placeholder between, a bus during it, and a second placeholder after. */
const gappy = () => plan([
  { id: 'a', name: 'Lisbon flat', type: 'stay', start: '2027-01-01', len: 3, costs: [per(10)] },
  { id: 'ph', name: 'Jan 4 to 6: not booked', type: 'stay', start: '2027-01-04', len: 2, committed: false },
  { id: 'bus', name: 'Bus Lisbon → Porto', type: 'transport', mode: 'bus', unit: 'hour', start: '2027-01-05', at: 9, len: 3 },
  { id: 'b', name: 'Porto room', type: 'stay', start: '2027-01-06', len: 2 },
  { id: 'ph2', name: 'Porto: not booked', type: 'stay', start: '2027-01-08', len: 1, committed: false },
  { id: 'ph3', name: 'Braga: not booked', type: 'stay', start: '2027-01-09', len: 2, committed: false },
]);

test('gaps come from the shared check, merged only when asked', () => {
  const doc = gappy(), bd = C.beds(doc, M.layout(doc), false);
  const merged = gapsOf(bd);
  assert.deepEqual(merged.map((g) => [g.a - day('2027-01-01'), g.b - g.a, g.ids]), [[3, 2, ['ph']], [7, 3, ['ph2', 'ph3']]]);
  assert.equal(gapsOf(bd, false).length, 3, 'each placeholder keeps its own run');
  assert.equal(merged.reduce((n, g) => n + g.b - g.a, 0), C.nightsIn(C.gapRuns(bd)));
});

test('the trip reads in time order: a gap at its first night, a move at its departure', () => {
  const doc = gappy(), at = M.layout(doc);
  const order = entriesOf(doc, at, false, C.beds(doc, at, false)).map((e) => e.stop?.name ?? (e.gap ? `gap ${e.gap.ids[0]}` : e.hop?.item.id));
  assert.deepEqual(order, ['Lisbon', 'gap ph', 'bus', 'Porto', 'gap ph2']);
});

test('people apart show each part, and a place holding them is not a stay', () => {
  const doc = plan([
    { id: 's0', name: 'Manila flat', type: 'stay', start: '2027-02-26', len: 2, costs: [per(40)] },
    { id: 'split', name: 'Split week', type: 'place', start: '2027-02-28', len: 3 },
    { id: 'k', name: 'Sam: Tokyo', type: 'event', unit: 'day', parent: 'split', len: 3 },
    { id: 'l', name: 'Alex: Berlin', type: 'event', unit: 'day', parent: 'split', len: 3 },
  ]);
  const at = M.layout(doc), bd = C.beds(doc, at, false);
  assert.ok(bd?.split);
  assert.deepEqual(apartRuns(bd).map((r) => [r.a - day('2027-02-28'), r.b - r.a, r.text]), [[0, 3, 'Sam: Tokyo · Alex: Berlin']]);
  const gaps = gapsOf(bd);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].apart, 'Sam: Tokyo · Alex: Berlin');
  assert.deepEqual(entriesOf(doc, at, false, bd).flatMap((e) => (e.stop ? [e.stop.name] : [])), ['Manila']);
});

test('unknown prices read as unpriced, not free', () => {
  const doc = gappy();
  assert.equal(costText(408, 0, 'USD'), '$408');
  assert.equal(costText(408, 2, 'USD'), '$408 + 2 unpriced');
  assert.equal(costText(0, 1, 'USD'), 'no price');
  assert.equal(unpricedCount(doc, false, 'all'), 2, 'the Porto room and the bus');
  assert.equal(unpricedCount(doc, false, 'stays'), 1);
  assert.equal(unpricedCount(doc, false, 'all', 'a'), 0);
});

test('a move shows its own mode icon', () => {
  const doc = gappy();
  assert.equal(modeIcon(/** @type {M.Item} */ (M.byId(doc, 'bus'))), M.MODES.bus[1]);
});
