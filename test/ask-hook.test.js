// The ask bridge (lib/hooks/ask.js, spec §4.1, §4.5): the PermissionRequest
// hook that holds a prompt open while the web-chat page can answer it, prints
// Claude Code's decision when the page does, and gets out of the way the
// moment the terminal answers.
//
// Five parts:
//
//   1. IN PROCESS, against a stub daemon on loopback: the create body (the
//      report-mode envelope unchanged, the display projection, the questions
//      with multiSelect), the plan path's fence (a refused path is never
//      opened: an fs spy), the plansDirectory setting (ruling A5 (b)), every
//      poll outcome, the backstop on the sessions file, the deadline.
//   2. THE DISPATCHER AS A SUBPROCESS: SIGTERM withdraws and exits 0 printing
//      nothing; a decision prints exactly buildAskOutput's line; an unmappable
//      one prints nothing and is logged by id and outcome only.
//   3. MASKED QUESTIONS END TO END (ruling A3 (a), and the maintainer's note
//      that a failure here would be silent and invisible to Claude): the real
//      hook against U53's real asks domain and routes on a bare app with the
//      real redactor; the page answers by index, the hook echoes the
//      unredacted texts.
//   4. THE EVENT SPLIT: a PermissionRequest envelope passes checkEnvelope, the
//      intake refuses it (and publishes nothing), POST /api/asks takes it.
//   5. THE SOURCE: the PermissionRequest output's event name has one home.
//
// Wall-clock bounds run only under WEB_CHAT_PERF=1 (spec §10.1); the default
// run asserts behaviour and logs the times.

const { home: SANDBOX_HOME } = require('../test-support/sandbox');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { Writable } = require('stream');
const { spawn } = require('child_process');

const ask = require('../lib/hooks/ask');
const { buildAskOutput, DENY_MESSAGE } = require('../lib/hooks/ask-output');
const { hookEnvelope } = require('../lib/hooks/envelope');
const client = require('../lib/client');
const { projectToolInput } = require('../lib/core/tool-input');
const { userClaudePaths } = require('../lib/core/paths');
const { writePortfileAt } = require('../lib/core/portfiles');
const { checkEnvelope } = require('../lib/server/routes/hooks');
const { createHookTap } = require('../lib/server/hook-tap');
const { createBus } = require('../lib/core/bus');
const { createRedactor, MASK } = require('../lib/core/redact');
const { createAsks } = require('../lib/server/domain/asks');
const { mountAskRoutes } = require('../lib/server/routes/asks');
const { claudeHome } = require('../test-support/claude-home');
const { fakeSecrets } = require('../test-support/fake-secrets');
const { tmpRoot, waitUntil, withServer } = require('../test-support/helpers');


const HOOK_BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat-hook.js');
const PERF = process.env.WEB_CHAT_PERF === '1';

const SID = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const NOW = 1790000000123;
const ENV = { CLAUDE_PID: '4242', CLAUDE_CODE_ENTRYPOINT: 'cli' };
const ID = 'ask_0123456789ab';
const SECRET = 'S3CRET-for-this-ask';
const CREATED = { ok: true, id: ID, secret: SECRET, wait: true, poll_ms: 2000, deadline_ms: 590000 };
const NO_WAIT = { ok: true, id: ID, wait: false, reason: 'no-viewer' };
const HANG = Symbol('hang');
// Headers, then a byte every 100 ms, forever: a socket that is never idle, so
// no client timeout can end the request.
const TRICKLE = Symbol('trickle');

function payload(root, extra = {}) {
  return {
    session_id: SID,
    transcript_path: `/Users/someone/.claude/projects/-p/${SID}.jsonl`,
    cwd: root,
    hook_event_name: 'PermissionRequest',
    prompt_id: 'c0ffee00-prompt',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf dist && npm run build', description: 'Rebuild' },
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run build' }], behavior: 'allow', destination: 'localSettings' }],
    ...extra,
  };
}

const QUESTIONS = [
  {
    question: 'Which colour?', header: 'Colour', multiSelect: false,
    options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }],
  },
  {
    question: 'Which toppings?', header: 'Toppings', multiSelect: true,
    options: [{ label: 'Cheese' }, { label: 'Olives, black' }, { label: 'Basil' }],
  },
];

const questionPayload = (root, questions = QUESTIONS) => payload(root, {
  tool_name: 'AskUserQuestion', tool_input: { questions }, permission_suggestions: undefined,
});
const planPayload = (root, planFilePath, plan = '# Stale plan from the tool input\n') => payload(root, {
  tool_name: 'ExitPlanMode', tool_input: { plan, planFilePath }, permission_suggestions: undefined,
});

// ── the rig ─────────────────────────────────────────────────────────────────

// A daemon stand-in on loopback for the asks routes the hook calls. `create`
// answers POST /api/asks (an object, or a function of the body); `poll(n,
// rec)` answers the nth decision poll ({status, body}, a body alone, or HANG
// to hold the response open), `withdraw(rec)` a withdraw (default {ok:
// true}); handed answers {ok: true}. Every
// request is recorded with its parsed body.
async function asksStub(t, { create = CREATED, poll = () => ({ state: 'pending' }), withdraw = () => ({ ok: true }) } = {}) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const url = new URL(req.url, 'http://stub');
      const rec = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body, at: Date.now() };
      requests.push(rec);
      res.on('error', () => {});
      const send = (answer) => {
        if (answer === HANG) return;
        if (answer === TRICKLE) {
          res.writeHead(200, { 'content-type': 'application/json' });
          const iv = setInterval(() => res.write(' '), 100);
          res.on('close', () => clearInterval(iv));
          return;
        }
        const status = answer && Number.isInteger(answer.status) && answer.body !== undefined ? answer.status : 200;
        const out = answer && Number.isInteger(answer.status) && answer.body !== undefined ? answer.body : answer;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      };
      if (req.method === 'POST' && url.pathname === '/api/asks') return send(typeof create === 'function' ? create(body) : create);
      const m = /^\/api\/asks\/([^/]+)\/(decision|withdraw|handed)$/.exec(url.pathname);
      if (m && m[2] === 'decision') {
        const n = requests.filter((r) => r.path === url.pathname).length;
        return send(await poll(n, rec));
      }
      if (m && m[2] === 'withdraw') return send(withdraw(rec));
      if (m) return send({ ok: true });
      return send({ status: 404, body: { ok: false } });
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    for (const s of sockets) s.destroy();
    return new Promise((r) => server.close(r));
  });
  return {
    port: server.address().port,
    requests,
    created: () => requests.filter((r) => r.path === '/api/asks'),
    polls: () => requests.filter((r) => r.path.endsWith('/decision')),
    withdraws: () => requests.filter((r) => r.path.endsWith('/withdraw')),
    handed: () => requests.filter((r) => r.path.endsWith('/handed')),
  };
}

