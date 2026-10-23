// The commit ordering (PLAN 1A.3, U203; GT-10's crash points): node first, log
// after, meta last — and the pending bookmark and folded turns consumed only
// once the node is on disk. Also the boot order (the redactor and the element
// store exist before graph.load), last_node, and createServer's `elements`.
//
// Each step is reached through its object (graph.writeNode,
// graph.elements.appendCommit, graph.saveMeta), so these tests wrap them on
// ctx.srv.graph exactly as the gate's g5-style injection does.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// createGraph is wrapped BEFORE lib/server/index.js is first required (it
// destructures createGraph at load; test-support/helpers requires it lazily):
// the spy records, at graph.load, what the boot had built by then.
const graphMod = require('../lib/server/graph');
const loads = [];
const origCreateGraph = graphMod.createGraph;
graphMod.createGraph = function spyCreateGraph(opts) {
  const g = origCreateGraph(opts);
  const load = g.load;
  g.load = (...a) => {
    loads.push({ redactText: typeof g.redactText, elements: !!g.elements, masks: g.redactText ? g.redactText('x') : null });
    return load(...a);
  };
  return g;
};

const { withServer, commentBody } = require('../test-support/helpers');
const { projectPaths } = require('../lib/core/paths');

function metaOf(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.web-chat', 'graph', '_meta.json'), 'utf8'));
}
function records(root) {
  let text = '';
  try { text = fs.readFileSync(projectPaths(root).elementsLog, 'utf8'); } catch {}
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const commitsIn = (root) => records(root).filter((r) => r.t === 'commit');

async function turn(api, message, work) {
  await api.post('/api/turn-begin', { message });
  if (work) await work();
  return api.post('/api/turn-end', { author: 'claude' });
}
const render = (api, id) => api.post('/api/render', { id, html: `<p>${id}</p>` });

// Wrap a method on its object with a recorder; `inject(name)` may throw.
function wrap(obj, name, calls, inject) {
  const orig = obj[name];
  obj[name] = function wrapped(...a) {
    calls.push(name);
    if (inject) inject(name);
    return orig.apply(this, a);
  };
  return () => { obj[name] = orig; };
}

test('node first, log after: a turn-end commit calls writeNode, then appendCommit, then saveMeta', async (t) => {
  const { api, srv, root } = await withServer(t);
  await api.post('/api/turn-begin', { message: 'work' });
  await render(api, 'm1');
  await api.post('/api/elements', commentBody({ text: 'pin', anchor: { mount: 'm1', selector: 'p', text: 'm1', ordinal: 0 } }));
  const calls = [];
  wrap(srv.graph, 'writeNode', calls);
  wrap(srv.graph.elements, 'appendCommit', calls);
  wrap(srv.graph, 'saveMeta', calls);
  const end = await api.post('/api/turn-end', { author: 'claude' });
  assert.ok(end.json.node_id);
  assert.deepEqual(calls, ['writeNode', 'appendCommit', 'saveMeta']);
  const [rec] = commitsIn(root);
  assert.equal(rec.node, end.json.node_id, 'the record names the node');
  assert.equal(rec.pins.length, 1);
  assert.equal(metaOf(root).last_node, end.json.node_id);
});

test('a throwing writeNode fails turn-end and loses nothing pending; the next commit carries the bookmark and the folded turns once', async (t) => {
  const { api, srv, root } = await withServer(t);
  const first = await turn(api, 'first', () => render(api, 'm1'));
  assert.ok(first.json.node_id);
  const chat = await turn(api, 'just chat');
  assert.equal(chat.json.skipped, 'no-change');
  await api.post('/api/graph/wipe', { name: 'fresh' });
  assert.ok(srv.graph.pendingBookmark);
  assert.equal(srv.graph.pendingFolded.length, 1);
  const commitsBefore = commitsIn(root).length;

  await api.post('/api/turn-begin', { message: 'doomed' });
  await render(api, 'm2');
  let armed = true;
  const restore = wrap(srv.graph, 'writeNode', [], () => {
    if (armed) { armed = false; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
  });
  const failed = await api.post('/api/turn-end', { author: 'claude' });
  restore();
  assert.equal(failed.status, 500, 'the commit fails');
  assert.ok(srv.graph.pendingBookmark, 'the bookmark is still pending in memory');
  assert.equal(srv.graph.pendingFolded.length, 1, 'and so are the folded turns');
  const meta = metaOf(root);
  assert.ok(meta.pending_bookmark, '…and in _meta.json');
  assert.equal(meta.pending_folded.length, 1);
  assert.equal(srv.graph.active, first.json.node_id, 'active did not move');
  assert.equal(commitsIn(root).length, commitsBefore, 'no commit record was appended');

  const ok = await api.post('/api/turn-end', { author: 'claude' });
  assert.ok(ok.json.node_id, 'the retry commits');
  const node = (await api.get(`/api/graph/node/${ok.json.node_id}`)).json;
  assert.equal(node.bookmarked, true);
  assert.equal(node.wipe, true);
  assert.equal(node.folded_count, 1);
  assert.equal(srv.graph.pendingBookmark, null);
  assert.deepEqual(srv.graph.pendingFolded, []);

  const later = await turn(api, 'later', () => render(api, 'm3'));
  const n3 = (await api.get(`/api/graph/node/${later.json.node_id}`)).json;
  assert.ok(!n3.bookmarked, 'the bookmark landed exactly once');
  assert.ok(!n3.folded_count, 'the folded turns landed once');
});

test('a throwing appendCommit: the node is registered, active advances, _meta.json is saved, and the store counts one failed append', async (t) => {
  const { api, srv, root } = await withServer(t);
  const orig = srv.graph.elements.appendCommit;
  srv.graph.elements.appendCommit = () => { throw new Error('log unwritable'); };
  const end = await turn(api, 'work', () => render(api, 'm1'));
  srv.graph.elements.appendCommit = orig;
  assert.equal(end.status, 200);
  const id = end.json.node_id;
  assert.ok(srv.graph.nodes.has(id), 'registered');
  assert.equal(srv.graph.active, id, 'active advanced');
  assert.equal(metaOf(root).active, id, '_meta.json saved');
  assert.equal(metaOf(root).last_node, id);
  assert.equal(srv.elements.stats().append_failures, 1);
  assert.equal(commitsIn(root).length, 0, 'no record: the next boot adopts the node');
});

test('_meta.json carries last_node after each commit; an older _meta.json without it loads', async (t) => {
  const seedNode = {
    id: 'n0', parent_id: null, created_at: 1000, author: 'claude', trigger: { kind: 'turn', message: '', summary: '' },
    mounts: [{ id: 'm0', html: '<p>m0</p>' }], store: {}, comments: [], captures: [],
  };
  const { api, srv, root } = await withServer(t, {
    seed: ({ webChatDir }) => {
      const g = path.join(webChatDir, 'graph');
      fs.mkdirSync(g, { recursive: true });
      fs.writeFileSync(path.join(g, 'n0.json'), JSON.stringify(seedNode));
      fs.writeFileSync(path.join(g, '_meta.json'), JSON.stringify({ active: 'n0', lock: null }));
    },
  });
  assert.equal(srv.graph.active, 'n0');
  assert.equal(srv.graph.lastNode, null);
  const a = await turn(api, 'one', () => render(api, 'm1'));
  assert.equal(metaOf(root).last_node, a.json.node_id);
  const b = await turn(api, 'two', () => render(api, 'm2'));
  assert.equal(metaOf(root).last_node, b.json.node_id);
  // A re-aim moves active, not last_node.
  await api.post('/api/graph/active', { id: 'n0' });
  assert.equal(metaOf(root).last_node, b.json.node_id);
});

test('boot order: the redactor and graph.redactText exist before graph.load, and graph.elements is built', async (t) => {
  const before = loads.length;
  const { srv } = await withServer(t);
  assert.equal(loads.length, before + 1, 'the spy saw this boot');
  const seen = loads[loads.length - 1];
  assert.equal(seen.redactText, 'function');
  assert.equal(seen.masks, 'x');
  assert.equal(seen.elements, true, 'the store hangs on the graph before load');
  assert.equal(srv.elements, srv.graph.elements, 'createServer exposes the store');
  // The boot reconcile (U209; U203's stub asserted {stub: true} here).
  const report = srv.elements.integrity();
  assert.equal(report.clean, true, 'the reconcile ran and reported a clean boot');
  assert.deepEqual(report.states, {});
  assert.equal(report.stub, undefined);
});

test('graph.js defines no local isGraphNode; the graph.redactText assignment stays once in index.js', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.ok(!/function isGraphNode/.test(src('lib/server/graph.js')));
  assert.match(src('lib/server/graph.js'), /require\('\.\.\/core\/element-log'\)\.?|\{ isGraphNode \} = require\('\.\.\/core\/element-log'\)/);
  const idx = src('lib/server/index.js');
  assert.equal((idx.match(/graph\.redactText = /g) || []).length, 1);
  assert.ok(idx.indexOf('graph.redactText = ') < idx.indexOf('graph.load()'), 'set before the load');
});
