// Tranche 1 of the chat mirror, end to end (design spec §11.4, "End-to-end check
// (U22a)"): the heartbeat through the daemon exactly as createServer wires it —
// ctx.hooks, ctx.redactor, ctx.audience and ctx.mirror, the hook, mirror,
// mirror-access and project routes mounted, every new handle stopped by both
// teardown paths — and through the real chrome, public/app/main.js, drawing what
// that daemon sends.
//
// The daemon is the real one (withServer). Claude Code is played by its own
// hooks' code: envelope v1 built by lib/hooks/envelope.js and posted by the
// `mirror` hook's postEnvelope (lib/hooks/mirror.js), and the turn hooks' bodies
// with the session fields lib/hooks/turn-begin.js sends — all through lib/client,
// with no Origin and no Sec-Fetch-*, as a hook posts. Its user tier is a private
// fake (test-support/claude-home), so every envelope names a transcript the
// mirror accepts. A browser is Node's fetch (it sends Sec-Fetch-Mode, as every
// browser does); a remote viewer is `X-WC-Remote: 1` from loopback (what the
// portal sends); a network peer is a stubbed req.socket.remoteAddress (spec
// §10.1).
//
// Pinned, a test per clause of §11.4's check:
//   * envelopes posted in order (SessionStart, turn-begin with the session's
//     fields, PreToolUse, PostToolUse, turn-end) give one conversation with one
//     closed turn — with the mirror on /api/health and its access route mounted;
//   * the same PostToolUse arriving before its PreToolUse leaves no running step;
//   * a turn-begin a browser sends publishes nothing on the hook tap;
//   * a network peer's hook envelope is refused (Q9), while the same peer's
//     GET /api/mirror answers the basic body;
//   * a local socket gets mirror:update frames with the step's label; a socket
//     with X-WC-Remote gets only mirror:status, with no label, path or prompt
//     text, and lock and node-added frames with no prompt text; and every route
//     TEXT_RULES names (lib/core/remote-policy: GET /api/graph and
//     /api/graph/node/:id among them), read by a remote viewer and by a network
//     peer, carries none either — but for the two whose route files the ledger
//     has left unowned, named in TEXT_NOT_YET_STRIPPED, a list that can only
//     shrink;
//   * and a project that opted in shows a remote viewer the conversation at
//     `read`: the audience its sockets and routes judge by is the server's own;
//   * the redactor knows web-chat's capture token (spec §5.5, "Known values"):
//     the one configured at boot, and one made later from the first request a
//     capture route holds to it;
//   * the server leaves no open handle through srv.stop() and through
//     gracefulShutdown(), the chat mirror's own (its timers, a linked process's
//     sampler and sessions-file watch, the audience's tunnel.json poll) included,
//     and gracefulShutdown() goes on past a mirror whose stop never settles;
//   * test/bus-golden.test.js is byte-identical;
//   * the real main.js, booted in jsdom, draws the bar from the frames a daemon
//     sent; the tab reads the project's name after hello and after a project
//     frame renames it, and nothing but project.js writes it; the lockup draws
//     the project's logo (and the phone's mark) from the URLs the daemon served
//     it at, light and dark; the step, a chip and the phone tab each open an
//     "Under development" note;
//   * a chrome test file that boots main.js still exits: this one (its shell,
//     restored, leaves nothing behind) and one that hand-rolls its boot, run in a
//     child process. On Node 22 (CI's), --test-timeout bounds a whole FILE, so
//     the suite run itself is the check for the other files; here they are not
//     run again (measured: a test with its own 120 s timeout is cancelled at the
//     file's 60 s on 22.23.3, and passes on 26).
//
// The chrome half replays a session recorded off a real daemon in its own
// `before`, so its tests run on their own (--test-name-pattern) like the rest.

const test = require('node:test');
const { describe, before, after } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createHook } = require('node:async_hooks');
const { withServer, tmpRoot, waitUntil, wsConnect } = require('../test-support/helpers');
const { claudeHome } = require('../test-support/claude-home');
const { bootShell } = require('../test-support/chrome-shell');
const { encodePng, solid } = require('../test-support/png-encode');
const client = require('../lib/client');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { postEnvelope } = require('../lib/hooks/mirror');
const { stepLabel } = require('../lib/core/tool-input');
const { MASK } = require('../lib/core/redact');
const { TEXT_RULES } = require('../lib/core/remote-policy');
const { projectPaths, userPaths } = require('../lib/core/paths');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { sampleProcs, formatProcStart } = require('../lib/core/portfiles');
const { HOST_ONLY } = require('../lib/server/audience');
const { MIRROR_STOP_TIMEOUT_MS } = require('../lib/server');

const REPO = path.resolve(__dirname, '..');

// The sessions, and text no viewer below `read` may ever be sent.
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const PROMPT_MARK = 'T1E2E-PROMPT-MARK';
const REPLY_MARK = 'T1E2E-REPLY-MARK';
const PROMPT = `${PROMPT_MARK} fix the import paths`;
const REPLY = `${REPLY_MARK} the import paths are fixed`;
const RENAMED = 'Heartbeat Project';
// The project's logo and its dark variant: square, so the logo is the phone's
// mark too (lib/core/project-identity markOf), and of two sizes, so the two
// files' versions differ and each mode's URL names its own.
const LOGO = encodePng(solid(16, 16, [20, 40, 200]), 16, 16);
const LOGO_DARK = encodePng(solid(32, 32, [230, 200, 40]), 32, 32);
// The URLs the topbar's lockup draws the project's images from (spec §9.3, §9.4):
// the route, `mode=dark` in web-chat's dark mode, and a cache key that names the
// version of the file that mode serves.
function lockupSrcs(id) {
  const v = (meta) => encodeURIComponent(meta.version);
  return {
    light: { icon: `/project/logo?v=${v(id.logo)}`, mark: `/project/mark?v=${v(id.logo)}` },
    dark: { icon: `/project/logo?mode=dark&v=${v(id.logo_dark)}`, mark: `/project/mark?mode=dark&v=${v(id.logo_dark)}` },
  };
}
// A network peer's address (spec §5.4: anything but loopback is one).
const PEER = '192.168.1.23';
// A tunnel.json `tunnel setup` could have written: the opt-in rides beside it.
const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
// Every call a test makes to its daemon: bounded, and generous, so a loaded
// machine (V17) delays a test rather than failing it.
const CALL_TIMEOUT_MS = 15000;
const WAIT = { timeout: 15000, interval: 10 };

// ── the daemon, and Claude Code's side of it ─────────────────────────────────

