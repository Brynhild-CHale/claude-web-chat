// The mod as a second transport for permission prompts (lib/server/domain/
// asks.js createFromMod / withdrawFromMod, spec §15.7, tranche 6): the real
// asks domain over a real hook tap, a real change bus and the real redactor; a
// fake `send` standing in for the bridge's permissionDecision op (U94a wires
// the real one). The ModEvents are built exactly as the bridge publishes them
// (lib/core/mod-protocol validateEvent, then the synthetic envelope of
// bridge.js publishOne).
//
//   * a 'permission.request' becomes the same ask the settings hook would
//     make — the display projected through lib/core/tool-input — with
//     transport 'mod';
//   * the duplicate rule holds both ways (ruling A1 (a)): whichever creates
//     first holds the ask, and the mod gets the pass-through decision, exactly
//     {pass: true} (ruled D5 (a)), at once;
//   * a decision goes back through `send` as the classic result itself — the
//     deny's words ask-output.js's, never updatedPermissions, updatedInput or
//     bypassPermissions — and validateOp takes the op;
//   * what the page cannot hold passes through at once, leaving no record;
//   * 'permission.settled' resolves it; the transport ships switched off.

const test = require('node:test');
const assert = require('node:assert');
const { createHookTap } = require('../lib/server/hook-tap');
const { createBus } = require('../lib/core/bus');
const { createRedactor } = require('../lib/core/redact');
const { projectToolInput, inputHash } = require('../lib/core/tool-input');
const { validateEvent, validateOp, MOD_EVENT, INPUT_MAX } = require('../lib/core/mod-protocol');
const { buildAskOutput, DENY_MESSAGE, WROTE } = require('../lib/hooks/ask-output');
const asksMod = require('../lib/server/domain/asks');
const { waitUntil } = require('../test-support/helpers');

const { createAsks, MOD_PERMISSION_WAIT_MS, PASS, HOOK_SILENT_MS, DEADLINE_MS, TTL_MS, MOD_WAIT_FLAG, modPermissionWait } = asksMod;

const SID = '9f8e7d6c-5b4a-4392-8a1b-0c2d3e4f5a6b';
const T0 = 1_790_500_000_000;
const settle = () => new Promise((r) => setImmediate(r));

// ── the rig ─────────────────────────────────────────────────────────────────

function rig(t, { viewers = { local: 1 }, send: sendImpl, withSend = true } = {}) {
  let now = T0;
  const pending = new Map();
  let seq = 0;
  const timers = {
    setTimeout(fn, ms) { seq += 1; pending.set(seq, { at: now + Math.max(0, Number(ms) || 0), fn }); return seq; },
    clearTimeout(id) { pending.delete(id); },
  };
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const [id, p] of pending) if (p.at <= end && (!next || p.at < next[1].at)) next = [id, p];
      if (!next) break;
      pending.delete(next[0]);
      now = Math.max(now, next[1].at);
      next[1].fn();
      await settle();
    }
    now = end;
    await settle();
  };
  const hooks = createHookTap();
  const bus = createBus({ maxEvents: 2000 });
  const frames = [];
  bus.setBroadcaster((f) => frames.push(f));
  const mirrorSubs = new Set();
  const mirror = {
    subscribe: (fn) => { mirrorSubs.add(fn); return () => mirrorSubs.delete(fn); },
    conversationOf: () => 'conv_mod',
    emit: (tr) => { for (const fn of [...mirrorSubs]) fn(tr); },
  };
  const sent = [];
  const send = (msg) => {
    sent.push(JSON.parse(JSON.stringify(msg)));
    return sendImpl ? sendImpl(msg) : Promise.resolve({ ok: true, result: { answered: true } });
  };
  const v = { ...viewers };
  const lines = [];
  const surface = { port: 47003, ensure: async () => ({ port: 47003 }), remoteAnswering: () => false };
  const asks = createAsks({
    bus, hooks, mirror, getViewers: () => ({ ...v }), answerSurface: () => surface,
    redactor: createRedactor(), audit: (l) => lines.push(l), now: () => now, timers,
    ...(withSend ? { send } : {}),
  });
  t.after(() => asks.stop());
  // A ModEvent exactly as the bridge publishes one.
  const modEvent = (kind, raw, ts = now) => {
    const ev = validateEvent(kind, raw);
    assert.ok(ev, `${kind} is an event the bridge takes`);
    const { kind: k, at: _at, ...payload } = ev;
    hooks.publish({ v: 1, event: MOD_EVENT, synthetic: true, ts, session_id: SID, mod: { kind: k, ...payload } });
  };
  const request = (raw) => modEvent('permission.request', { request_id: 'pr_1', tool: 'Bash', input: { command: 'npm test' }, ...raw });
  const settled = (requestId, by) => modEvent('permission.settled', { request_id: requestId, by });
  // The create body the settings ask hook posts for the same call.
  const hookBody = ({ name = 'Bash', input = { command: 'npm test' } } = {}) => ({
    v: 1,
    envelope: {
      v: 1, event: 'PermissionRequest', ts: now, session_id: SID, transcript_path: '/tmp/t.jsonl', cwd: '/p',
      prompt_id: null, claude_pid: 4242, entrypoint: 'cli', permission_mode: 'default', agent: null,
      tool: { name, use_id: null, kind: name, label: name, call: name, input: {}, input_hash: inputHash(input) }, ask: null,
    },
    kind: 'permission',
    display: projectToolInput(name, input, { profile: 'display' }),
  });
  const modAsks = () => asks.pending().filter((a) => a.transport === 'mod');
  return {
    asks, hooks, bus, frames, mirror, sent, lines, viewers: v, advance, request, settled, hookBody, modAsks,
    now: () => now, tap: (event) => hooks.recent().filter((e) => e.event === event),
  };
}