function project(t, port) {
  const root = tmpRoot('wc-askhook-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (port) writePortfileAt(path.join(root, '.web-chat'), { pid: process.pid, port });
  return root;
}

// A stdout whose write completes LATER, so a hook that did not await its write
// would return before the line is taken.
function capture({ delayMs = 40 } = {}) {
  const chunks = [];
  let takenAt = null;
  const stream = new Writable({
    write(chunk, enc, cb) {
      setTimeout(() => { chunks.push(String(chunk)); takenAt = Date.now(); cb(); }, delayMs);
    },
  });
  return { stream, text: () => chunks.join(''), takenAt: () => takenAt };
}

async function runAsk(p, { root, env = ENV } = {}) {
  const out = capture();
  const result = await ask(p, { root, now: NOW, env, stdout: out.stream });
  return { result, stdout: out.text(), out };
}

// Records every path the process opens or reads whole while `fn` runs.
async function opened(fn) {
  const seen = [];
  const orig = { openSync: fs.openSync, readFileSync: fs.readFileSync };
  fs.openSync = function spyOpen(p, ...rest) { if (typeof p === 'string') seen.push(p); return orig.openSync.call(this, p, ...rest); };
  fs.readFileSync = function spyRead(p, ...rest) { if (typeof p === 'string') seen.push(p); return orig.readFileSync.call(this, p, ...rest); };
  try {
    const value = await fn();
    return { value, seen };
  } finally {
    fs.openSync = orig.openSync;
    fs.readFileSync = orig.readFileSync;
  }
}

function realOrSelf(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

function assertNeverOpened(seen, ...files) {
  for (const f of files) {
    for (const spelling of new Set([f, realOrSelf(f)])) {
      assert.ok(!seen.includes(spelling), `${spelling} was never opened`);
    }
  }
}

// ── 1. in process: the create body ──────────────────────────────────────────

test('ask (in process): the create body carries the report-mode envelope unchanged, the display projection and the suggestions', async (t) => {
  const stub = await asksStub(t, { create: NO_WAIT });
  const root = project(t, stub.port);
  const p = payload(root);
  const { result, stdout } = await runAsk(p, { root });
  assert.equal(result, 'no-wait');
  assert.equal(stdout, '', 'nobody can answer: no output');
  assert.equal(stub.requests.length, 1, 'only the create');
  const [c] = stub.created();
  assert.equal(c.method, 'POST');
  assert.deepEqual(Object.keys(c.body).sort(), ['display', 'envelope', 'kind', 'suggestions', 'v']);
  assert.equal(c.body.v, 1);
  assert.equal(c.body.kind, 'permission');
  assert.deepEqual(c.body.envelope, JSON.parse(JSON.stringify(hookEnvelope(p, ENV, { now: NOW }))), 'exactly what report mode posted');
  assert.equal(c.body.envelope.ask, null);
  assert.deepEqual(c.body.display, projectToolInput('Bash', p.tool_input, { profile: 'display' }));
  assert.deepEqual(c.body.suggestions, p.permission_suggestions);
  assert.equal(c.headers['x-wc-ask-secret'], undefined, 'no secret before there is one');

  // Suggestions over 4 KB are dropped, never cut.
  const big = await asksStub(t, { create: NO_WAIT });
  const root2 = project(t, big.port);
  await runAsk(payload(root2, { permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'x'.repeat(5000) }] }] }), { root: root2 });
  assert.equal('suggestions' in big.created()[0].body, false);
});

test('ask (in process): a question\'s create body carries the questions with multiSelect, at the display caps', async (t) => {
  const stub = await asksStub(t, { create: NO_WAIT });
  const root = project(t, stub.port);
  await runAsk(questionPayload(root), { root });
  const { body } = stub.created()[0];
  assert.equal(body.kind, 'question');
  assert.deepEqual(body.questions, QUESTIONS, 'every field the page draws, multiSelect included');
  assert.equal(body.questions_truncated, false);
  assert.equal('plan' in body, false);

  // Over the caps: cut, and marked, so the ask is answered in the terminal.
  const long = [...Array(10)].map((_, i) => ({
    question: `${i}${'q'.repeat(5000)}`, header: 'h'.repeat(300), multiSelect: i === 0,
    options: [...Array(14)].map((__, j) => ({ label: `${j}${'l'.repeat(600)}`, description: 'd'.repeat(2500) })),
  }));
  const { questions, truncated } = ask.postedQuestions(long);
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(questions)) <= 16 * 1024);
  assert.ok(questions.length >= 1 && questions.length <= 8);
  assert.equal(questions[0].multiSelect, true);
  assert.ok(questions[0].question.startsWith('0'), 'the head is kept: picks index from the start');
  assert.ok(questions[0].options.length <= 12);
  // Shapes Claude Code never sends are marked too.
  assert.equal(ask.postedQuestions([{ question: 'q', options: 'x' }]).truncated, true);
  assert.equal(ask.postedQuestions([{ question: 7, options: [] }]).truncated, true);
  assert.equal(ask.postedQuestions(null).truncated, true);
  assert.deepEqual(ask.postedQuestions(QUESTIONS), { questions: QUESTIONS, truncated: false });
});

