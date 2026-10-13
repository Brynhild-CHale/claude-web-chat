// An MCP elicitation in the asks domain (lib/server/domain/asks.js, spec
// §15.7, tranche 6): U53's real domain and routes on a bare Express app, the
// real hook tap, a real change bus and the real redactor; a fake audience,
// viewer summary and answer surface; the real elicit hook as a subprocess for
// the end-to-end case.
//
//   * answerable only while a LOCAL viewer is connected NOW (a viewer seen
//     30 s ago is not one: the terminal shows no dialog while the hook waits),
//     for ELICIT_WAIT_MS;
//   * every bound of the create refused with its field;
//   * a decide validated against the DISPLAYED form — a missing required key,
//     an unknown key, a wrong type, an enum miss, a number out of range, a
//     string too long: 400 and nothing stored;
//   * never answered remotely, at any level (ruled D3 (a));
//   * the content never in the audit, a mirror:ask frame, a ring entry or the
//     tap, and gone from the record once the hook has printed it;
//   * resolved by a newer elicitation of its session and the turn events,
//     never by a tool event or the sessions file.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');

const { createHookTap } = require('../lib/server/hook-tap');
const { createBus } = require('../lib/core/bus');
const { createRedactor, MASK } = require('../lib/core/redact');
const { inputHash, projectToolInput } = require('../lib/core/tool-input');
const asksMod = require('../lib/server/domain/asks');
const { mountAskRoutes } = require('../lib/server/routes/asks');
const client = require('../lib/client');
const { writePortfileAt } = require('../lib/core/portfiles');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { formSchema } = require('../lib/hooks/elicitation');
const { fakeSecrets } = require('../test-support/fake-secrets');
const { tmpRoot, waitUntil } = require('../test-support/helpers');

const { createAsks, checkCreate, ELICIT_WAIT_MS, DEADLINE_MS } = asksMod;

const HOOK_BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat-hook.js');
const MASK_OPEN = MASK('x').slice(0, MASK('x').indexOf('x'));
const FAKES = fakeSecrets({ seed: 92 });
const SK = FAKES.find((f) => f.id === 'sk-anthropic-api').secrets[0];
const SID = '1e2d3c4b-5a69-4788-8a9b-0c1d2e3f4a5b';
const TYPED = 'TYPED-VALUE-correct-horse';

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Your name', maxLength: 40 },
    count: { type: 'integer', minimum: 1, maximum: 9 },
    ratio: { type: 'number' },
    ok: { type: 'boolean' },
    size: { type: 'string', enum: ['small', 'large'] },
  },
  required: ['name', 'ok'],
};
const GOOD = { name: TYPED, count: 3, ok: true, size: 'large' };

// ── the rig ─────────────────────────────────────────────────────────────────

function fakeAudience() {
  const browser = (req) => !!(req.headers.origin || req.headers['sec-fetch-mode'] || req.headers['sec-fetch-site']);
  return {
    levelOf: (req) => (req.headers['x-wc-remote'] ? 'full' : 'local'),
    isHost: (req) => !req.headers['x-wc-remote'] && !browser(req),
    requireMirror: () => (req, res, next) => next(),
  };
}

