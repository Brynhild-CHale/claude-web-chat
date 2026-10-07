// GET /api/code/preview (lib/server/routes/code.js, spec §15.3, §5.3's row at
// level read, §5.5, §5.7 P0), on a bare Express app with a fake ctx:
//   * the query: exactly one of turn and node, point before or after (400
//     otherwise; an empty, repeated or bracketed value too); a value over
//     ID_MAX characters is 404; the parsed query reaches revert.preview;
//   * the gate: requireMirror('read') — the real audience refuses a remote
//     viewer with no opt-in (basic) with the mirror hint, a local one passes;
//   * the body through the redactor: a fake secret in a file name is masked,
//     the project root shown as <project>;
//   * the answers: 503 {unavailable, reason} (diffs-off; no control domain; no
//     revert installed), 404 no-record and unknown, 410 tree-missing, 429;
//   * the rate shape through the REAL revert (installRevert over a fake restore
//     engine): the same target within 1 s returns the same preview_id, another
//     target 429;
//   * mounting without an audience or a redactor throws.
// No acting route: restore and undo are control actions on the answer origin.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const { request } = require('../lib/client');
const { tmpRoot, withTempHome } = require('../test-support/helpers');
const { fakeSecrets } = require('../test-support/fake-secrets');
const { MIRROR_HINT } = require('../lib/core/remote-policy');
const { createRedactor } = require('../lib/core/redact');
const { createAudience } = require('../lib/server/audience');
const { createControl } = require('../lib/server/control');
const { installRevert, HINTS } = require('../lib/server/control/revert');
const { mountCodeRoutes } = require('../lib/server/routes/code');
const { ID_MAX } = require('../lib/server/routes/mirror-query');

const TREE_A = 'a'.repeat(40);
const TREE_B = 'b'.repeat(40);
const TREE_NOW = 'c'.repeat(40);

// A local-only audience: no opt-in, so a remote request is basic.
function realAudience(t) {
  const a = createAudience({ configFile: null });
  t.after(() => a.stop());
  return a;
}

async function host(t, { revert, control, audience, root = '/nowhere/project' } = {}) {
  const app = express();
  app.use(express.json());
  const ctx = {
    root,
    audience: audience || realAudience(t),
    redactor: createRedactor(),
    control: control !== undefined ? control : { use: (name) => (name === 'revert' ? revert || null : null) },
  };
  mountCodeRoutes(app, ctx);
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const { port } = srv.address();
  const get = (p, { remote = false } = {}) => request(port, 'GET', p, null, { headers: remote ? { 'X-WC-Remote': '1' } : {} });
  return { get, ctx };
}

// A revert whose preview answers whatever the test sets, recording each query.
function fakeRevert(answer = { ok: true }) {
  const r = { calls: [], answer, async preview(q) { r.calls.push(q); return typeof r.answer === 'function' ? r.answer(q) : r.answer; } };
  return r;
}

test('the query: exactly one of turn and node, point before or after, else 400; an over-long id 404', async (t) => {
  const revert = fakeRevert({ ok: true, preview_id: 'pv_x0000', written: [] });
  const h = await host(t, { revert });
  for (const [qs, want] of [
    ['turn=t1', { turn: 't1', point: 'before' }],
    ['turn=t1&point=after', { turn: 't1', point: 'after' }],
    ['node=n1.4', { node: 'n1.4', point: 'before' }],
    ['node=active&point=before', { node: 'active', point: 'before' }],
  ]) {
    const r = await h.get(`/api/code/preview?${qs}`);
    assert.equal(r.status, 200, qs);
    assert.deepEqual(revert.calls.at(-1), want, qs);
  }
  const n = revert.calls.length;
  for (const qs of ['', 'turn=t1&node=n1.4', 'turn=', 'node=', 'turn=t1&turn=t2', 'turn[a]=1', 'turn=t1&point=during', 'turn=t1&point=', 'point=before']) {
    const r = await h.get(`/api/code/preview?${qs}`);
    assert.equal(r.status, 400, qs);
    assert.equal(r.body.ok, false, qs);
    assert.equal(typeof r.body.error, 'string', qs);
  }
  assert.equal((await h.get(`/api/code/preview?turn=${'x'.repeat(ID_MAX + 1)}`)).status, 404);
  assert.equal(revert.calls.length, n, 'a refused query never reaches the revert');
});

