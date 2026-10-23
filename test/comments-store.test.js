// The comment routes through the element store (U208; PLAN 1A.2, 1A.5, 1A.8):
// every add, edit and reply appends a version through the log's one redacted
// writer and the route serves the pin the store answers; ids and seqs are
// minted by the log alone (state.commentSeq is gone); GET's next_cursor is the
// log's max seq and never decreases; a value the redactor learns later is
// masked on GET. The S-14 golden (test/fixtures/s14-today.json, recorded at
// f3c4a7f by design/annotation-engine-redesign/tests/F6/s14.js) replays
// through the REAL get_comments and reply_comment handlers with 0 fields
// removed.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { withServer, existingProject, waitUntil, commentBody } = require('../test-support/helpers');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { v3Graph } = require('../test-support/v3-graph');
const { copyMatches } = require('../lib/core/element-log');
const { projectPaths } = require('../lib/core/paths');

const REPO = path.join(__dirname, '..');
const ANCHOR = { mount: 'm1', selector: 'p.lead', text: 'Hello', ordinal: 0 };
const SECRET = fakeSecrets({ seed: 7 }).find((f) => f.id === 'github-ghp');

const logFile = (root) => projectPaths(root).elementsLog;
const logBytes = (root) => { try { return fs.readFileSync(logFile(root), 'utf8'); } catch { return ''; } };
const nodeOf = (root, id) => JSON.parse(fs.readFileSync(path.join(projectPaths(root).graphDir, `${id}.json`), 'utf8'));
const idNum = (id) => Number(String(id).slice(1));

