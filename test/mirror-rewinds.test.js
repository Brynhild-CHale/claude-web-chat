// The rewinds source (lib/server/mirror/rewinds.js, spec §15.4 cases b and c,
// §2.4 rule 4, C43), registered on a REAL createMirror after the transcripts
// source the way U40 registers it, with an in-memory fake of the transcripts
// source's store contract. Every transcript is a test-support/rewind-fixtures.js
// fixture (on claude-records).
//
// Pinned:
//   * (a) a branch: the turn machine supersedes the abandoned turns under one
//     'branch' notice; the rewinds source calls nothing;
//   * (b) a first-prompt reset: the turns before it under ONE 'reset' notice, the
//     new turn live; (b′) a compaction and (b″) a resume supersede nothing;
//   * (c) each anchor form (rewound, an earlier leafUuid, a null one) supersedes
//     the turns after the anchor under 'anchor'; (c′) a last-prompt naming the
//     leaf, or a record of the newest turn, supersedes nothing;
//   * the open turn is never superseded, and `until` stops the run before the
//     turn of the prompt that rewound;
//   * a re-read of the same transcript, and a restart restoring the detector's
//     state from the store (read again from 0, or resumed), add no notice and
//     supersede nothing more; a restart between the turns and the rewind still
//     sees it (reset and anchor);
//   * an anchor that is also a branch yields one notice, whichever came first;
//   * nothing under the project's .web-chat/ but mirror/ changes (no graph or
//     node file); the thresholds are exported, and the reset fixture at exactly
//     those thresholds supersedes while one short of either does not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { withTempHome, waitUntil } = require('../test-support/helpers');
const { createRedactor } = require('../lib/core/redact');
const { createBus } = require('../lib/core/bus');
const { createHookTap } = require('../lib/server/hook-tap');
const { createMirror, SOURCES } = require('../lib/server/mirror');
const { createTailer } = require('../lib/server/mirror/tail');
const { createTranscriptsSource } = require('../lib/server/mirror/transcripts');
const rewinds = require('../lib/server/mirror/rewinds');
const fx = require('../test-support/rewind-fixtures');

const { createRewindsSource, FIRST_TURN_KINDS, RESET_MIN_COUNT_DROP, RESET_MIN_FIRST_TURN_RECORDS } = rewinds;
const SID = fx.DEFAULT_SESSION;

// ── the harness ──────────────────────────────────────────────────────────────

function project(t) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-rewinds-'));
  fs.mkdirSync(path.join(dir, '.web-chat'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The transcripts source's store contract, in memory. `saved` outlives mirrors.
function fakeStore() {
  const saved = new Map();
  const pending = new Map();
  async function flush(sid) {
    for (const [k, fn] of [...pending]) {
      if (sid && k !== sid) continue;
      pending.delete(k);
      const snap = fn();
      if (snap) saved.set(k, JSON.parse(JSON.stringify(snap)));
    }
  }
  const create = () => ({
    async load(sid) {
      const ix = saved.get(sid);
      return ix ? { ok: true, index: JSON.parse(JSON.stringify(ix)) } : { ok: false, reason: 'absent' };
    },
    schedule(sid, fn) { pending.set(sid, fn); },
    flush,
    drop(sid) { pending.delete(sid); },
    async readRange(file, { from, to }) {
      const s = fs.readFileSync(file).subarray(from, to).toString('utf8');
      const cut = s.lastIndexOf('\n');
      return cut < 0 ? '' : s.slice(0, cut + 1);
    },
    async stop() { await flush(); },
  });
  return { create, saved };
}

// Every file under .web-chat/ but mirror/, with its bytes.
function webChatFiles(root) {
  const out = {};
  const base = path.join(root, '.web-chat');
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(base, p);
      if (rel === 'mirror' || rel.startsWith(`mirror${path.sep}`)) continue;
      if (e.isDirectory()) walk(p);
      else out[rel] = fs.readFileSync(p).toString('base64');
    }
  })(base);
  return out;
}

