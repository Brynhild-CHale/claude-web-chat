// The three tranche-1 reviewer records tranche 2 builds (PLAN-T2 §2.3, plan
// 2E.5; U354):
//
//   DRAFT-SEQ RESERVATION (U208's record). A draft pin whose payload matches a
//   logged version answers that version and appends nothing, so a seq only the
//   pin carries never reached the mint. attachLive now raises the log's
//   reservation to every valid pin's seq (in memory, never persisted).
//   THE STORE REPAIR PATH (U209's record). A pinned version the log lost is
//   re-appended through store.repair, under the store's write gate: a
//   filesystem refusal makes the store read-only ('log-unwritable') and is never
//   swallowed; a TypeError leaves it writable; the element keeps its kind.
//   THE NARROWED MINT FLOOR (U247's open issue). An unreadable node file's or
//   draft's bytes are scanned only inside their "comments" arrays
//   (element-log maxPinSeqIn), so a pane store's Date.now() seq no longer makes
//   ids jump; the wide scan stays when the tear fell before the comments key.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { withServer, existingProject, commentBody } = require('../test-support/helpers');
const { projectPaths } = require('../lib/core/paths');
const elementLog = require('../lib/core/element-log');
const { createRedactor } = require('../lib/core/redact');
const { createElementStore } = require('../lib/server/domain/elements');
const { createGraph } = require('../lib/server/graph');
const { createState } = require('../lib/server/state');
const { resolvePaths } = require('../lib/server/paths');
const { reconcileElements } = require('../lib/server/domain/elements-reconcile');

const { createElementLog, maxPinSeqIn, maxElementSeqIn } = elementLog;

const ANCHOR = { mount: 'm1', selector: 'p.lead', text: 'Hello', ordinal: 0 };
const T0 = 1760000000000;
const STORE_SEQ = 1760000000000; // the signal-key convention's Date.now()

const graphDir = (root) => projectPaths(root).graphDir;
const bootReport = (root) => JSON.parse(fs.readFileSync(projectPaths(root).elementsBootReport, 'utf8'));
const logLines = (root) => fs.readFileSync(projectPaths(root).elementsLog, 'utf8').split('\n').filter(Boolean);
const logRecords = (root) => logLines(root).map((l) => JSON.parse(l));