async function rig(t, { viewers = { local: 1 }, remoteAnswering = false, now } = {}) {
  const hooks = createHookTap();
  const bus = createBus({ maxEvents: 2000 });
  const frames = [];
  bus.setBroadcaster((f) => frames.push(f));
  const surface = { port: 47002, ensure: async () => ({ port: 47002 }), remoteAnswering: () => remoteAnswering };
  const mirrorSubs = new Set();
  const mirror = {
    subscribe: (fn) => { mirrorSubs.add(fn); return () => mirrorSubs.delete(fn); },
    conversationOfPid: () => 'conv_1',
    emit: (tr) => { for (const fn of [...mirrorSubs]) fn(tr); },
  };
  const lines = [];
  const v = { ...viewers };
  const asks = createAsks({
    bus, hooks, mirror, getViewers: () => ({ ...v }), answerSurface: () => surface,
    redactor: createRedactor(), audit: (l) => lines.push(l), ...(now ? { now } : {}),
  });
  const app = express();
  app.use(express.json({ limit: '200mb' }));
  mountAskRoutes(app, { asks, audience: fakeAudience(), answerSurface: () => surface, hooks });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { asks.stop(); server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  const post = async (p, body, headers) => {
    try { return { status: 200, body: await client.post(p, body, { port, noSpawn: true, timeout: 5000, headers }) }; } catch (e) {
      if (e && Number.isInteger(e.status)) return { status: e.status, body: e.body };
      throw e;
    }
  };
  const get = async (p, headers) => {
    try { return { status: 200, body: await client.get(p, { port, noSpawn: true, timeout: 5000, headers }) }; } catch (e) {
      if (e && Number.isInteger(e.status)) return { status: e.status, body: e.body };
      throw e;
    }
  };
  return {
    asks, hooks, bus, frames, lines, viewers: v, mirror, port, post, get,
    askFrames: () => frames.filter((f) => f.type === 'mirror:ask'),
  };
}

function envelope(over = {}) {
  return {
    v: 1, event: 'Elicitation', ts: Date.now(), session_id: SID, transcript_path: '/tmp/t.jsonl', cwd: '/p',
    prompt_id: null, claude_pid: 4242, entrypoint: 'cli', permission_mode: 'default', agent: null,
    tool: null, result: null, session: null, compact: null, stop: null, prompt: null, ask: null, ...over,
  };
}

function body(over = {}, el = {}) {
  return {
    v: 1,
    envelope: envelope(over.envelope),
    kind: 'elicitation',
    elicitation: { server: 'scratch', message: 'Who is asking?', mode: 'form', elicitation_id: 'el-1', schema: SCHEMA, ...el },
    ...(over.extra || {}),
  };
}

const decided = (asks, id, decision, meta = {}) => asks.decide(id, decision, { version: asks.get(id).version, ...meta });

// ── answerable: a local viewer now, for ELICIT_WAIT_MS ──────────────────────

test('create: wait true only with a local viewer connected now, with deadline_ms ELICIT_WAIT_MS', async (t) => {
  const r = await rig(t);
  const res = await r.post('/api/asks', body());
  assert.equal(res.status, 200);
  assert.equal(res.body.wait, true);
  assert.equal(res.body.deadline_ms, ELICIT_WAIT_MS);
  assert.equal(ELICIT_WAIT_MS, 45_000);
  assert.ok(typeof res.body.secret === 'string' && res.body.secret.length > 20);
  const rec = r.asks.get(res.body.id);
  assert.deepEqual([rec.kind, rec.tool_name, rec.tool_kind, rec.transport, rec.answerable, rec.hook_attached],
    ['elicitation', 'scratch', 'elicitation', 'hook', true, true]);
});

test('create: a viewer seen 30 s ago is no viewer for an elicitation (it is for a permission)', async (t) => {
  const r = await rig(t, { viewers: { local: 0, last_local_at: Date.now() - 30_000 } });
  const res = await r.post('/api/asks', body());
  assert.equal(res.body.wait, false);
  assert.equal(res.body.reason, 'no-viewer');
  assert.equal(r.asks.get(res.body.id).answerable, false);
  // The same viewer state answers a permission (LOCAL_RECENT_MS), whose
  // terminal prompt stays up while its hook waits.
  const perm = await r.asks.create({
    v: 1,
    envelope: {
      ...envelope({ event: 'PermissionRequest', session_id: 'other-session' }),
      tool: { name: 'Bash', kind: 'Bash', label: 'Bash', call: 'Bash', input: {}, input_hash: inputHash({ command: 'ls' }) },
    },
    kind: 'permission',
    display: projectToolInput('Bash', { command: 'ls' }, { profile: 'display' }),
  });
  assert.equal(perm.wait, true);
  assert.equal(perm.deadline_ms, DEADLINE_MS);
});

test('create: a duplicate within 2 s answers duplicate; the record\'s answerable rules are unchanged', async (t) => {
  const r = await rig(t);
  const a = await r.asks.create(body());
  const b = await r.asks.create(body());
  assert.equal(a.wait, true);
  assert.deepEqual([b.wait, b.reason, b.id], [false, 'duplicate', a.id]);
});

// ── the create's bounds ─────────────────────────────────────────────────────

test('checkCreate: every bound of an elicitation is refused with its field; the route says the same', async (t) => {
  const r = await rig(t);
  const long = (n) => 'x'.repeat(n);
  const props = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { type: 'string' }]));
  const withProp = (p) => ({ schema: { type: 'object', properties: { a: p } } });
  const cases = [
    [body({ extra: { display: { input: {}, truncated: [] } } }), 'body'],
    [body({ extra: { kind: 'permission' } }), 'kind'],
    [body({ envelope: { tool: { name: 'x' } } }), 'envelope.tool'],
    [body({ envelope: { session_id: '' } }), 'envelope.session_id'],
    [body({ envelope: { ts: 'now' } }), 'envelope.ts'],
    [body({}, { extra: 1 }), 'elicitation'],
    [{ ...body(), elicitation: 'form' }, 'elicitation'],
    [body({}, { server: '' }), 'elicitation.server'],
    [body({}, { server: long(201) }), 'elicitation.server'],
    [body({}, { message: long(4001) }), 'elicitation.message'],
    [body({}, { message: 7 }), 'elicitation.message'],
    [body({}, { mode: 'url' }), 'elicitation.mode'],
    [body({}, { elicitation_id: long(201) }), 'elicitation.elicitation_id'],
    [body({}, { schema: null }), 'elicitation.schema'],
    [body({}, { schema: { type: 'object', properties: { a: { type: 'string' } }, $schema: 'x' } }), 'elicitation.schema'],
    [body({}, { schema: { type: 'array', properties: { a: { type: 'string' } } } }), 'elicitation.schema.type'],
    [body({}, { schema: { type: 'object', properties: {} } }), 'elicitation.schema.properties'],
    [body({}, { schema: { type: 'object', properties: props(21) } }), 'elicitation.schema.properties'],
    [body({}, { schema: { type: 'object', properties: { [long(101)]: { type: 'string' } } } }), 'elicitation.schema.properties'],
    [body({}, withProp({ type: 'string', pattern: '.*' })), 'elicitation.schema.properties'],
    [body({}, withProp({ type: 'object' })), 'elicitation.schema.type'],
    [body({}, withProp({ type: 'string', title: long(201) })), 'elicitation.schema.title'],
    [body({}, withProp({ type: 'string', description: long(1001) })), 'elicitation.schema.description'],
    [body({}, withProp({ type: 'string', enum: Array.from({ length: 51 }, (_, i) => `v${i}`) })), 'elicitation.schema.enum'],
    [body({}, withProp({ type: 'string', enum: [long(201)] })), 'elicitation.schema.enum'],
    [body({}, withProp({ type: 'number', enum: ['1'] })), 'elicitation.schema.enum'],
    [body({}, withProp({ type: 'number', minimum: 'low' })), 'elicitation.schema.minimum'],
    [body({}, withProp({ type: 'number', minimum: 5, maximum: 1 })), 'elicitation.schema.maximum'],
    [body({}, withProp({ type: 'string', minimum: 1 })), 'elicitation.schema.minimum'],
    [body({}, withProp({ type: 'string', minLength: -1 })), 'elicitation.schema.minLength'],
    [body({}, withProp({ type: 'string', maxLength: 1.5 })), 'elicitation.schema.maxLength'],
    [body({}, withProp({ type: 'string', format: 'ipv4' })), 'elicitation.schema.format'],
    [body({}, withProp({ type: 'boolean', default: 'yes' })), 'elicitation.schema.default'],
    [body({}, { schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] } }), 'elicitation.schema.required'],
    [body({}, { schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'a'] } }), 'elicitation.schema.required'],
  ];
  for (const [b, field] of cases) {
    assert.equal(checkCreate(b), field, `${field}: ${JSON.stringify(b.elicitation || b.kind).slice(0, 80)}`);
    const res = await r.post('/api/asks', b);
    assert.equal(res.status, 400, field);
  }
  assert.equal(checkCreate(body()), null);
  assert.equal(checkCreate(body({}, { schema: formSchema(SCHEMA) })), null, 'the hook\'s own copy passes');
  assert.equal(r.asks.list().length, 0, 'nothing was created');
});