test('the gate: requireMirror(read) refuses a remote viewer with no opt-in, and lets a local one through', async (t) => {
  const revert = fakeRevert({ ok: true, preview_id: 'pv_x0000' });
  const h = await host(t, { revert });
  const far = await h.get('/api/code/preview?turn=t1', { remote: true });
  assert.equal(far.status, 403);
  assert.deepEqual(far.body, { ok: false, mirror: 'basic', remote: true, hint: MIRROR_HINT });
  assert.equal(revert.calls.length, 0);
  assert.equal((await h.get('/api/code/preview?turn=t1')).status, 200);
});

test('the body passes the redactor: a secret in a file name is masked, the root is <project>', async (t) => {
  const root = '/Users/someone/work/the-project';
  const ghp = fakeSecrets({ seed: 3 }).find((f) => f.id === 'github-ghp');
  const leaky = `config/${ghp.secrets[0]}.env.txt`;
  const revert = fakeRevert({
    ok: true, preview_id: 'pv_x0000', target: { turn_id: 't1', node_id: null, label: 'n1.2', point: 'before', conversation_id: 'c1', at: 1 },
    written: [{ path: leaky, status: 'M' }], deleted: [], notCovered: [{ path: 'linked', reason: 'outside' }], headMoved: false,
    counts: { rewritten: 1, recreated: 0, deleted: 0, not_covered: 1 }, blocked: { reason: 'nested-busy', hint: `a session in ${root}/pkg is not idle` }, notes: [],
  });
  const h = await host(t, { revert, root });
  const r = await h.get('/api/code/preview?turn=t1');
  assert.equal(r.status, 200);
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes(ghp.secrets[0]), 'the secret is masked');
  assert.ok(!text.includes(root), 'the root is never shown');
  assert.match(r.body.blocked.hint, /<project>\/pkg/);
  assert.equal(r.body.preview_id, 'pv_x0000');
  assert.deepEqual(r.body.counts, { rewritten: 1, recreated: 0, deleted: 0, not_covered: 1 });
});

test('the answers: 503 unavailable with the reason, 404 no-record and unknown, 410 tree-missing, 429, 409 otherwise', async (t) => {
  const revert = fakeRevert();
  const h = await host(t, { revert });
  for (const [answer, status, body] of [
    [{ ok: false, unavailable: true, reason: 'diffs-off' }, 503, { ok: false, unavailable: true, reason: 'diffs-off' }],
    [{ ok: false, unavailable: true, reason: 'git-too-old' }, 503, { ok: false, unavailable: true, reason: 'git-too-old' }],
    [{ ok: false, refused: 'no-record', hint: HINTS['no-record'] }, 404, { ok: false, refused: 'no-record', hint: HINTS['no-record'] }],
    [{ ok: false, refused: 'unknown', hint: HINTS.unknown }, 404, { ok: false, refused: 'unknown', hint: HINTS.unknown }],
    [{ ok: false, refused: 'tree-missing', hint: HINTS['tree-missing'] }, 410, { ok: false, refused: 'tree-missing', hint: 'the snapshot was pruned (trees are kept 7 days)' }],
    [{ ok: false, refused: 'rate_limited', hint: HINTS.rate_limited }, 429, { ok: false, refused: 'rate_limited', hint: HINTS.rate_limited }],
    [{ ok: false, refused: 'snapshot-failed', hint: 'x' }, 409, { ok: false, refused: 'snapshot-failed', hint: 'x' }],
  ]) {
    revert.answer = answer;
    const r = await h.get('/api/code/preview?turn=t1');
    assert.equal(r.status, status, JSON.stringify(answer));
    assert.deepEqual(r.body, body);
  }
  revert.answer = () => { throw new Error(`/secret/path/${'x'}`); };
  const boom = await h.get('/api/code/preview?turn=t1');
  assert.equal(boom.status, 500);
  assert.ok(!JSON.stringify(boom.body).includes('/secret/path'), 'never the error\'s message');

  const none = await host(t, { control: null });
  assert.deepEqual((await none.get('/api/code/preview?turn=t1')).body, { ok: false, unavailable: true, reason: 'no-control' });
  const bare = await host(t, { revert: null });
  const nr = await bare.get('/api/code/preview?turn=t1');
  assert.deepEqual([nr.status, nr.body], [503, { ok: false, unavailable: true, reason: 'not-installed' }]);
});