test('ask (in process): an SDK entrypoint and no portfile each post nothing and print nothing', async (t) => {
  const stub = await asksStub(t);
  const root = project(t, stub.port);
  for (const entry of ['sdk-cli', 'sdk-ts', 'sdk-py']) {
    const r = await runAsk(payload(root), { root, env: { ...ENV, CLAUDE_CODE_ENTRYPOINT: entry } });
    assert.equal(r.result, 'sdk');
    assert.equal(r.stdout, '');
  }
  const bare = project(t, null);
  const r = await runAsk(payload(bare), { root: bare });
  assert.equal(r.result, 'no-daemon');
  assert.equal(r.stdout, '');
  assert.equal((await runAsk({ ...payload(root), hook_event_name: 'PreToolUse' }, { root })).result, 'ignored');
  assert.equal(stub.requests.length, 0, 'nothing was posted');
});

test('ask (in process): a create that fails or answers without a usable id prints nothing', async (t) => {
  for (const create of [{ status: 400, body: { ok: false } }, { status: 404, body: { ok: false } }, { ok: true, wait: true, id: '../x', secret: 's' }, { ok: true, wait: true, id: ID }]) {
    const stub = await asksStub(t, { create });
    const root = project(t, stub.port);
    const r = await runAsk(payload(root), { root });
    assert.equal(r.stdout, '');
    assert.equal(stub.polls().length, 0, JSON.stringify(create));
  }
});

// ── 1. in process: the plan path ────────────────────────────────────────────

async function planRun(t, { root, planFilePath, plan, create = NO_WAIT, poll }) {
  const stub = await asksStub(t, { create, poll });
  writePortfileAt(path.join(root, '.web-chat'), { pid: process.pid, port: stub.port });
  const { value, seen } = await opened(() => runAsk(planPayload(root, planFilePath, plan), { root }));
  return { posted: stub.created()[0].body.plan, run: value, seen, stub };
}

test('plan path: a planFilePath in the plans directory is read; the approve echoes the file\'s text', async (t) => {
  const root = project(t, null);
  const ch = claudeHome(t, { root });
  const file = ch.write('plans/quiet-river.md', '# Fresh plan\n\n1. Do it.\n');
  const { posted, run } = await planRun(t, {
    root, planFilePath: file, create: CREATED,
    poll: () => ({ state: 'decided', decision: { behavior: 'approve', mode: 'acceptEdits' } }),
  });
  assert.deepEqual(posted, { text: '# Fresh plan\n\n1. Do it.\n', file, from_file: true, truncated: false });
  assert.equal(run.result, 'decided');
  assert.deepEqual(JSON.parse(run.stdout).hookSpecificOutput.decision, {
    behavior: 'allow',
    updatedInput: { plan: '# Fresh plan\n\n1. Do it.\n', planFilePath: file },
    updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
  });
});

test('plan path: ~/.ssh/id_rsa, a link in plans/, a non-.md file and a relative path are never opened; the tool input\'s plan is posted', async (t) => {
  const root = project(t, null);
  const ch = claudeHome(t, { root });
  const ssh = path.join(SANDBOX_HOME, '.ssh', 'id_rsa');
  fs.mkdirSync(path.dirname(ssh), { recursive: true });
  fs.writeFileSync(ssh, 'PRIVATE-KEY-MARKER');
  t.after(() => fs.rmSync(path.dirname(ssh), { recursive: true, force: true }));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-askhook-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'secret.md');
  fs.writeFileSync(target, 'OUTSIDE-MARKER');
  ch.write('plans/.keep', '');
  const link = path.join(ch.dir, 'plans', 'link.md');
  fs.symlinkSync(target, link);
  t.after(() => fs.rmSync(link, { force: true }));
  const txt = ch.write('plans/notes.txt', 'TXT-MARKER');
  ch.write('plans/relative.md', 'RELATIVE-MARKER');

  for (const planFilePath of [ssh, link, txt, 'plans/relative.md', path.join('..', 'plans', 'relative.md')]) {
    const { posted, seen, stub } = await planRun(t, { root, planFilePath, plan: 'TOOL-PLAN' });
    assert.deepEqual(posted, { text: 'TOOL-PLAN', file: null, from_file: false, truncated: false }, planFilePath);
    assertNeverOpened(seen, ssh, link, target, txt, path.join(ch.dir, 'plans', 'relative.md'), path.resolve(planFilePath));
    assert.doesNotMatch(JSON.stringify(stub.requests.map((r) => r.body)), /MARKER/);
  }

  // And the approve echoes the tool input's plan, never the refused file.
  const { run } = await planRun(t, {
    root, planFilePath: ssh, plan: 'TOOL-PLAN', create: CREATED,
    poll: () => ({ state: 'decided', decision: { behavior: 'approve', mode: 'default' } }),
  });
  assert.deepEqual(JSON.parse(run.stdout).hookSpecificOutput.decision.updatedInput, { plan: 'TOOL-PLAN', planFilePath: ssh });
});

test('plan path: a plan file readWindow cannot read falls back to the tool input\'s plan', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) { t.skip('root reads a mode-000 file'); return; }
  const root = project(t, null);
  const ch = claudeHome(t, { root });
  const file = ch.write('plans/locked.md', 'LOCKED-MARKER');
  fs.chmodSync(file, 0o000);
  t.after(() => { try { fs.chmodSync(file, 0o600); } catch {} });
  const { posted } = await planRun(t, { root, planFilePath: file, plan: 'TOOL-PLAN' });
  assert.deepEqual(posted, { text: 'TOOL-PLAN', file: null, from_file: false, truncated: false });
});

