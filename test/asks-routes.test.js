// The asks routes (lib/server/routes/asks.js, spec §4.3, §5.7) on a bare
// Express app with a fake ctx: the real asks domain over a real hook tap, a
// real change bus, the real redactor and the real timers; a fake audience
// (isHost / levelOf / requireMirror, driven by headers: Origin and Sec-Fetch-*
// are a browser, X-WC-Remote a remote viewer, x-test-peer a network peer), a
// fake mirror and a fake answer surface. The app parses JSON globally first,
// as the daemon does (lib/server/index.js), so the routes' own size checks are
// the ones that bite.
//
// The masked-question cases (ruling A3 (a) and the maintainer's note: a failure
// here would be silent and invisible to Claude) drive the routes as the frame
// and the hook will: a create body carrying the hook's own questions, a decide
// with picks by index, the hook's poll. U53 builds before the frame and the
// hook exist; the run through the real frame and hook is U54's and U56's.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const { createHookTap } = require('../lib/server/hook-tap');
const { createBus } = require('../lib/core/bus');
const { createRedactor, MASK } = require('../lib/core/redact');
const { projectToolInput, inputHash } = require('../lib/core/tool-input');
const { createAsks } = require('../lib/server/domain/asks');
const { mountAskRoutes, MAX_BODY_BYTES } = require('../lib/server/routes/asks');
const { fakeSecrets } = require('../test-support/fake-secrets');

const MASK_OPEN = MASK('x').slice(0, MASK('x').indexOf('x'));
const FAKES = fakeSecrets({ seed: 530 });
const SK = FAKES.find((f) => f.id === 'sk-anthropic-api').secrets[0];
const SK_B = FAKES.find((f) => f.id === 'sk-openai-legacy').secrets[0];
const SK_C = FAKES.find((f) => f.id === 'sk-openai-project').secrets[0];
const SK_D = FAKES.find((f) => f.id === 'sk-openrouter').secrets[0];

// ── the rig ─────────────────────────────────────────────────────────────────

function fakeAudience({ remoteLevel = 'basic' } = {}) {
  const levelOf = (req) => {
    if (req.headers['x-test-peer']) return 'basic';
    if (req.headers['x-wc-remote']) return remoteLevel;
    return 'local';
  };
  const browser = (req) => !!(req.headers.origin || req.headers['sec-fetch-mode'] || req.headers['sec-fetch-site']);
  return {
    levelOf,
    isHost: (req) => levelOf(req) === 'local' && !browser(req),
    requireMirror: () => (req, res, next) => next(),
  };
}

async function rig(t, { remoteLevel, viewers = { local: 1 } } = {}) {
  const hooks = createHookTap();
  const bus = createBus();
  const surface = { port: 47001, ensures: 0, ensure: async () => { surface.ensures += 1; return { port: 47001 }; }, remoteAnswering: () => false };
  const subs = new Set();
  const mirror = { subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); }, conversationOfPid: () => 'conv_1' };
  const asks = createAsks({
    bus, hooks, mirror, getViewers: () => viewers, answerSurface: () => surface,
    redactor: createRedactor(), audit: () => {},
  });
  const ctx = { asks, audience: fakeAudience({ remoteLevel }), answerSurface: () => surface, hooks };
  const app = express();
  app.use(express.json({ limit: '200mb' }));
  mountAskRoutes(app, ctx);
  // The global parser's refusal of a malformed body, quietly (the daemon's own
  // handler is not under test here).
  app.use((err, req, res, next) => { void next; res.status(err.status || 500).json({ ok: false }); });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => {
    asks.stop();
    server.closeAllConnections();
    server.close(resolve);
  }));
  const port = server.address().port;
  function call(method, path, { body, headers = {}, raw } = {}) {
    return new Promise((resolve, reject) => {
      const data = raw !== undefined ? raw : body === undefined ? null : JSON.stringify(body);
      const h = { ...headers };
      if (data !== null) {
        h['content-type'] = h['content-type'] || 'application/json';
        h['content-length'] = Buffer.byteLength(data);
      }
      const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, text, json });
        });
      });
      req.on('error', reject);
      if (data !== null) req.write(data);
      req.end();
    });
  }
  return { asks, hooks, bus, surface, ctx, call };
}