test('the rate shape through the real revert: the same target within 1 s is the same preview_id; another target 429', async (t) => {
  withTempHome(t);
  const root = tmpRoot('wc-code-routes-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = 1_760_000_000_000;
  const now = () => clock;
  const restore = {
    features: async () => ({ ok: true }),
    preview: async () => ({ ok: true, current_tree: TREE_NOW, written: [{ path: 'a.txt', status: 'M' }], deleted: [], notCovered: [], headMoved: false }),
    apply: async () => ({ ok: false, refused: 'stale' }),
    undo: async () => ({ ok: false, refused: 'unknown' }),
  };
  const rec = (id) => ({ v: 1, turn_id: id, conversation_id: 'c1', status: 'ready', before: { tree: TREE_A, at: 1, head: null }, after: { tree: TREE_B, at: 2, head: null } });
  const mirror = {
    async diff(q) { return q.turn === 't1' || q.turn === 't2' ? rec(q.turn) : null; },
    async turn() { return null; },
    snapshot: () => ({ conversations: [] }),
  };
  const control = createControl({ root, mirror, now });
  const revert = installRevert(control, { restore, mirror, root, now, findClaude: () => null });
  t.after(async () => { await revert.stop(); await control.stop(); });
  const h = await host(t, { control, root });

  const a = await h.get('/api/code/preview?turn=t1');
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.match(a.body.preview_id, /^pv_/);
  assert.deepEqual(a.body.notes, ['claude was not found, so sessions in subdirectories were not checked']);
  clock += 400;
  const b = await h.get('/api/code/preview?turn=t1');
  assert.equal(b.body.preview_id, a.body.preview_id, 'the same target within 1 s');
  const c = await h.get('/api/code/preview?turn=t2');
  assert.deepEqual([c.status, c.body.refused], [429, 'rate_limited']);
  clock += 1001;
  const d = await h.get('/api/code/preview?turn=t2');
  assert.equal(d.status, 200);
  assert.notEqual(d.body.preview_id, a.body.preview_id);
  clock += 1001;
  assert.equal((await h.get('/api/code/preview?turn=t9')).status, 404, 'no record');
});

test('mounting without an audience gate or a redactor throws rather than serve the lists ungated or unredacted', () => {
  const app = express();
  assert.throws(() => mountCodeRoutes(app, {}), /ctx\.audience/);
  assert.throws(() => mountCodeRoutes(app, undefined), /ctx\.audience/);
  assert.throws(() => mountCodeRoutes(app, { audience: { requireMirror: () => (req, res, next) => next() } }), /ctx\.redactor/);
});

test('the module is a read: it mounts one GET and no acting route', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'routes', 'code.js'), 'utf8');
  const routes = [...src.matchAll(/\bapp\.(get|post|put|patch|delete|all|use)\(\s*(['"`])([^'"`]*)\2/g)].map((m) => `${m[1]} ${m[3]}`);
  assert.deepEqual(routes, ['get /api/code/preview']);
});