// A fresh project with a private Claude Code tier, its daemon (written into the
// project's portfile, as `start` writes it, so the mirror hook finds it), and
// the hooks' half of the conversation. `seed` writes into .web-chat before boot.
async function daemon(t, { seed } = {}) {
  let ctx = null;
  // Registered first, so it runs first: the daemon stops before claudeHome's
  // cleanup takes its Claude tier away (t.after runs in registration order).
  t.after(async () => { if (ctx) await ctx.stop(); });
  const root = tmpRoot('wc-t1e2e-');
  const ch = claudeHome(t, { root, isolate: true });
  ctx = await withServer(t, { root, writePortfile: true, seed });
  return driver(ctx, ch);
}

function driver(ctx, ch) {
  const call = { port: ctx.port, noSpawn: true, timeout: CALL_TIMEOUT_MS };
  const env = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
  let clock = Date.now();
  const stamp = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
  const sessionOf = (sid) => ({ session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd, permission_mode: 'default' });
  // Envelope v1 for one hook fire, built as the hook builds it (stamped now).
  const envelope = (event, extra = {}, sid = S1) => hookEnvelope({ hook_event_name: event, ...sessionOf(sid), ...extra }, env,
    { now: stamp() });
  // The `mirror` hook's post: through lib/client, to the port in this project's portfile.
  async function post(e) {
    const r = await postEnvelope(e, { root: ctx.root, timeout: CALL_TIMEOUT_MS });
    assert.equal(r, 'posted', `${e.event} reached the hook intake`);
  }
  const file = path.join(ch.cwd, 'lib', 'paths.js');
  const input = { file_path: file, old_string: "require('../core')", new_string: "require('../core/paths')" };
  // The body the turn-begin hook posts: the lock's own fields, and the session's.
  function turnBeginBody(promptId, text, sid = S1) {
    const e = envelope('UserPromptSubmit', { prompt: text, prompt_id: promptId }, sid);
    return { message: text, author: 'user', ...sessionFields(e), prompt: e.prompt };
  }
  const d = {
    ...ctx,
    ch,
    call,
    env,
    file,
    label: stepLabel('Edit', input),
    envelope,
    post,
    fire: (event, extra, sid) => post(envelope(event, extra, sid)),
    edit: (useId) => ({ tool_name: 'Edit', tool_use_id: useId, tool_input: input }),
    edited: (useId) => ({ tool_name: 'Edit', tool_use_id: useId, tool_input: input, tool_response: { filePath: file }, duration_ms: 9 }),
    turnBeginBody,
    turnBegin: (promptId, text, sid) => client.post('/api/turn-begin', turnBeginBody(promptId, text, sid), call),
    // The body the turn-end hook posts for a Stop: the session's fields, and the reply.
    turnEnd(reply, sid = S1) {
      const e = envelope('Stop', { last_assistant_message: reply }, sid);
      return client.post('/api/turn-end', {
        author: 'claude', reply, ended: 'stop', ...sessionFields(e), last_assistant_message: e.stop.last_assistant_message,
      }, call);
    },
    snapshot: () => client.get('/api/mirror', call),
    // A raw exchange: {status, body}, never thrown on a status.
    request: (method, p, body, headers) => client.request(ctx.port, method, p, body, { headers, timeout: CALL_TIMEOUT_MS }),
  };
  return d;
}

// The pane the turn renders (its version history is one more carrier of the
// prompt, below).
const PANE = 't1e2e-pane';

// One turn as Claude Code runs it: the session starts, the prompt opens the turn,
// an Edit runs — the pane rendered during it changes the surface, so the turn
// commits a node — and the Stop closes it. `onStep` runs while the Edit runs.
async function runTurn(d, { onStep } = {}) {
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await d.turnBegin('p1', PROMPT);
  await d.fire('PreToolUse', d.edit('toolu_1'));
  if (onStep) await onStep();
  await client.post('/api/render', { id: PANE, html: '<p>a pane</p>' }, d.call);
  await d.fire('PostToolUse', d.edited('toolu_1'));
  return d.turnEnd(REPLY);
}

// A WebSocket that records every frame it gets. `headers` go on its upgrade.
async function socket(t, port, headers) {
  const ws = wsConnect(port, '/ws', headers ? { headers } : undefined);
  t.after(() => { try { ws.terminate(); } catch {} });
  const frames = [];
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())); } catch {} });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { ...WAIT, what: 'the hello' });
  return { ws, frames, of: (type) => frames.filter((f) => f.type === type) };
}

const isMirror = (f) => typeof f.type === 'string' && f.type.startsWith('mirror:');
const stepFrame = (label) => (f) => f.type === 'mirror:update' && f.live && f.live.step && f.live.step.label === label;
const doneFrame = (f) => f.type === 'mirror:update' && f.live && f.live.state === 'idle' && f.live.last_turn
  && f.live.last_turn.id === 'p1';

// Requests carrying x-test-peer arrive from that address (spec §10.1's network
// peer): their socket's remoteAddress is stubbed before the app sees them, and
// put back once the response has gone.
function stubPeers(server) {
  const onRequest = (req, res) => {
    const addr = req.headers['x-test-peer'];
    if (!addr) return;
    Object.defineProperty(req.socket, 'remoteAddress', { value: addr, configurable: true });
    res.once('close', () => { delete req.socket.remoteAddress; });
  };
  server.prependListener('request', onRequest);
  return () => server.off('request', onRequest);
}

// ── the conversation's text, below `read` ────────────────────────────────────

// The viewers below `read` (rulings Q2 and Q9): a remote viewer of a project that
// has not opted in, and a peer on a network bind. Neither is sent the turn's text.
const BELOW_READ = Object.freeze([
  ['a remote viewer', Object.freeze({ 'X-WC-Remote': '1' })],
  ['a network peer', Object.freeze({ 'x-test-peer': PEER })],
]);

// How this test reaches each route lib/core/remote-policy's TEXT_RULES names:
// null while what it needs (the turn's committed node) does not exist yet. A key
// the table gains and this map lacks fails the test, so a carrier the table
// learns of is checked here too, on the daemon as wired.
const TEXT_ROUTE_URLS = Object.freeze({
  'GET /api/graph': () => '/api/graph',
  'GET /api/graph/node/:id': ({ node }) => node && `/api/graph/node/${encodeURIComponent(node)}`,
  'GET /preview/node/:id': ({ node }) => node && `/preview/node/${encodeURIComponent(node)}`,
  'GET /api/mounts/:id/history': ({ node }) => node && `/api/mounts/${PANE}/history`,
  'GET /api/replay/path': ({ node }) => node && '/api/replay/path',
  'GET /api/health': () => '/api/health',
});

