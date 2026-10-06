// The transcripts source (lib/server/mirror/transcripts.js, spec §2.2–§2.5,
// §2.9, §2.11, §2.12, §15.6), registered on a REAL createMirror the way U40
// registers it, with an in-memory fake of THE STORE CONTRACT (its header).
//
// Pinned:
//   * end to end: SessionStart, a turn-begin UserPromptSubmit, PreToolUse /
//     PostToolUse, Stop and the matching transcript give one conversation with
//     one closed turn, one tool group and the transcript's reply — with equal
//     prompt_id / promptId, with a mismatch (the alias path), and with a
//     wide-character prompt the hook cut below 16,384 characters (U07b #3: the
//     prefix match cannot bind it, the alias by order does);
//   * a session found late is caught up from 0 in index mode: no mirror:stream
//     frame for its conversation, then exactly one mirror:reset;
//   * restart: a new mirror resumes from the saved index at index.resume, an
//     appended turn gives every turn exactly once, and a task notification's
//     item (three carriers) keeps its seq — before, after, and on a whole-file
//     read (THE SEQ RULE); a turn open at stop resumes just before its opener
//     and closes whole;
//   * meta (the title, through upsertConversation and noteTitle) and a delivery
//     marker's transition reach the facade; SessionEnd keeps the current session
//     followed;
//   * /clear: the old file is drained before the new one is followed, both
//     sessions' turns in one conversation;
//   * a --fork-session file whose first turns belong to another conversation
//     calls markFork and adds no copied turn, and a boot with no index reads
//     the fork's source before the fork, so the fork never takes its turns;
//   * the LRU: an evicted turn holding a task notification is refilled through
//     store.readRange before turns() answers, its task item back with its seq;
//   * itemField pages a persisted tool result through sessionDirFile with to =
//     next, losing no line, a fake key masked; attachment decodes a PNG and
//     refuses bytes that are not what the block claims;
//   * known values (session_context's email, credential_org's id) are
//     registered before anything is stored: in no frame, no answer, no snapshot;
//     skillFold still has the org id, and after a restart both are registered
//     again from the file before index.resume; no answer names a transcript, a
//     tool-results file or a task output;
//   * a disabled session is never tailed; stop() stops every tailer and flushes
//     the store.
//
// The Claude tier is a private fake (test-support/claude-home, isolate: true),
// HOME a throwaway; transcripts are built by test-support/claude-records. The
// item LRU is shrunk for one test by wrapping model.js createModel before the
// facade is required (its budget has no facade option).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { withTempHome, waitUntil } = require('../test-support/helpers');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { createRecords, jsonl, TINY_PNG } = require('../test-support/claude-records');
const { createRedactor, MASK } = require('../lib/core/redact');
const { createBus } = require('../lib/core/bus');
const { userPaths } = require('../lib/core/paths');
const { createHookTap } = require('../lib/server/hook-tap');

// The LRU seam: set `lruOverride` before a mirror is built.
const modelModule = require('../lib/server/mirror/model');
const realCreateModel = modelModule.createModel;
let lruOverride = null;
modelModule.createModel = (opts) => realCreateModel(lruOverride ? { ...opts, lru: lruOverride } : opts);

const { createMirror, SOURCES } = require('../lib/server/mirror');
const { createTailer } = require('../lib/server/mirror/tail');
const {
  createTranscriptsSource, parseLines, mergeChanges, SLICE_VERSION, ATTACHMENT_MAX_BYTES, KNOWN_RANGES_MAX,
} = require('../lib/server/mirror/transcripts');
const { createIndexStore } = require('../lib/server/mirror/index-store');
const claudeFiles = require('../lib/core/claude-files');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const PID = 4242;
const MASK_OPEN = MASK('x').slice(0, -'x›'.length);
const NOTE = { taskId: 'b1a2c3d4', status: 'completed', summary: 'Background command "build" completed (exit code 0)' };

// ── fixtures ─────────────────────────────────────────────────────────────────

function project(t) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-transcripts-'));
  fs.mkdirSync(path.join(dir, '.web-chat'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// THE STORE CONTRACT, in memory. `saved` survives the mirrors that share it.
function fakeStore() {
  const saved = new Map();
  const pending = new Map();
  const log = { loads: [], schedules: [], snapshots: [], ranges: [], flushes: 0, stops: 0, drops: [] };
  async function flush(sid) {
    log.flushes += 1;
    for (const [k, fn] of [...pending]) {
      if (sid && k !== sid) continue;
      pending.delete(k);
      const snap = fn();
      if (!snap) continue;
      const copy = JSON.parse(JSON.stringify(snap));
      log.snapshots.push(copy);
      saved.set(k, copy);
    }
  }
  const create = () => ({
    async load(sid) {
      log.loads.push(sid);
      const ix = saved.get(sid);
      return ix ? { ok: true, index: JSON.parse(JSON.stringify(ix)) } : { ok: false, reason: 'absent' };
    },
    schedule(sid, fn) { log.schedules.push(sid); pending.set(sid, fn); },
    flush,
    drop(sid) { log.drops.push(sid); pending.delete(sid); },
    async readRange(file, { from, to }) {
      log.ranges.push({ file: path.basename(file), from, to });
      const s = fs.readFileSync(file).subarray(from, to).toString('utf8');
      const cut = s.lastIndexOf('\n');
      return cut < 0 ? '' : s.slice(0, cut + 1);
    },
    async stop() { log.stops += 1; await flush(); },
  });
  return { create, saved, pending, log };
}

// A watch that looks at the file only when the tailer asks (its first pump and
// each drain): no file event and no poll, so a test decides when a file is read.
function manualWatch(file, onTrigger) {
  let last = Promise.resolve();
  let stopped = false;
  const trigger = (src) => {
    if (stopped) return Promise.resolve();
    const p = last.then(() => (stopped ? undefined : onTrigger(src)));
    last = p.catch(() => {});
    return p;
  };
  return { trigger, retarget: () => Promise.resolve(), stop: async () => { stopped = true; await last; }, stats: {} };
}

// The real tailer, watched: every record batch it hands over, every stop.
// `manual: true` gives it manualWatch instead of the engine's watchFile.
function watchedTailers({ manual = false } = {}) {
  const list = [];
  const deliveries = [];
  function wrap(opts) {
    const real = createTailer({
      ...opts,
      ...(manual ? { watchFile: manualWatch } : {}),
      onRecords: (recs, meta) => {
        rec.starts.push(recs[0].start);
        for (const r of recs) deliveries.push({ file: path.basename(opts.file), start: r.start });
        return opts.onRecords(recs, meta);
      },
    });
    const rec = { file: opts.file, resume: opts.resume, starts: [], stopped: false, real };
    list.push(rec);
    return {
      start: () => real.start(),
      drain: () => real.drain(),
      resumeAt: (r) => real.resumeAt(r),
      stop: () => { rec.stopped = true; return real.stop(); },
      get stats() { return real.stats; },
    };
  }
  return { list, deliveries, create: wrap, of: (sid) => list.filter((x) => path.basename(x.file) === `${sid}.jsonl`) };
}

// A real facade over a fresh (or a shared) project and Claude tier, with the
// transcripts source registered after `live`, as U40 registers it.
function setup(t, { store = fakeStore(), root = null, ch = null, lru = null, manual = false } = {}) {
  let mirror = null;
  t.after(async () => { if (mirror) await mirror.stop(); });
  if (!root) {
    withTempHome(t);
    root = project(t);
    ch = claudeHome(t, { root, isolate: true });
  }
  const tailers = watchedTailers({ manual });
  const source = createTranscriptsSource({ createStore: store.create, createTailer: tailers.create, pollMs: 40 });
  const hooks = createHookTap();
  const mainBus = createBus();
  const mirrorBus = createBus({ maxEvents: 2000 });
  const frames = [];
  mirrorBus.setBroadcaster((frame) => frames.push(frame));
  const redactor = createRedactor();
  lruOverride = lru;
  try {
    mirror = createMirror({
      root, hooks, mainBus, mirrorBus, redactor, log: () => {},
      sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
      isPidAlive: () => true,
      sources: [...SOURCES, { name: 'transcripts', attach: source.attach }],
    });
  } finally {
    lruOverride = null;
  }
  let ts = Date.now();
  const h = { root, ch, store, tailers, hooks, mirrorBus, frames, redactor, mirror };
  h.tick = () => { ts += 1; return ts; };
  h.env = (event, extra = {}, sid = S1) => ({
    v: 1, event, ts: h.tick(), session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd,
    prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
    result: null, session: null, compact: null, stop: null, prompt: null, ask: null, ...extra,
  });
  h.publish = (event, extra, sid) => hooks.publish(h.env(event, extra, sid));
  h.sessionStart = (sid = S1, source = 'startup', pid = null) => h.publish('SessionStart', { session: { source }, claude_pid: pid }, sid);
  h.prompt = (pid, text, sid = S1) => h.publish('UserPromptSubmit', { prompt_id: pid, prompt: { author: 'user', text } }, sid);
  h.records = (sid = S1, seed = 1) => createRecords({ seed, sessionId: sid, cwd: ch.cwd, start: Date.now(), step: 10 });
  h.turns = async (cid = S1, items = 'full') => mirror.turns(cid, { items, limit: 100 });
  h.collected = [];
  h.ask = async (method, ...args) => { const v = await mirror[method](...args); h.collected.push(v); return v; };
  return h;
}

// A closed turn: prompt, reply, turn_duration.
function closedTurn(r, promptId, text = `prompt ${promptId}`, reply = `reply to ${promptId}`) {
  r.prompt(text, { promptId });
  r.assistant([reply]);
  r.turnDuration({ durationMs: 50 });
}

// A turn that receives one task notification through its three carriers
// (the enqueue, the user record, the queued_command), and closes.
function notifiedTurn(r, promptId) {
  r.prompt(`prompt ${promptId}`, { promptId });
  r.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'npm run build', run_in_background: true } }]);
  const text = require('../test-support/claude-records').taskNotificationText(NOTE);
  r.queueOperation('enqueue', { content: text });
  const user = r.taskNotification(NOTE);
  r.queuedCommand(text, { commandMode: 'task-notification' });
  r.assistant(['The build finished.']);
  r.turnDuration({ durationMs: 80 });
  return user;
}

