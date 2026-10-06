// Turn lifecycle repairs (spec §3.1-3.2, U30): the turn lock's session, the
// §3.2 turn-begin table, a second session's Stop, the late Stop, the extracted
// endTurn, how each turn ended, the ring fields, and redaction of the text the
// graph stores.
//
// Every route rule runs on a real daemon (withServer, spec §10.1): a HOST
// request goes through lib/client (no Origin, no Sec-Fetch-*: what the turn
// hooks send), a BROWSER's through Node's fetch (which sends sec-fetch-mode).
// The turn guard (U31) and graph.redactText (set by createServer in U40) do not
// exist yet in this tranche, so each test sets a fake on the LIVE objects: the
// server is booted from a fresh require of lib/server whose mountGraphRoutes is
// wrapped to hand back the ctx it was mounted with, and the handle it returns.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer, waitUntil, shortLockTtl } = require('../test-support/helpers');
const { request } = require('../lib/client');
const { createRedactor } = require('../lib/core/redact');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');

const elapse = (ms) => new Promise((r) => setTimeout(r, ms));

// A daemon, its live ctx and the handle mountGraphRoutes returned. A fresh
// lib/server is required for each (shortLockTtl, the one eviction of its
// modules: at the default 15-minute TTL unless `lockTtlMs` says otherwise), so
// the wrapper below is the one index.js destructures, and `env` (the task TTL)
// is read at its load. Both are restored after the test.
const DEFAULT_LOCK_TTL_MS = 15 * 60 * 1000;
async function daemon(t, { lockTtlMs = DEFAULT_LOCK_TTL_MS, env = {} } = {}) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  shortLockTtl(t, lockTtlMs);
  const routes = require('../lib/server/routes/graph');
  const real = routes.mountGraphRoutes;
  const cap = {};
  routes.mountGraphRoutes = (app, ctx) => { cap.ctx = ctx; cap.handle = real(app, ctx); return cap.handle; };
  const { createServer } = require('../lib/server');
  const turns = require('../lib/server/domain/turns');
  const s = await withServer(t, { createServer });
  const { ctx } = cap;
  const graph = ctx.graph;
  let dirtied = 0;
  return {
    ...s,
    ctx,
    graph,
    turns,
    handle: cap.handle,
    // The host: lib/client.
    host: (p, body) => request(s.port, 'POST', p, body, { timeout: 10000 }),
    // A browser: Node's fetch.
    page: async (p, body) => {
      const r = await s.api.post(p, body);
      return { status: r.status, body: r.json };
    },
    // Make the live surface differ from the active node: a value no earlier call wrote, so two calls
    // in the same millisecond still leave it dirty.
    dirty: (k = 'k', v = `dirty-${++dirtied}`) => { ctx.state.store[k] = v; },
    events: (op) => ctx.bus.events.filter((e) => e.kind === 'graph' && (!op || e.op === op)),
    meta: () => JSON.parse(fs.readFileSync(path.join(s.root, '.web-chat', 'graph', '_meta.json'), 'utf8')),
    nodeFile: (id) => fs.readFileSync(path.join(s.root, '.web-chat', 'graph', `${id}.json`), 'utf8'),
  };
}

// The session fields the turn hooks send.
const S1 = { session_id: 'sess-1', claude_pid: 4001, prompt_id: 'p1' };
const S2 = { session_id: 'sess-2', claude_pid: 4002, prompt_id: 'q1' };

const LOCK_0_8_0 = ['author', 'base', 'message', 'started_at'];
const RING_0_8_0 = ['base', 'kind', 'op', 'seq', 'stole_stale_lock', 'ts'];

// A fake turn guard (U31's interface): what it was asked, and what it answers.
function fakeGuard({ ended = null, closed = () => false, reconcile = () => 'n-late' } = {}) {
  const calls = { ended: [], closedRecently: [], reconcileLateStop: [] };
  return {
    calls,
    ended(lock) { calls.ended.push({ ...lock }); return typeof ended === 'function' ? ended(lock) : ended; },
    closedRecently(sid) { calls.closedRecently.push(sid); return closed(sid); },
    reconcileLateStop(args) { calls.reconcileLateStop.push(args); return reconcile(args); },
  };
}

// ── the lock record ─────────────────────────────────────────────────────────

test('lockSession and sameSession: fields only when set; same by session_id, or by claude_pid when both have one', async (t) => {
  const { turns } = await daemon(t);
  assert.deepStrictEqual(turns.lockSession({}), {});
  assert.deepStrictEqual(turns.lockSession({ session_id: '', claude_pid: 1, prompt_id: null }), {});
  assert.deepStrictEqual(turns.lockSession(S1), S1);
  assert.equal(turns.sameSession({ session_id: 'a' }, { session_id: 'a' }), true);
  assert.equal(turns.sameSession({ session_id: 'a', claude_pid: 7 }, { session_id: 'b', claude_pid: 7 }), true, 'a /clear under one process (C36)');
  assert.equal(turns.sameSession({ session_id: 'a', claude_pid: 7 }, { session_id: 'b', claude_pid: 8 }), false);
  assert.equal(turns.sameSession({}, {}), false, 'two unknown sessions are not the same');
  assert.equal(turns.sameSession({ session_id: 'a' }, {}), false);
});