// The TEXT_RULES routes that do not strip their entry yet. Each route strips its
// own (remote-policy's header names who: history.js the versions, replay.js the
// path), and these two route files have no 0.8.5 owner in the shared-file
// ledger (spec §11.2), so tranche 1's integration left the edit to whoever the
// orchestrator gives them. Shrink-only: once a route strips, this test fails
// until its entry goes.
const TEXT_NOT_YET_STRIPPED = new Map([
  ['GET /api/mounts/:id/history', 'routes/history.js serves each version\'s trigger_summary to every viewer'],
  ['GET /api/replay/path', 'routes/replay.js serves each step\'s caption (prompt, reply, summary) to every viewer'],
]);

const carriesText = (s) => s.includes(PROMPT_MARK) || s.includes(REPLY_MARK);
const bodyText = (r) => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body));

// Every TEXT_RULES route, read by the host and by each viewer below `read` at
// the points a test calls read(). A route counts as checked only where the
// host's own copy carries the turn's text: anywhere else a clean answer below
// `read` would prove nothing. check() then holds each route to its rule.
function textRoutes(d) {
  const carried = new Set();
  const leaked = new Map(); // route → the viewers below read it served text to
  return {
    async read(ids) {
      for (const [key, urlOf] of Object.entries(TEXT_ROUTE_URLS)) {
        const url = urlOf(ids);
        if (!url) continue;
        const near = await d.request('GET', url);
        if (near.status !== 200 || !carriesText(bodyText(near))) continue;
        carried.add(key);
        for (const [who, headers] of BELOW_READ) {
          const far = await d.request('GET', url, null, headers);
          assert.equal(far.status, 200, `${who}'s GET ${url}`);
          if (!carriesText(bodyText(far))) continue;
          const seen = leaked.get(key) || new Set();
          leaked.set(key, seen.add(who));
        }
      }
    },
    check() {
      const keys = Object.keys(TEXT_RULES.routes).sort();
      assert.deepEqual(Object.keys(TEXT_ROUTE_URLS).sort(), keys, 'this test reaches every route TEXT_RULES names');
      assert.deepEqual([...carried].sort(), keys, 'and read each one while the host\'s copy carried the turn\'s text');
      for (const key of [...TEXT_NOT_YET_STRIPPED.keys()]) assert.ok(keys.includes(key), `${key} is a TEXT_RULES route`);
      for (const key of keys) {
        const who = [...(leaked.get(key) || [])];
        if (TEXT_NOT_YET_STRIPPED.has(key)) {
          assert.deepEqual(who, BELOW_READ.map(([w]) => w),
            `${key} stopped serving the turn's text to ${BELOW_READ.map(([w]) => w).filter((w) => !who.includes(w)).join(' and ')}: `
            + `take it off TEXT_NOT_YET_STRIPPED (${TEXT_NOT_YET_STRIPPED.get(key)})`);
        } else {
          assert.deepEqual(who, [], `${key} served the turn's prompt or reply to ${who.join(' and ')}`);
        }
      }
    },
  };
}

// ── open handles ─────────────────────────────────────────────────────────────

// What keeps the event loop alive (Node's own list: ref'd handles and timers),
// counted by type.
function refCounts() {
  const out = {};
  for (const type of process.getActiveResourcesInfo()) out[type] = (out[type] || 0) + 1;
  return out;
}
// The types `now` has more of than `base`.
function excess(base, now = refCounts()) {
  return Object.keys(now).filter((type) => now[type] > (base[type] || 0)).map((type) => `${type} ×${now[type] - (base[type] || 0)}`);
}

// Every timer and handle made while it is on, ref'd or not: an unref'd one never
// holds a process, but one left running is still a leak (the audience's
// tunnel.json poll is unref'd). A timer is read off its own object — cleared or
// fired, Node marks it `_destroyed` at once, while async_hooks' destroy arrives
// later — and a handle by its destroy.
const HANDLE_TYPES = new Set(['TCPWRAP', 'TCPSERVERWRAP', 'PIPEWRAP', 'PIPESERVERWRAP', 'PROCESSWRAP', 'FSEVENTWRAP',
  'STATWATCHER', 'SIGNALWRAP', 'UDPWRAP']);
function trackHandles() {
  const timers = new Set();
  const handles = new Map();
  const hook = createHook({
    init(id, type, _trigger, resource) {
      if (type === 'Timeout') timers.add(resource);
      else if (HANDLE_TYPES.has(type)) handles.set(id, type);
    },
    destroy(id) { handles.delete(id); },
  }).enable();
  return {
    open() {
      const out = [...handles.values()];
      for (const tm of timers) {
        assert.equal(typeof tm._destroyed, 'boolean', 'a Timeout says whether it is spent (Node internals moved: update trackHandles)');
        if (!tm._destroyed) out.push(`Timeout(${tm._idleTimeout} ms${tm._repeat ? ', repeating' : ''}${tm.hasRef() ? '' : ', unref\'d'})`);
      }
      return out;
    },
    stop() { hook.disable(); },
  };
}

// The whole lifecycle with a linked Claude Code process — this one, with a
// sessions file and procStart, so the engine samples it and watches its file —
// then `teardown`, then nothing of the daemon's may be left: no handle or timer
// it made (ref'd or not), and nothing more keeping the loop alive than before.
async function exitsClean(t, teardown) {
  const procStart = formatProcStart((await sampleProcs([process.pid])).get(process.pid).startedAt);
  const base = refCounts();
  const tracker = trackHandles();
  t.after(() => tracker.stop());
  // Should the teardown under test leave the mirror running, the other one
  // still stops it, so a failure here is reported rather than holding this
  // file open for ever. Registered before the daemon's own, so it runs first.
  let d = null;
  t.after(async () => {
    if (!d) return;
    await d.srv.stop();
    await d.srv.gracefulShutdown();
  });

  d = await daemon(t);
  d.ch.writeSession({ pid: process.pid, procStart, sessionId: S1, status: 'busy' });
  d.env.CLAUDE_PID = String(process.pid);
  const local = await socket(t, d.port);
  await runTurn(d);
  const linked = async () => (await d.snapshot()).conversations.find((c) => c.process && c.process.pid === process.pid);
  await waitUntil(linked, { ...WAIT, what: 'the mirror to link the session\'s process' });
  // Its first sample runs at once. Give it the time a loaded machine needs (a
  // sample that times out is no verdict, V17), but fail nothing on it: the link
  // is what arms the sampler and the sessions-file watch.
  await waitUntil(async () => { const c = await linked(); return c && c.live.evidence.proc === 'alive'; }, { timeout: 5000 });
  await waitUntil(() => local.frames.some(doneFrame), { ...WAIT, what: 'the mirror\'s frames on the socket' });

  await teardown(d);
  assert.equal(d.server.listening, false, 'the server is closed');
  const left = await waitUntil(() => {
    const open = tracker.open();
    const more = excess(base);
    return open.length === 0 && more.length === 0 ? 'clean' : null;
  }, { timeout: 15000, interval: 20 });
  assert.ok(left, `left behind — handles and timers: [${tracker.open().join(', ')}]; keeping the loop alive beyond the baseline: [${excess(base).join(', ')}]`);
}