const ordinalOf = (r, rec) => r.records.indexOf(rec) + 1;
const taskItems = (page) => page.turns.flatMap((t) => (t.items || []).filter((it) => it.kind === 'task'));
const streamFor = (frames, cid) => frames.filter((f) => f.type === 'mirror:stream' && f.conversation_id === cid);
const resetsFor = (frames, cid) => frames.filter((f) => f.type === 'mirror:reset' && f.conversation_id === cid);

async function turnCount(h, n, cid = S1, what = `${n} turns`) {
  return waitUntil(async () => {
    const p = await h.mirror.turns(cid, { limit: 100 });
    return p && p.total === n && p.turns.every((x) => x.status !== 'open') ? p : null;
  }, { timeout: 8000, what });
}

// ── the pure helpers ─────────────────────────────────────────────────────────

test('parseLines: whole lines with exact byte offsets; empty lines skipped, bad lines kept', () => {
  const text = '{"a":1}\n\n{"é":"ü"}\nnot json\n';
  const recs = parseLines(text, 100);
  assert.deepEqual(recs.map((r) => [r.start, r.end, r.bad]), [[100, 108, false], [109, 121, false], [121, 130, true]]);
  assert.equal(recs[1].obj['é'], 'ü');
});

test('mergeChanges: carriers take the seq of the normalizer change at their offset, in file order', () => {
  const recs = [{ start: 0 }, { start: 10 }, { start: 20 }];
  const n = [{ type: 'record', seq: 6, offset: { start: 0 } }, { type: 'item', seq: 8, offset: { start: 20 } }];
  const c = [{ type: 'item', item: { id: 'q' }, offset: { start: 10 } }, { type: 'item', item: { id: 't' }, offset: { start: 20 } }];
  const out = mergeChanges(n, c, recs, 5);
  assert.deepEqual(out.map((x) => [x.offset.start, x.seq, x.item ? x.item.id : x.type]),
    [[0, 6, 'record'], [10, 7, 'q'], [20, 8, 'item'], [20, 8, 't']]);
});

// ── end to end ───────────────────────────────────────────────────────────────

async function oneToolTurn(t, { hookId, recId, text = 'read the readme', hookText = text }) {
  const h = setup(t);
  await h.mirror.start();
  h.sessionStart();
  const r = h.records();
  h.prompt(hookId, hookText);
  r.prompt(text, { promptId: recId });
  r.assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/README.md' }, id: 'toolu_01Read' }]);
  const tool = { use_id: 'toolu_01Read', name: 'Read', input: { file_path: '/tmp/project/README.md' } };
  h.publish('PreToolUse', { tool, prompt_id: hookId });
  r.toolResult('toolu_01Read', 'line one\nline two');
  h.publish('PostToolUse', { tool, prompt_id: hookId, result: { ok: true, duration_ms: 5 } });
  r.assistant(['Done reading.']);
  r.turnDuration({ durationMs: 120 });
  h.publish('Stop', { prompt_id: hookId, stop: { last_assistant_message: 'Done reading.' } });
  h.ch.writeTranscript(S1, r.records);
  const page = await waitUntil(async () => {
    const p = await h.turns();
    const turn = p && p.turns[0];
    return turn && turn.status === 'done' && turn.items.some((it) => it.kind === 'reply' && it.source === 'transcript') ? p : null;
  }, { timeout: 8000, what: 'the closed turn with its transcript reply' });
  return { h, page };
}

function assertOneToolTurn(h, page, id) {
  const snap = h.mirror.snapshot({});
  assert.equal(snap.conversations.length, 1, 'one conversation');
  assert.equal(page.total, 1, 'one turn');
  const [turn] = page.turns;
  assert.equal(turn.id, id);
  assert.equal(turn.status, 'done');
  assert.equal(turn.groups.length, 1, 'one tool group');
  assert.deepEqual(turn.tool_names, ['Read']);
  const kinds = turn.items.map((it) => it.kind);
  assert.deepEqual(kinds, ['prompt', 'tool_call', 'reply']);
  const reply = turn.items.find((it) => it.kind === 'reply');
  assert.equal(reply.text, 'Done reading.');
  assert.equal(reply.source, 'transcript', 'the transcript\'s reply replaced the Stop\'s');
  assert.equal(turn.items.find((it) => it.kind === 'tool_call').status, 'done');
}

test('end to end: hooks and the matching transcript give one closed turn, one tool group and the reply (same id)', async (t) => {
  const { h, page } = await oneToolTurn(t, { hookId: 'prompt-same-1', recId: 'prompt-same-1' });
  assertOneToolTurn(h, page, 'prompt-same-1');
  assert.equal(page.turns[0].replaces, undefined);
});

test('end to end with a prompt_id / promptId mismatch: the alias path binds the one turn (V28 either way)', async (t) => {
  const { h, page } = await oneToolTurn(t, { hookId: 'hook-side-1', recId: 'record-side-1' });
  assertOneToolTurn(h, page, 'record-side-1');
  assert.equal(page.turns[0].replaces, 'hook-side-1');
});

test('a wide-character prompt the hook cut below 16,384 characters still binds by order under a mismatch (U07b #3)', async (t) => {
  const full = '漢字'.repeat(12000); // 24,000 characters, 72,000 bytes
  const hookText = full.slice(0, 8192); // what the 32 KB envelope rule leaves of it
  const { h, page } = await oneToolTurn(t, { hookId: 'hook-wide', recId: 'record-wide', text: full, hookText });
  assertOneToolTurn(h, page, 'record-wide');
  assert.equal(page.turns[0].replaces, 'hook-wide');
});

// ── catch-up ─────────────────────────────────────────────────────────────────