test('a host lock records session_id, claude_pid and prompt_id; a session-less lock, its frame and _meta.json are 0.8.0\'s', async (t) => {
  const d = await daemon(t);
  const sock = d.ws();
  const frames = [];
  await new Promise((r, j) => { sock.on('message', (m) => { const f = JSON.parse(m); frames.push(f); if (f.type === 'hello') r(); }); sock.on('error', j); });
  t.after(() => { try { sock.close(); } catch {} });

  // A page's lock, sending every session field: none of them is read.
  const page = await d.page('/api/turn-begin', { message: 'from a page', author: 'user', ...S1 });
  assert.equal(page.status, 200);
  assert.deepStrictEqual(Object.keys(page.body).sort(), ['lock', 'ok', 'stole_stale_lock'], '0.8.0\'s answer');
  assert.deepStrictEqual(Object.keys(d.graph.lock).sort(), LOCK_0_8_0);
  assert.deepStrictEqual(Object.keys(d.meta().lock).sort(), LOCK_0_8_0, '_meta.json is 0.8.0\'s');
  const frame = await waitUntil(() => frames.find((f) => f.type === 'lock' && f.lock), { what: 'the lock frame' });
  assert.deepStrictEqual(Object.keys(frame.lock).sort(), [...LOCK_0_8_0, 'stale'].sort(), 'the lock frame is 0.8.0\'s');
  assert.deepStrictEqual(Object.keys((await d.api.get('/api/graph')).json.lock).sort(), [...LOCK_0_8_0, 'stale'].sort());
  await d.page('/api/unlock', {});

  // A host lock carries the session.
  frames.length = 0;
  const host = await d.host('/api/turn-begin', { message: 'from the host', author: 'user', ...S1 });
  assert.equal(host.status, 200);
  assert.deepStrictEqual(d.graph.lock, { base: null, started_at: d.graph.lock.started_at, message: 'from the host', author: 'user', ...S1 });
  assert.deepStrictEqual(d.meta().lock, d.graph.lock, 'persisted whole');
  const hostFrame = await waitUntil(() => frames.find((f) => f.type === 'lock' && f.lock), { what: 'the host lock frame' });
  assert.equal(hostFrame.lock.session_id, 'sess-1');
  assert.equal(hostFrame.lock.claude_pid, 4001);

  // Only the fields it has.
  await d.page('/api/unlock', {});
  await d.host('/api/turn-begin', { message: 'm', session_id: 'only-sid' });
  assert.deepStrictEqual(Object.keys(d.graph.lock).sort(), [...LOCK_0_8_0, 'session_id'].sort());
});

// ── the §3.2 turn-begin table, row by row ───────────────────────────────────

test('row 1: no lock → acquire, recording the session; the ring event adds session_id and prompt_id, and no author for a user', async (t) => {
  const d = await daemon(t);
  const r = await d.host('/api/turn-begin', { message: 'go', author: 'user', ...S1 });
  assert.deepStrictEqual([r.status, r.body.ok, r.body.stole_stale_lock], [200, true, false]);
  assert.equal(d.graph.lock.session_id, 'sess-1');
  const ev = d.events('turn-begin').pop();
  assert.deepStrictEqual(Object.keys(ev).sort(), [...RING_0_8_0, 'prompt_id', 'session_id'].sort());
  assert.deepStrictEqual([ev.session_id, ev.prompt_id, ev.author], ['sess-1', 'p1', undefined]);
});

test('row 1: a stale lock is stolen with preserve, and the new lock records the stealing session', async (t) => {
  const d = await daemon(t, { lockTtlMs: 50 });
  await d.host('/api/turn-begin', { message: 'abandoned', ...S1 });
  d.dirty();
  await elapse(120);
  const r = await d.host('/api/turn-begin', { message: 'next', ...S2 });
  assert.equal(r.status, 200);
  assert.equal(r.body.stole_stale_lock, true);
  assert.ok(r.body.preserved, 'the abandoned turn\'s work was kept as its own node');
  assert.equal(d.graph.nodes.get(r.body.preserved).trigger.kind, 'preserve');
  assert.deepStrictEqual([d.graph.lock.session_id, d.graph.lock.prompt_id, d.graph.lock.message], ['sess-2', 'q1', 'next']);
});

test('row 2: a fresh wake lock is upgraded in place by a user prompt, recording its session', async (t) => {
  const d = await daemon(t);
  d.turns.acquireWakeLock(d.graph, d.ctx.bus, { message: 'woken' });
  const base = d.graph.lock.base;
  const r = await d.host('/api/turn-begin', { message: 'typed', author: 'user', ...S1 });
  assert.deepStrictEqual([r.status, r.body.upgraded_wake_lock], [200, true]);
  assert.equal(d.graph.lock.author, 'user');
  assert.equal(d.graph.lock.ttl_ms, undefined, 'the short wake TTL is dropped');
  assert.equal(d.graph.lock.base, base);
  assert.equal(d.graph.lock.session_id, 'sess-1');
});

test('row 3: a fresh wake lock and a task → joined; the wake lock stays as it was', async (t) => {
  const d = await daemon(t);
  d.turns.acquireWakeLock(d.graph, d.ctx.bus, { message: 'woken' });
  const before = { ...d.graph.lock };
  const n = d.events().length;
  const r = await d.host('/api/turn-begin', { message: 'background task: tests done', author: 'task', ...S1 });
  assert.deepStrictEqual([r.status, r.body], [200, { ok: true, joined: true }]);
  assert.deepStrictEqual(d.graph.lock, before, 'untouched');
  assert.equal(d.events().length, n, 'a join emits nothing');
});