// A real facade with `live`, `transcripts`, the rewinds source (its supersede
// calls watched) and a replayer that can hand every batch over again.
function setup(t, { store = fakeStore(), root = null, ch = null } = {}) {
  let mirror = null;
  t.after(async () => { if (mirror) await mirror.stop(); });
  if (!root) {
    withTempHome(t);
    root = project(t);
    ch = claudeHome(t, { root, isolate: true });
  }
  const calls = [];
  const real = createRewindsSource();
  const spied = (engine) => {
    const model = Object.freeze({
      ...engine.model,
      supersede: (cid, from, opts) => {
        const r = engine.model.supersede(cid, from, opts);
        calls.push({ cid, from, opts: { ...opts }, superseded: r ? [...r.superseded] : null });
        return r;
      },
    });
    return real.attach(Object.freeze({ ...engine, model }));
  };
  const replay = { engine: null, batches: [] };
  const replayer = (engine) => {
    replay.engine = engine;
    return {
      start: async () => {}, stop: async () => {},
      onChanges: (sid, changes, { conversation_id }) => { replay.batches.push([sid, changes, conversation_id]); },
    };
  };
  const source = createTranscriptsSource({ createStore: store.create, createTailer, pollMs: 30 });
  const hooks = createHookTap();
  mirror = createMirror({
    root, hooks, mainBus: createBus(), mirrorBus: createBus({ maxEvents: 2000 }), redactor: createRedactor(), log: () => {},
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    isPidAlive: () => true,
    sources: [...SOURCES,
      { name: 'transcripts', attach: source.attach },
      { name: 'rewinds', attach: spied },
      { name: 'replayer', attach: replayer }],
  });
  const h = { root, ch, store, hooks, mirror, calls, replay, before: webChatFiles(root) };
  h.publish = (hook) => hooks.publish(fx.envelope(hook, { sessionId: SID, transcriptPath: ch.transcript(SID), cwd: ch.cwd }));
  h.replayAll = () => {
    const batches = replay.batches.splice(0);
    for (const [sid, changes, cid] of batches) replay.engine.applyChanges(sid, changes, { conversation_id: cid });
  };
  return h;
}

function build(name, opts = {}) { return fx[name]({ ...opts }); }

// Waits until the conversation holds `n` turns, every one closed but `open`.
async function settled(h, n, open = null) {
  return waitUntil(async () => {
    const p = await h.mirror.turns(SID, { items: 'full', limit: 100 });
    if (!p || p.total !== n) return null;
    return p.turns.every((x) => (x.id === open ? x.status === 'open' : x.status !== 'open')) ? p : null;
  }, { timeout: 8000, what: `${n} settled turns` });
}

// What the model says now: superseded turn ids, live ones, and the notices.
async function verdict(h) {
  const p = await h.mirror.turns(SID, { items: 'full', limit: 100 });
  const notices = [];
  for (const turn of p.turns) {
    for (const it of turn.items || []) if (it.kind === 'notice' && it.notice === 'rewound') notices.push({ turn: turn.id, reason: it.reason });
  }
  return {
    superseded: p.turns.filter((x) => x.superseded).map((x) => x.id),
    live: p.turns.filter((x) => !x.superseded).map((x) => x.id),
    notices,
  };
}

// Runs a fixture end to end: hooks first (a SessionStart precedes what it
// starts), then the transcript, then waits for every turn.
async function run(t, f, opts = {}) {
  const h = setup(t, opts);
  await h.mirror.start();
  for (const hook of f.hooks) h.publish(hook);
  h.ch.writeTranscript(SID, f.records);
  await settled(h, f.turns.length, f.expect.open);
  return h;
}

function assertExpected(v, f, label = f.name) {
  assert.deepEqual(v.superseded, f.expect.superseded, `${label}: the superseded turns`);
  assert.deepEqual(v.live, f.expect.live, `${label}: the live turns`);
  if (f.expect.reason) {
    assert.equal(v.notices.length, 1, `${label}: one rewound notice`);
    assert.equal(v.notices[0].reason, f.expect.reason, `${label}: its reason`);
    assert.equal(v.notices[0].turn, f.expect.superseded[0], `${label}: on the first abandoned turn`);
  } else {
    assert.equal(v.notices.length, 0, `${label}: no rewound notice`);
  }
}