async function ok(p, what) {
  const r = await p;
  assert.equal(r.status, 200, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
async function turn(api, message = 'turn') {
  await ok(api.post('/api/turn-begin', { message }), 'turn-begin');
  return ok(api.post('/api/turn-end', { summary: message }), 'turn-end');
}
const cursor = async (api) => (await ok(api.get('/api/elements?type=comment'), 'GET')).next_cursor;
const addPin = async (api, text, extra = {}) => (await ok(api.post('/api/elements', commentBody({ text, anchor: ANCHOR, ...extra })), `add ${text}`)).pin;

// ── the S-14 golden replay ──────────────────────────────────────────────────

// s14.js :27-35: keys sorted, created_at / at replaced.
function norm(v) {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = (k === 'created_at' || k === 'at') ? '<t>' : norm(v[k]);
    return o;
  }
  return v;
}
function shape(v) {
  const out = new Set();
  const walk = (x, p) => {
    if (Array.isArray(x)) { x.forEach((y) => walk(y, p + '[]')); return; }
    if (x && typeof x === 'object') for (const k of Object.keys(x)) { out.add(p + '.' + k); walk(x[k], p + '.' + k); }
  };
  walk(v, '');
  return out;
}
// Every value the golden holds, compared at the golden's own paths (a field
// the engine added beside them — v, writer, provenance, edited — is not a
// difference); next_cursor is compared by the cursor rule instead.
function diffs(g, x, p, out) {
  if (Array.isArray(g)) {
    if (!Array.isArray(x) || x.length !== g.length) { out.push(`${p}: length ${Array.isArray(x) ? x.length : typeof x} != ${g.length}`); return out; }
    g.forEach((y, i) => diffs(y, x[i], `${p}[${i}]`, out));
    return out;
  }
  if (g && typeof g === 'object') {
    if (!x || typeof x !== 'object') { out.push(`${p}: ${JSON.stringify(x)} is not an object`); return out; }
    for (const k of Object.keys(g)) if (k !== 'next_cursor') diffs(g[k], x[k], `${p}.${k}`, out);
    return out;
  }
  if (g !== x) out.push(`${p}: ${JSON.stringify(x)} != golden ${JSON.stringify(g)}`);
  return out;
}

test('S-14: the golden replays through the real get_comments and reply_comment with 0 fields removed, equal values, and a cursor that never decreases', async (t) => {
  // lib/mcp/client swapped in the require cache for a stub that calls this
  // test's daemon through withServer's api (which carries the boot's writer
  // token, so Claude's reply verifies), as s14.js swaps it — the handlers'
  // own code runs and nothing can auto-spawn a daemon.
  let API = null;
  const call = async (r) => {
    const res = await r;
    if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body: res.json });
    return res.json;
  };
  const mcpClientPath = require.resolve('../lib/mcp/client.js');
  const toolPaths = ['../lib/mcp/tools/get_comments.js', '../lib/mcp/tools/reply_comment.js'].map((p) => require.resolve(p));
  const saved = require.cache[mcpClientPath];
  require.cache[mcpClientPath] = {
    id: mcpClientPath, filename: mcpClientPath, loaded: true,
    exports: { get: (p) => call(API.get(p)), post: (p, body) => call(API.post(p, body)) },
  };
  for (const p of toolPaths) delete require.cache[p];
  t.after(() => {
    if (saved) require.cache[mcpClientPath] = saved; else delete require.cache[mcpClientPath];
    for (const p of toolPaths) delete require.cache[p];
  });
  const getComments = require('../lib/mcp/tools/get_comments.js');
  const replyComment = require('../lib/mcp/tools/reply_comment.js');

  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 's14-today.json'), 'utf8'));
  const steps = [];
  let s = await withServer(t);
  API = s.api;
  const record = async (step) => { steps.push({ step, get_comments: norm(await getComments.handler({})) }); };

  // s14.js :54-78, step for step.
  await ok(s.api.post('/api/render', { id: 'f6-s14', html: '<h3 id="t">Timeline</h3><p id="b">Body</p>' }), 'render');
  await turn(s.api, 'base');
  const add = (await ok(s.api.post('/api/elements', commentBody({ text: 'is this right?', anchor: { mount: 'f6-s14', selector: '#t', text: 'Timeline', ordinal: 0 } })), 'add')).pin;
  await record('add');
  await ok(s.api.post(`/api/elements/${add.id}/reply`, { text: 'one more thing', author: 'user' }), 'reply'); await record('reply-user');
  const rc = await replyComment.handler({ id: add.id, text: 'answered' });
  steps.push({ step: 'reply_comment', reply_comment: norm(rc) }); await record('reply-claude');
  await ok(s.api.patch(`/api/elements/${add.id}`, { shared: false }), 'private'); await record('toggle-private');
  await ok(s.api.patch(`/api/elements/${add.id}`, { shared: true }), 'shared'); await record('toggle-shared');
  await ok(s.api.patch(`/api/elements/${add.id}`, { text: 'is this right? (edited)' }), 'edit'); await record('edit');
  const A = (await turn(s.api, 'A')).node_id;
  const c2 = (await ok(s.api.post('/api/elements', commentBody({ text: 'second', anchor: { mount: 'f6-s14', selector: '#b', text: 'Body' } })), 'add 2')).pin;
  await record('add-second');
  await ok(s.api.post('/api/render', { id: 'f6-s14b', html: '<p>more</p>' }), 'render b');
  const B = (await turn(s.api, 'B')).node_id;
  await ok(s.api.del(`/api/elements/${c2.id}`), 'delete'); await record('delete');
  await ok(s.api.post('/api/graph/active', { id: A }), 'set active A'); await record('set-active-older');
  await ok(s.api.post(`/api/elements/${add.id}/reply`, { text: 'on the older node', author: 'user' }), 'reply older'); await record('reply-on-older');
  await ok(s.api.post('/api/graph/active', { id: B }), 'set active B'); await record('set-active-back');
  await ok(s.api.post(`/api/elements/${add.id}/reply`, { text: 'uncommitted', author: 'user' }), 'reply uncommitted'); await record('reply-uncommitted');
  await s.graceful(); await s.stop();
  s = await withServer(t, { root: s.root });
  API = s.api;
  await record('restart-from-draft');

  assert.equal(steps.length, golden.length, 'the 14 steps');
  assert.deepEqual(steps.map((x) => x.step), golden.map((g) => g.step));
  const removed = [...shape(golden)].filter((p) => !shape(steps).has(p));
  assert.deepEqual(removed, [], '0 field paths removed');
  const changed = diffs(golden, steps, '', []);
  assert.deepEqual(changed, [], 'every golden value equal (next_cursor aside)');
  let last = 0;
  for (let i = 0; i < steps.length; i++) {
    const g = golden[i].get_comments;
    if (!g) continue;
    const now = steps[i].get_comments.next_cursor;
    assert.ok(now >= g.next_cursor, `${steps[i].step}: next_cursor ${now} >= the golden's ${g.next_cursor}`);
    assert.ok(now >= last, `${steps[i].step}: next_cursor ${now} never decreases (was ${last})`);
    last = now;
  }
});

