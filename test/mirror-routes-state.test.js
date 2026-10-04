// The chat mirror's state routes (lib/server/routes/mirror.js, design spec
// §2.10 "State"): GET /api/mirror and GET /api/mirror/status, on a bare
// Express app with a fake ctx, as §10.1 says route units are tested. The wired
// path is tranche 1's end-to-end check (U22a).
//
// The fakes. ctx.mirror is the part of the facade these routes read (§2.12:
// ready, enabled, status, snapshot), holding §2.10's shapes; its status rows
// come from the engine's own row builder (lib/server/mirror/emit statusRowOf).
// ctx.audience is §5.4's gate (levelOf, requireMirror) on the real level order
// and hints from lib/core/remote-policy: a plain loopback request is `local`,
// one carrying the portal's X-WC-Remote label gets its project's opt-in ('off'
// is `basic`), and a network peer is `basic` whatever it sends (Q9).
//
// What is pinned:
//   * at `read` and above, GET /api/mirror is the facade's snapshot under the
//     envelope the request decides (v, enabled, content, access), and nothing
//     else; below `read`, the basic body, every field typed;
//   * one basic projection: the rows, the aggregate and the asks a basic viewer
//     gets over HTTP are exactly what projectFrame gives a basic socket for
//     `mirror:status` and `mirror:ask`, a mistyped or unlisted field dropped
//     from both;
//   * GET /api/mirror/status is projected at every level below `local`;
//   * the disabled, unavailable and failure answers, the failure never carrying
//     the error's message, to the client or to the host's log;
//   * the gate: requireMirror('basic') in front of both routes, refusing no level
//     a viewer can have, and answering its hint where it would;
//   * the wait on mirror.ready, which is bounded;
//   * no path to a Claude Code file is ever returned;
//   * the chrome's one store (public/app/chat-state.js normalizeSnapshot) reads
//     every body as it is meant.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { pathToFileURL } = require('url');
const { request } = require('../lib/client');
const { waitUntil } = require('../test-support/helpers');
const {
  projectFrame, projectValue, atLeast, fromOptIn, MIRROR_HINT, MIRROR_FULL_HINT, STATUS_SCHEMA,
} = require('../lib/core/remote-policy');
const { isRemoteRequest } = require('../lib/core/cors');
const { userClaudePaths, claudeProjectSlug, redactHostPaths } = require('../lib/core/paths');
const { statusRowOf } = require('../lib/server/mirror/emit');
const {
  mountMirrorRoutes, BODY_VERSION, READY_WAIT_MS, SINCE_DEFAULT_MS,
} = require('../lib/server/routes/mirror');

const REPO_ROOT = path.resolve(__dirname, '..');

// The chrome's store, loaded as the browser loads it: its normalizers are pure.
let chatState;
test.before(async () => {
  chatState = await import(pathToFileURL(path.join(REPO_ROOT, 'public/app/chat-state.js')).href);
});

// ── fixtures ────────────────────────────────────────────────────────────────

// The facade's clock: months away from the wall clock, so a default that came
// from Date.now() instead would show.
const NOW = 1_780_000_000_000;
// Conversations are named by their first session id.
const CID = '0b6c1f4e-3f2a-4c7e-9d5b-2a1f8e6c4d10';
const CID2 = '7e2d9a40-1c3b-4f5e-8a6d-9b0c1d2e3f40';
const CID3 = 'c3a1e5d2-9f40-4b6e-8d7c-1a2b3c4d5e60';
const CID4 = 'd4b2f6e3-0a51-4c7f-9e8d-2b3c4d5e6f70';

// Live objects (§2.6), with their content fields (step.label, waiting.summary).
const LIVE = {
  working: { state: 'working', since: NOW - 12_000, quiet: null,
    step: { kind: 'Edit', tool: 'Edit', label: 'Edit · lib/core/paths.js', started_at: NOW - 3_000 },
    waiting: null, last_activity_at: NOW - 1_000, evidence: { hook_at: NOW - 1_000, proc: 'alive' } },
  waiting: { state: 'waiting', since: NOW - 5_000, quiet: null,
    step: { kind: 'Bash', tool: 'Bash', label: 'Bash · rm -rf dist && npm run build', started_at: NOW - 6_000 },
    waiting: { kind: 'permission', tool: 'Bash', summary: 'rm -rf dist && npm run build', pending: true },
    last_activity_at: NOW - 5_000 },
  mcp: { state: 'working', since: NOW - 9_000, quiet: { since: NOW - 2_000, reason: 'no-activity' },
    step: { kind: 'MCP', tool: 'mcp__github__create_issue', label: 'github · create_issue', started_at: NOW - 95_000 },
    last_activity_at: NOW - 95_000 },
  ended: { state: 'ended', since: NOW - 60_000, quiet: null, step: null, evidence: { proc: 'gone' },
    last_activity_at: NOW - 60_000 },
};

