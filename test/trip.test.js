import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../public/app/model.js';
import * as T from '../public/app/trip.js';
import * as P from '../public/app/places.js';

const opts = { optional: false, filter: /** @type {const} */ ('all') };

test('the still-deciding sample forks after Saigon and totals each trip', () => {
  const doc = T.decidingSample(), at = M.layout(doc);
  assert.equal(T.forkOf(doc)?.id, 'next');
  assert.equal(M.pick(M.total(doc, { at }), 'all'), 3576);
  assert.equal(T.valueOf(doc, 'th', { ...opts, at }), 2920);
  assert.equal(T.valueOf(doc, 'tw', { ...opts, at }), 4230);
  assert.equal(T.totalIfPicked(doc, 'tw', opts), 4886);
  assert.equal(M.kidsOf(doc, 'next')[0].id, 'th', 'totalIfPicked leaves the plan as it was');
  assert.deepEqual(T.costRange(doc, 'th', { ...opts, at }), [2720, 3284]);
  assert.deepEqual(T.costRange(doc, 'next', { ...opts, at }), [2720, 4525]);
  assert.equal(M.coverage(doc, at, false).size, 0, 'no gaps or overlaps');
});

test('picking an option re-ranks it without touching the original', () => {
  const doc = T.decidingSample(), copy = T.withPick(doc, 'th-ari');
  assert.equal(M.kidsOf(copy, 'th-bkk')[0].id, 'th-ari');
  assert.equal(M.kidsOf(doc, 'th-bkk')[0].id, 'th-suk');
});

test('sleeps and hops follow the picks', () => {
  const doc = T.decidingSample(), at = M.layout(doc);
  assert.deepEqual(T.sleeps(doc, at, false).map((p) => p.item.id), ['sgn', 'th-suk', 'th-nim']);
  const h = T.hops(doc, at, false);
  assert.deepEqual(h.map((x) => [x.from, x.to]), [['SGN', 'BKK'], ['BKK', 'CNX'], ['CNX', 'SGN']]);
  assert.equal(h[0].cost, 192);
});

test('places come from names, codes and ancestors', () => {
  assert.equal(P.cityIn('VietJet SGN → BKK')?.name, 'Saigon');
  assert.equal(P.cityIn('Hồ Chí Minh City')?.name, 'Saigon');
  assert.equal(P.cityIn('Old City guesthouse'), undefined);
  const doc = T.decidingSample();
  assert.equal(P.placeOf(doc, /** @type {M.Item} */ (M.byId(doc, 'th-suk'))).name, 'Bangkok');
  assert.deepEqual(P.legsOf(doc, 'tw'), ['Taipei', 'Tainan']);
});

test('stops merge nights in one place and file each move under the stop it leaves', () => {
  const doc = M.sampleDoc(), { stops } = P.stopsOf(doc, M.layout(doc), false);
  assert.deepEqual(stops.map((s) => s.name), ['Hanoi', 'Hoi An', 'Bangkok']);
  assert.deepEqual(stops[1].hops.map((h) => h.label), ['SGN → BKK'], 'the flight leaves after a gap, from Hoi An');
  const d = T.decidingSample(), s2 = P.stopsOf(d, M.layout(d), false).stops;
  assert.deepEqual(s2.map((s) => s.hops.map((h) => h.to)), [['BKK'], ['CNX'], ['SGN']]);
});

test('night stays without a length stretch over their nights, not a flight home', () => {
  const doc = T.decidingSample(), at = M.layout(doc), th = /** @type {M.Placed} */ (at.get('th'));
  assert.equal(th.end - th.start, 25);
});

test('a change of city with nothing booked between is a missing move', () => {
  const doc = M.normalize({ v: 2, items: [
    { id: 'vn', name: 'Vietnam', start: '2026-11-01' },
    { id: 'han', name: 'Hanoi flat', parent: 'vn', len: 5 },
    { id: 'han2', name: 'Old Quarter hotel, Hanoi', parent: 'vn', offset: 5, len: 2 },
    { id: 'hoi', name: 'Hoi An homestay', parent: 'vn', offset: 7, len: 4 },
    { id: 'x', name: 'Somewhere', parent: 'vn', offset: 11, len: 2 },
  ] });
  const miss = P.missingMoves(doc, M.layout(doc), false);
  assert.deepEqual(miss.map((m) => [m.from, m.to, m.stay.id]), [['Hanoi', 'Hoi An', 'hoi']], 'same city needs nothing; an unknown place is not flagged');
  assert.equal(P.moveParent(doc, M.byId(doc, 'hoi') ?? doc.items[0]), 'vn');
  doc.items.push(M.makeItem({ id: 't', name: 'Hanoi → Da Nang', type: 'transport', unit: 'hour', start: '2026-11-08', at: 10, len: 1.5, parent: 'vn' }));
  assert.equal(P.missingMoves(doc, M.layout(doc), false).length, 0, 'a booked move clears it');
  const deciding = T.decidingSample();
  assert.equal(P.missingMoves(deciding, M.layout(deciding), false).length, 0);
});

test('events are not moves', () => {
  const doc = T.decidingSample();
  doc.items.push(M.makeItem({ id: 'ev', name: 'Muay Thai night', type: 'event', unit: 'hour', parent: 'th', offset: 3, at: 19, len: 3 }));
  const at = M.layout(doc);
  assert.ok(!T.hops(doc, at, false).some((h) => h.item.id === 'ev'));
  assert.equal(M.byId(doc, 'tw-train')?.mode, 'train');
});
