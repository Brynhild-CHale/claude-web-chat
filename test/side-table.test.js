// The side table (annotation engine PLAN.md 2B.2; DECISIONS.md F-SIDE a, A3,
// E-STORE a, F-DOCS a; rulings U311@qualifier-mechanism = a and
// U313@side-table-changed-rule = a): lib/server/domain/side-table.js
// (ctx.sideTable) and the element log's `answers` record
// (lib/core/element-log appendAnswers / answersOf / recordOf).
//
// Every test but the log's own drives a real daemon (withServer) through real
// sockets, as the chrome speaks to it: a pin is POST /api/elements {type:
// 'comment'} without the writer token (the chrome's own request), a report is
// a `report` frame on /ws, a turn is POST /api/turn-begin then /api/turn-end.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer, waitUntil, wsConnect, commentBody, existingProject } = require('../test-support/helpers');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { projectPaths } = require('../lib/core/paths');
const { createRedactor } = require('../lib/core/redact');
const { createElementLog, answerItemProblem } = require('../lib/core/element-log');
const { liveIsDirty, snapshotView } = require('../lib/server/domain/turns');

const T = 20000;
const until = (pred, what) => waitUntil(pred, { timeout: T, interval: 5, what });

async function ok(p, what) {
  const r = await p;
  assert.ok(r.status === 200 && (!r.json || r.json.ok !== false), `${what}: ${r.status} ${r.text}`);
  return r.json;
}

// A turn, as the hooks run one: turn-begin takes the lock, turn-end commits.
async function turn(api, msg) {
  await ok(api.post('/api/turn-begin', { message: msg }), 'turn-begin');
  return ok(api.post('/api/turn-end', { author: 'claude', summary: msg }), 'turn-end');
}
const commit = async (api, msg) => {
  const r = await turn(api, msg);
  assert.ok(r.node_id, `${msg}: a node committed (${JSON.stringify(r)})`);
  return r.node_id;
};

async function socket(t, port, headers) {
  const ws = wsConnect(port, '/ws', headers ? { headers } : undefined);
  t.after(() => { try { ws.terminate(); } catch {} });
  const frames = [];
  ws.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch {} });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await until(() => frames.some((f) => f.type === 'hello'), 'the hello');
  const of = (type) => frames.filter((f) => f.type === type);
  return {
    ws, frames, of,
    report: (surface, mounts) => ws.send(JSON.stringify({ type: 'report', surface, mounts })),
  };
}

// A pin on a pane, as the chrome sends it (no writer token).
async function pinOn(d, mount, text = 'a note') {
  const r = await ok(d.anonApi.post('/api/elements', commentBody({ text, shared: true, anchor: { mount, selector: 'p', text: 'x' } })), `pin on ${mount}`);
  return { id: r.pin.id, v: r.pin.v };
}

const logText = (root) => { try { return fs.readFileSync(projectPaths(root).elementsLog, 'utf8'); } catch { return ''; } };
const records = (root) => logText(root).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const answersRecs = (root) => records(root).filter((r) => r.t === 'answers');
const stats = (d) => d.srv.reports.stats();
const side = (d) => d.srv.sideTable;

// One report from `s` for (mount, gen), waited on until the holder took it.
async function report(d, s, mount, items, { gen = 0 } = {}) {
  const before = stats(d).accepted + stats(d).confirms;
  s.report(d.srv.reports.surface(), [{ mount, gen, items }]);
  await until(() => stats(d).accepted + stats(d).confirms > before, `the report on ${mount}`);
}

// ── the record type ─────────────────────────────────────────────────────────