test('plan path: a plan over 256 KB is posted cut, and marked', async (t) => {
  const root = project(t, null);
  const ch = claudeHome(t, { root });
  const file = ch.write('plans/huge.md', `# Huge\n${'é'.repeat(200 * 1024)}`);
  const { posted } = await planRun(t, { root, planFilePath: file });
  assert.equal(posted.from_file, true);
  assert.equal(posted.truncated, true);
  assert.ok(Buffer.byteLength(posted.text) <= ask.PLAN_MAX_BYTES);
  assert.ok(!posted.text.includes('�'), 'never half a character');
  const fromInput = await planRun(t, { root, planFilePath: null, plan: 'x'.repeat(ask.PLAN_MAX_BYTES + 10) });
  assert.equal(fromInput.posted.text.length, ask.PLAN_MAX_BYTES);
  assert.equal(fromInput.posted.truncated, true);
});

// ── 1. in process: plansDirectory (ruling A5 (b)) ───────────────────────────

function writeSettings(root, name, value) {
  const file = path.join(root, '.claude', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function planIn(dir, name = 'p.md', text = `# Plan in ${path.basename(dir)}\n`) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

test('plansDirectory: the project\'s and the local settings are followed, the local one over the project\'s', async (t) => {
  const root = project(t, null);
  claudeHome(t, { root, isolate: true });
  writeSettings(root, 'settings.json', { plansDirectory: 'docs/plans', model: 'NOT-READ' });
  const inDocs = planIn(path.join(root, 'docs', 'plans'));
  assert.equal(ask.plansDirectoryOf(root), 'docs/plans');
  let r = await planRun(t, { root, planFilePath: inDocs });
  assert.deepEqual(r.posted, { text: '# Plan in plans\n', file: inDocs, from_file: true, truncated: false });

  const root2 = project(t, null);
  writeSettings(root2, 'settings.local.json', { plansDirectory: 'docs/plans' });
  const inDocs2 = planIn(path.join(root2, 'docs', 'plans'));
  r = await planRun(t, { root: root2, planFilePath: inDocs2 });
  assert.equal(r.posted.from_file, true, 'from settings.local.json');

  // Both set: the local one applies, and the project's directory is not a
  // plans directory.
  writeSettings(root, 'settings.local.json', { plansDirectory: 'local-plans' });
  const inLocal = planIn(path.join(root, 'local-plans'));
  assert.equal(ask.plansDirectoryOf(root), 'local-plans');
  r = await planRun(t, { root, planFilePath: inLocal });
  assert.equal(r.posted.from_file, true);
  assert.equal(r.posted.file, inLocal);
  r = await planRun(t, { root, planFilePath: inDocs, plan: 'TOOL-PLAN' });
  assert.equal(r.posted.from_file, false);
  assertNeverOpened(r.seen, inDocs);
});

test('plansDirectory: a project setting that leads out of the project is refused, never opened', async (t) => {
  claudeHome(t, { root: project(t, null), isolate: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-askhook-out-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsidePlan = planIn(outside);

  // '../<outside>', an absolute path outside, and a directory link inside the
  // project that leads out.
  const cases = [
    (root) => ({ setting: path.relative(root, outside), file: path.join(root, path.relative(root, outside), 'p.md') }),
    () => ({ setting: outside, file: outsidePlan }),
    (root) => {
      fs.symlinkSync(outside, path.join(root, 'linked'));
      return { setting: 'linked', file: path.join(root, 'linked', 'p.md') };
    },
  ];
  for (const make of cases) {
    for (const name of ['settings.json', 'settings.local.json']) {
      const root = project(t, null);
      const { setting, file } = make(root);
      writeSettings(root, name, { plansDirectory: setting });
      const r = await planRun(t, { root, planFilePath: file, plan: 'TOOL-PLAN' });
      assert.deepEqual(r.posted, { text: 'TOOL-PLAN', file: null, from_file: false, truncated: false }, `${name}: ${setting}`);
      assertNeverOpened(r.seen, file, outsidePlan);
    }
  }
});

test('plansDirectory: the user\'s setting is resolved against the project root; one that leads out is ignored', async (t) => {
  const root = project(t, null);
  const ch = claudeHome(t, { root, isolate: true });
  ch.write('settings.json', JSON.stringify({ plansDirectory: 'my-plans' }));
  const mine = planIn(path.join(root, 'my-plans'));
  let r = await planRun(t, { root, planFilePath: mine });
  assert.deepEqual(r.posted, { text: '# Plan in my-plans\n', file: mine, from_file: true, truncated: false });

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-askhook-userout-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsidePlan = planIn(outside);
  const fallback = ch.write('plans/default.md', '# Default\n');
  for (const setting of [outside, path.relative(root, outside), '../elsewhere']) {
    ch.write('settings.json', JSON.stringify({ plansDirectory: setting }));
    const file = setting === '../elsewhere' ? path.join(root, '..', 'elsewhere', 'p.md') : outsidePlan;
    r = await planRun(t, { root, planFilePath: path.resolve(file), plan: 'TOOL-PLAN' });
    assert.equal(r.posted.from_file, false, setting);
    assertNeverOpened(r.seen, path.resolve(file), outsidePlan);
    // Only the default plans directory counts, as in Claude Code.
    r = await planRun(t, { root, planFilePath: fallback });
    assert.equal(r.posted.from_file, true, `${setting}: the default still counts`);
  }
});

test('plansDirectory: the default plans directory is read whatever the settings say', async (t) => {
  const root = project(t, null);
  const ch = claudeHome(t, { root, isolate: true });
  ch.write('settings.json', JSON.stringify({ plansDirectory: 'user-plans' }));
  writeSettings(root, 'settings.json', { plansDirectory: 'docs/plans' });
  writeSettings(root, 'settings.local.json', { plansDirectory: 'local-plans' });
  const file = ch.write('plans/always.md', '# Always\n');
  assert.equal(path.dirname(file), userClaudePaths().plansDir);
  const r = await planRun(t, { root, planFilePath: file });
  assert.deepEqual(r.posted, { text: '# Always\n', file, from_file: true, truncated: false });
  // A torn or absent settings file names none.
  fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), '{torn');
  assert.equal(ask.plansDirectoryOf(root), 'docs/plans');
  fs.rmSync(path.join(root, '.claude'), { recursive: true, force: true });
  assert.equal(ask.plansDirectoryOf(root), 'user-plans');
});

// ── 1. in process: the poll ─────────────────────────────────────────────────

test('ask (in process): a decided poll prints the line, awaits the write, then posts handed', async (t) => {
  const stub = await asksStub(t, { poll: () => ({ state: 'decided', decision: { behavior: 'deny', message: 'use pnpm' } }) });
  const root = project(t, stub.port);
  const { result, stdout, out } = await runAsk(payload(root), { root });
  assert.equal(result, 'decided');
  assert.equal(stdout, buildAskOutput('permission', {}, { behavior: 'deny', message: 'use pnpm' }));
  assert.equal(JSON.parse(stdout).hookSpecificOutput.decision.message, `${DENY_MESSAGE} They wrote: use pnpm`);
  const [poll] = stub.polls();
  assert.equal(poll.method, 'GET');
  assert.equal(poll.path, `/api/asks/${ID}/decision`);
  assert.equal(poll.query.wait, String(ask.POLL_WAIT_MS));
  assert.equal(poll.headers['x-wc-ask-secret'], SECRET);
  const [handed] = stub.handed();
  assert.ok(handed, 'handed was posted');
  assert.equal(handed.headers['x-wc-ask-secret'], SECRET);
  assert.ok(handed.at >= out.takenAt(), 'handed only after the line was taken');
  assert.equal(stub.withdraws().length, 0);
});

test('ask (in process): a resolved poll, a 404 poll and a terminal decision print nothing', async (t) => {
  let stub = await asksStub(t, { poll: () => ({ state: 'resolved', by: 'terminal' }) });
  let root = project(t, stub.port);
  let r = await runAsk(payload(root), { root });
  assert.equal(r.result, 'resolved');
  assert.equal(r.stdout, '');
  assert.equal(stub.withdraws().length + stub.handed().length, 0);

  stub = await asksStub(t, { poll: () => ({ status: 404, body: { ok: false, error: 'unknown ask' } }) });
  root = project(t, stub.port);
  r = await runAsk(payload(root), { root });
  assert.equal(r.result, 'poll-failed', 'a daemon restart forgot the ask');
  assert.equal(r.stdout, '');
  assert.equal(stub.withdraws().length, 0);

  stub = await asksStub(t, { poll: () => ({ state: 'decided', decision: { behavior: 'terminal' } }) });
  root = project(t, stub.port);
  r = await runAsk(payload(root), { root });
  assert.equal(r.result, 'decided');
  assert.equal(r.stdout, '', 'the terminal answers it');
  assert.equal(stub.handed().length, 1);
});

test('ask (in process): a decision the local copy cannot map prints nothing and throws ASK_UNMAPPED', async (t) => {
  const stub = await asksStub(t, { poll: () => ({ state: 'decided', decision: { behavior: 'answer', picks: [{ q: 0, options: [7] }, { q: 1, options: [0] }] } }) });
  const root = project(t, stub.port);
  const out = capture();
  await assert.rejects(ask(questionPayload(root), { root, now: NOW, env: ENV, stdout: out.stream }), (e) => e.code === 'ASK_UNMAPPED' && !/Colour|colour/.test(e.message));
  assert.equal(out.text(), '');
  assert.equal(stub.handed().length, 0);
});

test('ask (in process): the backstop — waiting, then busy: withdraw resolved-elsewhere, no output', async (t) => {
  const root0 = project(t, null);
  const ch = claudeHome(t, { root: root0 });
  ch.writeSession({ pid: 4242, procStart: null, sessionId: SID, status: 'waiting' });
  const stub = await asksStub(t, {
    poll: (n) => {
      if (n === 2) ch.writeSession({ pid: 4242, procStart: null, sessionId: SID, status: 'busy' });
      return { state: 'pending' };
    },
  });
  writePortfileAt(path.join(root0, '.web-chat'), { pid: process.pid, port: stub.port });
  const t0 = Date.now();
  const r = await runAsk(payload(root0), { root: root0 });
  const ms = Date.now() - t0;
  assert.equal(r.result, 'terminal');
  assert.equal(r.stdout, '');
  assert.equal(stub.polls().length, 2);
  const [w] = stub.withdraws();
  assert.deepEqual(w.body, { reason: 'resolved-elsewhere' });
  assert.equal(w.headers['x-wc-ask-secret'], SECRET);
  t.diagnostic(`left waiting → withdrawn in ${ms} ms`);
  if (PERF) assert.ok(ms < ask.SETTLE_MS, `${ms} ms`);
});

test('ask (in process): the backstop — busy from the start: withdraw after 2 s', async (t) => {
  const root = project(t, null);
  const ch = claudeHome(t, { root });
  ch.writeSession({ pid: 4242, procStart: null, sessionId: SID, status: 'busy' });
  const stub = await asksStub(t);
  writePortfileAt(path.join(root, '.web-chat'), { pid: process.pid, port: stub.port });
  const t0 = Date.now();
  const r = await runAsk(payload(root), { root });
  const ms = Date.now() - t0;
  assert.equal(r.result, 'terminal');
  assert.equal(r.stdout, '');
  assert.ok(ms >= ask.SETTLE_MS, `not before ${ask.SETTLE_MS} ms (${ms})`);
  assert.deepEqual(stub.withdraws().map((w) => w.body), [{ reason: 'resolved-elsewhere' }]);
  // Another session's file, or none, is no evidence.
  ch.writeSession({ pid: 4242, procStart: null, sessionId: 'another-session', status: 'busy' });
  const stub2 = await asksStub(t, { create: { ...CREATED, deadline_ms: 600 } });
  writePortfileAt(path.join(root, '.web-chat'), { pid: process.pid, port: stub2.port });
  assert.equal((await runAsk(payload(root), { root })).result, 'deadline');
});

test('ask (in process): the deadline — deadline_ms 300 withdraws \'deadline\' and prints nothing', async (t) => {
  const stub = await asksStub(t, { create: { ...CREATED, deadline_ms: 300 } });
  const root = project(t, stub.port);
  const t0 = Date.now();
  const r = await runAsk(payload(root), { root, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
  const ms = Date.now() - t0;
  assert.equal(r.result, 'deadline');
  assert.equal(r.stdout, '');
  assert.deepEqual(stub.withdraws().map((w) => w.body), [{ reason: 'deadline' }]);
  assert.ok(stub.polls().length >= 1 && stub.polls().length <= 4, `${stub.polls().length} polls: the loop never spins`);
  t.diagnostic(`withdrawn at the deadline after ${ms} ms`);
  // Never longer than 590 s, whatever the daemon says.
  assert.equal(ask.DEADLINE_MAX_MS, 590000);
});

// ── 2. the dispatcher, as a subprocess ──────────────────────────────────────

function hookEnv(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-askhook-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_ENTRYPOINT: 'cli', ...extra };
  delete env.WEB_CHAT_HOOK_LOG;
  return env;
}

function spawnHook({ cwd, env, input, killAfterMs = 20000 }) {
  const started = Date.now();
  const child = spawn(process.execPath, [HOOK_BIN, 'ask'], { cwd, env });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdin.on('error', () => {});
  const killer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
  const done = new Promise((resolve, reject) => {
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (status, signal) => {
      clearTimeout(killer);
      resolve({ status, signal, stdout, stderr, at: Date.now(), ms: Date.now() - started });
    });
  });
  child.stdin.end(JSON.stringify(input));
  return { child, done };
}

test('dispatcher: a stub daemon that decides allow — stdout is exactly the allow line, exit 0', async (t) => {
  const stub = await asksStub(t, { poll: () => ({ state: 'decided', decision: { behavior: 'allow' } }) });
  const root = project(t, stub.port);
  const r = await spawnHook({ cwd: root, env: hookEnv(t), input: payload(root) }).done;
  assert.equal(r.status, 0);
  assert.equal(r.signal, null);
  assert.equal(r.stdout, '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}');
  assert.equal(r.stdout, buildAskOutput('permission', {}, { behavior: 'allow' }));
  assert.equal(r.stderr, '');
  assert.equal(stub.handed().length, 1);
});

test('dispatcher: SIGTERM withdraws {reason: sigterm} and exits 0, printing nothing', async (t) => {
  const stub = await asksStub(t, { poll: () => HANG });
  const root = project(t, stub.port);
  const run = spawnHook({ cwd: root, env: hookEnv(t), input: payload(root) });
  await waitUntil(() => stub.polls().length === 1, { what: 'the hook to start polling', timeout: 10000 });
  const killedAt = Date.now();
  run.child.kill('SIGTERM');
  const r = await run.done;
  const ms = r.at - killedAt;
  assert.equal(r.signal, null, 'it ended itself');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  const [w] = stub.withdraws();
  assert.deepEqual(w.body, { reason: 'sigterm' });
  assert.equal(w.headers['x-wc-ask-secret'], SECRET);
  t.diagnostic(`SIGTERM → exit in ${ms} ms (bound ${ask.SIGTERM_EXIT_MS} ms)`);
  if (PERF) assert.ok(ms <= ask.SIGTERM_EXIT_MS + 150, `${ms} ms`);
});

test('dispatcher: SIGTERM against a daemon that never answers the withdraw still exits 0 within the hard exit', async (t) => {
  // The withdraw hangs too: only the hook's own bounds (the withdraw's 300 ms
  // socket timeout, the 400 ms hard exit) can end it.
  const stub = await asksStub(t, { poll: () => HANG, withdraw: () => HANG });
  const root = project(t, stub.port);
  const run = spawnHook({ cwd: root, env: hookEnv(t), input: payload(root) });
  await waitUntil(() => stub.polls().length === 1, { what: 'the hook to start polling', timeout: 10000 });
  const killedAt = Date.now();
  run.child.kill('SIGTERM');
  const r = await run.done;
  assert.equal(r.signal, null);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(stub.withdraws().length, 1);
  t.diagnostic(`SIGTERM → exit in ${r.at - killedAt} ms with the withdraw unanswered`);
  if (PERF) assert.ok(r.at - killedAt <= ask.SIGTERM_EXIT_MS + 150);
});

test('dispatcher: SIGTERM against a withdraw that trickles forever ends on the hook\'s own 400 ms hard exit', async (t) => {
  // The poll's 5 s and the withdraw's 300 ms timeouts are socket IDLE timeouts
  // (lib/client), and a trickling response is never idle: only
  // ctx.deadline(SIGTERM_EXIT_MS), armed on SIGTERM, ends this hook. Without
  // it the child runs until the killer's SIGKILL.
  const stub = await asksStub(t, { poll: () => TRICKLE, withdraw: () => TRICKLE });
  const root = project(t, stub.port);
  const run = spawnHook({ cwd: root, env: hookEnv(t), input: payload(root), killAfterMs: 8000 });
  await waitUntil(() => stub.polls().length === 1, { what: 'the hook to start polling', timeout: 10000 });
  const killedAt = Date.now();
  run.child.kill('SIGTERM');
  const r = await run.done;
  assert.equal(r.signal, null, 'it ended itself, on its own hard exit');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(stub.withdraws().length, 1);
  t.diagnostic(`SIGTERM → exit in ${r.at - killedAt} ms with the withdraw trickling`);
  if (PERF) assert.ok(r.at - killedAt <= ask.SIGTERM_EXIT_MS + 150);
});

test('dispatcher: an unmappable decision prints nothing, exits 0, and hook.log names only ids and the outcome', async (t) => {
  const stub = await asksStub(t, {
    poll: () => ({ state: 'decided', decision: { behavior: 'answer', picks: [{ q: 0, options: [7] }, { q: 1, options: [0] }] } }),
  });
  const root = project(t, stub.port);
  const r = await spawnHook({ cwd: root, env: hookEnv(t), input: questionPayload(root) }).done;
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'the terminal prompt stands');
  assert.equal(stub.handed().length, 0);
  const log = fs.readFileSync(path.join(root, '.web-chat', 'hook.log'), 'utf8').trim().split('\n');
  assert.equal(log.length, 1);
  assert.match(log[0], new RegExp(`^\\[[0-9T:.Z-]+\\] ask PermissionRequest session=${SID} error ASK_UNMAPPED$`));
});

// ── 3. masked questions end to end (ruling A3 (a)) ──────────────────────────

const FAKES = fakeSecrets({ seed: 540 });
const SK = FAKES.find((f) => f.id === 'sk-anthropic-api').secrets[0];
const SK_B = FAKES.find((f) => f.id === 'sk-openai-legacy').secrets[0];
const SK_C = FAKES.find((f) => f.id === 'sk-openai-project').secrets[0];
const SK_D = FAKES.find((f) => f.id === 'sk-openrouter').secrets[0];
const MASK_OPEN = MASK('x').slice(0, MASK('x').indexOf('x'));

function hostAudience() {
  const browser = (req) => !!(req.headers.origin || req.headers['sec-fetch-mode'] || req.headers['sec-fetch-site']);
  return {
    levelOf: () => 'local',
    isHost: (req) => !browser(req),
    requireMirror: () => (req, res, next) => next(),
  };
}

// U53's real asks domain and routes on a bare app, the real redactor, a local
// viewer and an answer surface that starts.
async function asksDaemon(t) {
  const hooks = createHookTap();
  const surface = { port: 47002, ensure: async () => ({ port: 47002 }), remoteAnswering: () => false };
  const mirror = { subscribe: () => () => {}, conversationOfPid: () => 'conv_1' };
  const asks = createAsks({
    bus: createBus(), hooks, mirror, getViewers: () => ({ local: 1 }), answerSurface: () => surface,
    redactor: createRedactor(), audit: () => {},
  });
  const app = express();
  app.use(express.json({ limit: '200mb' }));
  mountAskRoutes(app, { asks, audience: hostAudience(), answerSurface: () => surface, hooks });
  app.use((err, req, res, next) => { void next; res.status(err.status || 500).json({ ok: false }); });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => {
    asks.stop();
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { asks, hooks, port: server.address().port };
}

// The real hook asks; the page answers by index, against what it displayed.
async function answerThroughHook(t, d, root, questions, picks) {
  const run = spawnHook({ cwd: root, env: hookEnv(t), input: questionPayload(root, questions) });
  let id = null;
  await waitUntil(() => {
    const p = d.asks.pending().find((a) => a.hook_attached);
    if (p) id = p.id;
    return id !== null;
  }, { what: 'the hook\'s ask, pending', timeout: 10000 });
  const view = d.asks.displayView(id);
  const decided = d.asks.decide(id, { behavior: 'answer', picks }, { via: 'web', version: view.version });
  const r = await run.done;
  return { r, view, decided, id };
}

const answersOf = (stdout) => JSON.parse(stdout).hookSpecificOutput.decision.updatedInput;

test('masked questions end to end: the page sees masks, picks by index, and the hook echoes the unredacted texts', async (t) => {
  const d = await asksDaemon(t);
  const root = project(t, d.port);
  const questions = [
    {
      header: 'Key', question: `Rotate ${SK} now?`, multiSelect: false,
      options: [{ label: `Yes, rotate ${SK_B}`, description: `old key ${SK_C}` }, { label: 'No', description: 'leave it' }],
    },
    { header: 'When', question: 'When?', multiSelect: false, options: [{ label: 'Now' }, { label: 'Later' }] },
  ];
  const { r, view, decided } = await answerThroughHook(t, d, root, questions, [{ q: 0, options: [0] }, { q: 1, other: 'tomorrow' }]);
  assert.equal(decided.ok, true);
  assert.equal(view.masked, true);
  const shown = view.detail.question.questions[0];
  for (const [text, secret] of [[shown.question, SK], [shown.options[0].label, SK_B], [shown.options[0].description, SK_C]]) {
    assert.ok(text.includes(MASK_OPEN), 'masked in the page');
    assert.ok(!text.includes(secret));
  }
  assert.equal(r.status, 0);
  const input = answersOf(r.stdout);
  assert.deepEqual(input.questions, questions, 'the exact unredacted questions, descriptions included');
  assert.deepEqual(input.answers, { [`Rotate ${SK} now?`]: `Yes, rotate ${SK_B}`, 'When?': 'tomorrow' });
});

test('masked questions end to end: a decision the local copy cannot map prints nothing, and the hook exits 0', async (t) => {
  // Two questions of one unredacted text are one answers key: the domain takes
  // the picks (each index exists), the hook refuses to guess.
  const d = await asksDaemon(t);
  const root = project(t, d.port);
  const twins = [
    { header: 'A', question: `Keep ${SK_B}?`, multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] },
    { header: 'B', question: `Keep ${SK_B}?`, multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] },
  ];
  const { r, decided } = await answerThroughHook(t, d, root, twins, [{ q: 0, options: [0] }, { q: 1, options: [1] }]);
  assert.equal(decided.ok, true);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'no answer: the terminal prompt stands');
  assert.match(fs.readFileSync(path.join(root, '.web-chat', 'hook.log'), 'utf8'), /error ASK_UNMAPPED/);
});

