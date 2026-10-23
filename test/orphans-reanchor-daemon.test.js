// The re-anchor the chrome writes (annotation engine 2A.6; public/app/
// orphans.js), against the daemon's real element routes (U325): the browser's
// PATCH /api/elements/:id with {anchor, base_v, device} on a MIGRATED comment
// (a 0.8.5 pin the v3→v4 boot moved into the element log) appends exactly one
// anchor version to the log and rewrites no node: every node file's bytes
// (sha256) are the same before and after, the commit that follows included
// (it writes a NEW node file and touches none of the old). The node-scoped
// read answers the new version once a commit pins it (a version no commit
// pinned is visible from no node, lib/server/domain/element-scope.js): at the
// new node as its own version, and at the node it was re-anchored over as the
// newer version elsewhere.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { withServer } = require('../test-support/helpers');
const { v3Graph } = require('../test-support/v3-graph');
const { projectPaths } = require('../lib/core/paths');

// An engine record of the element kind, as the resolver's record() makes it
// in the browser (the element's own anchor kind: a converted pin's is element).
const RECORD = { v: 1, kind: 'element', mount: 'm-a', at: { path: [0, 1], sib: 0 },
  fp: { tag: 'p', id: '', cls: ['lead'], head: 'the labelled line', attrs: [], parent: 'div' }, rows: [] };

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function nodeHashes(paths) {
  const out = new Map();
  for (const f of fs.readdirSync(paths.graphDir).sort()) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    out.set(f, sha(path.join(paths.graphDir, f)));
  }
  return out;
}
const logLines = (paths) => fs.readFileSync(paths.elementsLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
async function ok(p, what) {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}

test('a re-anchor of a migrated comment: one anchor version in the log, 0 node-file bytes changed, the node-scoped read answers it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-orphans-reanchor-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  v3Graph(root);
  const paths = projectPaths(root);
  const { api, anonApi, srv } = await withServer(t, { root });

  // The boot migrated: c1 is a live pin whose versions are in the log.
  const live = await ok(anonApi.get('/api/elements?type=comment'), 'live read');
  const c1 = live.elements.find((e) => e.id === 'c1');
  assert.ok(c1 && Number.isInteger(c1.v), `c1 migrated and live: ${JSON.stringify(c1)}`);
  assert.ok(srv.elements.version('c1', c1.v), 'its version is in the log');
  const active = srv.graph.active;
  assert.ok(active, 'an active node');

  const nodesBefore = nodeHashes(paths);
  assert.ok(nodesBefore.size >= 6, 'the fixture\'s node files');
  const linesBefore = logLines(paths);

  // The chrome's write: the anchor alone, the version it holds, the device.
  const r = await ok(anonApi.patch('/api/elements/c1', { anchor: RECORD, base_v: c1.v, device: 'desktop' }), 're-anchor');
  assert.equal(r.ok, true);
  assert.equal(r.element.v, c1.v + 1, 'a new version');
  assert.deepEqual(r.element.record, RECORD, 'its anchor is the record sent');

  const linesAfter = logLines(paths);
  const added = linesAfter.slice(linesBefore.length);
  assert.deepEqual(linesAfter.slice(0, linesBefore.length), linesBefore, 'the log is appended to, never rewritten');
  // Exactly one version; beside it only the engine's own lazy boot epoch (the
  // log writes one before this boot's first append), never another record.
  const vers = added.filter((x) => x.t === 'ver');
  assert.equal(vers.length, 1, `exactly one version appended: ${JSON.stringify(added.map((x) => x.t))}`);
  assert.deepEqual(added.filter((x) => x.t !== 'ver').map((x) => x.t).filter((t) => t !== 'epoch'), [], 'nothing else');
  assert.ok(added.filter((x) => x.t === 'epoch').length <= 1);
  assert.equal(vers[0].id, 'c1');
  assert.equal(vers[0].v, c1.v + 1);
  assert.equal(vers[0].parent_v, c1.v);
  assert.deepEqual(srv.elements.version('c1', c1.v + 1).payload.anchor, RECORD, 'the version stores the record');
  const prev = srv.elements.version('c1', c1.v).payload;
  const next = srv.elements.version('c1', c1.v + 1).payload;
  assert.deepEqual([next.text, next.shared, next.replies], [prev.text, prev.shared, prev.replies], 'only the anchor moved');
  assert.deepEqual(nodeHashes(paths), nodesBefore, 'the re-anchor changed 0 node-file bytes');

  // A stale base version is refused and appends nothing.
  const stale = await anonApi.patch('/api/elements/c1', { anchor: { ...RECORD, mount: 'm-b' }, base_v: c1.v, device: 'desktop' });
  assert.equal(stale.status, 409);
  assert.ok(stale.json.hint, 'the refusal carries a hint for the card');
  assert.equal(logLines(paths).length, linesAfter.length, 'a refusal appends nothing');

  // The live read answers it now.
  const live2 = await ok(anonApi.get('/api/elements?type=comment'), 'live read after');
  const c1b = live2.elements.find((e) => e.id === 'c1');
  assert.equal(c1b.v, c1.v + 1);
  assert.deepEqual(c1b.record, RECORD);

  // The commit that follows pins it; the old node files stay byte-identical.
  await ok(api.post('/api/turn-begin', { message: 're-anchored' }), 'turn-begin');
  const end = await ok(api.post('/api/turn-end', { author: 'claude' }), 'turn-end');
  assert.ok(end.node_id, `the turn committed: ${JSON.stringify(end)}`);
  const nodesAfter = nodeHashes(paths);
  for (const [f, h] of nodesBefore) assert.equal(nodesAfter.get(f), h, `${f} untouched by the commit`);

  // The node-scoped read: the new node shows the new version as its own …
  const atNew = await ok(anonApi.get(`/api/elements?type=comment&node=${encodeURIComponent(end.node_id)}`), 'node read (new)');
  const n1 = atNew.elements.find((e) => e.id === 'c1');
  assert.ok(n1, 'c1 at the new node');
  assert.equal(n1.v, c1.v + 1);
  assert.equal(n1.node_v, c1.v + 1);
  assert.deepEqual(n1.record, RECORD);
  // … and the node it was re-anchored over names it as newer elsewhere.
  const atOld = await ok(anonApi.get(`/api/elements?type=comment&node=${encodeURIComponent(active)}`), 'node read (old)');
  const o1 = atOld.elements.find((e) => e.id === 'c1');
  assert.ok(o1, 'c1 at the old node');
  assert.ok(o1.v < c1.v + 1, 'the old node still shows its own version');
  assert.ok(o1.newer_elsewhere.some((x) => x.v === c1.v + 1 && x.home === end.node_id),
    `the re-anchor is newer elsewhere: ${JSON.stringify(o1.newer_elsewhere)}`);
});
