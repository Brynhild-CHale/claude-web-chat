// The asks domain (lib/server/domain/asks.js, spec §4.3): how a PermissionRequest
// the ask hook posts becomes a record the chrome shows, the answer surface
// decides and the hook collects.
//
// The rig is the domain over its real neighbours where they are cheap: a real
// hook tap (lib/server/hook-tap), a real change bus standing in for the mirror
// bus (its broadcaster records the frames), the real redactor; and fakes where
// they are not: a mirror with subscribe/conversationOfPid that the test drives,
// a viewer summary, an answer surface, and a fake clock whose timers only fire
// when the test advances it (the TTL, a silent hook, the long-polls).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHookTap } = require('../lib/server/hook-tap');
const { createBus } = require('../lib/core/bus');
const { createRedactor, MASK, WITHHELD } = require('../lib/core/redact');
const { projectToolInput, inputHash } = require('../lib/core/tool-input');
const { renderMarkdown } = require('../lib/core/markdown');
const { projectPaths } = require('../lib/core/paths');
const { fakeSecrets } = require('../test-support/fake-secrets');
const asksMod = require('../lib/server/domain/asks');

const { createAsks, TTL_MS, HOOK_SILENT_MS, DUPLICATE_MS, LOCAL_RECENT_MS, AUDIT_MAX_BYTES, RESOLVED_KEEP_MS } = asksMod;

const T0 = 1_790_000_000_000;
const PERF = process.env.WEB_CHAT_PERF === '1';
const MASK_OPEN = MASK('x').slice(0, MASK('x').indexOf('x'));
const FAKES = fakeSecrets({ seed: 53 });
const SK = FAKES.find((f) => f.id === 'sk-anthropic-api').secrets[0];
const SK2 = FAKES.find((f) => f.id === 'sk-openai-legacy').secrets[0];

const settle = () => new Promise((r) => setImmediate(r));

// ── the rig ─────────────────────────────────────────────────────────────────

function fakeClock(start = T0) {
  let t = start;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => t,
    set(ms) { t = ms; },
    timers: {
      setTimeout(fn, ms) { seq += 1; pending.set(seq, { at: t + Math.max(0, Number(ms) || 0), fn }); return seq; },
      clearTimeout(id) { pending.delete(id); },
    },
    count: () => pending.size,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, p] of pending) if (p.at <= end && (!next || p.at < next[1].at)) next = [id, p];
        if (!next) break;
        pending.delete(next[0]);
        t = Math.max(t, next[1].at);
        next[1].fn();
        await settle();
      }
      t = end;
      await settle();
    },
  };
}

function fakeMirror({ conversations = {} } = {}) {
  const subs = new Set();
  return {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    conversationOfPid: (pid) => conversations[pid] || null,
    emit(tr) { for (const fn of [...subs]) fn({ kind: 'mirror', ...tr }); },
    subscribers: () => subs.size,
  };
}

function rig(t, opts = {}) {
  const clock = fakeClock();
  const hooks = createHookTap();
  const bus = createBus({ maxEvents: 2000 });
  const frames = [];
  bus.setBroadcaster((f) => frames.push(f));
  const mirror = opts.mirror || fakeMirror({ conversations: { 4242: 'conv_1' } });
  const viewers = { local: 1, remote: 0, last_local_at: null, last_remote_at: null, last_full_remote_at: null, ...(opts.viewers || {}) };
  const surface = {
    port: 45123,
    ensures: 0,
    ensure: opts.ensure || (async () => { surface.ensures += 1; return { origin: 'http://127.0.0.1:45123', port: 45123 }; }),
    remoteAnswering: () => opts.remoteAnswering === true,
  };
  const lines = [];
  const asks = createAsks({
    bus,
    hooks,
    mirror,
    getViewers: () => ({ ...viewers }),
    audience: null,
    answerSurface: () => surface,
    redactor: createRedactor(),
    root: opts.root || null,
    audit: opts.root ? undefined : (l) => lines.push(l),
    now: clock.now,
    timers: clock.timers,
  });
  t.after(() => asks.stop());
  const tapOf = (event) => hooks.recent().filter((e) => e.event === event);
  return { clock, hooks, bus, frames, mirror, viewers, surface, lines, asks, tapOf, askFrames: () => frames.filter((f) => f.type === 'mirror:ask') };
}

// The envelope report mode posts (lib/hooks/envelope.js's shape).
function envelope({ name = 'Bash', input = { command: 'npm test' }, session = 'sess-1', agent = null, useId, ts = T0, pid = 4242, entrypoint = 'cli' } = {}) {
  return {
    v: 1,
    event: 'PermissionRequest',
    ts,
    session_id: session,
    transcript_path: '/tmp/t.jsonl',
    cwd: '/p',
    prompt_id: null,
    claude_pid: pid,
    entrypoint,
    permission_mode: 'default',
    agent,
    tool: { name, use_id: useId, kind: name, label: name, call: name, input: {}, input_hash: inputHash(input) },
    ask: null,
  };
}

// The create body U54 posts.
function body(o = {}) {
  const name = o.name || 'Bash';
  const input = o.input || { command: 'npm test' };
  const kind = name === 'AskUserQuestion' ? 'question' : name === 'ExitPlanMode' ? 'plan' : 'permission';
  const b = { v: 1, envelope: envelope({ ...o, name, input }), kind, display: projectToolInput(name, input, { profile: 'display' }) };
  if (kind === 'question') {
    b.questions = o.questions || input.questions;
    if (o.questions_truncated) b.questions_truncated = true;
  }
  if (kind === 'plan') b.plan = o.plan || { text: '# Plan\n\nDo it.', file: null, from_file: false, truncated: false };
  return b;
}

// A PreToolUse / PostToolUse / Stop… envelope onto the tap, as the intake publishes it.
function hookEvent(r, event, { name = 'Bash', input = { command: 'npm test' }, session = 'sess-1', agent = null, useId, ts } = {}) {
  r.hooks.publish({
    v: 1, event, ts: ts == null ? r.clock.now() : ts, session_id: session, agent,
    tool: event.includes('Tool') ? { name, use_id: useId, input_hash: inputHash(input) } : null,
  });
}

const QUESTION = (o = {}) => ({
  header: o.header || 'Pick',
  question: o.question || 'Which runtime?',
  multiSelect: o.multiSelect === true,
  options: o.options || [{ label: 'Node', description: 'the default' }, { label: 'Bun', description: 'faster' }],
});

async function question(r, questions, extra = {}) {
  const input = { questions };
  return r.asks.create(body({ name: 'AskUserQuestion', input, ...extra }));
}

// ── create ──────────────────────────────────────────────────────────────────