// ── the decision ────────────────────────────────────────────────────────────

test('decide: each refusal of the content is 400 and nothing is stored', async (t) => {
  const r = await rig(t);
  const { id } = await r.asks.create(body());
  const refused = [
    [{ ok: true }, 'content.required'],
    [{ name: '', ok: true }, 'content.required'],
    [{ ...GOOD, colour: 'red' }, 'content.key'],
    [{ ...GOOD, count: '3' }, 'content.type'],
    [{ ...GOOD, count: 2.5 }, 'content.type'],
    [{ ...GOOD, ok: 'true' }, 'content.type'],
    [{ ...GOOD, ratio: Number.NaN }, 'content.type'],
    [{ ...GOOD, size: 'medium' }, 'content.enum'],
    [{ ...GOOD, count: 10 }, 'content.range'],
    [{ ...GOOD, count: 0 }, 'content.range'],
    [{ ...GOOD, name: 'x'.repeat(41) }, 'content.length'],
  ];
  for (const [content, invalid] of refused) {
    const res = decided(r.asks, id, { behavior: 'accept', content });
    assert.deepEqual([res.ok, res.status, res.invalid], [false, 400, invalid], JSON.stringify(content));
  }
  assert.deepEqual(decided(r.asks, id, { behavior: 'accept' }), { ok: false, status: 400, invalid: 'content' });
  assert.deepEqual(decided(r.asks, id, { behavior: 'decline', content: GOOD }), { ok: false, status: 400, invalid: 'content' });
  assert.deepEqual(decided(r.asks, id, { behavior: 'allow' }), { ok: false, status: 400, invalid: 'behavior' });
  const rec = r.asks.get(id);
  assert.deepEqual([rec.state, rec.content_held, rec.version], ['pending', false, 1], 'nothing stored');
  assert.equal(r.lines.length, 0, 'no decision audited');
});