function createBody({ name = 'Bash', input = { command: 'npm test' }, session = 'sess-1', ...rest } = {}) {
  const kind = name === 'AskUserQuestion' ? 'question' : name === 'ExitPlanMode' ? 'plan' : 'permission';
  const b = {
    v: 1,
    envelope: {
      v: 1, event: 'PermissionRequest', ts: Date.now(), session_id: session, transcript_path: '/tmp/t.jsonl',
      cwd: '/p', prompt_id: null, claude_pid: 4242, entrypoint: 'cli', permission_mode: 'default', agent: null,
      tool: { name, kind, label: name, call: name, input: {}, input_hash: inputHash(input) }, ask: null,
    },
    kind,
    display: projectToolInput(name, input, { profile: 'display' }),
    ...rest,
  };
  if (kind === 'question' && !b.questions) b.questions = input.questions;
  return b;
}

const SECRET = 'x-wc-ask-secret';

// ── GET /api/asks ───────────────────────────────────────────────────────────

test('GET /api/asks: local reads AskPublic and the port; below read is projected and a remote request gets answer null', async (t) => {
  const r = await rig(t);
  const created = (await r.call('POST', '/api/asks', { body: createBody({ input: { command: `echo ${SK}` } }) })).json;
  const local = await r.call('GET', '/api/asks');
  assert.equal(local.status, 200);
  assert.deepEqual(local.json.answer, { port: 47001 });
  assert.equal(local.json.asks.length, 1);
  assert.equal(local.json.asks[0].id, created.id);
  assert.equal(local.json.asks[0].tool_name, 'Bash');
  assert.ok(!local.text.includes('echo') && !local.text.includes(SK), 'no subject or input, even masked');
  const remote = await r.call('GET', '/api/asks', { headers: { 'x-wc-remote': '1' } });
  assert.equal(remote.json.answer, null);
  assert.deepEqual(remote.json.asks, [{ id: created.id, conversation_id: 'conv_1', kind: 'permission', tool_kind: 'Bash', state: 'pending' }]);
  const peer = await r.call('GET', '/api/asks', { headers: { 'x-test-peer': '10.0.0.7' } });
  assert.equal(peer.json.answer, null);
  assert.deepEqual(Object.keys(peer.json.asks[0]).sort(), ['conversation_id', 'id', 'kind', 'state', 'tool_kind']);

  const full = await rig(t, { remoteLevel: 'full' });
  await full.call('POST', '/api/asks', { body: createBody() });
  const fr = await full.call('GET', '/api/asks', { headers: { 'x-wc-remote': '1' } });
  assert.equal(fr.json.answer, null, 'a remote page cannot use a loopback port, whatever its level');
  assert.equal(fr.json.asks[0].tool_name, 'Bash');
});

test('GET /api/asks?ensure=1 starts the answer surface for a local request only', async (t) => {
  const r = await rig(t);
  await r.call('GET', '/api/asks?ensure=1', { headers: { 'x-wc-remote': '1' } });
  await r.call('GET', '/api/asks?ensure=1', { headers: { 'x-test-peer': '10.0.0.7' } });
  await r.call('GET', '/api/asks');
  assert.equal(r.surface.ensures, 0);
  const res = await r.call('GET', '/api/asks?ensure=1');
  assert.equal(r.surface.ensures, 1);
  assert.deepEqual(res.json, { asks: [], answer: { port: 47001 } });
  // An ensure that throws is swallowed.
  r.surface.ensure = async () => { throw new Error('boom'); };
  assert.equal((await r.call('GET', '/api/asks?ensure=1')).status, 200);
});

test('GET /api/asks?ensure=1 after asks.stop() answers without starting the answer surface (U53c)', async (t) => {
  // Teardown stops the asks before it closes the answer surface, and close()
  // is re-openable: a straggler's ensure=1 landing after that must not open a
  // fresh listener (and its idle timer) the teardown has already passed.
  const r = await rig(t);
  r.asks.stop();
  const res = await r.call('GET', '/api/asks?ensure=1');
  assert.equal(res.status, 200, 'the list still answers');
  assert.deepEqual(res.json.asks, []);
  assert.equal(r.surface.ensures, 0, 'a stopped asks domain never calls ensure()');
});

// ── host only ───────────────────────────────────────────────────────────────