test('a session found late is caught up from 0 in index mode: no stream frame, then exactly one reset', async (t) => {
  const h = setup(t);
  const r = h.records();
  for (let i = 1; i <= 4; i++) closedTurn(r, `late-${i}`);
  h.ch.writeTranscript(S1, r.records);
  await h.mirror.start();
  h.sessionStart();
  await turnCount(h, 4);
  await waitUntil(() => resetsFor(h.frames, S1).length >= 1, { timeout: 4000, what: 'the reset' });
  await new Promise((res) => setTimeout(res, 250)); // two more flushes
  assert.equal(streamFor(h.frames, S1).length, 0, 'no per-item frame for the caught-up conversation');
  assert.equal(resetsFor(h.frames, S1).length, 1, 'one mirror:reset');
  assert.equal(h.tailers.of(S1)[0].resume, null, 'read from 0');
  const snap = h.mirror.snapshot({});
  assert.equal(snap.conversations[0].diagnostics.transcript, 'ok');
  const page = await h.turns();
  assert.deepEqual(page.turns.map((x) => x.id), ['late-1', 'late-2', 'late-3', 'late-4']);
});

// ── restart ──────────────────────────────────────────────────────────────────

test('restart: the new mirror resumes at index.resume, every turn exactly once, the task item\'s seq kept', async (t) => {
  const store = fakeStore();
  const a = setup(t, { store });
  const r = a.records();
  closedTurn(r, 'rs-1');
  const delivery = notifiedTurn(r, 'rs-2');
  a.ch.writeTranscript(S1, r.records);
  await a.mirror.start();
  a.sessionStart();
  await turnCount(a, 2);
  const before = taskItems(await a.turns());
  assert.equal(before.length, 1, 'one task item for three carriers');
  assert.equal(before[0].seq, ordinalOf(r, delivery), 'its seq is its delivery record\'s file ordinal');
  await a.mirror.stop();
  const index = store.saved.get(S1);
  assert.ok(index && index.resume, 'an index with a resume point was saved at stop');
  assert.equal(index.resume.offset, fs.statSync(a.ch.transcript(S1)).size, 'every turn closed: resume after the last record');
  assert.deepEqual(index.turns.map((x) => x.id), ['rs-1', 'rs-2'], 'each turn with its id on top');

  // A new mirror over the same project, Claude tier and store.
  const b = setup(t, { store, root: a.root, ch: a.ch });
  await b.mirror.start();
  b.sessionStart(S1, 'resume');
  await turnCount(b, 2);
  const tail = await waitUntil(() => b.tailers.of(S1).find((x) => x.resume), { what: 'the resumed tailer' });
  assert.equal(tail.resume.offset, index.resume.offset, 'the tailer was handed index.resume');
  const offsetBefore = fs.statSync(a.ch.transcript(S1)).size;
  const n0 = r.records.length;
  closedTurn(r, 'rs-3');
  b.ch.appendTranscript(S1, r.records.slice(n0));
  const page = await turnCount(b, 3);
  assert.deepEqual(page.turns.map((x) => x.id), ['rs-1', 'rs-2', 'rs-3'], 'no duplicate, no gap');
  assert.ok(b.tailers.deliveries.filter((d) => d.file === `${S1}.jsonl`).every((d) => d.start >= offsetBefore),
    'nothing before the resume point was read again');
  const after = taskItems(await b.turns());
  assert.equal(after.length, 1);
  assert.equal(after[0].id, before[0].id);
  assert.equal(after[0].seq, before[0].seq, 'the refilled task item keeps its seq');

  // A whole-file read of the same transcript numbers it the same.
  await b.mirror.stop();
  const c = setup(t, { store: fakeStore(), root: a.root, ch: a.ch });
  await c.mirror.start();
  c.sessionStart(S1, 'resume');
  const whole = await turnCount(c, 3);
  assert.equal(c.tailers.of(S1)[0].resume, null, 'read from 0');
  assert.deepEqual(whole.turns.map((x) => x.id), ['rs-1', 'rs-2', 'rs-3']);
  const wholeTask = taskItems(await c.turns());
  assert.equal(wholeTask.length, 1);
  assert.equal(wholeTask[0].seq, before[0].seq, 'and the same seq on a whole-file read');
});

test('restart with a turn open: the index resumes just before its opener, and the turn closes whole', async (t) => {
  const store = fakeStore();
  const a = setup(t, { store });
  const r = a.records();
  closedTurn(r, 'ot-1');
  const k = r.records.length;
  r.prompt('prompt ot-2', { promptId: 'ot-2' });
  r.assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/a.txt' }, id: 'toolu_01Open' }]);
  a.ch.writeTranscript(S1, r.records);
  await a.mirror.start();
  a.sessionStart();
  await waitUntil(async () => {
    const p = await a.mirror.turns(S1, { limit: 100 });
    return p && p.total === 2 && p.turns[1].status === 'open';
  }, { timeout: 8000, what: 'ot-2 open' });
  await a.mirror.stop();
  const index = store.saved.get(S1);
  assert.ok(index && index.resume, 'an index with a resume point');
  assert.equal(index.resume.offset, Buffer.byteLength(jsonl(r.records.slice(0, k))), 'the open turn\'s opener, not the last record');

  const b = setup(t, { store, root: a.root, ch: a.ch });
  await b.mirror.start();
  b.sessionStart(S1, 'resume');
  await waitUntil(() => b.tailers.of(S1).find((x) => x.resume), { what: 'the resumed tailer' });
  const n0 = r.records.length;
  r.toolResult('toolu_01Open', 'contents of a');
  r.assistant(['Read it.']);
  r.turnDuration({ durationMs: 30 });
  b.ch.appendTranscript(S1, r.records.slice(n0));
  const page = await turnCount(b, 2);
  assert.deepEqual(page.turns.map((x) => x.id), ['ot-1', 'ot-2']);
  const full = await b.turns();
  const turn2 = full.turns.find((x) => x.id === 'ot-2');
  assert.deepEqual(turn2.items.map((it) => it.kind), ['prompt', 'tool_call', 'reply'], 'every item of the reopened turn, once');
  assert.equal(turn2.items.find((it) => it.kind === 'tool_call').status, 'done');
});

test('meta, the title and a delivery marker reach the facade through the contract', async (t) => {
  const h = setup(t);
  const seen = [];
  h.mirror.subscribe((e) => seen.push(e));
  const r = h.records();
  r.aiTitle('Fix the flaky build');
  r.channel({ body: 'please look [web-chat message m-0123abcd]' });
  r.assistant(['Looking.']);
  r.turnDuration();
  h.ch.writeTranscript(S1, r.records);
  await h.mirror.start();
  h.sessionStart();
  await turnCount(h, 1);
  await waitUntil(() => {
    const c = h.mirror.snapshot({}).conversations.find((x) => x.id === S1);
    return c && c.title === 'Fix the flaky build';
  }, { what: 'the conversation\'s title, from the meta patch' });
  await waitUntil(() => seen.find((e) => e.op === 'delivered' && e.marker === 'm-0123abcd' && e.conversation_id === S1),
    { what: 'the delivered transition' });
  await h.mirror.stop();
  const { projectPaths } = require('../lib/core/paths');
  const saved = JSON.parse(fs.readFileSync(projectPaths(h.root).mirrorConversations, 'utf8'));
  assert.equal(saved.conversations.find((c) => c.id === S1).title, 'Fix the flaky build', 'noteTitle kept it for a restart');
});

test('SessionEnd of the current session keeps following it', async (t) => {
  const h = setup(t);
  await h.mirror.start();
  h.sessionStart();
  const r = h.records();
  closedTurn(r, 'se-1');
  h.ch.writeTranscript(S1, r.records);
  await turnCount(h, 1);
  h.publish('SessionEnd', { session: { reason: 'other' } });
  await new Promise((res) => setTimeout(res, 200));
  const n0 = r.records.length;
  closedTurn(r, 'se-2');
  h.ch.appendTranscript(S1, r.records.slice(n0));
  const page = await turnCount(h, 2);
  assert.deepEqual(page.turns.map((x) => x.id), ['se-1', 'se-2']);
});

// ── /clear and forks ─────────────────────────────────────────────────────────