test('create: a local viewer connected → wait:true with a secret, poll_ms 2000, deadline_ms 590000', async (t) => {
  const r = rig(t);
  const a = await r.asks.create(body());
  assert.equal(a.ok, true);
  assert.equal(a.wait, true);
  assert.match(a.id, /^ask_[0-9a-f]{12}$/);
  assert.equal(typeof a.secret, 'string');
  assert.ok(a.secret.length >= 40);
  assert.equal(a.poll_ms, 2000);
  assert.equal(a.deadline_ms, 590000);
  assert.equal(r.surface.ensures, 1);
  const pub = r.asks.publicView(a.id);
  assert.equal(pub.answerable, true);
  assert.equal(pub.conversation_id, 'conv_1', 'the conversation from conversationOfPid');
  assert.equal(r.asks.get(a.id).hook_attached, true);
});

test('create: a local viewer within 60 s still counts; none and none within 60 s → no-viewer at once', async (t) => {
  const r = rig(t, { viewers: { local: 0, last_local_at: T0 - LOCAL_RECENT_MS + 1000 } });
  assert.equal((await r.asks.create(body())).wait, true, 'a viewer 59 s ago');

  const r2 = rig(t, { viewers: { local: 0, last_local_at: T0 - LOCAL_RECENT_MS - 1 } });
  const timersBefore = r2.clock.count();
  const started = process.hrtime.bigint();
  const a = await r2.asks.create(body());
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  t.diagnostic(`no-viewer create answered in ${ms.toFixed(2)} ms`);
  if (PERF) assert.ok(ms < 100, `no-viewer create took ${ms} ms`);
  assert.deepEqual(Object.keys(a).sort(), ['id', 'ok', 'reason', 'wait']);
  assert.equal(a.wait, false);
  assert.equal(a.reason, 'no-viewer');
  assert.equal(r2.surface.ensures, 0, 'the answer surface is not even started');
  assert.equal(r2.clock.count() - timersBefore, 1, 'only the TTL is armed: no long-poll, no awaited timer');
  const kept = r2.asks.publicView(a.id);
  assert.equal(kept.state, 'pending', 'the record is kept, so the chrome can say "answer in the terminal"');
  assert.equal(kept.answerable, false);
  assert.equal(r2.asks.get(a.id).hook_attached, false);
});

test('create: ensure() rejecting → reason answer-surface', async (t) => {
  const r = rig(t, { ensure: async () => { throw new Error('EADDRINUSE'); } });
  const a = await r.asks.create(body());
  assert.equal(a.wait, false);
  assert.equal(a.reason, 'answer-surface');
  assert.equal(r.asks.publicView(a.id).answerable, false);
});

test('create: an sdk-cli entrypoint → reason sdk, nothing kept or published', async (t) => {
  const r = rig(t);
  const a = await r.asks.create(body({ entrypoint: 'sdk-cli' }));
  assert.deepEqual(a, { ok: true, wait: false, reason: 'sdk' });
  assert.equal(r.hooks.recent().length, 0);
  assert.equal(r.frames.length, 0);
  assert.deepEqual(r.asks.list(), []);
});

test('create: publishes {...envelope, ask:{id, kind}} on the tap once, the open frame and the ring entry', async (t) => {
  const r = rig(t);
  const b = body();
  const a = await r.asks.create(b);
  const reqs = r.tapOf('PermissionRequest');
  assert.equal(reqs.length, 1);
  const { seq, kind, ...env } = reqs[0];
  assert.equal(kind, 'hook');
  assert.ok(seq > 0);
  assert.deepEqual(env, { ...b.envelope, ask: { id: a.id, kind: 'permission' } });
  const frames = r.askFrames();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].op, 'open');
  assert.deepEqual(frames[0].answer, { port: 45123 });
  assert.equal(frames[0].ask.id, a.id);
  const ring = r.bus.read({ kinds: ['ask'] }).events;
  assert.equal(ring.length, 1);
  assert.deepEqual({ ...ring[0], seq: 0, ts: 0 }, { seq: 0, ts: 0, kind: 'ask', op: 'open', id: a.id, ask_kind: 'permission', tool_name: 'Bash', outcome: null });
});

test('create: a body the domain does not take → 400 naming the field', async (t) => {
  const r = rig(t);
  const b = body();
  b.kind = 'question';
  assert.deepEqual(await r.asks.create(b), { ok: false, status: 400, invalid: 'kind' });
  const b2 = body({ name: 'AskUserQuestion', input: { questions: [QUESTION()] } });
  b2.questions[0].options = Array.from({ length: 13 }, (_, i) => ({ label: `o${i}` }));
  assert.equal((await r.asks.create(b2)).invalid, 'questions.options');
  assert.equal(r.hooks.recent().length, 0);
});

// ── redaction ───────────────────────────────────────────────────────────────

test('redaction: an Edit of a dotenv shows WITHHELD for its strings, the path stays', async (t) => {
  const r = rig(t);
  const a = await r.asks.create(body({ name: 'Edit', input: { file_path: '/p/.env', old_string: 'DB_PASSWORD=hunter2hunter2', new_string: 'DB_PASSWORD=correcthorse9' } }));
  const v = r.asks.displayView(a.id);
  const f = Object.fromEntries(v.detail.permission.fields.map((x) => [x.name, x.value]));
  assert.equal(f.file_path, '/p/.env');
  assert.equal(f.old_string, WITHHELD('dotenv'));
  assert.equal(f.new_string, WITHHELD('dotenv'));
  assert.equal(v.masked, true);
  assert.ok(!JSON.stringify(v).includes('hunter2'));
});

test('redaction: a Bash command holding a key is masked; a shell-built value stays readable; home reads ~/', async (t) => {
  const r = rig(t);
  const a = await r.asks.create(body({ input: { command: `curl -H "x" https://api.example.com --data ${SK}` } }));
  const v = r.asks.displayView(a.id);
  assert.equal(v.masked, true);
  assert.equal(r.asks.publicView(a.id).masked, true);
  assert.ok(!JSON.stringify(v).includes(SK));
  assert.ok(v.detail.permission.fields[0].value.includes(MASK_OPEN));
  assert.ok(!v.subject.includes(SK));

  const r2 = rig(t);
  const cmd = 'export API_KEY=$(curl x | sh)';
  const b = await r2.asks.create(body({ input: { command: cmd } }));
  const v2 = r2.asks.displayView(b.id);
  assert.equal(v2.detail.permission.fields[0].value, cmd, 'the user must see what runs');
  assert.equal(v2.masked, false);

  const r3 = rig(t);
  const home = os.homedir();
  const c = await r3.asks.create(body({ name: 'Read', input: { file_path: path.join(home, 'notes', 'todo.md') } }));
  const v3 = r3.asks.displayView(c.id);
  assert.equal(v3.detail.permission.fields[0].value, '~/notes/todo.md');
  assert.ok(!JSON.stringify(v3).includes(home));
});