const PASS_MSG = (requestId = 'pr_1') => ({ session_id: SID, request_id: requestId, decision: { pass: true } });

// ── the record ──────────────────────────────────────────────────────────────

test('a permission.request for Bash becomes an ask with transport mod, displayed as the hook\'s create would be', async (t) => {
  const r = rig(t);
  const input = { command: 'rm -rf dist && npm run build', description: 'Rebuild' };
  r.request({ input, tool_use_id: 'toolu_mod1' });
  const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
  assert.deepEqual([ask.kind, ask.tool_name, ask.transport, ask.hook_attached, ask.answerable, ask.conversation_id],
    ['permission', 'Bash', 'mod', true, true, 'conv_mod']);
  assert.equal(ask.tool_use_id, 'toolu_mod1');
  assert.equal(ask.input_hash, inputHash(input), 'the same hash the hook computes for an uncut input');
  assert.deepEqual(r.sent, [], 'an answerable ask waits for the page: nothing sent yet');

  // The settings hook's create of the same call, in a domain of its own.
  const other = rig(t);
  const viaHook = await other.asks.create(other.hookBody({ input }));
  const strip = (v) => ({ ...v, id: null, version: null });
  assert.deepEqual(strip(r.asks.displayView(ask.id)), strip(other.asks.displayView(viaHook.id)), 'one display, either transport');
  assert.deepEqual(r.asks.displayView(ask.id).detail.permission.fields.map((f) => f.name), ['command', 'description']);

  const [published] = r.tap('PermissionRequest');
  assert.equal(published.synthetic, true, 'the daemon\'s own, routed by its session');
  assert.deepEqual(published.ask, { id: ask.id, kind: 'permission' });
  assert.equal(r.frames.filter((f) => f.type === 'mirror:ask').length, 1);
});

test('duplicate: a settings-hook create of the same call within 2 s answers duplicate; the mod holds the ask', async (t) => {
  const r = rig(t);
  r.request();
  const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
  const dup = await r.asks.create(r.hookBody());
  assert.deepEqual([dup.wait, dup.reason, dup.id], [false, 'duplicate', ask.id]);
  assert.equal(r.asks.pending().length, 1);
});

test('duplicate, the other way: the hook first, and the mod gets {pass: true} at once', async (t) => {
  const r = rig(t);
  const viaHook = await r.asks.create(r.hookBody());
  assert.equal(viaHook.wait, true);
  r.request();
  await waitUntil(() => r.sent.length === 1, { what: 'the pass-through' });
  assert.deepEqual(r.sent, [PASS_MSG()]);
  assert.deepEqual(r.sent[0].decision, PASS);
  assert.deepEqual(PASS, { pass: true }, 'exactly {pass: true} (ruled D5 (a); U88\'s mod reads the same)');
  assert.deepEqual(r.modAsks(), [], 'no second record');
  assert.equal(r.asks.get(viaHook.id).state, 'pending', 'the hook keeps its ask');
});

