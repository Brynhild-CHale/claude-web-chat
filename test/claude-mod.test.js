// The web-chat mod package (templates/claude-mod/, spec §15.7, U88): its
// files, and its hooks module's behaviour against a fake `$` and a REAL bridge
// (lib/server/domain/bridge + lib/server/routes/bridge on a bare Express app,
// as test/bridge-routes.test.js mounts them). No test runs `claude`: the fake
// host below stands in for Claude Code — it registers the module's hooks,
// fires events through them, and answers `$` (its $.http.fetch goes through
// lib/client, which sends no Origin and no Sec-Fetch-*, as the mod's own
// fetch; Node's fetch would be refused as a browser).
//
// The fake host's clock fires each timer after a SHORT real delay (default
// min(ms, 15)) and records the ms asked for, so a 60 s back-off runs in
// milliseconds while the test still reads 1000, 2000, … 60000. In `strict`
// mode every `$` call made outside a dispatch — a hook running, or a timer's
// callback — throws, which is what drives the op loop onto the clock
// (ruling C-defaults (a)).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { pathToFileURL } = require('url');

const { mountBridgeRoutes } = require('../lib/server/routes/bridge');
const { createBridge } = require('../lib/server/domain/bridge');
const { createHookTap } = require('../lib/server/hook-tap');
const { createAudience } = require('../lib/server/audience');
const { request } = require('../lib/client');
const P = require('../lib/core/mod-protocol');
const { fakeMod } = require('../test-support/fake-mod');
const { waitUntil } = require('../test-support/helpers');

const TPL = path.join(__dirname, '..', 'templates', 'claude-mod');
const REGISTER = path.join(TPL, 'hooks', 'register.js');
const SRC = fs.readFileSync(REGISTER, 'utf8');
const SID = '33333333-3333-4333-8333-333333333333';
const HOOKED = [
  'classic.PermissionRequest', 'prompt.submit', 'session.append', 'session.compact', 'session.end',
  'session.measure', 'session.start', 'tool.call', 'turn.complete', 'turn.start', 'turn.step',
];

let registerFn = null;
test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-mod-register-'));
  const file = path.join(dir, 'register.mjs');
  fs.writeFileSync(file, SRC);
  registerFn = (await import(pathToFileURL(file).href)).register;
  fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A project (a folder holding .web-chat/) and a home whose own .web-chat/ is
// the per-user folder, never a project.
function project(t) {
  const root = tmp(t, 'wc-mod-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'));
  const home = tmp(t, 'wc-mod-home-');
  fs.mkdirSync(path.join(home, '.web-chat'));
  return { root, home };
}

function writeServerJson(root, rec) {
  fs.writeFileSync(path.join(root, '.web-chat', 'server.json'), JSON.stringify(rec));
}

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

// A real bridge on a bare Express app, rooted at `root`.
async function bridgeHost(t, root) {
  const hooks = createHookTap();
  const published = [];
  const envs = []; // the same events, each with the session it was published as
  hooks.subscribe((e) => { if (e.event === P.MOD_EVENT) { published.push(e.mod); envs.push(e); } });
  const audience = createAudience({ configFile: null });
  const mirror = { subscribe: () => () => {}, conversationOf: () => null };
  const bridge = createBridge({ root, hooks, mirror });
  bridge.start();
  const app = express();
  app.use(express.json({ limit: '200mb' }));
  mountBridgeRoutes(app, { audience, hooks, mirror, bridge });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await bridge.stop();
    audience.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  return { port: server.address().port, bridge, published, envs, root };
}

