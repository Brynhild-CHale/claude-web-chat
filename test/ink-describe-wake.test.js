// What Claude reads about a stroke, daemon side (annotation engine tranche 4,
// plan 4F.2, U562; lib/server/index.js elementWake, lib/channel/policy
// elementItem, lib/core/ink-shape describeOf). A stroke-shaped plug-in type
// (its element.json declares exactly lib/core/strokes' STROKE_KEYS ∪
// DESCRIBE_KEYS, place 'box', input 'strokes', a wake) is approved the
// reviewed way (test-support/element-type-fixture) and written through the
// routes, so the log's one writer stores every version.
//
// Pinned here:
//   - three shared strokes on one svg → the one queue item carries describe
//     {shape, confidence, count 3, bbox: the union}, its summary names the
//     shape and the count, and its excerpt is the masked text under the
//     strokes, member by member;
//   - the excerpt switch off → no excerpt, describe kept;
//   - a value the redactor knows is masked in the log (the one writer) and in
//     the excerpt; one it learns after the write is masked at the raise;
//   - a private stroke is never enqueued and its add raises nothing; a group
//     of two shared and one private stroke describes count 2, and neither the
//     item, its describe nor its excerpt carries the private stroke's text or
//     extent;
//   - a stroke on another target starts its own group.
//   - a member leaving a queued group (its un-share), the newest or not,
//     takes the group's stale describe with it and the summary reads
//     `<label> ×N` (lib/server/domain/queue removeByElement); an edit of the
//     newest member refreshes the describe (refreshElement).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const crypto = require('crypto');

const { withServer, waitUntil } = require('../test-support/helpers');
const { approveElementPack } = require('../test-support/element-type-fixture');
const { STROKE_KEYS, DESCRIBE_KEYS } = require('../lib/core/strokes');
const { SHAPES } = require('../lib/core/ink-shape');
const { setSwitch } = require('../lib/core/excerpts');
const { projectPaths } = require('../lib/core/paths');

const TYPE = 'tq-strokes';
const PANE = '<div><svg class="a" viewBox="0 0 200 100"><text x="10" y="20">Revenue fell</text></svg>'
  + '<svg class="b" viewBox="0 0 200 100"><text x="10" y="20">Other</text></svg></div>';
const TARGET = (sib = 0) => ({ v: 1, kind: 'element', mount: 'm1', at: { path: [0], sib }, fp: { tag: 'svg', id: '', cls: [sib ? 'b' : 'a'], head: '', attrs: [], parent: 'div' }, rows: [] });

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}

async function setup(t, opts = {}) {
  const d = await withServer(t, opts);
  approveElementPack(d, {
    name: 'tq-strokes-pack', type: TYPE,
    json: {
      label: 'Ink', input: 'strokes', place: 'box', wake: true, anchors: ['element'],
      payload: { keys: [...STROKE_KEYS, ...DESCRIBE_KEYS] },
    },
  });
  await ok(d.api.post('/api/render', { id: 'm1', html: PANE }), 'render m1');
  return d;
}

// A horizontal stroke from (x0, y) to (x1, y) in frame units.
const line = (x0, x1, y) => {
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push(Math.round((x0 + ((x1 - x0) * i) / 10) * 1e4) / 1e4, y, 0.5, i * 8);
  return pts;
};
function stroke(d, { y = 0.3, x0 = 0.05, x1 = 0.45, shared = true, text, sib = 0 } = {}) {
  const payload = {
    shared, tool: 'pen', width: 0.01, colour: 'accent', points: line(x0, x1, y), stride: 4, aspect: 2,
    bbox: [x0, y, x1 - x0, 0],
    ...(text ? { text_under: text, text_box: [0.05, y - 0.15, 0.4, 0.14] } : {}),
  };
  return ok(d.api.post('/api/elements', { type: TYPE, anchor: TARGET(sib), payload }), 'POST stroke').then((b) => b.element);
}
const itemsOf = (d) => (d.srv.state.queue || []).filter((it) => it && it.kind === 'element' && it.type === TYPE);
const holds = (it, id) => (it.element_ids || [it.element_id]).includes(id);