// ── the daemon ───────────────────────────────────────────────────────────────

test('envelopes posted in order through lib/client give one conversation with one closed turn', async (t) => {
  const d = await daemon(t);
  const health0 = await client.get('/api/health', d.call);
  assert.deepEqual(health0.mirror, { enabled: true, level: 'local', state: 'none', conversations: 0, last_hook_at: null },
    'the mirror is wired into /api/health before any hook fires');

  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await d.turnBegin('p1', PROMPT);
  await d.fire('PreToolUse', d.edit('toolu_1'));
  const running = (await d.snapshot()).conversations;
  assert.equal(running.length, 1);
  assert.equal(running[0].open_turn_id, 'p1', 'the turn-begin\'s UserPromptSubmit opened the turn');
  assert.equal(running[0].live.state, 'working');
  assert.equal(running[0].live.step.label, d.label, 'the PreToolUse is the running step');

  await d.fire('PostToolUse', d.edited('toolu_1'));
  const end = await d.turnEnd(REPLY);
  assert.equal(end.ok, true);

  const snap = await d.snapshot();
  assert.equal(snap.content, true);
  assert.deepEqual(snap.access, { level: 'local', remote: false });
  assert.equal(snap.conversations.length, 1, 'one conversation');
  const [c] = snap.conversations;
  assert.equal(c.id, S1, 'named by its first session');
  assert.equal(c.turn_count, 1, 'one turn');
  assert.equal(c.open_turn_id, null, 'and it is closed');
  assert.equal(c.live.state, 'idle');
  assert.equal(c.live.step, null);
  assert.deepEqual([c.live.last_turn.id, c.live.last_turn.outcome, c.live.last_turn.reply_preview], ['p1', 'done', REPLY],
    'closed by the turn-end\'s Stop, with its reply');
  assert.deepEqual(snap.diagnostics.hooks.events_seen,
    { SessionStart: 1, UserPromptSubmit: 1, PreToolUse: 1, PostToolUse: 1, Stop: 1 }, 'each envelope reached the engine once');
  assert.deepEqual(snap.diagnostics.hooks.ignored, {}, 'and none was refused');

  const health = await client.get('/api/health', d.call);
  assert.equal(health.mirror.enabled, true);
  assert.equal(health.mirror.state, 'idle');
  assert.equal(health.mirror.conversations, 1);
  assert.equal(typeof health.mirror.last_hook_at, 'number');
  const access = await client.get('/api/mirror/access', d.call);
  assert.equal(access.level, 'local', 'GET /api/mirror/access is mounted, and a local caller is local');
  assert.deepEqual(access.project, { remote_level: 'off', tunnel_configured: false });
});

test('a PostToolUse that arrives before its PreToolUse leaves no running step', async (t) => {
  const d = await daemon(t);
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await d.turnBegin('p1', PROMPT);
  // The tool starts, and ends: stamped in that order, as the hooks read stdin…
  const pre = d.envelope('PreToolUse', d.edit('toolu_9'));
  const post = d.envelope('PostToolUse', d.edited('toolu_9'));
  // …but its PostToolUse reaches the daemon first (async hooks race, V24).
  await d.post(post);
  await d.post(pre);

  const snap = await d.snapshot();
  assert.deepEqual(snap.diagnostics.hooks.events_seen, { SessionStart: 1, UserPromptSubmit: 1, PostToolUse: 1, PreToolUse: 1 },
    'both reached the engine');
  const [c] = snap.conversations;
  assert.equal(c.open_turn_id, 'p1', 'the turn is still open');
  assert.equal(c.live.state, 'working');
  assert.equal(c.live.step, null, 'and no step is running: the ended call is never put back');
  const status = await client.get('/api/mirror/status', d.call);
  assert.equal(status.conversations[0].state, 'working');
  assert.equal(status.conversations[0].step_kind, undefined, 'the heartbeat names no step either');

  // The control: a call whose PreToolUse comes first is the running step.
  await d.fire('PreToolUse', d.edit('toolu_10'));
  assert.equal((await d.snapshot()).conversations[0].live.step.label, d.label);
});

test('a turn-begin sent through fetch, as a browser sends it, publishes nothing on the hook tap', async (t) => {
  const d = await daemon(t);
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  const before = (await d.snapshot()).diagnostics.hooks;

  // The turn-begin hook's own body, for another session, from a page: Node's
  // fetch sends Sec-Fetch-Mode, so the daemon takes it for a browser's.
  const body = d.turnBeginBody('pF', PROMPT, S2);
  const r = await d.api.post('/api/turn-begin', body);
  assert.equal(r.status, 200, 'a page drives the turn lock as it always has');
  assert.equal(r.json.ok, true);
  const after = await d.snapshot();
  assert.deepEqual(after.diagnostics.hooks.events_seen, before.events_seen, 'no envelope reached the mirror');
  assert.deepEqual(after.diagnostics.hooks.ignored, before.ignored, 'not even one it ignored');
  assert.deepEqual(after.conversations.map((c) => c.id), [S1], 'the page put no conversation in the mirror');
  await d.api.post('/api/unlock', {});

  // The control: the very same body from the host — lib/client, as the hook
  // posts — is published, and opens the turn.
  await client.post('/api/turn-begin', body, d.call);
  const hostSnap = await d.snapshot();
  assert.equal(hostSnap.diagnostics.hooks.events_seen.UserPromptSubmit, 1);
  const s2 = hostSnap.conversations.find((c) => c.id === S2);
  assert.ok(s2, 'the host\'s turn-begin reached the mirror');
  assert.equal(s2.open_turn_id, 'pF');
});