// ── correlation ─────────────────────────────────────────────────────────────

test('correlation: a PreToolUse 20 ms before binds tool_use_id', async (t) => {
  const r = rig(t);
  hookEvent(r, 'PreToolUse', { useId: 'toolu_before', ts: T0 - 20 });
  const a = await r.asks.create(body());
  assert.equal(r.asks.publicView(a.id).tool_use_id, 'toolu_before');
});

test('correlation: a PreToolUse arriving 30 ms after binds and does not resolve; another hash does neither', async (t) => {
  const r = rig(t);
  const a = await r.asks.create(body());
  const v0 = r.asks.publicView(a.id).version;
  hookEvent(r, 'PreToolUse', { input: { command: 'other' }, useId: 'toolu_other', ts: T0 - 5 });
  assert.equal(r.asks.publicView(a.id).tool_use_id, null, 'another hash does not bind');
  assert.equal(r.asks.publicView(a.id).state, 'pending', 'an older PreToolUse does not resolve');
  await r.clock.advance(30);
  hookEvent(r, 'PreToolUse', { useId: 'toolu_after', ts: T0 + 30 });
  const p = r.asks.publicView(a.id);
  assert.equal(p.tool_use_id, 'toolu_after');
  assert.equal(p.state, 'pending');
  assert.ok(p.version > v0);
  assert.equal(r.tapOf('PermissionResolved').length, 0);
});

test('correlation: of two PreToolUse within 3 s before, the newest binds', async (t) => {
  const r = rig(t);
  hookEvent(r, 'PreToolUse', { useId: 'toolu_older', ts: T0 - 2000 });
  hookEvent(r, 'PreToolUse', { useId: 'toolu_newer', ts: T0 - 20 });
  hookEvent(r, 'PreToolUse', { useId: 'toolu_stale', ts: T0 - 3001 });
  const a = await r.asks.create(body());
  assert.equal(r.asks.publicView(a.id).tool_use_id, 'toolu_newer');
});

test('correlation: the envelope\'s own tool.use_id wins', async (t) => {
  const r = rig(t);
  const a = await r.asks.create(body({ useId: 'toolu_own' }));
  assert.equal(r.asks.publicView(a.id).tool_use_id, 'toolu_own');
});

// ── resolution ──────────────────────────────────────────────────────────────

function assertResolvedOnce(r, id, by, outcome) {
  const res = r.tapOf('PermissionResolved');
  assert.equal(res.length, 1, 'one PermissionResolved');
  assert.equal(res[0].synthetic, true);
  assert.equal(res[0].ask.id, id);
  assert.equal(res[0].ask.by, by);
  if (outcome) assert.equal(res[0].ask.outcome, outcome);
  assert.equal(res[0].session_id, 'sess-1');
  const close = r.askFrames().filter((f) => f.op === 'close');
  assert.equal(close.length, 1, 'the frame closes');
  assert.equal(close[0].ask.id, id);
  assert.equal(close[0].ask.state, 'resolved');
  assert.equal(r.asks.publicView(id).state, 'resolved');
  assert.deepEqual(r.asks.list(), [], 'a closed ask leaves the list');
}

const RESOLUTIONS = [
  ['the mirror\'s waiting-cleared', 'terminal', (r, a) => r.mirror.emit({ op: 'waiting-cleared', conversation_id: 'conv_1', session_id: 'sess-1', ask_id: a.id, by: 'terminal' })],
  ['a state transition from waiting', 'terminal', (r) => r.mirror.emit({ op: 'state', conversation_id: 'conv_1', session_id: 'sess-1', state: 'working', prev: 'waiting' })],
  ['PostToolUse for the bound id', 'tool-ran', (r) => hookEvent(r, 'PostToolUse', { useId: 'toolu_1', ts: T0 + 500 })],
  ['a newer PreToolUse with another hash', 'tool-ran', (r) => hookEvent(r, 'PreToolUse', { input: { command: 'ls' }, useId: 'toolu_2', ts: T0 + 500 })],
  ['Stop', 'turn-closed', (r) => hookEvent(r, 'Stop', { ts: T0 + 500 })],
  ['UserPromptSubmit', 'turn-closed', (r) => hookEvent(r, 'UserPromptSubmit', { ts: T0 + 500 })],
  ['SessionEnd', 'turn-closed', (r) => hookEvent(r, 'SessionEnd', { ts: T0 + 500 })],
];
for (const [what, by, act] of RESOLUTIONS) {
  test(`resolution: ${what} → one PermissionResolved by ${by}, the frame closes`, async (t) => {
    const r = rig(t);
    const a = await r.asks.create(body({ useId: 'toolu_1' }));
    const poll = r.asks.poll(a.id, a.secret, { wait: 20000 });
    act(r, a);
    assertResolvedOnce(r, a.id, by, 'terminal');
    assert.deepEqual(await poll, { state: 'resolved', by });
  });
}

test('resolution: the 620 s TTL (fake clock) → expired', async (t) => {
  const r = rig(t, { viewers: { local: 0 } });
  const a = await r.asks.create(body());
  await r.clock.advance(TTL_MS - 1);
  assert.equal(r.asks.publicView(a.id).state, 'pending');
  await r.clock.advance(1);
  assertResolvedOnce(r, a.id, 'terminal', 'expired');
});

test('resolution: 15 s of hook silence → expired; a polling hook keeps it', async (t) => {
  const r = rig(t);
  const a = await r.asks.create(body());
  await r.clock.advance(HOOK_SILENT_MS - 1000);
  assert.deepEqual(await r.asks.poll(a.id, a.secret), { state: 'pending' });
  await r.clock.advance(HOOK_SILENT_MS - 1000);
  // A long-poll in flight is not silence.
  const p = r.asks.poll(a.id, a.secret, { wait: 20000 });
  await r.clock.advance(20000);
  assert.deepEqual(await p, { state: 'pending' });
  assert.equal(r.asks.publicView(a.id).state, 'pending');
  await r.clock.advance(HOOK_SILENT_MS - 1);
  assert.equal(r.asks.publicView(a.id).state, 'pending');
  await r.clock.advance(1);
  assertResolvedOnce(r, a.id, 'terminal', 'expired');
});