test('the log: appendAnswers checks every item, names only a version it holds, redacts the record, and a reopen reads the same', (t) => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wc-answers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'log.jsonl');
  const redactor = createRedactor();
  const fake = fakeSecrets().find((f) => f.id === 'sk-anthropic-api');
  const log = createElementLog({ file, redactor });
  log.load();
  log.ensureElement({ id: 'c1' });
  log.appendVersion({ id: 'c1', payload: { text: 'x', shared: true, replies: [], anchor: { mount: 'p1' } } });
  const item = {
    id: 'c1', v: 1, mount: 'p1', state: 'exact', how: 'path', gen: 0, surface: 5,
    qual: { spec: 'abc123', store: 'def456' }, source: { peer: 'local', device: null },
    record: { mount: 'p1', fingerprint: { tag: 'p', text: `head ${fake.secrets[0]}` } },
  };
  assert.equal(answerItemProblem(item), null);
  // Malformed sets are refused whole, nothing written.
  const bytes0 = fs.readFileSync(file, 'utf8');
  for (const [bad, why] of [
    [{ ...item, state: 'hidden' }, /state/], [{ ...item, how: 'two words' }, /how/], [{ ...item, v: 2 }, /no version c1@2/],
    [{ ...item, extra: 1 }, /key:extra/], [{ ...item, qual: { spec: 'a' } }, /qual/], [{ ...item, source: { peer: 'network' } }, /source/],
  ]) assert.throws(() => log.appendAnswers({ node: 'n1', items: [bad] }), why);
  assert.throws(() => log.appendAnswers({ node: 'n1', items: [] }), /non-empty/);
  assert.throws(() => log.appendAnswers({ node: 'n1', items: [item, item] }), /twice/);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes0, 'nothing written by a refused set');

  log.appendAnswers({ node: 'n1', items: [item] });
  log.appendAnswers({ node: 'n2', items: [{ ...item, state: 'orphaned', record: { mount: 'p1', other: 'second' } }] });
  const raw = fs.readFileSync(file, 'utf8');
  assert.deepEqual(findLeaks(raw, [fake]).map((l) => l.id), [], 'the record is redacted before the bytes land');
  assert.equal(log.recordOf('c1', 1).fingerprint.tag, 'p');
  assert.ok(!JSON.stringify(log.recordOf('c1', 1)).includes(fake.secrets[0]));
  assert.equal(log.recordOf('c1', 1).other, undefined, 'the first record in log order is the one kept');
  assert.equal(log.answersOf('n1')[0].state, 'exact');
  assert.equal(log.answersOf('n2')[0].state, 'orphaned');
  assert.deepEqual(log.answersOf('n9'), []);
  assert.equal(log.versionsOf('c1').length, 1, 'never a version');
  assert.equal(log.stats().answers, 2);
  const before = { n1: log.answersOf('n1'), n2: log.answersOf('n2'), rec: log.recordOf('c1', 1) };
  log.close();

  const again = createElementLog({ file, redactor: createRedactor() });
  const st = again.load();
  assert.equal(st.answers, 2);
  assert.equal(st.skipped, 0);
  assert.equal(st.unknown, 0);
  assert.deepStrictEqual({ n1: again.answersOf('n1'), n2: again.answersOf('n2'), rec: again.recordOf('c1', 1) }, before);
  again.close();
});

test('AG-1: a reader that predates the answers type counts it unknown and skips it — the index arm is the only reader', () => {
  // The alpha.1 reader's switch has no `answers` arm: its default counts
  // `unknown` and indexes nothing, and nothing reads `unknown` into the boot
  // report or the integrity event (lib/server/domain/elements-reconcile).
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core', 'element-log.js'), 'utf8');
  assert.match(src, /default:\s*\n\s*counts\.unknown\+\+;/, 'an unknown record type is counted and skipped');
  for (const f of ['lib/server/domain/elements-reconcile.js', 'lib/server/domain/elements.js', 'lib/server/routes/health.js']) {
    const body = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/\.unknown\b/.test(body), `${f} reads no unknown count`);
  }
});

// ── at commit ───────────────────────────────────────────────────────────────