test('a network peer is held to the heartbeat: its hook envelope is refused (Q9), and its GET /api/mirror is the basic body', async (t) => {
  const d = await daemon(t);
  t.after(stubPeers(d.server));
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await d.turnBegin('p1', PROMPT);
  await d.fire('PreToolUse', d.edit('toolu_1'));
  const before = (await d.snapshot()).diagnostics.hooks;

  // A PreToolUse from a peer on a WEB_CHAT_HOST bind: refused before its body
  // is read, whatever it carries.
  const forged = d.envelope('PreToolUse', d.edit('toolu_2'));
  const refused = await d.request('POST', '/api/hooks/event', forged, { 'x-test-peer': PEER });
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { ok: false, hint: HOST_ONLY });
  const asRemote = await d.request('POST', '/api/hooks/event', forged, { 'x-test-peer': PEER, 'X-WC-Remote': '1' });
  assert.equal(asRemote.status, 403, 'and no header raises it');
  assert.deepEqual((await d.snapshot()).diagnostics.hooks, before, 'nothing it sent reached the mirror');
  // The control: the same envelope from the host is taken.
  const taken = await d.request('POST', '/api/hooks/event', forged);
  assert.deepEqual([taken.status, taken.body], [200, { ok: true }]);
  await waitUntil(async () => (await d.snapshot()).diagnostics.hooks.events_seen.PreToolUse === 2,
    { ...WAIT, what: 'the host\'s envelope to reach the mirror' });

  // The same peer reads the heartbeat, and nothing more.
  const basic = await d.request('GET', '/api/mirror', null, { 'x-test-peer': PEER });
  assert.equal(basic.status, 200);
  assert.deepEqual(Object.keys(basic.body).sort(),
    ['access', 'aggregate', 'asks', 'content', 'conversations', 'enabled', 'now', 'primary', 'rev', 'v']);
  assert.equal(basic.body.content, false);
  assert.deepEqual(basic.body.access, { level: 'basic', remote: false });
  assert.equal(basic.body.conversations.length, 1);
  const [row] = basic.body.conversations;
  assert.equal(row.id, S1);
  assert.equal(row.state, 'working');
  assert.equal(row.step_kind, 'Edit', 'the kind of step, and no label');
  const text = JSON.stringify(basic.body);
  for (const needle of [PROMPT_MARK, d.label, 'paths.js', d.root, d.ch.cwd, d.ch.transcript(S1)]) {
    assert.ok(!text.includes(needle), `the peer's body does not carry ${JSON.stringify(needle)}`);
  }
  // Locally the same read is the whole snapshot.
  const local = await d.request('GET', '/api/mirror');
  assert.equal(local.body.content, true);
  assert.equal(local.body.conversations[0].live.step.label, d.label);
});

test('a local socket gets the step\'s label; a remote one only mirror:status, and no prompt text in lock, node-added or any route TEXT_RULES names', async (t) => {
  const d = await daemon(t);
  t.after(stubPeers(d.server));
  const local = await socket(t, d.port);
  const remote = await socket(t, d.port, { 'X-WC-Remote': '1' });
  const routes = textRoutes(d);
  const end = await runTurn(d, {
    onStep: async () => {
      await waitUntil(() => local.frames.some(stepFrame(d.label)), { ...WAIT, what: 'the step\'s mirror:update' });
      // The turn is open: its prompt rides the lock, in the graph and in /api/health.
      await routes.read({});
    },
  });
  assert.ok(end.node_id, 'the turn committed a node');
  await waitUntil(() => local.frames.some(doneFrame) && remote.of('node-added').length > 0
    && remote.of('mirror:status').some((f) => f.conversations.some((r) => r.state === 'idle')),
  { ...WAIT, what: 'the turn\'s end on both sockets' });

  // The local socket: the mirror's content, the step's label in it.
  const update = local.frames.find(stepFrame(d.label));
  assert.equal(update.conversation_id, S1);
  assert.equal(update.live.step.kind, 'Edit');
  assert.ok(local.of('mirror:status').some((f) => f.conversations.some((r) => r.step_kind === 'Edit')));
  // The prompt rides its lock and node-added frames (what the remote ones lack).
  assert.ok(local.of('lock').some((f) => f.lock && f.lock.message === PROMPT));
  assert.ok(local.of('node-added').some((f) => f.node.trigger_summary.includes(PROMPT_MARK)));

  // The remote socket: the heartbeat, and no conversation text anywhere.
  assert.deepEqual([...new Set(remote.frames.filter(isMirror).map((f) => f.type))], ['mirror:status'],
    'only mirror:status of the mirror\'s frames');
  assert.ok(remote.of('mirror:status').some((f) => f.conversations.some((r) => r.state === 'working' && r.step_kind === 'Edit')),
    'the heartbeat itself: working, an Edit');
  const lockFrames = remote.of('lock');
  assert.ok(lockFrames.length > 0, 'the remote socket was told of the lock');
  for (const f of lockFrames) assert.equal(f.lock && 'message' in f.lock, false, 'a lock frame without its prompt');
  for (const f of remote.of('node-added')) assert.equal('trigger_summary' in f.node, false, 'a node-added frame without its prompt');
  const wire = JSON.stringify(remote.frames);
  for (const needle of [PROMPT_MARK, REPLY_MARK, d.label, 'paths.js', d.root, d.ch.cwd, d.ch.transcript(S1)]) {
    assert.ok(!wire.includes(needle), `no frame the remote socket got carries ${JSON.stringify(needle)}`);
  }

  // Every route TEXT_RULES names — the graph, a node, its preview document, the
  // pane's history, the replay path, /api/health — read remotely and by a
  // network peer, carries no prompt or reply (but the two the ledger has left
  // unowned, TEXT_NOT_YET_STRIPPED); read locally, each carries them, so the
  // probe can see them.
  await routes.read({ node: end.node_id });
  routes.check();
});

test('a project that opted in shows a remote viewer the conversation at read: the server\'s audience reaches its sockets and routes', async (t) => {
  // `claude-web-chat tunnel mirror on --read-only`, as tunnel.json records it,
  // in place before the daemon boots: its audience reads it at once.
  const d = await daemon(t, {
    seed: ({ root }) => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(root)]: 'read' } } }),
  });
  const remote = await socket(t, d.port, { 'X-WC-Remote': '1' });
  await runTurn(d, {
    onStep: () => waitUntil(() => remote.frames.some(stepFrame(d.label)), { ...WAIT, what: 'the step\'s mirror:update, remotely' }),
  });
  assert.ok(remote.of('lock').some((f) => f.lock && f.lock.message === PROMPT), 'the lock\'s prompt, which read may see');
  const far = await d.request('GET', '/api/mirror', null, { 'X-WC-Remote': '1' });
  assert.equal(far.body.content, true);
  assert.deepEqual(far.body.access, { level: 'read', remote: true });
  const health = await d.request('GET', '/api/health', null, { 'X-WC-Remote': '1' });
  assert.equal(health.body.mirror.level, 'read');
});

