// The live feed from the mod (lib/server/mirror/mod-live.js, spec §15.7, §2.4
// rule 3, §2.9, §2.12; C-MOD-3), registered on a REAL createMirror beside the
// `live` and `transcripts` sources, fed through a real hook tap with a
// registered session — the ModEvent envelopes are U87's synthetic shape (one
// test has the real bridge publish them).
//
// Pinned:
//   * a tool.call gives a running tool_call item, source 'hook', in the next
//     flush and before any transcript record; tool.done ends it with its
//     duration; the transcript's later record of that tool_use leaves exactly
//     one item, with the transcript's fields and seq;
//   * a PreToolUse hook item that came first is filled, never overwritten, and
//     a finished call is never moved back to running by a late tool.call;
//   * turn.step deltas (a fake clock) give one reply item, written at most once
//     per 100 ms, with the joined text: `r_<message_id>` (the transcript's reply
//     replaces its text on the same item), else `rm_<turn>_<index>`, removed
//     when a transcript reply lands for it and when the Stop's `rh_` appears
//     (a step still streaming is not taken by the reply of the step before it);
//   * turn.complete sets the provisional reply when the turn has none, and
//     writes nothing when the transcript's is there;
//   * session.append rows: an assistant row's items carry exactly normalize()'s
//     ids; a user row opens no turn and binds nothing;
//   * never written by this source: seq, offset, a source other than 'hook', a
//     turn opened, closed, bound or superseded, a batch of changes;
//   * a fake secret in a delta (cut across two writes) and in a tool input is
//     masked in the stored item and in every frame;
//   * a blank step writes no reply, so none is left behind or shown twice;
//   * an event with no open turn waits up to 2 s for one, then is dropped and
//     counted, and holds back no event that has a turn (a mid-turn
//     prompt.submit); an unknown session's never reaches the source; a non-synthetic
//     envelope and another synthetic one are ignored;
//   * lifecycle events are progress evidence; prompt.submit patches mod_origin
//     and nothing else;
//   * with no ModEvent the source writes nothing; stop() leaves no timer and no
//     accumulator; start/stop/start works (the toggle); no open handle remains.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { withTempHome, waitUntil } = require('../test-support/helpers');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { createRecords } = require('../test-support/claude-records');
const { createRedactor } = require('../lib/core/redact');
const { createBus } = require('../lib/core/bus');
const { MOD_EVENT, MOD_PROTOCOL, OPS, EVENT_KINDS } = require('../lib/core/mod-protocol');
const { projectToolInput, toolKind, stepLabel, callLabel, inputHash } = require('../lib/core/tool-input');
const { createHookTap } = require('../lib/server/hook-tap');
const { createMirror, SOURCES } = require('../lib/server/mirror');
const { createTranscriptsSource } = require('../lib/server/mirror/transcripts');
const { createIndexStore } = require('../lib/server/mirror/index-store');
const { initialState, normalize } = require('../lib/server/mirror/normalize');
const { createModLiveSource, BUFFER_MS, PROMPT_SKEW_MS } = require('../lib/server/mirror/mod-live');
const { createBridge } = require('../lib/server/domain/bridge');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

// ── fixtures ─────────────────────────────────────────────────────────────────

function project(t) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-modlive-'));
  fs.mkdirSync(path.join(dir, '.web-chat'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A manual clock for the source's own timers: nothing fires until advance().
function fakeClock(start = 1_000_000) {
  let t = start;
  let serial = 0;
  const queue = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const h = { serial: ++serial };
      queue.set(h, { at: t + Math.max(0, ms), fn });
      return h;
    },
    clearTimeout(h) { queue.delete(h); },
    pending: () => queue.size,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [h, e] of queue) if (e.at <= end && (!next || e.at < next[1].at || (e.at === next[1].at && h.serial < next[0].serial))) next = [h, e];
        if (!next) break;
        queue.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
  };
}

// The tool section the bridge builds for a tool.call (lib/server/domain/bridge.js
// toolSection), from the same lib/core/tool-input functions.
function toolSection(name, useId, input) {
  return {
    name, use_id: useId, kind: toolKind(name), label: stepLabel(name, input), call: callLabel(name, input),
    input: projectToolInput(name, input, { profile: 'mirror' }).input, input_hash: inputHash(input),
  };
}