// StatusRows as the engine builds them: content-free by construction.
const ROWS = [
  statusRowOf(CID, LIVE.working, { shells: { running: 2, total: 3 }, agents: { running: 1, done: 0 } }),
  statusRowOf(CID2, LIVE.waiting, {}),
  statusRowOf(CID3, LIVE.mcp, { monitors: { running: 1, total: 1 } }),
  statusRowOf(CID4, LIVE.ended, {}),
];
const STATUS = { rev: 42, now: NOW, aggregate: { state: 'waiting' }, conversations: ROWS };

const CAPABILITIES = {
  answer: false, task_stop: false, queue_message: false, turn_diff: false, node_diff: false, attachments: false,
  agent_items: false, interrupt: false, code_revert: false, fork: false, mod: false, rewind_in_place: false,
};

// A Conversation (§2.10), its process able to take an injected Esc (§15.1).
const conversation = (id, live, extra = {}) => ({
  id, rev: 41, title: 'Fix the status bar', current_session_id: id, headless: false,
  sessions: [{ session_id: id, reason: 'start', started_at: NOW - 600_000 }],
  process: { pid: 4242, kind: 'interactive', entrypoint: 'cli', cc_version: '2.1.287', linked_by: 'hook',
    interrupt: 'tty', mod: false },
  model: 'claude-opus-5-5', permission_mode: 'default', mode: 'default',
  cost: { usd: null, source: null, tokens: { input: 1200, output: 340, cache_read: 0, cache_creation: 0 } },
  started_at: NOW - 600_000, last_activity_at: live.last_activity_at, away: null,
  live, turn_count: 3, open_turn_id: 'p_turn3', counts: { shells: 2, agents: 1, workflows: 0, monitors: 0 },
  diagnostics: { unknown_kinds: 0, bad_lines: 0, oversize_lines: 0, transcript: 'ok' },
  ...extra,
});

const TASK = {
  id: 'bx81k2', rev: 40, conversation_id: CID, kind: 'shell', title: 'npm run dev', status: 'running',
  started_at: NOW - 840_000, line: 'ready on http://localhost:5173', meta: { port: 5173 },
  turn_id: 'p_turn2', tool_use_id: 'toolu_01', can: { output: true, open: false, stop: true },
};

// AskPublic (§4.3): no subject, input, questions or plan, even at `local`.
const ASK = {
  id: 'ask_0123456789ab', conversation_id: CID2, kind: 'permission', tool_name: 'Bash', tool_kind: 'Bash',
  agent: null, created_at: NOW - 5_000, state: 'pending', answerable: false, outcome: null, via: null,
  tool_use_id: 'toolu_02', version: 1, masked: false,
};

// The facade's snapshot (§2.10) as it would answer a local viewer. Its own
// `access` is the facade's guess; the request decides the body's.
const SNAPSHOT = {
  v: 1, enabled: true, now: NOW, rev: 42, content: true,
  access: { level: 'local', remote: false },
  capabilities: CAPABILITIES,
  primary: CID2,
  aggregate: { state: 'waiting', conversations: 4 },
  conversations: [conversation(CID, LIVE.working), conversation(CID2, LIVE.waiting),
    conversation(CID3, LIVE.mcp), conversation(CID4, LIVE.ended, { ended_at: NOW - 60_000 })],
  tasks: [TASK],
  counts: { shells: { running: 2, total: 3 }, agents: { running: 1, done: 0 }, workflows: { running: 0, total: 0 },
    monitors: { running: 1, total: 1 } },
  asks: [ASK],
  diagnostics: { versions_seen: ['2.1.287'], tested: { min: '2.1.226', max: '2.1.287' }, skew: false,
    unknown_kinds: {}, bad_lines: 0, hooks: { last_at: NOW - 1_000, events_seen: 12 },
    sources: { sessions_dir: 'ok', mcp_rows: 1, git: 'ok' } },
};

// A facade that puts what it should not where a basic viewer could see it: a
// row's step label, an MCP tool's full name and a command in the typed fields,
// keys the schemas do not list, an ask's subject and input, a path for the
// primary, and text in the aggregate.
const DIRTY_STATUS = {
  ...STATUS,
  aggregate: { state: 'waiting', detail: 'Bash(rm -rf dist && npm run build)' },
  conversations: [
    { ...ROWS[0], label: 'Edit · lib/core/paths.js', step_kind: 'mcp__github__create_issue' },
    { ...ROWS[1], waiting_kind: 'Bash(rm -rf dist)', counts: { shells: 'two' }, since: String(NOW - 5_000) },
    { ...ROWS[2], title: 'Fix the status bar', last_activity_at: Infinity },
    { id: '../../.claude/projects/x/abc.jsonl', state: 'working' },
  ],
  diagnostics: { hooks: { last_at: NOW } },
};
const DIRTY_SNAPSHOT = {
  ...SNAPSHOT,
  primary: '/Users/me/.claude/projects/-Users-me-Dev-x/0b6c1f4e.jsonl',
  asks: [
    { ...ASK, tool_kind: 'mcp__github__create_issue', subject: 'rm -rf dist && npm run build',
      input: { command: 'rm -rf dist && npm run build' } },
    'not an ask',
    { ...ASK, id: 'ask with spaces', state: 'pending · Bash(rm -rf dist)' },
  ],
};