test('the redactor knows web-chat\'s capture token: a reply that quotes it reaches the mirror masked', async (t) => {
  const token = `wct-${crypto.randomBytes(12).toString('hex')}`;
  const d = await daemon(t, { seed: ({ root }) => fs.writeFileSync(projectPaths(root).captureToken, `${token}\n`) });
  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await d.turnBegin('p1', PROMPT);
  await d.turnEnd(`${REPLY_MARK} the capture token is ${token}`);
  const snap = await d.snapshot();
  const preview = snap.conversations[0].live.last_turn.reply_preview;
  assert.ok(preview.includes(REPLY_MARK), 'the reply reached the mirror');
  assert.ok(!JSON.stringify(snap).includes(token), 'without the token');
  assert.ok(preview.includes(MASK('capture-token')), 'which shows as a known value\'s mask');
});

test('a capture token made while the daemon runs is learned when a capture route first holds a request to it', async (t) => {
  const token = () => `wct-${crypto.randomBytes(12).toString('hex')}`;
  const [boot, second, third] = [token(), token(), token()];
  const d = await daemon(t, { seed: ({ root }) => fs.writeFileSync(projectPaths(root).captureToken, `${boot}\n`) });
  const replace = (value) => fs.writeFileSync(projectPaths(d.root).captureToken, `${value}\n`);
  // The token is replaced under the running daemon, as a user (or Claude) would
  // write .web-chat/capture-token, and the next request to a route that checks
  // it is held to the new one at once — each of the two such routes in turn.
  replace(second);
  const match = (value) => d.request('GET', '/api/profile-match?url=https%3A%2F%2Fexample.test%2F', null, { 'X-WC-Token': value });
  assert.equal((await match(boot)).status, 401, 'GET /api/profile-match holds a request to the new token');
  assert.equal((await match(second)).status, 200);
  replace(third);
  const capture = await d.request('POST', '/api/capture', { url: 'https://example.test/', html: '<p>x</p>' }, { 'X-WC-Token': second });
  assert.equal(capture.status, 401, 'and so does POST /api/capture');

  await d.fire('SessionStart', { source: 'startup', model: 'claude-test' });
  await d.turnBegin('p1', PROMPT);
  await d.turnEnd(`${REPLY_MARK} the tokens were ${boot}, ${second} and ${third}`);
  const snap = await d.snapshot();
  const preview = snap.conversations[0].live.last_turn.reply_preview;
  assert.ok(preview.includes(REPLY_MARK), 'the reply reached the mirror');
  const wire = JSON.stringify(snap);
  assert.ok(!wire.includes(third) && !wire.includes(second), 'without the tokens the gate honoured after boot');
  assert.ok(!wire.includes(boot), 'nor the one they replaced: a known value stays known');
  assert.equal(preview.split(MASK('capture-token')).length - 1, 3, 'each shows as a known value\'s mask');
});

test('srv.stop() leaves no open handle: the chat mirror, its audience and every socket stop with it', async (t) => {
  await exitsClean(t, (d) => d.srv.stop());
});

test('gracefulShutdown() leaves no open handle: the chat mirror, its audience and every socket stop with it', async (t) => {
  await exitsClean(t, (d) => d.srv.gracefulShutdown());
});

test('gracefulShutdown() does not wait for ever on a chat mirror whose stop never settles: the step has a ceiling', async (t) => {
  // Registered before the daemon's own cleanup, so it runs first: should an
  // assertion below fail, the stuck stop is let go and srv.stop() can end.
  let letGo = null;
  t.after(() => { if (letGo) letGo(); });
  const d = await daemon(t);
  // A source whose stop() hangs (a later tranche's tailer mid-read, say),
  // registered on the running engine, which starts it at once.
  let asked = 0;
  d.srv.mirror.register('stuck', () => ({
    start: async () => {},
    stop: () => { asked += 1; return new Promise((resolve) => { letGo = resolve; }); },
  }));
  await waitUntil(() => d.srv.mirror.stats().sources.some((s) => s.name === 'stuck' && s.started),
    { ...WAIT, what: 'the stuck source to start' });

  const logged = [];
  const realError = console.error;
  console.error = (...a) => { logged.push(a.map(String).join(' ')); };
  let took;
  try {
    const t0 = Date.now();
    await d.srv.gracefulShutdown();
    took = Date.now() - t0;
  } finally {
    console.error = realError;
  }
  assert.equal(asked, 1, 'the shutdown asked the mirror to stop, and the mirror its source');
  assert.equal(typeof letGo, 'function', 'and settled while that stop was still pending');
  assert.equal(d.server.listening, false, 'then went on to close the server');
  assert.ok(logged.some((l) => l.includes(`mirror: stop timed out after ${MIRROR_STOP_TIMEOUT_MS} ms`)),
    `the daemon's log says why it went on: ${JSON.stringify(logged)}`);
  // A wall-clock bound is asserted only under WEB_CHAT_PERF=1 (spec §10.1).
  t.diagnostic(`gracefulShutdown settled in ${took} ms with the mirror's stop pending (ceiling ${MIRROR_STOP_TIMEOUT_MS} ms)`);
  if (process.env.WEB_CHAT_PERF === '1') {
    assert.ok(took >= MIRROR_STOP_TIMEOUT_MS - 50 && took < MIRROR_STOP_TIMEOUT_MS + 1500, `took ${took} ms`);
  }

  // Let the stop finish, so the engine ends its own timers and this file exits.
  letGo();
  await d.srv.mirror.stop();
  assert.equal(d.srv.mirror.stats().timers, 0, 'the engine, let go, cleared every timer it held');
});

// §2.9 and §10.2: the core bus API and its golden are unchanged by the mirror,
// for the whole release. The golden test runs the wired daemon (withServer);
// this holds the file to the bytes tranche 1 started from, so it cannot be
// edited to fit a changed wire.
const BUS_GOLDEN_SHA256 = '235cabffa00d1a76c0e29f77c4380f30e3361248f8221d2ebffc8c585e23216a';

