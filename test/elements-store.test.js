// The daemon's element store (lib/server/domain/elements, U203): add / edit /
// reply through the log's one redacted writer and the pin projection (ruling
// A2's stamps), maskPins, read-only mode, and the pinned `v` carried through a
// restore, the draft and the dirty check (PLAN-T1 §2.3 finding (4)).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { withServer, existingProject } = require('../test-support/helpers');
const { fakeSecrets } = require('../test-support/fake-secrets');
const { createElementStore } = require('../lib/server/domain/elements');
const { createElementLog, payloadOf, copyMatches, convertAnchor } = require('../lib/core/element-log');
const { createRedactor } = require('../lib/core/redact');
const { projectPaths } = require('../lib/core/paths');
const { resolvePaths } = require('../lib/server/paths');
const { createState } = require('../lib/server/state');
const { createGraph } = require('../lib/server/graph');
const { liveIsDirty, nodeViewKey } = require('../lib/server/domain/turns');

const SECRET = fakeSecrets({ seed: 7 }).find((f) => f.id === 'github-ghp');
const ANCHOR = { mount: 'm1', selector: 'p.lead', text: 'Hello', ordinal: 0 };

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-element-store-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// A store on a fresh project, closed when the test ends.
function storeIn(t, dir, opts = {}) {
  const state = opts.state || createState();
  const graph = opts.graph || { active: null };
  const redactor = opts.redactor || createRedactor();
  let clock = 1000;
  const store = createElementStore({
    paths: projectPaths(dir), state, graph, redactor, bootId: 'test:1',
    migration: opts.migration || null, now: opts.now || (() => ++clock),
  });
  t.after(() => store.close());
  return { store, state, graph, redactor };
}