// A real facade with live, transcripts and the mod's live feed. The source is
// handed an engine whose model and live are wrapped, so a test sees every write
// and every lifecycle call it makes.
function setup(t, { clock = null, coalesceMs, bufferMs } = {}) {
  let mirror = null;
  t.after(async () => { if (mirror) await mirror.stop(); });
  withTempHome(t);
  const root = project(t);
  const ch = claudeHome(t, { root, isolate: true });
  const hooks = createHookTap();
  const mainBus = createBus();
  const mirrorBus = createBus({ maxEvents: 2000 });
  const frames = [];
  mirrorBus.setBroadcaster((frame) => frames.push(frame));
  const redactor = createRedactor();
  const calls = { upsertItem: [], removeItem: [], patchTurn: [], activity: [], lifecycle: [], applyChanges: 0 };
  const src = createModLiveSource({
    ...(coalesceMs ? { coalesceMs } : {}), ...(bufferMs ? { bufferMs } : {}),
    ...(clock ? { timers: clock, now: clock.now } : {}),
  });
  const h = { root, ch, hooks, frames, calls, inst: null, clock };
  const modLive = {
    attach(engine) {
      const model = { ...engine.model };
      model.upsertItem = (raw, opts) => { calls.upsertItem.push(JSON.parse(JSON.stringify(raw))); return engine.model.upsertItem(raw, opts); };
      model.removeItem = (id, opts) => { calls.removeItem.push(id); return engine.model.removeItem(id, opts); };
      model.patchTurn = (id, patch) => { calls.patchTurn.push({ id, patch: { ...patch } }); return engine.model.patchTurn(id, patch); };
      for (const k of ['openTurn', 'closeTurn', 'supersede', 'attachTurn', 'orphanPending', 'restoreTurns', 'refill']) {
        model[k] = (...args) => { calls.lifecycle.push(k); return engine.model[k](...args); };
      }
      const live = {
        ...engine.live,
        noteActivity: (id, at, kind) => { calls.activity.push({ id, at, kind }); return engine.live.noteActivity(id, at, kind); },
      };
      const wrapped = {
        ...engine, model: Object.freeze(model), live: Object.freeze(live),
        applyChanges: (...args) => { calls.applyChanges += 1; return engine.applyChanges(...args); },
      };
      h.engine = engine; // the unwrapped engine, for a test that plays the turn machine's part
      h.inst = src.attach(Object.freeze(wrapped));
      return h.inst;
    },
  };
  mirror = createMirror({
    root, hooks, mainBus, mirrorBus, redactor, log: () => {},
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    isPidAlive: () => true,
    sources: [
      ...SOURCES.filter((s) => s.name === 'live'),
      { name: 'transcripts', attach: createTranscriptsSource({ createStore: createIndexStore, pollMs: 40 }).attach },
      { name: 'mod-live', attach: modLive.attach },
    ],
  });
  h.mirror = mirror;
  let ts = Date.now();
  h.tick = (by = 1) => { ts += by; return ts; };
  h.env = (event, extra = {}, sid = S1) => ({
    v: 1, event, ts: h.tick(), session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd,
    prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
    result: null, session: null, compact: null, stop: null, prompt: null, ask: null, ...extra,
  });
  h.publish = (event, extra, sid) => hooks.publish(h.env(event, extra, sid));
  h.sessionStart = (sid = S1) => h.publish('SessionStart', { session: { source: 'startup' } }, sid);
  h.prompt = (pid, text = `prompt ${pid}`, sid = S1) => h.publish('UserPromptSubmit', { prompt_id: pid, prompt: { author: 'user', text } }, sid);
  h.stop = (pid, msg, sid = S1) => h.publish('Stop', { prompt_id: pid, stop: { last_assistant_message: msg } }, sid);
  // A ModEvent as the bridge publishes it.
  h.mod = (kind, payload = {}, { tool = null, sid = S1, ts: at = null } = {}) => {
    const env = { v: 1, event: MOD_EVENT, synthetic: true, ts: at === null ? h.tick() : at, session_id: sid, mod: { kind, ...payload } };
    if (tool) env.tool = tool;
    return hooks.publish(env);
  };
  h.toolCall = (useId, name, input, opts) => h.mod('tool.call', { tool_use_id: useId, tool: name, input }, { ...opts, tool: toolSection(name, useId, input) });
  h.toolDone = (useId, name, input, extra = {}, opts) => h.mod('tool.done', { tool_use_id: useId, ok: true, ...extra }, { ...opts, tool: toolSection(name, useId, input) });
  h.step = (turnId, index, delta, messageId = null, opts) => h.mod('turn.step', { turn_id: turnId, index, ...(messageId ? { message_id: messageId } : {}), delta }, opts);
  h.records = (sid = S1, seed = 1) => createRecords({ seed, sessionId: sid, cwd: ch.cwd, start: Date.now(), step: 10 });
  h.page = async (cid = S1) => mirror.turns(cid, { items: 'full', limit: 100 });
  h.items = async (cid = S1) => { const p = await h.page(cid); return p && p.turns ? p.turns.flatMap((x) => x.items || []) : []; };
  h.item = async (id, cid = S1) => (await h.items(cid)).find((it) => it.id === id) || null;
  h.diag = () => h.inst.diagnostics().mod_live;
  h.streamItems = () => h.frames.filter((f) => f.type === 'mirror:stream').flatMap((f) => f.items || []);
  return h;
}

// Started, with S1 registered and (when `pid` is given) a hook-opened turn.
async function ready(t, opts = {}) {
  const h = setup(t, opts);
  await h.mirror.start();
  h.sessionStart();
  // The session's catch-up (index mode: no stream frame) ends with one reset.
  await waitUntil(() => h.frames.some((f) => f.type === 'mirror:reset' && f.conversation_id === S1), { what: 'the catch-up' });
  if (opts.pid) h.prompt(opts.pid, opts.text);
  return h;
}

function assertNeverWritten(h) {
  for (const raw of h.calls.upsertItem) {
    assert.equal(raw.seq, undefined, `no seq on ${raw.id}`);
    assert.equal(raw.offset, undefined, `no offset on ${raw.id}`);
    assert.equal(raw.source, 'hook', `${raw.id} is written as a hook's`);
  }
  assert.deepEqual(h.calls.lifecycle, [], 'no turn opened, closed, bound or superseded');
  assert.equal(h.calls.applyChanges, 0, 'no batch of changes applied');
}