test('three shared strokes: one item, describe {shape, confidence, count 3, the union bbox}, the shape in its summary, the masked text under them as its excerpt', async (t) => {
  const d = await setup(t);
  const a = await stroke(d, { y: 0.3, text: 'Revenue fell' });
  const b = await stroke(d, { y: 0.5, x0: 0.1, x1: 0.6, text: 'by 4 %' });
  const c = await stroke(d, { y: 0.7, text: 'Revenue fell' });
  const items = itemsOf(d);
  assert.equal(items.length, 1, 'one group in the queue');
  const it = items[0];
  for (const e of [a, b, c]) assert.ok(holds(it, e.id), `${e.id} is a member`);
  assert.deepStrictEqual(Object.keys(it.describe).sort(), ['bbox', 'confidence', 'count', 'shape']);
  assert.ok(SHAPES.includes(it.describe.shape));
  assert.equal(it.describe.shape, 'underline', 'three flat strokes under their words');
  assert.equal(typeof it.describe.confidence, 'number');
  assert.equal(it.describe.count, 3);
  assert.deepStrictEqual(it.describe.bbox, [0.05, 0.3, 0.55, 0.4]);
  assert.match(it.summary, /^Ink · underline · 3 strokes · p\d+@1$/);
  assert.deepStrictEqual(it.excerpt, [
    { id: a.id, text: 'Revenue fell' }, { id: b.id, text: 'by 4 %' }, { id: c.id, text: 'Revenue fell' },
  ], 'each member\'s own passage, in order');
  assert.ok(!JSON.stringify(it.describe).includes('Revenue'), 'no page text in describe');
  assert.ok(!it.summary.includes('Revenue'), 'nor in the summary');
});

test('the excerpt switch off: no excerpt, describe kept', async (t) => {
  const d = await setup(t);
  setSwitch(d.root, false);
  await stroke(d, { text: 'Revenue fell' });
  await stroke(d, { y: 0.5, text: 'by 4 %' });
  const [it] = itemsOf(d);
  assert.ok(it, 'queued');
  assert.equal('excerpt' in it, false);
  assert.equal(it.describe.count, 2);
  assert.ok(SHAPES.includes(it.describe.shape));
});

test('a value the redactor knows is masked by the log\'s one writer and in the excerpt', async (t) => {
  const value = `wclearned${crypto.randomBytes(16).toString('hex')}`;
  const d = await setup(t, { seed: ({ root }) => fs.writeFileSync(projectPaths(root).captureToken, `${value}\n`) });
  const e = await stroke(d, { text: `the key is ${value} here` });
  const log = fs.readFileSync(projectPaths(d.root).elementsLog, 'utf8');
  assert.ok(log.includes('the key is'), 'the text under is stored');
  assert.ok(!log.includes(value), 'masked before the bytes land');
  const [it] = itemsOf(d);
  assert.equal(it.element_id, e.id);
  assert.equal(typeof it.excerpt, 'string');
  assert.ok(it.excerpt.startsWith('the key is '), it.excerpt);
  assert.ok(!it.excerpt.includes(value), 'masked in the excerpt');

  // Learned after the write: stored as written, masked when it is raised.
  const later = `wclearned${crypto.randomBytes(16).toString('hex')}`;
  const l = await stroke(d, { y: 0.6, text: `now ${later} too` });
  assert.ok(fs.readFileSync(projectPaths(d.root).elementsLog, 'utf8').includes(later), 'not known at the write: stored as written');
  fs.writeFileSync(projectPaths(d.root).captureToken, `${later}\n`);
  await waitUntil(async () => !JSON.stringify((await d.api.get(`/api/elements?type=${TYPE}`)).json).includes(later),
    { timeout: 6000, what: 'the redactor learned the value' });
  const c = d.srv.state.elementWords({ kind: 'element', type: TYPE, op: 'send', id: l.id, v: 1, shared: true, has: true, mount: 'm1' });
  assert.equal(c.action, 'enqueue');
  assert.ok(c.item.excerpt.startsWith('now '), c.item.excerpt);
  assert.ok(!c.item.excerpt.includes(later), 'masked at the raise');
});

