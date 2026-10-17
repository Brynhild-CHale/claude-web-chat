// Chat-mirror item ids from transcript identity (PLAN.md 1D.1; GT-13's clause
// "0 anchorable items carry seq- or counter-derived ids … merge collision 0/26").
//
// Pinned:
//   * the census: no item id template in normalize.js, turn-machine.js or
//     mod-live.js is built from a file ordinal (`seq`, an `s` infix, the old
//     `s${seq}` message-id fallback) or a process counter (`${++…}`);
//   * one rich synthetic transcript normalized from 0 in one batch, split at a
//     turn boundary and resumed from the carried (persisted) state, and split at
//     7 random places gives the same item ids (Jaccard 1);
//   * the session id separates the record-key ids (n_o, r_o / th_o, lo_o, af_o)
//     of byte-identical records, and leaves every uuid-derived id alone;
//   * two sessions of one conversation (a /clear), each with uuid-less frame-link
//     artifacts and a uuid-less notice at the same byte offsets, through the
//     transcripts source: every item kept (26/26 on the F7 s2-shaped fixture), 0
//     duplicate ids, model merge_duplicates 0;
//   * a provisional turn merged into the transcript turn that holds the same
//     records: one item each, merge_duplicates counts the one the merge dropped;
//   * mod-live: two mod turns bound to one turn writing step 0 give rm_<tid>_0
//     and rm_<tid>_0_<h8>, the same after a restart (a fresh source);
//   * the model's id grammar admits every new form.
//
// The census logic and the merge recipe are the F7 harness's
// (design/annotation-engine-redesign/tests/F7/s2-items.js), rewritten here: a
// test never requires design/ (CI has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { withTempHome, waitUntil } = require('../test-support/helpers');
const { createRecords, jsonl, taskNotificationText } = require('../test-support/claude-records');
const { mulberry32 } = require('../test-support/fake-secrets');
const { createRedactor } = require('../lib/core/redact');
const { createBus } = require('../lib/core/bus');
const { stableHash } = require('../lib/core/stable-json');
const { createHookTap } = require('../lib/server/hook-tap');
const { MOD_EVENT } = require('../lib/core/mod-protocol');
const { createMirror, SOURCES } = require('../lib/server/mirror');
const { createModel } = require('../lib/server/mirror/model');
const { initialState, normalize, recordKey } = require('../lib/server/mirror/normalize');
const { createTranscriptsSource, parseLines } = require('../lib/server/mirror/transcripts');
const { createIndexStore } = require('../lib/server/mirror/index-store');
const { createModLiveSource } = require('../lib/server/mirror/mod-live');

const REPO = path.resolve(__dirname, '..');
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const PID = 4242;

// ── the census ───────────────────────────────────────────────────────────────

const CENSUS_FILES = ['normalize.js', 'turn-machine.js', 'mod-live.js'];