// ── tool cards ───────────────────────────────────────────────────────────────

test('a tool.call gives a running card before any transcript record; tool.done ends it; the transcript\'s copy lands on the same item', async (t) => {
  const h = await ready(t, { pid: 'p-tool' });
  const input = { command: 'npm test' };
  h.toolCall('toolu_01Bash', 'Bash', input);
  const framed = await waitUntil(() => h.streamItems().find((it) => it.id === 'toolu_01Bash'), { what: 'the card in a mirror:stream frame' });
  assert.equal(fs.existsSync(h.ch.transcript(S1)), false, 'no transcript record yet');
  assert.equal(framed.kind, 'tool_call');
  assert.equal(framed.status, 'running');
  assert.equal(framed.source, 'hook');
  assert.equal(framed.provisional, true);
  assert.equal(framed.tool, 'Bash');
  assert.equal(framed.turn_id, 'p-tool');
  assert.equal(framed.label, stepLabel('Bash', input));

  h.toolDone('toolu_01Bash', 'Bash', input, { duration_ms: 1234, background_task_id: 'b1a2c3d4' });
  const done = await h.item('toolu_01Bash');
  assert.equal(done.status, 'done');
  assert.equal(done.duration_ms, 1234);
  assert.ok(Number.isFinite(done.ended_at));
  assert.deepEqual(done.links, { task_id: 'b1a2c3d4' });

  // The tailer's later copy.
  const r = h.records();
  r.prompt('prompt p-tool', { promptId: 'p-tool' });
  r.assistant([{ type: 'tool_use', name: 'Bash', input, id: 'toolu_01Bash' }]);
  const useRec = r.records[r.records.length - 1];
  r.toolResult('toolu_01Bash', 'all green');
  h.ch.writeTranscript(S1, r.records);
  const landed = await waitUntil(async () => {
    const it = await h.item('toolu_01Bash');
    return it && it.source === 'transcript' && it.result ? it : null;
  }, { timeout: 8000, what: 'the transcript\'s copy of the call' });
  const all = (await h.items()).filter((it) => it.id === 'toolu_01Bash');
  assert.equal(all.length, 1, 'one item, not two');
  assert.equal(landed.seq, r.records.indexOf(useRec) + 1, 'the transcript\'s seq');
  assert.equal(landed.provisional, undefined);
  assert.equal(landed.status, 'done');
  assert.equal(landed.result.preview, 'all green');
  assertNeverWritten(h);
});

test('a PreToolUse item that came first is filled, never overwritten; a finished call never goes back to running', async (t) => {
  const h = await ready(t, { pid: 'p-pre' });
  const input = { file_path: '/tmp/project/a.md' };
  const hookTool = { use_id: 'toolu_01Read', name: 'Read', kind: toolKind('Read'), label: 'the hook\'s label', input };
  const pre = h.env('PreToolUse', { prompt_id: 'p-pre', tool: hookTool });
  h.hooks.publish(pre);
  const before = await h.item('toolu_01Read');
  assert.equal(before.call, undefined, 'the hook gave no call line');

  h.toolCall('toolu_01Read', 'Read', input);
  const filled = await h.item('toolu_01Read');
  assert.equal(filled.label, 'the hook\'s label', 'kept');
  assert.equal(filled.started_at, pre.ts, 'kept');
  assert.equal(filled.status, 'running');
  assert.equal(filled.call, callLabel('Read', input), 'the gap filled');

  h.publish('PostToolUse', { prompt_id: 'p-pre', tool: hookTool, result: { ok: true, duration_ms: 7 } });
  assert.equal((await h.item('toolu_01Read')).status, 'done');
  h.toolCall('toolu_01Read', 'Read', input);
  const after = await h.item('toolu_01Read');
  assert.equal(after.status, 'done', 'a late tool.call never moves it back');
  assert.equal(after.duration_ms, 7);

  // The mod's own done, then a late tool.call of its own.
  h.toolCall('toolu_01Grep', 'Grep', { pattern: 'x' });
  h.toolDone('toolu_01Grep', 'Grep', { pattern: 'x' }, { duration_ms: 3 });
  h.toolCall('toolu_01Grep', 'Grep', { pattern: 'x' });
  assert.equal((await h.item('toolu_01Grep')).status, 'done');
  // A failed one.
  h.toolCall('toolu_01Fail', 'Bash', { command: 'false' });
  h.toolDone('toolu_01Fail', 'Bash', { command: 'false' }, { ok: false, is_error: true });
  assert.equal((await h.item('toolu_01Fail')).status, 'error');
  assertNeverWritten(h);
});

// ── streaming replies ────────────────────────────────────────────────────────