test('decide: a string over 2,000 characters is refused whatever maxLength says', async (t) => {
  const r = await rig(t);
  const { id } = await r.asks.create(body({}, { schema: { type: 'object', properties: { note: { type: 'string', maxLength: 100000 } } } }));
  assert.equal(decided(r.asks, id, { behavior: 'accept', content: { note: 'x'.repeat(2001) } }).invalid, 'content.length');
  assert.equal(decided(r.asks, id, { behavior: 'accept', content: { note: 'x'.repeat(2000) } }).ok, true);
});

test('decide: a remote decide is 403 remote-off even at full with remote answering on; the view says so', async (t) => {
  const r = await rig(t, { remoteAnswering: true });
  const { id } = await r.asks.create(body());
  assert.deepEqual(decided(r.asks, id, { behavior: 'accept', content: GOOD }, { remote: true }), { ok: false, status: 403, why_not: 'remote-off' });
  assert.deepEqual(decided(r.asks, id, { behavior: 'decline' }, { remote: true }), { ok: false, status: 403, why_not: 'remote-off' });
  assert.equal(r.asks.displayView(id, { remote: true }).why_not, 'remote-off');
  assert.equal(r.asks.displayView(id, { remote: true }).can_answer, false);
  assert.equal(r.asks.displayView(id).can_answer, true, 'locally it is answerable');
  assert.equal(r.asks.get(id).state, 'pending');
});