test('every hook-facing route answers 403 for a browser, a remote viewer and a network peer', async (t) => {
  const r = await rig(t);
  const a = (await r.call('POST', '/api/asks', { body: createBody() })).json;
  assert.equal(a.wait, true);
  const routes = [
    ['POST', '/api/asks', createBody({ session: 'sess-x' })],
    ['GET', `/api/asks/${a.id}/decision?wait=0`, undefined],
    ['POST', `/api/asks/${a.id}/withdraw`, { reason: 'sigterm' }],
    ['POST', `/api/asks/${a.id}/handed`, {}],
  ];
  const refused = [
    ['an Origin', { origin: 'http://127.0.0.1:5173' }],
    ['Sec-Fetch-Mode', { 'sec-fetch-mode': 'cors' }],
    ['X-WC-Remote', { 'x-wc-remote': '1' }],
    ['a network peer', { 'x-test-peer': '192.168.1.20' }],
  ];
  for (const [method, path, body] of routes) {
    for (const [what, headers] of refused) {
      const res = await r.call(method, path, { body, headers: { ...headers, [SECRET]: a.secret } });
      assert.equal(res.status, 403, `${method} ${path} with ${what}`);
      assert.equal(res.json.ok, false);
      assert.match(res.json.hint, /host/i);
    }
  }
  assert.equal(r.asks.publicView(a.id).state, 'pending', 'nothing refused touched the ask');
  assert.equal(r.asks.list().length, 1);
});

test('a bad secret → 403, an unknown id → 404, a missing secret → 403', async (t) => {
  const r = await rig(t);
  const a = (await r.call('POST', '/api/asks', { body: createBody() })).json;
  const bad = { [SECRET]: 'not-the-secret' };
  assert.equal((await r.call('GET', `/api/asks/${a.id}/decision`, { headers: bad })).status, 403);
  assert.equal((await r.call('GET', `/api/asks/${a.id}/decision`)).status, 403);
  assert.equal((await r.call('POST', `/api/asks/${a.id}/withdraw`, { body: { reason: 'sigterm' }, headers: bad })).status, 403);
  assert.equal((await r.call('POST', `/api/asks/${a.id}/handed`, { headers: bad })).status, 403);
  const ok = { [SECRET]: a.secret };
  assert.equal((await r.call('GET', '/api/asks/ask_000000000000/decision', { headers: ok })).status, 404);
  assert.equal((await r.call('POST', '/api/asks/ask_000000000000/withdraw', { body: { reason: 'sigterm' }, headers: ok })).status, 404);
  assert.equal((await r.call('POST', '/api/asks/ask_000000000000/handed', { headers: ok })).status, 404);
  assert.equal(r.asks.publicView(a.id).state, 'pending');
});

// ── POST /api/asks bounds ───────────────────────────────────────────────────

test('POST /api/asks over 300 KB → 413', async (t) => {
  const r = await rig(t);
  const b = createBody();
  b.suggestions = { pad: 'p'.repeat(MAX_BODY_BYTES) };
  const res = await r.call('POST', '/api/asks', { body: b });
  assert.equal(res.status, 413);
  assert.equal(r.hooks.recent().length, 0);
});

test('POST /api/asks: a bad envelope, a PreToolUse, an ask or synthetic → 400, never echoing a value', async (t) => {
  const r = await rig(t);
  const LEAK = 'LEAKY-VALUE-7731';
  const withEnv = (patch) => {
    const b = createBody({ session: LEAK });
    b.envelope = { ...b.envelope, ...patch };
    return b;
  };
  const cases = [
    ['unknown envelope field', withEnv({ extra: LEAK })],
    ['a PreToolUse (refused by the route itself)', withEnv({ event: 'PreToolUse' })],
    ['an ask', withEnv({ ask: { id: LEAK, kind: 'permission' } })],
    ['synthetic', withEnv({ synthetic: true })],
    ['v 2', { ...createBody({ session: LEAK }), v: 2 }],
    ['a kind that disagrees', { ...createBody({ session: LEAK }), kind: 'plan' }],
    ['an unknown body field', { ...createBody({ session: LEAK }), answers: LEAK }],
    ['not JSON', null],
  ];
  for (const [what, b] of cases) {
    const res = b === null
      ? await r.call('POST', '/api/asks', { raw: `{"v":1,"x":"${LEAK}"` })
      : await r.call('POST', '/api/asks', { body: b });
    assert.equal(res.status, 400, what);
    assert.ok(!res.text.includes(LEAK), `${what}: the 400 echoes nothing posted`);
  }
  assert.match((await r.call('POST', '/api/asks', { body: withEnv({ event: 'PreToolUse' }) })).json.error, /envelope\.event/);
  assert.equal(r.hooks.recent().length, 0, 'nothing published');
  assert.deepEqual(r.asks.list(), []);
});