// ── fakes and the host ──────────────────────────────────────────────────────

// The facade, as far as these routes read it. Data fields may be functions
// (called per read) to answer per call, throw or reject.
function fakeMirror({ status = STATUS, snap = SNAPSHOT, on = { enabled: true }, ready = Promise.resolve() } = {}) {
  const m = {
    calls: [],
    statusBody: status,
    snap,
    on,
    ready,
    enabled() { m.calls.push(['enabled']); return m.on; },
    status() { m.calls.push(['status']); return typeof m.statusBody === 'function' ? m.statusBody() : m.statusBody; },
    snapshot(q) { m.calls.push(['snapshot', q]); return typeof m.snap === 'function' ? m.snap(q) : m.snap; },
  };
  return m;
}

// The audience gate as §5.4 specifies it (lib/server/audience), on the real
// level order and hints. `peer` makes every request a network peer's; `forced`
// stands for a level below basic, which no request can have, to show the gate
// refusing where it would.
function fakeAudience({ optIn = 'off' } = {}) {
  const a = {
    optIn,
    peer: null,
    forced: null,
    needs: [],
    levelOf(req) {
      if (a.forced) return a.forced;
      if (a.peer) return 'basic';
      return isRemoteRequest(req) ? fromOptIn(a.optIn) : 'local';
    },
    requireMirror(need) {
      a.needs.push(need);
      return (req, res, next) => {
        const level = a.levelOf(req);
        if (atLeast(level, need)) return next();
        return res.status(403).json({ ok: false, mirror: level, remote: isRemoteRequest(req),
          hint: need === 'full' ? MIRROR_FULL_HINT : MIRROR_HINT });
      };
    },
  };
  return a;
}

// The routes on a bare Express app, the way lib/server/index.js mounts them.
// `mirror: null` leaves ctx.mirror unset.
async function host(t, { mirror = fakeMirror(), audience = fakeAudience(), opts } = {}) {
  const app = express();
  app.use(express.json());
  const ctx = { audience };
  if (mirror) ctx.mirror = mirror;
  mountMirrorRoutes(app, ctx, opts);
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const { port } = srv.address();
  // Through lib/client, as a host process asks (no Origin); `remote` adds the
  // label the portal puts on every request it forwards.
  const get = (p, { remote = false } = {}) => request(port, 'GET', p, null,
    { headers: remote ? { 'X-WC-Remote': '1' } : {}, timeout: 30000 });
  return { get, mirror, audience, ctx };
}

// Each level a viewer can have, as a request reaches it: the opt-in the
// audience reads, and whether the request carries the portal's label.
const LEVELS = {
  local: { optIn: 'off', remote: false },
  basic: { optIn: 'off', remote: true },
  read: { optIn: 'read', remote: true },
  full: { optIn: 'full', remote: true },
};
async function getAt(h, level, p) {
  h.audience.optIn = LEVELS[level].optIn;
  return h.get(p, { remote: LEVELS[level].remote });
}

const ENVELOPE = (level) => ({ v: 1, enabled: true, content: true, access: { level, remote: LEVELS[level].remote } });
const snapshotCalls = (m) => m.calls.filter((c) => c[0] === 'snapshot').map((c) => c[1]);
const facadeReads = (m) => m.calls.filter((c) => c[0] === 'status' || c[0] === 'snapshot').length;
// A frame's basic projection as a body: its `type` swapped for the body's `v`.
function frameBody(frame) {
  const { type, ...rest } = projectFrame(frame, 'basic');
  assert.equal(type, frame.type);
  return { v: BODY_VERSION, ...rest };
}

// ── GET /api/mirror ─────────────────────────────────────────────────────────

test('GET /api/mirror at local, read and full: the facade\'s snapshot under the request\'s envelope, and nothing else', async (t) => {
  const h = await host(t);
  for (const level of ['local', 'read', 'full']) {
    const r = await getAt(h, level, '/api/mirror');
    assert.equal(r.status, 200, level);
    assert.deepStrictEqual(r.body, { ...SNAPSHOT, ...ENVELOPE(level) }, level);
  }
  // Each read asked the facade at the viewer's level, for the last day by the
  // facade's own clock.
  assert.deepStrictEqual(snapshotCalls(h.mirror), ['local', 'read', 'full']
    .map((level) => ({ level, since: NOW - SINCE_DEFAULT_MS })));
  // §2.10's shapes ride through: the process's Esc probe and the control
  // layer's capabilities among them.
  const local = (await h.get('/api/mirror')).body;
  assert.equal(local.conversations[0].process.interrupt, 'tty');
  assert.deepStrictEqual(Object.keys(local.capabilities).sort(), Object.keys(CAPABILITIES).sort());
  assert.ok(['interrupt', 'code_revert', 'fork', 'mod', 'rewind_in_place'].every((k) => local.capabilities[k] === false));
});

