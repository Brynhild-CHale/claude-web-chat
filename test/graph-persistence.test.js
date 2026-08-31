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
//     and the rewrite is best-effort — boot does not depend on the heal.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withServer, tmpRoot } = require('../test-support/helpers');

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