test('one answers record per commit, after its commit record, holding the held answer; versionsOf unchanged', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render p1');
  const pin = await pinOn(d, 'p1');
  const versions = d.srv.elements.versionsOf(pin.id).length;
  const s = await socket(t, d.port);
  await report(d, s, 'p1', [{ id: pin.id, v: pin.v, state: 'exact', how: 'path' }]);
  const n1 = await commit(d.api, 'first');

  const recs = records(d.root);
  const ci = recs.findIndex((r) => r.t === 'commit' && r.node === n1);
  const ai = recs.findIndex((r) => r.t === 'answers' && r.node === n1);
  assert.ok(ci >= 0 && ai > ci, `the answers record lands after the commit record (${ci} < ${ai})`);
  assert.equal(answersRecs(d.root).length, 1);
  const [it] = recs[ai].items;
  assert.deepStrictEqual(
    { id: it.id, v: it.v, mount: it.mount, state: it.state, how: it.how, gen: it.gen, surface: it.surface, peer: it.source.peer },
    { id: pin.id, v: pin.v, mount: 'p1', state: 'exact', how: 'path', gen: 0, surface: d.srv.reports.surface(), peer: 'local' },
  );
  assert.equal(d.srv.elements.versionsOf(pin.id).length, versions, 'no version appended');
  const got = side(d).answerOf(n1, pin.id, pin.v);
  assert.equal(got.state, 'exact');
  assert.equal(got.node, n1);
  assert.equal(side(d).stats().sets, 1);
});

test('changed only: an unchanged answer writes nothing and is inherited; a re-render and a new report record the new answer', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render p1');
  const pin = await pinOn(d, 'p1');
  const s = await socket(t, d.port);
  await report(d, s, 'p1', [{ id: pin.id, v: pin.v, state: 'exact' }]);
  const n1 = await commit(d.api, 'first');
  assert.equal(answersRecs(d.root).length, 1);

  // Another pane changes: the held answer still qualifies, and equals n1's.
  await ok(d.api.post('/api/render', { id: 'p2', html: '<p>two</p>' }), 'render p2');
  const n2 = await commit(d.api, 'second');
  assert.equal(answersRecs(d.root).length, 1, 'nothing written for the unchanged answer');
  assert.equal(side(d).stats().unchanged >= 1, true);
  const inh = side(d).answerOf(n2, pin.id, pin.v);
  assert.equal(inh && inh.state, 'exact', 'the child inherits the parent\'s answer');
  assert.equal(inh.node, n1, 'recorded on the parent');

  // p1 re-rendered (gen 1) with new html and a new report.
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one, rewritten</p>' }), 're-render p1');
  assert.equal(d.srv.state.mounts.get('p1').gen, 1);
  await report(d, s, 'p1', [{ id: pin.id, v: pin.v, state: 're-resolved', how: 'score' }], { gen: 1 });
  const n3 = await commit(d.api, 'third');
  const recs = answersRecs(d.root);
  assert.equal(recs.length, 2);
  assert.equal(recs[1].node, n3);
  assert.equal(recs[1].items[0].state, 're-resolved');
  assert.equal(recs[1].items[0].gen, 1);
  assert.equal(side(d).answerOf(n3, pin.id, pin.v).state, 're-resolved');
  // The parent's answer does not carry into n3: its spec is p1's old html.
  assert.equal(side(d).answerOf(n3, pin.id, pin.v).node, n3);
});

