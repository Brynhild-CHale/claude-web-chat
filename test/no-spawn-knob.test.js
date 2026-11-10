// The no-spawn knob (contract 10 C-10.5, A-10.3; PLAN 6B.5, unit U751): under
// WEB_CHAT_SUPERVISED naming the call's own root, lib/mcp/client.js sends
// spawn: false and, when no daemon answers, waits ONCE on waitForDaemon before
// it fails — it never spawns. Any other root, and an absent variable, behave
// as before; a caller's noSpawn (the hooks) still wins; WEB_CHAT_PORT is never
// touched by the knob.
//
// The seams: lib/client's get/post (lib/mcp/client.js calls them through the
// module object at call time), lib/util/daemon's waitForDaemon (read at call
// time by lib/mcp/client.js) and spawnDaemon (read at call time by lib/client),
// each replaced for one test and put back after it. No test here spawns a
// daemon: the two that reach a real one boot it in-process (withServer).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { withServer, tmpRoot } = require('../test-support/helpers');
const lc = require('../lib/client');
const daemon = require('../lib/util/daemon');
const client = require('../lib/mcp/client');

const KNOB = 'WEB_CHAT_SUPERVISED';
const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp', 'client.js'), 'utf8');

// Set (or delete, for undefined) an env var for one test.
function env(t, name, value) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  t.after(() => { if (had) process.env[name] = prev; else delete process.env[name]; });
}

// Replace obj[key] for one test.
function stub(t, obj, key, fn) {
  const prev = obj[key];
  obj[key] = fn;
  t.after(() => { obj[key] = prev; });
}

// The three seams, recorded. `answers` is what lib/client's get answers per
// call, in order: a value, or an Error to throw.
function seams(t, { answers = [{ ok: true }], wait = null } = {}) {
  const rec = { calls: [], waits: [], spawns: [] };
  const answer = (opts) => {
    rec.calls.push(opts);
    const a = answers[Math.min(rec.calls.length - 1, answers.length - 1)];
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve(a);
  };
  stub(t, lc, 'get', (p, opts) => answer(opts));
  stub(t, lc, 'post', (p, b, opts) => answer(opts));
  stub(t, daemon, 'waitForDaemon', async (...args) => { rec.waits.push(args); return wait; });
  stub(t, daemon, 'spawnDaemon', async (...args) => { rec.spawns.push(args); throw new Error('spawn seam called'); });
  return rec;
}

