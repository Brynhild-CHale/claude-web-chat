// The fixture strokes pack for a caller with no test context (annotation
// engine tranche 5, 5C.1, U641; DECISIONS.md K.2-255 SOAK@strokes-fixture-
// export; rulings U641@private-only H12 (a), U641@judge-stroke-failures I4
// (a), U641@page-stroke-alternation I5 (a), KIND@declared-check C5 (a),
// FRAME@pane-element A9 (c), RECORD@page-kind, UNDO@either-end, AD5/J2).
//
// test-support/element-packs exports stageStrokesFixture(root, {srv}) — the
// fixture staged through test-support/element-type-fixture stageElementPack
// with a cleanup shim — and strokeBodies(...) — four real stroke bodies — so
// the soak (scripts/soak/fixture.js, scripts/soak/drive.js) strokes the
// fixture's type in three frames instead of reading 0 (K.2-255). Pinned here,
// each on a real daemon (withServer, ephemeral loopback ports):
//   (1) stage → {name, record}: quarantined, the forge closed on return; the
//       control row 'pack-approve' (fixture.js's own path) lists the type with
//       its pack and anchors element and page;
//   (2) strokeBodies over fixture.js paneHtml: the element, pane, arrow and
//       margin bodies each accepted, private, a stroke payload; the anchors
//       the svg's record, the outermost element's, and U613's page records;
//       the U579 drive's range-anchored body refused 400
//       anchor-kind-undeclared (why the drive changed);
//   (3) the drive's strokeStep twice: 4 writes per frame split 2/2/2 (an arrow,
//       then a margin stroke), no failure, nothing of the type left live;
//   (4) a refused quarantine POST throws naming its status, and fixture.js
//       stageStrokes logs it and answers null; a root that is not the
//       server's throws.

// The forge is the loopback stand-in: the pack pipeline never probes the gh
// program for it (lib/packs/gh available), as fixture.js stageStrokes says.
process.env.WEB_CHAT_NO_GH = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withServer, tmpRoot } = require('../test-support/helpers');
const packs = require('../test-support/element-packs');
const strokes = require('../lib/core/strokes');
const client = require('../lib/client');
const { projectPaths } = require('../lib/core/paths');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const fixture = require('../scripts/soak/fixture');
const drive = require('../scripts/soak/drive');

const REPO = path.join(__dirname, '..');
const NAME = packs.STROKES_FIXTURE_NAME;
const TYPE = packs.STROKES_FIXTURE_TYPE;

async function ok(p, what) {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}

// The soak's page: the three panes, as the fixture primes them.
async function renderPanes(d) {
  for (const id of fixture.PANES) await ok(d.api.post('/api/render', { id, html: fixture.paneHtml(id, 'd0') }), `render ${id}`);
}

async function stageAndApprove(d) {
  const staged = await packs.stageStrokesFixture(d.root, { srv: d.srv });
  await d.srv.controlStarted;
  const a = await d.srv.control.invoke('pack-approve', { name: staged.name, tier: 'local' }, { remote: false });
  assert.ok(a && a.ok, `pack-approve: ${JSON.stringify(a)}`);
  return staged;
}

const bodiesFor = () => packs.strokeBodies({
  type: TYPE, mount: drive.STROKE_MOUNT, html: fixture.paneHtml(drive.STROKE_MOUNT, 'd0'),
  arrowFrom: drive.ARROW_FROM, arrowTo: drive.ARROW_TO, marginItem: drive.MARGIN_ITEM,
  frame: drive.STROKE_FRAME, itemBox: drive.STROKE_ITEM_BOX,
});

test('the fixture names come from its own manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(packs.STROKES_FIXTURE_DIR, 'web-chat-pack.json'), 'utf8'));
  assert.equal(NAME, manifest.name);
  assert.equal(TYPE, manifest.elements[0]);
  assert.equal(packs.STROKES_FIXTURE_DIR, path.join(REPO, 'test-support', 'element-packs', 'strokes-fixture'));
});