test('qualifier: an answer stamped before a store write and never confirmed is not recorded; confirmed after it, it is', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render p1');
  const pin = await pinOn(d, 'p1');
  const s = await socket(t, d.port);
  await report(d, s, 'p1', [{ id: pin.id, v: pin.v, state: 'exact' }]);
  await ok(d.api.post('/api/store', { patch: { k: 1 } }), 'store write');
  const n1 = await commit(d.api, 'unconfirmed');
  assert.equal(answersRecs(d.root).length, 0, 'stamped with the old store: not recorded');
  assert.equal(side(d).answerOf(n1, pin.id, pin.v), null);

  await ok(d.api.post('/api/store', { patch: { k: 2 } }), 'store write 2');
  await report(d, s, 'p1', []);
  assert.equal(stats(d).confirms, 1);
  await ok(d.api.post('/api/render', { id: 'p2', html: '<p>two</p>' }), 'render p2');
  const n2 = await commit(d.api, 'confirmed');
  const recs = answersRecs(d.root);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].node, n2);
  assert.equal(side(d).answerOf(n2, pin.id, pin.v).state, 'exact');
});

test('GT-06: a service pane\'s answers never reach an answers record; a Claude pane\'s beside it do', async (t) => {
  const d = await withServer(t);
  const drv = require('../lib/driver').createDriver({ owner: 'svc', port: d.port });
  t.after(() => drv.release().catch(() => {}));
  const r = await drv.render({ id: 'svc-p', html: '<p>live</p>' });
  assert.notEqual(r && r.ok, false, JSON.stringify(r));
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>mine</p>' }), 'render p1');
  const a = await pinOn(d, 'svc-p');
  const b = await pinOn(d, 'p1');
  const s = await socket(t, d.port);
  s.report(d.srv.reports.surface(), [
    { mount: 'svc-p', gen: 0, items: [{ id: a.id, v: a.v, state: 'exact' }] },
    { mount: 'p1', gen: 0, items: [{ id: b.id, v: b.v, state: 'exact' }] },
  ]);
  await until(() => stats(d).accepted === 2, 'both held');
  assert.equal(stats(d).live_only, 1);
  const n1 = await commit(d.api, 'both');
  const recs = answersRecs(d.root);
  assert.equal(recs.length, 1);
  assert.deepStrictEqual(recs[0].items.map((i) => i.id), [b.id], 'only the Claude pane\'s answer');
  assert.equal(side(d).answerOf(n1, a.id, a.v), null);
});

test('B6: after Set active away and back, the commit records only answers carrying the current surface; none is skipped for its node', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render p1');
  const pin = await pinOn(d, 'p1');
  const na = await commit(d.api, 'a');
  await ok(d.api.post('/api/render', { id: 'p2', html: '<p>two</p>' }), 'render p2');
  const nb = await commit(d.api, 'b');
  const s = await socket(t, d.port);
  await report(d, s, 'p1', [{ id: pin.id, v: pin.v, state: 'orphaned' }]);
  const s0 = d.srv.reports.surface();

  await ok(d.api.post('/api/graph/active', { id: na }), 'set active a');
  await ok(d.api.post('/api/graph/active', { id: nb }), 'set active b');
  const s2 = d.srv.reports.surface();
  assert.ok(s2 > s0);
  assert.equal(stats(d).held, 0, 'the resets emptied the held answers');
  assert.equal(answersRecs(d.root).length, 0, 'no preserve node, nothing recorded');
  // A report on the restored surface (gen 0) is taken — no node check.
  await report(d, s, 'p1', [{ id: pin.id, v: pin.v, state: 'exact' }]);
  await ok(d.api.post('/api/render', { id: 'p3', html: '<p>three</p>' }), 'render p3');
  const nc = await commit(d.api, 'c');
  const recs = answersRecs(d.root);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].node, nc);
  assert.deepStrictEqual(recs[0].items.map((i) => [i.state, i.surface]), [['exact', s2]]);
});