test('GET /api/mirror below read: the basic body — typed, a mistyped or unlisted field dropped', async (t) => {
  const h = await host(t, { mirror: fakeMirror({ status: DIRTY_STATUS, snap: DIRTY_SNAPSHOT }) });
  const r = await getAt(h, 'basic', '/api/mirror');
  assert.equal(r.status, 200);
  const b = r.body;
  assert.deepStrictEqual(Object.keys(b).sort(),
    ['access', 'aggregate', 'asks', 'content', 'conversations', 'enabled', 'now', 'primary', 'rev', 'v']);
  assert.equal(b.v, 1);
  assert.equal(b.enabled, true);
  assert.equal(b.content, false);
  assert.deepStrictEqual(b.access, { level: 'basic', remote: true });
  assert.equal(b.now, NOW);
  assert.equal(b.rev, 42);
  assert.deepStrictEqual(b.aggregate, { state: 'waiting' }, 'the aggregate\'s text is dropped');
  assert.equal(b.primary, null, 'a primary that is not an id is dropped');

  // The rows: what is typed and listed stays; the rest is gone.
  const [working, waiting, mcp, odd] = b.conversations;
  assert.deepStrictEqual(working, (({ step_kind, ...row }) => row)(ROWS[0]),
    'an MCP tool\'s full name is no step kind, and the label is no StatusRow field');
  assert.deepStrictEqual(waiting, (({ waiting_kind, counts, since, ...row }) => row)(ROWS[1]),
    'a command is no waiting kind; counts must be integers; since must be a number');
  assert.deepStrictEqual(mcp, (({ last_activity_at, ...row }) => row)(ROWS[2]),
    'the title is no StatusRow field, and a time must be finite');
  assert.equal(mcp.step_kind, 'MCP', 'every MCP tool is one step kind');
  assert.deepStrictEqual(odd, { state: 'working' }, 'a path is no id');

  // The asks: kind, state and ids only, typed.
  assert.deepStrictEqual(b.asks, [
    { id: ASK.id, conversation_id: CID2, kind: 'permission', state: 'pending' },
    { conversation_id: CID2, kind: 'permission', tool_kind: 'Bash' },
  ], 'the subject, input and tool name are dropped; an MCP tool kind, a spaced id and a worded state too; a non-object is no ask');

  // Nothing of the content reached the body.
  const text = JSON.stringify(b);
  for (const s of ['paths.js', 'rm -rf', 'mcp__', 'Fix the status bar', 'Bash(', '.jsonl', '/Users/']) {
    assert.ok(!text.includes(s), `the basic body carries ${JSON.stringify(s)}: ${text}`);
  }
  // The facade was asked at the viewer's level, by its own clock.
  assert.deepStrictEqual(snapshotCalls(h.mirror), [{ level: 'basic', since: NOW - SINCE_DEFAULT_MS }]);
});

test('one basic projection: what a basic viewer gets over HTTP is what projectFrame gives a basic socket', async (t) => {
  for (const [status, snap] of [[STATUS, SNAPSHOT], [DIRTY_STATUS, DIRTY_SNAPSHOT]]) {
    const h = await host(t, { mirror: fakeMirror({ status, snap }) });
    const frame = frameBody({ type: 'mirror:status', ...status });
    // GET /api/mirror/status is the status frame's projection, byte for byte.
    const st = (await getAt(h, 'basic', '/api/mirror/status')).body;
    assert.deepStrictEqual(st, frame);
    // GET /api/mirror carries the same rows, aggregate, rev and now…
    const b = (await getAt(h, 'basic', '/api/mirror')).body;
    for (const k of ['rev', 'now', 'aggregate', 'conversations']) assert.deepStrictEqual(b[k], frame[k], k);
    // …and each ask as a basic socket's `mirror:ask` frame carries it.
    const asks = snap.asks.filter((a) => a !== null && typeof a === 'object' && !Array.isArray(a))
      .map((ask) => projectFrame({ type: 'mirror:ask', op: 'open', ask }, 'basic').ask);
    assert.deepStrictEqual(b.asks, asks);
  }
  // The schema is the one FRAME_RULES holds for mirror:status, by name.
  assert.deepStrictEqual(frameBody({ type: 'mirror:status', ...STATUS }),
    { v: BODY_VERSION, ...projectValue(STATUS_SCHEMA, STATUS) });
});