// ── the decision ────────────────────────────────────────────────────────────

test('decide allow: send is called once with {session_id, request_id, decision: {behavior: allow}}, and the ask is handed', async (t) => {
  const r = rig(t);
  r.request({ request_id: 'pr_allow' });
  const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
  const res = r.asks.decide(ask.id, { behavior: 'allow' }, { version: ask.version });
  assert.deepEqual([res.ok, res.outcome], [true, 'allowed']);
  await waitUntil(() => r.asks.get(ask.id).state === 'resolved', { what: 'handed' });
  assert.deepEqual(r.sent, [{ session_id: SID, request_id: 'pr_allow', decision: { behavior: 'allow' } }]);
  assert.deepEqual([r.asks.get(ask.id).by, r.asks.get(ask.id).outcome], ['web', 'allowed']);
  const op = validateOp('permissionDecision', { request_id: 'pr_allow', decision: r.sent[0].decision });
  assert.equal(op.ok, true, 'the bridge takes the op');
  assert.equal(r.tap('PermissionResolved').length, 1);
  assert.deepEqual(r.lines.map((l) => [l.outcome, l.transport]), [['allowed', 'mod'], ['allowed', 'mod']], 'the audit names the transport');
});

test('decide deny: the message is exactly what ask-output.js builds for a web deny, and nothing more', async (t) => {
  for (const message of [undefined, 'not now, use the staging build']) {
    const r = rig(t);
    r.request();
    const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
    const decision = message ? { behavior: 'deny', message } : { behavior: 'deny' };
    assert.equal(r.asks.decide(ask.id, decision, { version: ask.version }).ok, true);
    await waitUntil(() => r.sent.length === 1, { what: 'the deny' });
    const expected = JSON.parse(buildAskOutput('permission', {}, decision)).hookSpecificOutput.decision;
    assert.deepEqual(r.sent[0].decision, expected);
    assert.equal(r.sent[0].decision.message, message ? `${DENY_MESSAGE}${WROTE}${message}` : DENY_MESSAGE);
    assert.deepEqual(Object.keys(r.sent[0].decision).sort(), ['behavior', 'message']);
    const text = JSON.stringify(r.sent);
    for (const never of ['updatedPermissions', 'updatedInput', 'bypassPermissions', 'interrupt']) assert.ok(!text.includes(never), never);
    assert.equal(validateOp('permissionDecision', { request_id: 'pr_1', decision: r.sent[0].decision }).ok, true);
  }
});

test('decide terminal: the mod gets {pass: true}, and the ask reads the web\'s own choice', async (t) => {
  const r = rig(t);
  r.request();
  const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
  r.asks.decide(ask.id, { behavior: 'terminal' }, { version: ask.version });
  await waitUntil(() => r.sent.length === 1, { what: 'the pass' });
  assert.deepEqual(r.sent, [PASS_MSG()]);
  r.settled('pr_1', 'terminal');
  assert.equal(r.asks.get(ask.id).state, 'resolved');
  assert.equal(r.asks.displayView(ask.id).web_chose_terminal, true);
});

test('decide: a send the bridge refuses hands the prompt to the terminal', async (t) => {
  const r = rig(t, { send: async () => ({ ok: false, refused: 'not-attached' }) });
  r.request();
  const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
  r.asks.decide(ask.id, { behavior: 'allow' }, { version: ask.version });
  await waitUntil(() => r.asks.get(ask.id).state === 'resolved', { what: 'resolved' });
  assert.deepEqual([r.asks.get(ask.id).outcome, r.asks.get(ask.id).by], ['terminal', 'terminal']);
});

// ── what passes through ─────────────────────────────────────────────────────