function census() {
  const seqTemplates = [];
  const counterTemplates = [];
  const seqFallbacks = [];
  const templates = [];
  for (const f of CENSUS_FILES) {
    const lines = fs.readFileSync(path.join(REPO, 'lib/server/mirror', f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const at = `${f}:${i + 1}`;
      // F7 s2's template regex: `<prefix>_[s]${expr}[_${expr}]`.
      const re = /`([a-z]{1,4})_(s?)\$\{([^}]+)\}(?:_\$\{([^}]+)\})?`/g;
      let m;
      while ((m = re.exec(line))) {
        templates.push(`${at} ${m[0]}`);
        const exprs = [m[3], m[4]].filter(Boolean).map((x) => x.trim());
        if (m[2] === 's' || exprs.some((x) => /^(st\.)?seq$/.test(x))) seqTemplates.push(`${at} ${m[0]}`);
      }
      // Stronger than s2's: any interpolated ordinal, and any counter suffix.
      if (/\$\{(?:st\.)?seq\}/.test(line)) seqTemplates.push(`${at} ${line.trim()}`);
      if (/\$\{\s*\+\+/.test(line)) counterTemplates.push(`${at} ${line.trim()}`);
      if (/`s\$\{seq\}`/.test(line)) seqFallbacks.push(`${at} ${line.trim()}`);
    });
  }
  return { templates, seqTemplates, counterTemplates, seqFallbacks };
}

test('the census: no item id template is built from a file ordinal or a process counter', () => {
  const c = census();
  assert.ok(c.templates.length >= 5, `the census sees the id templates (${c.templates.length})`);
  assert.deepEqual(c.seqTemplates, [], 'seq_templates: 0');
  assert.deepEqual(c.counterTemplates, [], 'counter_templates: 0');
  assert.deepEqual(c.seqFallbacks, [], 'no s${seq} message-id fallback');
});

// ── the rich transcript, normalized ──────────────────────────────────────────

// A record with no uuid, of any kind (a metadata line, or a chain kind written
// without one): carries only its own keys, as r.meta writes them.
const bare = (r, type, fields) => r.meta(type, { timestamp: new Date(Date.UTC(2026, 9, 4, 12)).toISOString(), ...fields });

// Every id form: before the first opener (no turn) a uuid-less "Attached:"
// notice and bash local outputs with and without a uuid; then replies with a
// message id, with only a uuid, with neither; a uuid-less api-error; frame-link
// artifacts with and without a uuid; a local command's output; a task
// notification; a uuid-less notice inside a turn.
function richTranscript(sid, seed) {
  const r = createRecords({ seed, sessionId: sid, cwd: '/tmp/project', step: 10 });
  bare(r, 'attachment', { attachment: { type: 'file', filename: '/tmp/project/early.md' } });
  r.bashOutput('early out\n', '');
  bare(r, 'user', { message: { role: 'user', content: '<bash-stdout>bare out</bash-stdout><bash-stderr></bash-stderr>' } });
  r.prompt('plan the work', { promptId: `${seed}-1` });
  r.assistant([{ type: 'thinking', thinking: 'considering' }, 'First block.', { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/a.md' } }]);
  const tu = r.records[r.records.length - 1].message.content[0].id;
  r.toolResult(tu, 'file a');
  r.assistant(['no message id'], { extra: { message: { role: 'assistant', type: 'message', content: [{ type: 'text', text: 'no message id' }], stop_reason: 'end_turn' } } });
  bare(r, 'assistant', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'bare thought' }, { type: 'text', text: 'bare reply' }] } });
  bare(r, 'assistant', { message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error: 529' }] }, isApiErrorMessage: true });
  bare(r, 'system', { subtype: 'informational', content: 'A bare notice.', level: 'info' });
  r.frameLink({ title: 'Artifact one', frameUrl: 'https://example.org/a' });
  r.meta('frame-link', { uuid: r.uuid(), artifactCount: 1, frameUrl: 'https://example.org/u', path: '/tmp/project/u.html', title: 'With uuid' });
  r.turnDuration({ durationMs: 50 });
  r.bashMode('ls -la');
  r.bashOutput('total 0\n', '');
  r.turnDuration({ durationMs: 10 });
  r.prompt('next', { promptId: `${seed}-3` });
  r.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'npm run build', run_in_background: true } }]);
  const note = { taskId: `b${seed}a2c3d4`, status: 'completed', summary: 'Background command "build" completed (exit code 0)' };
  r.queueOperation('enqueue', { content: taskNotificationText(note) });
  r.taskNotification(note);
  r.assistant(['The build finished.']);
  r.frameLink({ title: 'Artifact two', frameUrl: 'https://example.org/b' });
  r.turnDuration({ durationMs: 50 });
  return r;
}

const idsOf = (changes) => [...new Set(changes.filter((ch) => ch.type === 'item').map((ch) => ch.item.id))].sort();
const persisted = (state) => JSON.parse(JSON.stringify(state));

// Normalize `recs` in pieces cut before each index of `cuts`, the state carried
// as the index persists it (a JSON round trip).
function inPieces(recs, cuts, sid) {
  const at = [0, ...[...new Set(cuts)].filter((n) => n > 0 && n < recs.length).sort((a, b) => a - b), recs.length];
  let state = initialState();
  const changes = [];
  for (let i = 0; i < at.length - 1; i++) {
    const n = normalize(recs.slice(at[i], at[i + 1]), state, { session_id: sid });
    changes.push(...n.changes);
    state = persisted(n.state);
  }
  return changes;
}