test('row 4: same session, a user prompt, and the guard has evidence → the held turn ends interrupted (ended_by copied), then a new lock', async (t) => {
  const d = await daemon(t);
  const guard = fakeGuard({ ended: { by: 'status', ended_by: 'web' } });
  d.ctx.turnGuard = guard;
  await d.host('/api/turn-begin', { message: 'the Esc\'d prompt', ...S1 });
  d.dirty();
  const r = await d.host('/api/turn-begin', { message: 'the next prompt', ...S1, prompt_id: 'p2' });
  assert.equal(r.status, 200);
  assert.equal(guard.calls.ended.length, 1);
  assert.equal(guard.calls.ended[0].message, 'the Esc\'d prompt', 'the guard is asked about the held lock');
  const node = d.graph.nodes.get(r.body.interrupted);
  assert.ok(node, 'the interrupted turn committed its work');
  assert.deepStrictEqual(
    { message: node.trigger.message, ended: node.trigger.ended, ended_by: node.trigger.ended_by, author: node.author },
    { message: 'the Esc\'d prompt', ended: 'interrupted', ended_by: 'web', author: 'claude' },
  );
  const te = d.events('turn-end').pop();
  assert.deepStrictEqual([te.session_id, te.prompt_id, te.ended, te.ended_by], ['sess-1', 'p1', 'interrupted', 'web']);
  assert.deepStrictEqual([d.graph.lock.message, d.graph.lock.prompt_id, d.graph.lock.base], ['the next prompt', 'p2', node.id]);

  // Evidence without ended_by: none is recorded; a clean surface folds.
  guard.calls.ended.length = 0;
  d.ctx.turnGuard = fakeGuard({ ended: true });
  const r2 = await d.host('/api/turn-begin', { message: 'third', ...S1, prompt_id: 'p3' });
  assert.equal(r2.body.interrupted, 'folded');
  const folded = d.graph.pendingFolded.at(-1);
  assert.deepStrictEqual([folded.message, folded.ended, folded.ended_by], ['the next prompt', 'interrupted', undefined]);
  assert.equal(d.graph.lock.prompt_id, 'p3');
});

test('row 4: same session, a user prompt, no evidence (or no guard) → joined; the held lock stays', async (t) => {
  const d = await daemon(t);
  await d.host('/api/turn-begin', { message: 'running', ...S1 });
  const before = { ...d.graph.lock };
  // No guard at all.
  assert.deepStrictEqual((await d.host('/api/turn-begin', { message: 'absorbed', ...S1, prompt_id: 'p2' })).body, { ok: true, joined: true });
  // A guard with no evidence, and one that throws.
  d.ctx.turnGuard = fakeGuard({ ended: null });
  assert.deepStrictEqual((await d.host('/api/turn-begin', { message: 'absorbed', ...S1 })).body, { ok: true, joined: true });
  d.ctx.turnGuard = { ended() { throw new Error('boom'); } };
  assert.deepStrictEqual((await d.host('/api/turn-begin', { message: 'absorbed', ...S1 })).body, { ok: true, joined: true });
  assert.deepStrictEqual(d.graph.lock, before);
  assert.equal(d.graph.nodes.size, 0);
});

test('row 5: same session and a task → joined, even with evidence', async (t) => {
  const d = await daemon(t);
  const guard = fakeGuard({ ended: { by: 'status' } });
  d.ctx.turnGuard = guard;
  await d.host('/api/turn-begin', { message: 'running', ...S1 });
  const r = await d.host('/api/turn-begin', { message: 'background task: x', author: 'task', ...S1 });
  assert.deepStrictEqual(r.body, { ok: true, joined: true });
  assert.equal(guard.calls.ended.length, 0, 'a task never interrupts');
  assert.equal(d.graph.lock.message, 'running');
});

test('same session matched by claude_pid after a session_id change (/clear, C36)', async (t) => {
  const d = await daemon(t);
  await d.host('/api/turn-begin', { message: 'before /clear', ...S1 });
  const cleared = { session_id: 'sess-1-after-clear', claude_pid: S1.claude_pid, prompt_id: 'c1' };
  assert.deepStrictEqual((await d.host('/api/turn-begin', { message: 'after', ...cleared })).body, { ok: true, joined: true });
  d.ctx.turnGuard = fakeGuard({ ended: { by: 'status', ended_by: 'terminal' } });
  d.dirty();
  const r = await d.host('/api/turn-begin', { message: 'after', ...cleared });
  assert.equal(r.status, 200);
  assert.equal(d.graph.nodes.get(r.body.interrupted).trigger.ended_by, 'terminal');
  assert.equal(d.graph.lock.session_id, 'sess-1-after-clear');
});

test('row 6: a fresh lock and a different or unknown session → 409, unchanged', async (t) => {
  const d = await daemon(t);
  d.ctx.turnGuard = fakeGuard({ ended: { by: 'status' } });
  await d.host('/api/turn-begin', { message: 'first', ...S1 });
  const other = await d.host('/api/turn-begin', { message: 'second', ...S2 });
  assert.equal(other.status, 409);
  assert.equal(other.body.lock.message, 'first');
  const unknown = await d.host('/api/turn-begin', { message: 'no session' });
  assert.equal(unknown.status, 409, 'a host request with no session is an unknown session');
  const task = await d.host('/api/turn-begin', { message: 'background task: x', author: 'task', ...S2 });
  assert.equal(task.status, 409, 'another session\'s task');
  assert.equal(d.ctx.turnGuard.calls.ended.length, 0, 'the guard is asked only about the same session');
  assert.equal(d.graph.lock.message, 'first');

  // A session-less lock: any session is unknown to it.
  await d.page('/api/unlock', {});
  await d.page('/api/turn-begin', { message: 'page lock' });
  assert.equal((await d.host('/api/turn-begin', { message: 'm', ...S1 })).status, 409);
});