async function assertNoGraphWrite(h) {
  await h.mirror.stop();
  assert.deepEqual(webChatFiles(h.root), h.before, 'nothing under .web-chat/ but mirror/ was written');
}

// One more closed turn after a fixture's end, with a higher message count than
// any before it: a whole-file re-read then meets the first turn's append and its
// low count right after this one — what the watermark must never judge again.
function extend(f, id = 'rw-5', count = 30) {
  f.r.prompt(`prompt ${id}`, { promptId: id });
  f.r.assistant([`reply to ${id}`]);
  f.r.turnDuration({ durationMs: 40, messageCount: count });
  f.turns.push(id);
  f.expect.live.push(id);
  return f;
}

const realCalls = (h) => h.calls.filter((c) => c.superseded && c.superseded.length);
const splitAt = (f, promptId) => f.records.findIndex((x) => x.promptId === promptId);

// ── the constants ────────────────────────────────────────────────────────────

test('the reset rule\'s thresholds are exported constants', () => {
  assert.deepEqual([...FIRST_TURN_KINDS], [
    'attachment/environment', 'attachment/model', 'attachment/deferred_tools_delta',
    'attachment/agent_listing_delta', 'attachment/mcp_instructions_delta', 'attachment/skill_listing',
  ]);
  assert.ok(Object.isFrozen(FIRST_TURN_KINDS));
  assert.equal(RESET_MIN_COUNT_DROP, 1);
  assert.equal(RESET_MIN_FIRST_TURN_RECORDS, 1);
  assert.equal(typeof createRewindsSource().attach, 'function');
  const src = fs.readFileSync(require.resolve('../lib/server/mirror/rewinds.js'), 'utf8');
  for (const banned of ['markSuperseded', 'upsertItem', 'patchTurn', 'writeJsonAtomic', 'require(\'fs\')', 'require(\'./turn-machine\')']) {
    assert.ok(!src.includes(banned), `rewinds.js never reaches ${banned}: every rewind is the one supersede`);
  }
});

// ── (a) the branch ───────────────────────────────────────────────────────────

test('(a) a branch: the turn machine supersedes the abandoned turns under one branch notice', async (t) => {
  const f = build('branch');
  const h = await run(t, f);
  assertExpected(await verdict(h), f);
  assert.equal(realCalls(h).length, 0, 'the rewinds source superseded nothing itself');
  await assertNoGraphWrite(h);
});

// ── (b) the first-prompt reset ───────────────────────────────────────────────

test('(b) a first-prompt reset: the turns before it under one reset notice; the new turn is live', async (t) => {
  const f = build('reset');
  const h = await run(t, f);
  assertExpected(await verdict(h), f);
  const calls = realCalls(h);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts.until, 'rw-4', 'the run is bounded by the turn the reset closed');
  assert.equal(calls[0].opts.reason, 'reset');
  const page = await h.mirror.turns(SID, { limit: 100 });
  assert.equal(calls[0].opts.at, page.turns.find((x) => x.id === 'rw-4').started_at, 'at = the new turn\'s started_at');
  await assertNoGraphWrite(h);
});

test('(b) the thresholds: exactly at them supersedes, one short of either does not', async (t) => {
  const at = build('reset', { drop: RESET_MIN_COUNT_DROP, firstTurnRecords: RESET_MIN_FIRST_TURN_RECORDS });
  assert.equal(at.expect.reason, 'reset');
  const h1 = await run(t, at);
  assertExpected(await verdict(h1), at, 'at the thresholds');
  await h1.mirror.stop();

  const shortCount = build('reset', { drop: RESET_MIN_COUNT_DROP - 1, firstTurnRecords: FIRST_TURN_KINDS.length });
  assert.equal(shortCount.expect.reason, null);
  const h2 = await run(t, shortCount);
  assertExpected(await verdict(h2), shortCount, 'a count one short');
  await h2.mirror.stop();

  const shortRecords = build('reset', { drop: 8, firstTurnRecords: RESET_MIN_FIRST_TURN_RECORDS - 1 });
  assert.equal(shortRecords.expect.reason, null);
  const h3 = await run(t, shortRecords);
  assertExpected(await verdict(h3), shortRecords, 'first-turn records one short');
  await h3.mirror.stop();
});

