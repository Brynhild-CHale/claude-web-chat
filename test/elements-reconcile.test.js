// The boot reconcile (PLAN 1A.3; GT-10; U209): lib/server/domain/elements-reconcile.
//
// Every state a crash, a rollback or a hand edit leaves the element log and the
// graph in is named in .web-chat/elements/boot-report.json, handed to the
// store (GET /api/health's graph_integrity, local requests only) and, when the
// boot is not clean, announced by ONE `integrity` event. The crash points are
// GT-10's (design/…/tests/F6/g5.js), injected by wrapping graph.writeNode,
// graph.elements.appendCommit and graph.saveMeta on ctx.srv.graph, each
// followed by a hard stop (no draft) and a reboot on the same root.
//
// The comment routes still mint from state.commentSeq until U208 binds them to
// the store, so these tests write pins through the store itself (add / reply)
// and put the projected pin on the live state, as U208's routes will.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { withServer } = require('../test-support/helpers');
const { v3Graph } = require('../test-support/v3-graph');
const { projectPaths } = require('../lib/core/paths');
const elementLog = require('../lib/core/element-log');
const { createRedactor } = require('../lib/core/redact');
const { createElementStore } = require('../lib/server/domain/elements');
const { createGraph } = require('../lib/server/graph');
const { createState } = require('../lib/server/state');
const { resolvePaths } = require('../lib/server/paths');
const { reconcileElements, STATES, NORMAL, REPORT_NAME } = require('../lib/server/domain/elements-reconcile');

const anchor = (m) => ({ mount: m, selector: 'p', text: m, ordinal: 0 });
const render = (api, id) => api.post('/api/render', { id, html: `<p>${id}</p>` });
async function turn(api, message, work) {
  await api.post('/api/turn-begin', { message });
  if (work) await work();
  return api.post('/api/turn-end', { author: 'claude' });
}
// A pin written as U208's routes will: through the store, onto the live state.
function addPin(srv, text, mount) {
  const pin = srv.elements.add({ text, anchor: anchor(mount) });
  srv.state.comments = [...(srv.state.comments || []), pin];
  return pin;
}
function replyPin(srv, id, text) {
  const cur = srv.state.comments.find((p) => p.id === id);
  const next = srv.elements.reply(cur, { text });
  srv.state.comments = srv.state.comments.map((p) => (p.id === id ? next : p));
  return next;
}

