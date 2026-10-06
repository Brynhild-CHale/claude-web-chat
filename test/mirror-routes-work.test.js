// The chat mirror's work and code routes (lib/server/routes/mirror-tasks.js and
// lib/server/routes/mirror-code.js, design spec §2.10 "Work and code"): the task
// rows, a task's output, an agent's stream, a workflow's detail, a turn's or a
// node's diff, a node's turns and every node's counts, on a bare Express app
// with a fake ctx, as §10.1 says route units are tested. Tranche 3's
// integration (U51) mounts them.
//
// The fakes. ctx.mirror is the part of the facade these routes read (§2.12:
// ready, enabled, status, tasks, taskOutput, agent, workflow, diff, nodeTurns,
// nodeSummaries — tasks, nodeTurns and nodeSummaries sync, the rest Promises);
// each answers what the test hands it, and every call is logged in order so the
// test can see that `rev` was read before the dispatched call. ctx.audience is
// §5.4's gate on the real level order and hints (lib/core/remote-policy); one
// test also runs the real lib/server/audience.
//
// What is pinned:
//   * each route answers the facade's value in §2.10's shape, cut to its keys,
//     with `rev` from status() read before the call — /tasks with the facade's
//     own rev;
//   * the facade receives exactly the parsed query;
//   * every query parameter's default, its bounds, and a 400 for each malformed
//     value or wrong pairing — before the facade is asked anything; an id or
//     ref over 128 characters is 404;
//   * null → 404; {unavailable:true}, a rejection coded 'unavailable' and no
//     mirror at all → 503; disabled → 200 with the hint; a throw → 500 that
//     names no file, to the client or the host's log;
//   * the gate: requireMirror('read') in front of all eight, refusing a remote
//     viewer below `read` with the hint and letting a local one through; the
//     portal's table (classify) agrees with no row of these modules' own;
//   * no path to a Claude Code file is ever returned;
//   * both modules require only routes/mirror.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { request } = require('../lib/client');
const {
  atLeast, fromOptIn, classify, RULES, MIRROR_HINT, MIRROR_FULL_HINT,
} = require('../lib/core/remote-policy');
const { isRemoteRequest } = require('../lib/core/cors');
const { createAudience } = require('../lib/server/audience');
const { disabledBody } = require('../lib/server/routes/mirror');
const {
  mountMirrorTasksRoutes, ID_MAX, OUTPUT_MAX, AGENT_LIMIT_DEFAULT, AGENT_LIMIT_MAX,
} = require('../lib/server/routes/mirror-tasks');
const {
  mountMirrorCodeRoutes, ID_MAX: CODE_ID_MAX, CONTEXT_DEFAULT, CONTEXT_MAX, DIFF_KEYS,
} = require('../lib/server/routes/mirror-code');

const REPO_ROOT = path.resolve(__dirname, '..');
const MODULES = ['lib/server/routes/mirror-tasks.js', 'lib/server/routes/mirror-code.js'];

// ── fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_780_000_000_000;
const CID = '0b6c1f4e-3f2a-4c7e-9d5b-2a1f8e6c4d10';
const TURN_ID = 'p_7f3a9c0d2e1b';
const TASK_ID = 'bx81k2';
const AGENT_ID = 'a3f9c2e1b0d4';
const RUN_ID = 'wf_5e2d1c0b';
const NODE_ID = 'n_8c1e2f';
const NODE_REF = 'n1.7';

const SHELL_ROW = {
  id: TASK_ID, rev: 5, conversation_id: CID, kind: 'shell', title: 'npm test', status: 'running',
  started_at: NOW - 60_000, line: 'ok 12 - passes', meta: { no_output_yet: false },
  turn_id: TURN_ID, tool_use_id: 'toolu_01', can: { output: true, open: true, stop: false },
};
const AGENT_ROW = { ...SHELL_ROW, id: AGENT_ID, kind: 'agent', title: 'Explore the routes', line: 'Read lib/server' };
const WF_ROW = { ...SHELL_ROW, id: RUN_ID, kind: 'workflow', title: 'build', steps: [{ label: 'Plan', state: 'done' }] };
const COUNTS = {
  shells: { running: 1, total: 2 }, agents: { running: 1, done: 0 },
  workflows: { running: 1, total: 1 }, monitors: { running: 0, total: 0 },
};
const ITEM = { id: 'i_a3f9_1', kind: 'tool_call', tool: 'Read', status: 'done', seq: 1.5 };