test('resolution: a subagent\'s Stop does not resolve the main agent\'s ask; an older Stop neither', async (t) => {
  const r = rig(t);
  const a = await r.asks.create(body({ ts: T0 }));
  hookEvent(r, 'Stop', { agent: { id: 'agent-9', type: 'Explore' }, ts: T0 + 10 });
  hookEvent(r, 'Stop', { ts: T0 - 10 });
  assert.equal(r.asks.publicView(a.id).state, 'pending');
});

// A mirror like live.js: subscribed to the tap, it draws the session's state
// from the NEWEST pending ask of any agent (waitingOf: a question → 'question',
// else 'waiting'; none → 'working') and emits the transition synchronously
// inside the publish, as ingest does.
function liveishMirror(conversations = { 4242: 'conv_1' }) {
  const subs = new Set();
  const asks = new Map(); // session → [{id, kind, ts}]
  const state = new Map();
  const emit = (tr) => { for (const fn of [...subs]) fn({ kind: 'mirror', ...tr }); };
  const stateOf = (sid) => {
    let newest = null;
    for (const a of asks.get(sid) || []) if (!newest || a.ts >= newest.ts) newest = a;
    if (!newest) return 'working';
    return newest.kind === 'question' ? 'question' : 'waiting';
  };
  return {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    conversationOfPid: (pid) => conversations[pid] || null,
    attach(tap) {
      tap.subscribe((env) => {
        const sid = env.session_id;
        const list = asks.get(sid) || [];
        if (env.event === 'PermissionRequest' && env.ask) list.push({ id: env.ask.id, kind: env.ask.kind, ts: env.ts });
        else if (env.event === 'PermissionResolved' && env.ask) {
          const i = list.findIndex((a) => a.id === env.ask.id);
          if (i < 0) return;
          list.splice(i, 1);
          emit({ op: 'waiting-cleared', conversation_id: 'conv_1', session_id: sid, ask_id: env.ask.id, by: env.ask.by });
        } else return;
        asks.set(sid, list);
        const prev = state.get(sid) || 'working';
        const next = stateOf(sid);
        if (next === prev) return;
        state.set(sid, next);
        emit({ op: 'state', conversation_id: 'conv_1', session_id: sid, state: next, prev });
      });
    },
  };
}

test('resolution: waiting ⇄ question (another agent\'s ask opening or closing) resolves nothing', async (t) => {
  const mirror = liveishMirror();
  const r = rig(t, { mirror });
  mirror.attach(r.hooks);
  const perm = await r.asks.create(body({ ts: T0 }));
  assert.equal(perm.wait, true);
  await r.clock.advance(10);
  // A subagent asks a question: the mirror moves waiting → question.
  const q = await question(r, [QUESTION()], { agent: { id: 'agent-9', type: 'Explore' }, ts: T0 + 10 });
  assert.equal(q.wait, true);
  assert.equal(r.asks.publicView(perm.id).state, 'pending', 'the main agent\'s permission ask stands');
  assert.equal(r.asks.publicView(q.id).state, 'pending', 'the new question stands');
  assert.deepEqual(await r.asks.poll(q.id, q.secret), { state: 'pending' }, 'the second create\'s answer is pollable');
  assert.equal(r.tapOf('PermissionResolved').length, 0);
  // The question is answered elsewhere: question → waiting.
  r.asks.withdraw(q.id, q.secret, 'resolved-elsewhere');
  assert.equal(r.asks.publicView(q.id).state, 'resolved');
  assert.equal(r.asks.publicView(perm.id).state, 'pending', 'question → waiting does not resolve the permission ask');
  assert.deepEqual(await r.asks.poll(perm.id, perm.secret), { state: 'pending' });
  assert.equal(r.tapOf('PermissionResolved').length, 1);
});

test('resolution: an unbound ask is not resolved by a hash-equal PostToolUse older than it', async (t) => {
  const r = rig(t);
  const a = await r.asks.create(body({ ts: T0 }));
  assert.equal(r.asks.get(a.id).tool_use_id, null, 'unbound');
  hookEvent(r, 'PostToolUse', { useId: 'toolu_old', ts: T0 - 50 });
  hookEvent(r, 'PostToolUseFailure', { useId: 'toolu_old2', ts: T0 - 10 });
  assert.equal(r.asks.publicView(a.id).state, 'pending', 'a late PostToolUse of an earlier identical call');
  assert.equal(r.tapOf('PermissionResolved').length, 0);
  hookEvent(r, 'PostToolUse', { useId: 'toolu_new', ts: T0 + 50 });
  assertResolvedOnce(r, a.id, 'tool-ran', 'terminal');
});

test('resolution: a decided ask the hook never collected resolves like a pending one', async (t) => {
  const r = rig(t);
  const a = await r.asks.create(body());
  assert.equal(r.asks.decide(a.id, { behavior: 'deny', message: 'no' }, { via: 'web', version: 1 }).ok, true);
  // The terminal answered before the hook's next poll: the state leaves waiting.
  r.mirror.emit({ op: 'state', conversation_id: 'conv_1', session_id: 'sess-1', state: 'working', prev: 'waiting' });
  assertResolvedOnce(r, a.id, 'terminal', 'terminal');
  assert.deepEqual(await r.asks.poll(a.id, a.secret), { state: 'resolved', by: 'terminal' });
  assert.equal(r.asks.publicView(a.id).outcome, 'terminal');
});

test('withdraw: sigterm → terminal, deadline → expired, resolved-elsewhere → terminal; a bad secret is 403', async (t) => {
  for (const [reason, outcome] of [['sigterm', 'terminal'], ['deadline', 'expired'], ['resolved-elsewhere', 'terminal']]) {
    const r = rig(t);
    const a = await r.asks.create(body());
    assert.equal(r.asks.withdraw(a.id, 'nope', reason).status, 403);
    assert.equal(r.asks.withdraw('ask_000000000000', a.secret, reason).status, 404);
    assert.equal(r.asks.withdraw(a.id, a.secret, 'bored').invalid, 'reason');
    assert.equal(r.asks.withdraw(a.id, a.secret, reason).ok, true);
    assertResolvedOnce(r, a.id, 'terminal', outcome);
    assert.equal(r.asks.withdraw(a.id, a.secret, reason).ok, true, 'idempotent');
    assert.equal(r.tapOf('PermissionResolved').length, 1);
  }
});

// ── supersede and duplicates ────────────────────────────────────────────────