function project(t) {
  const root = tmpRoot('wc-knob-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  return root;
}

test('supervised(): only an absolute, existing folder that is the call\'s own root', (t) => {
  const root = project(t);
  const other = project(t);
  const link = `${root}-link`;
  fs.symlinkSync(root, link);
  t.after(() => { try { fs.unlinkSync(link); } catch {} });
  const file = path.join(root, 'a-file');
  fs.writeFileSync(file, 'x');

  env(t, KNOB, undefined);
  assert.equal(client.supervised(root), false, 'absent');
  for (const [value, want, why] of [
    [root, true, 'the root itself'],
    [link, true, 'a symlinked spelling of the knob'],
    [`${root}${path.sep}`, true, 'a trailing separator'],
    [other, false, 'another root'],
    ['', false, 'empty'],
    [path.relative(process.cwd(), root), false, 'a relative path'],
    [path.join(root, 'gone'), false, 'a path that does not exist'],
    ['not a path', false, 'unparseable'],
    [file, false, 'a file, not a folder'],
  ]) {
    process.env[KNOB] = value;
    assert.equal(client.supervised(root), want, why);
  }
  process.env[KNOB] = root;
  assert.equal(client.supervised(link), true, 'the call\'s root spelled through the symlink');
});

test('knob on its own root: the call goes out with spawn: false (get and post, explicit and cwd roots)', async (t) => {
  const root = project(t);
  const link = `${root}-link`;
  fs.symlinkSync(root, link);
  t.after(() => { try { fs.unlinkSync(link); } catch {} });
  const rec = seams(t, { answers: [{ ok: 1 }] });

  env(t, KNOB, link);
  assert.deepEqual(await client.get('/api/health', { root }), { ok: 1 });
  assert.deepEqual(await client.post('/api/x', { a: 1 }, { root, spawn: true }), { ok: 1 });
  env(t, KNOB, process.cwd());
  assert.deepEqual(await client.get('/api/health'), { ok: 1 });

  assert.equal(rec.calls.length, 3);
  for (const o of rec.calls) assert.equal(o.spawn, false, 'never spawn: true under the knob, a caller\'s spawn: true included');
  assert.equal(rec.waits.length, 0, 'a call that reached a daemon never waits');
  assert.equal(rec.spawns.length, 0);
});

test('knob, no daemon: waits once on waitForDaemon, retries once with spawn: false when it answers', async (t) => {
  const root = project(t);
  const rec = seams(t, {
    answers: [new lc.NoServerError(), { ok: 'retried' }],
    wait: { pid: 4242, port: 45999, url: 'http://localhost:45999', source: 'portfile' },
  });
  env(t, KNOB, root);

  assert.deepEqual(await client.get('/api/health', { root }), { ok: 'retried' });
  assert.equal(rec.waits.length, 1, 'ONE wait');
  assert.deepEqual(rec.waits[0], [root], 'the default wait (no options) for the call\'s root');
  assert.equal(rec.calls.length, 2, 'ONE retry');
  assert.equal(rec.calls[0].spawn, false);
  assert.equal(rec.calls[1].spawn, false);
  assert.equal(rec.calls[1].port, 45999, 'the retry goes to the daemon the wait verified');
  assert.equal(rec.spawns.length, 0);
});

test('knob, no daemon, the wait finds none: NoServerError with the supervised hint, no spawn', async (t) => {
  const root = project(t);
  const rec = seams(t, { answers: [new lc.NoServerError()], wait: null });
  env(t, KNOB, root);

  await assert.rejects(client.post('/api/render', { id: 'x' }, { root }), (e) => {
    assert.ok(e instanceof lc.NoServerError);
    assert.equal(e.code, 'NO_SERVER');
    assert.equal(e.message, client.SUPERVISED_HINT);
    assert.match(e.message, /supervised by the web-chat connector/);
    assert.match(e.message, /claude-web-chat connect status/);
    return true;
  });
  assert.equal(rec.waits.length, 1);
  assert.equal(rec.calls.length, 1, 'no retry without a daemon');
  assert.equal(rec.spawns.length, 0);
});

test('knob, the retry still finds no daemon: the supervised hint, and no second wait', async (t) => {
  const root = project(t);
  const rec = seams(t, { answers: [new lc.NoServerError(), new lc.NoServerError()], wait: { pid: 1, port: 45998 } });
  env(t, KNOB, root);

  await assert.rejects(client.get('/api/health', { root }), (e) => e instanceof lc.NoServerError && e.message === client.SUPERVISED_HINT);
  assert.equal(rec.waits.length, 1);
  assert.equal(rec.calls.length, 2);
  assert.equal(rec.spawns.length, 0);
});

test('knob: an error that is not "no server" passes through untouched, with no wait', async (t) => {
  const root = project(t);
  const boom = new lc.HttpError(404, { error: 'nope' }, 'GET', '/api/x');
  const rec = seams(t, { answers: [boom] });
  env(t, KNOB, root);

  await assert.rejects(client.get('/api/x', { root }), (e) => e === boom);
  assert.equal(rec.waits.length, 0);
  assert.equal(rec.calls.length, 1);
});

test('knob through the real lib/client, no daemon: never reaches the spawn seam, fails with the hint', async (t) => {
  const root = project(t);
  env(t, 'WEB_CHAT_PORT', undefined);
  const waits = [];
  const spawns = [];
  stub(t, daemon, 'waitForDaemon', async (...args) => { waits.push(args); return null; });
  stub(t, daemon, 'spawnDaemon', async (...args) => { spawns.push(args); throw new Error('spawn seam called'); });
  env(t, KNOB, root);

  await assert.rejects(client.get('/api/health', { root }), (e) => e instanceof lc.NoServerError && e.message === client.SUPERVISED_HINT);
  assert.equal(spawns.length, 0, 'no spawn seam is ever called');
  assert.equal(waits.length, 1);

  // The same root without the knob takes lib/client's spawn path (as today).
  env(t, KNOB, undefined);
  await assert.rejects(client.get('/api/health', { root }), (e) => e && /spawn seam called/.test(e.message));
  assert.equal(spawns.length, 1, 'without the knob the spawn path is taken');
});

test('knob through the real lib/client: a live daemon answers at once, and the retry reaches the one the wait found', async (t) => {
  env(t, 'WEB_CHAT_PORT', undefined);
  const spawns = [];
  stub(t, daemon, 'spawnDaemon', async (...args) => { spawns.push(args); throw new Error('spawn seam called'); });

  // A daemon with its portfile: found by discovery, no wait.
  await withServer(t, { writePortfile: true }, async ({ root }) => {
    const waits = [];
    stub(t, daemon, 'waitForDaemon', async (...args) => { waits.push(args); return null; });
    env(t, KNOB, root);
    const h = await client.get('/api/health', { root });
    assert.ok(h && typeof h === 'object');
    assert.equal(waits.length, 0);
  });

  // A daemon whose portfile is not written yet: the first call finds none, the
  // wait verifies it, the retry reaches it.
  await withServer(t, async ({ root, port }) => {
    const waits = [];
    stub(t, daemon, 'waitForDaemon', async (...args) => { waits.push(args); return { pid: process.pid, port }; });
    env(t, KNOB, root);
    const h = await client.get('/api/health', { root });
    assert.ok(h && typeof h === 'object');
    assert.equal(waits.length, 1);
  });
  assert.equal(spawns.length, 0);
});

test('knob naming another root: the call spawns as today (spawn: true), no wait', async (t) => {
  const root = project(t);
  const other = project(t);
  const rec = seams(t, { answers: [new lc.NoServerError()] });
  env(t, KNOB, other);

  await assert.rejects(client.get('/api/health', { root }), (e) => e instanceof lc.NoServerError && e.message !== client.SUPERVISED_HINT);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].spawn, true);
  assert.equal(rec.waits.length, 0);
});