async function ok(p, what) {
  const r = await p;
  assert.equal(r.status, 200, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
async function turn(api, message = 'turn') {
  await ok(api.post('/api/turn-begin', { message }), 'turn-begin');
  return ok(api.post('/api/turn-end', { summary: message }), 'turn-end');
}
const addPin = async (api, text) => (await ok(api.post('/api/elements', commentBody({ text, anchor: ANCHOR })), `add ${text}`)).pin;

const pin = (n, extra = {}) => ({
  id: `c${n}`, seq: n, created_at: T0 + n, shared: true, text: `pin ${n}`, anchor: ANCHOR, replies: [], ...extra,
});
// A node whose pane store holds a signal key stamped with Date.now(), BEFORE
// its comments (the order commitNode writes), and captures after them.
function nodeWithStore(id, parent, comments, i = 9) {
  return {
    id, parent_id: parent, created_at: T0 + i * 1000, author: 'claude',
    trigger: { kind: 'turn', message: `turn ${i}`, summary: `turn ${i}` },
    mounts: [{ id: 'm1', html: '<p class="lead">Hello</p>', owner: 'claude' }],
    store: { form_submit: { seq: STORE_SEQ, payload: { ok: true } } },
    comments, captures: [],
  };
}
// The node's bytes cut AFTER its pins or BEFORE its "comments" key.
function tornBytes(node, where) {
  const text = JSON.stringify(node);
  const at = where === 'after' ? text.indexOf(',"captures"') : text.indexOf('"comments"');
  assert.ok(at > 0, 'the cut point is in the file');
  return text.slice(0, at);
}

// ── (1) the draft-seq reservation ────────────────────────────────────────────

test('a draft pin of seq 50 whose payload is its logged v1 (seq 1): the boot reserves 50, and the next add mints c51 at seq 51', async (t) => {
  const s1 = await withServer(t, { seed: existingProject });
  await ok(s1.api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello</p>' }), 'render');
  const p = await addPin(s1.api, 'the rolled-back text');
  assert.equal(p.id, 'c1');
  assert.equal(p.seq, 1);
  await s1.graceful(); // the draft holds the live pin
  const root = s1.root;
  const draftFile = projectPaths(root).draft;
  const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
  const dp = draft.comments.find((c) => c.id === 'c1');
  assert.ok(dp, 'the graceful stop wrote the pin into the draft');
  // A 0.8.5 rollback's shape: the payload is v1's, the seq a newer one.
  dp.seq = 50;
  fs.writeFileSync(draftFile, JSON.stringify(draft));
  assert.ok(!logRecords(root).some((r) => r.seq === 50), 'the log never saw seq 50');

  const s2 = await withServer(t, { root });
  const live = s2.srv.state.comments.find((c) => c.id === 'c1');
  assert.ok(live, 'the draft restored the pin');
  assert.equal(live.v, 1, 'its payload hash-matches v1: nothing was appended for it');
  assert.ok(s2.srv.elements.maxSeq() >= 50, `maxSeq ${s2.srv.elements.maxSeq()} reserves the pin's seq`);
  assert.ok(!logRecords(root).some((r) => r.t === 'ver' && r.seq === 50), 'the reservation is not persisted');
  const next = await addPin(s2.api, 'after the restore');
  assert.equal(next.id, 'c51', 'never c2 … c50, so get_comments(since) stops serving the draft pin');
  assert.equal(next.seq, 51);
});

test('attachLive reserves every valid pin\'s positive-integer seq, a read-only store\'s too, and writes nothing for it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-draft-seq-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'log.jsonl');
  const store = createElementStore({ paths: { elementsLog: file }, state: createState(), graph: null, redactor: createRedactor(), bootId: 'b1' });
  t.after(() => store.close());
  const a = store.add({ text: 'a', anchor: ANCHOR });
  const bytes = fs.readFileSync(file, 'utf8');
  const pins = [{ ...a, seq: 40 }, { ...a, seq: 'nope' }, null, { ...a, id: '', seq: 900 }];
  store.attachLive(pins, {});
  assert.equal(store.maxSeq(), 40, 'the valid pin\'s seq, not the invalid ones\'');
  assert.equal(pins[1].v, 1, 'a pin whose seq is not a positive integer still attaches, and reserves nothing');
  assert.equal(pins[0].v, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'a reservation appends nothing');

  // A refused migration leaves the store read-only: it still reserves.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-draft-seq-ro-'));
  t.after(() => fs.rmSync(dir2, { recursive: true, force: true }));
  const ro = createElementStore({ paths: { elementsLog: path.join(dir2, 'log.jsonl') }, state: createState(), graph: null, redactor: createRedactor(), bootId: 'b2', migration: { refused: true } });
  t.after(() => ro.close());
  assert.equal(ro.readOnly, true);
  ro.attachLive([pin(77)], {});
  assert.equal(ro.maxSeq(), 77);
  assert.equal(fs.existsSync(path.join(dir2, 'log.jsonl')), false, 'nothing written');
});

// ── (2) the store repair path ────────────────────────────────────────────────

// A v4 project with c1 (v1) replied to (v2) and committed, stopped, then the
// log truncated by whole lines to drop c1@2. → {root, node, head}.
async function seedLostVersion(t) {
  const s1 = await withServer(t, { seed: existingProject });
  await ok(s1.api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello</p>' }), 'render');
  const p = await addPin(s1.api, 'p');
  const head = (await ok(s1.api.post(`/api/elements/${p.id}/reply`, { text: 'r' }), 'reply')).pin;
  assert.equal(head.v, 2);
  const node = (await turn(s1.api, 'A')).node_id;
  await s1.stop();
  const root = s1.root;
  const file = projectPaths(root).elementsLog;
  const lines = logLines(root);
  const kept = lines.filter((l) => { const r = JSON.parse(l); return !(r.t === 'ver' && r.id === head.id && r.v === 2); });
  assert.equal(kept.length, lines.length - 1);
  fs.writeFileSync(file, kept.join('\n') + '\n');
  return { root, node, head };
}

// The daemon's boot order for the graph and the store, without a server.
function bootStandalone(t, root) {
  const paths = resolvePaths(root);
  const state = createState();
  const graph = createGraph({ paths, state, draftPath: projectPaths(root).draft });
  graph.elements = createElementStore({ paths: projectPaths(root), state, graph, redactor: createRedactor(), bootId: `b${Date.now()}` });
  t.after(() => graph.elements.close());
  graph.load();
  return { graph, store: graph.elements, paths };
}

test('repair under a filesystem refusal (an EIO append): repaired false, the store read-only (log-unwritable), the next write READ_ONLY', async (t) => {
  const { root, node, head } = await seedLostVersion(t);
  const { graph, store, paths } = bootStandalone(t, root);
  const orig = store.log.appendVersion;
  let refused = 0;
  store.log.appendVersion = (...a) => {
    if (!refused++) throw Object.assign(new Error('injected: i/o error'), { code: 'EIO' });
    return orig(...a);
  };
  const report = reconcileElements({ graph, store, paths });
  assert.equal(refused, 1, 'the repair reached the log\'s append once');
  assert.deepEqual(report.states['node-pins-missing-version'].detail, [{ node, pin: `${head.id}@2`, repaired: false }]);
  assert.equal(store.readOnly, true, 'the store learned its log is unwritable');
  assert.equal(store.readOnlyReason, 'log-unwritable');
  assert.equal(store.stats().unavailable, 'EIO');
  assert.equal(report.read_only, 'log-unwritable');
  assert.throws(() => store.add({ text: 'next', anchor: ANCHOR }), (e) => e.code === 'READ_ONLY');
  assert.throws(() => store.repair({ node: { id: node }, id: head.id, v: 2, copy: head }), (e) => e.code === 'READ_ONLY',
    'a read-only store\'s repair throws READ_ONLY');
});

test('repair under a filesystem refusal at boot (ENOSPC on the version\'s bytes): the route answers the next element write 503', async (t) => {
  const { root, node, head } = await seedLostVersion(t);
  const origWrite = fs.writeSync;
  let refused = 0;
  const restore = () => { fs.writeSync = origWrite; };
  t.after(restore);
  fs.writeSync = function writeSync(fd, buf, ...rest) {
    if (!refused && Buffer.isBuffer(buf) && buf.includes('"t":"ver"')) {
      refused++;
      throw Object.assign(new Error('injected: no space left on device'), { code: 'ENOSPC' });
    }
    return origWrite.call(this, fd, buf, ...rest);
  };
  let s2;
  try { s2 = await withServer(t, { root }); } finally { restore(); }
  assert.equal(refused, 1);
  const report = bootReport(root);
  assert.deepEqual(report.states['node-pins-missing-version'].detail, [{ node, pin: `${head.id}@2`, repaired: false }]);
  assert.equal(s2.srv.elements.readOnly, true);
  assert.equal(s2.srv.elements.readOnlyReason, 'log-unwritable');
  const r = await s2.api.post('/api/elements', commentBody({ text: 'after the refusal', anchor: ANCHOR }));
  assert.equal(r.status, 503, r.text);
});

test('repair under a TypeError: repaired false and the store stays writable', async (t) => {
  const { root, node, head } = await seedLostVersion(t);
  const { graph, store, paths } = bootStandalone(t, root);
  const orig = store.log.appendVersion;
  let thrown = 0;
  store.log.appendVersion = (...a) => {
    if (!thrown++) throw new TypeError('injected: a malformed version');
    return orig(...a);
  };
  const report = reconcileElements({ graph, store, paths });
  assert.equal(thrown, 1);
  assert.deepEqual(report.states['node-pins-missing-version'].detail, [{ node, pin: `${head.id}@2`, repaired: false }]);
  assert.equal(store.readOnly, false);
  assert.equal(store.readOnlyReason, null);
  const next = store.add({ text: 'still writable', anchor: ANCHOR });
  assert.ok(next && /^c\d+$/.test(next.id));
});

test('the truncated log: repaired true through the store, the version from the copy at its v, and a clean second boot', async (t) => {
  const { root, node, head } = await seedLostVersion(t);
  const s2 = await withServer(t, { root });
  const report = bootReport(root);
  assert.deepEqual(report.states['node-pins-missing-version'].detail, [{ node, pin: `${head.id}@2`, repaired: true }]);
  const v2 = s2.srv.elements.version(head.id, 2);
  assert.ok(v2);
  assert.equal(v2.parent_v, 1, 'the newest version below v the log holds');
  const copy = JSON.parse(fs.readFileSync(path.join(graphDir(root), `${node}.json`), 'utf8')).comments.find((c) => c.id === head.id);
  assert.deepEqual(v2.writer, copy.writer ?? null, 'the copy\'s own stamps (U203), never the repair\'s');
  assert.deepEqual(v2.provenance, copy.provenance ?? null);
  await s2.stop();
  await withServer(t, { root });
  assert.equal(bootReport(root).clean, true, JSON.stringify(bootReport(root).states));
});

test('repair keeps the version\'s kind: a lost highlight version is re-appended under its el record\'s kind and schema', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-repair-kind-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'log.jsonl');
  const hl = { anchor: { mount: 'm1', selector: 'p', text: 'x', ordinal: 0 }, shared: true, color: 'gold', note: null };
  const log = createElementLog({ file, redactor: createRedactor(), bootId: 'b1' });
  log.load();
  const id = log.mintId('highlight');
  log.ensureElement({ id, kind: 'highlight', created_at: T0 });
  const v1 = log.appendVersion({ id, schema: 'highlight@1', payload: hl });
  const v2 = log.appendVersion({ id, schema: 'highlight@1', payload: { ...hl, color: 'rust' }, parent_v: 1 });
  log.close();
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(file, lines.filter((l) => { const r = JSON.parse(l); return !(r.t === 'ver' && r.v === 2); }).join('\n') + '\n');

  const store = createElementStore({ paths: { elementsLog: file }, state: createState(), graph: null, redactor: createRedactor(), bootId: 'b2' });
  t.after(() => store.close());
  assert.equal(store.version(id, 2), null, 'the version is lost');
  const copy = { id, seq: v2.seq, ...hl, color: 'rust', writer: 'user', provenance: 'web' };
  assert.deepEqual(store.repair({ node: { id: 'n5', parent_id: null }, id, v: 2, copy }), { repaired: true });
  const back = store.version(id, 2);
  assert.equal(back.schema, 'highlight@1', 'never comment@1');
  assert.equal(store.log.element(id).kind, 'highlight');
  assert.equal(back.payload.color, 'rust');
  assert.equal(back.parent_v, v1.v);
  assert.equal(back.seq, v2.seq);
  assert.equal(back.writer, 'user');
  // A later version already there: nothing is appended.
  assert.deepEqual(store.repair({ node: null, id, v: 2, copy }), { repaired: false });
  assert.equal(store.versionsOf(id).length, 2);
  // A comment id with no el record is a comment.
  assert.deepEqual(store.repair({ node: null, id: 'c90', v: 1, copy: pin(90) }), { repaired: true });
  assert.equal(store.log.element('c90').kind, 'comment');
  assert.equal(store.version('c90', 1).schema, 'comment@1');
  assert.equal(store.readOnly, false);
});

// ── (3) the narrowed mint floor ──────────────────────────────────────────────

test('maxPinSeqIn: only inside the "comments" arrays; strings, escapes and brackets honoured; found false before the key', () => {
  const node = nodeWithStore('n9', 'n1', [pin(4), pin(7)]);
  const text = JSON.stringify(node);
  assert.equal(maxElementSeqIn(text), STORE_SEQ, 'the wide scan reads the store');
  assert.deepEqual(maxPinSeqIn(text), { max: 7, found: true });
  assert.deepEqual(maxPinSeqIn(tornBytes(node, 'after')), { max: 7, found: true });
  assert.deepEqual(maxPinSeqIn(tornBytes(node, 'before')), { max: 0, found: false }, 'the tear fell before the key');
  // A tear inside the array: the span runs to EOF.
  const mid = text.slice(0, text.indexOf('"id":"c7"') + '"id":"c7"'.length);
  assert.deepEqual(maxPinSeqIn(mid), { max: 7, found: true });
  // An escaped quote and brackets inside a comment's text do not end the span;
  // a capture's seq after the array is not a pin's.
  const tricky = JSON.stringify({
    store: { s: { seq: STORE_SEQ } },
    comments: [pin(3, { text: 'he said "]}" [ {', replies: [{ author: 'user', at: 1, text: '\\"]' }] }), pin(9)],
    captures: [{ seq: 500 }],
  });
  assert.deepEqual(maxPinSeqIn(tricky), { max: 9, found: true });
  // Whitespace after the key, two arrays (a node's and a draft's shapes), none.
  assert.deepEqual(maxPinSeqIn('{"comments" : [ {"seq": 2} ], "x": {"comments":[{"id":"h11"}]}, "seq": 99'), { max: 11, found: true });
  assert.deepEqual(maxPinSeqIn('{"comments":[]}'), { max: 0, found: true });
  assert.deepEqual(maxPinSeqIn(''), { max: 0, found: false });
  assert.deepEqual(maxPinSeqIn(null), { max: 0, found: false });
});

test('the one scanner: maxPinSeqIn reads through ELEMENT_SEQ_RE, and no file gains a second "seq" regex', () => {
  const lib = path.join(__dirname, '..', 'lib');
  for (const rel of ['core/element-log.js', 'core/element-migrate.js', 'server/domain/elements-reconcile.js']) {
    const src = fs.readFileSync(path.join(lib, rel), 'utf8');
    assert.equal((src.match(/\/"seq":[^/\n]*\/g?/g) || []).length, rel === 'core/element-log.js' ? 1 : 0, rel);
    assert.equal((src.match(/\/"comments"/g) || []).length, rel === 'core/element-log.js' ? 1 : 0, `${rel}: one comments-key regex`);
  }
});

// The reconcile, unit: one node aside, a stand-in store over a real log.
function reconcileAside(t, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-narrow-floor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gdir = path.join(dir, 'graph');
  fs.mkdirSync(gdir);
  const aside = 'n9.json.corrupt-1760000000000';
  fs.writeFileSync(path.join(gdir, aside), bytes);
  const log = createElementLog({ file: path.join(dir, 'log.jsonl'), redactor: createRedactor() });
  log.load();
  t.after(() => log.close());
  const graph = {
    nodes: new Map(), topology: new Map(), nextSeq: 10, active: null, lastNode: null,
    loadReport: { nodes_aside: [{ file: 'n9.json', aside, why: 'torn' }], meta_aside: null },
  };
  const report = reconcileElements({ graph, store: { log, stats: () => log.stats() }, paths: { GRAPH_DIR: gdir } });
  return { report, log, aside };
}

test('a torn node aside whose store holds a Date.now() seq and whose comments hold seq 7: mint_floor 7, the next id c8', (t) => {
  const { report, log, aside } = reconcileAside(t, tornBytes(nodeWithStore('n9', 'n1', [pin(4), pin(7)]), 'after'));
  assert.deepEqual(report.mint_floor, { seq: 7, files: [aside] });
  assert.deepEqual(report.states['commit-record-without-node'].detail, [{ node: 'n9', aside, record: false, max_seq: 7 }]);
  assert.equal(log.mintId(), 'c8');
});

test('a tear before the comments key keeps the wide floor (U247\'s behaviour)', (t) => {
  const { report, log } = reconcileAside(t, tornBytes(nodeWithStore('n9', 'n1', [pin(4), pin(7)]), 'before'));
  assert.equal(report.mint_floor.seq, STORE_SEQ);
  assert.equal(log.mintId(), `c${STORE_SEQ + 1}`, 'ids jump, never collide');
});

test('end to end: a v4 project with c1-c3 and a torn node holding a store seq and c4-c7 reboots minting c8', async (t) => {
  const s1 = await withServer(t, { seed: existingProject });
  await ok(s1.api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello</p>' }), 'render');
  for (const text of ['one', 'two', 'three']) await addPin(s1.api, text);
  const active = (await turn(s1.api, 'pins')).node_id;
  await s1.stop();
  fs.writeFileSync(path.join(graphDir(s1.root), 'n9.json'),
    tornBytes(nodeWithStore('n9', active, [pin(4), pin(5), pin(6), pin(7)]), 'after'));
  const s2 = await withServer(t, { root: s1.root });
  const report = bootReport(s1.root);
  assert.equal(report.mint_floor.seq, 7, JSON.stringify(report.mint_floor));
  assert.equal((await addPin(s2.api, 'after the tear')).id, 'c8');
});

test('migration: a v3 project with a torn node aside holding a pane store seq and comment seqs records seq_floor = the comment max', async (t) => {
  const s = await withServer(t, {
    seed: ({ webChatDir }) => {
      fs.writeFileSync(path.join(webChatDir, '_version.json'), JSON.stringify({ version: 3 }) + '\n');
      const g = path.join(webChatDir, 'graph');
      fs.mkdirSync(g, { recursive: true });
      const n1 = nodeWithStore('n1', null, [pin(1), pin(2), pin(3)], 1);
      n1.store = {};
      fs.writeFileSync(path.join(g, 'n1.json'), JSON.stringify(n1));
      fs.writeFileSync(path.join(g, 'n9.json.corrupt-1760000009000'),
        tornBytes(nodeWithStore('n9', 'n1', [pin(4), pin(5), pin(6)], 2), 'after'));
      fs.writeFileSync(path.join(g, '_meta.json'), JSON.stringify({ active: 'n1' }));
    },
  });
  const migration = logRecords(s.root).find((r) => r.t === 'migration');
  assert.ok(migration, 'the migration ran');
  assert.equal(migration.seq_floor, 6, 'the comment max, never the store\'s Date.now()');
  assert.equal(bootReport(s.root).mint_floor.seq, 6);
  assert.equal((await addPin(s.api, 'after the migration')).id, 'c7');
});

test('migration: a torn aside cut before its comments key keeps the wide floor', async (t) => {
  const s = await withServer(t, {
    seed: ({ webChatDir }) => {
      fs.writeFileSync(path.join(webChatDir, '_version.json'), JSON.stringify({ version: 3 }) + '\n');
      const g = path.join(webChatDir, 'graph');
      fs.mkdirSync(g, { recursive: true });
      const n1 = nodeWithStore('n1', null, [pin(1)], 1);
      n1.store = {};
      fs.writeFileSync(path.join(g, 'n1.json'), JSON.stringify(n1));
      fs.writeFileSync(path.join(g, 'n9.json.corrupt-1760000009000'),
        tornBytes(nodeWithStore('n9', 'n1', [pin(4)], 2), 'before'));
      fs.writeFileSync(path.join(g, '_meta.json'), JSON.stringify({ active: 'n1' }));
    },
  });
  const migration = logRecords(s.root).find((r) => r.t === 'migration');
  assert.ok(migration);
  assert.equal(migration.seq_floor, STORE_SEQ);
});