test('turn.step deltas give one r_<message_id> reply, written at most once per 100 ms, which the transcript\'s reply replaces', async (t) => {
  const clock = fakeClock();
  const h = await ready(t, { pid: 'p-stream', clock });
  h.mod('turn.start', { turn_id: 'mt-1' });
  const words = Array.from({ length: 25 }, (_, i) => `w${i} `);
  const writes = []; // [clock time, written] at each change of `written`
  let last = h.diag().written;
  for (const w of words) {
    h.step('mt-1', 0, w, 'msg_01Stream');
    const n = h.diag().written;
    if (n !== last) { writes.push(clock.now()); last = n; }
    clock.advance(10);
    const m = h.diag().written;
    if (m !== last) { writes.push(clock.now()); last = m; }
  }
  clock.advance(200);
  if (h.diag().written !== last) writes.push(clock.now());
  assert.ok(writes.length >= 3, `several writes (${writes.length})`);
  for (let i = 1; i < writes.length; i++) assert.ok(writes[i] - writes[i - 1] >= 100, `writes ${writes[i - 1]} and ${writes[i]} are 100 ms apart`);
  const replies = (await h.items()).filter((it) => it.kind === 'reply');
  assert.equal(replies.length, 1, 'one reply item');
  assert.equal(replies[0].id, 'r_msg_01Stream');
  assert.equal(replies[0].text, words.join(''), 'the joined text');
  assert.equal(replies[0].source, 'hook');
  assert.equal(replies[0].message_id, 'msg_01Stream');

  const r = h.records();
  r.prompt('prompt p-stream', { promptId: 'p-stream' });
  r.assistant([`${words.join('').trim()} — final`], { messageId: 'msg_01Stream' });
  h.ch.writeTranscript(S1, r.records);
  const landed = await waitUntil(async () => {
    const it = await h.item('r_msg_01Stream');
    return it && it.source === 'transcript' ? it : null;
  }, { timeout: 8000, what: 'the transcript\'s reply on the streamed item' });
  assert.equal(landed.text, `${words.join('').trim()} — final`, 'the transcript\'s text wins');
  assert.equal((await h.items()).filter((it) => it.kind === 'reply').length, 1);
  // Its key is retired: a late delta adds nothing.
  const n = h.diag().written;
  h.step('mt-1', 0, 'late ', 'msg_01Stream');
  clock.advance(200);
  assert.equal(h.diag().written, n);
  assertNeverWritten(h);
});

test('without a message id the reply is rm_<turn>_<index>, removed when the transcript\'s reply for it lands — not the step still streaming', async (t) => {
  const clock = fakeClock();
  const h = await ready(t, { pid: 'p-rm', clock });
  h.mod('turn.start', { turn_id: 'mt-2' });
  h.step('mt-2', 0, 'Let me look. ');
  clock.advance(150);
  assert.equal((await h.item('rm_p-rm_0')).text, 'Let me look. ');
  h.toolCall('toolu_01Ls', 'Bash', { command: 'ls' });
  h.step('mt-2', 1, 'The answer ');
  h.step('mt-2', 1, 'is 42.');
  clock.advance(150);
  assert.equal((await h.item('rm_p-rm_1')).text, 'The answer is 42.');

  // The transcript has the first message's reply, not yet the second's.
  const r = h.records();
  r.prompt('prompt p-rm', { promptId: 'p-rm' });
  r.assistant(['Let me look.', { type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 'toolu_01Ls' }]);
  h.ch.writeTranscript(S1, r.records);
  await waitUntil(async () => !(await h.item('rm_p-rm_0')), { timeout: 8000, what: 'rm_0 removed' });
  assert.ok(await h.item('rm_p-rm_1'), 'the step still streaming stays');
  assert.equal(h.diag().removed_provisional, 1);

  r.toolResult('toolu_01Ls', 'a.md');
  r.assistant(['The answer is 42.']);
  h.ch.writeTranscript(S1, r.records);
  await waitUntil(async () => !(await h.item('rm_p-rm_1')), { timeout: 8000, what: 'rm_1 removed' });
  const replies = (await h.items()).filter((it) => it.kind === 'reply');
  assert.deepEqual(replies.map((it) => it.source), ['transcript', 'transcript']);
  assert.equal(h.diag().removed_provisional, 2);
  assertNeverWritten(h);
});

test('an rm_ reply goes when the Stop\'s rh_ appears, and one written after the Stop is never made', async (t) => {
  const clock = fakeClock();
  const h = await ready(t, { pid: 'p-stop', clock });
  h.mod('turn.start', { turn_id: 'mt-3' });
  h.step('mt-3', 0, 'Done: everything ');
  clock.advance(150);
  assert.ok(await h.item('rm_p-stop_0'));
  h.stop('p-stop', 'Done: everything passes.');
  assert.equal(await h.item('rm_p-stop_0'), null, 'removed');
  assert.equal((await h.item('rh_p-stop')).text, 'Done: everything passes.');
  // The rest of the stream, arriving after the Stop, adds nothing.
  h.step('mt-3', 0, 'passes.');
  h.step('mt-3', 1, 'More.');
  clock.advance(300);
  assert.deepEqual((await h.items()).filter((it) => it.kind === 'reply').map((it) => it.id), ['rh_p-stop']);
  assertNeverWritten(h);
});

test('a streamed r_ reply that is the Stop\'s message is not shown twice', async (t) => {
  const clock = fakeClock();
  const h = await ready(t, { pid: 'p-dup', clock });
  h.mod('turn.start', { turn_id: 'mt-4' });
  h.step('mt-4', 0, 'All tests ', 'msg_01Dup');
  clock.advance(150);
  h.stop('p-dup', 'All tests pass.');
  assert.deepEqual((await h.items()).filter((it) => it.kind === 'reply').map((it) => it.id), ['rh_p-dup']);
  h.step('mt-4', 0, 'pass.', 'msg_01Dup');
  clock.advance(300);
  assert.deepEqual((await h.items()).filter((it) => it.kind === 'reply').map((it) => it.id), ['rh_p-dup']);
});