const jaccard = (a, b) => {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...A, ...B]).size;
  return uni ? inter / uni : 1;
};

test('a re-read from 0, a resume at a turn boundary and random splits give identical item ids', () => {
  const r = richTranscript(S1, 7);
  const recs = parseLines(jsonl(r.records), 0);
  const whole = idsOf(normalize(recs, initialState(), { session_id: S1 }).changes);
  // Every form is there, so the comparison means something.
  for (const re of [/^n_o[0-9a-f]{16}$/, /^r_o[0-9a-f]{16}$/, /^th_o[0-9a-f]{16}$/, /^lo_o[0-9a-f]{16}$/, /^af_o[0-9a-f]{16}$/,
    /^af_[0-9a-f]{8}-/, /^lo_[0-9a-f]{8}-/, /^r_u_[0-9a-f]{8}-/, /^r_msg_/, /^th_msg_/, /^rl_[0-9a-f]{8}-/, /^toolu_/]) {
    assert.ok(whole.some((id) => re.test(id)), `an id like ${re}: ${whole.join(' ')}`);
  }
  assert.equal(whole.filter((id) => /^af_o/.test(id)).length, 2, 'the two uuid-less artifacts');
  // Through normalize, the record key is the record's byte offset, never its ordinal.
  const bareLinks = recs.filter((x) => x.obj && x.obj.type === 'frame-link' && !x.obj.uuid);
  assert.equal(bareLinks.length, 2);
  for (const x of bareLinks) assert.ok(whole.includes(`af_o${stableHash([S1, x.start]).slice(0, 16)}`), `af_o of byte offset ${x.start}`);

  const again = idsOf(normalize(parseLines(jsonl(r.records), 0), initialState(), { session_id: S1 }).changes);
  assert.equal(jaccard(whole, again), 1, 'a re-read from 0');

  const boundary = recs.findIndex((x) => x.obj && x.obj.promptId === '7-3');
  assert.ok(boundary > 0);
  assert.equal(jaccard(whole, idsOf(inPieces(recs, [boundary], S1))), 1, 'a resume at the turn boundary');

  const rand = mulberry32(11);
  const cuts = Array.from({ length: 7 }, () => 1 + Math.floor(rand() * (recs.length - 1)));
  assert.equal(jaccard(whole, idsOf(inPieces(recs, cuts, S1))), 1, 'seven random splits');
  assert.deepEqual(idsOf(inPieces(recs, cuts, S1)), whole);
});

test('the session id separates the record-key ids of identical records; uuid-derived ids stay', () => {
  const r = richTranscript(S1, 7);
  const text = jsonl(r.records);
  const a = idsOf(normalize(parseLines(text, 0), initialState(), { session_id: 's1' }).changes);
  const b = idsOf(normalize(parseLines(text, 0), initialState(), { session_id: 's2' }).changes);
  const hashed = (ids) => ids.filter((id) => /^(n_o|r_o|th_o|lo_o|af_o)[0-9a-f]{16}$/.test(id));
  const rest = (ids) => ids.filter((id) => !hashed([id]).length);
  assert.ok(hashed(a).length >= 6, `record-key ids (${hashed(a).join(' ')})`);
  assert.equal(hashed(a).filter((id) => hashed(b).includes(id)).length, 0, 'disjoint');
  assert.equal(hashed(a).length, hashed(b).length);
  assert.deepEqual(rest(a), rest(b), 'uuid-derived ids identical');
});