// ── the task lock ───────────────────────────────────────────────────────────

test('a task lock takes TASK_LOCK_TTL_MS, author task and its message; the ring event names the author; the keep-alive extends it', async (t) => {
  const d = await daemon(t);
  assert.equal(d.turns.TASK_LOCK_TTL_MS, 3 * 60 * 1000, 'three minutes by default');
  const r = await d.host('/api/turn-begin', { message: 'background task: npm test passed', author: 'task', ...S1 });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(
    [d.graph.lock.author, d.graph.lock.message, d.graph.lock.ttl_ms],
    ['task', 'background task: npm test passed', d.turns.TASK_LOCK_TTL_MS],
  );
  assert.equal(d.events('turn-begin').pop().author, 'task');
  const before = d.graph.lock.started_at;
  await elapse(25);
  await d.api.post('/api/render', { id: 'tr-pane', html: '<p>working</p>' });
  assert.ok(d.graph.lock.started_at > before, 'Claude\'s write re-stamps a task lock too');
  assert.equal(d.graph.lock.ttl_ms, d.turns.TASK_LOCK_TTL_MS);
});

test('WEB_CHAT_TASK_LOCK_TTL_MS sets a task lock\'s TTL; past it the lock is stolen like any stale one', async (t) => {
  const d = await daemon(t, { env: { WEB_CHAT_TASK_LOCK_TTL_MS: '60' } });
  await d.host('/api/turn-begin', { message: 'background task: x', author: 'task', ...S1 });
  assert.equal(d.graph.lock.ttl_ms, 60);
  await elapse(130);
  const r = await d.host('/api/turn-begin', { message: 'someone else', ...S2 });
  assert.deepStrictEqual([r.status, r.body.stole_stale_lock], [200, true]);
});

// ── turn-end: another session, a late Stop, and today's paths ───────────────

test('a Stop from another host session answers skipped "other-session", leaves the lock, and rides the next commit\'s folded[]', async (t) => {
  const d = await daemon(t);
  await d.host('/api/turn-begin', { message: 'session one', ...S1 });
  d.dirty();
  const lock = { ...d.graph.lock };
  const r = await d.host('/api/turn-end', { author: 'claude', reply: 'session two replied', ended: 'stop', ...S2 });
  assert.deepStrictEqual([r.status, r.body], [200, { ok: true, skipped: 'other-session' }]);
  assert.deepStrictEqual(d.graph.lock, lock, 'the lock is untouched');
  assert.equal(d.graph.nodes.size, 0, 'nothing committed');
  const skipped = d.events('turn-skipped').pop();
  assert.deepStrictEqual(
    [skipped.reason, skipped.session_id, skipped.prompt_id, skipped.ended],
    ['other-session', 'sess-2', 'q1', 'stop'],
  );
  assert.equal(d.meta().pending_folded.length, 1, 'persisted with _meta.json');

  const end = await d.host('/api/turn-end', { author: 'claude', reply: 'session one replied', ended: 'stop', ...S1 });
  const node = d.graph.nodes.get(end.body.node_id);
  assert.equal(node.trigger.message, 'session one');
  assert.equal(node.trigger.reply, 'session one replied');
  assert.deepStrictEqual(node.folded.map((f) => [f.message, f.reply, f.ended]), [['', 'session two replied', 'stop']]);
  assert.equal(d.graph.lock, null);
});

test('a missing session_id on either side, or the same process, ends the held turn as today', async (t) => {
  const d = await daemon(t);
  // The Stop has no session_id (only a pid).
  await d.host('/api/turn-begin', { message: 'a', ...S1 });
  d.dirty('k', 1);
  const r1 = await d.host('/api/turn-end', { author: 'claude', claude_pid: 4999 });
  assert.ok(r1.body.node_id, 'committed');
  // The lock has none (a page's).
  await d.page('/api/turn-begin', { message: 'b' });
  d.dirty('k', 2);
  const r2 = await d.host('/api/turn-end', { author: 'claude', ...S2 });
  assert.ok(r2.body.node_id);
  // A page's Stop sending another session's fields: session-less, today's path.
  await d.host('/api/turn-begin', { message: 'c', ...S1 });
  d.dirty('k', 3);
  const r3 = await d.page('/api/turn-end', { author: 'claude', ...S2 });
  assert.ok(r3.body.node_id);
  // The same Claude Code process under a new session_id (/clear).
  await d.host('/api/turn-begin', { message: 'd', ...S1 });
  d.dirty('k', 4);
  const r4 = await d.host('/api/turn-end', { author: 'claude', session_id: 'sess-1-after-clear', claude_pid: S1.claude_pid });
  assert.ok(r4.body.node_id, 'sameSession by claude_pid');
  assert.equal(d.graph.nodes.size, 4);
});