const TASKS_BODY = { tasks: [SHELL_ROW, AGENT_ROW, WF_ROW], counts: COUNTS, rev: 77 };
const OUTPUT_BODY = {
  task_id: TASK_ID, text: 'ok 1 - passes\n', from: 0, to: 14, size: 14, eof: true, ended: true,
  footer: 'exited 0', exit_code: 0,
};
const AGENT_BODY = { agent: AGENT_ROW, items: [ITEM], next_before: 1.5 };
const WORKFLOW_BODY = {
  workflow: WF_ROW, phases: [{ title: 'Plan', state: 'done' }, { title: 'Build', state: 'running' }],
  agents: [{ agent_id: AGENT_ID, key: 'k1', label: 'planner', phase: 'Plan', state: 'done', attempt: 1, tools: 4,
    last_tool: 'Read', model: 'opus', started_at: NOW - 50_000, ended_at: NOW - 40_000 }],
};
const DIFF_RECORD = {
  v: 1, turn_id: TURN_ID, conversation_id: CID, status: 'ready',
  before: { tree: 'a'.repeat(40), at: NOW - 60_000, source: 'turn-open' }, after: { tree: 'b'.repeat(40), at: NOW - 1000 },
  files: [{ path: 'lib/a.js', status: 'M', additions: 3, deletions: 1, binary: false }],
  totals: { files: 1, additions: 3, deletions: 1 },
  patch: 'diff --git a/lib/a.js b/lib/a.js\n@@ -1 +1,3 @@\n-x\n+y\n+z\n+w\n', patch_truncated: false,
  flags: { concurrent_sessions: false, before_racy: false, skipped_large_untracked: [] },
  outside: null, attr_exact: true, created_at: NOW,
};
const { patch: _patch, ...RECORD_NO_PATCH } = DIFF_RECORD;
const NODE_DIFF_BODY = { node: { id: NODE_ID, label: NODE_REF }, turns: [RECORD_NO_PATCH], combined: DIFF_RECORD };
const TURN_HEADER = { id: TURN_ID, conversation_id: CID, seq: 7, kind: 'prompt', status: 'closed', role: 'commit' };
const NODE_BODY = { node: { id: NODE_ID, label: NODE_REF }, turns: [TURN_HEADER] };
const NODES_BODY = { nodes: { [NODE_ID]: { turns: 2, superseded: 1, rewound_at: NOW - 5000 }, n_9: { turns: 1, superseded: 0 } } };

const STATUS = { rev: 42, now: NOW, aggregate: { state: 'idle' }, conversations: [] };

// The facade methods, which of them are sync, and the default answer of each.
const SYNC = new Set(['tasks', 'nodeTurns', 'nodeSummaries']);
const ANSWERS = {
  tasks: TASKS_BODY, taskOutput: OUTPUT_BODY, agent: AGENT_BODY, workflow: WORKFLOW_BODY,
  diff: (q) => (q.turn !== undefined ? DIFF_RECORD : NODE_DIFF_BODY), nodeTurns: NODE_BODY, nodeSummaries: NODES_BODY,
};
const METHODS = Object.keys(ANSWERS);

// ── fakes and the host ──────────────────────────────────────────────────────

// The facade. Each answer may be a function of the call's arguments (to answer
// per call, throw or reject). `calls` logs every read in order.
function fakeMirror({ status = STATUS, on = { enabled: true }, ready = Promise.resolve(), ...over } = {}) {
  const answer = (v, args) => (typeof v === 'function' ? v(...args) : v);
  const m = { calls: [], answers: { status, ...ANSWERS, ...over }, on, ready };
  m.enabled = () => { m.calls.push(['enabled']); return m.on; };
  m.status = () => { m.calls.push(['status']); return answer(m.answers.status, []); };
  for (const name of METHODS) {
    m[name] = (...args) => {
      m.calls.push([name, ...args]);
      if (SYNC.has(name)) return answer(m.answers[name], args);
      return Promise.resolve().then(() => answer(m.answers[name], args));
    };
  }
  return m;
}
const workCalls = (m) => m.calls.filter((c) => !['enabled', 'status'].includes(c[0]));