test('the content never reaches the audit, a frame, a ring entry or the tap, and leaves the record once handed', async (t) => {
  const r = await rig(t);
  const res = await r.post('/api/asks', body());
  const { id, secret } = res.body;
  const ok = decided(r.asks, id, { behavior: 'accept', content: GOOD });
  assert.deepEqual([ok.ok, ok.state, ok.outcome], [true, 'decided', 'accepted']);
  assert.equal(r.asks.get(id).content_held, true, 'held for the hook');
  const poll = await r.get(`/api/asks/${id}/decision`, { 'X-WC-Ask-Secret': secret });
  assert.deepEqual(poll.body, { state: 'decided', decision: { behavior: 'accept', content: GOOD } }, 'the hook collects it');
  assert.equal(r.asks.get(id).content_held, true, 'until the hook has printed it');
  const handed = await r.post(`/api/asks/${id}/handed`, null, { 'X-WC-Ask-Secret': secret });
  assert.equal(handed.body.state, 'resolved');
  assert.equal(r.asks.get(id).content_held, false, 'gone once handed');
  assert.deepEqual(r.asks.get(id).outcome, 'accepted');

  const emitted = JSON.stringify({ audit: r.lines, frames: r.frames, ring: r.bus.events, tap: r.hooks.recent() });
  const views = JSON.stringify([r.asks.get(id), r.asks.publicView(id), r.asks.displayView(id), r.asks.list()]);
  assert.ok(!emitted.includes(TYPED) && !views.includes(TYPED), 'the typed text appears nowhere');
  assert.ok(!emitted.includes('large'), 'nor the enum choice (the view lists it only as an option)');
  assert.deepEqual(r.lines.map((l) => l.outcome), ['accepted', 'accepted']);
  assert.ok(r.askFrames().every((f) => f.ask.tool_kind === 'elicitation' && f.ask.tool_name === 'scratch'));
  const tap = r.hooks.recent();
  assert.deepEqual(tap.filter((e) => e.event === 'Elicitation').map((e) => e.ask), [{ id, kind: 'elicitation' }]);
  const [resolved] = tap.filter((e) => e.event === 'PermissionResolved');
  assert.deepEqual(resolved.ask, { id, kind: 'elicitation', by: 'web', outcome: 'accepted', decision: 'accept' });
});

test('the content also leaves the record when the ask resolves before the hook prints it', async (t) => {
  const r = await rig(t);
  const { id } = await r.asks.create(body());
  decided(r.asks, id, { behavior: 'accept', content: GOOD });
  assert.equal(r.asks.get(id).content_held, true);
  r.hooks.publish({ ...envelope({ event: 'Stop', ts: Date.now() + 1000 }), stop: {} });
  assert.equal(r.asks.get(id).state, 'resolved');
  assert.equal(r.asks.get(id).content_held, false);
});

test('decide: decline, cancel and terminal are their own outcomes', async (t) => {
  for (const [behavior, outcome] of [['decline', 'declined'], ['cancel', 'cancelled'], ['terminal', 'terminal']]) {
    const r = await rig(t);
    const { id } = await r.asks.create(body());
    const res = decided(r.asks, id, { behavior });
    assert.deepEqual([res.ok, res.outcome], [true, outcome], behavior);
  }
});

// ── the display ─────────────────────────────────────────────────────────────

