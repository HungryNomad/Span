import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../public/app/model.js';

test('dates round-trip', () => {
  assert.equal(M.isoOf(M.dayOf('2026-10-20')), '2026-10-20');
  assert.ok(Number.isNaN(M.dayOf('2026-1-2')));
  assert.equal(M.hhmm(13.5), '13:30');
  assert.equal(M.parseHhmm('08:50'), 8 + 50 / 60);
});

test('sample plan lays out chains after the pivot', () => {
  const doc = M.sampleDoc();
  const at = M.layout(doc);
  const vn = at.get('vn');
  assert.equal(M.isoOf(vn.end), '2026-12-28');
  assert.equal(at.get('bkk').start, vn.end);
  assert.equal(at.get('both-tpe').start, vn.end + 5);
  assert.equal(M.pivotOf(doc).id, 'vn');
  assert.deepEqual(M.pathsFrom(doc, 'vn'), [['bkk'], ['tpe'], ['both-bkk', 'both-tpe']]);
});

test('path cost follows the pivot length and dated fares', () => {
  const doc = M.sampleDoc();
  const c = M.pathCost(doc, ['bkk'], 'vn', 69);
  assert.equal(c.stay, 10 * (46 + 30));
  assert.equal(c.travel, doc.routes['SGN-BKK'].fares['2026-12-28']);
  doc.routes['SGN-BKK'].fares['2026-12-29'] = 1;
  assert.equal(M.pathCost(doc, ['bkk'], 'vn', 70).travel, 1);
  const both = M.pathCost(doc, ['both-bkk', 'both-tpe'], 'vn', 69);
  assert.equal(both.travel, M.fareOn(doc.routes['SGN-BKK'], M.dayOf('2026-12-28')) + M.fareOn(doc.routes['BKK-TPE'], M.dayOf('2027-01-02')));
});

test('normalize drops junk, clamps ranges and keeps valid plans intact', () => {
  assert.deepEqual(M.normalize(M.sampleDoc()), M.sampleDoc());
  const d = M.normalize({ bars: [{ id: 'a', kind: 'stay', nights: 200, minNights: 5, maxNights: 9, after: 'gone', start: 'x' }, { kind: 'stay' }, 7], routes: { x: 3 } });
  assert.equal(d.bars.length, 1);
  assert.equal(d.bars[0].nights, 9);
  assert.equal(d.bars[0].after, undefined);
  assert.deepEqual(d.routes, {});
});

test('cycles do not hang layout', () => {
  const d = M.normalize({ bars: [
    { id: 'a', kind: 'stay', after: 'b', nights: 1 },
    { id: 'b', kind: 'stay', after: 'a', nights: 1 },
  ] });
  assert.equal(M.layout(d, {}, 100).size, 2);
  assert.deepEqual(M.pathsFrom(d, 'a'), [['b']]);
});

test('removeBar frees followers and prunes routes', () => {
  const doc = M.sampleDoc();
  M.removeBar(doc, 'both-bkk');
  const t = doc.bars.find((b) => b.id === 'both-tpe');
  assert.equal(t.after, undefined);
  assert.equal(t.start, '2027-01-02');
  assert.ok(doc.routes['BKK-TPE']);
  M.removeBar(doc, 'tpe');
  assert.ok(doc.routes['SGN-TPE'] === undefined);
});