test('knob absent (or naming another root): the options lib/client gets are exactly the base shim\'s', async (t) => {
  const root = project(t);
  const other = project(t);
  const rec = seams(t, { answers: [{ ok: 1 }] });
  // The base shim: { spawn: true, ...o }, plus the identity headers and this
  // root's writer token when this process is the MCP server.
  const base = (o) => ({ spawn: true, ...o });

  for (const knob of [undefined, other]) {
    env(t, KNOB, knob);
    env(t, 'WEB_CHAT_MCP_SERVER', undefined);
    rec.calls.length = 0;
    const o1 = { root, timeout: 7, hint: 'h' };
    await client.get('/a', o1);
    await client.post('/b', { x: 1 }, { root, noSpawn: true });
    await client.get('/c', { root, spawn: false });
    assert.deepEqual(rec.calls, [base(o1), base({ root, noSpawn: true }), base({ root, spawn: false })]);

    env(t, 'WEB_CHAT_MCP_SERVER', '1');
    rec.calls.length = 0;
    await client.get('/a', { root, headers: { 'X-Mine': '1' } });
    const sent = rec.calls[0];
    assert.equal(sent.spawn, true);
    assert.equal(sent.headers['X-WC-Client'] !== undefined, true, 'identity headers as before');
    assert.equal(sent.headers['X-Mine'], '1');
  }
  assert.equal(rec.waits.length, 0);
  assert.equal(rec.spawns.length, 0);
});

test('a caller\'s noSpawn still wins under the knob: the call goes out as before and never waits', async (t) => {
  const root = project(t);
  const rec = seams(t, { answers: [new lc.NoServerError()], wait: { pid: 1, port: 45997 } });
  env(t, KNOB, root);
  env(t, 'WEB_CHAT_MCP_SERVER', undefined);

  await assert.rejects(client.post('/api/turn/end', {}, { root, noSpawn: true }), (e) => e instanceof lc.NoServerError && e.message !== client.SUPERVISED_HINT);
  assert.deepEqual(rec.calls, [{ spawn: true, root, noSpawn: true }], 'byte-identical to the base: lib/client\'s noSpawn decides');
  assert.equal(rec.waits.length, 0, 'a hook never waits');
  assert.equal(rec.spawns.length, 0);
});

test('the knob neither reads nor sets WEB_CHAT_PORT', async (t) => {
  assert.doesNotMatch(SRC, /WEB_CHAT_PORT/, 'lib/mcp/client.js never names WEB_CHAT_PORT');

  const root = project(t);
  seams(t, { answers: [new lc.NoServerError(), { ok: 1 }], wait: { pid: 1, port: 45996 } });
  env(t, KNOB, root);
  env(t, 'WEB_CHAT_PORT', undefined);

  // Every env read and write during one supervised call (lib/client's get is
  // stubbed, so these are the shim's own).
  const reads = new Set();
  const writes = new Set();
  const real = process.env;
  const watched = new Proxy(real, {
    get(o, k) { if (typeof k === 'string') reads.add(k); return Reflect.get(o, k); },
    set(o, k, v) { writes.add(k); return Reflect.set(o, k, v); },
    deleteProperty(o, k) { writes.add(k); return Reflect.deleteProperty(o, k); },
  });
  process.env = watched;
  try {
    assert.deepEqual(await client.get('/api/health', { root }), { ok: 1 });
  } finally {
    process.env = real;
  }
  assert.ok(reads.has(KNOB), 'the knob is read per call');
  assert.ok(!reads.has('WEB_CHAT_PORT'), 'WEB_CHAT_PORT never read');
  assert.equal(writes.size, 0, 'nothing written to the environment');
  assert.equal(process.env.WEB_CHAT_PORT, undefined);
});