test('branches: a branch from n1 does not see the answers recorded on n1\'s other child', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render p1');
  const pin = await pinOn(d, 'p1');
  const n1 = await commit(d.api, 'root');
  const s = await socket(t, d.port);
  await report(d, s, 'p1', [{ id: pin.id, v: pin.v, state: 'exact' }]);
  await ok(d.api.post('/api/render', { id: 'p2', html: '<p>a</p>' }), 'render p2');
  const na = await commit(d.api, 'child a');
  assert.equal(side(d).answerOf(na, pin.id, pin.v).state, 'exact');

  await ok(d.api.post('/api/graph/active', { id: n1 }), 'back to n1');
  await ok(d.api.post('/api/render', { id: 'p3', html: '<p>b</p>' }), 'render p3');
  const nb = await commit(d.api, 'child b');
  assert.equal(d.srv.graph.nodes.get(nb).parent_id, n1);
  assert.equal(side(d).answerOf(nb, pin.id, pin.v), null, 'child a\'s answer is not on the branch');
  assert.equal(side(d).answersFor(nb).size, 0);
  assert.equal(side(d).answersFor(n1).size, 0);
});

test('the minted record: kept once per id@v, masked on read, never a version; a fake secret in it never reaches log.jsonl', async (t) => {
  const d = await withServer(t);
  const fake = fakeSecrets().find((f) => f.id === 'sk-anthropic-api');
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render p1');
  const pin = await pinOn(d, 'p1');
  const verRecs = () => records(d.root).filter((r) => r.t === 'ver').length;
  const vers = verRecs();
  const s = await socket(t, d.port);
  const record = { v: 1, kind: 'element', mount: 'p1', path: { selector: 'p' }, fingerprint: { tag: 'p', text: `the head ${fake.secrets[0]}` } };
  await report(d, s, 'p1', [{ id: pin.id, v: pin.v, state: 're-resolved', how: 'score', record }]);
  const n1 = await commit(d.api, 'first');
  const got = side(d).recordOf(pin.id, pin.v);
  assert.equal(got.fingerprint.tag, 'p');
  assert.ok(got.fingerprint.text.startsWith('the head '));
  assert.ok(!JSON.stringify(got).includes(fake.secrets[0]), 'masked');
  assert.deepEqual(findLeaks(logText(d.root), [fake]).map((l) => l.id), [], 'the secret never reached the bytes');
  assert.equal(side(d).stats().records, 1);

  // A second report with another record (and a changed state): a new set,
  // the record not replaced, and no version.
  await report(d, s, 'p1', [{ id: pin.id, v: pin.v, state: 'exact', record: { ...record, fingerprint: { tag: 'p', text: 'another-record-text' } } }]);
  await ok(d.api.post('/api/render', { id: 'p2', html: '<p>two</p>' }), 'render p2');
  const n2 = await commit(d.api, 'second');
  const recs = answersRecs(d.root);
  assert.equal(recs.length, 2);
  assert.equal(recs[1].node, n2);
  assert.equal(recs[1].items[0].record, undefined, 'written once per id@v');
  assert.ok(!logText(d.root).includes('another-record-text'));
  assert.ok(side(d).recordOf(pin.id, pin.v).fingerprint.text.startsWith('the head '));
  assert.equal(verRecs(), vers, 'no new ver record');
  assert.equal(side(d).answerOf(n1, pin.id, pin.v).record, undefined, 'answersFor carries no record; recordOf does');
});

test('read-only: with the element store read-only a commit appends no answers record, and stats counts it', async (t) => {
  const COPY = { id: 'c1', anchor: { mount: 'm1', selector: 'p', text: 'x' }, text: 'a pin', shared: true, replies: [], seq: 1, created_at: 1 };
  const node = { id: 'n1', parent_id: null, created_at: 1, author: 'claude', trigger: { kind: 'user', message: '', summary: '' }, mounts: [], store: {}, comments: [COPY], captures: [] };
  let elementsDir = null;
  t.after(() => { if (elementsDir) { try { fs.chmodSync(elementsDir, 0o755); } catch {} } });
  const d = await withServer(t, {
    seed: ({ webChatDir }) => {
      existingProject({ webChatDir });
      const gdir = path.join(webChatDir, 'graph');
      fs.mkdirSync(gdir, { recursive: true });
      fs.writeFileSync(path.join(gdir, 'n1.json'), JSON.stringify(node));
      fs.writeFileSync(path.join(gdir, '_meta.json'), JSON.stringify({ active: 'n1' }));
      elementsDir = path.dirname(projectPaths(path.dirname(webChatDir)).elementsLog);
      fs.mkdirSync(elementsDir, { recursive: true });
      fs.chmodSync(elementsDir, 0o555);
    },
  });
  assert.equal(d.srv.elements.readOnly, true, 'the store is read-only this boot');
  await ok(d.api.post('/api/render', { id: 'm9', html: '<p>more</p>' }), 'render');
  const n2 = await commit(d.api, 'go');
  assert.equal(d.srv.graph.active, n2);
  assert.equal(side(d).stats().skipped_read_only, 1);
  assert.equal(logText(d.root), '', 'nothing appended');
});