test('/clear: the old file is drained before the new one is followed; both sessions\' turns in one conversation', async (t) => {
  // Files are read only when a tailer starts or drains: nothing but the /clear's
  // drain can read the old file's last turn.
  const h = setup(t, { manual: true });
  await h.mirror.start();
  const r1 = h.records(S1, 1);
  closedTurn(r1, 'old-1');
  h.ch.writeTranscript(S1, r1.records);
  h.sessionStart(S1, 'startup', PID);
  await turnCount(h, 1);
  const tailEnd = fs.statSync(h.ch.transcript(S1)).size;
  // The old file's last turn and the new file land together, as the /clear writes them.
  closedTurn(r1, 'old-2');
  h.ch.writeTranscript(S1, r1.records);
  const r2 = h.records(S2, 2);
  closedTurn(r2, 'new-1');
  h.ch.writeTranscript(S2, r2.records);
  // No SessionEnd (missed 1 time in 6, V14): the 'linked' event alone orders the reads.
  h.publish('SessionStart', { claude_pid: PID, session: { source: 'clear' } }, S2);
  const page = await turnCount(h, 3);
  assert.equal(h.mirror.snapshot({}).conversations.length, 1, 'one conversation');
  assert.deepEqual(page.turns.map((x) => [x.id, x.session_id]), [['old-1', S1], ['old-2', S1], ['new-1', S2]]);
  const order = h.tailers.deliveries;
  const lastOld = order.findIndex((d) => d.file === `${S1}.jsonl` && d.start >= tailEnd);
  const firstNew = order.findIndex((d) => d.file === `${S2}.jsonl`);
  assert.ok(lastOld >= 0 && firstNew >= 0);
  const lastOldIdx = order.map((d) => d.file === `${S1}.jsonl`).lastIndexOf(true);
  assert.ok(lastOldIdx < firstNew, 'every record of the old file before any of the new one');
  await waitUntil(() => h.tailers.of(S1).every((x) => x.stopped), { what: 'the old tailer stopped' });
});

test('a --fork-session file whose first turns belong to another conversation calls markFork and adds no copied turn', async (t) => {
  const h = setup(t);
  await h.mirror.start();
  h.sessionStart(S1);
  const r1 = h.records(S1, 1);
  closedTurn(r1, 'src-1');
  closedTurn(r1, 'src-2');
  h.ch.writeTranscript(S1, r1.records);
  await turnCount(h, 2);
  // The fork: the source's records copied under the new session id, then its own turn.
  const copied = r1.records.map((x) => (x.sessionId ? { ...x, sessionId: S3 } : x));
  const r3 = h.records(S3, 3);
  closedTurn(r3, 'fork-own-1');
  h.ch.writeTranscript(S3, [...copied, ...r3.records]);
  h.sessionStart(S3, 'resume');
  const page = await turnCount(h, 1, S3, 'the fork\'s own turn');
  assert.deepEqual(page.turns.map((x) => x.id), ['fork-own-1'], 'no copied turn');
  await waitUntil(() => {
    const c = h.mirror.snapshot({}).conversations.find((x) => x.id === S3);
    return c && c.forked_from === S1;
  }, { what: 'forked_from' });
  assert.deepEqual((await h.turns(S1)).turns.map((x) => x.id), ['src-1', 'src-2'], 'the source untouched');
});

test('a boot with no index reads a fork\'s source before the fork: the fork never takes the source\'s turns', async (t) => {
  const a = setup(t);
  await a.mirror.start();
  a.sessionStart(S1);
  const r1 = a.records(S1, 1);
  closedTurn(r1, 'src-1');
  closedTurn(r1, 'src-2');
  a.ch.writeTranscript(S1, r1.records);
  await turnCount(a, 2);
  const copied = r1.records.map((x) => (x.sessionId ? { ...x, sessionId: S3 } : x));
  const r3 = a.records(S3, 3);
  closedTurn(r3, 'fork-own-1');
  a.ch.writeTranscript(S3, [...copied, ...r3.records]);
  a.sessionStart(S3, 'resume');
  await turnCount(a, 1, S3, 'the fork\'s own turn');
  await waitUntil(() => {
    const c = a.mirror.snapshot({}).conversations.find((x) => x.id === S3);
    return c && c.forked_from === S1;
  }, { what: 'forked_from' });
  await a.mirror.stop();

  // A second mirror on the same root and Claude tier, with no index at all: the
  // registry lists the fork first (the newest activity), its source after it.
  const b = setup(t, { store: fakeStore(), root: a.root, ch: a.ch });
  await b.mirror.start();
  const src = await turnCount(b, 2, S1, 'the source\'s turns');
  const fork = await turnCount(b, 1, S3, 'the fork\'s own turn');
  assert.deepEqual(src.turns.map((x) => x.id), ['src-1', 'src-2'], 'the source keeps its turns');
  assert.deepEqual(fork.turns.map((x) => x.id), ['fork-own-1'], 'the fork has only its own');
  const order = b.tailers.list.map((x) => path.basename(x.file));
  assert.ok(order.indexOf(`${S1}.jsonl`) < order.indexOf(`${S3}.jsonl`), 'the source was opened first');
});

// ── the LRU ──────────────────────────────────────────────────────────────────

test('an evicted turn holding a task notification is refilled through store.readRange, its task item\'s seq kept', async (t) => {
  const h = setup(t, { lru: { maxChars: 1, maxItems: 1e6, keepRecent: 1 } });
  const r = h.records();
  const delivery = notifiedTurn(r, 'lru-1');
  closedTurn(r, 'lru-2');
  closedTurn(r, 'lru-3');
  h.ch.writeTranscript(S1, r.records);
  await h.mirror.start();
  h.sessionStart();
  await turnCount(h, 3);
  const stats = h.mirror.stats();
  assert.ok(stats.model.evicted >= 1, 'the older turns lost their items');
  const ranges = h.store.log.ranges.length;
  const page = await h.turns();
  assert.ok(h.store.log.ranges.length > ranges, 'refilled through store.readRange');
  const first = page.turns.find((x) => x.id === 'lru-1');
  assert.ok(Array.isArray(first.items) && first.items.length, 'items back before turns() answered');
  const task = first.items.find((it) => it.kind === 'task');
  assert.ok(task, 'the task item is back');
  assert.equal(task.task_id, NOTE.taskId);
  assert.equal(task.seq, ordinalOf(r, delivery), 'with its seq');
  assert.equal(first.items.find((it) => it.kind === 'prompt').text, 'prompt lru-1');
});

// ── item fields and attachments ──────────────────────────────────────────────

test('itemField pages a persisted tool result (fenced through sessionDirFile) with to = next, losing no line', async (t) => {
  const h = setup(t);
  const fake = fakeSecrets().find((f) => f.id === 'github-ghp') || fakeSecrets().find((f) => !f.context && f.rule !== 'known');
  const lines = [];
  for (let i = 0; i < 600; i++) lines.push(`line ${String(i).padStart(4, '0')} of the build output`);
  lines.splice(300, 0, `export TOKEN_LINE=${fake.text}`);
  const body = `${lines.join('\n')}\n`;
  const dir = h.ch.sessionDir(S1);
  const out = path.join(dir, 'tool-results', 'toolu_01Big.txt');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, body);
  const r = h.records();
  r.prompt('build it', { promptId: 'big-1' });
  r.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'npm run build' }, id: 'toolu_01Big' }]);
  r.toolResult('toolu_01Big', 'line 0000 of the build output…', { persistedOutputPath: out, persistedOutputSize: Buffer.byteLength(body) });
  r.assistant(['Built.']);
  r.turnDuration();
  h.ch.writeTranscript(S1, r.records);
  await h.mirror.start();
  h.sessionStart();
  await turnCount(h, 1);
  const pages = [];
  let from = 0;
  for (let i = 0; i < 100; i++) {
    const p = await h.ask('itemField', 'toolu_01Big', { field: 'result', from, max: 1000 });
    assert.ok(p, 'a page');
    pages.push(p);
    if (p.eof) break;
    assert.ok(p.to > from, 'the pager moves on');
    from = p.to;
  }
  assert.ok(pages.length > 5, 'several pages');
  assert.ok(pages.every((p) => p.total === Buffer.byteLength(body)));
  const got = pages.map((p) => p.text).join('');
  const want = lines.map((l, i) => (i === 300 ? null : l)).filter((l) => l !== null);
  const gotLines = got.split('\n').filter(Boolean);
  for (const l of want) assert.ok(gotLines.includes(l), `kept: ${l}`);
  assert.equal(gotLines.length, lines.length, 'no line lost or shown twice');
  assert.deepEqual(findLeaks(got, [fake]), [], 'the fake key is masked');
  assert.ok(got.includes(MASK_OPEN));
  const text = await h.ask('itemField', 'p_big-1', { field: 'text' });
  assert.deepEqual([text.text, text.from, text.to, text.eof], ['build it', 0, 8, true]);
});