const logBytes = (dir) => {
  try { return fs.statSync(projectPaths(dir).elementsLog).size; } catch { return 0; }
};
const verRecords = (dir) => {
  let text = '';
  try { text = fs.readFileSync(projectPaths(dir).elementsLog, 'utf8'); } catch {}
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

// ── the store's writes ──────────────────────────────────────────────────────

test('add / edit / reply append versions with seq strictly increasing, ids "c" + seq', (t) => {
  const dir = tmpDir(t);
  const { store } = storeIn(t, dir);
  const a = store.add({ text: 'one', anchor: ANCHOR });
  const b = store.add({ text: 'two', anchor: ANCHOR });
  assert.equal(a.id, `c${a.seq}`);
  assert.equal(b.id, `c${b.seq}`);
  assert.ok(b.seq > a.seq);
  const e = store.edit(a, { text: 'one, edited' });
  assert.equal(e.unchanged, false);
  assert.ok(e.pin.seq > b.seq);
  assert.equal(e.pin.id, a.id, 'an edit keeps the id');
  assert.equal(e.pin.v, 2);
  const r = store.reply(e.pin, { text: 'a reply', author: 'claude' });
  assert.ok(r.seq > e.pin.seq);
  assert.equal(r.v, 3);
  assert.equal(store.maxSeq(), r.seq, 'maxSeq is the last seq');
  const seqs = verRecords(dir).filter((x) => x.t === 'ver').map((x) => x.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
  assert.equal(new Set(seqs).size, seqs.length);
});

test('the returned pin is the redacted payload: a secret typed into a comment shows masked, and never lands on disk', (t) => {
  const dir = tmpDir(t);
  const { store } = storeIn(t, dir);
  const pin = store.add({ text: SECRET.text, anchor: ANCHOR });
  for (const s of SECRET.secrets) {
    assert.ok(!pin.text.includes(s), 'the pin carries the masked text');
    assert.ok(!fs.readFileSync(projectPaths(dir).elementsLog, 'utf8').includes(s), 'the log never held it');
  }
  assert.notEqual(pin.text, SECRET.text);
});

test('the pin serves the ORIGINAL locator; the log keeps the converted anchor', (t) => {
  const dir = tmpDir(t);
  const { store } = storeIn(t, dir);
  const pin = store.add({ text: 'x', anchor: ANCHOR });
  assert.deepEqual(pin.anchor, ANCHOR);
  const ver = verRecords(dir).find((x) => x.t === 'ver');
  assert.deepEqual(ver.payload.anchor, convertAnchor(ANCHOR));
  assert.deepEqual(ver.original, ANCHOR);
  assert.equal(pin.shared, true);
  assert.equal(pin.replies, undefined, 'no replies key until a reply');
  assert.equal(typeof pin.created_at, 'number');
});

test('edit with the same text answers unchanged and appends nothing (no seq spent)', (t) => {
  const dir = tmpDir(t);
  const { store } = storeIn(t, dir);
  const pin = store.add({ text: 'same', anchor: ANCHOR });
  const bytes = logBytes(dir);
  const seq = store.maxSeq();
  const r = store.edit(pin, { text: 'same' });
  assert.equal(r.unchanged, true);
  assert.equal(r.pin.v, pin.v);
  assert.equal(logBytes(dir), bytes);
  assert.equal(store.maxSeq(), seq);
  // A shared toggle is a change.
  const s = store.edit(pin, { shared: false });
  assert.equal(s.unchanged, false);
  assert.equal(s.pin.shared, false);
});

test('reply appends {author, at, text} to the thread', (t) => {
  const dir = tmpDir(t);
  const { store } = storeIn(t, dir);
  const pin = store.add({ text: 'q', anchor: ANCHOR });
  const r1 = store.reply(pin, { text: 'first', author: 'user' });
  const r2 = store.reply(r1, { text: 'second', author: 'claude' });
  assert.deepEqual(r2.replies.map((r) => [r.author, r.text]), [['user', 'first'], ['claude', 'second']]);
  for (const r of r2.replies) assert.equal(typeof r.at, 'number');
  const last = verRecords(dir).filter((x) => x.t === 'ver').pop();
  assert.deepEqual(Object.keys(last.payload.replies[1]).sort(), ['at', 'author', 'text']);
  assert.equal(last.parent_v, 2);
});

test('maskPins masks a value the redactor learns after the write; the log and the pin keep their bytes', (t) => {
  const dir = tmpDir(t);
  const { store, redactor } = storeIn(t, dir);
  const value = 'plain-words-nobody-masks-9182';
  const pin = store.reply(store.add({ text: `see ${value}`, anchor: ANCHOR }), { text: `and ${value}`, author: 'user' });
  assert.ok(pin.text.includes(value), 'not rule-shaped: the write kept it');
  assert.ok(redactor.addKnown(value, 'known'));
  const [masked] = store.maskPins([pin]);
  assert.ok(!masked.text.includes(value));
  assert.ok(!masked.replies[0].text.includes(value));
  assert.ok(pin.text.includes(value), 'the pin handed in is not rewritten');
  assert.ok(fs.readFileSync(projectPaths(dir).elementsLog, 'utf8').includes(value), 'the bytes are never rewritten');
});

test('read-only (a refused migration): add, edit and reply throw READ_ONLY, and the store writes nothing', (t) => {
  const dir = tmpDir(t);
  const { store, state } = storeIn(t, dir, { migration: { refused: true } });
  assert.equal(store.readOnly, true);
  assert.throws(() => store.add({ text: 'x', anchor: ANCHOR }), (e) => e.code === 'READ_ONLY');
  const pin = { id: 'c1', seq: 1, created_at: 1, shared: true, text: 'x', anchor: ANCHOR };
  assert.throws(() => store.edit(pin, { text: 'y' }), (e) => e.code === 'READ_ONLY');
  assert.throws(() => store.reply(pin, { text: 'y' }), (e) => e.code === 'READ_ONLY');
  state.comments = [pin];
  assert.equal(store.appendCommit({ id: 'n0', parent_id: null, created_at: 1, comments: [pin] }), null);
  store.attachLive(state.comments, { draft: true });
  assert.equal(logBytes(dir), 0, 'nothing was written');
  assert.equal(store.stats().read_only, true);
});

// ── ruling A2: the stamps ───────────────────────────────────────────────────

test('A2: writer/provenance are v1\'s, edited is the newest text/shared change, each reply carries its own version\'s pair', (t) => {
  const dir = tmpDir(t);
  const { store } = storeIn(t, dir);
  const W = (n) => ({ class: 'user', owner: `o${n}`, verified: n % 2 === 0 });
  const P = (n) => ({ origin: 'local', device: `d${n}` });
  const p1 = store.add({ text: 'a', anchor: ANCHOR, writer: W(1), provenance: P(1) });
  assert.deepEqual(p1.writer, W(1));
  assert.deepEqual(p1.provenance, P(1));
  assert.equal(p1.edited, undefined);
  const p2 = store.reply(p1, { text: 'r1', author: 'claude', writer: W(2), provenance: P(2) });
  assert.equal(p2.edited, undefined, 'a reply alone is not an edit');
  assert.deepEqual(p2.writer, W(1));
  const e3 = store.edit(p2, { text: 'a, changed', writer: W(3), provenance: P(3) });
  assert.deepEqual(e3.pin.edited.writer, W(3));
  assert.deepEqual(e3.pin.edited.provenance, P(3));
  assert.equal(typeof e3.pin.edited.at, 'number');
  const p4 = store.reply(e3.pin, { text: 'r2', author: 'user', writer: W(4), provenance: P(4) });
  assert.deepEqual(p4.edited.writer, W(3), 'still the newest text change');
  const e5 = store.edit(p4, { shared: false, writer: W(5), provenance: P(5) });
  assert.deepEqual(e5.pin.edited.writer, W(5), 'a shared toggle is an edit too');
  assert.deepEqual(e5.pin.writer, W(1));
  assert.deepEqual(e5.pin.provenance, P(1));
  assert.deepEqual(e5.pin.replies.map((r) => r.writer), [W(2), W(4)]);
  assert.deepEqual(e5.pin.replies.map((r) => r.provenance), [P(2), P(4)]);
  // An edit back to v1's text is still the newest edit (it differs from its
  // parent), and a reply after it does not take its place.
  const e6 = store.edit(e5.pin, { text: 'a', shared: true, writer: W(6), provenance: P(6) });
  assert.equal(e6.unchanged, false);
  assert.deepEqual(e6.pin.edited.writer, W(6));
  const p7 = store.reply(e6.pin, { text: 'r3', author: 'user', writer: W(7), provenance: P(7) });
  assert.deepEqual(p7.edited.writer, W(6));

  // A store reopened on the same log projects the same pin.
  store.close();
  const again = createElementStore({ paths: projectPaths(dir), state: createState(), graph: { active: null }, redactor: createRedactor(), bootId: 'test:2' });
  t.after(() => again.close());
  assert.deepEqual(again.project(p7.id, p7.v), p7);
});

test('A2: the stamps stay outside both hashes', (t) => {
  const a = tmpDir(t);
  const b = tmpDir(t);
  const sa = storeIn(t, a).store;
  const sb = storeIn(t, b).store;
  sa.add({ text: 'same', anchor: ANCHOR, writer: { class: 'claude', owner: null, verified: true }, provenance: { origin: 'local' } });
  sb.add({ text: 'same', anchor: ANCHOR });
  const va = verRecords(a).find((x) => x.t === 'ver');
  const vb = verRecords(b).find((x) => x.t === 'ver');
  assert.equal(va.payload_hash, vb.payload_hash);
  assert.equal(va.src_hash, vb.src_hash);
  assert.notDeepEqual(va.writer, vb.writer);
});

// ── clonePin keeps v (a test, not code) ─────────────────────────────────────

test('snapshotLive and restoreLiveToNode carry a pin\'s v (clonePin spreads)', (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  const state = createState();
  const graph = createGraph({ paths: resolvePaths(dir), state });
  state.comments = [{ id: 'c1', seq: 1, created_at: 1, shared: true, text: 'x', anchor: ANCHOR, v: 3, replies: [{ author: 'user', at: 2, text: 'r' }] }];
  const snap = graph.snapshotLive();
  assert.equal(snap.comments[0].v, 3);
  graph.nodes.set('n0', { id: 'n0', parent_id: null, created_at: 1, mounts: [], store: {}, comments: snap.comments, captures: [] });
  state.comments = [];
  graph.restoreLiveToNode('n0');
  assert.equal(state.comments[0].v, 3);
  assert.notEqual(state.comments[0], snap.comments[0], 'a copy, not the node\'s object');
});

// ── the pinned v through restore, the draft and the dirty check ─────────────

const COPY = { id: 'c1', seq: 1, created_at: 500, shared: true, text: 'note on the lead', anchor: ANCHOR };
function nodeFile(id, parent, over = {}) {
  return {
    id, parent_id: parent, created_at: 1000 + Number(id.slice(1)), author: 'claude',
    trigger: { kind: 'turn', message: '', summary: '' },
    mounts: [{ id: 'm1', html: '<p class="lead">Hello</p>' }], store: {}, comments: [{ ...COPY }], captures: [],
    ...over,
  };
}
// Seed a project: node files whose copies carry no v, and a log whose commit
// records pin them (written with createElementLog before the daemon boots).
function seedGraph(webChatDir, { nodes, records, active }) {
  const gdir = path.join(webChatDir, 'graph');
  fs.mkdirSync(gdir, { recursive: true });
  for (const n of nodes) fs.writeFileSync(path.join(gdir, `${n.id}.json`), JSON.stringify(n));
  fs.writeFileSync(path.join(gdir, '_meta.json'), JSON.stringify({ active }));
  const log = createElementLog({ file: projectPaths(path.dirname(webChatDir)).elementsLog, redactor: createRedactor(), bootId: 'seed:1' });
  log.load();
  log.ensureElement({ id: 'c1', kind: 'comment', created_at: COPY.created_at });
  log.appendVersion({ id: 'c1', payload: payloadOf(COPY), seq: COPY.seq, original: COPY.anchor, at: 600 });
  for (const n of records) log.appendCommit({ node: n, pins: ['c1@1'] });
  log.close();
}

test('the dirty check ignores v: a restored pre-upgrade node is clean, a no-change turn commits 0 nodes, and restore appends nothing', async (t) => {
  const n0 = nodeFile('n0', null);
  const { api, srv, root } = await withServer(t, {
    seed: ({ webChatDir }) => seedGraph(webChatDir, { nodes: [n0], records: [n0], active: 'n0' }),
  });
  const before = logBytes(root);
  const pins = (await api.get('/api/comments')).json.comments;
  assert.equal(pins.length, 1);
  assert.equal(pins[0].v, 1, 'restore stamped v from the commit record');
  assert.equal(srv.elements.stats().appended_records, 0, 'stamped with 0 appends');
  assert.equal(liveIsDirty(srv.graph), false);
  await api.post('/api/turn-begin', { message: 'chat' });
  const end = await api.post('/api/turn-end', { author: 'claude' });
  assert.equal(end.json.skipped, 'no-change');
  assert.equal((await api.get('/api/graph')).json.nodes.length, 1, '0 nodes committed');
  // A second restore of the same node appends 0 bytes.
  srv.graph.restoreLiveToNode('n0', srv.bus);
  assert.equal(srv.graph.lastNode, null);
  assert.equal(logBytes(root), before);
  // nodeViewKey is blind to v.
  assert.equal(nodeViewKey(n0), nodeViewKey({ ...n0, comments: n0.comments.map((c) => ({ ...c, v: 1 })) }));
});

test('attachLive: a copy whose text differs from its record\'s version mints once, counts a mismatch, and later restores append nothing', async (t) => {
  const n0 = nodeFile('n0', null);
  const n1 = nodeFile('n1', 'n0', { comments: [{ ...COPY, text: 'edited by hand' }] });
  const { srv, root } = await withServer(t, {
    seed: ({ webChatDir }) => seedGraph(webChatDir, { nodes: [n0, n1], records: [n0, n1], active: 'n0' }),
  });
  assert.equal(srv.elements.stats().copy_v_mismatch, 0);
  const b0 = logBytes(root);
  srv.graph.restoreLiveToNode('n1', srv.bus);
  const pin = srv.state.comments[0];
  assert.equal(pin.text, 'edited by hand', 'attachLive never rewrites text');
  assert.equal(pin.v, 2, 'a version minted from the copy');
  assert.ok(copyMatches(pin, srv.elements.version('c1', 2)));
  assert.equal(srv.elements.stats().copy_v_mismatch, 1);
  assert.equal(srv.elements.stats().minted_on_attach, 1);
  const b1 = logBytes(root);
  assert.ok(b1 > b0);
  srv.graph.restoreLiveToNode('n1', srv.bus);
  srv.graph.restoreLiveToNode('n1', srv.bus);
  assert.equal(logBytes(root), b1, 'the second and third restores append nothing');
  assert.equal(srv.state.comments[0].v, 2);
  assert.equal(srv.elements.stats().copy_v_mismatch, 1, 'counted once per node and pin');
});

test('the draft: a graceful stop and reboot restores the live pins with their v and appends 0 version records', async (t) => {
  const n0 = nodeFile('n0', null);
  const first = await withServer(t, {
    seed: ({ webChatDir }) => seedGraph(webChatDir, { nodes: [n0], records: [n0], active: 'n0' }),
  });
  // Uncommitted work so a draft is written.
  await first.api.post('/api/render', { id: 'm2', html: '<p>draft</p>' });
  assert.equal(first.srv.state.comments[0].v, 1);
  await first.graceful();
  const draft = JSON.parse(fs.readFileSync(path.join(first.webChatDir, 'draft.json'), 'utf8'));
  assert.equal(draft.comments[0].v, 1, 'the draft carries v');
  const vers = verRecords(first.root).filter((x) => x.t === 'ver').length;

  const second = await withServer(t, { root: first.root });
  const pins = (await second.api.get('/api/comments')).json.comments;
  assert.equal(pins[0].v, 1);
  assert.ok((await second.api.get('/api/mounts')).json.mounts.some((m) => m.id === 'm2'), 'the draft was restored');
  assert.equal(verRecords(first.root).filter((x) => x.t === 'ver').length, vers, '0 version records appended');
  assert.equal(second.srv.elements.stats().appended_records, 0);
});

test('a commit after a pin added through today\'s route appends one version and one commit record; the node copy resolves', async (t) => {
  const { api, srv, root } = await withServer(t);
  await api.post('/api/turn-begin', { message: 'first' });
  await api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello</p>' });
  await api.post('/api/turn-end', { author: 'claude' });
  const add = await api.post('/api/comments', { text: 'a pin', anchor: ANCHOR });
  assert.equal(add.json.pin.v, undefined, 'the 0.8.5-shaped route mints no v');
  const before = verRecords(root);
  await api.post('/api/turn-begin', { message: 'second' });
  const end = await api.post('/api/turn-end', { author: 'claude' });
  assert.ok(end.json.node_id, 'the new pin is a change');
  const added = verRecords(root).slice(before.length);
  assert.equal(added.filter((x) => x.t === 'ver').length, 1);
  assert.equal(added.filter((x) => x.t === 'commit').length, 1);
  const rec = added.find((x) => x.t === 'commit');
  assert.equal(rec.node, end.json.node_id);
  const node = JSON.parse(fs.readFileSync(path.join(root, '.web-chat', 'graph', `${end.json.node_id}.json`), 'utf8'));
  const copy = node.comments.find((c) => c.id === add.json.pin.id);
  assert.equal(copy.v, undefined, 'the node file is written before the log: its copy is as it was');
  const [id, v] = rec.pins[0].split('@');
  assert.equal(id, copy.id);
  assert.ok(copyMatches(copy, srv.elements.version(id, Number(v))));
  assert.equal(srv.elements.version(id, Number(v)).seq, copy.seq, 'the version carries the copy\'s own seq');
  assert.equal(srv.state.comments[0].v, Number(v), 'the live pin is stamped');
  assert.equal(liveIsDirty(srv.graph), false, 'and the stamp is not a change');
});

test('a copy\'s own v is trusted only when the hash checks: a pin edited in place keeps a stale v, and the commit and a restore map it to the version it holds', async (t) => {
  const { api, srv, root } = await withServer(t);
  await api.post('/api/turn-begin', { message: 'first' });
  await api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello</p>' });
  await api.post('/api/turn-end', { author: 'claude' });
  const add = await api.post('/api/comments', { text: 'before', anchor: ANCHOR });
  const id = add.json.pin.id;
  await api.post('/api/turn-begin', { message: 'second' });
  const a = await api.post('/api/turn-end', { author: 'claude' });
  assert.ok(a.json.node_id);
  const v1 = srv.state.comments[0].v;
  assert.ok(Number.isInteger(v1), 'the commit stamped the live pin');
  // Today's edit route spreads the pin: the new text rides with the old v.
  const ed = await api.patch(`/api/comments/${id}`, { text: 'after' });
  assert.equal(ed.json.pin.v, v1, 'the stale v is carried');
  await api.post('/api/turn-begin', { message: 'third' });
  const b = await api.post('/api/turn-end', { author: 'claude' });
  assert.ok(b.json.node_id);
  const rec = srv.elements.commitOf(b.json.node_id);
  const pinned = Number(rec.pins.find((p) => p.startsWith(`${id}@`)).split('@')[1]);
  assert.notEqual(pinned, v1, 'the stale v is not trusted');
  assert.equal(srv.elements.version(id, pinned).parent_v, v1,
    'the version appended from the copy descends from the one the parent node\'s commit record pins');
  const node = JSON.parse(fs.readFileSync(path.join(root, '.web-chat', 'graph', `${b.json.node_id}.json`), 'utf8'));
  const copy = node.comments.find((c) => c.id === id);
  assert.equal(copy.v, v1, 'the node copy keeps the v it was written with');
  assert.ok(copyMatches(copy, srv.elements.version(id, pinned)), 'the record pins the version the copy holds');
  assert.equal(srv.state.comments[0].v, pinned, 'the live pin is re-stamped');
  assert.ok(srv.elements.stats().copy_v_mismatch >= 1, 'the stale v is counted');
  // A restore of that node: the copy's v fails the hash; the record's holds.
  const bytes = logBytes(root);
  srv.graph.restoreLiveToNode(b.json.node_id, srv.bus);
  assert.equal(srv.state.comments[0].v, pinned);
  assert.equal(srv.state.comments[0].text, 'after');
  assert.equal(logBytes(root), bytes, 'nothing appended');
});

test('a log that cannot be appended to does not fail boot: the pin is served without v, attach_failures counts it, and Set active does not throw', async (t) => {
  const n0 = nodeFile('n0', null);
  const n1 = nodeFile('n1', 'n0', { comments: [{ ...COPY, text: 'second copy' }] });
  let elementsDir = null;
  t.after(() => { if (elementsDir) { try { fs.chmodSync(elementsDir, 0o755); } catch {} } });
  const { api, srv, root } = await withServer(t, {
    seed: ({ webChatDir }) => {
      existingProject({ webChatDir }); // at SCHEMA_VERSION: no migration runs
      const gdir = path.join(webChatDir, 'graph');
      fs.mkdirSync(gdir, { recursive: true });
      for (const n of [n0, n1]) fs.writeFileSync(path.join(gdir, `${n.id}.json`), JSON.stringify(n));
      fs.writeFileSync(path.join(gdir, '_meta.json'), JSON.stringify({ active: 'n1' }));
      // An elements folder with no log in it, that nothing may write into.
      elementsDir = path.dirname(projectPaths(path.dirname(webChatDir)).elementsLog);
      fs.mkdirSync(elementsDir, { recursive: true });
      fs.chmodSync(elementsDir, 0o555);
    },
  });
  const pins = (await api.get('/api/comments')).json.comments;
  assert.equal(pins.length, 1);
  assert.equal(pins[0].text, 'second copy');
  assert.equal(pins[0].v, undefined, 'served without v');
  assert.ok(srv.elements.stats().attach_failures >= 1);
  assert.equal(srv.elements.readOnly, true, 'comments are read-only this boot');
  assert.equal(srv.elements.readOnlyReason, 'log-unwritable');
  assert.throws(() => srv.elements.add({ text: 'x', anchor: ANCHOR }), (e) => e.code === 'READ_ONLY');
  assert.equal(logBytes(root), 0, 'nothing written');
  // Set active onto the other node restores (and attaches) again: no throw.
  const r = await api.post('/api/graph/active', { id: 'n0' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(srv.graph.active, 'n0');
  assert.equal(srv.state.comments[0].text, COPY.text);
  assert.equal(srv.state.comments[0].v, undefined);
  // A commit on it: the node lands, the commit record is skipped, not failed.
  await api.post('/api/turn-begin', { message: 'go' });
  await api.post('/api/render', { id: 'm9', html: '<p>more</p>' });
  const end = await api.post('/api/turn-end', { author: 'claude' });
  assert.ok(end.json.node_id);
  assert.equal(srv.graph.active, end.json.node_id);
  assert.ok(srv.elements.stats().commits_skipped_read_only >= 1);
  assert.equal(logBytes(root), 0);
});

test('a filesystem refusal on a reply answers READ_ONLY and leaves the store read-only; a TypeError does not', (t) => {
  const dir = tmpDir(t);
  const { store } = storeIn(t, dir);
  const pin = store.add({ text: 'first', anchor: ANCHOR });
  assert.equal(store.readOnly, false);
  // A pin that cannot be mapped (code UNMAPPED, not the filesystem's) leaves
  // the log writable.
  assert.throws(() => store.edit({ id: '', text: 'x' }, { text: 'y' }), (e) => e.code === 'UNMAPPED');
  assert.equal(store.readOnly, false, 'a bad pin does not make the log read-only');
  // The filesystem refuses the next write.
  const orig = fs.writeSync;
  fs.writeSync = () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); };
  try {
    assert.throws(() => store.reply(pin, { text: 'r' }), (e) => e.code === 'READ_ONLY' && e.reason === 'log-unwritable');
  } finally { fs.writeSync = orig; }
  assert.equal(store.readOnly, true);
  assert.equal(store.stats().read_only_reason, 'log-unwritable');
  assert.throws(() => store.add({ text: 'later' }), (e) => e.code === 'READ_ONLY');
});