test('a throwing append reaches noteAppendFailure and the commit still lands', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render p1');
  const pin = await pinOn(d, 'p1');
  const s = await socket(t, d.port);
  await report(d, s, 'p1', [{ id: pin.id, v: pin.v, state: 'exact' }]);
  const log = d.srv.elements.log;
  const seen = [];
  const realNote = d.srv.elements.noteAppendFailure;
  log.appendAnswers = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  d.srv.elements.noteAppendFailure = (e) => { seen.push(e && e.code); return realNote(e); };
  const n1 = await commit(d.api, 'first');
  assert.equal(d.srv.graph.active, n1, 'the commit landed');
  assert.ok(fs.existsSync(path.join(d.root, '.web-chat', 'graph', `${n1}.json`)));
  assert.deepEqual(seen, ['ENOSPC']);
  assert.equal(side(d).stats().append_failures, 1);
  assert.equal(answersRecs(d.root).length, 0);
});

test('boot: a log holding answers records reloads them (answersOf and recordOf equal across a restart); the boot report stays clean', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render p1');
  const pin = await pinOn(d, 'p1');
  const s = await socket(t, d.port);
  const record = { v: 1, kind: 'element', mount: 'p1', path: { selector: 'p' }, fingerprint: { tag: 'p', text: 'one' } };
  await report(d, s, 'p1', [{ id: pin.id, v: pin.v, state: 'exact', record }]);
  const n1 = await commit(d.api, 'first');
  const before = { own: d.srv.elements.log.answersOf(n1), rec: side(d).recordOf(pin.id, pin.v), for: [...side(d).answersFor(n1)] };
  assert.equal(before.own.length, 1);
  s.ws.terminate();
  await d.stop();

  const again = await withServer(t, { root: d.root });
  assert.deepStrictEqual(again.srv.elements.log.answersOf(n1), before.own);
  assert.deepStrictEqual(again.srv.sideTable.recordOf(pin.id, pin.v), before.rec);
  assert.deepStrictEqual([...again.srv.sideTable.answersFor(n1)], before.for);
  const st = again.srv.elements.stats();
  assert.equal(st.answers, 1);
  assert.equal(st.skipped, 0);
  assert.equal(st.unknown, 0);
  const report2 = again.srv.elements.integrity();
  assert.equal(report2.clean, true, JSON.stringify(report2.states));
});

// ── the changed rule's edges (E2 a) ────────────────────────────────────────

test('changed only, store half: an ancestor\'s answer stops carrying down once the node\'s store differs from its qualifier', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render p1');
  const pin = await pinOn(d, 'p1');
  const s = await socket(t, d.port);
  await report(d, s, 'p1', [{ id: pin.id, v: pin.v, state: 'exact' }]);
  const n1 = await commit(d.api, 'first');
  assert.equal(side(d).answerOf(n1, pin.id, pin.v).state, 'exact');
  // A store write, never confirmed: n2's p1 is the same content, its store is not.
  await ok(d.api.post('/api/store', { patch: { k: 1 } }), 'store write');
  const n2 = await commit(d.api, 'store moved');
  assert.equal(d.srv.graph.nodes.get(n2).parent_id, n1);
  assert.equal(answersRecs(d.root).length, 1, 'nothing recorded for n2: the held answer carries the old store');
  assert.equal(side(d).answerOf(n2, pin.id, pin.v), null, 'n1\'s answer does not carry into a node whose store differs');
  assert.equal(side(d).answersFor(n2).size, 0);
});