test('the record key: the byte offset when the record has one, else the ordinal', () => {
  assert.equal(recordKey('s1', { start: 120 }, 4), stableHash(['s1', 120]).slice(0, 16));
  assert.equal(recordKey('s1', {}, 4), stableHash(['s1', 'seq', 4]).slice(0, 16));
  assert.equal(recordKey(undefined, { start: 0 }, 1), stableHash(['', 0]).slice(0, 16));
  // A bare call (no offsets) still keys every uuid-less record apart, and alike on a re-run.
  const r = createRecords({ seed: 3 });
  r.frameLink({ title: 'one' });
  r.frameLink({ title: 'two' });
  const run = () => idsOf(normalize(r.records.map((obj) => ({ obj })), initialState(), { session_id: 's1' }).changes);
  assert.deepEqual(run(), [`af_o${recordKey('s1', {}, 1)}`, `af_o${recordKey('s1', {}, 2)}`].sort());
  assert.deepEqual(run(), run());
});

test('the model\'s id grammar admits every new form', () => {
  const model = createModel({ redactor: { text: (s) => s, value: (v) => v } });
  const recs = parseLines(jsonl(richTranscript(S1, 7).records), 0);
  const ids = idsOf(normalize(recs, initialState(), { session_id: S1 }).changes);
  ids.push(`rm_p-two_0_${stableHash([S1, 'mt-b', 0]).slice(0, 8)}`);
  for (const id of ids) assert.equal(model.cleanId(id), id, id);
});

// ── a /clear's two sessions, merged into one conversation ────────────────────