// A daemon that hands out whatever ops the test queues — forged ops the real
// bridge would refuse before they ever reached a mod.
async function rawDaemon(t) {
  const queue = [];
  const results = [];
  const app = express();
  app.use(express.json());
  app.post('/api/bridge/hello', (req, res) => res.json({
    ok: true, token: 'f'.repeat(48), protocol: 1, wait_max_ms: 200, flush_ms: 100, permission_wait_ms: 0,
  }));
  app.get('/api/bridge/ops', (req, res) => {
    if (queue.length) return res.json({ ok: true, ops: queue.splice(0) });
    setTimeout(() => { if (!res.writableEnded) res.json({ ok: true, ops: queue.splice(0) }); }, 40);
    return undefined;
  });
  app.post('/api/bridge/result', (req, res) => { results.push(req.body); res.json({ ok: true }); });
  app.post('/api/bridge/events', (req, res) => res.json({ ok: true, accepted: req.body.events.length, dropped: 0 }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  return { port: server.address().port, queue, results };
}

// The fake Claude Code: hooks, dispatches and `$`. `sessionId` may be a
// function, read on every $.session.id() (a process Claude Code switches).
function fakeHost(t, {
  cwd, home, strict = false, delay = (ms) => Math.min(ms, 15), sessionId = SID, ccVersion = '2.1.296', handlers = {},
} = {}) {
  const sidNow = () => (typeof sessionId === 'function' ? sessionId() : sessionId);
  const hooks = new Map();
  let registering = true;
  const lateOn = [];
  const on = (event, a, b) => {
    const fn = typeof a === 'function' ? a : b;
    if (!registering) lateOn.push(event);
    hooks.set(event, fn);
    return { catch() { return this; } };
  };
  registerFn(on);
  registering = false;

  let depth = 0;
  let disposed = false;
  let inflight = 0;
  const calls = [];
  const requested = [];
  const live = new Set();

  function dispatch(fn) {
    depth += 1;
    let r;
    try { r = fn(); } catch (e) { depth -= 1; throw e; }
    if (r && typeof r.then === 'function') return Promise.resolve(r).finally(() => { depth -= 1; });
    depth -= 1;
    return r;
  }

  const g = (name, fn, { sync = false } = {}) => (...args) => {
    calls.push({ name, args });
    if (strict && depth === 0) {
      const err = new Error(`${name}: called outside a hook`);
      if (sync) throw err;
      return Promise.reject(err);
    }
    return fn(...args);
  };

  function timer(kind, ms, fn) {
    requested.push({ kind, ms });
    const h = { kind, ms, id: null };
    if (disposed) return { cancel() {} };
    const run = () => {
      if (kind === 'after') live.delete(h);
      try { const r = dispatch(fn); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch {}
    };
    h.id = kind === 'after' ? setTimeout(run, delay(ms)) : setInterval(run, Math.max(1, delay(ms)));
    live.add(h);
    return { cancel() { if (kind === 'after') clearTimeout(h.id); else clearInterval(h.id); live.delete(h); } };
  }

  const $ = {
    session: {
      id: g('session.id', async () => sidNow()),
      cwd: g('session.cwd', async () => cwd),
      version: g('session.version', async () => ({ version: ccVersion, base: ccVersion, builtAt: '2026-10-01T00:00:00Z' })),
      usage: g('session.usage', async () => ({
        startedAt: 1760000000000,
        context: { used: 1200, window: 200000, percent: 0.6, label: 'a secret label' },
        rateLimits: [{ name: 'five_hour', percentUsed: 3 }],
        cost: { usd: 0.42, note: 'words' },
      })),
      messages: g('session.messages', async () => [
        { role: 'user', text: 'a secret prompt', toolUses: [] },
        { role: 'assistant', text: 'a secret reply', toolUses: [] },
      ]),
    },
    env: { get: g('env.get', async (name) => (name === 'HOME' ? home : undefined)) },
    fs: {
      exists: g('fs.exists', async (p) => fs.existsSync(p)),
      read: g('fs.read', async (p) => fs.readFileSync(p, 'utf8')),
      stat: g('fs.stat', async (p, o) => {
        const s = fs.statSync(p);
        const out = { kind: s.isDirectory() ? 'dir' : 'file', size: s.size, mtimeMs: s.mtimeMs, isLink: false };
        if (o && o.resolve) out.realPath = fs.realpathSync(p);
        return out;
      }),
    },
    http: {
      fetch: g('http.fetch', async (url, init = {}) => {
        inflight += 1;
        try {
          const u = new URL(url);
          const r = await request(Number(u.port), init.method || 'GET', u.pathname + u.search,
            init.body !== undefined ? init.body : null, { headers: init.headers || {} });
          return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: {}, text: JSON.stringify(r.body) };
        } finally { inflight -= 1; }
      }),
    },
    clock: {
      now: g('clock.now', async () => Date.now()),
      sleep: g('clock.sleep', (ms) => new Promise((r) => setTimeout(r, delay(ms)))),
      after: g('clock.after', (ms, fn) => timer('after', ms, fn), { sync: true }),
      every: g('clock.every', (ms, fn) => timer('every', ms, fn), { sync: true }),
    },
    turn: { abort: g('turn.abort', async (a) => (handlers.abort ? handlers.abort(a) : undefined)) },
    tool: { call: g('tool.call', async (a) => (handlers.toolCall ? handlers.toolCall(a) : { result: {}, text: '' })) },
    prompt: {
      submit: g('prompt.submit', async (a) => (handlers.submit ? handlers.submit(a) : { text: a.text })),
      fill: g('prompt.fill', async () => ({ isFilled: true })),
    },
    command: { run: g('command.run', async (a) => (handlers.command ? handlers.command(a) : { text: '' })) },
  };

  let ended = false;
  const host = {
    $, hooks, lateOn, calls, requested,
    called: (name) => calls.filter((c) => c.name === name),
    fetches: (pathPart) => calls.filter((c) => c.name === 'http.fetch' && String(c.args[0]).includes(pathPart || '')),
    liveTimers: () => live.size,
    inflight: () => inflight,
    fire(event, e, next) {
      const fn = hooks.get(event);
      return dispatch(() => fn($, e, next || (async (x) => ({ echoed: x }))));
    },
    start() {
      return host.fire('session.start', { cwd, surface: 'terminal', isInteractive: true }, async (x) => ({ cwd: x.cwd }));
    },
    async end(reason = 'prompt_input_exit') {
      if (ended) return null;
      ended = true;
      const sid = sidNow();
      return host.fire('session.end', { reason, sessionId: sid, resume: {} }, async () => ({ sessionId: sid }));
    },
    async step(e, chunks, result) {
      const fn = hooks.get('turn.step');
      const next = () => (async function* gen() { for (const c of chunks) yield c; return result; })();
      depth += 1;
      const out = [];
      let r;
      try {
        const gen = fn($, e, next);
        for (;;) {
          const { value, done } = await gen.next();
          if (done) { r = value; break; }
          out.push(value);
        }
      } finally { depth -= 1; }
      return { chunks: out, result: r };
    },
    dispose() {
      disposed = true;
      for (const h of live) { clearTimeout(h.id); clearInterval(h.id); }
      live.clear();
    },
  };
  t.after(async () => {
    try { await host.end(); } catch {}
    await waitUntil(() => inflight === 0, { timeout: 3000 });
    host.dispose();
  });
  return host;
}

const attachedTo = (b, sid = SID) => b.bridge.status().sessions.find((s) => s.session_id === sid);

async function attachedHost(t, opts = {}) {
  const { root, home } = project(t);
  const b = await bridgeHost(t, root);
  if (opts.permissionWaitMs) b.bridge.setPermissionWait(opts.permissionWaitMs);
  writeServerJson(root, { pid: process.pid, port: b.port, root });
  const host = fakeHost(t, { cwd: root, home, ...opts });
  await host.start();
  await waitUntil(() => attachedTo(b), { timeout: 5000, what: 'the mod\'s hello' });
  return { root, home, b, host };
}

// ── the package's files ─────────────────────────────────────────────────────

test('plugin.json names web-chat-mod, with no version (mod on stamps it) and no capabilities field', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(TPL, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'web-chat-mod');
  assert.match(manifest.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case');
  assert.equal(manifest.version, undefined);
  assert.equal(manifest.capabilities, undefined, '2.1.296: capabilities is no longer read');
  assert.equal(typeof manifest.description, 'string');
  assert.deepEqual(manifest.author, { name: 'web-chat' });
});

test('hooks/hooks.json names the one module, exactly as 2.1.296 scaffolds it', () => {
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(TPL, 'hooks', 'hooks.json'), 'utf8')), { modules: ['./register.js'] });
  assert.deepEqual(fs.readdirSync(path.join(TPL, 'hooks')).sort(), ['hooks.json', 'register.js']);
  assert.deepEqual(fs.readdirSync(TPL).sort(), ['.claude-plugin', 'hooks'], 'no MCP server, skill or command in the plugin');
});