test('supersede: a second ask of the same session and agent resolves the first; a subagent\'s does not', async (t) => {
  const r = rig(t);
  const first = await r.asks.create(body({ input: { command: 'one' } }));
  const poll = r.asks.poll(first.id, first.secret, { wait: 20000 });
  const sub = await r.asks.create(body({ input: { command: 'sub' }, agent: { id: 'agent-1', type: 'Explore' } }));
  assert.equal(r.asks.publicView(first.id).state, 'pending', 'a subagent\'s ask supersedes nothing of the main agent\'s');
  await r.clock.advance(10);
  const second = await r.asks.create(body({ input: { command: 'two' }, ts: T0 + 10 }));
  assert.deepEqual(await poll, { state: 'resolved', by: 'terminal' });
  assert.equal(r.asks.get(first.id).outcome, 'superseded');
  assert.equal(r.asks.publicView(second.id).state, 'pending');
  assert.equal(r.asks.publicView(sub.id).state, 'pending');
  assert.equal(r.asks.publicView(sub.id).agent.type, 'Explore');
  const res = r.tapOf('PermissionResolved');
  assert.equal(res.length, 1);
  assert.equal(res[0].ask.outcome, 'superseded');
  assert.equal(res[0].ask.by, 'terminal');
});

test('duplicate: an identical create within 2 s answers the first id and publishes nothing; after 2 s it supersedes', async (t) => {
  const r = rig(t);
  const first = await r.asks.create(body());
  const framesBefore = r.frames.length;
  await r.clock.advance(DUPLICATE_MS - 1);
  const dup = await r.asks.create(body());
  assert.deepEqual(dup, { ok: true, id: first.id, wait: false, reason: 'duplicate' });
  assert.equal(r.tapOf('PermissionRequest').length, 1);
  assert.equal(r.frames.length, framesBefore);
  assert.equal(r.asks.publicView(first.id).state, 'pending');
  // A different tool_use_id is not the same ask.
  const other = await r.asks.create(body({ useId: 'toolu_x' }));
  assert.notEqual(other.id, first.id);
  assert.equal(r.asks.get(first.id).outcome, 'superseded');

  const r2 = rig(t);
  const a = await r2.asks.create(body());
  await r2.clock.advance(DUPLICATE_MS);
  const b = await r2.asks.create(body());
  assert.notEqual(b.id, a.id);
  assert.equal(b.wait, true);
  assert.equal(r2.asks.get(a.id).outcome, 'superseded');
});

// ── decide ──────────────────────────────────────────────────────────────────

async function decided(t, b, decision, expect) {
  const r = rig(t);
  const a = await r.asks.create(b);
  const d = r.asks.decide(a.id, decision, { via: 'web', version: r.asks.publicView(a.id).version });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.outcome, expect.outcome);
  const p = await r.asks.poll(a.id, a.secret);
  assert.deepEqual(p, { state: 'decided', decision: expect.decision });
  const pub = r.asks.publicView(a.id);
  assert.equal(pub.state, 'decided');
  assert.equal(pub.via, 'web');
  assert.equal(pub.outcome, expect.outcome);
  return { r, a };
}

test('decide: every behavior, stored in the hook form with its outcome', async (t) => {
  const q2 = [QUESTION(), QUESTION({ question: 'Which tests?', multiSelect: true, options: [{ label: 'unit' }, { label: 'e2e' }, { label: 'lint' }] })];
  const cases = [
    [body(), { behavior: 'allow' }, 'allowed', { behavior: 'allow' }],
    [body(), { behavior: 'deny', message: 'not \u0007now' }, 'denied', { behavior: 'deny', message: 'not now' }],
    [body(), { behavior: 'terminal' }, 'terminal', { behavior: 'terminal' }],
    [body({ name: 'AskUserQuestion', input: { questions: q2 } }), { behavior: 'answer', picks: [{ q: 1, options: [2, 0] }, { q: 0, options: [1] }] }, 'answered',
      { behavior: 'answer', picks: [{ q: 0, options: [1] }, { q: 1, options: [0, 2] }] }],
    [body({ name: 'AskUserQuestion', input: { questions: q2 } }), { behavior: 'answer', picks: [{ q: 0, other: 'Deno' }, { q: 1, options: [1] }] }, 'answered',
      { behavior: 'answer', picks: [{ q: 0, other: 'Deno' }, { q: 1, options: [1] }] }],
    [body({ name: 'AskUserQuestion', input: { questions: q2 } }), { behavior: 'decline', message: 'ask me later' }, 'declined', { behavior: 'decline', message: 'ask me later' }],
    [body({ name: 'ExitPlanMode', input: { plan: '# p' } }), { behavior: 'approve', mode: 'default' }, 'approved', { behavior: 'approve', mode: 'default' }],
    [body({ name: 'ExitPlanMode', input: { plan: '# p' } }), { behavior: 'approve', mode: 'acceptEdits' }, 'approved', { behavior: 'approve', mode: 'acceptEdits' }],
    [body({ name: 'ExitPlanMode', input: { plan: '# p' } }), { behavior: 'reject', message: 'smaller steps' }, 'rejected', { behavior: 'reject', message: 'smaller steps' }],
    [body({ name: 'ExitPlanMode', input: { plan: '# p' } }), { behavior: 'reject' }, 'rejected', { behavior: 'reject' }],
  ];
  for (const [b, decision, outcome, hookForm] of cases) {
    const { r, a } = await decided(t, b, decision, { outcome, decision: hookForm });
    const ring = r.bus.read({ kinds: ['ask'] }).events.map((e) => e.op);
    assert.deepEqual(ring, ['open', 'decided']);
    assert.equal(r.askFrames().at(-1).op, 'update');
    // Handed: the hook printed it — one PermissionResolved, by web (terminal for terminal).
    assert.equal(r.asks.handed(a.id, a.secret).ok, true);
    const res = r.tapOf('PermissionResolved');
    assert.equal(res.length, 1);
    assert.equal(res[0].ask.by, decision.behavior === 'terminal' ? 'terminal' : 'web');
    assert.equal(res[0].ask.outcome, outcome);
    assert.equal(res[0].ask.decision, decision.behavior);
  }
});