test('(b′) a compaction with re-sent attachments and a lower count is never a reset', async (t) => {
  for (const compactStart of [false, true]) {
    const f = build('compaction', { compactStart });
    const h = await run(t, f);
    assertExpected(await verdict(h), f, `compaction (SessionStart ${compactStart})`);
    assert.equal(realCalls(h).length, 0);
    await assertNoGraphWrite(h);
  }
});

test('(b″) a --resume (SessionStart resume, appended records) is never a reset', async (t) => {
  const f = build('resume');
  const h = await run(t, f);
  assertExpected(await verdict(h), f);
  assert.equal(h.calls.length, 0, 'not even a call');
  await h.mirror.stop();
  // Without the resume's SessionStart the same records WOULD read as a reset:
  // the SessionStart is what keeps a resume that lowers the count from one.
  const bare = build('resume');
  bare.hooks = bare.hooks.filter((x) => !(x.session && x.session.source === 'resume'));
  const h2 = await run(t, bare);
  assert.deepEqual((await verdict(h2)).superseded, ['rw-1', 'rw-2', 'rw-3']);
  await h2.mirror.stop();
  // And a resume that does not lower the count is no reset with no hook at all.
  const flat = build('resume', { countAfter: 14 });
  flat.hooks = flat.hooks.filter((x) => !(x.session && x.session.source === 'resume'));
  const h3 = await run(t, flat);
  assertExpected(await verdict(h3), flat, 'a resume with a higher count');
});

// ── (c) the headless anchor ──────────────────────────────────────────────────

for (const form of ['rewound', 'earlier', 'null']) {
  test(`(c) an anchor (${form}) supersedes the turns after it under one anchor notice, until the new turn`, async (t) => {
    const f = build('anchor', { form });
    const h = await run(t, f);
    assertExpected(await verdict(h), f);
    const calls = realCalls(h);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.reason, 'anchor');
    assert.equal(calls[0].opts.until, 'rw-4', 'until = the next opener after the evidence');
    assert.ok(Number.isFinite(calls[0].opts.at));
    await assertNoGraphWrite(h);
  });
}

test('(c) evidence at the end of the file, with no prompt after it yet: bounded by its time', async (t) => {
  const f = build('anchor', { form: 'rewound', next: false });
  const h = await run(t, f);
  assertExpected(await verdict(h), f);
  const [call] = realCalls(h);
  assert.equal(call.opts.until, undefined);
  assert.ok(Number.isFinite(call.opts.at));
});

test('(c′) a last-prompt naming the leaf, or a record of the newest turn, supersedes nothing', async (t) => {
  for (const mid of [false, true]) {
    const f = build('leafNamed', { mid });
    const h = await run(t, f);
    assertExpected(await verdict(h), f, `leaf named (mid ${mid})`);
    assert.equal(realCalls(h).length, 0);
    await h.mirror.stop();
  }
});

// ── the open turn, and until ─────────────────────────────────────────────────

test('the open turn is never superseded: never named as from, never inside the run', async (t) => {
  // The only turn after the anchor is the open one: nothing.
  const after = build('anchor', { form: 'earlier', open: true });
  const h1 = await run(t, after, {});
  assertExpected(await verdict(h1), after, 'anchor before the open turn');
  assert.equal(h1.calls.length, 0, 'the open turn was never handed to supersede');
  await h1.mirror.stop();
  // A rewind to the first prompt while turn 3 is open: turns 1–2 only.
  const first = build('anchor', { form: 'null', open: true });
  const h2 = await run(t, first);
  assertExpected(await verdict(h2), first, 'null anchor with the third turn open');
  const page = await h2.mirror.turns(SID, { limit: 100 });
  assert.equal(page.turns.find((x) => x.id === 'rw-3').status, 'open');
  assert.ok(h2.calls.every((c) => c.from !== 'rw-3'));
});

// ── idempotence and restart ──────────────────────────────────────────────────