test('GET /api/mirror?since: milliseconds pass to the facade; anything else is its clock less a day', async (t) => {
  const h = await host(t);
  const r = await h.get('/api/mirror?since=1700000000000');
  assert.equal(r.status, 200);
  for (const bad of ['abc', '-5', '1e3', '', '12.5', '0x10', '99999999999999999', 'since=1&since=2']) {
    const q = bad.startsWith('since=') ? bad : `since=${encodeURIComponent(bad)}`;
    assert.equal((await h.get(`/api/mirror?${q}`)).status, 200, bad);
  }
  assert.equal((await h.get('/api/mirror')).status, 200);
  const sinces = snapshotCalls(h.mirror).map((q) => q.since);
  assert.deepStrictEqual(sinces, [1700000000000, ...Array(9).fill(NOW - SINCE_DEFAULT_MS)]);
  assert.equal(SINCE_DEFAULT_MS, 24 * 60 * 60 * 1000, 'the default is the last 24 hours');
});

// ── GET /api/mirror/status ─────────────────────────────────────────────────

test('GET /api/mirror/status: projected at every level below local; the facade\'s status at local', async (t) => {
  const h = await host(t, { mirror: fakeMirror({ status: DIRTY_STATUS }) });
  const projected = frameBody({ type: 'mirror:status', ...DIRTY_STATUS });
  for (const level of ['basic', 'read', 'full']) {
    const r = await getAt(h, level, '/api/mirror/status');
    assert.equal(r.status, 200, level);
    assert.deepStrictEqual(r.body, projected, level);
    assert.ok(!JSON.stringify(r.body).includes('paths.js'), level);
  }
  // A local viewer is never projected: the status as the facade answers it.
  const local = await getAt(h, 'local', '/api/mirror/status');
  assert.equal(local.status, 200);
  assert.deepStrictEqual(local.body, { v: 1, ...JSON.parse(JSON.stringify(DIRTY_STATUS)) });
  // A clean status is the same at every level: StatusRows are content-free by
  // construction, and the projection is the second lock, never the first.
  const clean = await host(t);
  const want = { v: 1, ...STATUS };
  for (const level of Object.keys(LEVELS)) {
    assert.deepStrictEqual((await getAt(clean, level, '/api/mirror/status')).body, want, level);
  }
  assert.equal(snapshotCalls(clean.mirror).length, 0, 'the status route reads only the status');
});

// ── the answers every mirror route shares ──────────────────────────────────

test('disabled: 200 {ok:false, disabled:true, scope, hint}, the hint naming the command that turns it on', async (t) => {
  const mirror = fakeMirror();
  const h = await host(t, { mirror });
  for (const [scope, hint] of [
    ['project', 'web-chat is off for this project — on the host: claude-web-chat on'],
    ['user', 'web-chat is off on this machine — on the host: claude-web-chat on --global'],
    ['Bash(rm -rf /)', 'web-chat is off for this project — on the host: claude-web-chat on'],
    [undefined, 'web-chat is off for this project — on the host: claude-web-chat on'],
  ]) {
    mirror.on = { enabled: false, scope };
    const want = { ok: false, disabled: true, scope: scope === 'project' || scope === 'user' ? scope : null, hint };
    for (const level of Object.keys(LEVELS)) {
      for (const p of ['/api/mirror', '/api/mirror/status']) {
        const r = await getAt(h, level, p);
        assert.equal(r.status, 200, `${p} at ${level}`);
        assert.deepStrictEqual(r.body, want, `${p} at ${level}`);
      }
    }
  }
  assert.equal(facadeReads(mirror), 0, 'a switched-off mirror is not read');

  // A facade whose enabled() answers a promise is waited on, never taken for
  // "enabled" because a promise is an object.
  const later = fakeMirror();
  later.enabled = async () => ({ enabled: false, scope: 'project' });
  const h2 = await host(t, { mirror: later });
  for (const p of ['/api/mirror', '/api/mirror/status']) {
    assert.deepStrictEqual((await h2.get(p)).body, { ok: false, disabled: true, scope: 'project',
      hint: 'web-chat is off for this project — on the host: claude-web-chat on' }, p);
  }
  assert.equal(facadeReads(later), 0);
});

test('unavailable: 503 {ok:false, unavailable:true} with no mirror wired, or when the facade answers or rejects unavailable', async (t) => {
  const want = { ok: false, unavailable: true };
  const unavailable = () => Object.assign(new Error('the transcripts source is not registered'), { code: 'unavailable' });
  const cases = [
    ['no mirror wired', null],
    ['the status answers unavailable', fakeMirror({ status: { unavailable: true } })],
    ['the status rejects unavailable', fakeMirror({ status: () => Promise.reject(unavailable()) })],
    ['the snapshot answers unavailable', fakeMirror({ snap: { unavailable: true } })],
    ['the snapshot rejects unavailable', fakeMirror({ snap: () => Promise.reject(unavailable()) })],
  ];
  for (const [what, mirror] of cases) {
    const h = await host(t, { mirror });
    const paths = what.startsWith('the snapshot') ? ['/api/mirror'] : ['/api/mirror', '/api/mirror/status'];
    for (const level of ['local', 'basic']) {
      for (const p of paths) {
        const r = await getAt(h, level, p);
        assert.equal(r.status, 503, `${what}: ${p} at ${level}`);
        assert.deepStrictEqual(r.body, want, `${what}: ${p} at ${level}`);
      }
    }
  }
  // A snapshot answer the status route never reads is no reason to refuse it.
  const h = await host(t, { mirror: fakeMirror({ snap: { unavailable: true } }) });
  assert.equal((await h.get('/api/mirror/status')).status, 200);
});