test('attachment answers the decoded PNG; a block whose bytes are not its media type answers null', async (t) => {
  const h = setup(t);
  const r = h.records();
  r.promptImage('look at this', { promptId: 'img-1' });
  r.assistant(['A small image.']);
  r.turnDuration();
  r.promptImage('and this', { promptId: 'img-2', png: Buffer.from('this is not a png, whatever it says') });
  r.assistant(['That is not one.']);
  r.turnDuration();
  h.ch.writeTranscript(S1, r.records);
  await h.mirror.start();
  h.sessionStart();
  await turnCount(h, 2);
  const a = await h.mirror.attachment('p_img-1', 1);
  assert.ok(a, 'an answer');
  assert.equal(a.media_type, 'image/png');
  assert.ok(Buffer.from(a.bytes).equals(TINY_PNG), 'the PNG\'s bytes, decoded');
  assert.equal(await h.mirror.attachment('p_img-2', 1), null, 'claimed image/png, is not');
  assert.equal(await h.mirror.attachment('p_img-1', 2), null, 'no second attachment');
});

// ── known values, paths ──────────────────────────────────────────────────────

test('known values are registered before anything is stored: in no frame, no answer, no snapshot; skillFold keeps the org id', async (t) => {
  const h = setup(t);
  const email = 'pat.example-user@example.com';
  const org = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
  const r = h.records();
  r.sessionContext({ userEmail: email });
  r.credentialOrg(org);
  r.skillListing({ isInitial: true, names: ['deploy'], content: '- deploy: ship it' });
  r.prompt(`mail ${email} about org ${org}`, { promptId: 'kv-1' });
  r.assistant([`Mailed ${email}.`]);
  r.turnDuration();
  h.ch.writeTranscript(S1, r.records);
  await h.mirror.start();
  h.sessionStart();
  await turnCount(h, 1);
  await new Promise((res) => setTimeout(res, 250));
  const answers = [await h.ask('turns', S1, { items: 'full' }), await h.ask('turn', 'kv-1'),
    await h.ask('itemField', 'p_kv-1', { field: 'text' }), h.mirror.snapshot({})];
  // The snapshots scheduled so far, taken now as the store would write them.
  for (const fn of h.store.pending.values()) h.store.log.snapshots.push(JSON.parse(JSON.stringify(fn())));
  assert.ok(h.store.log.snapshots.length >= 1, 'a snapshot was scheduled');
  // The meta fold's free text (title, first_prompt, …) is handed over RAW: the
  // store redacts it before it persists it (ruled 2026-10-05,
  // U27@meta.js:18-raw-text-in-persisted-state). Everything else must be clean.
  const RAW_META = ['title', 'ai_title', 'agent_name', 'first_prompt', 'away'];
  const outsideRawMeta = h.store.log.snapshots.map((snap) => {
    const meta = { ...snap.state.meta };
    for (const k of RAW_META) delete meta[k];
    return { ...snap, state: { ...snap.state, meta } };
  });
  assert.ok(h.store.log.snapshots.some((snap) => String(snap.state.meta.first_prompt).includes(email)),
    'the raw first prompt is the store\'s to redact');
  for (const [what, v] of [['frames', h.frames], ['answers', answers], ['snapshots', outsideRawMeta]]) {
    const s = JSON.stringify(v);
    assert.ok(!s.includes(email), `no email in ${what}`);
    assert.ok(!s.includes(org), `no org id in ${what}`);
  }
  assert.ok(JSON.stringify(answers[0]).includes('mail '), 'the prompt is there, masked');
  const fold = h.mirror.skillFold(S1);
  assert.equal(fold.orgUuid, org, 'skillFold keeps the org id, in process');
  assert.deepEqual(fold.names, ['deploy']);
});

test('restart: the known values before index.resume are registered again (the index never holds them)', async (t) => {
  const store = fakeStore();
  const a = setup(t, { store });
  const email = 'pat.resumed-user@example.com';
  const org = '7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918';
  const r = a.records();
  r.sessionContext({ userEmail: email });
  r.credentialOrg(org);
  closedTurn(r, 'kr-1');
  a.ch.writeTranscript(S1, r.records);
  await a.mirror.start();
  a.sessionStart();
  await turnCount(a, 1);
  await a.mirror.stop();
  const index = store.saved.get(S1);
  assert.ok(index && index.resume && index.resume.offset > 0, 'an index resuming past both known-value records');
  assert.ok(!JSON.stringify(index).includes(email) && !JSON.stringify(index).includes(org), 'neither value in the index');

  // A new mirror, with a new redactor that has never seen either value.
  const b = setup(t, { store, root: a.root, ch: a.ch });
  await b.mirror.start();
  b.sessionStart(S1, 'resume');
  await waitUntil(() => b.tailers.of(S1).find((x) => x.resume), { what: 'the resumed tailer' });
  const n0 = r.records.length;
  closedTurn(r, 'kr-2', `mail ${email} about org ${org}`, `Mailed ${email}.`);
  b.ch.appendTranscript(S1, r.records.slice(n0));
  await turnCount(b, 2);
  assert.ok(b.tailers.deliveries.filter((d) => d.file === `${S1}.jsonl`).every((d) => d.start >= index.resume.offset),
    'the records naming them were not handed over again');
  const answers = [await b.ask('turns', S1, { items: 'full' }), await b.ask('turn', 'kr-2')];
  const s = JSON.stringify([answers, b.frames]);
  assert.ok(s.includes('mail '), 'the prompt is there');
  assert.ok(!s.includes(email), 'the email is masked after the restart');
  assert.ok(!s.includes(org), 'the org id is masked after the restart');
  assert.equal(b.mirror.skillFold(S1).orgUuid, org, 'skillFold has the org id again');
});

test('no api answer names the projects dir, a .jsonl, a tool-results file or a task output', async (t) => {
  const h = setup(t);
  const dir = h.ch.sessionDir(S1);
  const out = path.join(dir, 'tool-results', 'toolu_01P.txt');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'all of it\n');
  const task = h.ch.writeTaskOutput(S1, 'b9z8y7x6', 'building…\n');
  const r = h.records();
  r.prompt('go', { promptId: 'paths-1' });
  r.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'make' }, id: 'toolu_01P' }]);
  r.toolResult('toolu_01P', 'part of it', { persistedOutputPath: out, persistedOutputSize: 10, taskId: 'b9z8y7x6' });
  r.assistant(['Done.']);
  r.turnDuration();
  h.ch.writeTranscript(S1, r.records);
  await h.mirror.start();
  h.sessionStart();
  await turnCount(h, 1);
  const answers = [await h.ask('turns', S1, { items: 'full' }), await h.ask('turn', 'paths-1'),
    await h.ask('itemField', 'toolu_01P', { field: 'result' }), await h.ask('itemField', 'toolu_01P', { field: 'input' }),
    await h.ask('forkAnchor', 'paths-1')];
  const s = JSON.stringify(answers);
  assert.ok(answers[2] && answers[2].text.includes('all of it'), 'the full result was read');
  for (const bad of [h.ch.projectsDir, fs.realpathSync(h.ch.projectsDir), '.jsonl', 'tool-results', '.output', typeof task === 'string' ? task : 'tasks/']) {
    assert.ok(!s.includes(bad), `no ${bad} in an answer`);
  }
});

