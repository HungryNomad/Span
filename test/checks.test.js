import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../public/app/model.js';
import * as C from '../public/app/checks.js';
import { missingMoves } from '../public/app/places.js';

/** A made-up plan from item fields, normalized. */
const plan = (/** @type {object[]} */ items) => M.normalize({ v: 2, currency: 'USD', people: 2, items: items.map((f) => M.makeItem(/** @type {any} */ (f))), routes: {} });
const per = (/** @type {number} */ amount) => ({ label: 'Room', type: 'per', amount, pp: false });
const day = M.dayOf;

test('beds counts a night booked twice once per night, and a gap by its placeholder', () => {
  const doc = plan([
    { id: 'a', name: 'Hanoi hotel', type: 'stay', start: '2027-01-01', len: 4, costs: [per(30)] },
    { id: 'b', name: 'Hanoi flat', type: 'stay', start: '2027-01-03', len: 3, costs: [per(20)] },
    { id: 'ph', name: 'Hue: not booked', type: 'stay', start: '2027-01-06', len: 2, committed: false },
    { id: 'c', name: 'Hoi An room', type: 'stay', start: '2027-01-08', len: 2 },
  ]);
  const bd = C.beds(doc, M.layout(doc), false);
  assert.ok(bd && !bd.split);
  const d0 = day('2027-01-01');
  assert.deepEqual(C.doubleRuns(bd).map((r) => [r.a - d0, r.b - d0, r.ids]), [[2, 4, ['a', 'b']]]);
  assert.deepEqual(C.gapRuns(bd).map((r) => [r.a - d0, r.b - d0, r.ids]), [[5, 7, ['ph']]]);
  assert.equal(C.nightsIn(C.gapRuns(bd)), 2);
  // Counting optional stays as booked closes the gap.
  assert.equal(C.gapRuns(C.beds(doc, M.layout(doc), true)).length, 0);
});

test('a city with nights and nothing inside counts as a bed', () => {
  const doc = plan([
    { id: 'sg', name: 'Saigon', type: 'place', start: '2027-01-01', len: 3 },
    { id: 'h', name: 'Hanoi hotel', type: 'stay', start: '2027-01-04', len: 2 },
  ]);
  assert.equal(C.gapRuns(C.beds(doc, M.layout(doc), false)).length, 0);
});

test('people named by leading names get their own lines, with where they are', () => {
  const doc = plan([
    { id: 's0', name: 'Manila flat', type: 'stay', start: '2027-02-26', len: 2 },
    { id: 'split', name: 'Split week', type: 'place', start: '2027-02-28', len: 3 },
    { id: 'k', name: 'Sam: Tokyo', type: 'event', unit: 'day', parent: 'split', len: 3 },
    { id: 'l', name: 'Alex: Berlin', type: 'event', unit: 'day', parent: 'split', len: 3 },
  ]);
  assert.deepEqual(C.peopleOf(doc), ['Sam', 'Alex']);
  assert.equal(C.whoOf(doc, /** @type {M.Item} */ (M.byId(doc, 'k'))), 'Sam');
  assert.equal(C.whoOf(doc, /** @type {M.Item} */ (M.byId(doc, 's0'))), undefined);
  const bd = /** @type {C.Beds} */ (C.beds(doc, M.layout(doc), false));
  assert.ok(bd.split);
  assert.deepEqual(bd.lines.map((l) => [l.who, l.runs.at(-1)?.where]), [['Sam', 'Tokyo'], ['Alex', 'Berlin']]);
  // The week apart is one gap for everyone, not one per person.
  assert.deepEqual(C.gapRuns(bd).map((r) => [r.b - r.a, r.who]), [[3, []]]);
});

test('a lone "Trip:" lead is a label, not a person; an explicit who is', () => {
  const doc = plan([
    { id: 't', name: 'Trip: Japan', type: 'stay', start: '2027-03-01', len: 2 },
    { id: 'w', name: 'Ryokan', type: 'stay', start: '2027-03-03', len: 1, who: 'Sam' },
  ]);
  assert.deepEqual(C.peopleOf(doc), ['Sam']);
});

test('unpriced stays and moves are counted, free events are not', () => {
  const doc = plan([
    { id: 'p', name: 'Paid', type: 'stay', start: '2027-01-01', len: 2, costs: [per(10)] },
    { id: 'u', name: 'Unpriced', type: 'stay', start: '2027-01-03', len: 2 },
    { id: 'f', name: 'Flight', type: 'transport', unit: 'hour', start: '2027-01-05', at: 9, len: 2 },
    { id: 'e', name: 'Market', type: 'event', unit: 'hour', start: '2027-01-04', at: 10, len: 2 },
  ]);
  assert.deepEqual(C.unpricedIn(doc, true).map((it) => it.id).sort(), ['f', 'u']);
  assert.equal(C.isUnpriced(/** @type {M.Item} */ (M.byId(doc, 'e'))), false);
});

test('a placeholder move between two cities is not a missing move', () => {
  const doc = plan([
    { id: 'a', name: 'Lisbon flat', type: 'stay', start: '2027-01-01', len: 3 },
    { id: 'bus', name: 'Lisbon → Porto: not booked', type: 'transport', mode: 'bus', unit: 'hour', start: '2027-01-04', at: 9, len: 3, committed: false },
    { id: 'b', name: 'Porto room', type: 'stay', start: '2027-01-04', len: 2 },
  ]);
  assert.equal(missingMoves(doc, M.layout(doc), false).length, 0);
});