test('texts that mask alike, through the real hook: two labels, two questions, a multiSelect label holding ", "', async (t) => {
  const d = await asksDaemon(t);
  const root = project(t, d.port);

  // Two options whose labels mask identically.
  const labels = [{ header: 'K', question: 'Which key?', multiSelect: false, options: [{ label: `key ${SK_B}` }, { label: `key ${SK_D}` }] }];
  for (const i of [0, 1]) {
    const { r, view } = await answerThroughHook(t, d, root, labels, [{ q: 0, options: [i] }]);
    const shown = view.detail.question.questions[0].options;
    assert.equal(shown[0].label, shown[1].label, 'the two labels look the same in the page');
    assert.deepEqual(answersOf(r.stdout).answers, { 'Which key?': labels[0].options[i].label });
  }

  // Two questions whose texts mask identically.
  const twins = [
    { header: 'A', question: `Keep ${SK_B}?`, multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] },
    { header: 'B', question: `Keep ${SK_D}?`, multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] },
  ];
  const tw = await answerThroughHook(t, d, root, twins, [{ q: 0, options: [1] }, { q: 1, options: [0] }]);
  assert.equal(tw.view.detail.question.questions[0].question, tw.view.detail.question.questions[1].question);
  assert.deepEqual(answersOf(tw.r.stdout), { questions: twins, answers: { [`Keep ${SK_B}?`]: 'no', [`Keep ${SK_D}?`]: 'yes' } });

  // A multiSelect label that itself contains ', '.
  const multi = [{ header: 'M', question: 'Which?', multiSelect: true, options: [{ label: 'red, green' }, { label: 'blue' }, { label: 'red' }] }];
  const mu = await answerThroughHook(t, d, root, multi, [{ q: 0, options: [0, 1] }]);
  assert.deepEqual(answersOf(mu.r.stdout).answers, { 'Which?': 'red, green, blue' }, 'the picked labels joined, the comma-holding label whole');
  const solo = await answerThroughHook(t, d, root, multi, [{ q: 0, options: [0] }]);
  assert.deepEqual(answersOf(solo.r.stdout).answers, { 'Which?': 'red, green' });
});

