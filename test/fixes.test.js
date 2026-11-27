import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../public/app/model.js';
import * as T from '../public/app/trip.js';
import * as P from '../public/app/places.js';

const opts = { optional: false, filter: /** @type {const} */ ('all') };

test('dragging a stay start stops at the end of the stay before it', () => {
  const doc = T.decidingSample();
  const tpe = M.layout(doc).get('tw-tpe'), tnn = M.layout(doc).get('tw-tnn');
  M.setEdge(doc, 'tw-tnn', 'start', tnn.start - 5);
  assert.equal(Math.floor(M.layout(doc).get('tw-tnn').start), Math.round(tpe.end));
});

test('dragging a stay end stops at the start of a stay that does not follow it', () => {
  const doc = T.decidingSample(), at = M.layout(doc);
  const before = at.get('tw-tpe').end;
  M.setEdge(doc, 'tw-tpe', 'end', before + 3);
  assert.ok(M.layout(doc).get('tw-tpe').end >= before, 'a follower is pushed, so growing still works');
});

test('fixOverlaps shortens the earlier of two overlapping stays', () => {
  const doc = T.decidingSample();
  const tnn = M.byId(doc, 'tw-tnn');
  const s = M.layout(doc).get('tw-tpe').start;
  delete tnn.after; tnn.start = M.isoOf(s + 3);
  assert.ok(M.layout(doc).get('tw-tpe').end > M.layout(doc).get('tw-tnn').start, 'they overlap to begin with');
  assert.ok(M.fixOverlaps(doc, 'tw', false));
  const at = M.layout(doc);
  assert.ok(at.get('tw-tpe').end <= at.get('tw-tnn').start + 1e-9);
});

test('insertItem keeps siblings in date order', () => {
  const doc = M.normalize({ v: 2, items: [
    { id: 'a', kind: 'item', name: 'A', start: '2026-03-01', unit: 'night', len: 2, committed: true, costs: [] },
    { id: 'c', kind: 'item', name: 'C', start: '2026-03-10', unit: 'night', len: 2, committed: true, costs: [] },
  ] });
  M.insertItem(doc, { ...doc.items[0], id: 'b', name: 'B', start: '2026-03-05' });
  assert.deepEqual(doc.items.map((it) => it.id), ['a', 'b', 'c']);
});

test('pastWindows flags a return after the visa ends, naming the trip', () => {
  const doc = T.decidingSample();
  assert.equal(P.pastWindows(doc, false).length, 0);
  M.byId(doc, 'tw-tnn').len = 17;
  for (const k of M.kidsOf(doc, 'tw-tnn')) k.len = 17;
  const hits = P.pastWindows(doc, false);
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /→ SGN .* after Vietnam e-visa ends/);
  assert.equal(hits[0].trip, 'Taiwan');
});

test('rivalDelta compares per night when lengths differ', () => {
  const doc = T.decidingSample();
  const [pick, other] = M.kidsOf(doc, 'tw-tpe');
  assert.match(T.rivalDelta(doc, other.id, pick.id, opts), /^[+−-]\$\d/);
  other.len = (pick.len ?? 1) + 2;
  assert.match(T.rivalDelta(doc, other.id, pick.id, opts), /\d+n vs \d+n · [+−-]\$\d+\/night/);
  assert.equal(T.rivalDelta(doc, other.id, pick.id, { ...opts, filter: 'none' }), '');
});