test('forkAnchor: the opener\'s parent for a later turn; the first, a superseded or an unknown turn refused', async (t) => {
  const h = setup(t);
  const r = h.records();
  closedTurn(r, 'fa-1');
  const before = r.leaf;
  closedTurn(r, 'fa-2');
  h.ch.writeTranscript(S1, r.records);
  await h.mirror.start();
  h.sessionStart();
  await turnCount(h, 2);
  assert.deepEqual(await h.mirror.forkAnchor('fa-2'), { session_id: S1, parent_uuid: before });
  assert.deepEqual(await h.mirror.forkAnchor('fa-1'), { refused: 'first' });
  assert.deepEqual(await h.mirror.forkAnchor('nope'), { refused: 'unknown' });
});

// ── disabled sessions, stop ──────────────────────────────────────────────────

test('a disabled session is never tailed; stop() stops every tailer and flushes the store', async (t) => {
  const h = setup(t);
  const marker = userPaths().sessionFile(S2);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ enabled: false }));
  const r1 = h.records(S1, 1);
  closedTurn(r1, 'on-1');
  h.ch.writeTranscript(S1, r1.records);
  const r2 = h.records(S2, 2);
  closedTurn(r2, 'off-1');
  h.ch.writeTranscript(S2, r2.records);
  await h.mirror.start();
  h.sessionStart(S1);
  h.sessionStart(S2);
  await turnCount(h, 1);
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(h.tailers.of(S2).length, 0, 'the disabled session is never tailed');
  assert.ok(h.tailers.of(S1).length >= 1);
  const flushes = h.store.log.flushes;
  await h.mirror.stop();
  assert.ok(h.tailers.list.every((x) => x.stopped), 'every tailer stopped');
  assert.ok(h.store.log.flushes > flushes, 'the store flushed');
  assert.equal(h.store.log.stops, 1, 'and stopped');
  assert.ok(h.store.saved.get(S1), 'S1\'s index written');
  assert.equal(h.store.saved.get(S2), undefined);
  const snap = h.store.saved.get(S1);
  assert.equal(snap.state.sources.transcripts.v, SLICE_VERSION, 'the source\'s own slice is in the index');
  assert.equal(SLICE_VERSION, 2, 'the slice carries the known-value ranges since U28b@known-ranges');
  assert.ok(!('org' in snap.state.meta) && !JSON.stringify(snap).includes('organizationUuid'));
});

// ── the attachment limit (ruled U28b@attachment-limit) ───────────────────────

// The real index store (lib/server/mirror/index-store.js), so readRange keeps
// its 8 MiB line rule.
const realStore = () => ({ create: (o) => createIndexStore(o), log: { ranges: [] } });
// A PNG of exactly `n` bytes: the signature, then padding.
function pngOf(n) {
  const b = Buffer.alloc(n, 0x41);
  TINY_PNG.copy(b, 0, 0, Math.min(TINY_PNG.length, n));
  return b;
}

test('the attachment limit is 6 MiB − 48 KiB, and the content route serves up to the same number', () => {
  assert.equal(ATTACHMENT_MAX_BYTES, 6242304);
  assert.equal(ATTACHMENT_MAX_BYTES, 6 * 1024 * 1024 - 48 * 1024);
  // Its base64 leaves 64 KiB of readWindow's 8 MiB for the record around it.
  assert.equal(claudeFiles.WINDOW_MAX_BYTES - Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4, 64 * 1024);
  // routes/mirror-content.js requires only ./mirror (its own test), so it spells
  // the number; this pins the two equal.
  assert.equal(require('../lib/server/routes/mirror-content').ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_BYTES);
});

test('an attachment of exactly the limit is served; one byte more answers null before its base64 is decoded', async (t) => {
  const h = setup(t, { store: realStore() });
  const r = h.records();
  const exact = pngOf(ATTACHMENT_MAX_BYTES);
  r.promptImage('the largest one', { promptId: 'att-max', png: exact });
  r.assistant(['Seen.']);
  r.turnDuration();
  r.promptImage('one byte more', { promptId: 'att-over', png: pngOf(ATTACHMENT_MAX_BYTES + 1) });
  r.assistant(['Too big.']);
  r.turnDuration();
  h.ch.writeTranscript(S1, r.records);
  await h.mirror.start();
  h.sessionStart();
  await turnCount(h, 2);
  const realFrom = Buffer.from;
  let decodes = 0;
  const spy = function from(v, enc, ...rest) {
    if (enc === 'base64') decodes += 1;
    return realFrom.call(Buffer, v, enc, ...rest);
  };
  Buffer.from = spy;
  let a = null;
  let over = 'unset';
  try {
    a = await h.mirror.attachment('p_att-max', 1);
    assert.ok(decodes >= 1, 'the spy sees a decode');
    decodes = 0;
    over = await h.mirror.attachment('p_att-over', 1);
  } finally {
    Buffer.from = realFrom;
  }
  assert.ok(a, 'the exact limit is served');
  assert.equal(a.media_type, 'image/png');
  assert.equal(a.bytes.length, ATTACHMENT_MAX_BYTES);
  assert.ok(Buffer.from(a.bytes).equals(exact), 'its bytes, decoded');
  assert.equal(over, null, 'one byte more answers null');
  assert.equal(decodes, 0, 'without decoding its base64');
});

test('a record whose two attachments, each under the limit, make a line over 8 MiB answers null for both', async (t) => {
  const h = setup(t, { store: realStore() });
  const r = h.records();
  const half = pngOf(4.5 * 1024 * 1024);
  r.prompt('look at both', { promptId: 'att-two' });
  r.assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/both.png' }, id: 'toolu_01Two' }]);
  r.toolResult('toolu_01Two', 'two images', { images: [half, half] });
  r.assistant(['Too much for one line.']);
  r.turnDuration();
  // The control: the same shape, small.
  r.prompt('look at these', { promptId: 'att-small' });
  r.assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/small.png' }, id: 'toolu_01Small' }]);
  r.toolResult('toolu_01Small', 'two images', { images: [TINY_PNG, TINY_PNG] });
  r.assistant(['Both fine.']);
  r.turnDuration();
  h.ch.writeTranscript(S1, r.records);
  assert.ok(Buffer.byteLength(JSON.stringify(r.records.find((x) => JSON.stringify(x).includes('toolu_01Two') && x.type === 'user')))
    > claudeFiles.WINDOW_MAX_BYTES, 'the record\'s line is over 8 MiB');
  await h.mirror.start();
  h.sessionStart();
  await turnCount(h, 2);
  const small = [await h.mirror.attachment('toolu_01Small', 1), await h.mirror.attachment('toolu_01Small', 2)];
  assert.ok(small.every((x) => x && Buffer.from(x.bytes).equals(TINY_PNG)), 'the small record answers both');
  assert.equal(await h.mirror.attachment('toolu_01Two', 1), null, 'the first answers null');
  assert.equal(await h.mirror.attachment('toolu_01Two', 2), null, 'the second answers null');
});

// ── known values across a restart (ruled U28b@known-ranges) ──────────────────

// The byte range [start, end) of record `rec` in `records` written as jsonl.
function rangeOf(records, rec) {
  const i = records.indexOf(rec);
  const start = Buffer.byteLength(jsonl(records.slice(0, i)));
  return [start, start + Buffer.byteLength(jsonl([rec]))];
}
// Push one record through `fn` and answer it.
function added(r, fn) {
  const n = r.records.length;
  fn();
  return r.records[n];
}

// Count lib/core/claude-files readWindow calls on S1's transcript from now on
// (the facade captures readWindow when a mirror is built, so this wraps it
// before one is). Answers the list; the wrap comes off at the test's end.
function countWindows(t) {
  const real = claudeFiles.readWindow;
  const calls = [];
  claudeFiles.readWindow = (file, opts) => {
    if (path.basename(String(file)) === `${S1}.jsonl`) calls.push({ ...opts });
    return real(file, opts);
  };
  t.after(() => { claudeFiles.readWindow = real; });
  return { calls, off: () => { claudeFiles.readWindow = real; } };
}

async function restartWith(t, a, store, { windows = true } = {}) {
  const w = windows ? countWindows(t) : null;
  const ranges0 = store.log.ranges.length;
  const b = setup(t, { store, root: a.root, ch: a.ch });
  if (w) w.off(); // only the new mirror's facade holds the counting wrap
  await b.mirror.start();
  b.sessionStart(S1, 'resume');
  await waitUntil(() => b.tailers.of(S1).find((x) => x.resume), { what: 'the resumed tailer' });
  return { b, windows: w ? w.calls : [], ranges: () => store.log.ranges.slice(ranges0) };
}