test('a facade that throws: 500 that says the mirror could not answer — never the error\'s message, in the body or the log', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const secret = '/Users/me/.claude/projects/-Users-me-Dev-x/0b6c1f4e.jsonl';
  const enoent = () => Object.assign(new Error(`ENOENT: no such file or directory, open '${secret}'`), { code: 'ENOENT' });
  const cases = [
    ['GET /api/mirror', fakeMirror({ snap: () => { throw enoent(); } }), '/api/mirror', 'ENOENT'],
    ['GET /api/mirror', fakeMirror({ snap: () => Promise.reject(enoent()) }), '/api/mirror', 'ENOENT'],
    ['GET /api/mirror/status', fakeMirror({ status: () => { throw new TypeError(`cannot read ${secret}`); } }),
      '/api/mirror/status', 'TypeError'],
    // A code that is not a word is not logged either: the class stands in.
    ['GET /api/mirror', fakeMirror({ snap: () => { throw Object.assign(new RangeError(secret), { code: secret }); } }),
      '/api/mirror', 'RangeError'],
    // An answer that is not an object is a failure, not a body.
    ['GET /api/mirror', fakeMirror({ snap: [secret] }), '/api/mirror', 'TypeError'],
    ['GET /api/mirror/status', fakeMirror({ status: secret }), '/api/mirror/status', 'TypeError'],
  ];
  for (const [route, mirror, p, word] of cases) {
    const h = await host(t, { mirror });
    for (const level of ['local', 'basic']) {
      const before = logged.mock.callCount();
      const r = await getAt(h, level, p);
      assert.equal(r.status, 500, `${route} at ${level}`);
      assert.deepStrictEqual(r.body, { ok: false, error: 'the chat mirror could not answer' });
      assert.equal(logged.mock.callCount(), before + 1, 'one line in the host\'s log');
      const line = logged.mock.calls[before].arguments.join(' ');
      assert.equal(line, `[web-chat] ${route}: the chat mirror could not answer (${word})`);
    }
  }
});

// ── the gate ────────────────────────────────────────────────────────────────

test('the gate: requireMirror(\'basic\') fronts both routes, refuses no level a viewer can have, answers its hint where it would', async (t) => {
  const h = await host(t);
  assert.ok(h.audience.needs.length >= 1, 'the routes asked the audience for a gate');
  assert.deepStrictEqual([...new Set(h.audience.needs)], ['basic'], 'every gate is requireMirror(\'basic\')');

  // Every level a viewer can have passes it, on both routes.
  for (const level of Object.keys(LEVELS)) {
    for (const p of ['/api/mirror', '/api/mirror/status']) {
      assert.equal((await getAt(h, level, p)).status, 200, `${p} at ${level}`);
    }
  }
  // A network peer is held to basic whatever it sends (Q9), and is answered
  // the basic body, not refused. `remote` is the portal's label and nothing
  // else, as the socket's is (§5.4: ws._wc.remote = isRemoteRequest(req)), so
  // the body and the `mirror:access` frames agree about one viewer.
  h.audience.peer = '10.0.0.7';
  for (const remote of [true, false]) {
    h.audience.optIn = 'full';
    const peer = await h.get('/api/mirror', { remote });
    assert.equal(peer.status, 200);
    assert.equal(peer.body.content, false);
    assert.deepStrictEqual(peer.body.access, { level: 'basic', remote });
  }
  h.audience.peer = null;

  // Where it would refuse — a level below basic, which no request can have —
  // both routes answer the gate's 403 and its hint, and the facade is not read.
  h.audience.forced = 'off';
  const reads = facadeReads(h.mirror);
  for (const p of ['/api/mirror', '/api/mirror/status']) {
    for (const remote of [false, true]) {
      const r = await h.get(p, { remote });
      assert.equal(r.status, 403, p);
      assert.deepStrictEqual(r.body, { ok: false, mirror: 'off', remote, hint: MIRROR_HINT }, p);
    }
  }
  assert.equal(facadeReads(h.mirror), reads, 'a refused request never reaches the facade');
});

test('mountMirrorRoutes refuses to mount without the audience: the mirror is never served ungated', () => {
  for (const ctx of [undefined, {}, { mirror: fakeMirror() }, { audience: { levelOf() {} } },
    { audience: { requireMirror() { return (q, s, n) => n(); } } }]) {
    assert.throws(() => mountMirrorRoutes(express(), ctx), /ctx\.audience/);
  }
});

// ── mirror.ready ────────────────────────────────────────────────────────────

