// The turn machine's re-keys, announced in the change batch, and the provisional
// reply ids named (PLAN.md 3A.2; DECISIONS.md D3; GT-13's "turn anchors keep
// canonical ids and re-key on turn-machine re-key with the absorb() merge
// constructed" and "provisional items refused or aliased by the prefix rule with
// 1 candidate per id"; the carried condition C-13-1).
//
// Pinned, through a real facade (createMirror with every built-in SOURCE, the
// transcripts source on a short poll) over a temp project and a claude-home tier
// fed only claude-records transcripts and v1 hook envelopes, with a recording
// stub source (mirror.register) that keeps every onChanges batch:
//   (a) a hook prompt_id the transcript names otherwise, bound by order: one
//       {type: 'rekey', of: 'turn'} in the opener's own batch, after its changes;
//   (b) a bound alias (the hook after the transcript opened the turn): none;
//   (c) the "chain" recipe (an h_<ts> turn, a PreToolUse with a prompt_id, an
//       opener with a third id): ONE rekey — the PreToolUse's prompt_id is a soft
//       alias, which changes no id; two re-keys in one batch come in order;
//   (d) the absorb() merge constructed (V28): one rekey, items moved;
//   (e) F7 s4's six provisional cases and the turn_duration path: every id
//       isProvisional, one prefix-rule successor each, one {of: 'item'} rekey
//       per rh_ removal naming it, none for rm_;
//   (f) every built-in source handed a batch whose only change is a rekey
//       changes nothing (snapshot, stats and diagnostics equal);
//   (g) a restart keeps the replaces aliases: the old ids resolve to the same header;
//   (h) C-13-1: every o<h16> item id is recordKey(sid, {start}) of a record's
//       byte offset, never the seq form. The one production caller that hands
//       normalize() records is transcripts.js, whose parseLines and tailer set
//       `start` on every record; recordKey's seq branch is a bare unit call's.
//
// The F7 harness's recipes (design/annotation-engine-redesign/tests/F7) are
// rewritten here: a test never requires design/ (CI has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { withTempHome, waitUntil } = require('../test-support/helpers');
const { createRecords, jsonl } = require('../test-support/claude-records');
const { createRedactor } = require('../lib/core/redact');
const { createBus } = require('../lib/core/bus');
const { createHookTap } = require('../lib/server/hook-tap');
const { MOD_EVENT } = require('../lib/core/mod-protocol');
const { createMirror, SOURCES } = require('../lib/server/mirror');
const { createModel } = require('../lib/server/mirror/model');
const { recordKey } = require('../lib/server/mirror/normalize');
const { createTranscriptsSource, parseLines } = require('../lib/server/mirror/transcripts');
const { createIndexStore } = require('../lib/server/mirror/index-store');
const {
  createTurnMachine, isProvisional, PROVISIONAL_PREFIXES, OPENER_SKEW_MS,
} = require('../lib/server/mirror/turn-machine');