test('re-reading the same transcript adds no notice and supersedes nothing more', async (t) => {
  for (const name of ['reset', 'anchor', 'branch']) {
    const f = extend(build(name));
    const h = await run(t, f);
    const first = await verdict(h);
    assertExpected(first, f);
    const n = h.calls.length;
    h.replayAll();
    assert.deepEqual(await verdict(h), first, `${name}: the same verdict after a re-read`);
    assert.equal(h.calls.length, n, `${name}: the re-read judged nothing again`);
    await assertNoGraphWrite(h);
  }
});

test('a restart restores the detector state: read again from 0, or resumed, nothing is repeated', async (t) => {
  const store = fakeStore();
  const f = extend(build('reset'));
  const a = await run(t, f, { store });
  const before = await verdict(a);
  assertExpected(before, f);
  await a.mirror.stop();
  const ix = store.saved.get(SID);
  assert.ok(ix && ix.state && ix.state.sources && ix.state.sources.rewinds, 'the detector state is in the index');
  const slice = JSON.stringify(ix.state.sources.rewinds);
  assert.ok(!/prompt rw-|reply to/.test(slice), 'content-free');
  assert.equal(ix.state.sources.rewinds.count, 30);

  // Read again from 0 with the state restored.
  const zero = JSON.parse(JSON.stringify(ix));
  zero.resume = null;
  zero.file = null;
  store.saved.set(SID, zero);
  const b = setup(t, { store, root: a.root, ch: a.ch });
  await b.mirror.start();
  for (const hook of f.hooks) b.publish(hook);
  await settled(b, 5);
  assert.deepEqual(await verdict(b), before, 'from 0: the same verdict, one notice');
  assert.equal(b.calls.length, 0, 'from 0: nothing judged again');
  await b.mirror.stop();

  // Resumed, then a later turn with a higher count: nothing more.
  const c = setup(t, { store, root: a.root, ch: a.ch });
  await c.mirror.start();
  for (const hook of f.hooks) c.publish(hook);
  await settled(c, 5);
  const n0 = f.records.length;
  f.r.prompt('prompt rw-6', { promptId: 'rw-6' });
  f.r.assistant(['reply to rw-6']);
  f.r.turnDuration({ durationMs: 40, messageCount: 34 });
  c.ch.appendTranscript(SID, f.records.slice(n0));
  await settled(c, 6);
  const after = await verdict(c);
  assert.deepEqual(after.superseded, before.superseded);
  assert.deepEqual(after.notices, before.notices);
  assert.equal(c.calls.length, 0);
  await assertNoGraphWrite(c);
});

test('a restart between the turns and the rewind still sees it (a reset, an anchor)', async (t) => {
  for (const [name, opts, split] of [['reset', {}, 'rw-4'], ['anchor', { form: 'earlier' }, null]]) {
    const store = fakeStore();
    const f = build(name, opts);
    // Everything up to the rewind's evidence: a reset's fourth prompt, an anchor's last-prompt.
    const cut = split ? splitAt(f, split) : f.records.findIndex((x) => x.type === 'last-prompt');
    const a = setup(t, { store });
    await a.mirror.start();
    for (const hook of f.hooks) a.publish(hook);
    a.ch.writeTranscript(SID, f.records.slice(0, cut));
    await settled(a, 3);
    await a.mirror.stop();
    const b = setup(t, { store, root: a.root, ch: a.ch });
    await b.mirror.start();
    await settled(b, 3);
    b.ch.appendTranscript(SID, f.records.slice(cut));
    await settled(b, 4);
    assertExpected(await verdict(b), f, `${name} across a restart`);
    assert.equal(realCalls(b).length, 1);
    await assertNoGraphWrite(b);
  }
});

// ── an anchor that is also a branch ──────────────────────────────────────────