test('a private stroke is never enqueued and its add raises nothing', async (t) => {
  const d = await setup(t);
  const before = (d.srv.state.queue || []).length;
  const p = await stroke(d, { shared: false, text: 'private words' });
  assert.equal(p.shared, false);
  assert.equal((d.srv.state.queue || []).length, before, 'nothing queued');
  assert.equal(itemsOf(d).length, 0);
  assert.ok(!JSON.stringify(d.srv.state.queue || []).includes('private words'));
  // Its add raises nothing through the one word-reader either.
  const words = d.srv.state.elementWords({ kind: 'element', type: TYPE, op: 'add', id: p.id, v: 1, shared: false, has: true, mount: 'm1' });
  assert.equal(words, null);
});

test('two shared and one private stroke: describe counts 2; the private stroke\'s text and extent never reach the item', async (t) => {
  const d = await setup(t);
  const a = await stroke(d, { y: 0.3, text: 'Revenue fell' });
  const p = await stroke(d, { y: 0.9, x0: 0.0, x1: 0.95, shared: false, text: 'secret line' });
  const b = await stroke(d, { y: 0.5, text: 'by 4 %' });
  const [it] = itemsOf(d);
  assert.ok(it, 'queued');
  assert.ok(!holds(it, p.id), 'the private stroke is no member');
  assert.equal(it.describe.count, 2);
  assert.deepStrictEqual(it.describe.bbox, [0.05, 0.3, 0.4, 0.2], 'the shared members\' extent alone');
  const all = JSON.stringify(it);
  assert.ok(!all.includes('secret'), 'no private text');
  assert.ok(!all.includes('0.95') && !all.includes('0.9,'), 'no private extent');
  assert.deepStrictEqual(it.excerpt, [{ id: a.id, text: 'Revenue fell' }, { id: b.id, text: 'by 4 %' }]);
  // Sharing it later raises it with the group now three strong.
  await ok(d.api.patch(`/api/elements/${p.id}`, { payload: { shared: true } }), 'share it');
  const [after] = itemsOf(d);
  assert.ok(holds(after, p.id));
  assert.equal(after.describe.count, 3);
  assert.deepStrictEqual(after.describe.bbox, [0, 0.3, 0.95, 0.6]);
});

test('a stroke on another target is its own group', async (t) => {
  const d = await setup(t);
  await stroke(d, { y: 0.3, text: 'Revenue fell' });
  await stroke(d, { y: 0.5, text: 'by 4 %' });
  const o = await stroke(d, { sib: 1, y: 0.3, text: 'Other' });
  const [it] = itemsOf(d);
  assert.equal(it.element_id, o.id, 'the newest member');
  // The item folds both groups (U562a, PQ-4F-3): each keeps its own guess,
  // newest last; the top-level count sums them, the summary is the newest's.
  assert.deepStrictEqual(it.describe.groups.map((g) => g.count), [2, 1], 'the first svg\'s two, then the other svg\'s group of one');
  assert.deepStrictEqual(it.describe.groups[1].element_ids, [o.id]);
  assert.equal(it.describe.shape, it.describe.groups[1].shape, 'the newest group\'s shape on top');
  assert.equal(it.describe.count, 3);
  assert.match(it.summary, / · 1 stroke · /);
});

// A member leaving a queued group (its un-share; K.2-10's removeByElement)
// takes the group's composed describe with it: the count and the extent were
// composed over the shared members at the last raise, so a stale one would
// carry an unshared stroke's count and extent to Claude (J2, AD5). The
// summary falls back to the `<label> ×N` form until the next raise.
const { wakeEnvelope } = require('../lib/channel/envelope');