test('(1) stageStrokesFixture stages the fixture into the quarantine, closes its forge, and the control row approves it: the type listed with its pack and both anchor kinds', async (t) => {
  const d = await withServer(t, { root: tmpRoot('wc-u641-stage-') });
  const staged = await packs.stageStrokesFixture(d.root, { srv: d.srv });
  assert.equal(staged.name, NAME);
  assert.equal(staged.record.name, NAME);
  assert.ok(fs.existsSync(path.join(projectPaths(d.root).quarantine, NAME)), 'staged under this root\'s quarantine');
  const listed = await ok(d.api.get('/api/packs'), 'packs');
  assert.deepEqual(listed.quarantined.map((q) => q.name), [NAME], 'waiting on its card');
  assert.ok(!listed.packs.some((p) => p.name === NAME), 'installed nowhere yet');

  // The forge the stage stood up is closed when the call returns.
  const url = new URL(JSON.stringify(staged.record).match(/http:\/\/127\.0\.0\.1:\d+\/[^"]*/)[0]);
  await assert.rejects(client.request(Number(url.port), 'GET', '/', null, { timeout: 2000 }), (e) => e.code === 'ECONNREFUSED', 'the fake forge is closed');

  await d.srv.controlStarted;
  const a = await d.srv.control.invoke('pack-approve', { name: NAME, tier: 'local' }, { remote: false });
  assert.ok(a && a.ok, JSON.stringify(a));
  const row = (await ok(d.api.get('/api/elements/types'), 'types')).types.find((r) => r.type === TYPE);
  assert.ok(row, 'listed once approved');
  assert.equal(row.builtin, false);
  assert.equal(row.pack, NAME);
  assert.ok(row.anchors.includes('element') && row.anchors.includes('page'), JSON.stringify(row.anchors));
});

test('(2) strokeBodies over the soak\'s pane: the element, pane, arrow and margin bodies each accepted private; the anchors are the svg\'s, the outermost element\'s and U613\'s page records; the U579 drive\'s body is refused', async (t) => {
  const d = await withServer(t, { root: tmpRoot('wc-u641-bodies-') });
  await renderPanes(d);
  await stageAndApprove(d);
  const b = bodiesFor();

  assert.equal(b.element.anchor.kind, 'element');
  assert.equal(b.element.anchor.mount, drive.STROKE_MOUNT);
  assert.equal(b.element.anchor.fp.tag, 'svg', 'the pane\'s svg (a fixed-aspect target)');
  assert.equal(b.pane.anchor.kind, 'element');
  assert.equal(b.pane.anchor.mount, drive.STROKE_MOUNT);
  assert.equal(b.pane.anchor.fp.tag, 'section', 'the pane\'s outermost element (FRAME@pane-element)');
  assert.deepEqual(b.pane.anchor.at.path, [b.element.anchor.at.path[0]], 'the svg\'s top-level ancestor');
  assert.equal(b.pane.anchor.at.path.length, 1, 'a child of the shadow root');
  const end = (item, x, y) => ({ item, x, y, ...drive.STROKE_ITEM_BOX });
  assert.deepEqual(b.arrow.anchor, strokes.pageRecord({
    frame: drive.STROKE_FRAME, from: end(drive.ARROW_FROM, 0.5, 0.9), to: end(drive.ARROW_TO, 0.5, 0.1),
  }));
  assert.equal(strokes.pageShape(b.arrow.anchor), 'between');
  assert.equal(b.arrow.anchor.item, drive.ARROW_FROM);
  assert.equal(b.arrow.anchor.to.item, drive.ARROW_TO);
  assert.deepEqual(b.margin.anchor, strokes.pageRecord({
    frame: drive.STROKE_FRAME, from: end(drive.MARGIN_ITEM, 1.05, 0.2), to: end(drive.MARGIN_ITEM, 1.08, 0.8),
  }));
  assert.equal(strokes.pageShape(b.margin.anchor), 'beside');
  assert.equal(b.margin.anchor.item, drive.MARGIN_ITEM);

  for (const [k, body] of Object.entries(b)) {
    assert.equal(body.type, TYPE);
    assert.equal(body.payload.shared, false, `${k}: private (PRIVATE@create)`);
    assert.ok(strokes.isStrokePayload(body.payload), `${k}: a stroke payload`);
    assert.deepEqual(Object.keys(body.payload).filter((key) => ![...strokes.STROKE_KEYS, ...strokes.DESCRIBE_KEYS].includes(key)), [], `${k}: only declared keys`);
    const r = await d.anonApi.post('/api/elements', body);
    assert.equal(r.status, 200, `${k}: ${r.text}`);
    assert.equal(r.json.element.type, TYPE);
    assert.equal(r.json.element.shared, false, `${k}: stored private`);
    assert.deepStrictEqual(r.json.element.anchor, body.anchor, `${k}: the anchor kept as given`);
  }

  // The U579 drive's stroke: a range anchor and a points array of arrays.
  const old = { type: TYPE, anchor: drive.rangeAnchor(drive.STROKE_MOUNT), payload: { points: [[0.1, 0.1, 0.5], [0.4, 0.3, 0.6], [0.7, 0.5, 0.5]] } };
  const r = await d.anonApi.post('/api/elements', old);
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.error, 'anchor-kind-undeclared');
  assert.equal(r.json.kind, 'range');
});

test('(3) the drive\'s strokeStep, twice, over the staged fixture: an element, a pane and a page stroke each time (an arrow, then a margin stroke), all undone, none refused', async (t) => {
  const d = await withServer(t, { root: tmpRoot('wc-u641-drive-') });
  await renderPanes(d);
  const lines = [];
  const name = await fixture.stageStrokes({ project: d.root }, d.srv, { intDir: REPO, log: (l) => lines.push(l) });
  assert.equal(name, NAME, lines.join('\n'));

  const soakRoot = tmpRoot('wc-u641-soak-');
  const cfg = { root: soakRoot, out: soakRoot, port: d.port, project: d.root };
  writeJsonAtomic(fixture.fixtureRecord(cfg), { v: 1, pack: name });
  const before = (d.srv.state.elements || []).slice();
  const log = [];
  const dr = drive.createDrive(cfg, { log: (l) => log.push(l) });
  assert.equal(typeof dr.strokeStep, 'function', 'the seam U627 and U690 shape-check');
  // What the drive sends, in order (lib/client is one module: the drive's post
  // is this one).
  const sent = [];
  const post = client.post;
  client.post = (p, body, o) => { sent.push([p, body, o && o.headers]); return post(p, body, o); };
  try {
    await dr.strokeStep();
    await dr.strokeStep();
  } finally { client.post = post; }
  const c = dr.counts;
  // stroke_writes is the total (the K.2-255 reading): three a step.
  assert.deepEqual(
    [c.stroke_writes, c.stroke_writes_element, c.stroke_writes_pane, c.stroke_writes_page, c.stroke_failures],
    [6, 2, 2, 2, 0], log.join('\n'),
  );
  assert.deepEqual(log, [], 'nothing refused, nothing deleted');
  assert.deepEqual(d.srv.state.elements || [], before, 'every stroke undone: no reference left on the surface');
  const live = await ok(d.anonApi.get(`/api/elements?type=${TYPE}`), 'GET for the host\'s browser');
  assert.deepEqual(live.elements, [], 'no element of the fixture type left live');
  const shapeOf = (b) => (b.anchor.kind === 'page' ? strokes.pageShape(b.anchor) : b.anchor.fp.tag);
  assert.deepEqual(sent.map(([p, b]) => (p === '/api/elements' ? [p, b.type, shapeOf(b), b.payload.shared] : [p, b])), [
    ['/api/elements', TYPE, 'svg', false], ['/api/elements/undo', {}],
    ['/api/elements', TYPE, 'section', false], ['/api/elements/undo', {}],
    ['/api/elements', TYPE, 'between', false], ['/api/elements/undo', { item: drive.ARROW_TO }],
    ['/api/elements', TYPE, 'svg', false], ['/api/elements/undo', {}],
    ['/api/elements', TYPE, 'section', false], ['/api/elements/undo', {}],
    ['/api/elements', TYPE, 'beside', false], ['/api/elements/undo', { item: drive.MARGIN_ITEM }],
  ], 'element, pane, then the arrow (undone from its to item); then the margin stroke (undone on its item)');
  for (const [, , headers] of sent) assert.equal(headers.origin, `http://localhost:${d.port}`, 'written as the local browser');
  const saved = JSON.parse(fs.readFileSync(path.join(soakRoot, 'drive.json'), 'utf8'));
  assert.equal(saved.stroke_writes_page, 2, 'drive.json carries the per-frame counters');
});

test('(3b) the drive strokes nothing when fixture.json names no pack, or names one the daemon does not list', async (t) => {
  const d = await withServer(t, { root: tmpRoot('wc-u641-nopack-') });
  // The fixture's type IS listed (a non-built-in row), so a drive that took
  // the first non-built-in type instead of the named pack's would stroke it.
  await renderPanes(d);
  await stageAndApprove(d);
  assert.ok((await ok(d.api.get('/api/elements/types'), 'types')).types.some((r) => r.builtin === false && r.pack === NAME), 'a plug-in type is listed');
  const soakRoot = tmpRoot('wc-u641-nopack-soak-');
  const cfg = { root: soakRoot, out: soakRoot, port: d.port, project: d.root };
  const none = drive.createDrive(cfg, { log: () => {} });
  await none.strokeStep();
  assert.equal(none.counts.stroke_writes + none.counts.stroke_failures, 0, 'no pack named');
  writeJsonAtomic(fixture.fixtureRecord(cfg), { v: 1, pack: 'not-listed' });
  const other = drive.createDrive(cfg, { log: () => {} });
  await other.strokeStep();
  assert.equal(other.counts.stroke_writes + other.counts.stroke_failures, 0, 'a pack the daemon does not list');
});

test('(4) a refused quarantine POST throws naming its status, fixture.js stageStrokes logs it and answers null; a root that is not the server\'s throws', async (t) => {
  const d = await withServer(t, { root: tmpRoot('wc-u641-refused-') });
  // The quarantine's directory is a file: the daemon cannot stage into it.
  const q = projectPaths(d.root).quarantine;
  fs.mkdirSync(path.dirname(q), { recursive: true });
  fs.writeFileSync(q, 'not a directory');
  await assert.rejects(packs.stageStrokesFixture(d.root, { srv: d.srv }), (e) => {
    assert.match(e.message, /POST \/api\/packs\/quarantine answered [45]\d\d: /);
    return true;
  });
  const lines = [];
  assert.equal(await fixture.stageStrokes({ project: d.root }, d.srv, { intDir: REPO, log: (l) => lines.push(l) }), null);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /could not be staged — running without it: .*answered [45]\d\d/);
  fs.rmSync(q);

  const elsewhere = tmpRoot('wc-u641-elsewhere-');
  await assert.rejects(packs.stageStrokesFixture(elsewhere, { srv: d.srv }), /is .* the server's root/);
  await assert.rejects(packs.stageStrokesFixture(d.root, {}), TypeError);
});