// ── 4. the event split ──────────────────────────────────────────────────────

function ingestSeen(stats) {
  const { accepted, duplicates, ignored } = stats.ingest;
  return accepted + duplicates + Object.values(ignored).reduce((a, b) => a + b, 0);
}

test('split: a PermissionRequest envelope passes checkEnvelope; the intake refuses it and publishes nothing', async (t) => {
  await withServer(t, async (s) => {
    const env = JSON.parse(JSON.stringify(hookEnvelope(payload(s.root), ENV, { now: Date.now() })));
    assert.equal(checkEnvelope(env), null);
    const before = ingestSeen(s.srv.mirror.stats());
    const refused = await client.request(s.port, 'POST', '/api/hooks/event', env);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, 'not an event this intake takes');
    // A mirror event after it: exactly one envelope reaches the engine, so the
    // refused one never reached the tap.
    const pre = JSON.parse(JSON.stringify(hookEnvelope({ ...payload(s.root), hook_event_name: 'PreToolUse', tool_use_id: 'toolu_1' }, ENV, { now: Date.now() })));
    const taken = await client.request(s.port, 'POST', '/api/hooks/event', pre);
    assert.equal(taken.status, 200);
    await waitUntil(() => ingestSeen(s.srv.mirror.stats()) > before, { what: 'the PreToolUse at the engine', timeout: 5000 });
    assert.equal(ingestSeen(s.srv.mirror.stats()), before + 1);
  });
});