test('a blank step is no reply: with a message id nothing is left behind, and without ids the transcript\'s reply is not shown twice', async (t) => {
  // (a) A tool-only model request's chunk names its message and carries no text.
  const clock = fakeClock();
  const h = await ready(t, { pid: 'p-blank', clock });
  h.mod('turn.start', { turn_id: 'mt-b1' });
  h.step('mt-b1', 0, '', 'msg_01ToolOnly');
  clock.advance(150);
  assert.equal(await h.item('r_msg_01ToolOnly'), null, 'a blank step writes nothing');
  h.toolCall('toolu_01Blank', 'Bash', { command: 'ls' });
  h.step('mt-b1', 1, 'Done.', 'msg_01Text');
  clock.advance(150);
  assert.equal((await h.item('r_msg_01Text')).text, 'Done.');
  h.stop('p-blank', 'Done.');
  const r = h.records();
  r.prompt('prompt p-blank', { promptId: 'p-blank' });
  r.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 'toolu_01Blank' }], { messageId: 'msg_01ToolOnly' });
  r.toolResult('toolu_01Blank', 'a.md');
  r.assistant(['Done.'], { messageId: 'msg_01Text' });
  r.turnDuration({ durationMs: 30 });
  h.ch.writeTranscript(S1, r.records);
  await waitUntil(async () => {
    const items = await h.items();
    return !items.some((it) => it.id === 'rh_p-blank') && items.some((it) => it.id === 'r_msg_01Text' && it.source === 'transcript');
  }, { timeout: 8000, what: 'the transcript\'s reply in place of the Stop\'s' });
  const replies = (await h.items()).filter((it) => it.kind === 'reply');
  assert.deepEqual(replies.filter((it) => it.source === 'hook').map((it) => it.id), [], 'no provisional reply left in the closed turn');
  assert.deepEqual(replies.map((it) => it.id), ['r_msg_01Text']);

  // (b) Without ids: a blank step 0, then the text of step 1.
  const clock2 = fakeClock();
  const h2 = await ready(t, { pid: 'p-blank2', clock: clock2 });
  h2.mod('turn.start', { turn_id: 'mt-b2' });
  h2.step('mt-b2', 0, '');
  clock2.advance(150);
  h2.toolCall('toolu_01Blank2', 'Bash', { command: 'ls' });
  h2.step('mt-b2', 1, 'Answer.');
  clock2.advance(150);
  assert.equal(await h2.item('rm_p-blank2_0'), null, 'a blank step writes nothing');
  assert.equal((await h2.item('rm_p-blank2_1')).text, 'Answer.');
  const r2 = h2.records();
  r2.prompt('prompt p-blank2', { promptId: 'p-blank2' });
  r2.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 'toolu_01Blank2' }]);
  r2.toolResult('toolu_01Blank2', 'a.md');
  r2.assistant(['Answer.']);
  h2.ch.writeTranscript(S1, r2.records);
  await waitUntil(async () => (await h2.items()).some((it) => it.kind === 'reply' && it.source === 'transcript'), { timeout: 8000, what: 'the transcript\'s reply' });
  await waitUntil(async () => !(await h2.item('rm_p-blank2_1')), { timeout: 8000, what: 'rm_1 removed' });
  const shown = (await h2.items()).filter((it) => it.kind === 'reply');
  assert.deepEqual(shown.map((it) => [it.text, it.source]), [['Answer.', 'transcript']], 'the reply shown once');
  assertNeverWritten(h);
  assertNeverWritten(h2);
});

test('turn.complete with no reply sets the provisional reply; with the transcript\'s already there it writes nothing', async (t) => {
  const h = await ready(t, { pid: 'p-done' });
  h.mod('turn.start', { turn_id: 'mt-5' });
  h.mod('turn.complete', { turn_id: 'mt-5', text: 'All done.' });
  const it = await h.item('rm_p-done_end');
  assert.equal(it.text, 'All done.');
  assert.equal(it.source, 'hook');

  const h2 = await ready(t, { pid: 'p-done2' });
  const r = h2.records();
  r.prompt('prompt p-done2', { promptId: 'p-done2' });
  r.assistant(['The transcript said so.']);
  h2.ch.writeTranscript(S1, r.records);
  await waitUntil(async () => (await h2.items()).some((x) => x.kind === 'reply' && x.source === 'transcript'), { timeout: 8000, what: 'the transcript reply' });
  const n = h2.calls.upsertItem.length;
  h2.mod('turn.start', { turn_id: 'mt-6' });
  h2.mod('turn.complete', { turn_id: 'mt-6', text: 'The transcript said so.' });
  assert.equal(h2.calls.upsertItem.length, n, 'nothing written');
  assert.equal((await h2.items()).filter((x) => x.kind === 'reply').length, 1);
});

// ── rows ─────────────────────────────────────────────────────────────────────