const S1 = '11111111-1111-4111-8111-111111111111';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function project(t) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-rekey-'));
  fs.mkdirSync(path.join(dir, '.web-chat'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Every built-in source, the transcripts source on a short poll.
const sourcesFor = () => SOURCES.map((s) => (s.name === 'transcripts'
  ? { name: 'transcripts', attach: createTranscriptsSource({ createStore: createIndexStore, pollMs: 40 }).attach }
  : s));

// A real facade with a recording stub source. `world` = {root, ch} boots again
// over an existing project and tier (a restart).
function boot(t, { world = null } = {}) {
  let root; let ch;
  // The facade's clock: the wall clock until a test holds it (h.hold).
  let held = null;
  if (world) ({ root, ch } = world);
  else { root = project(t); ch = claudeHome(t, { root, isolate: true }); }
  const hooks = createHookTap();
  const mirrorBus = createBus({ maxEvents: 5000 });
  const frames = [];
  mirrorBus.setBroadcaster((frame) => frames.push(frame));
  let mirror = createMirror({
    root, hooks, mainBus: createBus(), mirrorBus, redactor: createRedactor(), log: () => {},
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    isPidAlive: () => true,
    now: () => (held === null ? Date.now() : held),
    sources: sourcesFor(),
  });
  const batches = [];
  const rec = { engine: null };
  mirror.register('recorder', (engine) => {
    rec.engine = engine;
    return {
      start: async () => {}, stop: async () => {},
      onChanges(sid, changes, o) { batches.push({ sid, cid: o && o.conversation_id, changes: [...changes] }); },
    };
  });
  t.after(async () => { if (mirror) await mirror.stop(); });
  let ts = Date.now();
  const h = { root, ch, hooks, frames, batches, rec, world: { root, ch } };
  Object.defineProperty(h, 'mirror', { get: () => mirror });
  h.hold = () => { held = Date.now(); };
  h.stop = async () => { const m = mirror; mirror = null; if (m) await m.stop(); };
  h.tick = (n = 1) => { ts += n; return ts; };
  h.env = (event, extra = {}, sid = S1) => ({
    v: 1, event, ts: h.tick(), session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd,
    prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
    result: null, session: null, compact: null, stop: null, prompt: null, ask: null, ...extra,
  });
  h.publish = (event, extra, sid) => hooks.publish(h.env(event, extra, sid));
  h.prompt = (pid, text) => h.publish('UserPromptSubmit', { prompt_id: pid, prompt: { author: 'user', text } });
  h.mod = (kind, payload = {}) => hooks.publish({ v: 1, event: MOD_EVENT, synthetic: true, ts: h.tick(), session_id: S1, mod: { kind, ...payload } });
  h.records = (seed) => createRecords({ seed, sessionId: S1, cwd: ch.cwd, start: Date.now(), step: 10 });
  h.append = (records) => fs.appendFileSync(ch.transcript(S1), jsonl(records));
  h.page = () => mirror.turns(S1, { items: 'full', limit: 100 });
  h.resolve = async (id) => { const x = await mirror.turn(id); return x && x.turn ? x.turn.id : null; };
  h.rekeys = (from = 0) => batches.slice(from).flatMap((b) => b.changes.filter((c) => c.type === 'rekey'));
  h.turnRekeys = (from = 0) => h.rekeys(from).filter((c) => c.of === 'turn');
  // Started, the session known, its (empty) transcript followed.
  h.begin = async () => {
    await mirror.start();
    fs.writeFileSync(ch.transcript(S1), '');
    h.publish('SessionStart', { session: { source: 'startup' } });
    await waitUntil(() => frames.some((f) => f.type === 'mirror:reset' && f.conversation_id === S1), { timeout: 8000, what: 'the session followed' });
    await sleep(100);
  };
  return h;
}

const turnClosed = (h, id) => waitUntil(async () => {
  const x = await h.mirror.turn(id);
  return x && x.turn && x.turn.status !== 'open' ? x.turn : null;
}, { timeout: 8000, what: `turn ${id} closed` });

const turnRekey = (from, to) => ({ type: 'rekey', of: 'turn', from, to, conversation_id: S1 });

// ── provisional ids, named ──────────────────────────────────────────────────

test('isProvisional names the Stop hook\'s rh_ and mod-live\'s rm_ ids, and nothing else', () => {
  assert.deepEqual([...PROVISIONAL_PREFIXES], ['rh_', 'rm_']);
  assert.ok(Object.isFrozen(PROVISIONAL_PREFIXES));
  for (const id of ['rh_p5-a', 'rh_h_1792202168102', 'rm_p5-d_0', 'rm_p5-d_end', 'rm_p-two_0_0a1b2c3d']) assert.equal(isProvisional(id), true, id);
  for (const id of ['r_msg_01M5C', 'p_rh_x', 'rh_', 'rm_', 'th_o0123456789abcdef', 'toolu_01', '', null, undefined, 42]) {
    assert.equal(isProvisional(id), false, String(id));
  }
});

// ── the pure machine: where the re-keys go in the batch ─────────────────────

function pureHarness(start = 200000) {
  const model = createModel({ redactor: { text: (s) => s, value: (v) => v } });
  let clock = start;
  const tm = createTurnMachine({ model, now: () => clock });
  const hook = (event, fields = {}) => { clock += 1; return tm.ingest('c1', { v: 1, event, ts: clock, session_id: 's1', prompt_id: null, ...fields }); };
  return { model, tm, hook };
}
const op = (pid, uuid, parent, text, ts) => ({ type: 'opener', prompt_id: pid, uuid, parent_uuid: parent, kind: 'prompt', text, ts });

test('the machine appends its re-keys after the batch\'s own changes, in order, and skips one handed back', () => {
  const h = pureHarness();
  h.hook('UserPromptSubmit', { prompt_id: 'hA', prompt: { author: 'user', text: 'one' } });
  h.hook('Stop', { prompt_id: 'hA' });
  h.hook('UserPromptSubmit', { prompt_id: 'hB', prompt: { author: 'user', text: 'two' } });
  const own = [op('tA', 'uA', null, 'one', 200001), { type: 'turn-duration', uuid: 'uA2', parent_uuid: 'uA', duration_ms: 5 },
    op('tB', 'uB', 'uA2', 'two', 200003)];
  const batch = [...own];
  const r = h.tm.applyChanges('c1', 's1', batch);
  assert.equal(r.applied, 3);
  assert.deepEqual(batch.slice(0, 3), own, 'the batch\'s own changes first, untouched');
  assert.deepEqual(batch.slice(3), [
    { type: 'rekey', of: 'turn', from: 'hA', to: 'tA', conversation_id: 'c1' },
    { type: 'rekey', of: 'turn', from: 'hB', to: 'tB', conversation_id: 'c1' },
  ], 'one per re-key, in the order they happened');
  // Handed back (a source re-applying the batch): skipped, neither applied nor unknown.
  const before = h.tm.diagnostics();
  const again = h.tm.applyChanges('c1', 's1', [batch[3]]);
  assert.deepEqual(again, { ok: true, applied: 0 });
  assert.deepEqual(h.tm.diagnostics(), before);
  // A frozen batch is never written to (and the machine does not throw).
  const g = pureHarness();
  g.hook('UserPromptSubmit', { prompt_id: 'hC', prompt: { author: 'user', text: 'three' } });
  const frozen = Object.freeze([op('tC', 'uC', null, 'three', 200001)]);
  assert.deepEqual(g.tm.applyChanges('c1', 's1', frozen), { ok: true, applied: 1 });
  assert.equal(g.tm.resolve('hC'), 'tC');
});

test('the machine: a merge (absorb) is announced once; the rh_ successor waits for the reply whose text it holds', () => {
  const h = pureHarness();
  h.hook('PreToolUse', { prompt_id: 'H3', tool: { name: 'Bash', use_id: 'toolu_live' } });
  h.hook('PreToolUse', { prompt_id: 'H3', tool: { name: 'Read', use_id: 'toolu_next' } });
  h.hook('Stop', { prompt_id: 'H3', stop: { last_assistant_message: 'Done: B.' } });
  const b1 = [op('P3', 'u3a', null, 'run', 200001 - OPENER_SKEW_MS - 50000)];
  h.tm.applyChanges('c1', 's1', b1);
  assert.equal(b1.filter((c) => c.type === 'rekey').length, 0, 'no id changed yet: the opener opened a turn of its own');
  const b2 = [{ type: 'item', uuid: 'u3b', parent_uuid: 'u3a', item: { id: 'toolu_live', kind: 'tool_call', tool: 'Bash', status: 'done' } }];
  h.tm.applyChanges('c1', 's1', b2);
  assert.deepEqual(b2.slice(1), [{ type: 'rekey', of: 'turn', from: 'H3', to: 'P3', conversation_id: 'c1' }]);
  assert.equal(h.tm.resolve('H3'), 'P3');
  assert.equal(h.model.item('toolu_next').turn_id, 'P3');
  assert.ok(h.model.item('rh_P3'), 'the Stop\'s provisional reply moved over with the merge');
  // The first transcript reply removes rh_; it is not its successor (other text), so nothing yet.
  const b3 = [{ type: 'item', uuid: 'u3c', parent_uuid: 'u3b', item: { id: 'r_msg_1', kind: 'reply', text: 'Let me check.' } }];
  h.tm.applyChanges('c1', 's1', b3);
  assert.equal(h.model.item('rh_P3'), null);
  assert.equal(b3.length, 1);
  const b4 = [{ type: 'item', uuid: 'u3d', parent_uuid: 'u3c', item: { id: 'r_msg_2', kind: 'reply', text: 'Done: B.' } },
    { type: 'turn-duration', uuid: 'u3e', parent_uuid: 'u3d', duration_ms: 9 }];
  h.tm.applyChanges('c1', 's1', b4);
  assert.deepEqual(b4.slice(2), [{ type: 'rekey', of: 'item', from: 'rh_P3', to: 'r_msg_2', conversation_id: 'c1' }]);
});

// ── through the facade ───────────────────────────────────────────────────────

test('(a) a hook prompt_id bound by order to the transcript\'s: one turn rekey, in the opener\'s own batch, after its changes', async (t) => {
  withTempHome(t);
  const h = boot(t);
  await h.begin();
  h.prompt('hook-a', 'turn a');
  await waitUntil(() => h.resolve('hook-a'), { timeout: 8000, what: 'the hook turn' });
  const mark = h.batches.length;
  const r = h.records(11);
  r.prompt('turn a', { promptId: 'rec-a' });
  r.assistant(['reply a']);
  r.turnDuration({ durationMs: 40 });
  h.append(r.records);
  await turnClosed(h, 'rec-a');
  h.publish('Stop', { prompt_id: 'hook-a', stop: { last_assistant_message: 'reply a' } });
  await sleep(150);
  assert.deepEqual(h.rekeys(mark), [turnRekey('hook-a', 'rec-a')], 'exactly one rekey');
  const b = h.batches.slice(mark).find((x) => x.changes.some((c) => c.type === 'rekey'));
  assert.equal(b.cid, S1);
  assert.ok(b.changes.some((c) => c.type === 'opener' && c.prompt_id === 'rec-a'), 'in the batch of the opener that caused it');
  const at = b.changes.findIndex((c) => c.type === 'rekey');
  assert.ok(b.changes.slice(at).every((c) => c.type === 'rekey'), 'at the end of the batch');
  assert.equal(await h.resolve('hook-a'), 'rec-a');
  assert.equal(h.frames.some((f) => JSON.stringify(f).includes('"rekey"')), false, 'never a frame');
});

test('(b) a bound alias (the hook after the transcript opened its turn) re-keys nothing; the hook id resolves', async (t) => {
  withTempHome(t);
  const h = boot(t);
  await h.begin();
  const mark = h.batches.length;
  const r = h.records(12);
  r.prompt('turn b', { promptId: 'rec-b' });
  h.append(r.records);
  await waitUntil(async () => { const x = await h.mirror.turn('rec-b'); return x && x.turn && x.turn.status === 'open'; }, { timeout: 8000, what: 'turn b open' });
  h.prompt('hook-b', 'turn b');
  await sleep(60);
  const n = r.records.length;
  r.assistant(['reply b']);
  r.turnDuration({ durationMs: 40 });
  h.append(r.records.slice(n));
  h.publish('Stop', { prompt_id: 'hook-b', stop: { last_assistant_message: 'reply b' } });
  await turnClosed(h, 'rec-b');
  await sleep(150);
  assert.deepEqual(h.turnRekeys(mark), [], 'no turn id changed: nothing announced');
  // The Stop beat the tailer to the reply: its provisional reply came and went, named once.
  for (const c of h.rekeys(mark)) assert.equal(c.from, 'rh_rec-b');
  assert.equal(await h.resolve('hook-b'), 'rec-b');
});

test('(c) the chain recipe re-keys once (the PreToolUse\'s prompt_id is a soft alias); two re-keys in one batch come in order', async (t) => {
  withTempHome(t);
  const h = boot(t);
  await h.begin();
  h.hooks.publish(h.env('UserPromptSubmit', { prompt_id: null, prompt: { author: 'user', text: 'turn c' } }));
  const hts = await waitUntil(async () => {
    const p = await h.page();
    const x = p && p.turns.find((tt) => /^h_\d+$/.test(tt.id));
    return x ? x.id : null;
  }, { timeout: 8000, what: 'the h_<ts> turn' });
  const tool = { use_id: 'toolu_01ChainTwo', name: 'Read', input: { file_path: '/tmp/project/z.md' } };
  h.publish('PreToolUse', { tool, prompt_id: 'rk-hook-c' });
  await sleep(60);
  assert.equal(await h.resolve(hts), hts, 'the PreToolUse changed no id');
  const mark = h.batches.length;
  const r = h.records(13);
  r.prompt('turn c', { promptId: 'rk-tx-c' });
  r.assistant([{ type: 'tool_use', name: 'Read', input: tool.input, id: tool.use_id }]);
  r.toolResult(tool.use_id, 'z');
  r.assistant(['reply c']);
  r.turnDuration({ durationMs: 40 });
  h.append(r.records);
  h.publish('PostToolUse', { tool, prompt_id: 'rk-hook-c', result: { ok: true, duration_ms: 3 } });
  h.publish('Stop', { prompt_id: 'rk-hook-c', stop: { last_assistant_message: 'reply c' } });
  await turnClosed(h, 'rk-tx-c');
  await sleep(150);
  assert.deepEqual(h.turnRekeys(mark), [turnRekey(hts, 'rk-tx-c')], 'one turn rekey: the soft alias is never announced');
  assert.equal(h.rekeys(mark).some((c) => c.from === 'rk-hook-c' || c.to === 'rk-hook-c'), false);
  assert.equal(await h.resolve(hts), 'rk-tx-c', 'the h_<ts> id resolves to the last');
  assert.equal(h.mirror.snapshot({}).conversations[0].id, S1);

  // Two hook turns bound by order in one batch: two rekeys, in the order they happened.
  h.prompt('hx', 'turn x');
  await waitUntil(() => h.resolve('hx'), { timeout: 8000, what: 'hx' });
  h.publish('Stop', { prompt_id: 'hx', stop: { last_assistant_message: 'reply x' } });
  h.prompt('hy', 'turn y');
  await waitUntil(() => h.resolve('hy'), { timeout: 8000, what: 'hy' });
  const mark2 = h.batches.length;
  const n = r.records.length;
  r.prompt('turn x', { promptId: 'rec-x' });
  r.assistant(['reply x']);
  r.turnDuration({ durationMs: 40 });
  r.prompt('turn y', { promptId: 'rec-y' });
  h.append(r.records.slice(n));
  await waitUntil(() => h.resolve('rec-y'), { timeout: 8000, what: 'rec-y' });
  await sleep(150);
  assert.deepEqual(h.turnRekeys(mark2), [turnRekey('hx', 'rec-x'), turnRekey('hy', 'rec-y')], 'in the order they happened');
  for (const b of h.batches.slice(mark2).filter((x) => x.changes.some((c) => c.type === 'rekey'))) {
    const first = b.changes.findIndex((c) => c.type === 'rekey');
    assert.ok(b.changes.slice(first).every((c) => c.type === 'rekey'), 'at the end of their batch');
  }
});

// The absorb() merge (V28), constructed: a PreToolUse with no turn open opens an
// h_ turn; an opener more than OPENER_SKEW_MS older opens a transcript turn of
// its own; the transcript places the hook turn's tool call in it.
async function absorbWorld(t) {
  const h = boot(t);
  await h.begin();
  const tool = { use_id: 'toolu_01AbsorbMe', name: 'Read', input: { file_path: '/tmp/project/x.md' } };
  const other = { use_id: 'toolu_01AlsoMine', name: 'Bash', input: { command: 'ls' } };
  h.hooks.publish(h.env('PreToolUse', { tool, prompt_id: null }));
  const hid = await waitUntil(async () => {
    const p = await h.page();
    const x = p && p.turns.find((tt) => /^h_\d+$/.test(tt.id));
    return x ? x.id : null;
  }, { timeout: 8000, what: 'the mid-turn hook turn' });
  h.hooks.publish(h.env('PreToolUse', { tool: other, prompt_id: null }));
  await sleep(60);
  const mark = h.batches.length;
  const r = h.records(14);
  r.at(Date.now() - OPENER_SKEW_MS - 20000);
  r.prompt('turn d', { promptId: 'rec-d' });
  r.assistant([{ type: 'tool_use', name: 'Read', input: tool.input, id: tool.use_id }]);
  h.append(r.records);
  await waitUntil(async () => (await h.resolve(hid)) === 'rec-d', { timeout: 8000, what: 'the merge' });
  return { h, r, hid, mark, tool, other };
}

test('(d) the absorb() merge, constructed: the hook turn\'s id resolves to the transcript\'s, its items moved, one rekey heard', async (t) => {
  withTempHome(t);
  const { h, hid, mark, other } = await absorbWorld(t);
  await sleep(150);
  assert.deepEqual(h.rekeys(mark), [turnRekey(hid, 'rec-d')], 'exactly one rekey');
  const turn = await h.mirror.turn(hid);
  assert.equal(turn.turn.id, 'rec-d');
  assert.equal(turn.turn.replaces, hid);
  const p = await h.page();
  assert.equal(p.turns.some((x) => x.id === hid), false, 'the hook\'s turn is gone');
  const items = p.turns.find((x) => x.id === 'rec-d').items.map((it) => it.id);
  assert.ok(items.includes(other.use_id), 'the hook turn\'s other call moved with it');
});

// ── (e) the six provisional cases, and the turn_duration path ────────────────

test('(e) every provisional id has one prefix-rule successor; each rh_ removal names it in one item rekey; rm_ is never announced', async (t) => {
  withTempHome(t);
  const h = boot(t);
  await h.begin();
  const provisional = new Map(); // id → {turn, text}
  const stops = new Map(); // turn → the Stop's last_assistant_message
  const stopOf = (pid, text) => { stops.set(pid, text); h.publish('Stop', { prompt_id: pid, stop: { last_assistant_message: text } }); };
  const capture = async () => {
    const p = await h.page();
    for (const tt of (p && p.turns) || []) for (const it of tt.items || []) {
      if (it.kind === 'reply' && isProvisional(it.id)) provisional.set(it.id, { turn: it.turn_id || tt.id, text: it.text });
    }
  };
  const step = (tid, index, delta, messageId = null) => h.mod('turn.step', { turn_id: tid, index, ...(messageId ? { message_id: messageId } : {}), delta });
  const r = h.records(51);
  let n = 0;
  const land = () => { h.append(r.records.slice(n)); n = r.records.length; };
  const seen = (pred, what) => waitUntil(async () => { await capture(); return pred(); }, { timeout: 8000, what });

  // A. Stop before the transcript, one reply (the :694 path).
  h.prompt('p5-a', 'question a'); await sleep(80);
  stopOf('p5-a', 'Answer A.');
  await seen(() => provisional.has('rh_p5-a'), 'rh_p5-a');
  r.prompt('question a', { promptId: 'p5-a' }); r.assistant(['Answer A.']); r.turnDuration({ durationMs: 30 });
  land(); await turnClosed(h, 'p5-a');

  // B. Stop before the transcript, two assistant messages (the first is not the successor).
  h.prompt('p5-b', 'question b'); await sleep(80);
  stopOf('p5-b', 'Done: B.');
  await seen(() => provisional.has('rh_p5-b'), 'rh_p5-b');
  r.prompt('question b', { promptId: 'p5-b' });
  r.assistant(['Let me check.', { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/b.md' }, id: 'toolu_01M5B' }]);
  r.toolResult('toolu_01M5B', 'b');
  r.assistant(['Done: B.']);
  r.turnDuration({ durationMs: 30 });
  land(); await turnClosed(h, 'p5-b');

  // C. Stop before the transcript, a final message of two text blocks.
  h.prompt('p5-c', 'question c'); await sleep(80);
  stopOf('p5-c', 'Part one.\n\nPart two.');
  await seen(() => provisional.has('rh_p5-c'), 'rh_p5-c');
  r.prompt('question c', { promptId: 'p5-c' }); r.assistant(['Part one.', 'Part two.'], { messageId: 'msg_01M5C' }); r.turnDuration({ durationMs: 30 });
  land(); await turnClosed(h, 'p5-c');

  // D. A mod stream without message ids: rm_<turn>_0, rm_<turn>_1.
  h.prompt('p5-d', 'question d'); await sleep(80);
  h.mod('turn.start', { turn_id: 'mt-d' });
  step('mt-d', 0, 'Let me '); step('mt-d', 0, 'look.');
  step('mt-d', 1, 'The answer '); step('mt-d', 1, 'is 42.');
  await seen(() => provisional.has('rm_p5-d_1') && provisional.get('rm_p5-d_1').text === 'The answer is 42.', 'rm_p5-d_1');
  r.prompt('question d', { promptId: 'p5-d' });
  r.assistant(['Let me look.', { type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 'toolu_01M5D' }]);
  r.toolResult('toolu_01M5D', 'x');
  r.assistant(['The answer is 42.']);
  r.turnDuration({ durationMs: 30 });
  h.mod('turn.complete', { turn_id: 'mt-d' });
  land();
  stopOf('p5-d', 'The answer is 42.');
  await turnClosed(h, 'p5-d');

  // E. A mod stream that learns its message id mid-way.
  h.prompt('p5-e', 'question e'); await sleep(80);
  h.mod('turn.start', { turn_id: 'mt-e' });
  step('mt-e', 0, 'Streaming ');
  await seen(() => provisional.has('rm_p5-e_0'), 'rm_p5-e_0');
  step('mt-e', 0, 'then named.', 'msg_01M5E'); await sleep(150); await capture();
  r.prompt('question e', { promptId: 'p5-e' }); r.assistant(['Streaming then named.'], { messageId: 'msg_01M5E' }); r.turnDuration({ durationMs: 30 });
  h.mod('turn.complete', { turn_id: 'mt-e' });
  land();
  stopOf('p5-e', 'Streaming then named.');
  await turnClosed(h, 'p5-e');

  // F. turn.complete with no reply item: rm_<turn>_end.
  h.prompt('p5-f', 'question f'); await sleep(80);
  h.mod('turn.start', { turn_id: 'mt-f' });
  h.mod('turn.complete', { turn_id: 'mt-f', text: 'Only at the end.' });
  await seen(() => provisional.has('rm_p5-f_end'), 'rm_p5-f_end');
  r.prompt('question f', { promptId: 'p5-f' }); r.assistant(['Only at the end.']); r.turnDuration({ durationMs: 30 });
  land();
  stopOf('p5-f', 'Only at the end.');
  await turnClosed(h, 'p5-f');

  // G. The turn_duration path (:726): the final reply is on disk, an artifact after
  // it, when the Stop's provisional reply is made; turn_duration removes it.
  r.prompt('question g', { promptId: 'p5-g' }); r.assistant(['Final g.']);
  r.frameLink({ title: 'After the reply', frameUrl: 'https://example.org/g' });
  land();
  await waitUntil(async () => { const x = await h.page(); const tt = x && x.turns.find((y) => y.id === 'p5-g'); return tt && tt.items.some((it) => it.kind === 'artifact'); }, { timeout: 8000, what: 'turn g\'s artifact' });
  const markG = h.batches.length;
  stopOf('p5-g', 'Final g.');
  await seen(() => provisional.has('rh_p5-g'), 'rh_p5-g');
  r.turnDuration({ durationMs: 30 });
  land();
  await waitUntil(async () => { const x = await h.page(); const tt = x && x.turns.find((y) => y.id === 'p5-g'); return tt && !tt.items.some((it) => it.id === 'rh_p5-g'); }, { timeout: 8000, what: 'rh_p5-g removed' });
  await sleep(300);

  const want = ['rh_p5-a', 'rh_p5-b', 'rh_p5-c', 'rm_p5-d_0', 'rm_p5-d_1', 'rm_p5-e_0', 'rm_p5-f_end', 'rh_p5-g'];
  assert.deepEqual([...provisional.keys()].sort(), [...want].sort(), 'every case captured its provisional ids');
  const page = await h.page();
  const sameReply = (a, b) => a && b && (a === b || a.startsWith(b) || b.startsWith(a));
  const item = h.rekeys().filter((c) => c.of === 'item');
  for (const [id, e] of provisional) {
    assert.equal(isProvisional(id), true, id);
    const tt = page.turns.find((x) => x.id === e.turn);
    assert.ok(tt, `${id}'s turn ${e.turn}`);
    assert.equal(tt.items.some((it) => it.id === id), false, `${id} gone once the transcript landed`);
    const finals = tt.items.filter((it) => it.kind === 'reply' && !isProvisional(it.id));
    const cands = finals.filter((it) => sameReply(e.text, it.text));
    assert.equal(cands.length, 1, `${id}: one candidate by the prefix rule (${finals.length} transcript replies)`);
    const heard = item.filter((c) => c.from === id);
    if (id.startsWith('rh_')) {
      assert.deepEqual(heard, [{ type: 'rekey', of: 'item', from: id, to: cands[0].id, conversation_id: S1 }], `${id}: one item rekey naming its successor`);
    } else {
      assert.deepEqual(heard, [], `${id}: an rm_ removal is not announced`);
    }
  }
  // Every item rekey is an rh_ removal (the Stop also beat the tailer in D, E and
  // F), one per id, naming the turn's transcript reply that holds the Stop's text.
  assert.equal(item.length, new Set(item.map((c) => c.from)).size, 'one per removed rh_');
  for (const c of item) {
    assert.ok(c.from.startsWith('rh_'), c.from);
    const tt = page.turns.find((x) => `rh_${x.id}` === c.from);
    const to = tt.items.find((it) => it.id === c.to);
    assert.ok(to && to.kind === 'reply' && !isProvisional(to.id), `${c.from} names a transcript reply of its turn`);
    assert.ok(sameReply(stops.get(tt.id), to.text), `${c.from}: the reply holding the Stop's text`);
  }
  assert.ok(item.length >= 4, 'at least the four captured rh_ removals');
  const g = h.batches.slice(markG).find((b) => b.changes.some((c) => c.type === 'rekey' && c.from === 'rh_p5-g'));
  assert.ok(g.changes.some((c) => c.type === 'turn-duration'), 'the :726 path: announced in the turn_duration\'s batch');
});

// ── (f) a batch carrying only a rekey changes no source ──────────────────────

const view = (h) => ({ snap: h.mirror.snapshot({}), stats: h.mirror.stats(), summary: h.mirror.summary() });

// A rekey-only batch never occurs (the machine appends a re-key to the batch whose
// change made it), so the comparison is the batch without it: an empty batch,
// which live.js reads as a transcript append like any batch. The facade's clock
// is held so that append's time is the same both times.
test('(f) every built-in source handed a batch whose only change is a rekey changes nothing a batch without it does not', async (t) => {
  withTempHome(t);
  const { h } = await absorbWorld(t);
  const r = h.records(15);
  r.prompt('one more', { promptId: 'rec-e' }); r.assistant(['reply e']); r.turnDuration({ durationMs: 40 });
  h.append(r.records);
  await turnClosed(h, 'rec-e');
  await sleep(400);
  h.hold();
  const heard = h.batches.length;
  assert.deepEqual(h.rec.engine.applyChanges(S1, [], { conversation_id: S1 }), { ok: true, applied: 0 });
  await sleep(300);
  const before = view(h);
  for (const ch of [turnRekey('nobody', 'rec-e'), { type: 'rekey', of: 'item', from: 'rh_rec-e', to: 'r_x', conversation_id: S1 }]) {
    assert.deepEqual(h.rec.engine.applyChanges(S1, [ch], { conversation_id: S1 }), { ok: true, applied: 0 });
  }
  await sleep(400);
  assert.equal(h.batches.length, heard, 'the recorder is the origin: it hears its own batches from no one');
  const after = view(h);
  assert.deepEqual(after.snap.diagnostics, before.snap.diagnostics, 'every source\'s diagnostics, and the turn machine\'s');
  assert.deepEqual(after, before, 'snapshot (rev included), stats and summary');
  assert.equal(await h.resolve('nobody'), null, 'a rekey handed in makes no alias');
});

// ── (g) a restart keeps the replaces aliases ─────────────────────────────────

test('(g) after a restart a re-keyed turn\'s old id resolves to the same header (an alias and a merge)', async (t) => {
  withTempHome(t);
  const { h, r, hid } = await absorbWorld(t);
  const n = r.records.length;
  r.toolResult('toolu_01AbsorbMe', 'x');
  r.assistant(['reply d']);
  r.turnDuration({ durationMs: 40 });
  h.append(r.records.slice(n));
  await turnClosed(h, 'rec-d');
  h.prompt('hook-z', 'turn z');
  await waitUntil(() => h.resolve('hook-z'), { timeout: 8000, what: 'hook-z' });
  const m = r.records.length;
  r.at(Date.now());
  r.prompt('turn z', { promptId: 'rec-z' }); r.assistant(['reply z']); r.turnDuration({ durationMs: 40 });
  h.append(r.records.slice(m));
  await turnClosed(h, 'rec-z');
  await sleep(200);
  assert.deepEqual(h.rekeys().map((c) => [c.from, c.to]), [[hid, 'rec-d'], ['hook-z', 'rec-z']]);
  const pick = (x) => ({ id: x.id, replaces: x.replaces, seq: x.seq, status: x.status, started_at: x.started_at, session_id: x.session_id });
  const before = {};
  for (const id of [hid, 'hook-z']) before[id] = pick((await h.mirror.turn(id)).turn);
  await h.stop();

  const b = boot(t, { world: h.world });
  await b.mirror.start();
  b.publish('SessionStart', { session: { source: 'resume' } });
  await waitUntil(async () => { const p = await b.page(); return p && p.total >= 2 ? p : null; }, { timeout: 8000, what: 'the restored turns' });
  for (const id of [hid, 'hook-z']) {
    const x = await b.mirror.turn(id);
    assert.ok(x && x.turn, `${id} resolves after the restart`);
    assert.deepEqual(pick(x.turn), before[id], `${id}: the same header`);
  }
  assert.deepEqual(b.rekeys(), [], 'a restore announces nothing');
});

// ── (h) C-13-1: the record key is the byte offset's ──────────────────────────

test('(h) C-13-1: every o<h16> item id from an ingested session is recordKey(sid, {start}) of a record\'s offset, never the seq form', async (t) => {
  withTempHome(t);
  const h = boot(t);
  await h.begin();
  const r = h.records(16);
  const at = new Date().toISOString();
  r.prompt('plan', { promptId: 'c13-1' });
  r.assistant([{ type: 'thinking', thinking: 'considering' }, 'First block.']);
  r.meta('assistant', { timestamp: at, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'bare thought' }, { type: 'text', text: 'bare reply' }] } });
  r.meta('system', { timestamp: at, subtype: 'informational', content: 'A bare notice.', level: 'info' });
  r.frameLink({ title: 'Artifact one', frameUrl: 'https://example.org/a' });
  r.frameLink({ title: 'Artifact two', frameUrl: 'https://example.org/b' });
  r.bashMode('ls');
  r.meta('user', { timestamp: at, message: { role: 'user', content: '<bash-stdout>bare out</bash-stdout><bash-stderr></bash-stderr>' } });
  r.turnDuration({ durationMs: 50 });
  h.append(r.records);
  await waitUntil(async () => { const p = await h.page(); return p && p.total >= 2 && p.turns.every((x) => x.status !== 'open') ? p : null; }, { timeout: 8000, what: 'the session ingested' });
  await sleep(200);
  const ids = (await h.page()).turns.flatMap((x) => x.items.map((it) => it.id));
  const keyed = ids.map((id) => [id, /(?:^|_)o([0-9a-f]{16})$/.exec(id)]).filter(([, m]) => m);
  assert.ok(keyed.length >= 3, `record-keyed ids seen (${keyed.map(([id]) => id).join(', ')})`);
  const lines = parseLines(jsonl(r.records), 0);
  const byOffset = new Set(lines.map((x) => recordKey(S1, { start: x.start })));
  const bySeq = new Set();
  for (let seq = 0; seq < lines.length * 4 + 16; seq++) bySeq.add(recordKey(S1, {}, seq));
  for (const [id, m] of keyed) {
    assert.ok(byOffset.has(m[1]), `${id}: the key of a record's byte offset`);
    assert.equal(bySeq.has(m[1]), false, `${id}: never the seq form`);
  }
});