// ── the hook's loop through the routes ──────────────────────────────────────

test('create → long-poll → decide → the poll answers the decision → handed resolves it once', async (t) => {
  const r = await rig(t);
  const a = (await r.call('POST', '/api/asks', { body: createBody() })).json;
  assert.equal(a.wait, true);
  assert.equal(a.poll_ms, 2000);
  assert.equal(a.deadline_ms, 590000);
  const auth = { [SECRET]: a.secret };
  assert.deepEqual((await r.call('GET', `/api/asks/${a.id}/decision`, { headers: auth })).json, { state: 'pending' });
  const polling = r.call('GET', `/api/asks/${a.id}/decision?wait=20000`, { headers: auth });
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(r.asks.decide(a.id, { behavior: 'deny', message: 'no' }, { via: 'web', version: 1 }).ok, true);
  const got = await polling;
  assert.deepEqual(got.json, { state: 'decided', decision: { behavior: 'deny', message: 'no' } });
  assert.equal((await r.call('POST', `/api/asks/${a.id}/handed`, { headers: auth })).json.ok, true);
  assert.deepEqual((await r.call('GET', `/api/asks/${a.id}/decision`, { headers: auth })).json, { state: 'resolved', by: 'web' });
  assert.equal(r.hooks.recent().filter((e) => e.event === 'PermissionResolved').length, 1);
  assert.equal(r.hooks.recent().filter((e) => e.event === 'PermissionRequest').length, 1);
});

test('withdraw through the route: sigterm resolves terminal; a bad reason is 400', async (t) => {
  const r = await rig(t);
  const a = (await r.call('POST', '/api/asks', { body: createBody() })).json;
  const auth = { [SECRET]: a.secret };
  assert.equal((await r.call('POST', `/api/asks/${a.id}/withdraw`, { body: { reason: 'nah' }, headers: auth })).status, 400);
  const w = await r.call('POST', `/api/asks/${a.id}/withdraw`, { body: { reason: 'sigterm' }, headers: auth });
  assert.equal(w.status, 200);
  assert.equal(w.json.outcome, 'terminal');
  assert.deepEqual((await r.call('GET', `/api/asks/${a.id}/decision`, { headers: auth })).json, { state: 'resolved', by: 'terminal' });
});

test('no viewer: the create answers wait:false and the record is listed for the chrome', async (t) => {
  const r = await rig(t, { viewers: { local: 0 } });
  const a = (await r.call('POST', '/api/asks', { body: createBody() })).json;
  assert.deepEqual(Object.keys(a).sort(), ['id', 'ok', 'reason', 'wait']);
  assert.equal(a.reason, 'no-viewer');
  const list = (await r.call('GET', '/api/asks')).json.asks;
  assert.equal(list[0].answerable, false);
});

// ── masked questions, end to end (ruling A3 (a)) ────────────────────────────

// What the hook does with a poll's picks: map them onto ITS OWN copy of the
// questions (the create body's, unredacted), as lib/hooks/ask-output.js will.
function hookAnswers(questions, decision) {
  const out = {};
  for (const p of decision.picks) {
    const q = questions[p.q];
    out[q.question] = p.other !== undefined ? p.other : p.options.map((i) => q.options[i].label).join(', ');
  }
  return out;
}

async function askAndAnswer(r, questions, picks) {
  const b = createBody({ name: 'AskUserQuestion', input: { questions } });
  const a = (await r.call('POST', '/api/asks', { body: b })).json;
  assert.equal(a.wait, true);
  const view = r.asks.displayView(a.id);
  // The frame posts indexes, as answered against the displayed texts.
  const d = r.asks.decide(a.id, { behavior: 'answer', picks }, { via: 'web', version: view.version });
  const poll = (await r.call('GET', `/api/asks/${a.id}/decision`, { headers: { [SECRET]: a.secret } })).json;
  return { a, b, view, d, poll };
}