test('a restart reads only the recorded known-value lines of the prefix and registers both values again', async (t) => {
  const store = fakeStore();
  const a = setup(t, { store });
  const email = 'pat.ranged-user@example.com';
  const org = '5d4c3b2a-1908-4f7e-8d6c-5b4a39281706';
  const r = a.records();
  closedTurn(r, 'kn-0');
  const ctx = added(r, () => r.sessionContext({ userEmail: email }));
  const cred = added(r, () => r.credentialOrg(org));
  closedTurn(r, 'kn-1');
  added(r, () => r.sessionContext({ userEmail: email })); // the same value again: no second range
  closedTurn(r, 'kn-2');
  a.ch.writeTranscript(S1, r.records);
  await a.mirror.start();
  a.sessionStart();
  await turnCount(a, 3);
  await a.mirror.stop();
  const index = store.saved.get(S1);
  const slice = index.state.sources.transcripts;
  assert.equal(slice.v, SLICE_VERSION);
  assert.deepEqual(slice.known, [rangeOf(r.records, ctx), rangeOf(r.records, cred)], 'one range per distinct value, the first line');
  assert.ok(!JSON.stringify(index).includes(email) && !JSON.stringify(index).includes(org), 'ranges, never a value');

  const { b, windows, ranges } = await restartWith(t, a, store);
  const n0 = r.records.length;
  closedTurn(r, 'kn-3', `mail ${email} about org ${org}`, `Mailed ${email}.`);
  b.ch.appendTranscript(S1, r.records.slice(n0));
  await turnCount(b, 4);
  assert.deepEqual(windows.filter((c) => (c.from || 0) < index.resume.offset), [], 'no readWindow of the prefix');
  assert.deepEqual(ranges().filter((x) => x.file === `${S1}.jsonl`).map((x) => [x.from, x.to]), slice.known,
    'store.readRange read exactly the recorded lines');
  assert.ok(b.tailers.deliveries.filter((d) => d.file === `${S1}.jsonl`).every((d) => d.start >= index.resume.offset));
  const s = JSON.stringify([await b.ask('turns', S1, { items: 'full' }), b.frames]);
  assert.ok(s.includes('mail '), 'the prompt is there');
  assert.ok(!s.includes(email), 'the email is masked after the restart');
  assert.ok(!s.includes(org), 'the org id is masked after the restart');
  assert.equal(b.mirror.skillFold(S1).orgUuid, org, 'skillFold has the org id again');
  await b.mirror.stop();
  assert.deepEqual(store.saved.get(S1).state.sources.transcripts.known, slice.known, 'the next index keeps the same ranges');
});

test('a known-value line that ends exactly at the resume point is re-read on a restart', async (t) => {
  const store = fakeStore();
  const a = setup(t, { store });
  const email = 'pat.edge-user@example.com';
  const r = a.records();
  closedTurn(r, 'ke-0');
  const ctx = added(r, () => r.sessionContext({ userEmail: email })); // the last line read
  a.ch.writeTranscript(S1, r.records);
  await a.mirror.start();
  a.sessionStart();
  await turnCount(a, 1);
  await a.mirror.stop();
  const index = store.saved.get(S1);
  const range = rangeOf(r.records, ctx);
  assert.equal(index.resume.offset, range[1], 'the resume point is the end of the known-value line');
  assert.deepEqual(index.state.sources.transcripts.known, [range]);

  const { b, ranges } = await restartWith(t, a, store);
  const n0 = r.records.length;
  closedTurn(r, 'ke-1', `mail ${email}`, `Mailed ${email}.`);
  b.ch.appendTranscript(S1, r.records.slice(n0));
  await turnCount(b, 2);
  assert.deepEqual(ranges().filter((x) => x.file === `${S1}.jsonl`).map((x) => [x.from, x.to]), [range], 'the line was re-read');
  const s = JSON.stringify([await b.ask('turns', S1, { items: 'full' }), b.frames]);
  assert.ok(s.includes('mail '), 'the prompt is there');
  assert.ok(!s.includes(email), 'the email is masked after the restart');
});

test('two accounts in one session: both emails are masked in text appended after a restart', async (t) => {
  const store = fakeStore();
  const a = setup(t, { store });
  const first = 'first.account@example.com';
  const second = 'second.account@example.org';
  const r = a.records();
  r.sessionContext({ userEmail: first });
  closedTurn(r, 'acc-1');
  r.sessionContext({ userEmail: second });
  closedTurn(r, 'acc-2');
  a.ch.writeTranscript(S1, r.records);
  await a.mirror.start();
  a.sessionStart();
  await turnCount(a, 2);
  await a.mirror.stop();
  assert.equal(store.saved.get(S1).state.sources.transcripts.known.length, 2, 'a range for each account');

  const { b, windows } = await restartWith(t, a, store);
  const n0 = r.records.length;
  closedTurn(r, 'acc-3', `forward ${first} to ${second}`, `Forwarded ${first} to ${second}.`);
  b.ch.appendTranscript(S1, r.records.slice(n0));
  await turnCount(b, 3);
  assert.deepEqual(windows, [], 'no walk');
  const s = JSON.stringify([await b.ask('turns', S1, { items: 'full' }), await b.ask('turn', 'acc-3'), b.frames]);
  assert.ok(s.includes('forward '), 'the prompt is there');
  assert.ok(!s.includes(first), 'the first account is masked');
  assert.ok(!s.includes(second), 'the second account is masked');
});

test('a slice without ranges (an older index) falls back to the walk once; the next restart reads ranges only', async (t) => {
  const store = fakeStore();
  const a = setup(t, { store });
  const email = 'pat.walked-user@example.com';
  const org = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const r = a.records();
  closedTurn(r, 'wk-1');
  const ctx = added(r, () => r.sessionContext({ userEmail: email }));
  const cred = added(r, () => r.credentialOrg(org));
  closedTurn(r, 'wk-2');
  a.ch.writeTranscript(S1, r.records);
  await a.mirror.start();
  a.sessionStart();
  await turnCount(a, 2);
  await a.mirror.stop();
  // An index written before SLICE_VERSION 2: no ranges.
  const old = store.saved.get(S1);
  const slice = old.state.sources.transcripts;
  slice.v = 1;
  delete slice.known;

  const one = await restartWith(t, a, store);
  await turnCount(one.b, 2);
  assert.ok(one.windows.some((c) => (c.from || 0) === 0), 'the walk read the prefix from 0');
  assert.deepEqual(one.ranges(), [], 'no range to read');
  const n0 = r.records.length;
  closedTurn(r, 'wk-3', `mail ${email} about ${org}`);
  one.b.ch.appendTranscript(S1, r.records.slice(n0));
  await turnCount(one.b, 3);
  const s = JSON.stringify([await one.b.ask('turn', 'wk-3'), one.b.frames]);
  assert.ok(!s.includes(email) && !s.includes(org), 'both values registered by the walk');
  await one.b.mirror.stop();
  const next = store.saved.get(S1).state.sources.transcripts;
  assert.equal(next.v, SLICE_VERSION);
  assert.deepEqual(next.known, [rangeOf(r.records, ctx), rangeOf(r.records, cred)], 'the walk recorded the ranges');

  const two = await restartWith(t, a, store);
  await turnCount(two.b, 3);
  assert.deepEqual(two.windows, [], 'the next restart does not walk');
  assert.deepEqual(two.ranges().map((x) => [x.from, x.to]), next.known, 'it reads the ranges only');
  assert.equal(two.b.mirror.skillFold(S1).orgUuid, org);
});