test('split: POST /api/asks still takes a PermissionRequest envelope and creates the ask', async (t) => {
  const d = await asksDaemon(t);
  const p = payload('/p');
  const env = JSON.parse(JSON.stringify(hookEnvelope(p, ENV, { now: Date.now() })));
  const published = [];
  d.hooks.subscribe((e) => published.push(e));
  const r = await client.request(d.port, 'POST', '/api/asks', {
    v: 1, envelope: env, kind: 'permission', display: projectToolInput('Bash', p.tool_input, { profile: 'display' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.body.id, /^ask_[0-9a-f]{12}$/);
  assert.equal(d.asks.get(r.body.id).state, 'pending');
  await waitUntil(() => published.some((e) => e.event === 'PermissionRequest'), { what: 'the asks domain to publish it', timeout: 5000 });
  assert.deepEqual(published.find((e) => e.event === 'PermissionRequest').ask, { id: r.body.id, kind: 'permission' });
});

// ── 5. the source ───────────────────────────────────────────────────────────

test('source: the PermissionRequest output\'s event name is spelled only in lib/hooks/ask-output.js under lib/', () => {
  const libDir = path.join(__dirname, '..', 'lib');
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|cjs|mjs|sh)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes("hookEventName: 'PermissionRequest'")) {
        hits.push(path.relative(libDir, p));
      }
    }
  };
  walk(libDir);
  assert.deepEqual(hits, [path.join('hooks', 'ask-output.js')]);
});