test('un-sharing a queued group\'s middle member drops the stale describe and recomputes the summary', async (t) => {
  const d = await setup(t);
  const a = await stroke(d, { y: 0.3, text: 'Revenue fell' });
  const m = await stroke(d, { y: 0.9, x0: 0, x1: 0.95, text: 'middle line' });
  const c = await stroke(d, { y: 0.5, text: 'by 4 %' });
  const [before] = itemsOf(d);
  assert.equal(before.describe.count, 3, 'three strong before');
  assert.deepStrictEqual(before.describe.bbox, [0, 0.3, 0.95, 0.6]);
  await ok(d.api.patch(`/api/elements/${m.id}`, { payload: { shared: false } }), 'un-share the middle one');
  const [it] = itemsOf(d);
  assert.ok(it, 'the group stays');
  assert.ok(!holds(it, m.id), 'the middle one left');
  assert.ok(holds(it, a.id) && holds(it, c.id));
  assert.equal(it.element_id, c.id, 'the newest stays the newest');
  assert.ok(!(it.describe && it.describe.count === 3), 'no describe counting 3');
  assert.ok(!(it.describe && JSON.stringify(it.describe.bbox) === JSON.stringify([0, 0.3, 0.95, 0.6])), 'no describe with the old extent');
  assert.equal('describe' in it, false, 'the stale describe is dropped');
  assert.equal(it.summary, 'Ink ×2', 'the summary recomputed');
  const { content } = wakeEnvelope([it], {});
  assert.ok(!content.includes('3 strokes'), 'the envelope carries no old count');
  assert.ok(!content.includes('0.95'), 'nor the unshared stroke\'s extent');
  assert.ok(!content.includes('middle line'), 'nor its passage');
});

test('un-sharing a queued group\'s newest member drops the stale describe and recomputes the summary', async (t) => {
  const d = await setup(t);
  const a = await stroke(d, { y: 0.3, text: 'Revenue fell' });
  const b = await stroke(d, { y: 0.5, text: 'by 4 %' });
  const n = await stroke(d, { y: 0.9, x0: 0, x1: 0.95, text: 'newest line' });
  const [before] = itemsOf(d);
  assert.equal(before.element_id, n.id);
  assert.equal(before.describe.count, 3);
  await ok(d.api.patch(`/api/elements/${n.id}`, { payload: { shared: false } }), 'un-share the newest one');
  const [it] = itemsOf(d);
  assert.ok(it, 'the group stays');
  assert.ok(!holds(it, n.id));
  assert.ok(holds(it, a.id) && holds(it, b.id));
  assert.equal('describe' in it, false, 'the stale describe is dropped');
  assert.equal(it.summary, 'Ink ×2');
  const { content } = wakeEnvelope([it], {});
  assert.ok(!content.includes('3 strokes'), 'the envelope carries no old count');
  assert.ok(!content.includes('0.95'), 'nor the unshared stroke\'s extent');
  assert.ok(!content.includes('newest line'), 'nor its passage');
});

test('an edit of a queued group\'s newest member refreshes the group\'s describe', async (t) => {
  const d = await setup(t);
  await stroke(d, { y: 0.3, text: 'Revenue fell' });
  const n = await stroke(d, { y: 0.5, text: 'by 4 %' });
  const [before] = itemsOf(d);
  assert.deepStrictEqual(before.describe.bbox, [0.05, 0.3, 0.4, 0.2]);
  await ok(d.api.patch(`/api/elements/${n.id}`, { payload: { points: line(0.05, 0.45, 0.7), bbox: [0.05, 0.7, 0.4, 0] } }), 'move the newest');
  const [it] = itemsOf(d);
  assert.equal(it.element_id, n.id);
  assert.equal(it.describe.count, 2);
  assert.deepStrictEqual(it.describe.bbox, [0.05, 0.3, 0.4, 0.4], 'the refreshed extent');
});