test('a late Stop runs first: no lock and the guard closed this session\'s turn → reconciled, no new node', async (t) => {
  const d = await daemon(t);
  const guard = fakeGuard({ closed: (sid) => sid === 'sess-1', reconcile: () => 'n42' });
  d.ctx.turnGuard = guard;
  d.dirty();
  const r = await d.host('/api/turn-end', { author: 'claude', reply: 'the reply that came late', ended: 'stop', ...S1 });
  assert.deepStrictEqual([r.status, r.body], [200, { ok: true, reconciled: 'n42' }]);
  assert.equal(d.graph.nodes.size, 0, 'no stray node');
  assert.deepStrictEqual(guard.calls.reconcileLateStop, [{ session_id: 'sess-1', prompt_id: 'p1', reply: 'the reply that came late', ended: 'stop' }]);

  // A StopFailure passes 'failed'; a reconcile that names no node answers 'folded'.
  d.ctx.turnGuard = fakeGuard({ closed: () => true, reconcile: () => undefined });
  const f = await d.host('/api/turn-end', { author: 'claude', ended: 'failed', error: 'e', ...S1 });
  assert.deepStrictEqual(f.body, { ok: true, reconciled: 'folded' });
  assert.equal(d.ctx.turnGuard.calls.reconcileLateStop[0].ended, 'failed');
});

test('with no guard, or closedRecently false, or a page\'s Stop, the unlocked-turn path runs as today', async (t) => {
  const d = await daemon(t);
  // No guard: clean → no-lock, dirty → an unlocked-turn node.
  assert.deepStrictEqual((await d.host('/api/turn-end', { author: 'claude', ...S1 })).body, { ok: true, skipped: 'no-lock' });
  d.dirty('k', 1);
  const u = await d.host('/api/turn-end', { author: 'claude', ...S1 });
  assert.equal(u.body.unlocked, true);
  assert.equal(d.graph.nodes.get(u.body.node_id).trigger.kind, 'unlocked-turn');

  // A guard that did not close this session.
  d.ctx.turnGuard = fakeGuard({ closed: () => false });
  d.dirty('k', 2);
  const u2 = await d.host('/api/turn-end', { author: 'claude', ...S1 });
  assert.equal(u2.body.unlocked, true);
  assert.deepStrictEqual(d.ctx.turnGuard.calls.reconcileLateStop, []);

  // A page cannot reconcile: it has no session, so the guard is never asked.
  d.ctx.turnGuard = fakeGuard({ closed: () => true });
  d.dirty('k', 3);
  const p = await d.page('/api/turn-end', { author: 'claude', ...S1 });
  assert.equal(p.body.unlocked, true);
  assert.deepStrictEqual(d.ctx.turnGuard.calls.closedRecently, []);
});

test('a late Stop the guard answers null for (a prompt_id it never closed) goes on down the lockless path (U31b)', async (t) => {
  const d = await daemon(t);
  d.ctx.turnGuard = fakeGuard({ closed: () => true, reconcile: () => null });
  // Clean: no-lock, as with no guard.
  assert.deepStrictEqual((await d.host('/api/turn-end', { author: 'claude', ...S1, prompt_id: 'p9' })).body, { ok: true, skipped: 'no-lock' });
  // Dirty: an unlocked-turn node carrying the Stop's reply.
  d.dirty();
  const u = await d.host('/api/turn-end', { author: 'claude', reply: 'whose?', ...S1, prompt_id: 'p9' });
  assert.equal(u.body.unlocked, true);
  assert.equal(u.body.reconciled, undefined);
  const node = d.graph.nodes.get(u.body.node_id);
  assert.deepStrictEqual([node.trigger.kind, node.trigger.reply], ['unlocked-turn', 'whose?']);
  assert.equal(d.ctx.turnGuard.calls.reconcileLateStop.length, 2, 'the guard was asked each time');
  // A guard that throws in reconcileLateStop answers "no" the same way.
  d.ctx.turnGuard = { closedRecently: () => true, reconcileLateStop() { throw new Error('boom'); } };
  d.dirty();
  assert.equal((await d.host('/api/turn-end', { author: 'claude', ...S1 })).body.unlocked, true);
});

test('turn-begin tells the guard which turn it ended as interrupted: noteEnded(held lock, endTurn\'s answer, {ended, since}) (U31b)', async (t) => {
  const d = await daemon(t);
  const noted = [];
  d.ctx.turnGuard = { ...fakeGuard({ ended: { by: 'status', ended_by: 'terminal' } }), noteEnded: (...a) => { noted.push(a); return true; } };
  await d.host('/api/turn-begin', { message: 'first', ...S1 });
  d.dirty();
  const t0 = Date.now();
  const r = await d.host('/api/turn-begin', { message: 'second', ...S1, prompt_id: 'p2' });
  assert.ok(r.body.interrupted);
  assert.equal(noted.length, 1);
  const [lock, result, opts] = noted[0];
  assert.deepStrictEqual([lock.message, lock.session_id, lock.prompt_id], ['first', 'sess-1', 'p1']);
  assert.deepStrictEqual(result, { ok: true, node_id: r.body.interrupted });
  assert.equal(opts.ended, 'interrupted');
  assert.ok(opts.since >= t0 && opts.since <= Date.now());
  // A joined prompt ends nothing, so it notes nothing.
  d.ctx.turnGuard = { ...fakeGuard({ ended: null }), noteEnded: (...a) => { noted.push(a); } };
  assert.deepStrictEqual((await d.host('/api/turn-begin', { message: 'absorbed', ...S1, prompt_id: 'p3' })).body, { ok: true, joined: true });
  assert.equal(noted.length, 1);
});