test('decide: refused bodies → 400 naming the field, nothing stored', async (t) => {
  const qs = [QUESTION(), QUESTION({ question: 'Which tests?', multiSelect: true, options: [{ label: 'unit' }, { label: 'e2e' }] })];
  const cases = [
    [body({ name: 'AskUserQuestion', input: { questions: qs } }), { behavior: 'answer', picks: [{ q: 2, options: [0] }, { q: 0, options: [0] }] }, 'picks.q'],
    [body({ name: 'AskUserQuestion', input: { questions: qs } }), { behavior: 'answer', picks: [{ q: 0, options: [5] }, { q: 1, options: [0] }] }, 'picks.options'],
    [body({ name: 'AskUserQuestion', input: { questions: qs } }), { behavior: 'answer', picks: [{ q: 0, options: [0, 1] }, { q: 1, options: [0] }] }, 'picks.options'],
    [body({ name: 'AskUserQuestion', input: { questions: qs } }), { behavior: 'answer', picks: [{ q: 1, options: [0, 1] }] }, 'picks'],
    [body({ name: 'AskUserQuestion', input: { questions: qs } }), { behavior: 'answer', picks: [{ q: 0, other: 'x'.repeat(501) }, { q: 1, options: [0] }] }, 'picks.other'],
    [body({ name: 'AskUserQuestion', input: { questions: qs } }), { behavior: 'answer', answers: { 'Which runtime?': 'Node' } }, 'answers'],
    [body({ name: 'ExitPlanMode', input: { plan: '# p' } }), { behavior: 'approve', mode: 'bypassPermissions' }, 'mode'],
    [body(), { behavior: 'deny', message: 'x'.repeat(2001) }, 'message'],
    [body(), { behavior: 'approve', mode: 'default' }, 'behavior'],
    [body(), { behavior: 'allow', updatedInput: { command: 'rm -rf /' } }, 'updatedInput'],
    [body(), 'allow', 'decision'],
  ];
  for (const [b, decision, field] of cases) {
    const r = rig(t);
    const a = await r.asks.create(b);
    const d = r.asks.decide(a.id, decision, { via: 'web', version: 1 });
    assert.deepEqual(d, { ok: false, status: 400, invalid: field }, JSON.stringify(decision).slice(0, 80));
    assert.equal(r.asks.publicView(a.id).state, 'pending');
    assert.deepEqual(await r.asks.poll(a.id, a.secret), { state: 'pending' });
  }
});