// §5.4's gate on the real level order and hints: a plain loopback request is
// `local`; one with the portal's label gets the project's opt-in ('off' is
// `basic`).
function fakeAudience({ optIn = 'off' } = {}) {
  const a = {
    optIn,
    needs: [],
    levelOf(req) { return isRemoteRequest(req) ? fromOptIn(a.optIn) : 'local'; },
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

async function host(t, { mirror = fakeMirror(), audience = fakeAudience(), opts } = {}) {
  const app = express();
  app.use(express.json());
  const ctx = { audience };
  if (mirror) ctx.mirror = mirror;
  mountMirrorTasksRoutes(app, ctx, opts);
  mountMirrorCodeRoutes(app, ctx, opts);
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const { port } = srv.address();
  // JSON through lib/client, as a host process asks; `remote` adds the label
  // the portal puts on every request it forwards.
  const get = (p, { remote = false } = {}) => request(port, 'GET', p, null,
    { headers: remote ? { 'X-WC-Remote': '1' } : {}, timeout: 30000 });
  return { get, mirror, audience, ctx };
}

const enc = encodeURIComponent;
const TASKS_URL = '/api/mirror/tasks';
const OUTPUT_URL = `/api/mirror/tasks/${TASK_ID}/output`;
const AGENT_URL = `/api/mirror/agents/${AGENT_ID}`;
const WORKFLOW_URL = `/api/mirror/workflows/${RUN_ID}`;
const DIFF_TURN_URL = `/api/mirror/diff?turn=${TURN_ID}`;
const DIFF_NODE_URL = `/api/mirror/diff?node=${NODE_REF}`;
const NODE_URL = `/api/mirror/node/${NODE_REF}`;
const NODES_URL = '/api/mirror/nodes';

// The eight routes: the facade call each makes with no parameters, its body
// and the keys of that body.
const ROUTES = [
  { url: TASKS_URL, method: 'tasks', call: ['tasks'], body: TASKS_BODY, ownRev: true },
  { url: OUTPUT_URL, method: 'taskOutput', call: ['taskOutput', TASK_ID, { from: 0, max: OUTPUT_MAX, tail: null }],
    body: OUTPUT_BODY },
  { url: AGENT_URL, method: 'agent', call: ['agent', AGENT_ID, { before: null, after: null, limit: AGENT_LIMIT_DEFAULT }],
    body: AGENT_BODY },
  { url: WORKFLOW_URL, method: 'workflow', call: ['workflow', RUN_ID], body: WORKFLOW_BODY },
  { url: DIFF_TURN_URL, method: 'diff', call: ['diff', { turn: TURN_ID }], body: DIFF_RECORD },
  { url: DIFF_NODE_URL, method: 'diff', call: ['diff', { node: NODE_REF, context: CONTEXT_DEFAULT }], body: NODE_DIFF_BODY },
  { url: NODE_URL, method: 'nodeTurns', call: ['nodeTurns', NODE_REF], body: NODE_BODY },
  { url: NODES_URL, method: 'nodeSummaries', call: ['nodeSummaries'], body: NODES_BODY },
];
// The facade's answer set to `v` for every method.
const every = (v) => Object.fromEntries(METHODS.map((k) => [k, v]));

// ── the bodies ──────────────────────────────────────────────────────────────

test('each route answers its facade value in §2.10\'s shape, with rev from status() read before the call', async (t) => {
  for (const r of ROUTES.filter((x) => !x.ownRev)) {
    const m = fakeMirror();
    // The facade moves on while the read runs: a frame newer than the body's
    // rev is what the chrome re-applies, so the body must carry the rev from
    // before the call.
    const inner = m.answers[r.method];
    m.answers[r.method] = (...args) => {
      m.answers.status = { ...STATUS, rev: 43 };
      return typeof inner === 'function' ? inner(...args) : inner;
    };
    const h = await host(t, { mirror: m });
    const res = await h.get(r.url);
    assert.equal(res.status, 200, r.url);
    assert.deepStrictEqual(res.body, { ...r.body, rev: 42 }, r.url);
    assert.deepStrictEqual(m.calls, [['enabled'], ['status'], r.call], `${r.url}: the status first, then exactly the parsed query`);
    // The next read sees the rev the call moved to.
    assert.equal((await h.get(r.url)).body.rev, 43, r.url);
  }
});

test('GET /api/mirror/tasks keeps the facade\'s own rev and reads no status', async (t) => {
  const m = fakeMirror({ status: () => { throw new Error('the status is not read'); } });
  const h = await host(t, { mirror: m });
  const r = await h.get(TASKS_URL);
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.body, TASKS_BODY);
  assert.deepStrictEqual(m.calls, [['enabled'], ['tasks']]);
  // A rev that is no number is null, never passed on.
  m.answers.tasks = { tasks: [], counts: COUNTS, rev: '77' };
  assert.deepStrictEqual((await h.get(TASKS_URL)).body, { tasks: [], counts: COUNTS, rev: null });
  m.answers.tasks = { tasks: [], counts: COUNTS };
  assert.deepStrictEqual((await h.get(TASKS_URL)).body, { tasks: [], counts: COUNTS, rev: null });
});

test('a key a source adds beside §2.10\'s is dropped: no Claude Code path is ever returned', async (t) => {
  const PATHS = {
    file: '/Users/me/.claude/projects/-Users-me-Dev-x/0b6c1f4e.jsonl',
    transcript_path: '~/.claude/projects/-Users-me-Dev-x/0b6c1f4e.jsonl',
    tool_results_path: '~/.claude/projects/x/0b6c1f4e/tool-results/toolu_01.txt',
    output_file: '/private/tmp/claude-501/x/tasks/bx81k2.output',
    agent_file: '/Users/me/.claude/projects/x/0b6c1f4e/subagents/agent-a3f9c2e1b0d4.jsonl',
  };
  const m = fakeMirror({
    tasks: { ...TASKS_BODY, ...PATHS },
    taskOutput: { ...OUTPUT_BODY, ...PATHS },
    agent: { ...AGENT_BODY, ...PATHS },
    workflow: { ...WORKFLOW_BODY, ...PATHS },
    diff: (q) => ({ ...(q.turn !== undefined ? DIFF_RECORD : NODE_DIFF_BODY), ...PATHS }),
    nodeTurns: { ...NODE_BODY, ...PATHS },
    nodeSummaries: { ...NODES_BODY, ...PATHS },
  });
  const h = await host(t, { mirror: m });
  const want = [
    [TASKS_URL, ['counts', 'rev', 'tasks']],
    [OUTPUT_URL, ['ended', 'eof', 'exit_code', 'footer', 'from', 'rev', 'size', 'task_id', 'text', 'to']],
    [AGENT_URL, ['agent', 'items', 'next_before', 'rev']],
    [WORKFLOW_URL, ['agents', 'phases', 'rev', 'workflow']],
    [DIFF_TURN_URL, [...DIFF_KEYS.filter((k) => k !== 'reason'), 'rev'].sort()],
    [DIFF_NODE_URL, ['combined', 'node', 'rev', 'turns']],
    [NODE_URL, ['node', 'rev', 'turns']],
    [NODES_URL, ['nodes', 'rev']],
  ];
  for (const [url, keys] of want) {
    const r = await h.get(url);
    assert.equal(r.status, 200, url);
    assert.deepStrictEqual(Object.keys(r.body).sort(), keys, url);
    const text = JSON.stringify(r.body);
    for (const s of ['.jsonl', 'tool-results', '.output', '/.claude/', '/Users/', '/private/tmp']) {
      assert.ok(!text.includes(s), `${url} carries ${JSON.stringify(s)}`);
    }
  }
  // The diff record's own optional keys pass: an unavailable record's reason.
  m.answers.diff = { v: 1, turn_id: TURN_ID, status: 'unavailable', reason: 'not-a-git-repo', ...PATHS };
  assert.deepStrictEqual((await h.get(DIFF_TURN_URL)).body,
    { v: 1, turn_id: TURN_ID, status: 'unavailable', reason: 'not-a-git-repo', rev: 42 });
  // An output with no exit code yet carries none.
  const { exit_code: _x, ...running } = OUTPUT_BODY;
  m.answers.taskOutput = { ...running, ended: false };
  assert.ok(!('exit_code' in (await h.get(OUTPUT_URL)).body));
});

test('GET …/tasks/:taskId/output: `to` passed back as `from` pages through every byte once', async (t) => {
  const m = fakeMirror();
  const FULL = 'line one\nline two\nline three\n';
  // A source that answers windows of `max` bytes ending at a line boundary (U41).
  m.answers.taskOutput = (id, q) => {
    let text = FULL.slice(q.from, q.from + q.max);
    const nl = text.lastIndexOf('\n');
    if (nl >= 0 && q.from + text.length < FULL.length) text = text.slice(0, nl + 1);
    const to = q.from + text.length;
    return { task_id: id, text, from: q.from, to, size: FULL.length, eof: to >= FULL.length, ended: true, footer: null };
  };
  const h = await host(t, { mirror: m });
  let from = 0;
  let got = '';
  for (let i = 0; i < 20; i++) {
    const r = await h.get(`${OUTPUT_URL}?from=${from}&max=12`);
    assert.equal(r.status, 200);
    got += r.body.text;
    if (r.body.eof) break;
    from = r.body.to;
  }
  assert.equal(got, FULL);
  assert.ok(workCalls(m).every((c) => c[2].max === 12 && c[2].tail === null));
});

// ── parameters ──────────────────────────────────────────────────────────────

test('query parameters: defaults, the bounds accepted, and the parsed query handed over exactly', async (t) => {
  const m = fakeMirror();
  const h = await host(t, { mirror: m });
  const out = (q) => ['taskOutput', TASK_ID, { from: 0, max: OUTPUT_MAX, tail: null, ...q }];
  const ag = (q) => ['agent', AGENT_ID, { before: null, after: null, limit: AGENT_LIMIT_DEFAULT, ...q }];
  const ok = [
    [`${OUTPUT_URL}?from=0`, out({})],
    [`${OUTPUT_URL}?from=9007199254&max=1`, out({ from: 9007199254, max: 1 })],
    [`${OUTPUT_URL}?max=${OUTPUT_MAX}`, out({})],
    [`${OUTPUT_URL}?tail=1`, out({ tail: 1 })],
    [`${OUTPUT_URL}?tail=${OUTPUT_MAX}&max=100`, out({ tail: OUTPUT_MAX, max: 100 })],
    [`${OUTPUT_URL}?from=007`, out({ from: 7 })],
    [`${AGENT_URL}?limit=1`, ag({ limit: 1 })],
    [`${AGENT_URL}?limit=${AGENT_LIMIT_MAX}`, ag({ limit: 100 })],
    [`${AGENT_URL}?before=0`, ag({ before: 0 })],
    [`${AGENT_URL}?before=12.5&limit=5`, ag({ before: 12.5, limit: 5 })],
    [`${AGENT_URL}?after=3.25`, ag({ after: 3.25 })],
    [`${WORKFLOW_URL}?ignored=1`, ['workflow', RUN_ID]],
    [`${DIFF_NODE_URL}&context=0`, ['diff', { node: NODE_REF, context: 0 }]],
    [`${DIFF_NODE_URL}&context=${CONTEXT_MAX}`, ['diff', { node: NODE_REF, context: 20 }]],
    ['/api/mirror/diff?node=live', ['diff', { node: 'live', context: 3 }]],
    ['/api/mirror/diff?node=active', ['diff', { node: 'active', context: 3 }]],
    [`/api/mirror/diff?turn=${TURN_ID}&ignored=1`, ['diff', { turn: TURN_ID }]],
    ['/api/mirror/node/live', ['nodeTurns', 'live']],
    [`/api/mirror/node/${NODE_ID}`, ['nodeTurns', NODE_ID]],
    [`${NODES_URL}?x=1`, ['nodeSummaries']],
    [`${TASKS_URL}?x=1`, ['tasks']],
  ];
  for (const [url, call] of ok) {
    m.calls.length = 0;
    const r = await h.get(url);
    assert.equal(r.status, 200, url);
    assert.deepStrictEqual(workCalls(m), [call], url);
  }
  assert.equal(CONTEXT_DEFAULT, 3);
  assert.equal(CONTEXT_MAX, 20);
  assert.equal(AGENT_LIMIT_DEFAULT, 50);
  assert.equal(AGENT_LIMIT_MAX, 100);
  assert.equal(OUTPUT_MAX, 262144);
});

test('a 400 for each malformed, out-of-range, empty or repeated value and each wrong pairing, before the facade is asked', async (t) => {
  const m = fakeMirror();
  const h = await host(t, { mirror: m });
  const bad = [
    ['from', OUTPUT_URL, ['-1', 'x', '1.5', '', '1e2', ' 1', '0x10', '99999999999999999']],
    ['max', OUTPUT_URL, ['0', String(OUTPUT_MAX + 1), '-5', 'x', '', '1.5']],
    ['tail', OUTPUT_URL, ['0', String(OUTPUT_MAX + 1), '-1', '2.5', '', 'all']],
    ['limit', AGENT_URL, ['0', '101', '-1', '1.5', 'abc', '', '1e1']],
    ['before', AGENT_URL, ['-1', 'abc', '', '1e3', 'Infinity', 'NaN', '.5', '5.', ' 1']],
    ['after', AGENT_URL, ['-1', 'abc', '', '1e3', 'Infinity', '.5']],
    ['context', DIFF_NODE_URL, ['21', '-1', '1.5', '', 'x', '3e0']],
  ];
  for (const [name, base, values] of bad) {
    for (const v of values) {
      m.calls.length = 0;
      const url = `${base}${base.includes('?') ? '&' : '?'}${name}=${enc(v)}`;
      const r = await h.get(url);
      assert.equal(r.status, 400, url);
      assert.equal(r.body.ok, false, url);
      assert.ok(typeof r.body.error === 'string' && r.body.error.startsWith(`${name}: `), `${url}: ${JSON.stringify(r.body)}`);
      assert.deepStrictEqual(m.calls, [], `${url}: the facade is not asked`);
    }
  }
  const pairings = [
    [`${OUTPUT_URL}?tail=10&from=0`, 'tail: '],
    [`${OUTPUT_URL}?from=5&tail=10`, 'tail: '],
    [`${AGENT_URL}?before=3&after=1`, 'after: '],
    ['/api/mirror/diff', 'turn: '],
    ['/api/mirror/diff?context=3', 'turn: '],
    [`/api/mirror/diff?turn=${TURN_ID}&node=${NODE_REF}`, 'turn: '],
    [`/api/mirror/diff?turn=${TURN_ID}&context=3`, 'context: '],
    ['/api/mirror/diff?turn=', 'turn: '],
    ['/api/mirror/diff?node=', 'node: '],
  ];
  for (const [url, prefix] of pairings) {
    m.calls.length = 0;
    const r = await h.get(url);
    assert.equal(r.status, 400, url);
    assert.ok(r.body.error.startsWith(prefix), `${url}: ${r.body.error}`);
    assert.deepStrictEqual(m.calls, [], `${url}: the facade is not asked`);
  }
  // A parameter given twice is no single value, and neither is a one-element
  // list or an object (Express's qs parser makes both from brackets).
  for (const url of [`${OUTPUT_URL}?from=1&from=2`, `${OUTPUT_URL}?tail[]=5`, `${AGENT_URL}?limit=5&limit=6`,
    `${AGENT_URL}?before[a]=1`, `/api/mirror/diff?turn=${TURN_ID}&turn=${TURN_ID}`, `/api/mirror/diff?node[]=${NODE_REF}`,
    `${DIFF_NODE_URL}&context=3&context=4`]) {
    m.calls.length = 0;
    const r = await h.get(url);
    assert.equal(r.status, 400, url);
    assert.deepStrictEqual(m.calls, [], url);
  }
});

test('ids and refs pass through as given; one over 128 characters is 404 and asks nothing', async (t) => {
  const m = fakeMirror();
  const h = await host(t, { mirror: m });
  assert.equal(ID_MAX, 128);
  assert.equal(CODE_ID_MAX, 128);
  const urls = (id) => [
    `/api/mirror/tasks/${enc(id)}/output`, `/api/mirror/agents/${enc(id)}`, `/api/mirror/workflows/${enc(id)}`,
    `/api/mirror/diff?turn=${enc(id)}`, `/api/mirror/diff?node=${enc(id)}`, `/api/mirror/node/${enc(id)}`,
  ];
  for (const id of ['a'.repeat(ID_MAX), 'n1.7.0', 'p_x y.ü']) {
    m.calls.length = 0;
    for (const url of urls(id)) assert.equal((await h.get(url)).status, 200, url);
    assert.deepStrictEqual(workCalls(m).map((c) => (typeof c[1] === 'string' ? c[1] : c[1].turn || c[1].node)),
      [id, id, id, id, id, id], 'the id as given');
  }
  m.calls.length = 0;
  for (const url of urls('a'.repeat(ID_MAX + 1))) {
    const r = await h.get(url);
    assert.equal(r.status, 404, url);
    assert.deepStrictEqual(r.body, { ok: false, error: 'not found' });
  }
  assert.deepStrictEqual(m.calls, []);
});

// ── the shared answers ──────────────────────────────────────────────────────

test('a source answering null (an unknown id or ref) is 404 {ok:false, error:\'not found\'}', async (t) => {
  for (const nothing of [null, undefined]) {
    const h = await host(t, { mirror: fakeMirror(every(nothing)) });
    for (const { url } of ROUTES) {
      const r = await h.get(url);
      assert.equal(r.status, 404, url);
      assert.deepStrictEqual(r.body, { ok: false, error: 'not found' });
    }
  }
});

test('a source not registered yet is 503 {ok:false, unavailable:true}: the answer, a rejection coded so, and no mirror', async (t) => {
  const rejecting = (name) => () => {
    const e = Object.assign(new Error(`${name} is not registered`), { code: 'unavailable' });
    if (SYNC.has(name)) throw e;
    return Promise.reject(e);
  };
  const rejectAll = Object.fromEntries(METHODS.map((k) => [k, rejecting(k)]));
  for (const answers of [every({ unavailable: true }), rejectAll]) {
    const h = await host(t, { mirror: fakeMirror(answers) });
    for (const { url } of ROUTES) {
      const r = await h.get(url);
      assert.equal(r.status, 503, url);
      assert.deepStrictEqual(r.body, { ok: false, unavailable: true });
    }
  }
  // The facade's status unavailable (every route but /tasks reads it).
  const st = await host(t, { mirror: fakeMirror({ status: { unavailable: true } }) });
  for (const { url } of ROUTES.filter((x) => !x.ownRev)) {
    assert.deepStrictEqual((await st.get(url)).body, { ok: false, unavailable: true }, url);
  }
  // No mirror wired at all.
  const none = await host(t, { mirror: null });
  for (const { url } of ROUTES) {
    const r = await none.get(url);
    assert.equal(r.status, 503, url);
    assert.deepStrictEqual(r.body, { ok: false, unavailable: true });
  }
});

test('a disabled mirror: 200 {ok:false, disabled:true, scope, hint}, nothing read', async (t) => {
  for (const scope of ['project', 'user', 'session']) {
    const m = fakeMirror({ on: { enabled: false, scope } });
    const h = await host(t, { mirror: m });
    for (const { url } of ROUTES) {
      const r = await h.get(url);
      assert.equal(r.status, 200, url);
      assert.deepStrictEqual(r.body, disabledBody(scope));
      assert.match(r.body.hint, /claude-web-chat on/);
    }
    assert.deepStrictEqual(workCalls(m), []);
  }
});

test('a throw is 500 with a message-free body: no file named to the client or in the host\'s log', async (t) => {
  const SECRET_PATH = '/Users/me/.claude/projects/-Users-me-Dev-x/0b6c1f4e/tool-results/toolu_01.txt';
  const boom = () => { throw Object.assign(new Error(`ENOENT: no such file, open '${SECRET_PATH}'`), { code: 'ENOENT' }); };
  const rejecting = () => Promise.reject(new Error(`EACCES ${SECRET_PATH}`));
  const logged = [];
  const orig = console.error;
  console.error = (...a) => { logged.push(a.join(' ')); };
  t.after(() => { console.error = orig; });
  const ALL = ROUTES.map((r) => r.url);
  const WITH_STATUS = ROUTES.filter((r) => !r.ownRev).map((r) => r.url);
  const cases = [
    [fakeMirror(every(boom)), ALL],
    [fakeMirror(every(rejecting)), ALL],
    // An answer that is no object is a fault, never a body.
    [fakeMirror(every(SECRET_PATH)), ALL],
    [fakeMirror(every([SECRET_PATH])), ALL],
    [fakeMirror(every(42)), ALL],
    // The status read before the call.
    [fakeMirror({ status: () => { throw new Error(SECRET_PATH); } }), WITH_STATUS],
    [fakeMirror({ status: SECRET_PATH }), WITH_STATUS],
  ];
  for (const [m, urls] of cases) {
    const h = await host(t, { mirror: m });
    for (const url of urls) {
      const r = await h.get(url);
      assert.equal(r.status, 500, url);
      assert.deepStrictEqual(r.body, { ok: false, error: 'the chat mirror could not answer' });
    }
  }
  console.error = orig;
  assert.ok(logged.length > 0);
  for (const line of logged) {
    assert.ok(!line.includes('.claude') && !line.includes('/Users/') && !line.includes('no such file'), line);
  }
});

test('the wait on mirror.ready is bounded: a start that never settles still gets an answer', async (t) => {
  const h = await host(t, { mirror: fakeMirror({ ready: new Promise(() => {}) }), opts: { readyWaitMs: 50 } });
  for (const { url, body, ownRev } of ROUTES) {
    const r = await h.get(url);
    assert.equal(r.status, 200, url);
    assert.deepStrictEqual(r.body, ownRev ? body : { ...body, rev: 42 }, url);
  }
});

// ── the gate ────────────────────────────────────────────────────────────────

test('requireMirror(\'read\') on all eight: a remote viewer below read gets the 403 hint, local, read and full get through', async (t) => {
  const m = fakeMirror();
  const audience = fakeAudience();
  const h = await host(t, { mirror: m, audience });
  assert.deepStrictEqual(audience.needs, ['read', 'read'], 'one gate per module, at read');
  for (const { url } of ROUTES) {
    audience.optIn = 'off';
    m.calls.length = 0;
    const refused = await h.get(url, { remote: true });
    assert.equal(refused.status, 403, url);
    assert.deepStrictEqual(refused.body, { ok: false, mirror: 'basic', remote: true, hint: MIRROR_HINT });
    assert.deepStrictEqual(m.calls, [], `${url}: a refused viewer asks the facade nothing`);
    assert.equal((await h.get(url)).status, 200, `${url} local`);
    for (const optIn of ['read', 'full']) {
      audience.optIn = optIn;
      assert.equal((await h.get(url, { remote: true })).status, 200, `${url} remote ${optIn}`);
    }
  }
});

test('the real audience gate: with no opt-in a remote request is refused with the mirror hint, a local one passes', async (t) => {
  const audience = createAudience({ configFile: null });
  t.after(() => audience.stop());
  const h = await host(t, { mirror: fakeMirror(), audience });
  for (const { url } of ROUTES) {
    const refused = await h.get(url, { remote: true });
    assert.equal(refused.status, 403, url);
    assert.deepStrictEqual(refused.body, { ok: false, mirror: 'basic', remote: true, hint: MIRROR_HINT });
    assert.equal((await h.get(url)).status, 200, url);
  }
});

test('the portal\'s table: GET /api/mirror/* allows each route at read and full, refuses it at basic, refuses every write', () => {
  for (const { url } of ROUTES) {
    const basic = classify('GET', url, { mirror: 'off' });
    assert.equal(basic.allow, false, url);
    assert.equal(basic.reason, 'mirror', url);
    assert.equal(basic.hint, MIRROR_HINT, url);
    assert.equal(basic.key, 'GET /api/mirror/*', `${url}: the existing row decides`);
    for (const mirror of ['read', 'full']) {
      const v = classify('GET', url, { mirror });
      assert.deepStrictEqual(v, { allow: true, key: 'GET /api/mirror/*' }, `${url} at ${mirror}`);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const w = classify(method, url, { mirror: 'full' });
      assert.equal(w.allow, false, `${method} ${url}`);
      assert.equal(w.key, '* /api/mirror/*', `${method} ${url}`);
      assert.match(w.hint, /driven from the host/, `${method} ${url}: HOST_ONLY`);
    }
  }
  // No row of these modules' own: the two mirror wildcards cover them.
  for (const p of ['/api/mirror/tasks', '/api/mirror/agents', '/api/mirror/workflows', '/api/mirror/diff',
    '/api/mirror/node', '/api/mirror/nodes']) {
    assert.ok(!RULES.some((r) => r.path === p || r.path.startsWith(`${p}/`)), p);
  }
});

test('mounting without an audience gate throws rather than serve the work ungated', () => {
  for (const mount of [mountMirrorTasksRoutes, mountMirrorCodeRoutes]) {
    const app = express();
    assert.throws(() => mount(app, { mirror: fakeMirror() }), /ctx\.audience/);
    assert.throws(() => mount(app, { mirror: fakeMirror(), audience: {} }), /requireMirror/);
    assert.throws(() => mount(app, undefined), /ctx\.audience/);
  }
});

// ── thin ────────────────────────────────────────────────────────────────────

test('both modules are thin: each requires only routes/mirror.js (no fs, claude-files or domain/refs)', () => {
  for (const rel of MODULES) {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    const requires = [...code.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((x) => x[2]);
    assert.deepStrictEqual(requires, ['./mirror'], rel);
    assert.ok(!/require\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/.test(code), `${rel}: fs`);
    assert.ok(!/claude-files|domain\/refs|resolveNodeRef/.test(code), `${rel}: claude-files or refs`);
    assert.ok(!/\bimport\s*\(/.test(code), `${rel}: no dynamic import`);
    // Nor does it redact, fence or read a window on its own (§2.9).
    assert.ok(!/\bredact\w*\s*\(|\bfence\s*\(|readWindow|sessionDirFile|taskOutputFile/.test(code), rel);
  }
});