test('mirror.ready: a route waits for it, at most READY_WAIT_MS, and a failed start does not hold it', async (t) => {
  assert.equal(READY_WAIT_MS, 2000, 'spec §2.12: routes wait on it at most 2 s');

  // Pending: nothing is read until it settles. The bound is set far out, so
  // only the resolve can release the request.
  let resolve;
  let touched = 0;
  const pending = new Promise((r) => { resolve = r; });
  const mirror = fakeMirror();
  Object.defineProperty(mirror, 'ready', { get() { touched++; return pending; } });
  const h = await host(t, { mirror, opts: { readyWaitMs: 60_000 } });
  const answer = Promise.all([h.get('/api/mirror'), h.get('/api/mirror/status')]);
  await waitUntil(() => touched >= 2, { timeout: 20_000, what: 'both routes to reach mirror.ready' });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(mirror.calls, [], 'the facade is not read before it is ready');
  resolve();
  const [snap, status] = await answer;
  assert.equal(snap.status, 200);
  assert.equal(status.status, 200);
  assert.deepStrictEqual(snap.body, { ...SNAPSHOT, ...ENVELOPE('local') });

  // Never settling: the route answers what the facade holds once the bound passes.
  const stuck = await host(t, { mirror: fakeMirror({ ready: new Promise(() => {}) }), opts: { readyWaitMs: 20 } });
  const late = await stuck.get('/api/mirror');
  assert.equal(late.status, 200);
  assert.deepStrictEqual(late.body, { ...SNAPSHOT, ...ENVELOPE('local') });
  assert.equal((await stuck.get('/api/mirror/status')).status, 200);

  // Rejected: the same, and the start's error goes nowhere.
  const failed = Promise.reject(new Error('start failed reading /Users/me/.claude/sessions/4242.json'));
  failed.catch(() => {});
  const broken = await host(t, { mirror: fakeMirror({ ready: failed }) });
  const r = await getAt(broken, 'basic', '/api/mirror');
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.body).includes('sessions'), JSON.stringify(r.body));
});

// ── no path to a Claude Code file ───────────────────────────────────────────

test('no path to a Claude Code file is ever returned, whatever the facade holds below read and however it fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  const claude = userClaudePaths();
  const projectDir = claude.projectDir(REPO_ROOT);
  const transcript = path.join(projectDir, `${CID}.jsonl`);
  const toolResult = path.join(projectDir, CID, 'tool-results', 'toolu_01.txt');
  const agentFile = path.join(projectDir, CID, 'subagents', 'agent-a1b2c3.jsonl');
  const taskOutput = `/private/tmp/claude-501/${claudeProjectSlug(REPO_ROOT)}/${CID}/tasks/bx81k2.output`;
  const sessionsFile = claude.claudeSessionStateFile(4242);
  const masked = redactHostPaths(transcript);
  assert.ok(masked.startsWith('~'), `the sandbox's Claude home is under its HOME: ${masked}`);
  const FILES = [transcript, toolResult, agentFile, taskOutput, sessionsFile, masked];

  // A facade that holds those paths everywhere a careless one might put them.
  const leakyRow = (row, i) => ({ ...row, transcript_path: FILES[i % FILES.length], step_kind: toolResult, id: transcript });
  const LEAKY_STATUS = {
    ...STATUS, transcript_path: transcript, files: FILES,
    aggregate: { state: 'working', file: masked },
    conversations: [...ROWS.map(leakyRow), ...ROWS],
  };
  const LEAKY_SNAPSHOT = {
    ...SNAPSHOT, primary: transcript, transcripts: { [CID]: transcript }, outputs: [taskOutput],
    asks: [{ ...ASK, plan_file: masked, persistedOutputPath: toolResult, tool_kind: taskOutput, id: sessionsFile }, ASK],
  };
  const carries = (text) => FILES.filter((f) => text.includes(f))
    .concat(['.jsonl', '.output', 'tool-results', 'subagents', 'sessions/'].filter((s) => text.includes(s)));

  const h = await host(t, { mirror: fakeMirror({ status: LEAKY_STATUS, snap: LEAKY_SNAPSHOT }) });
  for (const level of ['basic', 'read', 'full']) {
    const st = await getAt(h, level, '/api/mirror/status');
    assert.equal(st.status, 200);
    assert.deepStrictEqual(carries(JSON.stringify(st.body)), [], `GET /api/mirror/status at ${level}`);
    assert.equal(st.body.conversations.length, ROWS.length * 2, 'the clean rows still arrive');
  }
  const basic = await getAt(h, 'basic', '/api/mirror');
  assert.equal(basic.status, 200);
  assert.deepStrictEqual(carries(JSON.stringify(basic.body)), [], 'GET /api/mirror below read');
  assert.deepStrictEqual(basic.body.asks[1], projectValue({ id: 'id', conversation_id: 'id', kind: 'word',
    tool_kind: 'word', state: 'word' }, ASK), 'a clean ask still arrives');

  // However the facade fails — a thrown error, a rejection, a failed start —
  // the error's text naming the file goes nowhere.
  const enoent = (f) => Object.assign(new Error(`ENOENT: no such file or directory, open '${f}'`), { code: 'ENOENT' });
  const failedStart = Promise.reject(enoent(sessionsFile));
  failedStart.catch(() => {});
  const failing = [
    fakeMirror({ snap: () => { throw enoent(transcript); }, status: () => { throw enoent(taskOutput); } }),
    fakeMirror({ snap: () => Promise.reject(enoent(toolResult)), status: () => Promise.reject(enoent(agentFile)) }),
    fakeMirror({ ready: failedStart }),
  ];
  for (const mirror of failing) {
    const fh = await host(t, { mirror });
    for (const level of Object.keys(LEVELS)) {
      for (const p of ['/api/mirror', '/api/mirror/status']) {
        const r = await getAt(fh, level, p);
        assert.deepStrictEqual(carries(JSON.stringify(r.body)), [], `${p} at ${level} → ${r.status}`);
      }
    }
  }
  for (const call of console.error.mock.calls) {
    assert.deepStrictEqual(carries(call.arguments.join(' ')), [], 'the host\'s log line names no file');
  }
});