test('a question, a plan, no viewer and an input the transport cut pass through at once and leave no record', async (t) => {
  const cases = [
    ['a question', {}, { request_id: 'pr_q', tool: 'AskUserQuestion', input: { questions: [{ question: 'Which?', multiSelect: false, options: [{ label: 'A' }] }] } }],
    ['a plan', {}, { request_id: 'pr_p', tool: 'ExitPlanMode', input: { plan: '# Plan' } }],
    ['no viewer', { viewers: { local: 0, last_local_at: null } }, { request_id: 'pr_v' }],
    ['a cut input', {}, { request_id: 'pr_c', input: { command: 'x'.repeat(INPUT_MAX * 3) } }],
    ['an input past the transport\'s key bound', {}, { request_id: 'pr_k', tool: 'mcp__x__y', input: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, i])) }],
    // Whole on the wire (under half of INPUT_MAX), but past the display's own
    // 1,000-character text bound: the page could not show it whole.
    ['an input the display caps', {}, { request_id: 'pr_d', tool: 'mcp__x__y', input: { a: 'q'.repeat(3000) } }],
  ];
  for (const [what, opts, raw] of cases) {
    const r = rig(t, opts);
    r.request(raw);
    await waitUntil(() => r.sent.length === 1, { what });
    assert.deepEqual(r.sent, [PASS_MSG(raw.request_id)], what);
    assert.deepEqual(r.asks.pending(), [], `${what}: no record`);
    assert.equal(r.tap('PermissionRequest').length, 0, `${what}: nothing published`);
  }
});

test('without a send (U94a unwired) the domain takes no mod ask at all', async (t) => {
  const r = rig(t, { withSend: false });
  r.request();
  await settle(); await settle();
  assert.deepEqual(r.asks.pending(), []);
});

// ── settling ────────────────────────────────────────────────────────────────

test('permission.settled by terminal or timeout resolves it terminal, with one PermissionResolved on the tap', async (t) => {
  for (const by of ['terminal', 'timeout']) {
    const r = rig(t);
    r.request();
    const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
    r.settled('pr_1', by);
    const rec = r.asks.get(ask.id);
    assert.deepEqual([rec.state, rec.outcome, rec.by], ['resolved', 'terminal', 'terminal'], by);
    const resolved = r.tap('PermissionResolved');
    assert.equal(resolved.length, 1, by);
    assert.deepEqual(resolved[0].ask, { id: ask.id, kind: 'permission', by: 'terminal', outcome: 'terminal', decision: null });
    r.settled('pr_1', by);
    assert.equal(r.tap('PermissionResolved').length, 1, 'a repeat changes nothing');
  }
});

test('permission.settled by web after a decision is the hand-off; another request id is not this ask', async (t) => {
  const r = rig(t, { send: () => new Promise(() => {}) });
  r.request();
  const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
  r.asks.decide(ask.id, { behavior: 'allow' }, { version: ask.version });
  r.settled('pr_other', 'terminal');
  assert.equal(r.asks.get(ask.id).state, 'decided');
  r.settled('pr_1', 'web');
  assert.deepEqual([r.asks.get(ask.id).state, r.asks.get(ask.id).by, r.asks.get(ask.id).outcome], ['resolved', 'web', 'allowed']);
});

test('permission.settled by terminal while the web\'s decision is still in flight: the terminal answered, not the web', async (t) => {
  const r = rig(t, { send: () => new Promise(() => {}) });
  r.request();
  const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
  r.asks.decide(ask.id, { behavior: 'allow' }, { version: ask.version });
  assert.equal(r.asks.get(ask.id).state, 'decided');
  r.settled('pr_1', 'terminal');
  assert.deepEqual([r.asks.get(ask.id).state, r.asks.get(ask.id).by, r.asks.get(ask.id).outcome], ['resolved', 'terminal', 'terminal']);
});

test('permission.settled of another session with the same request id is not this ask', async (t) => {
  const r = rig(t);
  r.request();
  const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
  const ev = validateEvent('permission.settled', { request_id: 'pr_1', by: 'terminal' });
  const { kind, at: _at, ...payload } = ev;
  r.hooks.publish({ v: 1, event: MOD_EVENT, synthetic: true, ts: r.now(), session_id: '00000000-1111-4222-8333-444444444444', mod: { kind, ...payload } });
  assert.equal(r.asks.get(ask.id).state, 'pending', 'a request id is the mod\'s per session, never global');
  r.settled('pr_1', 'terminal');
  assert.equal(r.asks.get(ask.id).state, 'resolved');
});