test('a Stop of the held lock\'s session naming another prompt_id that the guard closed is reconciled; the held turn stays open (U31b)', async (t) => {
  const d = await daemon(t);
  await d.host('/api/turn-begin', { message: 'held', ...S1, prompt_id: 'p2' });
  const held = d.graph.lock;
  d.dirty();
  const guard = fakeGuard({ closed: (sid) => sid === 'sess-1', reconcile: (a) => (a.prompt_id === 'p1' ? 'n-old' : null) });
  d.ctx.turnGuard = guard;
  const r = await d.host('/api/turn-end', { author: 'claude', reply: 'the old turn\'s reply', ...S1, prompt_id: 'p1' });
  assert.deepStrictEqual([r.status, r.body], [200, { ok: true, reconciled: 'n-old' }]);
  assert.deepStrictEqual(guard.calls.reconcileLateStop, [{ session_id: 'sess-1', prompt_id: 'p1', reply: 'the old turn\'s reply', ended: 'stop' }]);
  assert.equal(d.graph.lock, held);
  assert.equal(d.graph.nodes.size, 0);

  // A prompt_id the guard does not know: the held turn ends, as before.
  const r2 = await d.host('/api/turn-end', { author: 'claude', ...S1, prompt_id: 'p7' });
  assert.ok(r2.body.node_id);
  assert.equal(d.graph.lock, null);

  // The lock's own prompt_id, or none, never asks the guard: the held turn ends.
  for (const fields of [{ ...S1, prompt_id: 'p4' }, { session_id: 'sess-1', claude_pid: S1.claude_pid }]) {
    await d.host('/api/turn-begin', { message: 'again', ...S1, prompt_id: 'p4' });
    d.dirty();
    d.ctx.turnGuard = fakeGuard({ closed: () => true, reconcile: () => 'n-wrong' });
    const e = await d.host('/api/turn-end', { author: 'claude', ...fields });
    assert.ok(e.body.node_id, 'ended the held turn');
    assert.deepStrictEqual(d.ctx.turnGuard.calls.reconcileLateStop, []);
  }

  // closedRecently false: the held turn ends; another session's Stop folds as before.
  await d.host('/api/turn-begin', { message: 'again', ...S1, prompt_id: 'p5' });
  d.ctx.turnGuard = fakeGuard({ closed: () => false, reconcile: () => 'n-wrong' });
  assert.deepStrictEqual((await d.host('/api/turn-end', { author: 'claude', ...S2 })).body, { ok: true, skipped: 'other-session' });
  d.dirty();
  assert.ok((await d.host('/api/turn-end', { author: 'claude', ...S1, prompt_id: 'p1' })).body.node_id);
  assert.deepStrictEqual(d.ctx.turnGuard.calls.reconcileLateStop, []);
});

// ── endTurn ─────────────────────────────────────────────────────────────────

test('mountGraphRoutes returns {endTurn}; it ends a held lock exactly as the route does', async (t) => {
  const d = await daemon(t);
  assert.deepStrictEqual(Object.keys(d.handle), ['endTurn']);
  const { endTurn } = d.handle;

  // No lock, clean: as the route.
  assert.deepStrictEqual(endTurn({}), { ok: true, skipped: 'no-lock' });

  // Dirty: commits on the lock's base with the lock's prompt, and unlocks.
  await d.host('/api/turn-begin', { message: 'ended by the guard', ...S1 });
  d.dirty('k', 1);
  const c = endTurn({ author: 'claude', ended: 'session-ended', session_id: 'sess-1' });
  const node = d.graph.nodes.get(c.node_id);
  assert.deepStrictEqual([node.trigger.message, node.trigger.ended, node.parent_id], ['ended by the guard', 'session-ended', null]);
  assert.equal(d.graph.lock, null);
  assert.deepStrictEqual(Object.keys(c), ['ok', 'node_id']);

  // Clean: skips and folds.
  await d.host('/api/turn-begin', { message: 'chat only', ...S1 });
  const s = endTurn({ author: 'claude', reply: 'just talk', ended: 'interrupted', ended_by: 'hook' });
  assert.deepStrictEqual(s, { ok: true, skipped: 'no-change', accumulated: 1 });
  assert.deepStrictEqual(
    [d.graph.pendingFolded[0].message, d.graph.pendingFolded[0].reply, d.graph.pendingFolded[0].ended, d.graph.pendingFolded[0].ended_by],
    ['chat only', 'just talk', 'interrupted', 'hook'],
  );

  // A re-aim queued mid-turn applies after.
  await d.host('/api/turn-begin', { message: 'with a queued wipe', ...S1 });
  const q = await d.page('/api/graph/wipe', { name: 'fresh' });
  assert.equal(q.body.pending, true);
  d.dirty('k', 2);
  const w = endTurn({ author: 'claude' });
  assert.ok(w.node_id);
  assert.deepStrictEqual(w.reaim, { op: 'wipe', ok: true });
  assert.equal(d.graph.pendingBookmark.wipe, true);

  // The same sequence through the route answers the same shapes.
  await d.page('/api/turn-begin', { message: 'route' });
  d.dirty('k', 3);
  assert.deepStrictEqual(Object.keys((await d.page('/api/turn-end', { author: 'claude' })).body), ['ok', 'node_id']);
});

// ── ended, ended_by, error ──────────────────────────────────────────────────