// ── the cursor ──────────────────────────────────────────────────────────────

test('the cursor is the log\'s max seq: delete, Set active, Wipe, New graph and both restarts keep it; each edit and reply raises it by one', async (t) => {
  let s = await withServer(t);
  await ok(s.api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello</p>' }), 'render');
  const base = (await turn(s.api, 'base')).node_id;
  const pins = [];
  for (const text of ['a', 'b', 'c']) pins.push(await addPin(s.api, text));
  assert.equal(await cursor(s.api), 3, 'three adds give 3');
  const n1 = (await turn(s.api, 'pins')).node_id;
  await ok(s.api.del(`/api/elements/${pins[2].id}`), 'delete');
  assert.equal(await cursor(s.api), 3, 'deleting the newest keeps 3');
  await ok(s.api.post('/api/graph/active', { id: base }), 'set active base');
  assert.equal(await cursor(s.api), 3, 'Set active to an older node keeps it');
  await ok(s.api.post('/api/graph/active', { id: n1 }), 'set active back');
  assert.equal(await cursor(s.api), 3, 'and back keeps it');
  await ok(s.api.post('/api/graph/wipe', {}), 'wipe');
  assert.equal(await cursor(s.api), 3, 'a Wipe keeps it');
  await ok(s.api.post('/api/graph/new', {}), 'new graph');
  assert.equal(await cursor(s.api), 3, 'a New graph keeps it');
  await s.graceful(); await s.stop();
  s = await withServer(t, { root: s.root });
  assert.equal(await cursor(s.api), 3, 'a graceful restart keeps it');
  await s.stop();
  s = await withServer(t, { root: s.root });
  assert.equal(await cursor(s.api), 3, 'a hard-stop restart keeps it');

  const p = await addPin(s.api, 'd');
  assert.equal(await cursor(s.api), 4);
  assert.equal(p.seq, 4);
  const ed = await ok(s.api.patch(`/api/elements/${p.id}`, { text: 'd2' }), 'edit');
  assert.equal(ed.pin.seq, 5);
  assert.equal(await cursor(s.api), 5, 'an edit raises it by one');
  await ok(s.api.patch(`/api/elements/${p.id}`, { text: 'd2' }), 'no-op edit');
  assert.equal(await cursor(s.api), 5, 'a no-op edit does not');
  const rp = await ok(s.api.post(`/api/elements/${p.id}/reply`, { text: 'r', author: 'user' }), 'reply');
  assert.equal(rp.pin.seq, 6);
  assert.equal(await cursor(s.api), 6, 'a reply raises it by one');
  // since=N stays exclusive over the live pins.
  const since = (await ok(s.api.get('/api/elements?type=comment&since=5'), 'since')).elements.map((c) => c.id);
  assert.deepEqual(since, [p.id]);
  assert.deepEqual((await ok(s.api.get('/api/elements?type=comment&since=6'), 'since 6')).elements, []);
});

test('one counter: a highlight write raises get_comments\' cursor too, and a highlight\'s delete never lowers it (U327a, the element API\'s 1A.8 rule)', async (t) => {
  const { api } = await withServer(t);
  await ok(api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello</p>' }), 'render');
  const p = await addPin(api, 'a');
  assert.equal(await cursor(api), p.seq);
  const RANGE = { v: 1, kind: 'range', mount: 'm1', quote: { exact: 'Hello', prefix: '', suffix: '' }, pos: { start: 0, end: 5 } };
  const h = (await ok(api.post('/api/elements', { type: 'highlight', anchor: RANGE, payload: { color: 'gold' } }), 'highlight')).element;
  assert.equal(h.seq, p.seq + 1, 'the highlight takes the next seq of the one counter');
  assert.equal(await cursor(api), h.seq, 'and raises the comment read\'s cursor');
  await ok(api.patch(`/api/elements/${h.id}`, { color: 'accent' }), 'highlight edit');
  assert.equal(await cursor(api), h.seq + 1, 'its edit raises it by one');
  await ok(api.del(`/api/elements/${h.id}`), 'highlight delete');
  assert.equal(await cursor(api), h.seq + 1, 'its delete never lowers it');
  const q = await addPin(api, 'b');
  assert.equal(q.seq, h.seq + 2, 'the next comment continues the one counter');
  assert.deepEqual((await ok(api.get(`/api/elements?type=comment&since=${p.seq}`), 'since')).elements.map((c) => c.id), [q.id]);
});

// ── ids never re-minted (tests/F6/ids.js's three cases) ─────────────────────

test('ids: a pin held only in a torn node, only in a set-aside draft, or lost to a hard stop is never minted again', async (t) => {
  // (a) a pin held only in a node file that is then torn.
  let s = await withServer(t);
  await ok(s.api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello</p>' }), 'render');
  await turn(s.api, 'base');
  const a1 = await addPin(s.api, 'one');
  const a2 = await addPin(s.api, 'two');
  const n = (await turn(s.api, 'holds both')).node_id;
  await ok(s.api.del(`/api/elements/${a2.id}`), 'delete');
  await s.stop();
  const nodePath = path.join(projectPaths(s.root).graphDir, `${n}.json`);
  fs.writeFileSync(nodePath, fs.readFileSync(nodePath, 'utf8').slice(0, 40));
  s = await withServer(t, { root: s.root });
  const aNext = await addPin(s.api, 'after the tear');
  assert.ok(idNum(aNext.id) > Math.max(idNum(a1.id), idNum(a2.id)), `${aNext.id} is above ${a1.id} and ${a2.id}`);

  // (b) a pin held only in a draft that is set aside.
  s = await withServer(t);
  await ok(s.api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello</p>' }), 'render');
  await turn(s.api, 'base');
  const b1 = await addPin(s.api, 'only in the draft');
  await s.graceful(); await s.stop();
  const draft = projectPaths(s.root).draft;
  assert.ok(fs.existsSync(draft), 'the graceful stop wrote the draft');
  fs.writeFileSync(draft, '{"torn');
  s = await withServer(t, { root: s.root });
  assert.deepEqual((await ok(s.api.get('/api/elements?type=comment'), 'GET')).elements, [], 'the draft was set aside');
  const bNext = await addPin(s.api, 'after the aside');
  assert.ok(idNum(bNext.id) > idNum(b1.id), `${bNext.id} is above ${b1.id}`);

  // (c) an uncommitted pin lost to a hard stop.
  s = await withServer(t);
  const c1 = await addPin(s.api, 'lost');
  await s.stop();
  s = await withServer(t, { root: s.root });
  assert.deepEqual((await ok(s.api.get('/api/elements?type=comment'), 'GET')).elements, [], 'the pin was lost');
  const cNext = await addPin(s.api, 'after the hard stop');
  assert.ok(idNum(cNext.id) > idNum(c1.id), `${cNext.id} is above ${c1.id}`);
});

test('the reservation: a seq only a hand-written (not active) node copy holds is never minted again', async (t) => {
  const node = (id, parent, comments) => ({
    id, parent_id: parent, created_at: 1000 + Number(id.slice(1)), author: 'claude',
    trigger: { kind: 'turn', message: '', summary: '' },
    mounts: [{ id: 'm1', html: '<p class="lead">Hello</p>' }], store: {}, comments, captures: [],
  });
  const { api } = await withServer(t, {
    seed: ({ webChatDir }) => {
      existingProject({ webChatDir }); // at SCHEMA_VERSION: no migration runs
      const g = path.join(webChatDir, 'graph');
      fs.mkdirSync(g, { recursive: true });
      fs.writeFileSync(path.join(g, 'n0.json'), JSON.stringify(node('n0', null, [])));
      fs.writeFileSync(path.join(g, 'n1.json'), JSON.stringify(node('n1', 'n0', [
        { id: 'c500', seq: 500, created_at: 900, shared: true, text: 'hand-made', anchor: ANCHOR },
      ])));
      fs.writeFileSync(path.join(g, '_meta.json'), JSON.stringify({ active: 'n0' }));
    },
  });
  const p = await addPin(api, 'new');
  assert.ok(p.seq >= 501, `seq ${p.seq} is above the copy's 500`);
  assert.notEqual(p.id, 'c500');
  assert.ok(idNum(p.id) >= 501);
  assert.ok(await cursor(api) >= 501);
});

// ── the one writer ──────────────────────────────────────────────────────────

test('the one writer: a fake secret posted as text, as an edit and as a reply comes back masked; the node copy holds it masked; the log bytes hold none', async (t) => {
  const { api, root } = await withServer(t);
  await ok(api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello</p>' }), 'render');
  await turn(api, 'base');
  const add = await addPin(api, `see ${SECRET.text}`);
  assert.deepEqual(findLeaks(JSON.stringify(add), [SECRET]), [], 'the add answers it masked');
  const other = await addPin(api, 'plain');
  const ed = await ok(api.patch(`/api/elements/${other.id}`, { text: `edited ${SECRET.text}` }), 'edit');
  assert.deepEqual(findLeaks(JSON.stringify(ed), [SECRET]), [], 'the edit answers it masked');
  assert.notEqual(ed.pin.text, `edited ${SECRET.text}`);
  const rp = await ok(api.post(`/api/elements/${other.id}/reply`, { text: `reply ${SECRET.text}`, author: 'user' }), 'reply');
  assert.deepEqual(findLeaks(JSON.stringify(rp), [SECRET]), [], 'the reply answers it masked');
  const all = await ok(api.get('/api/elements?type=comment'), 'GET');
  assert.equal(all.elements.length, 2);
  assert.deepEqual(findLeaks(JSON.stringify(all), [SECRET]), [], 'GET serves it masked');
  const n = (await turn(api, 'commit')).node_id;
  const copies = nodeOf(root, n).comments;
  assert.equal(copies.length, 2);
  assert.deepEqual(findLeaks(JSON.stringify(copies), [SECRET]), [], 'the committed copy holds the masked text');
  assert.ok(logBytes(root).length > 0);
  assert.deepEqual(findLeaks(logBytes(root), [SECRET]), [], 'the log bytes hold no fake value');
});

test('learned later: a value the redactor learns after the write (the capture token) is masked on GET while the log bytes are unchanged', async (t) => {
  const { api, root } = await withServer(t);
  const value = `wclearned${crypto.randomBytes(16).toString('hex')}`;
  const p = await addPin(api, `the token is ${value}`);
  const r = await ok(api.post(`/api/elements/${p.id}/reply`, { text: `again ${value}`, author: 'user' }), 'reply');
  assert.ok(r.pin.replies[0].text.includes(value), 'not known at the write: stored as typed');
  const before = logBytes(root);
  assert.ok(before.includes(value), 'the log holds it as written');
  fs.writeFileSync(projectPaths(root).captureToken, value + '\n');
  const masked = await waitUntil(async () => {
    const body = (await api.get('/api/elements?type=comment')).json;
    return JSON.stringify(body).includes(value) ? null : body;
  }, { timeout: 6000, what: 'GET /api/elements masks the learned value' });
  assert.equal(masked.elements.length, 1);
  assert.ok(!masked.elements[0].text.includes(value));
  assert.ok(!masked.elements[0].replies[0].text.includes(value));
  assert.equal(logBytes(root), before, 'the log bytes are unchanged');
});

// ── v on every live pin and committed copy ──────────────────────────────────

test('every live pin and every committed copy carries a v whose log version passes copyMatches', async (t) => {
  const { api, srv, root } = await withServer(t);
  await ok(api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello</p>' }), 'render');
  await turn(api, 'base');
  const a = await addPin(api, 'a');
  const b = await addPin(api, 'b', { shared: false });
  const n1 = (await turn(api, 'one')).node_id;
  await ok(api.patch(`/api/elements/${a.id}`, { text: 'a2' }), 'edit');
  await ok(api.post(`/api/elements/${b.id}/reply`, { text: 'mine', author: 'user' }), 'reply');
  await ok(api.patch(`/api/elements/${b.id}`, { shared: true }), 'share');
  const n2 = (await turn(api, 'two')).node_id;
  await addPin(api, 'uncommitted');
  const checkPin = (c, where) => {
    assert.ok(Number.isInteger(c.v), `${where} ${c.id} carries a v`);
    assert.ok(copyMatches(c, srv.elements.version(c.id, c.v)), `${where} ${c.id}@${c.v} matches its version`);
  };
  for (const c of srv.state.comments) checkPin(c, 'live');
  assert.equal(srv.state.comments.length, 3);
  for (const id of [n1, n2]) for (const c of nodeOf(root, id).comments) checkPin(c, id);
  for (const c of (await ok(api.get('/api/elements?type=comment'), 'GET')).elements) checkPin(c, 'GET');
});

// ── unchanged gates ─────────────────────────────────────────────────────────

test('unchanged: Claude\'s reply into a private pin 404s, an empty reply 400s, a private pin\'s event copy carries no text', async (t) => {
  const { api } = await withServer(t);
  const priv = await addPin(api, 'PRIVATE-NOTE-TEXT', { shared: false });
  const before = (await ok(api.get('/api/elements?type=comment'), 'GET')).next_cursor;
  const claude = await api.post(`/api/elements/${priv.id}/reply`, { text: 'hi', author: 'claude' });
  assert.equal(claude.status, 404);
  assert.deepEqual(claude.json, { error: 'not found', id: priv.id });
  assert.equal((await api.post(`/api/elements/${priv.id}/reply`, { text: '   ' })).status, 400);
  assert.equal((await api.post('/api/elements/nope/reply', { text: 'x' })).status, 404);
  assert.equal((await api.patch('/api/elements/nope', { text: 'x' })).status, 404);
  assert.equal((await ok(api.get('/api/elements?type=comment'), 'GET')).next_cursor, before, 'a refused write mints nothing');
  await ok(api.post(`/api/elements/${priv.id}/reply`, { text: 'PRIVATE-REPLY-TEXT', author: 'user' }), 'user reply');
  await ok(api.patch(`/api/elements/${priv.id}`, { text: 'PRIVATE-EDIT-TEXT' }), 'edit');
  const evs = (await ok(api.get('/api/events'), 'events')).events.filter((e) => e.kind === 'comment');
  assert.deepEqual(evs.map((e) => e.op), ['add', 'reply', 'edit']);
  assert.ok(!JSON.stringify(evs).includes('PRIVATE-'), 'no private text in the ring');
  for (const e of evs) { assert.equal(e.pin.id, priv.id); assert.equal(e.pin.shared, false); }
});

test('the stamps ride the store\'s pin: writer and provenance on the pin, `edited` on an edit, writer/provenance on each reply (ruling A2)', async (t) => {
  const { api, anonApi } = await withServer(t);
  const add = await addPin(api, 'by claude');
  assert.deepEqual(add.writer, { class: 'claude', owner: 'claude', verified: true });
  assert.equal(add.provenance.origin, 'local');
  assert.equal(add.edited, undefined);
  const ed = await ok(anonApi.patch(`/api/elements/${add.id}`, { text: 'by the user', device: 'mobile' }), 'edit');
  assert.deepEqual(ed.pin.writer, add.writer, 'the creator stays');
  assert.equal(ed.pin.edited.writer.class, 'user');
  assert.equal(ed.pin.edited.provenance.device, 'mobile');
  assert.ok(Number.isFinite(ed.pin.edited.at));
  const r1 = await ok(api.post(`/api/elements/${add.id}/reply`, { text: 'claude here', author: 'claude' }), 'claude reply');
  const r2 = await ok(anonApi.post(`/api/elements/${add.id}/reply`, { text: 'user here', device: 'desktop' }), 'user reply');
  assert.equal(r1.pin.replies[0].writer.class, 'claude');
  assert.equal(r2.pin.replies[0].writer.class, 'claude', 'an earlier reply keeps its own writer');
  assert.equal(r2.pin.replies[1].writer.class, 'user');
  assert.equal(r2.pin.replies[1].provenance.device, 'desktop');
  assert.equal(r2.pin.edited.writer.class, 'user', 'a reply never becomes the editor');
  const got = (await ok(api.get('/api/elements?type=comment'), 'GET')).elements[0];
  assert.deepEqual(got.writer, add.writer);
  assert.deepEqual(got.edited, r2.pin.edited);
  assert.deepEqual(got.replies.map((r) => r.writer.class), ['claude', 'user']);
});

test('read-only: on a project whose comment migration was refused, add, edit and reply answer 503 with the hint; GET and DELETE answer', async (t) => {
  const { api, srv } = await withServer(t, { seed: ({ root }) => { v3Graph(root, { unmappable: true }); } });
  assert.equal(srv.elements.readOnly, true);
  const got = await api.get('/api/elements?type=comment');
  assert.equal(got.status, 200);
  const pins = got.json.elements;
  assert.ok(pins.length >= 1, 'the restored node\'s pins are served');
  const before = got.json.next_cursor;
  const want = { error: 'elements are read-only until the comment migration runs', hint: 'run claude-web-chat migrate for the report' };
  const post = await api.post('/api/elements', commentBody({ text: 'x', anchor: ANCHOR }));
  assert.equal(post.status, 503); assert.deepEqual(post.json, want);
  const patch = await api.patch(`/api/elements/${pins[0].id}`, { text: 'changed' });
  assert.equal(patch.status, 503); assert.deepEqual(patch.json, want);
  const reply = await api.post(`/api/elements/${pins[0].id}/reply`, { text: 'hello', author: 'user' });
  assert.equal(reply.status, 503); assert.deepEqual(reply.json, want);
  const after = (await ok(api.get('/api/elements?type=comment'), 'GET again'));
  assert.deepEqual(after.elements.map((c) => [c.id, c.seq, c.text]), pins.map((c) => [c.id, c.seq, c.text]), 'nothing changed');
  assert.equal(after.next_cursor, before);
  const del = await api.del(`/api/elements/${pins[pins.length - 1].id}`);
  assert.equal(del.status, 200, `DELETE still works: ${del.text}`);
});

test('an anchor with no mount is refused (400): the element log cannot convert one', async (t) => {
  const { api } = await withServer(t);
  const r = await api.post('/api/elements', commentBody({ text: 'x', anchor: { selector: 'div', text: 'x' } }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'anchor without a mount');
  assert.deepEqual((await ok(api.get('/api/elements?type=comment'), 'GET')).elements, []);
  assert.equal((await addPin(api, 'page note', { anchor: null })).anchor, null, 'a page note (null anchor) is fine');
});

// ── state.commentSeq is gone ────────────────────────────────────────────────

test('state.commentSeq is gone: lib/server/state.js has no commentSeq and nothing under lib/ reads or writes it', () => {
  assert.ok(!/commentSeq/.test(fs.readFileSync(path.join(REPO, 'lib/server/state.js'), 'utf8')));
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && /commentSeq/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO, p));
    }
  };
  walk(path.join(REPO, 'lib'));
  assert.deepEqual(hits, []);
  const { createState } = require('../lib/server/state');
  assert.equal('commentSeq' in createState(), false);
});