function project(t) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-mirror-ids-'));
  fs.mkdirSync(path.join(dir, '.web-chat'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A real facade with the live and transcripts sources (and mod-live when asked),
// as test/mirror-transcripts.test.js and test/mirror-mod-live.test.js build it.
// The test calls withTempHome once; each boot has its own project and Claude tier.
function boot(t, { modLive = null } = {}) {
  let mirror = null;
  t.after(async () => { if (mirror) await mirror.stop(); });
  const root = project(t);
  const ch = claudeHome(t, { root, isolate: true });
  const hooks = createHookTap();
  const mirrorBus = createBus({ maxEvents: 2000 });
  const frames = [];
  mirrorBus.setBroadcaster((frame) => frames.push(frame));
  mirror = createMirror({
    root, hooks, mainBus: createBus(), mirrorBus, redactor: createRedactor(), log: () => {},
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    isPidAlive: () => true,
    sources: [
      ...SOURCES.filter((s) => s.name === 'live'),
      { name: 'transcripts', attach: createTranscriptsSource({ createStore: createIndexStore, pollMs: 40 }).attach },
      ...(modLive ? [{ name: 'mod-live', attach: modLive.attach }] : []),
    ],
  });
  let ts = Date.now();
  const h = { root, ch, hooks, frames, mirror };
  h.stop = async () => { const m = mirror; mirror = null; await m.stop(); };
  h.tick = () => { ts += 1; return ts; };
  h.env = (event, extra = {}, sid = S1) => ({
    v: 1, event, ts: h.tick(), session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd,
    prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
    result: null, session: null, compact: null, stop: null, prompt: null, ask: null, ...extra,
  });
  h.publish = (event, extra, sid) => hooks.publish(h.env(event, extra, sid));
  h.page = (cid = S1) => mirror.turns(cid, { items: 'full', limit: 100 });
  return h;
}

// The F7 s2 fixture (rich()), whose two uuid-less frame-links collided at the
// same file ordinals; `notice` adds a uuid-less notice inside the first turn.
function s2Rich(sid, seed, tag, { notice = false } = {}) {
  const r = createRecords({ seed, sessionId: sid, cwd: '/tmp/project', start: Date.now(), step: 10 });
  r.prompt(`plan ${tag}`, { promptId: `${tag}-1` });
  r.assistant([{ type: 'thinking', thinking: 'considering the options' }, 'First block of the reply.', { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/a.md' } }]);
  const tu = r.records[r.records.length - 1].message.content[0].id;
  r.toolResult(tu, 'file a');
  r.assistant(['Second message, ', 'two text blocks.']);
  if (notice) bare(r, 'system', { subtype: 'informational', content: 'A bare notice.', level: 'info' });
  r.frameLink({ title: `Artifact ${tag}`, frameUrl: 'https://example.org/a', path: '/tmp/project/a.html', artifactCount: 1 });
  r.turnDuration({ durationMs: 50 });
  r.bashMode('ls -la');
  r.bashOutput('total 0\n', '');
  r.localCommandOutput('local output');
  r.turnDuration({ durationMs: 10 });
  r.prompt(`next ${tag}`, { promptId: `${tag}-3` });
  r.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'npm run build', run_in_background: true } }]);
  const note = { taskId: `b${seed}a2c3d4`, status: 'completed', summary: 'Background command "build" completed (exit code 0)' };
  const text = taskNotificationText(note);
  r.queueOperation('enqueue', { content: text });
  r.taskNotification(note);
  r.queuedCommand(text, { commandMode: 'task-notification' });
  r.assistant(['The build finished.']);
  r.frameLink({ title: `Artifact ${tag} two`, frameUrl: 'https://example.org/b', path: '/tmp/project/b.html', artifactCount: 1 });
  r.turnDuration({ durationMs: 50 });
  return r;
}

const allIds = (page) => page.turns.flatMap((x) => (x.items || []).map((it) => it.id));
const settled = (h, cid, n) => waitUntil(async () => {
  const p = await h.page(cid);
  return p && p.total === n && p.turns.every((x) => x.status !== 'open') ? p : null;
}, { timeout: 8000, what: `${n} closed turns of ${cid}` });

// One session alone: its turns and item ids.
async function solo(t, sid, seed, tag, opts) {
  const h = boot(t);
  await h.mirror.start();
  const r = s2Rich(sid, seed, tag, opts);
  h.ch.writeTranscript(sid, r.records);
  h.publish('SessionStart', { session: { source: 'startup' } }, sid);
  const p = await settled(h, sid, 3);
  await h.stop();
  return allIds(p);
}

for (const [label, opts, expected] of [['the F7 s2 fixture', {}, 26], ['with a uuid-less notice', { notice: true }, 28]]) {
  test(`a /clear's two sessions merged into one conversation keep every item (${label}: ${expected}/${expected})`, async (t) => {
    withTempHome(t);
    const ids1 = await solo(t, S1, 41, 'x', opts);
    const ids2 = await solo(t, S2, 42, 'y', opts);
    assert.equal(ids1.length + ids2.length, expected, 'the expected items');

    const h = boot(t);
    await h.mirror.start();
    const r1 = s2Rich(S1, 41, 'x', opts);
    const r2 = s2Rich(S2, 42, 'y', opts);
    // The uuid-less records sit at the same byte offsets in both files: only the session tells them apart.
    const offsets = (r) => parseLines(jsonl(r.records), 0).filter((x) => x.obj && !x.obj.uuid && x.obj.type === 'frame-link').map((x) => x.start);
    assert.deepEqual(offsets(r1), offsets(r2));
    h.ch.writeTranscript(S1, r1.records);
    h.publish('SessionStart', { claude_pid: PID, session: { source: 'startup' } }, S1);
    await settled(h, S1, 3);
    h.ch.writeTranscript(S2, r2.records);
    h.publish('SessionStart', { claude_pid: PID, session: { source: 'clear' } }, S2);
    const page = await settled(h, S1, 6);
    assert.equal(h.mirror.snapshot({}).conversations.length, 1, 'one conversation');
    assert.deepEqual([...new Set(page.turns.map((x) => x.session_id))].sort(), [S1, S2].sort());
    const ids = allIds(page);
    assert.equal(ids.length - new Set(ids).size, 0, 'no duplicate id in the conversation');
    assert.equal(new Set(ids).size, expected, `every item kept (${new Set(ids).size}/${expected})`);
    assert.deepEqual([...ids].sort(), [...ids1, ...ids2].sort(), 'each session\'s own items');
    assert.equal(ids1.filter((id) => ids2.includes(id)).length, 0, 'the two sessions share no id');
    assert.equal(h.mirror.stats().model.merge_duplicates, 0);
  });
}

// ── a provisional turn merged into the transcript's ──────────────────────────

test('a provisional turn merged into the transcript turn: one item per record, the dropped copy counted', () => {
  const model = createModel({ redactor: { text: (s) => s, value: (v) => v } });
  const w = model.claimTurnWriter();
  w.putTurn({ id: 'P3', conversation_id: 'c1', session_id: S1, seq: 1, status: 'open', started_at: 5 });
  w.putTurn({ id: 'H3', conversation_id: 'c1', session_id: S1, seq: 2, status: 'open', started_at: 9, provisional: true });
  assert.equal(model.stats().merge_duplicates, 0);
  // The hook's copies: the prompt (p_<turn>, re-keyed by the merge) and a tool call.
  model.upsertItem({ id: 'p_H3', turn_id: 'H3', kind: 'prompt', text: 'run the tests', origin: 'human', source: 'hook' });
  model.upsertItem({ id: 'toolu_live', turn_id: 'H3', kind: 'tool_call', tool: 'Bash', status: 'running', source: 'hook' });
  model.upsertItem({ id: 'toolu_next', turn_id: 'H3', kind: 'tool_call', tool: 'Read', status: 'running', source: 'hook' });
  // The transcript's: the same prompt, and the same tool call record (which moves the hook's item over).
  model.upsertItem({ id: 'p_P3', turn_id: 'P3', kind: 'prompt', text: 'run the tests', origin: 'human' });
  model.upsertItem({ id: 'toolu_live', turn_id: 'P3', kind: 'tool_call', tool: 'Bash', status: 'running', source: 'transcript' });
  assert.ok(w.mergeTurn('H3', 'P3'));
  const ids = model.itemsOf('P3').map((it) => it.id).sort();
  assert.deepEqual(ids, ['p_P3', 'toolu_live', 'toolu_next']);
  assert.equal(ids.filter((id) => id === 'toolu_live').length, 1, 'one item for the tool call');
  assert.equal(model.stats().merge_duplicates, 1, 'the hook\'s copy of the prompt, dropped');
  assert.equal(model.item('p_H3'), null);
});

// ── mod-live: a collision on rm_<turn>_<index> ───────────────────────────────

async function twoModTurns(t) {
  const src = createModLiveSource({ coalesceMs: 20 });
  const h = boot(t, { modLive: src });
  await h.mirror.start();
  h.publish('SessionStart', { session: { source: 'startup' } }, S1);
  await waitUntil(() => h.frames.some((f) => f.type === 'mirror:reset' && f.conversation_id === S1), { what: 'the catch-up' });
  h.publish('UserPromptSubmit', { prompt_id: 'p-two', prompt: { author: 'user', text: 'prompt p-two' } }, S1);
  const mod = (kind, payload) => h.hooks.publish({ v: 1, event: MOD_EVENT, synthetic: true, ts: h.tick(), session_id: S1, mod: { kind, ...payload } });
  mod('turn.start', { turn_id: 'mt-a' });
  mod('turn.step', { turn_id: 'mt-a', index: 0, delta: 'First turn, step zero. ' });
  await waitUntil(async () => {
    const p = await h.page();
    return p && allIds(p).includes('rm_p-two_0');
  }, { what: 'mt-a\'s step' });
  mod('turn.start', { turn_id: 'mt-b' });
  mod('turn.step', { turn_id: 'mt-b', index: 0, delta: 'Second turn, step zero. ' });
  const p = await waitUntil(async () => {
    const pg = await h.page();
    return pg && allIds(pg).filter((id) => id.startsWith('rm_')).length === 2 ? pg : null;
  }, { what: 'mt-b\'s step' });
  const rms = allIds(p).filter((id) => id.startsWith('rm_')).sort();
  await h.stop();
  return rms;
}

test('mod-live: two mod turns on one turn give rm_<tid>_0 and rm_<tid>_0_<h8>, the same after a restart', async (t) => {
  withTempHome(t);
  const first = await twoModTurns(t);
  const h8 = stableHash([S1, 'mt-b', 0]).slice(0, 8);
  assert.deepEqual(first, ['rm_p-two_0', `rm_p-two_0_${h8}`].sort());
  for (const id of first) assert.match(id, /^rm_p-two_0(_[0-9a-f]{8})?$/, 'no decimal counter suffix');
  const restarted = await twoModTurns(t);
  assert.deepEqual(restarted, first, 'a fresh source fed the same events makes the same ids');
});