test('a mod ask has no silent hook: it outlives HOOK_SILENT_MS, and the waiting → busy move and session end withdraw it', async (t) => {
  const r = rig(t);
  r.request();
  const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
  await r.advance(HOOK_SILENT_MS * 2);
  assert.equal(r.asks.get(ask.id).state, 'pending', 'the mod settles by its own event, not by polling');
  r.mirror.emit({ op: 'state', session_id: SID, prev: 'waiting', state: 'working' });
  assert.deepEqual([r.asks.get(ask.id).state, r.asks.get(ask.id).by], ['resolved', 'terminal']);

  r.request({ request_id: 'pr_2', input: { command: 'ls' } });
  const second = await waitUntil(() => r.modAsks()[0], { what: 'a second mod ask' });
  r.hooks.publish({ v: 1, event: 'SessionEnd', ts: r.now() + 1, session_id: SID, agent: null, session: { reason: 'exit' } });
  assert.deepEqual([r.asks.get(second.id).state, r.asks.get(second.id).by], ['resolved', 'turn-closed']);
});

test('the mod\'s hook cannot poll its ask: it has no secret', async (t) => {
  const r = rig(t);
  r.request();
  const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
  assert.equal((await r.asks.poll(ask.id, 'anything')).status, 403);
  assert.equal(r.asks.withdraw(ask.id, '', 'sigterm').status, 403);
  assert.equal(r.asks.handed(ask.id, undefined).status, 403);
});

// ── an undecided ask is passed back ─────────────────────────────────────────
// A mod ask that resolves without a web decision delivered to the mod sends
// exactly one {pass: true} (ruled D5 (a); main-session decision after wave 3),
// so the mod lets the terminal's dialog answer at once instead of waiting out
// its permission wait; a decided ask sends its decision only.

test('pass on undecided: a superseded mod ask sends exactly one {pass: true}', async (t) => {
  const r = rig(t);
  r.request({ request_id: 'pr_old' });
  const old = await waitUntil(() => r.modAsks()[0], { what: 'the older mod ask' });
  r.request({ request_id: 'pr_new', input: { command: 'ls' } });
  await waitUntil(() => r.asks.get(old.id).state === 'resolved', { what: 'superseded' });
  assert.equal(r.asks.get(old.id).outcome, 'superseded');
  await settle();
  assert.deepEqual(r.sent, [PASS_MSG('pr_old')], 'the superseded ask is passed back, once; the newer one waits');
  await r.advance(1000);
  assert.deepEqual(r.sent, [PASS_MSG('pr_old')], 'nothing more');
});

test('pass on undecided: a TTL-expired mod ask sends exactly one {pass: true}', async (t) => {
  const r = rig(t);
  r.request();
  const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
  await r.advance(TTL_MS - 1);
  assert.deepEqual(r.sent, [], 'still waiting for the page');
  await r.advance(1);
  assert.deepEqual([r.asks.get(ask.id).state, r.asks.get(ask.id).outcome], ['resolved', 'expired']);
  assert.deepEqual(r.sent, [PASS_MSG()]);
  await r.advance(TTL_MS);
  r.asks.stop();
  assert.deepEqual(r.sent, [PASS_MSG()], 'once, and stop() adds nothing for a resolved ask');
});

test('pass on undecided: stop() passes every undecided mod ask once', async (t) => {
  const r = rig(t);
  r.request({ request_id: 'pr_a' });
  await waitUntil(() => r.modAsks().length === 1, { what: 'the first mod ask' });
  // Another agent's prompt: not superseded by the first, so both stay pending.
  const ev = validateEvent('permission.request', { request_id: 'pr_b', tool: 'Bash', input: { command: 'ls' } });
  const { kind, at: _at, ...payload } = ev;
  r.hooks.publish({ v: 1, event: MOD_EVENT, synthetic: true, ts: r.now(), session_id: '00000000-1111-4222-8333-444444444444', mod: { kind, ...payload } });
  await waitUntil(() => r.modAsks().length === 2, { what: 'the second mod ask' });
  assert.deepEqual(r.sent, []);
  r.asks.stop();
  assert.deepEqual(r.sent.map((m) => [m.request_id, m.decision]).sort(), [['pr_a', { pass: true }], ['pr_b', { pass: true }]]);
  r.asks.stop();
  assert.equal(r.sent.length, 2, 'a second stop() sends nothing');
});