test('display: the server, the message and the fields, redacted; nothing of the user\'s', async (t) => {
  const r = await rig(t);
  const { id } = await r.asks.create(body({}, {
    message: `Paste the key like ${SK}`,
    schema: { type: 'object', properties: { key: { type: 'string', title: 'API key', description: `e.g. ${SK}`, default: 'none', format: 'uri' }, n: { type: 'number', minimum: 0 } }, required: ['key'] },
  }));
  const v = r.asks.displayView(id);
  assert.equal(v.kind, 'elicitation');
  assert.equal(v.tool_name, 'scratch');
  assert.equal(v.masked, true);
  assert.equal(v.complete, true, 'a masked message or description still answers');
  const e = v.detail.elicitation;
  assert.equal(e.server, 'scratch');
  assert.ok(!e.message.includes(SK) && e.message.includes(MASK_OPEN));
  assert.deepEqual(e.fields.map((f) => [f.name, f.type, f.required]), [['key', 'string', true], ['n', 'number', false]]);
  assert.ok(!e.fields[0].description.includes(SK));
  assert.deepEqual([e.fields[0].title, e.fields[0].default, e.fields[0].format, e.fields[1].minimum], ['API key', 'none', 'uri', 0]);
  assert.ok(!JSON.stringify(v).includes(SK));
  assert.ok(!JSON.stringify(r.asks.publicView(id)).includes('Paste'), 'the pane-readable view has no message');
});

test('display: an enum value the redactor would change makes the form the terminal\'s (too-long)', async (t) => {
  const r = await rig(t);
  const { id } = await r.asks.create(body({}, { schema: { type: 'object', properties: { key: { type: 'string', enum: [SK, 'other'] } } } }));
  const v = r.asks.displayView(id);
  assert.deepEqual([v.complete, v.why_not, v.can_answer], [false, 'too-long', false]);
  assert.deepEqual(decided(r.asks, id, { behavior: 'accept', content: { key: 'other' } }), { ok: false, status: 409, why_not: 'too-long' });
  assert.equal(decided(r.asks, id, { behavior: 'decline' }).ok, true, 'declining it still works');
});

test('display: a field NAME the redactor would change makes the form the terminal\'s (too-long)', async (t) => {
  const r = await rig(t);
  const secret = FAKES.find((f) => f.id === 'sk-openai-legacy').secrets[0];
  assert.ok(secret.length <= 100, 'a name the bounds take');
  const { id } = await r.asks.create(body({}, { schema: { type: 'object', properties: { [secret]: { type: 'string' }, n: { type: 'number' } } } }));
  assert.ok(id, 'created');
  const v = r.asks.displayView(id);
  assert.deepEqual([v.complete, v.why_not, v.can_answer, v.masked], [false, 'too-long', false, true]);
  assert.deepEqual(decided(r.asks, id, { behavior: 'accept', content: { n: 1 } }), { ok: false, status: 409, why_not: 'too-long' });
  assert.equal(decided(r.asks, id, { behavior: 'decline' }).ok, true, 'declining it still works');
});

// ── resolution ──────────────────────────────────────────────────────────────

test('resolution: a newer elicitation of the session supersedes it; a permission ask does not, nor the other way', async (t) => {
  const r = await rig(t);
  const a = await r.asks.create(body());
  const perm = await r.asks.create({
    v: 1,
    envelope: { ...envelope({ event: 'PermissionRequest' }), tool: { name: 'Bash', input_hash: inputHash({ command: 'ls' }) } },
    kind: 'permission',
    display: projectToolInput('Bash', { command: 'ls' }, { profile: 'display' }),
  });
  assert.equal(r.asks.get(a.id).state, 'pending', 'a permission does not supersede an elicitation');
  const b = await r.asks.create(body({ envelope: { ts: Date.now() + 5 } }, { message: 'A second form' }));
  assert.deepEqual([r.asks.get(a.id).state, r.asks.get(a.id).outcome], ['resolved', 'superseded']);
  assert.equal(r.asks.get(b.id).state, 'pending');
  assert.equal(r.asks.get(perm.id).state, 'pending', 'an elicitation does not supersede a permission');
});