test('a session.append assistant row gives reply and tool_call items under normalize\'s ids; a user row opens and binds nothing', async (t) => {
  const h = await ready(t, { pid: 'p-row' });
  const uuid = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const message = {
    role: 'assistant', id: 'msg_01Row', model: 'claude-opus-5-5',
    content: [{ type: 'text', text: 'Reading it now.' }, { type: 'tool_use', id: 'toolu_01Row', name: 'Read', input: { file_path: '/tmp/project/b.md' } }],
  };
  const expected = normalize([{ obj: { type: 'assistant', uuid, message }, start: 0, end: 0 }], initialState())
    .changes.filter((c) => c.type === 'item').map((c) => c.item.id);
  assert.deepEqual(expected, ['r_msg_01Row', 'toolu_01Row']);
  h.mod('session.append', { uuid, message });
  const items = await h.items();
  for (const id of expected) {
    const it = items.find((x) => x.id === id);
    assert.ok(it, id);
    assert.equal(it.source, 'hook');
    assert.equal(it.turn_id, 'p-row');
  }
  assert.equal(items.find((x) => x.id === 'r_msg_01Row').text, 'Reading it now.');
  assert.equal(items.find((x) => x.id === 'toolu_01Row').status, 'running');

  // A tool_result row ends the call (the mod keeps no preview).
  h.mod('session.append', { uuid: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01Row', is_error: false }] } });
  assert.equal((await h.item('toolu_01Row')).status, 'done');

  // A user prompt row: no turn, no binding, no header change.
  const lifecycle = (p) => p.turns.map((x) => ({
    id: x.id, status: x.status, provisional: x.provisional, replaces: x.replaces, started_at: x.started_at, ended_at: x.ended_at, kind: x.kind, author: x.author,
  }));
  const before = await h.page();
  const writes = h.calls.upsertItem.length;
  h.mod('session.append', { uuid: 'cccccccc-1111-4111-8111-cccccccccccc', origin: { kind: 'user' }, message: { role: 'user', content: 'and now the next thing' } });
  const after = await h.page();
  assert.equal(after.total, before.total, 'no turn opened');
  assert.deepEqual(lifecycle(after), lifecycle(before));
  assert.equal(h.calls.upsertItem.length, writes, 'nothing written');
  assertNeverWritten(h);
});

// ── redaction ────────────────────────────────────────────────────────────────

test('a fake secret cut across two writes of a delta stream, and one in a tool input, are masked in the item and in every frame', async (t) => {
  const clock = fakeClock();
  const h = await ready(t, { pid: 'p-secret', clock });
  const fake = fakeSecrets({ seed: 90 }).find((f) => f.id === 'github-ghp');
  assert.ok(fake, 'a one-line token');
  const secret = fake.secrets[0];
  const half = Math.floor(secret.length / 2);
  h.mod('turn.start', { turn_id: 'mt-7' });
  h.step('mt-7', 0, `the key is ${secret.slice(0, half)}`);
  clock.advance(150);
  h.step('mt-7', 0, `${secret.slice(half)} — keep it`);
  clock.advance(150);
  h.toolCall('toolu_01Env', 'Bash', { command: `export API_KEY=${secret}` });
  const items = await h.items();
  const reply = items.find((it) => it.id === 'rm_p-secret_0');
  assert.match(reply.text, /keep it/);
  assert.deepEqual(findLeaks(JSON.stringify(items), [fake]), [], 'nothing of it stored');
  await waitUntil(() => h.streamItems().some((it) => it.id === 'toolu_01Env'), { what: 'the frames' });
  assert.deepEqual(findLeaks(JSON.stringify(h.frames), [fake]), [], 'nothing of it framed');
});

// ── which turn ───────────────────────────────────────────────────────────────

test('an event with no open turn is written when one opens within 2 s, and dropped and counted otherwise', async (t) => {
  const clock = fakeClock();
  const h = await ready(t, { clock });
  h.toolCall('toolu_01Wait', 'Bash', { command: 'make' });
  assert.equal(h.diag().waiting, 1);
  clock.advance(1000);
  h.prompt('p-late');
  const it = await h.item('toolu_01Wait');
  assert.ok(it, 'written into the turn that opened');
  assert.equal(it.turn_id, 'p-late');
  assert.equal(h.diag().waiting, 0);
  h.stop('p-late', 'ok');

  h.toolCall('toolu_01Lost', 'Bash', { command: 'make' });
  clock.advance(2001);
  assert.equal(h.diag().dropped_no_turn, 1);
  assert.equal(h.diag().waiting, 0);
  assert.equal(clock.pending(), 0);
  h.prompt('p-next');
  assert.equal(await h.item('toolu_01Lost'), null, 'dropped, never written');
});

test('nothing is written to a superseded turn: a bound step, a new step and a tool call are dropped and counted', async (t) => {
  const clock = fakeClock();
  const h = await ready(t, { pid: 'p-sup', clock });
  h.mod('turn.start', { turn_id: 'mt-s' });
  h.step('mt-s', 0, 'before ');
  clock.advance(150);
  assert.equal((await h.item('rm_p-sup_0')).text, 'before ');
  // The turn machine's one supersede (a rewind), as the rewinds source calls it.
  const res = h.engine.model.supersede(S1, 'p-sup', { reason: 'branch', at: Date.now() });
  assert.deepEqual(res.superseded, ['p-sup']);
  const writes = h.calls.upsertItem.length;
  const dropped = h.diag().dropped_no_turn;
  h.step('mt-s', 0, 'after');       // the bound step
  clock.advance(150);
  h.step('mt-s', 1, 'next step');   // a new step of the bound mod turn
  clock.advance(150);
  h.mod('turn.start', { turn_id: 'mt-s2' });
  h.toolCall('toolu_01Sup', 'Bash', { command: 'ls' }); // an unbound event: the open turn is superseded
  clock.advance(2001);
  assert.equal(h.calls.upsertItem.length, writes, 'nothing written after the supersede');
  assert.equal((await h.item('rm_p-sup_0')).text, 'before ', 'the bound step kept its text');
  assert.equal(await h.item('rm_p-sup_1'), null);
  assert.equal(await h.item('toolu_01Sup'), null);
  assert.ok(h.diag().dropped_no_turn >= dropped + 2, `dropped and counted (${h.diag().dropped_no_turn})`);
  assert.equal(h.diag().waiting, 0);
  assert.equal(clock.pending(), 0);
});

test('a mid-turn prompt.submit that finds no turn holds back no tool card, and only it is dropped', async (t) => {
  const clock = fakeClock();
  const h = await ready(t, { pid: 'p-mid', clock });
  // The open turn started more than PROMPT_SKEW_MS ago: a submit now is a
  // queued mid-turn prompt that opens no turn. The bridge publishes the submit
  // and the tool.call of one batch in the same ms.
  clock.advance(PROMPT_SKEW_MS + 1000);
  const at = h.tick(PROMPT_SKEW_MS + 1000);
  h.mod('prompt.submit', { origin: { kind: 'user' } }, { ts: at });
  h.toolCall('toolu_01Mid', 'Bash', { command: 'make' }, { ts: at });
  const it = await h.item('toolu_01Mid');
  assert.ok(it, 'the card is written at once');
  assert.equal(it.status, 'running');
  assert.equal(it.turn_id, 'p-mid');
  assert.equal(h.diag().waiting, 1, 'only the submit waits');
  clock.advance(BUFFER_MS + 1);
  assert.equal(h.diag().dropped_no_turn, 1, 'only the submit is dropped');
  assert.equal(h.diag().waiting, 0);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(h.calls.patchTurn, [], 'no turn patched');
  assert.equal((await h.item('toolu_01Mid')).status, 'running');
  assertNeverWritten(h);
});

test('an unknown session\'s event never reaches the source; a non-synthetic envelope and another synthetic one are ignored', async (t) => {
  const h = await ready(t, { pid: 'p-ign' });
  h.toolCall('toolu_01Other', 'Bash', { command: 'ls' }, { sid: S2 });
  h.hooks.publish({ ...h.env(MOD_EVENT), mod: { kind: 'tool.call', tool_use_id: 'toolu_01Nosyn', tool: 'Bash', input: {} }, tool: toolSection('Bash', 'toolu_01Nosyn', {}) });
  h.hooks.publish({ v: 1, event: 'PermissionResolved', synthetic: true, ts: h.tick(), session_id: S1, tool: { use_id: 'toolu_01Perm' }, ask: { id: 'a1', outcome: 'allow' } });
  assert.equal(h.diag().events, 0);
  assert.equal(h.calls.upsertItem.length, 0);
  // A kind that is U92's or U93's: heard, and nothing done.
  h.mod('session.measure', { changed: true });
  h.mod('permission.request', { request_id: 'r1', tool: 'Bash', input: {} });
  assert.equal(h.diag().events, 2);
  assert.equal(h.calls.upsertItem.length, 0);
  // A subagent's event.
  h.mod('tool.call', { tool_use_id: 'toolu_01Sub', tool: 'Bash', input: {}, agent_id: 'agent-1' }, { tool: toolSection('Bash', 'toolu_01Sub', {}) });
  assert.equal(h.diag().ignored_agent, 1);
  assert.equal(await h.item('toolu_01Sub'), null);
});

test('lifecycle events are progress evidence; prompt.submit patches mod_origin on the open turn and nothing else', async (t) => {
  const h = await ready(t, { pid: 'p-life' });
  const start = h.mod('turn.start', { turn_id: 'mt-8' });
  h.step('mt-8', 0, 'x');
  h.mod('turn.complete', { turn_id: 'mt-8' });
  assert.deepEqual(h.calls.activity.map((a) => [a.id, a.kind]), [[S1, 'mod'], [S1, 'mod'], [S1, 'mod']]);
  assert.equal(h.calls.activity[0].at, start.ts);

  const h2 = await ready(t);
  h2.prompt('p-origin');
  h2.mod('prompt.submit', { origin: { kind: 'user', as_user: true } });
  assert.deepEqual(h2.calls.patchTurn, [{ id: 'p-origin', patch: { mod_origin: 'user' } }]);
  assert.equal(h2.calls.upsertItem.length, 0);
  const turn = (await h2.page()).turns[0];
  assert.equal(turn.mod_origin, 'user');
  assert.equal(turn.status, 'open');
  assertNeverWritten(h2);
});

// ── no mod; the lifecycle ────────────────────────────────────────────────────

test('with no ModEvent the source writes nothing through a whole turn', async (t) => {
  const h = await ready(t, { pid: 'p-none' });
  const tool = { use_id: 'toolu_01None', name: 'Read', input: { file_path: '/tmp/project/c.md' } };
  h.publish('PreToolUse', { prompt_id: 'p-none', tool });
  h.publish('PostToolUse', { prompt_id: 'p-none', tool, result: { ok: true, duration_ms: 4 } });
  h.stop('p-none', 'Read it.');
  const r = h.records();
  r.prompt('prompt p-none', { promptId: 'p-none' });
  r.assistant([{ type: 'tool_use', name: 'Read', input: tool.input, id: 'toolu_01None' }]);
  r.toolResult('toolu_01None', 'c');
  r.assistant(['Read it.']);
  r.turnDuration({ durationMs: 30 });
  h.ch.writeTranscript(S1, r.records);
  await waitUntil(async () => !(await h.item('rh_p-none')), { timeout: 8000, what: 'the transcript\'s reply' });
  assert.deepEqual(h.calls.upsertItem, []);
  assert.deepEqual(h.calls.removeItem, []);
  assert.deepEqual(h.calls.patchTurn, []);
  assert.equal(h.diag().events, 0);
  assert.equal(h.diag().written, 0);
});

test('stop() leaves no timer and no accumulator; start/stop/start works', async (t) => {
  const clock = fakeClock();
  const h = await ready(t, { clock });
  h.toolCall('toolu_01Held', 'Bash', { command: 'make' }); // waits: no turn
  h.prompt('p-cycle');
  h.mod('turn.start', { turn_id: 'mt-9' });
  h.step('mt-9', 0, 'one ');
  h.step('mt-9', 0, 'two ');
  // A second conversation with no turn: its event is still waiting at the stop,
  // with its expiry timer armed.
  h.sessionStart(S2);
  h.toolCall('toolu_01Parked', 'Bash', { command: 'make' }, { sid: S2 });
  assert.equal(h.diag().waiting, 1, 'an event waiting at the stop');
  assert.ok(clock.pending() >= 2, 'a window and an expiry timer armed');
  assert.equal(h.diag().accumulating, 1);
  await h.inst.stop();
  assert.equal(clock.pending(), 0, 'no timer');
  assert.deepEqual({ waiting: h.diag().waiting, accumulating: h.diag().accumulating, sessions: h.diag().sessions, timers: h.diag().timers },
    { waiting: 0, accumulating: 0, sessions: 0, timers: 0 });
  await h.inst.start();
  h.toolCall('toolu_01Again', 'Bash', { command: 'make' });
  assert.equal((await h.item('toolu_01Again')).status, 'running');
  h.step('mt-9', 1, 'three');
  clock.advance(150);
  assert.equal((await h.item('rm_p-cycle_1')).text, 'three');
  await h.inst.stop();
  await h.inst.start();
  h.toolCall('toolu_01Third', 'Bash', { command: 'make' });
  assert.ok(await h.item('toolu_01Third'));
  assertNeverWritten(h);
});

test('end to end through the bridge: a mod\'s tool.call becomes a running card', async (t) => {
  const h = await ready(t, { pid: 'p-bridge' });
  const bridge = createBridge({ root: h.root, hooks: h.hooks, mirror: h.mirror, log: () => {} });
  t.after(() => bridge.stop());
  bridge.start();
  const hello = bridge.hello({
    v: 1, protocol: MOD_PROTOCOL, session_id: S1, cc_version: '2.1.296', mod_version: '0.8.5',
    ops: [...OPS], events: [...EVENT_KINDS], root: h.root,
  });
  assert.equal(hello.status, 200, JSON.stringify(hello.body));
  const at = Date.now();
  const r = bridge.events(hello.body.token, { events: [
    { kind: 'turn.start', turn_id: 'mt-b', at },
    { kind: 'tool.call', tool_use_id: 'toolu_01Bridge', tool: 'Bash', input: { command: 'npm run build' }, at: at + 1 },
    { kind: 'turn.step', turn_id: 'mt-b', index: 0, message_id: 'msg_01Bridge', delta: 'Building.', at: at + 2 },
  ] });
  assert.equal(r.status, 200);
  const it = await waitUntil(() => h.item('toolu_01Bridge'), { what: 'the bridged card' });
  assert.equal(it.status, 'running');
  assert.equal(it.label, stepLabel('Bash', { command: 'npm run build' }));
  assert.equal((await waitUntil(() => h.item('r_msg_01Bridge'), { what: 'the bridged reply' })).text, 'Building.');
});

test('no open handle after a stop with a window and a queue armed on the engine\'s own timers', async (t) => {
  const kinds = ['Timeout', 'Immediate', 'FSEventWrap', 'StatWatcher'];
  const count = () => { const c = Object.fromEntries(kinds.map((k) => [k, 0])); for (const k of process.getActiveResourcesInfo()) if (k in c) c[k] += 1; return c; };
  const baseline = count();
  const h = setup(t);
  await h.mirror.start();
  h.sessionStart();
  h.toolCall('toolu_01Q', 'Bash', { command: 'make' }); // waits: an expiry timer
  h.prompt('p-handles');
  h.step('mt-h', 0, 'a');
  h.step('mt-h', 0, 'b'); // a window open
  h.toolCall('toolu_01Q2', 'Bash', { command: 'make' });
  // A conversation with no turn: its event still waits, its expiry armed.
  h.sessionStart(S2);
  h.toolCall('toolu_01Q3', 'Bash', { command: 'make' }, { sid: S2 });
  assert.equal(h.diag().waiting, 1, 'a queue armed at the stop');
  await h.mirror.stop();
  const after = count();
  for (const k of kinds) assert.ok(after[k] <= baseline[k], `${k}: ${after[k]} after, ${baseline[k]} before`);
});