test('pass on undecided: the waiting → busy move and a turn event pass the mod ask back once', async (t) => {
  const r = rig(t);
  r.request();
  const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
  r.mirror.emit({ op: 'state', session_id: SID, prev: 'waiting', state: 'working' });
  assert.equal(r.asks.get(ask.id).state, 'resolved');
  assert.deepEqual(r.sent, [PASS_MSG()]);
  r.request({ request_id: 'pr_2', input: { command: 'ls' } });
  const second = await waitUntil(() => r.modAsks()[0], { what: 'a second mod ask' });
  r.hooks.publish({ v: 1, event: 'SessionEnd', ts: r.now() + 1, session_id: SID, agent: null, session: { reason: 'exit' } });
  assert.equal(r.asks.get(second.id).state, 'resolved');
  assert.deepEqual(r.sent, [PASS_MSG(), PASS_MSG('pr_2')]);
});

test('pass on undecided: a web-decided ask sends only its decision — handed, refused, in flight past its TTL, or stopped', async (t) => {
  const allow = (id) => ({ session_id: SID, request_id: id, decision: { behavior: 'allow' } });
  // Handed: the bridge took it.
  {
    const r = rig(t);
    r.request();
    const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
    r.asks.decide(ask.id, { behavior: 'allow' }, { version: ask.version });
    await waitUntil(() => r.asks.get(ask.id).state === 'resolved', { what: 'handed' });
    r.settled('pr_1', 'web');
    r.asks.stop();
    assert.deepEqual(r.sent, [allow('pr_1')], 'handed');
  }
  // Refused by the bridge: the mod hands it to the terminal by itself.
  {
    const r = rig(t, { send: async () => ({ ok: false, refused: 'not-attached' }) });
    r.request();
    const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
    r.asks.decide(ask.id, { behavior: 'allow' }, { version: ask.version });
    await waitUntil(() => r.asks.get(ask.id).state === 'resolved', { what: 'resolved' });
    r.asks.stop();
    assert.deepEqual(r.sent, [allow('pr_1')], 'refused');
  }
  // In flight: the decision is the mod's answer, whatever ends the record.
  {
    const r = rig(t, { send: (msg) => (msg.decision.pass ? Promise.resolve({ ok: true }) : new Promise(() => {})) });
    r.request();
    const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
    r.asks.decide(ask.id, { behavior: 'allow' }, { version: ask.version });
    r.asks.stop();
    assert.deepEqual(r.sent, [allow('pr_1')], 'stopped while in flight');
  }
  {
    const r = rig(t, { send: (msg) => (msg.decision.pass ? Promise.resolve({ ok: true }) : new Promise(() => {})) });
    r.request();
    const ask = await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
    r.asks.decide(ask.id, { behavior: 'deny' }, { version: ask.version });
    await r.advance(TTL_MS);
    assert.equal(r.asks.get(ask.id).state, 'resolved');
    assert.deepEqual(r.sent.map((m) => m.decision.behavior), ['deny'], 'past its TTL');
  }
  // The mod settled the prompt itself: nothing to pass back.
  {
    const r = rig(t);
    r.request();
    await waitUntil(() => r.modAsks()[0], { what: 'the mod ask' });
    r.settled('pr_1', 'terminal');
    r.asks.stop();
    assert.deepEqual(r.sent, [], 'settled by the mod');
  }
});

// ── switched off ────────────────────────────────────────────────────────────

test('the transport ships switched off: MOD_PERMISSION_WAIT_MS is 0 (ruled D2 (a), until gate V41)', () => {
  assert.equal(MOD_PERMISSION_WAIT_MS, 0);
  assert.equal(DEADLINE_MS, 590_000, 'the figure a recorded V41 turns it to');
  // V41's knob: the daemon's environment raises it for one measured run.
  assert.equal(MOD_WAIT_FLAG, 'WEB_CHAT_MOD_PERMISSION_WAIT_MS');
  assert.equal(modPermissionWait({}), 0);
  assert.equal(modPermissionWait(undefined), 0);
  assert.equal(modPermissionWait({ [MOD_WAIT_FLAG]: '60000' }), 60_000);
  assert.equal(modPermissionWait({ [MOD_WAIT_FLAG]: '590000' }), 590_000);
  for (const bad of ['590001', '-1', '1.5', 'sixty', '', ' 60000', '1e5']) {
    assert.equal(modPermissionWait({ [MOD_WAIT_FLAG]: bad }), 0, JSON.stringify(bad));
  }
});