test('masked questions: question text, label and description masked in the display view; picks by index select the unredacted texts', async (t) => {
  const r = await rig(t);
  const questions = [{
    header: 'Key',
    question: `Rotate ${SK} now?`,
    multiSelect: false,
    options: [
      { label: `Yes, rotate ${SK_B}`, description: `old key ${SK_C}` },
      { label: 'No', description: 'leave it' },
    ],
  }];
  const { a, view, d, poll } = await askAndAnswer(r, questions, [{ q: 0, options: [0] }]);
  assert.equal(view.masked, true);
  const shown = view.detail.question.questions[0];
  for (const [text, secret] of [[shown.question, SK], [shown.options[0].label, SK_B], [shown.options[0].description, SK_C]]) {
    assert.ok(text.includes(MASK_OPEN), 'masked');
    assert.ok(!text.includes(secret), 'the secret never shows');
  }
  assert.equal(d.ok, true);
  assert.deepEqual(poll, { state: 'decided', decision: { behavior: 'answer', picks: [{ q: 0, options: [0] }] } });
  assert.deepEqual(hookAnswers(questions, poll.decision), { [`Rotate ${SK} now?`]: `Yes, rotate ${SK_B}` });
  const listed = await r.call('GET', '/api/asks');
  for (const s of [SK, SK_B, SK_C, 'Rotate']) assert.ok(!listed.text.includes(s));
  assert.equal(listed.json.asks[0].masked, true);
  assert.equal(a.wait, true);
});

test('masked questions: a pick of a question or option this ask did not display → 400, nothing stored, the poll still pending', async (t) => {
  const r = await rig(t);
  const questions = [{ header: 'Key', question: `Use ${SK}?`, multiSelect: false, options: [{ label: `key ${SK_B}` }, { label: 'none' }] }];
  for (const picks of [[{ q: 0, options: [2] }], [{ q: 1, options: [0] }], [{ q: 0, options: [-1] }], [{ q: '0', options: [0] }]]) {
    const { a, d, poll } = await askAndAnswer(r, questions, picks);
    assert.equal(d.status, 400, JSON.stringify(picks));
    assert.match(d.invalid, /^picks/);
    assert.deepEqual(poll, { state: 'pending' });
    assert.equal(r.asks.publicView(a.id).state, 'pending');
    r.asks.withdraw(a.id, a.secret, 'sigterm');
  }
});

test('texts that mask alike: two labels, two questions, a multiSelect label with ", " — each pick selects exactly the unredacted text picked', async (t) => {
  const r = await rig(t);

  // Two options whose labels mask identically.
  const labels = [{ header: 'K', question: 'Which key?', multiSelect: false, options: [{ label: `key ${SK_B}` }, { label: `key ${SK_D}` }] }];
  for (const i of [0, 1]) {
    const { a, view, poll } = await askAndAnswer(r, labels, [{ q: 0, options: [i] }]);
    const shown = view.detail.question.questions[0].options;
    assert.equal(shown[0].label, shown[1].label, 'the two labels look the same in the frame');
    assert.deepEqual(hookAnswers(labels, poll.decision), { 'Which key?': labels[0].options[i].label });
    assert.notEqual(hookAnswers(labels, poll.decision)['Which key?'], labels[0].options[1 - i].label);
    r.asks.handed(a.id, a.secret);
  }

  // Two questions whose texts mask identically.
  const twins = [
    { header: 'A', question: `Keep ${SK_B}?`, multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] },
    { header: 'B', question: `Keep ${SK_D}?`, multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] },
  ];
  const { a: ta, view: tv, poll: tp } = await askAndAnswer(r, twins, [{ q: 0, options: [1] }, { q: 1, options: [0] }]);
  assert.equal(tv.detail.question.questions[0].question, tv.detail.question.questions[1].question);
  assert.deepEqual(hookAnswers(twins, tp.decision), { [`Keep ${SK_B}?`]: 'no', [`Keep ${SK_D}?`]: 'yes' });
  r.asks.handed(ta.id, ta.secret);

  // A multiSelect label that itself contains ', '.
  const multi = [{ header: 'M', question: 'Which?', multiSelect: true, options: [{ label: 'red, green' }, { label: 'blue' }, { label: 'red' }] }];
  const { poll: mp } = await askAndAnswer(r, multi, [{ q: 0, options: [0, 1] }]);
  assert.deepEqual(mp.decision.picks, [{ q: 0, options: [0, 1] }], 'the indexes, never a joined string');
  assert.deepEqual(mp.decision.picks[0].options.map((i) => multi[0].options[i].label), ['red, green', 'blue']);
});
