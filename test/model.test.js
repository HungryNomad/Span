import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../public/app/model.js';

/** Fallback start day used by tests, so results don't depend on today. */
const T0 = M.dayOf('2026-01-01');

test('dates round-trip', () => {
  assert.equal(M.isoOf(M.dayOf('2026-10-20')), '2026-10-20');
  assert.ok(Number.isNaN(M.dayOf('2026-1-2')));
  assert.equal(M.hhmm(13.5), '13:30');
  assert.equal(M.parseHhmm('08:50'), 8 + 50 / 60);
});

test('v1 plans upgrade into a group of options with the same costs', () => {
  const doc = M.normalize(M.sampleV1());
  assert.equal(doc.v, 2);
  const g = doc.items.find((it) => it.kind === 'group');
  assert.equal(g.after, 'vn');
  assert.deepEqual(M.kidsOf(doc, g.id).map((it) => it.name), ['Bangkok', 'Taipei', 'Both']);
  const both = M.kidsOf(doc, g.id)[2];
  assert.deepEqual(M.kidsOf(doc, both.id).map((it) => it.id), ['both-bkk', 'both-tpe']);

  const at = M.layout(doc), vn = at.get('vn');
  assert.equal(M.isoOf(vn.end), '2026-12-28');
  assert.equal(at.get('bkk').start, vn.end);
  assert.equal(at.get('both-tpe').start, vn.end + 5);
  assert.equal(at.get(both.id).end, vn.end + 10);
  assert.equal(M.pivotOf(doc).id, 'vn');
  assert.equal(M.focusGroupOf(doc, M.pivotOf(doc)).id, g.id);
  assert.deepEqual(M.departRoutes(doc, 'vn'), ['SGN-BKK', 'SGN-TPE']);

  // Same numbers as round 1's path costs.
  const bkk = M.optionCost(doc, 'bkk', 'vn', 69, false);
  assert.equal(bkk.stay, 10 * (46 + 30));
  assert.equal(bkk.travel, doc.routes['SGN-BKK'].fares['2026-12-28']);
  const b = M.optionCost(doc, both.id, 'vn', 69, false);
  assert.equal(b.travel, M.fareOn(doc.routes['SGN-BKK'], M.dayOf('2026-12-28')) + M.fareOn(doc.routes['BKK-TPE'], M.dayOf('2027-01-02')));
  doc.routes['SGN-BKK'].fares['2026-12-29'] = 1;
  assert.equal(M.optionCost(doc, 'bkk', 'vn', 70, false).travel, 1);
});

test('normalize is idempotent and drops junk', () => {
  for (const d of [M.sampleDoc(), M.normalize(M.sampleV1())]) assert.deepEqual(M.normalize(structuredClone(d)), d);
  const d = M.normalize({ v: 2, items: [
    { id: 'a', len: 200, minLen: 5, maxLen: 9, after: 'gone', start: 'x', links: ['javascript:alert(1)', 'https://www.agoda.com/x'], images: ['nope'] },
    { id: 'a' }, { kind: 'item' }, 7,
    { id: 'b', parent: 'c' }, { id: 'c', parent: 'b' },
  ], routes: { x: 3 } });
  assert.deepEqual(d.items.map((it) => it.id), ['a', 'b', 'c']);
  assert.equal(d.items[0].len, 9);
  assert.equal(d.items[0].after, undefined);
  assert.deepEqual(d.items[0].links, ['https://www.agoda.com/x']);
  assert.deepEqual(d.items[0].images, []);
  assert.ok(!d.items[1].parent || !d.items[2].parent, 'parent loop broken');
  assert.deepEqual(d.routes, {});
});

test('only committed items and group picks count; per-person scales', () => {
  const doc = M.normalize({ v: 2, people: 2, items: [
    { id: 'trip', start: '2026-03-01', len: 4, costs: [{ type: 'fixed', amount: 100, pp: true }] },
    { id: 'r1', parent: 'trip', len: 2, costs: [{ type: 'per', amount: 50 }] },
    { id: 'r2', parent: 'trip', offset: 2, len: 2, committed: false, costs: [{ type: 'per', amount: 70 }] },
    { id: 'g', kind: 'group', parent: 'trip' },
    { id: 'x', parent: 'g', len: 1, costs: [{ type: 'fixed', amount: 10 }] },
    { id: 'y', parent: 'g', len: 1, costs: [{ type: 'fixed', amount: 1 }] },
  ] });
  assert.deepEqual([...M.counted(doc, false)].sort(), ['g', 'r1', 'trip', 'x']);
  assert.equal(M.total(doc).stay, 200 + 100 + 10);
  assert.equal(M.total(doc, { optional: true }).stay, 200 + 100 + 140 + 10);
  M.setRank(doc, 'y', 0);
  assert.equal(M.total(doc).stay, 200 + 100 + 1);
  assert.deepEqual(M.kidsOf(doc, 'g').map((it) => it.id), ['y', 'x']);
});

test('coverage finds gaps and overlaps', () => {
  const doc = M.sampleDoc(), at = M.layout(doc);
  const vn = M.coverage(doc, at, false).get('vn');
  assert.deepEqual(vn.gaps.map(([a, b]) => b - a), [69 - 58]);
  assert.deepEqual(vn.overlaps, []);
  const opt = M.coverage(doc, at, true).get('vn');
  assert.deepEqual(opt.overlaps.map(([a, b]) => b - a), [58 - 54]);
  assert.equal(opt.gaps.length, 0);
});

test('hour items sit at their time of day', () => {
  const doc = M.normalize({ v: 2, items: [
    { id: 'sat', unit: 'day', start: '2026-05-02', len: 1 },
    { id: 'lunch', parent: 'sat', unit: 'hour', at: 12.5, len: 1.5 },
    { id: 'bar', unit: 'hour', after: 'lunch', len: 2 },
    { id: 'friend', parent: 'sat' },
    { id: 'v', parent: 'friend', unit: 'hour', at: 20, len: 3 },
  ] });
  const at = M.layout(doc, {}, T0), d = M.dayOf('2026-05-02');
  assert.equal(at.get('lunch').start, d + 12.5 / 24);
  assert.equal(at.get('bar').start, d + 14 / 24);
  assert.equal(at.get('friend').end, d + 23 / 24);
});

test('cycles do not hang layout', () => {
  const d = M.normalize({ v: 2, items: [
    { id: 'a', after: 'b', len: 1 }, { id: 'b', after: 'a', len: 1 },
    { id: 'p' }, { id: 'k', parent: 'p', after: 'p' },
  ] });
  assert.equal(M.layout(d, {}, 100).size, 4);
});

test('removeItem takes children, frees followers and prunes routes', () => {
  const doc = M.normalize(M.sampleV1());
  const both = doc.items.find((it) => it.name === 'Both');
  const imgs = M.removeItem(doc, 'both-bkk');
  assert.deepEqual(imgs, []);
  const t = M.byId(doc, 'both-tpe');
  assert.equal(t.after, undefined);
  assert.equal(t.start, '2027-01-02');
  assert.ok(doc.routes['BKK-TPE']);
  M.removeItem(doc, both.id);
  assert.equal(M.byId(doc, 'both-tpe'), undefined);
  assert.equal(doc.routes['BKK-TPE'], undefined);
});

test('link chips name known sites', () => {
  assert.equal(M.siteOf('https://www.booking.com/hotel/x'), 'Booking');
  assert.equal(M.siteOf('https://www.airbnb.co.uk/rooms/1'), 'Airbnb');
  assert.equal(M.siteOf('https://example.org/a'), 'example.org');
  assert.ok(!M.isLink('javascript:alert(1)'));
});