test('test/bus-golden.test.js is byte-identical', () => {
  const src = fs.readFileSync(path.join(REPO, 'test', 'bus-golden.test.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(crypto.createHash('sha256').update(src).digest('hex'), BUS_GOLDEN_SHA256,
    'test/bus-golden.test.js changed: the spec holds the bus wire and its golden byte-identical for 0.8.5 (§2.9, §10.2)');
});

test('a chrome test file that hand-rolls its boot of main.js still exits on its own', async (t) => {
  // test/mount-chrome-safety.test.js boots the real main.js by hand and silences
  // only setInterval, the way most chrome files do (spec §10.1). Run as the suite
  // runs a file, and with nothing to make it exit: it must end on its own.
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  delete env.NODE_TEST_CONTEXT; // else the child reports to this runner's protocol, not to us
  const child = spawn(process.execPath, ['--test', '--test-timeout=60000', '--import', './test-support/sandbox.js',
    '--test-reporter=spec', path.join('test', 'mount-chrome-safety.test.js')], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const code = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(code, 0, `it exited ${code}:\n${out.slice(-2000)}`);
  assert.match(out, /ℹ pass [1-9]/);
  assert.match(out, /ℹ fail 0/);
});

// ── the chrome ───────────────────────────────────────────────────────────────

// A scratch test context for the chrome's `before`, where node:test hands a
// suite context with no `after`: the recording's daemon and fixtures register
// their cleanups here, and they run (in order, as t.after's do) once it is done.
async function scratch(fn) {
  const afters = [];
  try {
    return await fn({ after: (f) => afters.push(f) });
  } finally {
    for (const f of afters) await f();
  }
}

// A session recorded off a real daemon, for the chrome to replay: every frame a
// local socket got, in order, and what GET /api/mirror and GET /api/project
// answered at each point the chrome reads them — and what the daemon served at
// each URL the lockup draws the project's logo from.
async function recordSession() {
  return scratch(async (t) => {
    const d = await daemon(t);
    const local = await socket(t, d.port);
    const rec = { project: path.basename(d.root), label: d.label, marks: {}, mirror: {}, identity: {} };
    rec.mirror.hello = await d.snapshot();
    rec.identity.hello = await client.get('/api/project', d.call);
    await runTurn(d, {
      onStep: async () => {
        await waitUntil(() => local.frames.some(stepFrame(d.label)), { ...WAIT, what: 'the step\'s mirror:update' });
        rec.marks.step = local.frames.length;
        rec.mirror.step = await d.snapshot();
      },
    });
    await waitUntil(() => local.frames.some(doneFrame), { ...WAIT, what: 'the turn\'s end' });
    rec.marks.done = local.frames.length;
    rec.mirror.done = await d.snapshot();
    const renamed = await d.request('PUT', '/api/project/name', { name: RENAMED });
    assert.equal(renamed.status, 200);
    await waitUntil(() => local.of('project').length > 0, { ...WAIT, what: 'the project frame' });
    rec.identity.renamed = await client.get('/api/project', d.call);
    rec.marks.end = local.frames.length;

    // Then a logo, light and dark, through the routes `claude-web-chat identity`
    // writes through (a raw image body, so Node's fetch: lib/client sends JSON).
    for (const [kind, png] of [['logo', LOGO], ['logo-dark', LOGO_DARK]]) {
      const put = await d.api.raw(`/api/project/${kind}`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png });
      assert.equal(put.status, 200, `PUT /api/project/${kind}: ${await put.text()}`);
    }
    await waitUntil(() => local.of('project').some((f) => f.identity && f.identity.logo_dark),
      { ...WAIT, what: 'the dark logo\'s project frame' });
    rec.identity.branded = await client.get('/api/project', d.call);
    rec.served = {};
    for (const urls of Object.values(lockupSrcs(rec.identity.branded))) {
      for (const url of Object.values(urls)) {
        const r = await d.api.raw(url);
        rec.served[url] = { status: r.status, type: r.headers.get('content-type'), bytes: Buffer.from(await r.arrayBuffer()) };
      }
    }
    rec.frames = local.frames.slice();
    rec.marks.branded = rec.frames.length;
    return rec;
  });
}

describe('the real main.js in jsdom, on what the daemon sent', () => {
  let rec = null;
  let shell = null;
  let base = null;
  let titleWrites = null;
  // What the shell's fetch answers for the two reads that follow a hello.
  const current = { mirror: null, identity: null };

  before(async () => {
    rec = await recordSession();
    base = refCounts();
    shell = await bootShell({
      routes: { '/api/mirror': () => current.mirror, '/api/project': () => current.identity },
      init: (sh) => {
        // Every write of the tab's title from here on, and who made it.
        const W = sh.window;
        const desc = Object.getOwnPropertyDescriptor(W.Document.prototype, 'title');
        assert.ok(desc && desc.get && desc.set, 'jsdom keeps document.title as an accessor on Document.prototype');
        titleWrites = [];
        Object.defineProperty(sh.document, 'title', {
          configurable: true,
          get() { return desc.get.call(this); },
          set(v) { titleWrites.push({ value: String(v), stack: String(new Error().stack) }); desc.set.call(this, v); },
        });
      },
    });
  });

  after(() => (shell ? shell.restore() : undefined));

  const $ = (id) => shell.$(id);
  const barText = () => $('cs-step-text').textContent;
  const barMeta = () => $('cs-step-meta').textContent;
  const barState = () => $('chat-statusbar').getAttribute('data-cs-state');
  async function replay(from, to) {
    for (const f of rec.frames.slice(from, to)) shell.socket().receive(f);
    await shell.tick();
  }
  // The module that wrote the title: the first frame of the stack in public/app.
  const writer = (stack) => {
    const line = stack.split('\n').find((l) => l.includes('/public/app/'));
    const m = line && /\/public\/app\/([\w-]+\.js)/.exec(line);
    return m ? m[1] : `(none: ${stack.split('\n').slice(1, 4).join(' | ')})`;
  };

  test('it draws the status bar from the frames: the step\'s label while the Edit runs, then the reply', async () => {
    const S = await shell.importApp('chat-state.js');
    current.mirror = rec.mirror.hello;
    current.identity = rec.identity.hello;
    await replay(0, 1); // the hello
    await waitUntil(() => S.mirror.availability === 'ok', { ...WAIT, what: 'the store to read GET /api/mirror' });
    // Before any hook fired, the daemon knew of no session, and the bar says so.
    await waitUntil(() => barText() === 'No Claude session', { ...WAIT, what: 'the bar to say there is no session' });

    current.mirror = rec.mirror.step;
    await replay(1, rec.marks.step);
    await waitUntil(() => barText() === rec.label, { ...WAIT, what: `the bar to read ${rec.label}` });
    assert.equal(barState(), 'working');
    assert.match(barMeta(), /^\d+:\d{2}$/, 'beside a running clock');

    current.mirror = rec.mirror.done;
    await replay(rec.marks.step, rec.marks.done);
    await waitUntil(() => barState() === 'idle', { ...WAIT, what: 'the bar to go idle' });
    assert.equal(barText(), `Done · “${REPLY}”`, 'the turn\'s reply, as the Stop carried it');
  });

  test('the tab reads the project\'s name after hello and after a project frame renames it, and only project.js writes it', async () => {
    current.mirror = rec.mirror.done;
    current.identity = rec.identity.hello;
    await replay(0, 1); // a hello (again: a reconnect is the same frame)
    await waitUntil(() => shell.document.title === rec.project, { ...WAIT, what: 'the folder\'s name in the tab' });

    current.identity = rec.identity.renamed;
    const frame = rec.frames.slice(rec.marks.done).find((f) => f.type === 'project');
    assert.ok(frame, 'the daemon sent a project frame for the rename');
    await replay(rec.marks.done, rec.marks.end);
    assert.equal(shell.document.title, RENAMED, 'the project frame renamed the tab');

    // A reconnect's hello never puts the folder back over the name, and no
    // other frame of the session — the lock, a render, node-added, the mirror's
    // — touches the title: no step and no state in it (ruling N1).
    await replay(0, 1);
    await shell.tick();
    await replay(1, rec.marks.done);
    assert.equal(shell.document.title, RENAMED);

    assert.ok(titleWrites.length > 0, 'the trap saw the writes');
    for (const w of titleWrites) assert.equal(writer(w.stack), 'project.js', `title ${JSON.stringify(w.value)} written by project.js`);
    assert.ok(titleWrites.every((w) => w.value === rec.project || w.value === RENAMED),
      `the title was only ever the project's name: ${JSON.stringify(titleWrites.map((w) => w.value))}`);
  });

  test('the lockup draws the project\'s logo from the URLs the daemon serves it at, its dark variant in dark mode', async () => {
    // The two halves agree on the wire (spec §9.3): the project frames carry the
    // ImageMeta GET /api/project answers.
    const id = rec.identity.branded;
    const frames = rec.frames.slice(rec.marks.end, rec.marks.branded).filter((f) => f.type === 'project');
    assert.ok(frames.length > 0, 'the uploads were announced in project frames');
    const last = frames[frames.length - 1].identity;
    for (const k of ['logo', 'logo_dark', 'mark', 'mark_dark']) assert.deepEqual(last[k], id[k], `the frame's ${k} is GET /api/project's`);
    assert.deepEqual(Object.keys(id.logo).sort(), ['bytes', 'height', 'type', 'version', 'width']);
    assert.deepEqual([id.logo.type, id.logo.bytes, id.logo.width, id.logo.height], ['image/png', LOGO.length, 16, 16]);
    assert.deepEqual([id.mark, id.mark_dark], ['logo', true], 'a square logo with a dark variant is the mark in both modes');
    assert.notEqual(id.logo.version, id.logo_dark.version, 'precondition: each mode\'s URL names its own file');

    current.identity = id;
    await replay(rec.marks.end, rec.marks.branded); // the frames themselves land it
    const srcs = lockupSrcs(id);
    const root = shell.document.documentElement;
    const was = root.getAttribute('data-theme');
    const drawn = () => ({ icon: $('cobrand-icon') && $('cobrand-icon').getAttribute('src'),
      mark: $('cobrand-pmark') && $('cobrand-pmark').getAttribute('src') });
    try {
      root.setAttribute('data-theme', 'light'); // web-chat's light mode, as theme.js marks it
      await shell.tick();
      assert.deepEqual(drawn(), srcs.light, 'light: the logo and the mark, each keyed by the light file\'s version');
      assert.equal($('cobrand-icon').dataset.shape, 'tile', 'a square logo is drawn as a tile');
      root.removeAttribute('data-theme'); // and its dark mode: the attribute gone
      await shell.tick();
      assert.deepEqual(drawn(), srcs.dark, 'dark: mode=dark, keyed by the dark variant\'s version');
    } finally {
      if (was === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', was);
      await shell.tick();
    }

    // Each of those URLs, asked of the daemon that sent the frames, served that
    // mode's image as uploaded.
    for (const [mode, png] of [['light', LOGO], ['dark', LOGO_DARK]]) {
      for (const url of Object.values(srcs[mode])) {
        const got = rec.served[url];
        assert.ok(got, `the recording asked the daemon for ${url}`);
        assert.deepEqual([got.status, got.type], [200, 'image/png'], url);
        assert.ok(got.bytes.equals(png), `${url} served the ${mode} logo's bytes`);
      }
    }
  });

  test('the stand-ins: the step, a chip and the phone tab each open an "Under development" note', async () => {
    const note = () => $('cs-tray');
    const shown = (el) => !!el && !el.classList.contains('hidden') && !el.hidden;

    shell.press($('cs-step'));
    assert.ok(shown(note()) && note().classList.contains('cs-dev'), 'the step opens the note');
    assert.equal(note().querySelector('.cs-dev-title').textContent, 'Under development');
    shell.key('Escape');
    assert.ok(!shown(note()));

    const chip = $('cs-chips').querySelector('.cs-devchip');
    assert.ok(chip, 'the chips stand in for the trays');
    shell.press(chip);
    assert.ok(shown(note()), `the ${chip.dataset.csCat} chip opens the note`);
    assert.equal(note().querySelector('.cs-dev-title').textContent, 'Under development');
    shell.key('Escape');

    shell.setViewport({ width: 390, height: 844 });
    await shell.tick();
    try {
      assert.equal($('chat-pull').hidden, false, 'on a phone the grip tab shows');
      shell.press($('chat-tab'));
      assert.ok(shown($('chat-sheet')), 'a tap opens its note');
      assert.equal($('chat-sheet').querySelector('h4').textContent, 'Under development');
      shell.key('Escape');
    } finally {
      shell.setViewport({ width: 1280, height: 800 });
      await shell.tick();
    }
  });

  test('restored, the shell leaves nothing behind: a file that boots main.js can exit', async () => {
    await shell.restore();
    const left = await waitUntil(() => excess(base).length === 0, { timeout: 5000, interval: 20 });
    assert.ok(left, `the boot left the loop held by: ${excess(base).join(', ')}`);
  });
});