test('changed only, state half: a new state on the same content and store is recorded', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render p1');
  const pin = await pinOn(d, 'p1');
  const s = await socket(t, d.port);
  await report(d, s, 'p1', [{ id: pin.id, v: pin.v, state: 'exact' }]);
  await commit(d.api, 'first');
  // The same viewer, the same surface, gen and store: its newer answer replaces the held one.
  await report(d, s, 'p1', [{ id: pin.id, v: pin.v, state: 'orphaned' }]);
  await ok(d.api.post('/api/render', { id: 'p2', html: '<p>two</p>' }), 'render p2');
  const n2 = await commit(d.api, 'second');
  const recs = answersRecs(d.root);
  assert.equal(recs.length, 2, 'the state changed: a record set for n2');
  assert.equal(recs[1].node, n2);
  assert.deepStrictEqual(recs[1].items.map((i) => i.state), ['orphaned']);
  assert.equal(side(d).answerOf(n2, pin.id, pin.v).state, 'orphaned');
});

test('a record set never names an id@v the node does not carry: a pin removed after its report is not recorded', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render p1');
  const pin = await pinOn(d, 'p1');
  const kept = await pinOn(d, 'p1', 'another note');
  const s = await socket(t, d.port);
  await report(d, s, 'p1', [{ id: pin.id, v: pin.v, state: 'exact' }, { id: kept.id, v: kept.v, state: 'exact' }]);
  await ok(d.anonApi.del(`/api/elements/${pin.id}`), 'remove the pin');
  assert.equal(stats(d).held, 2, 'precondition: both answers are still held');
  await ok(d.api.post('/api/render', { id: 'p2', html: '<p>two</p>' }), 'render p2');
  const n1 = await commit(d.api, 'after the removal');
  const recs = answersRecs(d.root);
  assert.equal(recs.length, 1);
  assert.deepStrictEqual(recs[0].items.map((i) => i.id), [kept.id], 'only the pin n1 carries');
  assert.equal(side(d).answerOf(n1, pin.id, pin.v), null);
});

// ── S-15: the dirty check never sees reports or marks ───────────────────────

test('S-15: 100 reports and 50 mark writes flip the dirty check 0 times; snapshotView is unchanged', async (t) => {
  const d = await withServer(t);
  await ok(d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' }), 'render p1');
  const pin = await pinOn(d, 'p1');
  await commit(d.api, 'base');
  const g = d.srv.graph;
  const view0 = snapshotView(g.snapshotLive());
  assert.equal(liveIsDirty(g), false);
  const s = await socket(t, d.port);
  const drv = require('../lib/driver').createDriver({ owner: 'marker', port: d.port });
  t.after(() => drv.release().catch(() => {}));
  let flips = 0;
  const states = ['exact', 're-resolved', 'orphaned'];
  for (let i = 0; i < 100; i++) {
    await report(d, s, 'p1', [{ id: pin.id, v: pin.v, state: states[i % 3], tie: i }]);
    if (liveIsDirty(g)) flips++;
    if (i % 2 === 0) {
      const r = await drv.setMarks([{ mount: 'p1', kind: 'look', label: `mark ${i}` }]);
      assert.equal(r.ok, true, JSON.stringify(r));
      if (liveIsDirty(g)) flips++;
    }
  }
  assert.equal(flips, 0);
  assert.equal(snapshotView(g.snapshotLive()), view0);
  assert.equal(d.srv.marks.stats().writes, 50);
});