test('ended, ended_by and error land on triggers and folded entries only when present; a page records none', async (t) => {
  const d = await daemon(t);
  await d.host('/api/turn-begin', { message: 'fails', ...S1 });
  d.dirty('k', 1);
  const f = await d.host('/api/turn-end', { author: 'claude', ended: 'failed', error: `api: ${'e'.repeat(800)}`, ...S1 });
  const ft = d.graph.nodes.get(f.body.node_id).trigger;
  assert.equal(ft.ended, 'failed');
  assert.equal(ft.error.length, 500, 'error ≤ 500');
  assert.equal('ended_by' in ft, false, 'a Stop never names who interrupted');

  // A Stop: ended 'stop', no error key. An ended the hook never sends is a Stop.
  await d.host('/api/turn-begin', { message: 'stops', ...S1 });
  d.dirty('k', 2);
  const s = await d.host('/api/turn-end', { author: 'claude', ended: 'whatever', ended_by: 'web', ...S1 });
  const st = d.graph.nodes.get(s.body.node_id).trigger;
  assert.deepStrictEqual([st.ended, 'error' in st, 'ended_by' in st], ['stop', false, false], 'ended_by never comes from a request');

  // A folded entry, from a host StopFailure that changed nothing.
  await d.host('/api/turn-begin', { message: 'folds', ...S1 });
  await d.host('/api/turn-end', { author: 'claude', ended: 'failed', error: 'overloaded', ...S1 });
  const entry = d.graph.pendingFolded.at(-1);
  assert.deepStrictEqual([entry.ended, entry.error, 'ended_by' in entry], ['failed', 'overloaded', false]);

  // A page's turn-end: 0.8.0's trigger, whatever it sends.
  await d.page('/api/turn-begin', { message: 'page' });
  d.dirty('k', 3);
  const p = await d.page('/api/turn-end', { author: 'claude', ended: 'failed', error: 'x', ...S1 });
  const pt = d.graph.nodes.get(p.body.node_id).trigger;
  assert.deepStrictEqual(Object.keys(pt).sort(), ['kind', 'message', 'summary']);
  const pn = d.graph.nodes.get(p.body.node_id);
  assert.equal(pn.folded[0].message, 'folds', 'the folded entry rode this commit');
  assert.deepStrictEqual(Object.keys(pn.folded[0]).sort(), ['at', 'author', 'ended', 'error', 'kind', 'message', 'summary']);
});

// ── ring events ─────────────────────────────────────────────────────────────

test('ring events: turn-begin, turn-end and turn-skipped carry the new fields only when present', async (t) => {
  const d = await daemon(t);
  // A page: 0.8.0's events, byte for byte.
  await d.page('/api/turn-begin', { message: 'page', ...S1 });
  assert.deepStrictEqual(Object.keys(d.events('turn-begin').pop()).sort(), RING_0_8_0);
  d.dirty('k', 1);
  await d.page('/api/turn-end', { author: 'claude', ended: 'stop', ...S1 });
  assert.deepStrictEqual(Object.keys(d.events('turn-end').pop()).sort(), ['id', 'kind', 'op', 'seq', 'ts']);
  await d.page('/api/turn-begin', { message: 'page' });
  await d.page('/api/turn-end', { author: 'claude' });
  assert.deepStrictEqual(Object.keys(d.events('turn-skipped').pop()).sort(), ['accumulated', 'kind', 'op', 'reason', 'seq', 'ts']);

  // The host: the session, the prompt and how it ended.
  await d.host('/api/turn-begin', { message: 'host', ...S1 });
  d.dirty('k', 2);
  await d.host('/api/turn-end', { author: 'claude', ended: 'stop', ...S1 });
  const te = d.events('turn-end').pop();
  assert.deepStrictEqual([te.session_id, te.prompt_id, te.ended, 'ended_by' in te], ['sess-1', 'p1', 'stop', false]);
  await d.host('/api/turn-begin', { message: 'host', session_id: 'sess-1' });
  await d.host('/api/turn-end', { author: 'claude', ended: 'failed', session_id: 'sess-1' });
  const sk = d.events('turn-skipped').pop();
  assert.deepStrictEqual([sk.reason, sk.session_id, 'prompt_id' in sk, sk.ended], ['no-change', 'sess-1', false, 'failed']);
});

// ── redaction ───────────────────────────────────────────────────────────────

