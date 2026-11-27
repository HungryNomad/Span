import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../public/app/model.js';
import * as P from '../public/app/places.js';

/** Day index of an ISO date. */
const day = (/** @type {string} */ iso) => M.dayOf(iso);

/**
 * A made-up plan: a booked stay in Mui Ne, a night with nothing, an
 * unbooked "Saigon?" placeholder, a booked stay in Manila, a split week
 * (Sam in Seoul, Alex in Berlin), then a flight home to Ontario.
 * @returns {M.PlanDoc}
 */
function plan() {
  return M.normalize({ v: 2, currency: 'USD', people: 2, routes: {}, items: [
    { id: 'mn', name: 'Mui Ne', type: 'place', start: '2027-01-01' },
    { id: 'mn-s', name: 'Beach bungalow', type: 'stay', parent: 'mn', len: 4 },
    { id: 'bus', name: 'Mui Ne → Saigon', type: 'transport', unit: 'hour', start: '2027-01-05', at: 9, len: 5 },
    { id: 'sg', name: 'Saigon? Jan 6 to 8: not booked', type: 'stay', start: '2027-01-06', len: 2, committed: false },
    { id: 'fl', name: 'SGN → MNL', type: 'transport', unit: 'hour', start: '2027-01-08', at: 10, len: 3 },
    { id: 'mnl', name: 'Makati flat, Manila', type: 'stay', start: '2027-01-08', len: 3 },
    { id: 'split', name: 'Split week', type: 'place', start: '2027-01-11', len: 3 },
    { id: 'sam', name: 'Sam: Seoul', type: 'event', unit: 'day', parent: 'split', len: 3 },
    { id: 'sam-in', name: 'MNL → ICN', type: 'transport', unit: 'hour', parent: 'sam', at: 8, len: 4 },
    { id: 'alex', name: 'Alex: Berlin', type: 'event', unit: 'day', parent: 'split', len: 3 },
    { id: 'alex-in', name: 'MNL → BER', type: 'transport', unit: 'hour', parent: 'alex', at: 9, len: 14 },
    { id: 'home', name: 'Flight home MNL → ONT', type: 'transport', unit: 'hour', start: '2027-01-14', at: 12, len: 14 },
  ] });
}

test('new cities are known by name and code', () => {
  assert.equal(P.cityIn('Mui Ne')?.name, 'Mui Ne');
  assert.equal(P.cityIn('Phan Thiết resort')?.name, 'Mui Ne');
  assert.equal(P.cityIn('China Airlines MNL → ONT')?.name, 'Manila');
  assert.equal(P.cityIn('ONT')?.name, 'Ontario, CA');
  assert.equal(P.cityIn('Lio Beach, El Nido, Palawan')?.name, 'El Nido');
  for (const n of ['Vung Tau', 'Can Tho', 'Quy Nhon', 'Ninh Binh', 'Ha Giang', 'Kuching', 'Kota Kinabalu', 'Langkawi', 'Boracay', 'Coron', 'Siargao', 'Bohol']) {
    assert.equal(P.cityIn(`Hotel in ${n}`)?.name, n);
  }
});

test('the map route covers every night, first night to the flight home', () => {
  const doc = plan(), r = P.mapRoute(doc, M.layout(doc));
  assert.ok(r);
  assert.equal(r.a, day('2027-01-01'));
  assert.equal(r.last, day('2027-01-14'), 'the slider runs to the flight home');
  const stops = r.stops.map((s) => [s.who, s.name, s.start - r.a, s.end - s.start, s.open]);
  assert.deepEqual(stops, [
    [null, 'Mui Ne', 0, 4, 0],
    [null, '', 4, 1, 1],
    [null, 'Saigon', 5, 2, 2],
    [null, 'Manila', 7, 3, 0],
    ['Sam', 'Seoul', 10, 3, 3],
    ['Alex', 'Berlin', 10, 3, 3],
  ]);
});

test('each person has their own line while apart, ending at home', () => {
  const doc = plan(), r = P.mapRoute(doc, M.layout(doc));
  assert.ok(r);
  const names = (/** @type {string | null} */ who) => r.lines.find((l) => l.who === who)?.points.map((p) => p.city.name);
  assert.deepEqual(names('Sam'), ['Mui Ne', 'Saigon', 'Manila', 'Seoul', 'Manila', 'Ontario, CA']);
  assert.deepEqual(names('Alex'), ['Mui Ne', 'Saigon', 'Manila', 'Berlin', 'Manila', 'Ontario, CA']);
  const sam = /** @type {P.MapPoint[]} */ (r.lines[0].points);
  assert.deepEqual(sam.map((p) => p.open), [false, true, false, true, false, false], 'unbooked stays are open');
});

test('where each person is on a day', () => {
  const doc = plan(), r = P.mapRoute(doc, M.layout(doc));
  assert.ok(r);
  assert.equal(P.mapDay(r, 'Sam', r.a).stop?.name, 'Mui Ne');
  const gap = P.mapDay(r, 'Sam', r.a + 4);
  assert.equal(gap.stop?.name, '', 'a night with nothing booked is a gap');
  assert.equal(gap.city?.name, 'Saigon', 'the marker waits where the bus went');
  assert.equal(P.mapDay(r, 'Sam', r.a + 11).city?.name, 'Seoul');
  assert.equal(P.mapDay(r, 'Alex', r.a + 11).city?.name, 'Berlin');
  const home = P.mapDay(r, 'Alex', r.last);
  assert.equal(home.city?.name, 'Ontario, CA');
  assert.equal(home.hop?.item.id, 'home');
});

test('a plan with nobody named has one line and a new check-in wins an overlap', () => {
  const doc = M.normalize({ v: 2, items: [
    { id: 'a', name: 'Bangkok condo', type: 'stay', start: '2027-02-01', len: 5 },
    { id: 'b', name: 'Saigon flat', type: 'stay', start: '2027-02-04', len: 3 },
  ] });
  const r = P.mapRoute(doc, M.layout(doc));
  assert.ok(r);
  assert.deepEqual(r.lines.map((l) => l.who), [null]);
  assert.deepEqual(r.stops.map((s) => [s.name, s.end - s.start]), [['Bangkok', 3], ['Saigon', 3]]);
  assert.equal(r.last, r.b - 1, 'with no flight home the slider ends on the last night');
  assert.equal(P.mapRoute(M.emptyDoc(), new Map()), null);
});