test('decide: a stale version → 409 stale; a second decide → 409 with state and outcome; no hook → 409', async (t) => {
  const r = rig(t);
  const a = await r.asks.create(body());
  const stale = r.asks.decide(a.id, { behavior: 'allow' }, { version: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.stale, true);
  const v = r.asks.publicView(a.id).version;
  assert.equal(r.asks.decide(a.id, { behavior: 'deny' }, { version: v }).ok, true);
  const again = r.asks.decide(a.id, { behavior: 'allow' }, { version: v + 1 });
  assert.deepEqual(again, { ok: false, status: 409, state: 'decided', outcome: 'denied', decision: { behavior: 'deny' } });
  assert.equal(r.asks.decide('ask_ffffffffffff', { behavior: 'allow' }, { version: 1 }).status, 404);

  const r2 = rig(t, { viewers: { local: 0 } });
  const b = await r2.asks.create(body());
  const noHook = r2.asks.decide(b.id, { behavior: 'allow' }, { version: 1 });
  assert.equal(noHook.status, 409);
  assert.equal(noHook.why_not, 'no-hook');
  assert.equal(r2.asks.publicView(b.id).state, 'pending');
});

test('decide: an acting answer on a request that cannot be shown whole is refused; a remote decide is refused while remote answering is off', async (t) => {
  const r = rig(t);
  const long = 'x'.repeat(9000);
  const a = await r.asks.create(body({ input: { command: long } }));
  assert.equal(r.asks.decide(a.id, { behavior: 'allow' }, { version: 1 }).why_not, 'too-long');
  const b = await r.asks.create(body({ input: { command: 'ok' }, session: 'sess-2' }));
  assert.equal(r.asks.decide(b.id, { behavior: 'allow' }, { version: 1, remote: true }).why_not, 'remote-off');
  assert.equal(r.asks.decide(a.id, { behavior: 'terminal' }, { version: 1 }).ok, true, 'answering in the terminal is always allowed');
});

test('retention: a resolved ask answers a late decide 409 for RESOLVED_KEEP_MS, then is dropped', async (t) => {
  const r = rig(t);
  const a = await r.asks.create(body());
  r.asks.withdraw(a.id, a.secret, 'sigterm');
  await r.clock.advance(RESOLVED_KEEP_MS - 1000);
  await r.asks.create(body({ session: 'sess-2' }));
  const late = r.asks.decide(a.id, { behavior: 'allow' }, { version: 1 });
  assert.deepEqual(late, { ok: false, status: 409, state: 'resolved', outcome: 'terminal', decision: null }, 'how a late web answer learns it lost');
  await r.clock.advance(1000);
  await r.asks.create(body({ session: 'sess-3' }));
  assert.equal(r.asks.decide(a.id, { behavior: 'allow' }, { version: 1 }).status, 404);
});

test('decide: the hook\'s long-poll wakes within one tick', async (t) => {
  const r = rig(t);
  const a = await r.asks.create(body());
  let got = null;
  r.asks.poll(a.id, a.secret, { wait: 25000 }).then((x) => { got = x; });
  await settle();
  assert.equal(got, null);
  r.asks.decide(a.id, { behavior: 'allow' }, { version: 1 });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(got, { state: 'decided', decision: { behavior: 'allow' } });
});

test('decide: a question whose label holds a masked value — the picks name the option index, never the masked text', async (t) => {
  const r = rig(t);
  const a = await question(r, [QUESTION({ options: [{ label: `use ${SK}` }, { label: 'none' }] })]);
  const view = r.asks.displayView(a.id);
  assert.equal(view.masked, true);
  const shown = view.detail.question.questions[0].options[0].label;
  assert.ok(shown.includes(MASK_OPEN) && !shown.includes(SK));
  assert.equal(r.asks.decide(a.id, { behavior: 'answer', picks: [{ q: 0, options: [0] }] }, { version: view.version }).ok, true);
  const p = await r.asks.poll(a.id, a.secret);
  assert.deepEqual(p.decision, { behavior: 'answer', picks: [{ q: 0, options: [0] }] });
  assert.ok(!JSON.stringify(p).includes(MASK_OPEN));
});

test('permission-decision: the mirror applying the bound call marks it applied', async (t) => {
  const r = rig(t);
  const a = await r.asks.create(body({ useId: 'toolu_9' }));
  r.asks.decide(a.id, { behavior: 'allow' }, { version: 1 });
  const v = r.asks.get(a.id).version;
  r.mirror.emit({ op: 'permission-decision', conversation_id: 'conv_1', session_id: 'sess-1', tool_use_id: 'toolu_9', decision: 'allow' });
  assert.equal(r.asks.get(a.id).applied, true);
  assert.equal(r.asks.get(a.id).version, v + 1);
});

test('conversation: learned from the next mirror transition naming the session', async (t) => {
  const r = rig(t, { mirror: fakeMirror() });
  const a = await r.asks.create(body());
  assert.equal(r.asks.publicView(a.id).conversation_id, null);
  r.mirror.emit({ op: 'state', conversation_id: 'conv_7', session_id: 'sess-1', state: 'waiting', prev: 'working', ask_id: a.id });
  const p = r.asks.publicView(a.id);
  assert.equal(p.conversation_id, 'conv_7');
  assert.equal(p.version, 2);
  assert.equal(p.state, 'pending', 'entering waiting resolves nothing');
  assert.equal(r.askFrames().at(-1).ask.conversation_id, 'conv_7');
});

test('conversation: mirror.conversationOf wins over conversationOfPid', async (t) => {
  const m = fakeMirror({ conversations: { 4242: 'by_pid' } });
  m.conversationOf = (sid) => (sid === 'sess-1' ? 'by_session' : null);
  const r = rig(t, { mirror: m });
  const a = await r.asks.create(body());
  assert.equal(r.asks.publicView(a.id).conversation_id, 'by_session');
});

// ── views ───────────────────────────────────────────────────────────────────

test('displayView: why_not too-long, remote-off, resolved; plan.html is the chat flavour of the redacted plan', async (t) => {
  const r = rig(t);
  const cut = await r.asks.create(body({ input: { command: 'y'.repeat(9000) } }));
  assert.equal(r.asks.displayView(cut.id).why_not, 'too-long');
  assert.equal(r.asks.displayView(cut.id).complete, false);
  assert.equal(r.asks.displayView(cut.id).can_answer, false);

  const qt = await question(r, [QUESTION()], { session: 's-q', questions_truncated: true });
  assert.equal(r.asks.displayView(qt.id).why_not, 'too-long');

  const big = 'z'.repeat(200_001);
  const pl = await r.asks.create(body({ name: 'ExitPlanMode', input: { plan: 'p' }, session: 's-p', plan: { text: big, file: null, from_file: false, truncated: false } }));
  assert.equal(r.asks.displayView(pl.id).why_not, 'too-long');

  // The engine cuts on UTF-16 length: 195,011 code points, 205,011 units.
  const astral = 'word '.repeat(37_000) + '\u{1F600}'.repeat(10_000) + 'END-OF-PLAN';
  assert.ok(Array.from(astral).length <= 200_000 && astral.length > 200_000 && Buffer.byteLength(astral) < 256 * 1024);
  const pa = await r.asks.create(body({ name: 'ExitPlanMode', input: { plan: 'p' }, session: 's-pa', plan: { text: astral, file: null, from_file: false, truncated: false } }));
  const va = r.asks.displayView(pa.id);
  assert.equal(va.why_not, 'too-long');
  assert.equal(va.complete, false);
  assert.equal(va.can_answer, false);
  const refused = r.asks.decide(pa.id, { behavior: 'approve', mode: 'default' }, { version: va.version });
  assert.equal(refused.ok, false);
  assert.equal(refused.why_not, 'too-long');
  assert.equal(r.asks.publicView(pa.id).state, 'pending');

  const text = `# Plan\n\nRotate the key ${SK} in **prod**.`;
  const ok = await r.asks.create(body({ name: 'ExitPlanMode', input: { plan: 'p' }, session: 's-ok', plan: { text, file: '/p/plans/x.md', from_file: true, truncated: false } }));
  const v = r.asks.displayView(ok.id);
  assert.equal(v.why_not, null);
  assert.equal(v.can_answer, true);
  assert.equal(v.masked, true);
  const redacted = createRedactor().text(text);
  assert.equal(v.detail.plan.html, renderMarkdown(redacted, { flavor: 'chat' }));
  assert.ok(!v.detail.plan.html.includes(SK));
  assert.equal(r.asks.displayView(ok.id, { remote: true }).why_not, 'remote-off');

  r.asks.withdraw(ok.id, ok.secret, 'sigterm');
  assert.equal(r.asks.displayView(ok.id).why_not, 'resolved');
  assert.equal(r.asks.displayView('ask_000000000000'), null);
});

test('waitView: answers once the version moves, or when the wait runs out', async (t) => {
  const r = rig(t);
  const a = await r.asks.create(body());
  let got = null;
  r.asks.waitView(a.id, 1, 20000).then((v) => { got = v; });
  await settle();
  assert.equal(got, null);
  r.asks.decide(a.id, { behavior: 'allow' }, { version: 1 });
  await settle();
  assert.equal(got.state, 'decided');
  assert.equal(got.version, 2);
  let late = null;
  r.asks.waitView(a.id, 2, 5000).then((v) => { late = v; });
  await r.clock.advance(5000);
  assert.equal(late.version, 2);
});

const CONTENT_KEYS = ['subject', 'display', 'input', 'questions', 'plan', 'detail', 'secret', 'secretHash', 'suggestions'];

test('publicView and list carry no subject, input, questions or plan; below read list() is projected', async (t) => {
  const m = fakeMirror({ conversations: { 4242: 'conv with spaces!' } });
  const r = rig(t, { mirror: m });
  const a = await question(r, [QUESTION({ question: `Path ${os.homedir()}/x?` })]);
  const b = await r.asks.create(body({ session: 'sess-2', name: 'ExitPlanMode', input: { plan: 'p' } }));
  for (const v of [r.asks.publicView(a.id), ...r.asks.list(), ...r.askFrames().map((f) => f.ask)]) {
    for (const k of CONTENT_KEYS) assert.ok(!(k in v), `no ${k}`);
    assert.ok(!JSON.stringify(v).includes(os.homedir()));
    assert.ok(!JSON.stringify(v).includes('Path'));
  }
  const full = r.asks.list({ level: 'local' });
  assert.deepEqual(full.map((x) => x.id), [b.id, a.id], 'newest first');
  assert.deepEqual(Object.keys(full[0]).sort(),
    ['agent', 'answerable', 'conversation_id', 'created_at', 'id', 'kind', 'masked', 'outcome', 'state', 'tool_kind', 'tool_name', 'tool_use_id', 'version', 'via']);
  assert.deepEqual(r.asks.list({ level: 'read' }), full);
  const basic = r.asks.list({ level: 'basic' });
  assert.deepEqual(basic, [
    { id: b.id, kind: 'plan', tool_kind: 'Plan', state: 'pending' },
    { id: a.id, kind: 'question', tool_kind: 'Question', state: 'pending' },
  ], 'the mistyped conversation_id is dropped; nothing beyond ASK_SCHEMA');
});

test('pending() lists the pending records with their conversation', async (t) => {
  const r = rig(t);
  const a = await r.asks.create(body());
  const p = r.asks.pending();
  assert.equal(p.length, 1);
  assert.equal(p[0].id, a.id);
  assert.equal(p[0].conversation_id, 'conv_1');
  assert.ok(!('secretHash' in p[0]) && !('display' in p[0]));
  r.asks.decide(a.id, { behavior: 'allow' }, { version: 1 });
  assert.deepEqual(r.asks.pending(), []);
});

// ── audit ───────────────────────────────────────────────────────────────────

function scratchRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-asks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('audit: one JSONL line per decision, resolution and refusal; no command text, answer or message', async (t) => {
  const root = scratchRoot(t);
  const r = rig(t, { root });
  const cmd = 'deploy --target secret-prod-cluster';
  const a = await r.asks.create(body({ input: { command: cmd } }));
  r.asks.decide(a.id, { behavior: 'deny', message: 'never on fridays' }, { version: 1, remote: false, device: 'desktop', ua: 'Mozilla/5.0 \u0007x' });
  r.asks.handed(a.id, a.secret);
  const q = await question(r, [QUESTION()], { session: 'sess-q' });
  r.asks.noteRefusal(q.id, { reason: 'nonce', origin: 'remote', device: 'mobile', ua: 'Phone' });
  r.asks.decide(q.id, { behavior: 'answer', picks: [{ q: 0, other: 'Zig please' }] }, { version: 1, device: 'mobile' });
  const file = projectPaths(root).asksAudit;
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.outcome), ['denied', 'denied', 'refused', 'answered']);
  assert.equal(lines[0].via, 'web');
  assert.equal(lines[0].origin, 'local');
  assert.equal(lines[0].device, 'desktop');
  assert.equal(lines[0].ua, 'Mozilla/5.0 x');
  assert.equal(lines[1].via, 'web', 'the resolution line');
  assert.equal(lines[2].origin, 'remote');
  assert.equal(lines[2].device, 'mobile');
  assert.equal(lines[2].reason, 'nonce');
  for (const l of lines) assert.deepEqual(Object.keys(l).filter((k) => k !== 'reason'), ['at', 'ask', 'kind', 'tool', 'outcome', 'via', 'origin', 'device', 'ua']);
  for (const secret of [cmd, 'secret-prod', 'never on fridays', 'Zig please', 'Which runtime']) assert.ok(!raw.includes(secret), secret);
});