const graphDir = (root) => projectPaths(root).graphDir;
const nodeFile = (root, id) => JSON.parse(fs.readFileSync(path.join(graphDir(root), `${id}.json`), 'utf8'));
const metaOf = (root) => JSON.parse(fs.readFileSync(projectPaths(root).meta, 'utf8'));
const bootReport = (root) => JSON.parse(fs.readFileSync(projectPaths(root).elementsBootReport, 'utf8'));
function records(root) {
  let text = '';
  try { text = fs.readFileSync(projectPaths(root).elementsLog, 'utf8'); } catch {}
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const commitsIn = (root) => records(root).filter((r) => r.t === 'commit');
const nodeIds = (root) => fs.readdirSync(graphDir(root)).filter((f) => /^n\d+\.json$/.test(f)).map((f) => f.slice(0, -5));
// The states a report names that are not the normal ones, sorted.
const unclean = (report) => Object.keys(report.states).filter((k) => !NORMAL.has(k)).sort();
const integrityEvents = (srv) => srv.bus.read({ since: 0, kinds: ['integrity'] }).events;

// Every name the report uses is a named state, and no commit record stands for
// a node other than the one whose file it describes.
function assertNamedAndHonest(root, report) {
  for (const k of Object.keys(report.states)) assert.ok(STATES.includes(k), `${k} is a named state`);
  const perNode = new Map();
  for (const rec of commitsIn(root)) {
    perNode.set(rec.node, (perNode.get(rec.node) || 0) + 1);
    let file = null;
    try { file = nodeFile(root, rec.node); } catch { file = null; }
    if (file) assert.equal(rec.digest, elementLog.nodeDigest(file), `the record for ${rec.node} is that node's`);
  }
  for (const [n, k] of perNode) assert.equal(k, 1, `one commit record for ${n}`);
}

// ── the four crash points ───────────────────────────────────────────────────

const CRASHES = {
  // [non-normal states after the reboot, the node written, rolled forward]
  none: [[], true, false],
  'before-any': [['uncommitted-lost'], false, false],
  'between-node-and-log': [['node-without-commit-record', 'rolled-forward'], true, true],
  'append-fails': [['node-without-commit-record'], true, false],
  'before-meta': [['rolled-forward'], true, true],
};

for (const [crash, [expected, written, rolled]] of Object.entries(CRASHES)) {
  test(`crash point ${crash}: every state is named, no record is adopted by another node, no bookmark is duplicated`, async (t) => {
    const s1 = await withServer(t);
    const { api, srv, root } = s1;
    const A = (await turn(api, 'A', async () => { await render(api, 'm1'); addPin(srv, 'on A', 'm1'); })).json.node_id;
    await api.post('/api/graph/wipe', { name: 'fresh' });
    await api.post('/api/turn-begin', { message: 'B' });
    await render(api, 'm2');
    const pinB = addPin(srv, 'on B', 'm2');
    const B = `n${srv.graph.nextSeq}`;

    // The process "dies" at the crash point: nothing it would write after it lands.
    let dead = false;
    let armed = false;
    const g = srv.graph;
    const st = srv.graph.elements;
    const origWrite = g.writeNode; const origSave = g.saveMeta; const origAppend = st.appendCommit;
    const dying = () => { if (dead) throw new Error('injected: the process is gone'); };
    g.writeNode = (node) => {
      dying();
      if (crash === 'before-any') { dead = true; throw new Error('injected: before any write'); }
      const r = origWrite(node);
      if (crash === 'between-node-and-log') { dead = true; throw new Error('injected: between node and log'); }
      return r;
    };
    st.appendCommit = (node) => {
      dying();
      if (crash === 'append-fails') throw new Error('injected: the append fails');
      const r = origAppend(node);
      armed = true;
      return r;
    };
    g.saveMeta = () => {
      dying();
      if (crash === 'before-meta' && armed) { dead = true; throw new Error('injected: after node and log, before meta'); }
      return origSave();
    };
    const end = await api.post('/api/turn-end', { author: 'claude' });
    assert.equal(end.status, crash === 'none' || crash === 'append-fails' ? 200 : 500, `turn-end at ${crash}`);
    await s1.stop(); // a hard stop: no graceful shutdown, no draft

    const s2 = await withServer(t, { root });
    const report = bootReport(root);
    assertNamedAndHonest(root, report);
    assert.deepEqual(unclean(report), [...expected].sort(), JSON.stringify(report.states));
    assert.equal(report.clean, expected.length === 0);
    assert.equal(integrityEvents(s2.srv).length, expected.length ? 1 : 0, 'one integrity event exactly when not clean');
    assert.equal(s2.srv.graph.nodes.has(B), written);
    assert.equal(s2.srv.graph.active, written ? B : A);
    if (rolled) {
      assert.deepEqual(report.states['rolled-forward'].examples, [B]);
      assert.equal(metaOf(root).active, B, 'the roll forward saved the meta');
      assert.equal(metaOf(root).last_node, B);
    }
    if (crash === 'before-any') {
      assert.deepEqual(report.states['uncommitted-lost'].examples, [`${pinB.id}@${pinB.v}`], 'the crash lost the live pin, and says so');
      assert.ok(metaOf(root).pending_bookmark, 'the bookmark still waits');
    } else {
      assert.equal(metaOf(root).pending_bookmark, null, 'the bookmark is not pending any more');
    }

    // A written node has exactly its record by now (adopted or appended); a
    // node that was never written is named by none.
    assert.equal(commitsIn(root).some((r) => r.node === B), written);
    // One more commit. An id a written node claims is never minted again (a
    // node never written claimed nothing, and no record names it).
    const C = (await turn(s2.api, 'C', () => render(s2.api, 'm3'))).json.node_id;
    assert.ok(C);
    if (written) assert.notEqual(C, B, 'a fresh id');
    assert.equal(nodeFile(root, C).parent_id, written ? B : A, 'the next node is the written node\'s child');
    const bookmarks = nodeIds(root).map((id) => nodeFile(root, id)).filter((n) => n.bookmarked && n.name === 'fresh');
    assert.equal(bookmarks.length, 1, 'the wipe\'s bookmark landed exactly once');
    await s2.stop();

    const s3 = await withServer(t, { root });
    const again = bootReport(root);
    assertNamedAndHonest(root, again);
    assert.deepEqual(unclean(again), crash === 'before-any' ? ['uncommitted-lost'] : [], JSON.stringify(again.states));
    assert.equal(s3.srv.graph.active, C);
  });
}

test('a deliberate Set active to an older node, then a hard stop, is not rolled forward', async (t) => {
  const s1 = await withServer(t);
  const A = (await turn(s1.api, 'A', () => render(s1.api, 'm1'))).json.node_id;
  const B = (await turn(s1.api, 'B', () => render(s1.api, 'm2'))).json.node_id;
  const r = await s1.api.post('/api/graph/active', { id: A });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(metaOf(s1.root).last_node, B);
  await s1.stop();

  const s2 = await withServer(t, { root: s1.root });
  assert.equal(s2.srv.graph.active, A, 'still the node the user chose');
  const report = bootReport(s1.root);
  assert.equal(report.clean, true, JSON.stringify(report.states));
  assert.deepEqual(report.states, {});
  assert.equal(integrityEvents(s2.srv).length, 0, 'a clean boot announces nothing');
  const health = (await s2.api.get('/api/health')).json;
  assert.deepEqual(health.graph_integrity, { clean: true, states: {}, report: REPORT_NAME });
});

test('rolled-forward clears the pending_folded the rolled-forward node carries, so the next node does not carry it again', async (t) => {
  const s1 = await withServer(t);
  const { api, srv, root } = s1;
  await turn(api, 'A', () => render(api, 'm1'));
  await turn(api, 'folds: no surface change');
  assert.equal(metaOf(root).pending_folded.length, 1, 'the no-change turn waits on the meta');
  await api.post('/api/turn-begin', { message: 'B' });
  await render(api, 'm2');
  const B = `n${srv.graph.nextSeq}`;
  const g = srv.graph;
  const origSave = g.saveMeta; const origAppend = g.elements.appendCommit;
  let armed = false;
  g.elements.appendCommit = (node) => { const r = origAppend(node); armed = true; return r; };
  g.saveMeta = () => { if (armed) throw new Error('injected: before meta'); return origSave(); };
  assert.equal((await api.post('/api/turn-end', { author: 'claude' })).status, 500);
  await s1.stop();
  assert.equal(nodeFile(root, B).folded.length, 1, 'B carries the folded turn');
  assert.equal(metaOf(root).pending_folded.length, 1, 'the meta was never saved after B');

  const s2 = await withServer(t, { root });
  assert.deepEqual(unclean(bootReport(root)), ['rolled-forward']);
  assert.deepEqual(metaOf(root).pending_folded, [], 'the roll forward cleared what B carries');
  const C = (await turn(s2.api, 'C', () => render(s2.api, 'm3'))).json.node_id;
  assert.equal(nodeFile(root, C).parent_id, B);
  assert.ok(!(nodeFile(root, C).folded || []).length, 'the folded turn rode onto B only');
});

// ── the two restart moments (tests/F6/restart.js) ───────────────────────────

async function pinWithReplies(srv) {
  const p = addPin(srv, 'note', 'm1');
  replyPin(srv, p.id, 'r1');
  return replyPin(srv, p.id, 'r2');
}

test('a graceful stop with an uncommitted pin and replies reboots clean, its versions draft-pinned and superseded', async (t) => {
  const s1 = await withServer(t);
  await turn(s1.api, 'A', () => render(s1.api, 'm1'));
  const head = await pinWithReplies(s1.srv);
  assert.equal(head.v, 3);
  await s1.graceful();

  const s2 = await withServer(t, { root: s1.root });
  const report = bootReport(s1.root);
  assert.equal(report.clean, true, JSON.stringify(report.states));
  assert.deepEqual(report.states['draft-pinned'], { count: 1, examples: [`${head.id}@3`] });
  assert.deepEqual(report.states.superseded, { count: 2, examples: [`${head.id}@1`, `${head.id}@2`] });
  assert.deepEqual(unclean(report), []);
  assert.equal(s2.srv.state.comments.find((p) => p.id === head.id).v, 3, 'the draft restored the pin');
});

test('a hard stop reboots with the unsaved versions uncommitted-lost; one more commit and a clean reboot report nothing new', async (t) => {
  const s1 = await withServer(t);
  await turn(s1.api, 'A', () => render(s1.api, 'm1'));
  const head = await pinWithReplies(s1.srv);
  await s1.stop();

  const s2 = await withServer(t, { root: s1.root });
  const report = bootReport(s1.root);
  assert.equal(report.clean, false);
  assert.deepEqual(unclean(report), ['uncommitted-lost']);
  assert.deepEqual(report.states['uncommitted-lost'], { count: 1, examples: [`${head.id}@3`] });
  assert.equal(report.states.superseded.count, 2);
  assert.equal(integrityEvents(s2.srv).length, 1);
  assert.deepEqual(integrityEvents(s2.srv)[0].states, { 'uncommitted-lost': 1, superseded: 2 });
  assert.equal(s2.srv.state.comments.length, 0, 'the pin was only live, and the stop lost it');
  // One more commit, with its own superseded intermediate.
  await turn(s2.api, 'B', async () => {
    await render(s2.api, 'm2');
    const p = addPin(s2.srv, 'second', 'm2');
    replyPin(s2.srv, p.id, 'q1');
  });
  await s2.graceful();

  await withServer(t, { root: s1.root });
  const after = bootReport(s1.root);
  assert.deepEqual(unclean(after), ['uncommitted-lost'], 'nothing but the lost versions');
  assert.deepEqual(after.states['uncommitted-lost'], report.states['uncommitted-lost'], '0 false positives');
  assert.equal(after.states.superseded.count, 3);
});

// ── adoption, orphans, dangling records, lost versions ──────────────────────

test('node-without-commit-record: a node 0.8.5 committed is adopted (one record, its copies found or appended); the next boot is clean', async (t) => {
  const s1 = await withServer(t);
  const A = (await turn(s1.api, 'A', async () => { await render(s1.api, 'm1'); addPin(s1.srv, 'kept', 'm1'); })).json.node_id;
  await s1.stop();
  const root = s1.root;
  // A commit by a 0.8.5 daemon (rolled back): no `v` on its copies, no commit
  // record, and a meta that knows nothing of last_node.
  const a = nodeFile(root, A);
  const id = `n${Math.max(...nodeIds(root).map((n) => Number(n.slice(1)))) + 1}`;
  const kept = { ...a.comments[0] };
  delete kept.v;
  const fresh = { id: 'c900', seq: 900, created_at: a.created_at + 500, shared: true, text: 'written by 0.8.5', anchor: anchor('m1'), replies: [] };
  const node = { ...a, id, parent_id: A, created_at: a.created_at + 1000, trigger: { kind: 'turn', message: 'rolled back', summary: 'rolled back' }, comments: [kept, fresh] };
  fs.writeFileSync(path.join(graphDir(root), `${id}.json`), JSON.stringify(node));
  fs.writeFileSync(projectPaths(root).meta, JSON.stringify({ active: id, lock: null, pending_bookmark: null, pending_folded: [], pending_folded_dropped: 0 }));
  const versionsBefore = records(root).filter((r) => r.t === 'ver').length;

  const s2 = await withServer(t, { root });
  const report = bootReport(root);
  assert.deepEqual(unclean(report), ['node-without-commit-record'], JSON.stringify(report.states));
  assert.deepEqual(report.states['node-without-commit-record'].examples, [id]);
  assert.deepEqual(report.states['node-without-commit-record'].detail, [{ node: id, adopted: true }]);
  const recs = commitsIn(root).filter((r) => r.node === id);
  assert.equal(recs.length, 1, 'one commit record appended');
  assert.deepEqual(recs[0].pins.sort(), [`${kept.id}@1`, 'c900@1'].sort(), 'the kept copy found its version; the new one was appended');
  assert.equal(records(root).filter((r) => r.t === 'ver').length, versionsBefore + 1);
  assert.equal(s2.srv.graph.active, id);
  await s2.stop();

  await withServer(t, { root });
  const again = bootReport(root);
  assert.equal(again.clean, true, JSON.stringify(again.states));
  assert.deepEqual(again.states, {});
});

test('commit-record-without-node: a torn node file is set aside and reported in boot-report.json, /api/health (local only) and one integrity event; the next id is fresh', async (t) => {
  const s1 = await withServer(t);
  const A = (await turn(s1.api, 'A', () => render(s1.api, 'm1'))).json.node_id;
  const B = (await turn(s1.api, 'B', () => render(s1.api, 'm2'))).json.node_id;
  await s1.stop();
  const root = s1.root;
  fs.writeFileSync(path.join(graphDir(root), `${B}.json`), `{"id":"${B}","trunc`);

  const s2 = await withServer(t, { root });
  const report = bootReport(root);
  assert.deepEqual(unclean(report), ['commit-record-without-node'], JSON.stringify(report.states));
  const orphan = report.states['commit-record-without-node'];
  assert.equal(orphan.count, 1);
  assert.match(orphan.examples[0], new RegExp(`^${B}\\.json\\.corrupt-`), 'the aside file is named');
  assert.deepEqual(orphan.detail, [{ node: B, aside: orphan.examples[0], record: true }]);
  assert.ok(fs.existsSync(path.join(graphDir(root), orphan.examples[0])));
  assert.equal(s2.srv.graph.active, A);

  const local = (await s2.api.get('/api/health')).json;
  assert.deepEqual(local.graph_integrity, { clean: false, states: { 'commit-record-without-node': 1 }, report: REPORT_NAME });
  const remote = (await s2.api.get('/api/health', { 'X-WC-Remote': '1' })).json;
  assert.equal(remote.remote, true);
  assert.equal('graph_integrity' in remote, false, 'absent below local');

  const events = integrityEvents(s2.srv);
  assert.equal(events.length, 1);
  assert.equal(events[0].op, 'boot');
  assert.equal(events[0].clean, false);
  assert.deepEqual(events[0].states, { 'commit-record-without-node': 1 }, 'counts only');
  assert.ok(!JSON.stringify(events[0]).includes('corrupt'), 'no file names on the ring');

  const C = (await turn(s2.api, 'C', () => render(s2.api, 'm3'))).json.node_id;
  assert.notEqual(C, B, 'the id is never minted again');
  assert.equal(commitsIn(root).filter((r) => r.node === B).length, 1, 'the orphan record is not adopted by anyone');
  await s2.stop();

  // A later boot names the aside an earlier boot made.
  await withServer(t, { root });
  const later = bootReport(root);
  assert.deepEqual(later.states['commit-record-without-node'].examples, orphan.examples);
});

test('a node file set aside with no commit record is reported with record: false', async (t) => {
  const s1 = await withServer(t);
  await turn(s1.api, 'A', () => render(s1.api, 'm1'));
  await s1.stop();
  fs.writeFileSync(path.join(graphDir(s1.root), 'n40.json'), 'null');
  await withServer(t, { root: s1.root });
  const report = bootReport(s1.root);
  const orphan = report.states['commit-record-without-node'];
  assert.equal(orphan.count, 1);
  assert.equal(orphan.detail[0].record, false);
  assert.equal(orphan.detail[0].node, 'n40');
  assert.match(orphan.detail[0].aside, /^n40\.json\.corrupt-/);
});

test('dangling-commit-record: a node file edited to drop a copy is reported, not adopted, and still loads and restores', async (t) => {
  const s1 = await withServer(t);
  const A = (await turn(s1.api, 'A', async () => {
    await render(s1.api, 'm1');
    addPin(s1.srv, 'one', 'm1');
    addPin(s1.srv, 'two', 'm1');
  })).json.node_id;
  await s1.stop();
  const root = s1.root;
  const a = nodeFile(root, A);
  a.comments = a.comments.filter((c) => c.text !== 'two');
  fs.writeFileSync(path.join(graphDir(root), `${A}.json`), JSON.stringify(a));

  const s2 = await withServer(t, { root });
  const report = bootReport(root);
  assert.deepEqual(unclean(report), ['dangling-commit-record'], JSON.stringify(report.states));
  assert.deepEqual(report.states['dangling-commit-record'].examples, [A]);
  assert.equal(commitsIn(root).filter((r) => r.node === A).length, 1, 'no second record: never adopted as the node\'s truth');
  assert.ok(s2.srv.graph.nodes.has(A));
  assert.deepEqual(s2.srv.state.comments.map((p) => p.text), ['one'], 'restored as the file holds it');
});

test('copy-v-mismatch: a copy whose v is not its record\'s pin, or (on a node already not clean) whose payload is not the pinned version\'s, is named', async (t) => {
  const s1 = await withServer(t);
  let one = null;
  let two = null;
  const A = (await turn(s1.api, 'A', async () => {
    await render(s1.api, 'm1');
    one = addPin(s1.srv, 'one', 'm1');
    two = addPin(s1.srv, 'two', 'm1');
  })).json.node_id;
  await s1.stop();
  const root = s1.root;
  const a = nodeFile(root, A);
  // `one` keeps its v and loses its text; `two` claims a v its record does not pin.
  a.comments = a.comments.map((c) => (c.id === one.id ? { ...c, text: 'tampered' } : c.id === two.id ? { ...c, v: 2 } : c));
  fs.writeFileSync(path.join(graphDir(root), `${A}.json`), JSON.stringify(a));

  await withServer(t, { root });
  const report = bootReport(root);
  assert.deepEqual(unclean(report), ['copy-v-mismatch', 'dangling-commit-record'], JSON.stringify(report.states));
  assert.deepEqual(report.states['copy-v-mismatch'].examples.slice().sort(), [`${A}:${one.id}@1`, `${A}:${two.id}@2`].sort());
});

test('node-pins-missing-version: a pinned version the log lost is re-appended from the copy with the same v; a second boot is clean', async (t) => {
  const s1 = await withServer(t);
  let head = null;
  const A = (await turn(s1.api, 'A', async () => {
    await render(s1.api, 'm1');
    const p = addPin(s1.srv, 'p', 'm1');
    head = replyPin(s1.srv, p.id, 'r');
  })).json.node_id;
  await s1.stop();
  const root = s1.root;
  assert.deepEqual(commitsIn(root)[0].pins, [`${head.id}@2`]);
  const file = projectPaths(root).elementsLog;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const kept = lines.filter((l) => { const r = JSON.parse(l); return !(r.t === 'ver' && r.id === head.id && r.v === 2); });
  assert.equal(kept.length, lines.length - 1);
  fs.writeFileSync(file, kept.join('\n') + '\n');

  const s2 = await withServer(t, { root });
  const report = bootReport(root);
  assert.deepEqual(unclean(report), ['node-pins-missing-version'], JSON.stringify(report.states));
  assert.deepEqual(report.states['node-pins-missing-version'].detail, [{ node: A, pin: `${head.id}@2`, repaired: true }]);
  const v2 = s2.srv.elements.version(head.id, 2);
  assert.ok(v2, 'the pin resolves');
  assert.ok(elementLog.copyMatches(nodeFile(root, A).comments[0], v2), 'from the node\'s copy');
  await s2.stop();

  await withServer(t, { root });
  const again = bootReport(root);
  assert.equal(again.clean, true, JSON.stringify(again.states));
  assert.deepEqual(unclean(again), []);
});

test('torn-tail-set-aside and bad-line: the aside file and the bad line\'s offset are reported', async (t) => {
  const s1 = await withServer(t);
  await turn(s1.api, 'A', async () => { await render(s1.api, 'm1'); addPin(s1.srv, 'p', 'm1'); });
  await s1.stop();
  const file = projectPaths(s1.root).elementsLog;
  const offset = fs.statSync(file).size;
  fs.appendFileSync(file, '{garbage\n{"t":"ver","id":"c77","v":');

  await withServer(t, { root: s1.root });
  const report = bootReport(s1.root);
  assert.deepEqual(unclean(report), ['bad-line', 'torn-tail-set-aside'], JSON.stringify(report.states));
  assert.equal(report.states['torn-tail-set-aside'].count, 1);
  assert.match(report.states['torn-tail-set-aside'].examples[0], /^log\.jsonl\.torn-/);
  assert.ok(fs.existsSync(path.join(path.dirname(file), report.states['torn-tail-set-aside'].examples[0])));
  assert.deepEqual(report.states['bad-line'], { count: 1, examples: [offset] });
});

test('migration-refused: a v3 project with an unmappable copy boots read-only and reports the refusal with its report path', async (t) => {
  const s = await withServer(t, { seed: ({ root }) => { v3Graph(root, { unmappable: true }); } });
  const report = bootReport(s.root);
  assert.deepEqual(unclean(report), ['migration-refused'], JSON.stringify(report.states));
  assert.deepEqual(report.states['migration-refused'].examples, ['elements/migration-report.json']);
  assert.equal(report.migration.state, 'refused');
  assert.equal(report.migration.report, 'elements/migration-report.json');
  assert.equal(report.read_only, 'migration-refused');
  assert.ok(fs.existsSync(projectPaths(s.root).migrationReport));
  assert.equal(s.srv.elements.readOnly, true);
  assert.equal(commitsIn(s.root).length, 0, 'nothing adopted into an untrusted log');
});

// ── the clean boot's cost ───────────────────────────────────────────────────

test('a clean boot over 1,000 nodes redacts nothing and hashes no payload', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-reconcile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolvePaths(root);
  const T0 = 1790000000000;
  for (let k = 0; k < 1000; k++) {
    const comments = [
      { id: 'c1', seq: 1, created_at: T0, shared: true, text: 'the same pin', anchor: anchor('m1'), replies: [] },
      { id: 'c2', seq: 2, created_at: T0 + 1, shared: true, text: `edited ${Math.floor(k / 10)}`, anchor: anchor('m1'), replies: [] },
    ];
    const node = { id: `n${k}`, parent_id: k ? `n${k - 1}` : null, created_at: T0 + k * 1000, author: 'claude', trigger: { kind: 'turn', message: '', summary: '' }, mounts: [], store: {}, comments, captures: [] };
    fs.writeFileSync(path.join(paths.GRAPH_DIR, `n${k}.json`), JSON.stringify(node));
  }
  fs.writeFileSync(paths.META_PATH, JSON.stringify({ active: 'n999', lock: null, last_node: 'n999' }));
  const boot = (redactor) => {
    const state = createState();
    const graph = createGraph({ paths, state, draftPath: projectPaths(root).draft });
    graph.elements = createElementStore({ paths: projectPaths(root), state, graph, redactor, bootId: `b${Date.now()}` });
    graph.load();
    return graph;
  };
  // The first boot adopts every node (the migration's one-time cost, C-1).
  const first = boot(createRedactor());
  const r1 = reconcileElements({ graph: first, store: first.elements, paths });
  assert.equal(r1.states['node-without-commit-record'].count, 1000);
  first.elements.close();

  // The second: spies on the redactor, the payload hashers and adopt.
  const redactor = createRedactor();
  let redactions = 0;
  for (const k of Object.keys(redactor)) {
    if (typeof redactor[k] !== 'function' || /^add/.test(k)) continue;
    const orig = redactor[k];
    redactor[k] = (...a) => { redactions++; return orig.apply(redactor, a); };
  }
  const second = boot(redactor);
  t.after(() => second.elements.close());
  redactions = 0;
  const counted = {};
  for (const name of ['copyMatches', 'payloadOf']) {
    const orig = elementLog[name];
    counted[name] = 0;
    elementLog[name] = (...a) => { counted[name]++; return orig(...a); };
    t.after(() => { elementLog[name] = orig; });
  }
  let adopts = 0;
  const origAdopt = second.elements.adopt;
  second.elements.adopt = (n) => { adopts++; return origAdopt(n); };
  const r2 = reconcileElements({ graph: second, store: second.elements, paths });
  assert.equal(r2.clean, true, JSON.stringify(r2.states));
  assert.deepEqual(unclean(r2), []);
  assert.equal(redactions, 0, 'no redactor call');
  assert.deepEqual(counted, { copyMatches: 0, payloadOf: 0 }, 'no payload hashed');
  assert.equal(adopts, 0);
  assert.ok(Number.isFinite(r2.timings.reconcile_ms));
  assert.ok(r2.log.records > 1000, 'every commit record and version was read');
  assert.deepEqual(bootReport(root).states, r2.states, 'the report on disk is the one returned');
});