test('an anchor that is also a branch yields one notice, whichever is read first', async (t) => {
  // One batch: the turn machine's branch first, the anchor's supersede a no-op.
  const f = build('anchor', { form: 'rewound', branch: true });
  const h = await run(t, f);
  assertExpected(await verdict(h), f);
  assert.equal(realCalls(h).length, 0, 'the anchor added nothing');
  await h.mirror.stop();

  // The evidence read before the branching prompt: the anchor first.
  for (const form of ['earlier', 'null']) {
    const g = build('anchor', { form, branch: true });
    const cut = g.records.findIndex((x) => x.type === 'last-prompt') + 1;
    const h2 = setup(t);
    await h2.mirror.start();
    for (const hook of g.hooks) h2.publish(hook);
    h2.ch.writeTranscript(SID, g.records.slice(0, cut));
    await waitUntil(() => realCalls(h2).length === 1, { timeout: 8000, what: 'the anchor' });
    h2.ch.appendTranscript(SID, g.records.slice(cut));
    await settled(h2, 4);
    const v = await verdict(h2);
    assert.deepEqual(v.superseded, g.expect.superseded, `${form}: the abandoned turns`);
    assert.equal(v.notices.length, 1, `${form}: one notice`);
    assert.equal(v.notices[0].reason, 'anchor', `${form}: the first reason stands`);
    await assertNoGraphWrite(h2);
  }
});

// ── a stale anchor ───────────────────────────────────────────────────────────

test('an anchor inside a run an earlier rewind abandoned supersedes nothing', async (t) => {
  // Turns 2–3 were abandoned by the branch; a last-prompt read after turn 4
  // names turn 2's last record. Its turn after (3) is superseded already: the
  // conversation went back before it, and turn 4 is never taken.
  const f = build('branch');
  f.r.lastPrompt({ leafUuid: f.lastOf['rw-2'], rewound: true });
  const h = await run(t, f);
  assertExpected(await verdict(h), f, 'the stale anchor');
  assert.equal(h.calls.length, 0);
});

// ── the watermark, unit-level ────────────────────────────────────────────────

test('the watermark: a re-read of the same file is skipped; a rewritten file is judged afresh', () => {
  const calls = [];
  const turns = [];
  const model = {
    resolveTurn: (id) => id, turn: (id) => turns.find((x) => x.id === id) || null,
    turnOfUuid: () => null, turnsOf: () => turns, openTurnOf: () => null, segmentOf: () => null,
    supersede: (cid, from, opts) => { calls.push({ from, opts }); return { ok: true, superseded: [from] }; },
  };
  const src = createRewindsSource().attach({ model, now: () => 0 });
  const opener = (seq, uuid, id) => ({ type: 'opener', prompt_id: id, uuid, parent_uuid: null, seq, ts: seq * 10 });
  const td = (seq, uuid, count) => ({ type: 'turn-duration', uuid, message_count: count, seq, ts: seq * 10 });
  const env = (kind, seq, uuid) => ({ type: 'record', kind, uuid, seq, ts: seq * 10 });
  turns.push({ id: 'p1', session_id: 's', started_at: 10 }, { id: 'p2', session_id: 's', started_at: 40 });
  const file = [opener(1, 'u1', 'p1'), env('attachment/environment', 2, 'u2'), td(3, 'u3', 10),
    opener(4, 'u4', 'p2'), td(5, 'u5', 20)];
  src.onChanges('s', file, { conversation_id: 'c' });
  assert.equal(src.persistState('s').seq, 5);
  assert.equal(src.persistState('s').count, 20);
  // The same file again from 0: the first turn's append and count 10 after 20 —
  // a reset, were it judged — is skipped whole.
  src.onChanges('s', file, { conversation_id: 'c' });
  assert.equal(calls.length, 0, 'a re-read judges nothing');
  assert.equal(src.persistState('s').count, 20);
  // A different file under the same session (its first record is another):
  // the watermark starts over and the new records are judged.
  src.onChanges('s', [opener(1, 'v1', 'p1'), td(2, 'v2', 3)], { conversation_id: 'c' });
  const st = src.persistState('s');
  assert.equal(st.seq, 2);
  assert.deepEqual(st.head, { seq: 1, uuid: 'v1' });
  assert.equal(st.count, 3);
  // The state survives a round trip through the index, content-free.
  const other = createRewindsSource().attach({ model, now: () => 0 });
  other.restoreState('s', JSON.parse(JSON.stringify(st)));
  assert.deepEqual(other.persistState('s'), st);
  other.restoreState('s', { v: 99 });
  assert.deepEqual(other.persistState('s'), st, 'an unknown version is ignored');
});