test('register.js is one self-contained module: no import or require, no process., no messaging token, one version line', () => {
  assert.doesNotMatch(SRC, /^\s*import\s/m);
  assert.doesNotMatch(SRC, /\bimport\s*\(/);
  assert.doesNotMatch(SRC, /\brequire\s*\(/);
  assert.doesNotMatch(SRC, /\bprocess\./);
  assert.doesNotMatch(SRC, /CLAUDE_CODE_MESSAGING_TOKEN/);
  assert.equal(SRC.split("const MOD_VERSION = '0.0.0-template';").length, 2, 'exactly one MOD_VERSION placeholder');
  assert.equal((SRC.match(/^export /gm) || []).length, 1);
  assert.match(SRC, /^export function register\(on\) \{/m);
});

test('register.js\'s WIRE literal is lib/core/mod-protocol\'s wire', () => {
  const m = /const WIRE = Object\.freeze\((\{[\s\S]*?\n\})\);/.exec(SRC);
  assert.ok(m, 'a WIRE literal');
  const wire = JSON.parse(m[1]);
  for (const k of ['MOD_PROTOCOL', 'MOD_MIN_CLAUDE', 'OPS', 'MOD_COMMANDS', 'EVENT_KINDS', 'BRIDGE_ONLY_KINDS', 'BATCH_MAX', 'DELTA_MAX', 'TEXT_MAX', 'INPUT_MAX', 'RENAME_MAX', 'COMMAND_ARGS_MAX']) {
    assert.ok(Object.hasOwn(wire, k), `WIRE carries ${k}`);
  }
  for (const [k, v] of Object.entries(wire)) assert.deepEqual(v, P[k], `WIRE.${k} equals mod-protocol's`);
});

test('register(on) hooks exactly the events the wire needs, and registers nothing after it returns', async (t) => {
  const { home } = project(t);
  const elsewhere = tmp(t, 'wc-mod-none-');
  const host = fakeHost(t, { cwd: elsewhere, home });
  assert.deepEqual([...host.hooks.keys()].sort(), HOOKED);
  await host.start();
  await host.fire('turn.start', { turnId: 't1', text: '' });
  await host.fire('tool.call', { tool: 'Read', tool_use_id: 'tu_1', file_path: 'a' });
  await host.fire('turn.complete', { turnId: 't1', answer: 'ok', reason: 'answer', durationMs: 1, isAborted: false });
  await host.end();
  assert.deepEqual(host.lateOn, []);
});

// ── the gate ────────────────────────────────────────────────────────────────

test('with no .web-chat above the session (only $HOME\'s, which is not a project) a whole session makes no network call', async (t) => {
  const { home } = project(t);
  const cwd = path.join(home, 'code', 'app');
  fs.mkdirSync(cwd, { recursive: true });
  const host = fakeHost(t, { cwd, home });
  await host.start();
  await waitUntil(() => host.called('fs.exists').some((c) => c.args[0] === '/.web-chat'), { timeout: 3000, what: 'the walk to /' });
  for (let i = 0; i < 3; i++) {
    await host.fire('prompt.submit', { text: 'hi', origin: { kind: 'composer' } });
    await host.fire('tool.call', { tool: 'Bash', tool_use_id: `tu_${i}`, command: 'ls' });
  }
  await new Promise((r) => setTimeout(r, 150));
  await host.end();
  assert.deepEqual(host.fetches(), []);
  assert.ok(!host.called('fs.exists').some((c) => c.args[0] === `${home}/.web-chat`), '$HOME\'s .web-chat is never taken for a project');
});

for (const [what, marker] of [
  ['the project is switched off', (root) => path.join(root, '.web-chat', 'disabled')],
  ['the user switched web-chat off', (root, home) => path.join(home, '.web-chat', 'disabled')],
  ['this session is switched off', (root, home) => path.join(home, '.web-chat', 'sessions', `${SID}.json`)],
]) {
  test(`with a disabled marker (${what}) the mod idles, re-checks every 30 s and makes no network call`, async (t) => {
    const { root, home } = project(t);
    const b = await bridgeHost(t, root);
    writeServerJson(root, { pid: process.pid, port: b.port, root });
    const file = marker(root, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}');
    const host = fakeHost(t, { cwd: root, home, delay: (ms) => (ms >= 30000 ? 60000 : Math.min(ms, 15)) });
    await host.start();
    await waitUntil(() => host.requested.some((r) => r.kind === 'after' && r.ms === 30000), { timeout: 3000, what: 'the 30 s re-check' });
    await host.fire('prompt.submit', { text: 'hi', origin: { kind: 'composer' } });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(host.fetches(), []);
    assert.equal(b.bridge.status().sessions.length, 0);
  });
}

test('a server.json naming another project\'s root, or no root, is no daemon of this project: no hello until one names its own', async (t) => {
  const { root, home } = project(t);
  const other = tmp(t, 'wc-mod-other-');
  const b = await bridgeHost(t, root);
  writeServerJson(root, { pid: process.pid, port: b.port, root: other });
  const host = fakeHost(t, { cwd: root, home });
  await host.start();
  await waitUntil(() => host.called('fs.read').length >= 3, { timeout: 3000, what: 'server.json read again' });
  assert.deepEqual(host.fetches(), [], 'a copied record: never asked');
  writeServerJson(root, { pid: process.pid, port: b.port });
  const reads = host.called('fs.read').length;
  await waitUntil(() => host.called('fs.read').length >= reads + 3, { timeout: 5000, what: 'server.json read again' });
  assert.deepEqual(host.fetches(), [], 'no root: never asked');
  assert.ok(host.requested.some((r) => r.kind === 'after' && r.ms >= 1000), 'it backs off');
  writeServerJson(root, { pid: process.pid, port: b.port, root });
  await waitUntil(() => attachedTo(b), { timeout: 70000, what: 'the hello once server.json names this root' });
  assert.equal(host.fetches('/api/bridge/hello').length, 1);
});

test('a hello answered 409 wrong-project is handled like a network failure: back off, read server.json again, attach later', async (t) => {
  const { root, home } = project(t);
  const elsewhere = tmp(t, 'wc-mod-elsewhere-');
  const wrong = await bridgeHost(t, elsewhere);
  const right = await bridgeHost(t, root);
  writeServerJson(root, { pid: process.pid, port: wrong.port, root }); // a portfile that claims this root
  const host = fakeHost(t, { cwd: root, home });
  await host.start();
  await waitUntil(() => host.fetches('/api/bridge/hello').length >= 2, { timeout: 5000, what: 'a second hello' });
  assert.equal(wrong.bridge.status().sessions.length, 0);
  assert.ok(host.requested.some((r) => r.kind === 'after' && r.ms >= 1000), 'backed off between them');
  writeServerJson(root, { pid: process.pid, port: right.port, root });
  await waitUntil(() => attachedTo(right), { timeout: 70000, what: 'the hello to this project\'s daemon' });
});

test('a daemon that is down: back off 1 s, 2 s, … up to 60 s, reading server.json each time, then attach to the new port', async (t) => {
  const { root, home } = project(t);
  const dead = await freePort();
  writeServerJson(root, { pid: process.pid, port: dead, root });
  const host = fakeHost(t, { cwd: root, home, delay: () => 2 });
  await host.start();
  const backoffs = () => host.requested.filter((r) => r.kind === 'after' && r.ms >= 1000 && r.ms !== 3000).map((r) => r.ms);
  await waitUntil(() => backoffs().filter((ms) => ms === 60000).length >= 2, { timeout: 10000, what: 'the 60 s ceiling, twice' });
  assert.deepEqual(backoffs().slice(0, 8), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  const serverReads = host.called('fs.read').filter((c) => c.args[0].endsWith('server.json')).length;
  assert.ok(serverReads >= 8, `server.json read before every try (${serverReads})`);
  const b = await bridgeHost(t, root);
  writeServerJson(root, { pid: process.pid, port: b.port, root });
  await waitUntil(() => attachedTo(b), { timeout: 5000, what: 'the hello on the new port' });
});

// ── the hello and the op loop, against a real bridge ────────────────────────

test('it says hello within one flush, as this session, with the template\'s version and its project root', async (t) => {
  const t0 = Date.now();
  const { b, root } = await attachedHost(t);
  assert.ok(Date.now() - t0 < 2000);
  const s = attachedTo(b);
  assert.equal(s.cc_version, '2.1.296');
  assert.equal(s.mod_version, '0.0.0-template');
  const log = fs.readFileSync(path.join(root, '.web-chat', 'mod', 'bridge.log'), 'utf8');
  assert.match(log, /"what":"hello"/);
});

test('abort: $.turn.abort on the open turn, then TaskStop for a foreground Bash it left running backgrounded', async (t) => {
  let release = null;
  let releaseBg = null;
  let releaseRead = null;
  const aborted = [];
  const stops = [];
  const { b, host } = await attachedHost(t, {
    handlers: {
      abort: async (a) => {
        aborted.push(a);
        // Claude Code backgrounds the running foreground Bash.
        release({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bash_7' }, text: 'moved to the background' });
        // Calls that are not a foreground Bash settle too, even carrying a
        // task id: never the abort's to stop (a background task is the user's).
        releaseBg({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bash_bg' }, text: 'running in the background' });
        releaseRead({ result: { backgroundTaskId: 'read_1' }, text: '' });
      },
      toolCall: async (a) => { stops.push(a); return { result: { message: 'stopped' }, text: 'stopped' }; },
    },
  });
  await host.fire('turn.start', { turnId: 'turn_1', text: 'go' });
  const bash = host.fire('tool.call', { tool: 'Bash', tool_use_id: 'tu_bash', command: 'sleep 30' },
    () => new Promise((r) => { release = r; }));
  const bg = host.fire('tool.call', { tool: 'Bash', tool_use_id: 'tu_bg', command: 'npm run dev', run_in_background: true },
    () => new Promise((r) => { releaseBg = r; }));
  const read = host.fire('tool.call', { tool: 'Read', tool_use_id: 'tu_read', file_path: '/x' },
    () => new Promise((r) => { releaseRead = r; }));
  const r = await b.bridge.enqueue(SID, { op: 'abort', args: {} });
  assert.deepEqual(r, { ok: true, result: { aborted: true, stopped: ['bash_7'] } });
  assert.deepEqual(aborted, [{ turnId: 'turn_1' }]);
  assert.deepEqual(stops, [{ tool: 'TaskStop', task_id: 'bash_7' }], 'only the foreground Bash the abort backgrounded');
  await Promise.all([bg, read]);
  const done = await bash;
  assert.equal(done.result.backgroundTaskId, 'bash_7', 'the tool call\'s own result is untouched');
});

test('abort with no turn running is refused no-turn; taskStop runs TaskStop', async (t) => {
  const stops = [];
  const { b, host } = await attachedHost(t, { handlers: { toolCall: async (a) => { stops.push(a); return { result: {}, text: 'ok' }; } } });
  const r = await b.bridge.enqueue(SID, { op: 'abort', args: {} });
  assert.equal(r.ok, false);
  assert.equal(r.refused, 'no-turn');
  assert.equal(host.called('turn.abort').length, 0);
  const s = await b.bridge.enqueue(SID, { op: 'taskStop', args: { task_id: 'bg_9' } });
  assert.deepEqual(s, { ok: true, result: { stopped: true } });
  assert.deepEqual(stops, [{ tool: 'TaskStop', task_id: 'bg_9' }]);
});

test('submit, command, fill, usage and messages run through $ — numbers and counts only, never content', async (t) => {
  const { b, host } = await attachedHost(t);
  assert.deepEqual(await b.bridge.enqueue(SID, { op: 'submit', args: { text: 'hello from the browser' } }), { ok: true, result: { submitted: true } });
  assert.deepEqual(host.called('prompt.submit').map((c) => c.args[0]), [{ text: 'hello from the browser', asUser: true }]);

  assert.deepEqual(await b.bridge.enqueue(SID, { op: 'command', args: { name: 'plan' } }), { ok: true, result: { ran: true } });
  assert.deepEqual(host.called('command.run').map((c) => c.args[0]), [{ command: 'plan' }]);
  await b.bridge.enqueue(SID, { op: 'command', args: { name: 'rename', args: 'my fork' } });
  assert.deepEqual(host.called('command.run')[1].args[0], { command: 'rename', args: 'my fork' });

  assert.deepEqual(await b.bridge.enqueue(SID, { op: 'fill', args: { text: 'draft' } }), { ok: true, result: { filled: true } });
  assert.deepEqual(host.called('prompt.fill').map((c) => c.args[0]), [{ text: 'draft', mode: 'replace' }]);

  const u = await b.bridge.enqueue(SID, { op: 'usage', args: {} });
  assert.equal(u.ok, true);
  assert.deepEqual(u.result, { startedAt: 1760000000000, context: { used: 1200, window: 200000, percent: 0.6 }, rateLimits: [{ percentUsed: 3 }], cost: { usd: 0.42 } });
  const m = await b.bridge.enqueue(SID, { op: 'messages', args: {} });
  assert.deepEqual(m, { ok: true, result: { count: 2 } });
  assert.doesNotMatch(JSON.stringify([u, m]), /secret|words/);
});

// U126: Claude Code 2.1.29x RESOLVES a submit it did not take
// ({ended: 'Prompt not submitted: …'} / {ended: 'Prompt dropped by a hook: …'});
// m-71c5c175 read as submitted and stayed 'sent'. Such an answer is a refusal.
test('a submit Claude Code did not take ({ended: …}, {drop: …}) answers refused not-submitted with its reason; a plain resolve is submitted', async (t) => {
  const answers = [
    { ended: 'Prompt not submitted: a dialog is open' },
    { ended: 'Prompt dropped by a hook: x' },
    { ended: { resultText: 'Prompt dropped by a hook: y' } },
    { drop: 'the prompt did not go through prompt.submit' },
  ];
  let i = 0;
  const { b, host } = await attachedHost(t, { handlers: { submit: async () => answers[i++] || { text: 'ran' } } });
  const out = [];
  for (let n = 0; n <= 4; n++) out.push(await b.bridge.enqueue(SID, { op: 'submit', args: { text: `message ${n}` } }));
  assert.deepEqual(out.slice(0, 4), [
    { ok: false, refused: 'not-submitted', error: 'Prompt not submitted: a dialog is open', delivered: true },
    { ok: false, refused: 'not-submitted', error: 'Prompt dropped by a hook: x', delivered: true },
    { ok: false, refused: 'not-submitted', error: 'Prompt dropped by a hook: y', delivered: true },
    { ok: false, refused: 'not-submitted', error: 'the prompt did not go through prompt.submit', delivered: true },
  ]);
  assert.deepEqual(out[4], { ok: true, result: { submitted: true } }, 'a normal resolve is still submitted');
  assert.equal(host.called('prompt.submit').length, 5);
  // The reason is cut to the wire's ERROR_MAX.
  i = 0;
  answers.splice(0, answers.length, { ended: `Prompt not submitted: ${'z'.repeat(400)}` });
  const long = await b.bridge.enqueue(SID, { op: 'submit', args: { text: 'long' } });
  assert.equal(long.refused, 'not-submitted');
  assert.equal(long.error.length, P.ERROR_MAX);
});

test('forged ops (past the daemon) are refused by the mod itself: a /command as a submit, a config-persisting command, an expired op', async (t) => {
  const { root, home } = project(t);
  const d = await rawDaemon(t);
  writeServerJson(root, { pid: process.pid, port: d.port, root });
  const host = fakeHost(t, { cwd: root, home });
  await host.start();
  d.queue.push(
    { id: 'op_a1', op: 'submit', args: { text: '/model x' }, expires_at: Date.now() + 60000 },
    { id: 'op_a2', op: 'command', args: { name: 'model', args: 'x' }, expires_at: Date.now() + 60000 },
    { id: 'op_a3', op: 'command', args: { name: 'config' }, expires_at: Date.now() + 60000 },
    { id: 'op_a4', op: 'usage', args: {}, expires_at: Date.now() - 1000 },
    { id: 'op_a5', op: 'eval', args: {}, expires_at: Date.now() + 60000 },
  );
  await waitUntil(() => d.results.length >= 5, { timeout: 5000, what: 'five results' });
  const by = Object.fromEntries(d.results.map((r) => [r.id, r]));
  assert.equal(by.op_a1.ok, false);
  assert.equal(by.op_a1.refused, 'not-allowed');
  assert.equal(by.op_a2.refused, 'not-allowed');
  assert.equal(by.op_a3.refused, 'not-allowed');
  assert.equal(by.op_a4.refused, 'expired');
  assert.equal(by.op_a5.refused, 'not-allowed');
  assert.equal(host.called('prompt.submit').length, 0);
  assert.equal(host.called('command.run').length, 0);
  assert.equal(host.called('session.usage').length, 0);
});

test('the mod takes the /plan and /compact lines the protocol takes (up to COMMAND_ARGS_MAX); rename keeps RENAME_MAX', async (t) => {
  assert.equal(P.COMMAND_ARGS_MAX, 2000);
  assert.equal(P.RENAME_MAX, 64);
  const { root, home } = project(t);
  const d = await rawDaemon(t);
  writeServerJson(root, { pid: process.pid, port: d.port, root });
  const host = fakeHost(t, { cwd: root, home });
  await host.start();
  const op = (id, name, args) => ({ id, op: 'command', args: { name, args }, expires_at: Date.now() + 60000 });
  d.queue.push(
    op('op_c1', 'plan', 'x'.repeat(65)),
    op('op_c2', 'compact', 'y'.repeat(2000)),
    op('op_c3', 'plan', 'x'.repeat(2001)),
    op('op_c4', 'compact', 'two\nlines'),
    op('op_c5', 'rename', 'r'.repeat(64)),
    op('op_c6', 'rename', 'r'.repeat(65)),
  );
  await waitUntil(() => d.results.length >= 6, { timeout: 5000, what: 'six results' });
  const by = Object.fromEntries(d.results.map((r) => [r.id, r]));
  assert.equal(by.op_c1.ok, true, 'a 65-character /plan line runs');
  assert.equal(by.op_c2.ok, true, 'a 2000-character /compact line runs');
  assert.equal(by.op_c3.refused, 'bad-args', 'a 2001-character line is refused');
  assert.equal(by.op_c4.refused, 'bad-args', 'a newline is still refused');
  assert.equal(by.op_c5.ok, true, 'a 64-character name runs');
  assert.equal(by.op_c6.refused, 'bad-args', 'rename keeps its 64');
  assert.deepEqual(host.called('command.run').map((c) => [c.args[0].command, c.args[0].args.length]),
    [['plan', 65], ['compact', 2000], ['rename', 64]]);
});

// ── the hooks never alter what they see ─────────────────────────────────────

test('tool.call passes e on and returns next(e)\'s very value; a throw while forwarding changes neither', async (t) => {
  const { b, host } = await attachedHost(t);
  const e = Object.freeze({ tool: 'Read', tool_use_id: 'tu_r1', file_path: '/x' });
  const R = Object.freeze({ result: { file: {} }, text: 'contents', ref: 3 });
  let seen = null;
  const r = await host.fire('tool.call', e, async (x) => { seen = x; return R; });
  assert.equal(r, R);
  assert.equal(seen, e);

  const hostile = new Proxy({ tool: 'Bash', tool_use_id: 'tu_r2', command: 'ls' }, { ownKeys() { throw new Error('boom'); } });
  let seen2 = null;
  const r2 = await host.fire('tool.call', hostile, async (x) => { seen2 = x; return R; });
  assert.equal(r2, R);
  assert.equal(seen2, hostile);

  await waitUntil(() => b.published.some((m) => m.kind === 'tool.done' && m.tool_use_id === 'tu_r1'), { timeout: 3000, what: 'tool.done' });
  const call = b.published.find((m) => m.kind === 'tool.call' && m.tool_use_id === 'tu_r1');
  assert.ok(call, 'tool.call forwarded');
  const doneEv = b.published.find((m) => m.kind === 'tool.done' && m.tool_use_id === 'tu_r1');
  assert.equal(doneEv.ok, true);
});

test('turn.step yields every chunk of next() unchanged and in order, and the forwarded deltas join to the text', async (t) => {
  const { b, host } = await attachedHost(t);
  // A chunk whose fields throw when read (not `then`: an async generator awaits
  // what it yields, so a real chunk is plain data).
  const hostile = new Proxy({}, { get(o, k) { if (k === 'then') return undefined; throw new Error('a chunk that throws when read'); } });
  const chunks = [
    { kind: 'engine', ref: 1 },
    { kind: 'text', index: 0, text: 'Hel' },
    { kind: 'thinking', index: 1, text: 'hmm' },
    hostile,
    { kind: 'text', index: 0, text: 'lo, ' },
    { kind: 'text', index: 0, text: 'world' },
    { kind: 'stop', stopReason: 'end_turn', usage: null },
  ];
  const result = { turnId: 'turn_s', index: 0, answer: 'Hello, world', toolUses: [], stopReason: 'end_turn', usage: null };
  await host.fire('turn.start', { turnId: 'turn_s', text: '' });
  const out = await host.step({ turnId: 'turn_s', index: 0, model: 'm', messageCount: 1 }, chunks, result);
  assert.equal(out.chunks.length, chunks.length);
  out.chunks.forEach((c, i) => assert.equal(c, chunks[i], `chunk ${i} is the same object`));
  assert.equal(out.result, result);
  await waitUntil(() => b.published.filter((m) => m.kind === 'turn.step').map((m) => m.delta).join('') === 'Hello, world',
    { timeout: 3000, what: 'the deltas' });
});

test('an event goes to the bridge within one flush (100 ms)', async (t) => {
  const { b, host } = await attachedHost(t);
  const n = host.requested.length;
  await host.fire('prompt.submit', { text: 'a secret prompt', origin: { kind: 'composer' } });
  assert.ok(host.requested.slice(n).some((r) => r.kind === 'after' && r.ms === P.FLUSH_MS), 'a flush asked for 100 ms on');
  await waitUntil(() => b.published.some((m) => m.kind === 'prompt.submit'), { timeout: 2000, what: 'the event' });
  const ev = b.published.find((m) => m.kind === 'prompt.submit');
  assert.deepEqual(ev.origin, { kind: 'composer' });
  assert.doesNotMatch(JSON.stringify(b.published), /a secret prompt/, 'the prompt\'s origin, never its text');
});

test('a batch goes at once at 50 events; at most 200 wait while the bridge is away', async (t) => {
  const { root, home } = project(t);
  const b = await bridgeHost(t, root);
  // The flush timer (100 ms) is held back here, so what arrives arrived without it.
  const host = fakeHost(t, { cwd: root, home, delay: (ms) => (ms === P.FLUSH_MS ? 600000 : Math.min(ms, 15)) });
  await host.start();
  for (let i = 0; i < 300; i++) await host.fire('prompt.submit', { text: 'x', origin: { kind: 'composer' } });
  writeServerJson(root, { pid: process.pid, port: b.port, root });
  await waitUntil(() => attachedTo(b), { timeout: 70000, what: 'the hello' });
  await waitUntil(() => attachedTo(b).counters.events_accepted >= 150, { timeout: 3000, what: 'the backlog, on attaching' });
  await new Promise((r) => setTimeout(r, 100));
  const c = attachedTo(b).counters;
  assert.equal(c.events_accepted + c.events_dropped, 200, 'the 200 newest waited; the rest were dropped and counted');

  const before = attachedTo(b).counters.events_accepted;
  for (let i = 0; i < 49; i++) await host.fire('prompt.submit', { text: 'y', origin: { kind: 'composer' } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(attachedTo(b).counters.events_accepted, before, '49 wait for the (held) timer');
  await host.fire('prompt.submit', { text: 'y', origin: { kind: 'composer' } });
  await waitUntil(() => attachedTo(b).counters.events_accepted === before + 50, { timeout: 3000, what: 'the batch at 50' });

  // The first turn.complete queues the diag (turn.complete + diag = 2 events);
  // 48 more fill the next batch of 50, so it goes without the held timer. The
  // diag counts what the mod dropped: 301 events waited (session.start, then
  // the 300 prompts) and the 101 oldest of them went.
  await host.fire('turn.complete', { turnId: 't_b', answer: 'ok', reason: 'answer', durationMs: 1, isAborted: false });
  for (let i = 0; i < 48; i++) await host.fire('prompt.submit', { text: 'z', origin: { kind: 'composer' } });
  await waitUntil(() => attachedTo(b).shapes.driver, { timeout: 3000, what: 'the diag' });
  assert.deepEqual(attachedTo(b).shapes.dropped, ['101'], 'the diag says how many events the mod dropped');
  assert.deepEqual(attachedTo(b).shapes.failed, ['0']);
});

test('the diag counts what the mod failed to handle: a handler that threw', async (t) => {
  const { b, host } = await attachedHost(t);
  // A turn.complete whose turnId throws on read: the handler's catch counts it.
  const bad = { answer: 'ok', reason: 'answer', get turnId() { throw new Error('unreadable'); } };
  await host.fire('turn.complete', bad);
  assert.equal(attachedTo(b).shapes.driver, undefined, 'a handler that threw sends no diag');
  await host.fire('turn.complete', { turnId: 't_f', answer: 'ok', reason: 'answer', durationMs: 1, isAborted: false });
  await waitUntil(() => attachedTo(b).shapes.driver, { timeout: 5000, what: 'the diag' });
  assert.deepEqual(attachedTo(b).shapes.failed, ['1'], 'the diag says how many the mod failed to handle');
  assert.deepEqual(attachedTo(b).shapes.dropped, ['0']);
});

test('a 401 (the token superseded) makes the mod say hello again', async (t) => {
  const { b, host } = await attachedHost(t);
  const other = fakeMod({ port: b.port, sessionId: SID, root: b.root });
  await other.hello();
  assert.equal(attachedTo(b).mod_version, '0.8.5-test');
  await waitUntil(() => attachedTo(b) && attachedTo(b).mod_version === '0.0.0-template', { timeout: 5000, what: 'the second hello' });
  assert.ok(host.fetches('/api/bridge/hello').length >= 2);
});

test('session.end ends the loop and the session at the bridge, with no timer left', async (t) => {
  const { b, host } = await attachedHost(t);
  await host.fire('turn.start', { turnId: 'turn_e', text: '' });
  const r = await host.end('prompt_input_exit');
  assert.deepEqual(r, { sessionId: SID });
  await waitUntil(() => !attachedTo(b), { timeout: 3000, what: 'the detach' });
  await waitUntil(() => host.inflight() === 0 && host.liveTimers() === 0, { timeout: 5000, what: 'no fetch and no timer' });
  const n = host.calls.length;
  await new Promise((r2) => setTimeout(r2, 100));
  assert.equal(host.calls.length, n, 'nothing after the end');
});

test('session.end for a /clear keeps the mod running: it reads the session id again and says hello as that session', async (t) => {
  const { b, host } = await attachedHost(t);
  const ids = host.called('session.id').length;
  const hellos = host.fetches('/api/bridge/hello').length;
  const r = await host.fire('session.end', { reason: 'clear', sessionId: SID, resume: {} }, async () => ({ sessionId: SID }));
  assert.deepEqual(r, { sessionId: SID });
  await waitUntil(() => host.fetches('/api/bridge/hello').length > hellos && attachedTo(b), { timeout: 5000, what: 'the hello after the clear' });
  assert.ok(host.called('session.id').length > ids, 'the session id is read again, not kept from before the clear');
});

// ── a session Claude Code switches the process to (U127) ────────────────────
//
// After /resume, /clear or plan mode's clear-context, Claude Code 2.1.300
// fires session.end {reason} and moves the process to the next session id
// only once its own work is done: $.session.id() answers the ENDED id for a
// while. The mod must say hello as the conversation the terminal is in.

const NEW_SID = '44444444-4444-4444-8444-444444444444';

// A session id Claude Code switches: switchTo(id, lag) makes the next `lag`
// reads still answer the old id.
function switchingId(first = SID) {
  const s = { id: first, old: null, lag: 0 };
  s.read = () => { if (s.lag > 0) { s.lag -= 1; return s.old; } return s.id; };
  s.switchTo = (id, lag) => { s.old = s.id; s.id = id; s.lag = lag; };
  return s;
}

const helloSids = (host) => host.fetches('/api/bridge/hello').map((c) => JSON.parse(c.args[1].body).session_id);
const logLines = (root) => fs.readFileSync(path.join(root, '.web-chat', 'mod', 'bridge.log'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

for (const reason of ['resume', 'clear']) {
  test(`after a '${reason}' end with a lagging $.session.id(), the hello carries the new id, never the ended one, and what waited goes after it`, async (t) => {
    const ids = switchingId();
    const { b, host, root } = await attachedHost(t, { sessionId: ids.read });
    const before = helloSids(host).length;
    ids.switchTo(NEW_SID, 6); // six reads after the end still answer the ended id
    const r = await host.fire('session.end', { reason, sessionId: SID, resume: {} }, async () => ({ sessionId: SID }));
    assert.deepEqual(r, { sessionId: SID });
    // The first prompt of the conversation the terminal is now in, while the
    // mod waits for the switch.
    await host.fire('turn.start', { turnId: 'turn_after', text: '' });
    await waitUntil(() => attachedTo(b, NEW_SID), { timeout: 5000, what: 'the hello as the new session' });
    await waitUntil(() => !attachedTo(b, SID), { timeout: 3000, what: 'the ended session detached' });
    assert.deepEqual(helloSids(host).slice(before), [NEW_SID], 'one hello after the end, as the new session');
    assert.ok(ids.lag === 0, 'the lagging reads were all spent before the hello');
    const hellos = logLines(root).filter((l) => l.what === 'hello').map((l) => l.session_id);
    assert.deepEqual(hellos, [SID, NEW_SID], 'bridge.log: never a hello as the ended session after its end');
    await waitUntil(() => b.envs.some((e) => e.mod.kind === 'turn.start' && e.mod.turn_id === 'turn_after'), { timeout: 3000, what: 'the waiting turn.start' });
    const ev = b.envs.find((e) => e.mod.kind === 'turn.start' && e.mod.turn_id === 'turn_after');
    assert.equal(ev.session_id, NEW_SID, 'what was pushed during the wait went out as the new session');
  });
}

test('a resume that keeps its id (the same conversation) still says hello, with that id, by the bound', async (t) => {
  const { b, host, root } = await attachedHost(t);
  const before = helloSids(host).length;
  const reads = host.called('session.id').length;
  await host.fire('session.end', { reason: 'resume', sessionId: SID, resume: {} }, async () => ({ sessionId: SID }));
  await waitUntil(() => helloSids(host).length > before && attachedTo(b), { timeout: 5000, what: 'the hello at the bound' });
  assert.deepEqual(helloSids(host).slice(before), [SID]);
  // SWITCH_WAIT_MS / SWITCH_POLL_MS reads (this fake's clock runs fast): the
  // mod waited the bound out before taking the unchanged id.
  assert.ok(host.called('session.id').length - reads >= 30, 'the id was read again until the bound');
  assert.deepEqual(logLines(root).map((l) => l.what).filter((w) => w === 'hello' || w === 'detach'), ['hello', 'detach', 'hello']);
});

test('a turn.start whose $.session.id() changed with no end: the old session is ended at the bridge, then hello as the new one, without holding up the turn', async (t) => {
  const ids = switchingId();
  const { b, host, root } = await attachedHost(t, { sessionId: ids.read });
  ids.switchTo(NEW_SID, 0);
  const reads = host.called('session.id').length;
  const e = { turnId: 'turn_switched', text: '' };
  const r = host.fire('turn.start', e);
  assert.equal(host.called('session.id').length, reads, 'turn.start returned without reading the id');
  assert.deepEqual(await r, { echoed: e }, 'turn.start returns next(e)\'s value');
  await waitUntil(() => attachedTo(b, NEW_SID) && !attachedTo(b, SID), { timeout: 3000, what: 'the heal' });
  const lines = logLines(root).filter((l) => l.what === 'hello' || l.what === 'detach');
  assert.deepEqual(lines.map((l) => [l.what, l.session_id, l.reason]), [
    ['hello', SID, undefined], ['detach', SID, 'session-end'], ['hello', NEW_SID, undefined],
  ], 'the old id detached by its session.end, before the new hello');
  await waitUntil(() => b.envs.some((x) => x.mod.kind === 'turn.start' && x.mod.turn_id === 'turn_switched'), { timeout: 3000, what: 'the turn\'s event' });
  const evs = b.envs.filter((x) => x.mod.turn_id === 'turn_switched');
  assert.ok(evs.every((x) => x.session_id === NEW_SID), 'no event of the turn went out as the old session');
});

test('a turn.start with an unchanged id does nothing extra: one read, no hello, no detach', async (t) => {
  const { b, host, root } = await attachedHost(t);
  const reads = host.called('session.id').length;
  const hellos = helloSids(host).length;
  await host.fire('turn.start', { turnId: 'turn_same', text: '' });
  await waitUntil(() => b.envs.some((x) => x.mod.turn_id === 'turn_same'), { timeout: 3000, what: 'the turn.start' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(host.called('session.id').length - reads, 1, 'the id read once, where the events left');
  assert.equal(helloSids(host).length, hellos);
  assert.ok(attachedTo(b));
  assert.ok(!logLines(root).some((l) => l.what === 'detach'));
  // A subagent's turn.start is not the main thread's: no read at all.
  await host.fire('turn.start', { turnId: 'turn_sub', agentId: 'agent_1', text: '' });
  await waitUntil(() => b.envs.some((x) => x.mod.turn_id === 'turn_sub'), { timeout: 3000, what: 'the subagent turn.start' });
  assert.equal(host.called('session.id').length - reads, 1);
});

test('after a switch the session-scope disable check reads the NEW id', async (t) => {
  const ids = switchingId();
  const { b, host, home } = await attachedHost(t, { sessionId: ids.read });
  fs.mkdirSync(path.join(home, '.web-chat', 'sessions'), { recursive: true });
  const newMarker = path.join(home, '.web-chat', 'sessions', `${NEW_SID}.json`);
  const oldMarker = path.join(home, '.web-chat', 'sessions', `${SID}.json`);
  fs.writeFileSync(newMarker, '{}');
  const checked = () => host.called('fs.exists').map((c) => c.args[0]);
  const n = checked().length;
  ids.switchTo(NEW_SID, 3);
  await host.fire('session.end', { reason: 'resume', sessionId: SID, resume: {} }, async () => ({ sessionId: SID }));
  await waitUntil(() => checked().slice(n).includes(newMarker), { timeout: 5000, what: 'the new session\'s marker checked' });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!checked().slice(n).includes(oldMarker), 'the ended session\'s marker is not what it reads');
  assert.ok(!attachedTo(b, NEW_SID) && !attachedTo(b, SID), 'the new session is disabled: no hello');
});

test('a second clear/resume end inside the wait leaves no session.end behind to detach the new session after its hello', async (t) => {
  const ids = switchingId();
  const { b, host, root } = await attachedHost(t, { sessionId: ids.read });
  ids.switchTo(NEW_SID, 6);
  await host.fire('session.end', { reason: 'resume', sessionId: SID, resume: {} }, async () => ({ sessionId: SID }));
  // No token now: this end's session.end cannot leave, and must not wait for
  // the next hello either.
  await host.fire('session.end', { reason: 'clear', sessionId: SID, resume: {} }, async () => ({ sessionId: SID }));
  await waitUntil(() => attachedTo(b, NEW_SID), { timeout: 5000, what: 'the hello as the new session' });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(attachedTo(b, NEW_SID), 'the new session stays attached');
  assert.deepEqual(logLines(root).filter((l) => l.what === 'detach').map((l) => l.session_id), [SID]);
});

// ── PermissionRequest: the transport (U92 builds its meaning) ───────────────

test('classic.PermissionRequest with permission_wait_ms 0 returns next(e) at once and forwards nothing', async (t) => {
  const { b, host } = await attachedHost(t);
  const R = { echoed: true };
  const e = { session_id: SID, tool_name: 'Bash', tool_input: { command: 'rm -rf x' }, hook_event_name: 'PermissionRequest' };
  let seen = null;
  const r = await host.fire('classic.PermissionRequest', e, async (x) => { seen = x; return R; });
  assert.equal(r, R);
  assert.equal(seen, e);
  await new Promise((r2) => setTimeout(r2, 150));
  assert.ok(!b.published.some((m) => m.kind === 'permission.request'));
});

test('classic.PermissionRequest with a wait: a decision answers the hook; {pass: true} or no answer in time leaves it to the terminal', async (t) => {
  const { b, host } = await attachedHost(t, { permissionWaitMs: 4000, delay: (ms) => (ms === 4000 ? 300 : Math.min(ms, 15)) });
  const e = { session_id: SID, tool_name: 'Bash', tool_input: { command: 'ls' }, hook_event_name: 'PermissionRequest' };
  const R = { terminal: true };
  const ask = async (decision) => {
    const before = b.published.filter((m) => m.kind === 'permission.request').length;
    const p = host.fire('classic.PermissionRequest', e, async () => R);
    if (decision === undefined) return p;
    await waitUntil(() => b.published.filter((m) => m.kind === 'permission.request').length > before, { timeout: 3000, what: 'permission.request' });
    const req = b.published.filter((m) => m.kind === 'permission.request')[before];
    assert.equal(req.tool, 'Bash');
    const answered = await b.bridge.enqueue(SID, { op: 'permissionDecision', args: { request_id: req.request_id, decision } });
    assert.equal(answered.ok, true);
    return p;
  };
  assert.deepEqual(await ask({ behavior: 'allow' }), { decision: { behavior: 'allow' } });
  assert.deepEqual(await ask({ behavior: 'deny', message: 'no' }), { decision: { behavior: 'deny', message: 'no' } });
  assert.equal(await ask({ pass: true }), R, 'the pass-through sentinel (D5 (a)): next(e) at once');
  assert.equal(await ask(undefined), R, 'no answer in time: next(e)');
  await waitUntil(() => b.published.filter((m) => m.kind === 'permission.settled').length >= 4, { timeout: 3000, what: 'four settles' });
  assert.deepEqual(b.published.filter((m) => m.kind === 'permission.settled').map((m) => m.by), ['web', 'web', 'terminal', 'timeout']);
});

// ── the op loop's driver (ruling C-defaults (a)) ────────────────────────────

for (const [strict, driver] of [[false, 'loop'], [true, 'clock']]) {
  test(`with a $ that ${strict ? 'refuses calls made outside a hook' : 'answers anywhere'}, the op loop runs on the ${driver} and diag says so`, async (t) => {
    const { b, host } = await attachedHost(t, { strict });
    const u = await b.bridge.enqueue(SID, { op: 'messages', args: {} });
    assert.deepEqual(u, { ok: true, result: { count: 2 } });
    await host.fire('turn.start', { turnId: 'turn_d', text: '' });
    await host.fire('session.append', {
      door: 'prompt', origin: { kind: 'composer' }, uuid: '44444444-4444-4444-8444-444444444444',
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'hi' }] },
    }, async (x) => ({ message: x.message, uuid: x.uuid }));
    await host.fire('turn.complete', { turnId: 'turn_d', answer: 'ok', reason: 'answer', durationMs: 5, isAborted: false });
    await waitUntil(() => attachedTo(b) && attachedTo(b).shapes.driver, { timeout: 5000, what: 'the diag' });
    const s = attachedTo(b);
    assert.deepEqual(s.shapes.driver, [driver]);
    assert.ok(s.shapes['turn.complete'].includes('turnId'), 'key names of turn.complete');
    assert.ok(s.shapes['session.append'].includes('message.content'), 'key names of a row');
    assert.doesNotMatch(JSON.stringify(s.shapes), /\bhi\b|composer/, 'names, never values');
    assert.equal(host.called('clock.every').length > 0, strict, strict ? 'the clock drives' : 'no clock needed');
  });
}