test('resolution: a tool event or the sessions file never resolves an elicitation; a turn event and the hook\'s withdraw do', async (t) => {
  const r = await rig(t);
  const { id, secret } = await r.asks.create(body());
  const later = Date.now() + 1000;
  r.hooks.publish({ ...envelope({ event: 'PreToolUse', ts: later }), tool: { name: 'Read', use_id: 'toolu_x', input_hash: 'h' } });
  r.hooks.publish({ ...envelope({ event: 'PostToolUse', ts: later }), tool: { name: 'mcp__scratch__ask', use_id: 'toolu_y', input_hash: 'h2' } });
  r.mirror.emit({ op: 'waiting-cleared', session_id: SID, by: 'terminal' });
  r.mirror.emit({ op: 'state', session_id: SID, prev: 'waiting', state: 'working' });
  assert.equal(r.asks.get(id).state, 'pending', 'still the page\'s');
  const w = r.asks.withdraw(id, secret, 'deadline');
  assert.deepEqual([w.state, w.outcome], ['resolved', 'expired']);

  const again = await r.asks.create(body({ envelope: { ts: Date.now() + 2000 } }, { message: 'again' }));
  r.hooks.publish({ ...envelope({ event: 'Stop', ts: Date.now() + 5000 }), stop: {} });
  assert.deepEqual([r.asks.get(again.id).state, r.asks.get(again.id).by], ['resolved', 'turn-closed']);
});

test('resolution: an elicitation\'s TTL is its own wait plus a silent hook\'s grace, not a permission\'s 620 s', async (t) => {
  const now = 1_800_000_000_000;
  const r = await rig(t, { now: () => now });
  const { id } = await r.asks.create(body({ envelope: { ts: now } }));
  const rec = r.asks.get(id);
  assert.equal(rec.expires_at - rec.created_at, ELICIT_WAIT_MS + asksMod.HOOK_SILENT_MS);
  assert.ok(rec.expires_at - rec.created_at < asksMod.TTL_MS);
});

// ── end to end: the real hook against the real domain ──────────────────────

test('end to end: the elicit hook against the real domain prints the typed content, and the record lets it go', async (t) => {
  const r = await rig(t);
  const root = tmpRoot('wc-elicit-e2e-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePortfileAt(path.join(root, '.web-chat'), { pid: process.pid, port: r.port });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-elicit-e2e-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_ENTRYPOINT: 'cli' };
  delete env.WEB_CHAT_HOOK_LOG;
  const input = {
    session_id: SID, transcript_path: '/tmp/t.jsonl', cwd: root, hook_event_name: 'Elicitation',
    mcp_server_name: 'scratch', message: 'Who is asking?', mode: 'form', elicitation_id: 'el-9', requested_schema: SCHEMA,
  };
  const child = spawn(process.execPath, [HOOK_BIN, 'elicit'], { cwd: root, env });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  const done = new Promise((resolve) => child.on('close', (status) => resolve(status)));
  child.stdin.end(JSON.stringify(input));
  const pending = await waitUntil(() => r.asks.pending()[0], { what: 'the hook to create its ask', timeout: 10000 });
  assert.equal(pending.kind, 'elicitation');
  assert.equal(decided(r.asks, pending.id, { behavior: 'accept', content: { ...GOOD, ratio: 0.5 } }).ok, true);
  assert.equal(await done, 0);
  assert.deepEqual(JSON.parse(stdout), {
    hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: { name: TYPED, count: 3, ok: true, size: 'large', ratio: 0.5 } },
  });
  await waitUntil(() => r.asks.get(pending.id).state === 'resolved', { what: 'handed' });
  assert.equal(r.asks.get(pending.id).content_held, false);
  assert.deepEqual(r.hooks.recent().find((e) => e.event === 'Elicitation').session_id, hookEnvelope(input, env).session_id);
});