// U28b@restoreState-v1-slice: a slice written before SLICE_VERSION 2 still
// hands its normalizer and carrier states on. With a turn open at stop (and a
// task notification's first carrier pending) those states are the boundary's,
// which a resumed read cannot rebuild: were the v1 slice refused, the restart
// would read on from the boundary with a file-from-0 state.
test('a v1 slice keeps its norm and carriers across a restart with a turn open at the boundary', async (t) => {
  const store = fakeStore();
  const a = setup(t, { store });
  const r = a.records();
  closedTurn(r, 'v1-1');
  const text = require('../test-support/claude-records').taskNotificationText(NOTE);
  r.queueOperation('enqueue', { content: text }); // its delivery comes after the restart
  const k = r.records.length;
  r.prompt('prompt v1-2', { promptId: 'v1-2' });
  r.assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/b.txt' }, id: 'toolu_01V1Open' }]);
  a.ch.writeTranscript(S1, r.records);
  await a.mirror.start();
  a.sessionStart();
  await waitUntil(async () => {
    const p = await a.mirror.turns(S1, { limit: 100 });
    return p && p.total === 2 && p.turns[1].status === 'open';
  }, { timeout: 8000, what: 'v1-2 open' });
  await a.mirror.stop();
  const index = store.saved.get(S1);
  assert.equal(index.resume.offset, Buffer.byteLength(jsonl(r.records.slice(0, k))), 'the index resumes at the open turn\'s opener');
  // An index written before SLICE_VERSION 2: no ranges.
  const slice = index.state.sources.transcripts;
  slice.v = 1;
  delete slice.known;
  assert.ok(slice.norm.seq > 0 && slice.norm.turn === 'v1-1', 'the boundary\'s norm is not a file-from-0 state');
  assert.equal(slice.carriers.queue.length, 1, 'the notification\'s enqueue is pending at the boundary');
  const v1 = JSON.parse(JSON.stringify(index));

  // The restart re-reads the opener and the open call, so the boundary it
  // saves again is built from the restored states.
  const one = await restartWith(t, a, store, { windows: false });
  await waitUntil(async () => {
    const p = await one.b.mirror.turns(S1, { items: 'full', limit: 100 });
    return p && p.total === 2 && p.turns[1].status === 'open' && p.turns[1].items.some((it) => it.kind === 'tool_call');
  }, { timeout: 8000, what: 'v1-2 open again' });
  await one.b.mirror.stop();
  const next = store.saved.get(S1).state.sources.transcripts;
  assert.equal(next.v, SLICE_VERSION, 'the restarted mirror wrote its own slice');
  assert.deepEqual(next.norm, slice.norm, 'the v1 slice\'s norm survived the restart');
  assert.deepEqual(next.carriers, slice.carriers, 'and its carriers');

  // From the same v1 index, the turn then closes whole and the pending carrier
  // still makes one task item, numbered by its delivery record.
  store.saved.set(S1, v1);
  const two = await restartWith(t, a, store, { windows: false });
  const n0 = r.records.length;
  const delivery = r.taskNotification(NOTE);
  r.queuedCommand(text, { commandMode: 'task-notification' });
  r.toolResult('toolu_01V1Open', 'contents of b');
  r.assistant(['Read it.']);
  r.turnDuration({ durationMs: 30 });
  two.b.ch.appendTranscript(S1, r.records.slice(n0));
  const page = await turnCount(two.b, 2);
  assert.deepEqual(page.turns.map((x) => x.id), ['v1-1', 'v1-2']);
  const full = await two.b.turns();
  const turn2 = full.turns.find((x) => x.id === 'v1-2');
  assert.equal(turn2.items.find((it) => it.kind === 'prompt').seq, k + 1, 'the opener keeps its file ordinal');
  assert.equal(turn2.items.find((it) => it.kind === 'tool_call').status, 'done');
  const tasks = taskItems(full);
  assert.equal(tasks.length, 1, 'one task item for the carriers either side of the restart');
  assert.equal(tasks[0].seq, ordinalOf(r, delivery), 'its seq is its delivery record\'s file ordinal');
});

// U28b@scanKnown-cut-short: a walk of the prefix that stops after its first
// page has recorded the ranges of that page alone, which may miss a value — so
// the snapshot after it carries no `known`, and the next restart walks again.
test('a walk cut short after its first page leaves `known` out of the next slice; the next restart walks again', async (t) => {
  const store = fakeStore();
  const a = setup(t, { store });
  const email = 'pat.cut-user@example.com';
  const org = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';
  const r = a.records();
  const ctx = added(r, () => r.sessionContext({ userEmail: email })); // in the walk's first page
  for (let i = 0; i < 3; i++) closedTurn(r, `cut-${i}`, `prompt cut-${i}`, `${'x'.repeat(400 * 1024)} ${i}`);
  const cred = added(r, () => r.credentialOrg(org)); // past the first 1 MiB page
  closedTurn(r, 'cut-3');
  a.ch.writeTranscript(S1, r.records);
  assert.ok(rangeOf(r.records, cred)[0] > 1024 * 1024, 'the org line lies past the walk\'s first page');
  await a.mirror.start();
  a.sessionStart();
  await turnCount(a, 4);
  await a.mirror.stop();
  // An index written before SLICE_VERSION 2: no ranges, so the restart walks.
  const slice = store.saved.get(S1).state.sources.transcripts;
  const resumeAt = store.saved.get(S1).resume.offset;
  slice.v = 1;
  delete slice.known;

  // Every readWindow of the prefix after the walk's first page fails.
  const real = claudeFiles.readWindow;
  const walk = [];
  claudeFiles.readWindow = (file, opts) => {
    if (path.basename(String(file)) === `${S1}.jsonl` && ((opts && opts.from) || 0) < resumeAt) {
      walk.push({ ...opts });
      if (((opts && opts.from) || 0) > 0) throw new Error('EIO: the walk cut short');
    }
    return real(file, opts);
  };
  t.after(() => { claudeFiles.readWindow = real; });
  const one = await restartWith(t, a, store, { windows: false });
  claudeFiles.readWindow = real; // the new facade holds the failing wrap; nothing else does
  assert.ok(walk.length >= 2 && walk[0].from === 0 && walk[1].from > 0, 'the walk read its first page, then failed on the next');
  const n0 = r.records.length;
  closedTurn(r, 'cut-4'); // a record read after the walk, so the restarted mirror writes its own slice
  one.b.ch.appendTranscript(S1, r.records.slice(n0));
  await turnCount(one.b, 5);
  await one.b.mirror.stop();
  const next = store.saved.get(S1).state.sources.transcripts;
  assert.equal(next.v, SLICE_VERSION, 'the restarted mirror wrote its own slice');
  assert.ok(!('known' in next), 'a walk cut short hands on no ranges');

  // So the next restart walks again, all the way, and records both ranges.
  const two = await restartWith(t, a, store);
  assert.ok(two.windows.some((c) => (c.from || 0) === 0), 'the next restart walks from 0');
  const n1 = r.records.length;
  closedTurn(r, 'cut-5', `mail ${email} about ${org}`);
  two.b.ch.appendTranscript(S1, r.records.slice(n1));
  await turnCount(two.b, 6);
  const s = JSON.stringify([await two.b.ask('turn', 'cut-5'), two.b.frames]);
  assert.ok(!s.includes(email) && !s.includes(org), 'both values registered by the second walk');
  await two.b.mirror.stop();
  assert.deepEqual(store.saved.get(S1).state.sources.transcripts.known, [rangeOf(r.records, ctx), rangeOf(r.records, cred)],
    'the whole walk recorded both ranges');
});

test('at most KNOWN_RANGES_MAX ranges a session, the newest kept', async (t) => {
  const store = fakeStore();
  const h = setup(t, { store });
  const r = h.records();
  const recs = [];
  for (let i = 0; i < KNOWN_RANGES_MAX + 2; i++) recs.push(added(r, () => r.sessionContext({ userEmail: `user-${i}@example.com` })));
  closedTurn(r, 'many-1');
  h.ch.writeTranscript(S1, r.records);
  await h.mirror.start();
  h.sessionStart();
  await turnCount(h, 1);
  await h.mirror.stop();
  assert.equal(KNOWN_RANGES_MAX, 32);
  assert.deepEqual(store.saved.get(S1).state.sources.transcripts.known, recs.slice(-KNOWN_RANGES_MAX).map((x) => rangeOf(r.records, x)));
});
