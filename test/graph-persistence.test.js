// Graph persistence honesty: never destroy what you could not read, and one
// field authority for the writer and the reader.
//
// test/graph-corrupt.test.js already pins that an unreadable record cannot wedge
// the daemon. This file pins the other half — what happens to the bytes we
// declined to read, and what a commit is entitled to write:
//
//   * a node file that fails the read is MOVED ASIDE, and its id stays claimed,
//     so the next commit can never land on top of it;
//   * a torn graph/_meta.json is moved aside before the recovery rewrites it,
//     and the rewrite is best-effort — boot does not depend on the heal;
//   * a committed mount carries exactly the fields hydrateMount reads back
//     (id + SNAPSHOT_FIELDS), so the live-only `gen` never reaches node bytes
//     (decision D18).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withServer, tmpRoot } = require('../test-support/helpers');
const { SNAPSHOT_FIELDS } = require('../lib/server/domain/turns');

let clock = 1000;
function node(id, parent_id, extra = {}) {
  return {
    id, parent_id, created_at: clock++, author: 'claude',
    trigger: { kind: 'turn', message: `turn ${id}`, summary: `turn ${id}` },
    mounts: [], store: {}, comments: [], captures: [], ...extra,
  };
}

function graphDir(webChatDir) {
  const dir = path.join(webChatDir, 'graph');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeNode(dir, n) {
  fs.writeFileSync(path.join(dir, `${n.id}.json`), JSON.stringify(n, null, 2));
}

function asideFor(dir, base) {
  return fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.corrupt-`));
}

test('graph: unreadable nodes and a torn meta are moved aside, and their ids stay claimed', async (t) => {
  const { api, webChatDir } = await withServer(t, {
    seed: ({ webChatDir }) => {
      const dir = graphDir(webChatDir);
      writeNode(dir, node('n0', null));
      writeNode(dir, node('n1', 'n0'));
      // Valid JSON, wrong shape — the case isGraphNode exists for.
      fs.writeFileSync(path.join(dir, 'n2.json'), 'null');
      // Truncated mid-write.
      fs.writeFileSync(path.join(dir, 'n3.json'), '{"id":"n3","created_at":10');
      fs.writeFileSync(path.join(dir, '_meta.json'), '{"active": "n1", "lock": nu');
    },
  });

  const dir = path.join(webChatDir, 'graph');

  const r = await api.get('/api/graph');
  assert.equal(r.status, 200, 'boot survives');
  assert.deepEqual(r.json.nodes.map((n) => n.id).sort(), ['n0', 'n1']);
  assert.equal(r.json.active, 'n1', 'the torn meta recovers to the latest node');

  // The bytes we could not read are kept, under a name the commit path will
  // never write.
  assert.equal(fs.existsSync(path.join(dir, 'n2.json')), false, 'n2.json no longer sits under a writable name');
  assert.equal(fs.existsSync(path.join(dir, 'n3.json')), false);
  assert.equal(asideFor(dir, 'n2.json').length, 1, 'n2.json was renamed aside, not deleted');
  assert.equal(asideFor(dir, 'n3.json').length, 1);
  assert.equal(asideFor(dir, '_meta.json').length, 1, 'the torn meta was kept too');
  assert.equal(
    fs.readFileSync(path.join(dir, asideFor(dir, '_meta.json')[0]), 'utf8'),
    '{"active": "n1", "lock": nu',
    'aside means the original bytes, untouched'
  );
  // …and the heal still landed a readable meta in its place.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '_meta.json'), 'utf8')).active, 'n1');

  // The ids of the skipped nodes are spent. Seeding nextSeq from the nodes that
  // LOADED used to leave it at 2, so these two commits wrote over both files.
  const c1 = await api.post('/api/commit', { message: 'one' });
  const c2 = await api.post('/api/commit', { message: 'two' });
  assert.equal(c1.json.node_id, 'n4', 'the next commit skips the ids of the unreadable files');
  assert.equal(c2.json.node_id, 'n5');
});

test('graph: an aside copy keeps its id claimed on every LATER boot too', async (t) => {
  // The rename removes `n2.json` from the directory, so a filename scan that
  // only matched live node files would hand n2 straight back on the next boot —
  // and any node still naming n2 as its parent would graft onto the new one.
  const root = tmpRoot();
  const dir = graphDir(path.join(root, '.web-chat'));
  writeNode(dir, node('n0', null));
  fs.writeFileSync(path.join(dir, 'n2.json'), '{}');

  const first = await withServer(t, { root });
  assert.equal((await first.api.get('/api/graph')).status, 200);
  assert.equal(asideFor(dir, 'n2.json').length, 1);
  await first.stop();

  // Second boot: n2.json is gone, only its aside copy remains.
  const second = await withServer(t, { root });
  const c = await second.api.post('/api/commit', { message: 'after the rename' });
  assert.equal(c.json.node_id, 'n3', 'the aside copy still speaks for n2');
});

test('graph: boot completes even when the meta heal cannot be written', (t) => {
  // graph.load is called unguarded by createServer, so a throw out of the
  // recovery's saveMeta is the daemon failing to boot for that project — for a
  // write that is only ever an optimisation for the NEXT boot. The recovered
  // active is already in memory.
  const { createGraph } = require('../lib/server/graph');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-graph-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const dir = graphDir(root);
  writeNode(dir, node('n0', null));
  writeNode(dir, node('n1', 'n0'));
  fs.writeFileSync(path.join(dir, '_meta.json'), 'not json at all');

  const state = { store: {}, mounts: new Map(), comments: [], captures: [], queue: [], commentSeq: 0, captureSeq: 0 };
  const graph = createGraph({ paths: { GRAPH_DIR: dir, META_PATH: path.join(dir, '_meta.json') }, state });
  graph.saveMeta = () => { throw new Error('EROFS: read-only file system'); };

  assert.doesNotThrow(() => graph.load());
  assert.equal(graph.active, 'n1', 'the recovery still ran; only its persistence failed');
  assert.equal(asideFor(dir, '_meta.json').length, 1, 'and the unreadable bytes were still kept');
});

// ── One field authority: writer == reader ──────────────────────────────────

test('graph: a committed mount carries exactly id + SNAPSHOT_FIELDS (no live-only gen)', async (t) => {
  const { createGraph } = require('../lib/server/graph');
  const turns = require('../lib/server/domain/turns');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-graph-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const dir = graphDir(root);

  // A live mount record as domain/mounts setMount builds one: every persisted
  // field set, plus the live-only re-render counter.
  const state = {
    store: { k: 1 }, comments: [], captures: [], queue: [], commentSeq: 0, captureSeq: 0,
    mounts: new Map([['m1', {
      html: '<p>x</p>', target: 'main', params: { routing: 'none' }, component: 'form-signoff',
      pane_state: { colSpan: 6 }, form_state: { '#a:0': { value: 'typed' } },
      theme: { tokens: {} }, owner: 'claude', gen: 3,
    }]]),
  };
  const graph = createGraph({ paths: { GRAPH_DIR: dir, META_PATH: path.join(dir, '_meta.json') }, state });
  graph.load();

  const bus = { emit() {} };
  const r = turns.commitNode(graph, bus, {
    draftPath: path.join(root, 'draft.json'), parentId: null, author: 'claude',
    triggerKind: 'turn', message: 'm', summary: 's',
    clearLock: false, op: 'commit', includeLabelAndUnlock: false,
  });

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, `${r.node_id}.json`), 'utf8'));
  assert.deepEqual(
    Object.keys(onDisk.mounts[0]),
    ['id', ...SNAPSHOT_FIELDS],
    'the node file holds exactly what hydrateMount will read back'
  );
  assert.equal('gen' in onDisk.mounts[0], false, 'D18: gen is live-only and never reaches node bytes');
  // The snapshot in memory agrees with the file (nothing is dropped only by
  // JSON.stringify happening to skip an undefined).
  assert.deepEqual(Object.keys(graph.snapshotLive().mounts[0]), ['id', ...SNAPSHOT_FIELDS]);
});

test('graph: a real render/turn-end round trip writes no gen into the node or the draft', async (t) => {
  const { api, webChatDir, graceful } = await withServer(t);

  await api.post('/api/render', { id: 'p1', html: '<p>one</p>' });
  await api.post('/api/render', { id: 'p1', html: '<p>two</p>' }); // bumps gen to 1
  await api.post('/api/turn-begin', { message: 'hi' });
  const end = await api.post('/api/turn-end', {});
  assert.equal(end.json.ok, true);

  const dir = path.join(webChatDir, 'graph');
  const nodeFile = fs.readdirSync(dir).find((f) => /^n\d+\.json$/.test(f));
  const committed = JSON.parse(fs.readFileSync(path.join(dir, nodeFile), 'utf8'));
  const allowed = new Set(['id', ...SNAPSHOT_FIELDS]);
  for (const k of Object.keys(committed.mounts[0])) {
    assert.ok(allowed.has(k), `committed mount key ${k} is not in id + SNAPSHOT_FIELDS`);
  }
  assert.equal(committed.mounts[0].html, '<p>two</p>');

  // The draft takes the same projection — its reader (loadDraft) is hydrateMount too.
  await api.post('/api/render', { id: 'p2', html: '<p>uncommitted</p>' });
  await graceful();
  const draft = JSON.parse(fs.readFileSync(path.join(webChatDir, 'draft.json'), 'utf8'));
  for (const m of draft.mounts) {
    for (const k of Object.keys(m)) assert.ok(allowed.has(k), `draft mount key ${k} is not in id + SNAPSHOT_FIELDS`);
  }
});

test('graph: a capture id is claimed by its sidecar file, not only by a node that loaded', async (t) => {
  // Same rule as nextSeq, one directory over: `capN.html` is written before the
  // record reaches a node, and the node carrying it can be one graph.load
  // declined to read. Seeding captureSeq only from the nodes that loaded handed
  // the id back and the next capture overwrote the raw page.
  const { api, webChatDir } = await withServer(t, {
    seed: ({ webChatDir }) => {
      const dir = path.join(webChatDir, 'captures');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'cap1.html'), '<p>an earlier capture</p>');
      fs.writeFileSync(path.join(dir, 'cap7.html'), '<p>a later one</p>');
      // The node that would have named it is unreadable, so nothing in memory
      // knows cap7 exists.
      fs.writeFileSync(path.join(graphDir(webChatDir), 'n0.json'), 'null');
    },
  });

  const r = await api.post('/api/capture', { url: 'https://x/doc', html: '<html><body><p>new</p></body></html>' });
  assert.equal(r.status, 200);
  assert.equal(r.json.capture_id, 'cap8', 'the counter starts past the highest sidecar on disk');
  assert.equal(
    fs.readFileSync(path.join(webChatDir, 'captures', 'cap1.html'), 'utf8'),
    '<p>an earlier capture</p>',
    'and the earlier captures are still on disk, untouched'
  );
});