test('at read and above the route adds nothing but the envelope, and opens nothing: it requires only the policy and the label', async (t) => {
  // The facade's body passes under v, enabled, content and access; every
  // other key is the facade's, whose read boundary redacts it and holds no
  // path the engine read (§2.9). So no path can come from the route itself.
  const h = await host(t);
  for (const level of ['local', 'read', 'full']) {
    const body = (await getAt(h, level, '/api/mirror')).body;
    const added = Object.keys(body).filter((k) => !(k in SNAPSHOT));
    assert.deepStrictEqual(added, [], level);
    for (const k of Object.keys(SNAPSHOT)) {
      if (!['v', 'enabled', 'content', 'access'].includes(k)) assert.deepStrictEqual(body[k], SNAPSHOT[k], `${level}: ${k}`);
    }
  }
  const src = fs.readFileSync(path.join(REPO_ROOT, 'lib/server/routes/mirror.js'), 'utf8');
  const requires = [...src.matchAll(/require\(\s*(['"`])([^'"`]+)\1\s*\)/g)].map((m) => m[2]).sort();
  assert.deepStrictEqual(requires, ['../../core/cors', '../../core/remote-policy'],
    'the state routes read the facade and nothing else: no fs, no lib/core/claude-files');
});

// ── the consumer ────────────────────────────────────────────────────────────

test('the chrome\'s one store reads each body as it is meant (public/app/chat-state.js normalizeSnapshot)', async (t) => {
  const h = await host(t);
  const { normalizeSnapshot } = chatState;

  const local = normalizeSnapshot((await h.get('/api/mirror')).body);
  assert.equal(local.disabled, false);
  assert.equal(local.content, true);
  assert.deepStrictEqual(local.access, { level: 'local', remote: false });
  assert.equal(local.primary, CID2);
  assert.deepStrictEqual(local.conversations.map((c) => c.id), [CID, CID2, CID3, CID4]);
  assert.equal(local.conversations[0].process.interrupt, 'tty');
  assert.equal(local.conversations[0].live.step.label, 'Edit · lib/core/paths.js');
  assert.deepStrictEqual(local.tasks.map((x) => x.id), [TASK.id]);
  assert.deepStrictEqual(local.asks.map((a) => a.tool_name), ['Bash']);
  assert.equal(local.rev, 42);

  const basic = normalizeSnapshot((await getAt(h, 'basic', '/api/mirror')).body);
  assert.equal(basic.disabled, false);
  assert.equal(basic.content, false);
  assert.deepStrictEqual(basic.access, { level: 'basic', remote: true });
  assert.equal(basic.primary, CID2);
  assert.deepStrictEqual(basic.conversations, [], 'below read the store holds no Conversation');
  assert.deepStrictEqual(basic.status.map((r) => [r.id, r.state, r.step_kind || null, r.waiting_kind || null]), [
    [CID, 'working', 'Edit', null], [CID2, 'waiting', 'Bash', 'permission'], [CID3, 'working', 'MCP', null],
    [CID4, 'ended', null, null],
  ]);
  assert.equal(basic.status[3].ended_reason, 'process-gone');
  assert.deepStrictEqual(basic.tasks, []);
  assert.deepStrictEqual(basic.asks.map((a) => [a.id, a.kind, a.state, a.tool_name]), [[ASK.id, 'permission', 'pending', undefined]]);
  assert.equal(basic.aggregate.state, 'waiting');

  h.mirror.on = { enabled: false, scope: 'user' };
  const off = normalizeSnapshot((await h.get('/api/mirror')).body);
  assert.deepStrictEqual({ ...off }, { disabled: true, hint: 'web-chat is off on this machine — on the host: claude-web-chat on --global',
    scope: 'user' });
});