test('with graph.redactText set, the lock message, trigger message, summary, reply and every folded entry are masked; no node file or _meta.json holds a secret', async (t) => {
  const d = await daemon(t);
  const fakes = fakeSecrets({ seed: 30 }).filter((f) => ['sk-openrouter', 'sk-openai-legacy', 'bearer-bare'].includes(f.id));
  assert.equal(fakes.length, 3);
  const [a, b, c] = fakes.map((f) => f.text);
  const redactor = createRedactor();
  d.graph.redactText = (s) => redactor.text(s);
  const leaks = (hay) => findLeaks(hay, fakes).map((l) => l.id);

  // The lock's message, live and on disk.
  await d.host('/api/turn-begin', { message: `please use ${a}`, ...S1 });
  assert.deepStrictEqual(leaks(d.graph.lock), [], 'the lock');
  assert.deepStrictEqual(leaks(fs.readFileSync(path.join(d.root, '.web-chat', 'graph', '_meta.json'), 'utf8')), [], '_meta.json');
  assert.match(d.graph.lock.message, /‹redacted:/);

  // A folded turn (no change), and another session's Stop.
  await d.host('/api/turn-end', { author: 'claude', summary: `summary ${b}`, reply: `reply ${c}`, ended: 'failed', error: `error ${a}`, ...S1 });
  await d.host('/api/turn-begin', { message: `second ${b}`, ...S1 });
  await d.host('/api/turn-end', { author: 'claude', summary: `other ${c}`, reply: `other reply ${a}`, ...S2 });
  assert.equal(d.graph.pendingFolded.length, 2);
  assert.deepStrictEqual(leaks(d.graph.pendingFolded), [], 'every folded entry');
  assert.deepStrictEqual(leaks(fs.readFileSync(path.join(d.root, '.web-chat', 'graph', '_meta.json'), 'utf8')), []);

  // A commit: trigger message, summary, reply, and the folded entries it carries.
  d.dirty();
  const end = await d.host('/api/turn-end', { author: 'claude', summary: `done ${c}`, reply: `here it is ${b}`, ...S1 });
  const node = d.graph.nodes.get(end.body.node_id);
  assert.equal(node.folded.length, 2);
  assert.deepStrictEqual(leaks(d.nodeFile(node.id)), [], 'the node file');
  for (const k of ['message', 'summary', 'reply']) assert.match(node.trigger[k], /‹redacted:/, `trigger.${k} is masked`);

  // The unlocked-turn, manual and interrupted commit paths are masked too.
  d.dirty('k', 2);
  const u = await d.host('/api/turn-end', { author: 'claude', summary: `unlocked ${a}`, reply: `r ${b}`, ...S1 });
  assert.deepStrictEqual(leaks(d.nodeFile(u.body.node_id)), []);
  d.dirty('k', 3);
  const m = await d.page('/api/commit', { message: `manual ${c}` });
  assert.deepStrictEqual(leaks(d.nodeFile(m.body.node_id)), []);
  d.ctx.turnGuard = fakeGuard({ ended: { by: 'status', ended_by: 'terminal' } });
  await d.host('/api/turn-begin', { message: `esc'd ${a}`, ...S1 });
  d.dirty('k', 4);
  const i = await d.host('/api/turn-begin', { message: `after ${b}`, ...S1 });
  assert.deepStrictEqual(leaks(d.nodeFile(i.body.interrupted)), []);
  assert.deepStrictEqual(leaks(d.meta()), []);

  // GET /api/graph serves only masked text.
  assert.deepStrictEqual(leaks((await d.api.get('/api/graph')).text), []);
});

test('with graph.redactText set, a wake lock\'s message is masked when taken and when a re-wake re-stamps it, live and in _meta.json', async (t) => {
  const d = await daemon(t);
  const fakes = fakeSecrets({ seed: 31 }).filter((f) => ['sk-openrouter', 'sk-openai-legacy'].includes(f.id));
  assert.equal(fakes.length, 2);
  const [a, b] = fakes.map((f) => f.text);
  const redactor = createRedactor();
  d.graph.redactText = (s) => redactor.text(s);
  const leaks = (hay) => findLeaks(hay, fakes).map((l) => l.id);

  d.turns.acquireWakeLock(d.graph, d.ctx.bus, { message: `woken with ${a}` });
  assert.equal(d.graph.lock.author, 'wake');
  assert.match(d.graph.lock.message, /‹redacted:/);
  assert.deepStrictEqual(leaks(d.graph.lock), [], 'the wake lock');
  assert.deepStrictEqual(leaks(d.meta()), [], '_meta.json');

  // A second wake on the fresh wake lock re-stamps its message.
  d.turns.acquireWakeLock(d.graph, d.ctx.bus, { message: `woken again with ${b}` });
  assert.match(d.graph.lock.message, /‹redacted:/);
  assert.deepStrictEqual(leaks(d.graph.lock), [], 'the re-stamped wake lock');
  assert.deepStrictEqual(leaks(d.meta()), [], '_meta.json after the re-stamp');
});

test('a redactText that throws keeps nothing; without one the text is kept as it is', async (t) => {
  const d = await daemon(t);
  await d.host('/api/turn-begin', { message: 'plain prompt', ...S1 });
  assert.equal(d.graph.lock.message, 'plain prompt');
  await d.page('/api/unlock', {});
  d.graph.redactText = () => { throw new Error('boom'); };
  await d.host('/api/turn-begin', { message: 'never stored', ...S1 });
  assert.equal(d.graph.lock.message, '');
});

// ── a browser stays session-less ────────────────────────────────────────────

test('a browser\'s fetch sending session fields cannot join, interrupt, reconcile or fold another session\'s turn', async (t) => {
  const d = await daemon(t);
  const guard = fakeGuard({ ended: { by: 'status', ended_by: 'web' }, closed: () => true });
  d.ctx.turnGuard = guard;
  await d.host('/api/turn-begin', { message: 'the host\'s turn', ...S1 });
  const lock = { ...d.graph.lock };

  // Its prompt naming the lock's own session: no join, no interrupt — 409.
  const tb = await d.page('/api/turn-begin', { message: 'from a pane', ...S1 });
  assert.equal(tb.status, 409);
  const task = await d.page('/api/turn-begin', { message: 'from a pane', author: 'task', ...S1 });
  assert.equal(task.status, 409);
  assert.deepStrictEqual(guard.calls.ended, [], 'the guard is never asked on a page\'s behalf');
  assert.deepStrictEqual(d.graph.lock, lock);

  // Its Stop naming another session: not folded as other-session; it is the
  // session-less Stop 0.8.0 took (the lock's turn ends, recording nothing new).
  const te = await d.page('/api/turn-end', { author: 'claude', ...S2 });
  assert.notEqual(te.body.skipped, 'other-session');
  assert.equal(d.events('turn-skipped').filter((e) => e.reason === 'other-session').length, 0);

  // With no lock, its Stop is never reconciled.
  d.dirty();
  const late = await d.page('/api/turn-end', { author: 'claude', ...S1 });
  assert.equal(late.body.reconciled, undefined);
  assert.deepStrictEqual(guard.calls.closedRecently, []);
  assert.deepStrictEqual(guard.calls.reconcileLateStop, []);
});