test('audit: past 1 MiB the file is renamed aside once, one generation kept', async (t) => {
  const root = scratchRoot(t);
  const p = projectPaths(root);
  fs.mkdirSync(p.asksDir, { recursive: true });
  fs.writeFileSync(p.asksAudit, 'x'.repeat(AUDIT_MAX_BYTES));
  const r = rig(t, { root });
  const a = await r.asks.create(body());
  r.asks.decide(a.id, { behavior: 'allow' }, { version: 1 });
  let aside = fs.readdirSync(p.asksDir).filter((f) => f.startsWith('audit.log.1'));
  assert.equal(aside.length, 1);
  assert.equal(fs.statSync(path.join(p.asksDir, aside[0])).size, AUDIT_MAX_BYTES);
  assert.equal(fs.readFileSync(p.asksAudit, 'utf8').trim().split('\n').length, 1);
  // Again: still one generation.
  fs.appendFileSync(p.asksAudit, 'y'.repeat(AUDIT_MAX_BYTES));
  r.clock.set(T0 + 5000);
  r.asks.handed(a.id, a.secret);
  aside = fs.readdirSync(p.asksDir).filter((f) => f.startsWith('audit.log.1'));
  assert.equal(aside.length, 1);
  assert.ok(fs.readFileSync(path.join(p.asksDir, aside[0]), 'utf8').includes('y'));
});

// ── stop ────────────────────────────────────────────────────────────────────

test('stop(): pending long-polls resolve, every timer is cleared, the subscriptions end', async (t) => {
  const r = rig(t);
  const a = await r.asks.create(body());
  const b = await r.asks.create(body({ session: 'sess-2' }));
  const p1 = r.asks.poll(a.id, a.secret, { wait: 25000 });
  const p2 = r.asks.waitView(b.id, 1, 20000);
  assert.ok(r.clock.count() > 0);
  r.asks.stop();
  assert.deepEqual(await p1, { state: 'pending' });
  assert.equal((await p2).id, b.id);
  assert.equal(r.clock.count(), 0, 'no timer left');
  assert.equal(r.mirror.subscribers(), 0);
  assert.equal((await r.asks.create(body({ session: 'sess-3' }))).status, 503);
  r.asks.stop();
});

test('stop(): with the real timers, a long-poll ends and nothing holds the process', async () => {
  const hooks = createHookTap();
  const asks = createAsks({
    bus: createBus(), hooks, mirror: fakeMirror(), getViewers: () => ({ local: 1 }),
    answerSurface: { port: 1, ensure: async () => ({ port: 1 }) }, redactor: createRedactor(), audit: () => {},
  });
  const a = await asks.create(body());
  const p = asks.poll(a.id, a.secret, { wait: 25000 });
  asks.stop();
  assert.deepEqual(await p, { state: 'pending' });
});

// ── the chrome reads what this unit emits (acceptance 1) ────────────────────

test('the chrome\'s normalizers (public/app/chat-state.js) read every frame and row, unchanged, at local and at basic', async (t) => {
  const { pathToFileURL } = require('url');
  const { projectFrame } = require('../lib/core/remote-policy');
  const state = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'app', 'chat-state.js')).href);
  const r = rig(t);
  const a = await r.asks.create(body({ useId: 'toolu_n1' }));
  await question(r, [QUESTION()], { session: 'sess-q', agent: { id: 'agent-3', type: 'Explore' } });
  await r.asks.create(body({ name: 'ExitPlanMode', input: { plan: 'p' }, session: 'sess-p' }));
  r.asks.decide(a.id, { behavior: 'allow' }, { version: 1 });
  r.asks.handed(a.id, a.secret);
  const frames = r.askFrames();
  assert.deepEqual(frames.map((f) => f.op), ['open', 'open', 'open', 'update', 'close']);
  for (const f of frames) {
    const n = state.normalizeFrame(f, { level: 'local' });
    assert.ok(n, `local ${f.op}`);
    assert.equal(n.op, f.op);
    const dropNull = Object.fromEntries(Object.entries(f.ask).filter(([k, v]) => v !== null || k === 'agent'));
    const { source, ...read } = n.ask;
    assert.equal(source, 'ask');
    assert.deepEqual(read, dropNull, 'every AskPublic field survives the normalizer');
    const basic = projectFrame(f, 'basic', 'status');
    const nb = state.normalizeFrame(basic, { level: 'basic' });
    assert.ok(nb, `basic ${f.op}`);
    assert.equal(nb.ask.id, f.ask.id);
  }
  for (const level of ['local', 'basic']) {
    for (const row of r.asks.list({ level })) assert.ok(state.normalizeAsk(row, { level }), `a ${level} row`);
  }
});
