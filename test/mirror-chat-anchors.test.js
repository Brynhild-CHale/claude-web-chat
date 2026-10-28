// The chat-anchor resolver behind the mirror's facade (PLAN.md 3A.1; DECISIONS.md
// D3, D4, D5, L1, L4, L5; RULED Q6, Q7, S1-confirm, REQ@list-never-waits,
// LAST@memory). lib/server/mirror/chat-anchors.js, reached through the facade's
// resolveAnchors and recordAnchor rows, and lib/core/anchor-states.js.
//
// Pinned, through a real facade (createMirror with every built-in SOURCE, the
// transcripts source on a short poll) over a temp project and a claude-home tier
// fed only claude-records transcripts and v1 hook envelopes:
//   * record + resolve each built-in kind (a turn; an item: a reply, a tool card;
//     an item-range in a reply): placed exact, and every record has the shape
//     S1-confirm states for its kind, quote ≤ 2000, prefix/suffix ≤ 32, its ids
//     from the model;
//   * a rewind (rewind-fixtures branch()) supersedes a turn: its pins answer
//     superseded with their placement data;
//   * a learned value inside a recorded passage (M-7's one-value, ending-inside
//     and wholly-inside cases) answers masked with its span, never exact; an
//     unaffected passage placed; a passage masked at create placed;
//   * record refuses rh_, rm_, a hook-sourced card and a provisional turn with
//     EXPLAIN.refused, and writes nothing;
//   * U413's re-key followed, and after a restart (the replaces alias);
//   * gone answers unavailable, never orphaned; every state in the vocabulary;
//   * REQ@list-never-waits: indexing with zero reads;
//   * redactOut on every answer (findLeaks), no served text in an answer;
//   * memory hits, dropped by a batch, nothing written under .web-chat/;
//   * registerKind through the `kinds` option; an unregistered kind; a note.
//
// A test never requires design/ (CI has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { withTempHome, waitUntil } = require('../test-support/helpers');
const { createRecords, jsonl } = require('../test-support/claude-records');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const rewindFixtures = require('../test-support/rewind-fixtures');
const { createRedactor, marksIn } = require('../lib/core/redact');
const { createBus } = require('../lib/core/bus');
const { ANCHOR_STATES, VISIBLE, EXPLAIN, isAnchorState } = require('../lib/core/anchor-states');
const { createHookTap } = require('../lib/server/hook-tap');
const { MOD_EVENT } = require('../lib/core/mod-protocol');
const { createMirror, SOURCES, DISPATCH } = require('../lib/server/mirror');
const { createTranscriptsSource } = require('../lib/server/mirror/transcripts');
const { createIndexStore } = require('../lib/server/mirror/index-store');
const { createModLiveSource } = require('../lib/server/mirror/mod-live');
const { createChatAnchorsSource, MEMORY_MAX, FP_HEX, BUILTIN_KINDS } = require('../lib/server/mirror/chat-anchors');

const S1 = '11111111-1111-4111-8111-111111111111';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAKES = fakeSecrets();
const secretOf = (id) => FAKES.find((x) => x.id === id).secrets[0];
const E = secretOf('known-email'); // masked only once known
const G = secretOf('github-ghp'); // masked from the start

const SIX = ['placed', 'refused', 'superseded', 'masked', 'indexing', 'unavailable'];
const Q6 = {
  placed: 'Pinned here.',
  refused: 'This reply is still arriving — pin it once the transcript has it.',
  superseded: 'This turn was rewound in the terminal; the pin stays on the turn it was made on.',
  masked: 'The pinned words now hold a value web-chat hides; the pin covers the hidden part and never shows it.',
  indexing: 'This conversation is being read; the pin places when that is done.',
  unavailable: 'What this pin was on is no longer on this machine; its quote is kept.',
};
const ANSWER_KEYS = ['id', 'state', 'visible', 'explain', 'how', 'at', 'turn_id', 'rule', 'note'];

function project(t) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-chat-anchors-'));
  fs.mkdirSync(path.join(dir, '.web-chat'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function listing(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
    }
  };
  walk(dir, '');
  return out;
}

// The transcripts source on a short poll; optionally wrapped to count its api
// calls and to answer `indexing` (U454's seam, stubbed: `spy.indexing` decides).
function transcriptsEntry(spy) {
  const make = () => createTranscriptsSource({ createStore: createIndexStore, pollMs: 40 });
  if (!spy) return { name: 'transcripts', attach: make().attach };
  return {
    name: 'transcripts',
    attach: (engine) => {
      const inst = make().attach(engine);
      const api = {};
      for (const [k, fn] of Object.entries(inst.api)) {
        api[k] = (...args) => { spy.calls[k] = (spy.calls[k] || 0) + 1; return fn(...args); };
      }
      api.indexing = (cid) => spy.indexing(cid);
      return { ...inst, api };
    },
  };
}

// A real facade over a temp project; `world` = {root, ch} boots again over an
// existing project and tier (a restart).
function boot(t, { world = null, spy = null, chatAnchors = null, modLive = false } = {}) {
  let root; let ch;
  if (world) ({ root, ch } = world);
  else { root = project(t); ch = claudeHome(t, { root, isolate: true }); }
  const hooks = createHookTap();
  const mirrorBus = createBus({ maxEvents: 5000 });
  const frames = [];
  mirrorBus.setBroadcaster((frame) => frames.push(frame));
  const redactor = createRedactor();
  const sources = SOURCES.map((s) => {
    if (s.name === 'transcripts') return transcriptsEntry(spy);
    if (s.name === 'chat-anchors' && chatAnchors) return { name: 'chat-anchors', attach: chatAnchors.attach };
    if (s.name === 'mod-live' && modLive) return { name: 'mod-live', attach: createModLiveSource({ coalesceMs: 20 }).attach };
    return s;
  });
  let mirror = createMirror({
    root, hooks, mainBus: createBus(), mirrorBus, redactor, log: () => {},
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    isPidAlive: () => true,
    sources,
  });
  t.after(async () => { if (mirror) await mirror.stop(); });
  let ts = Date.now();
  const h = { root, ch, hooks, frames, redactor, world: { root, ch } };
  Object.defineProperty(h, 'mirror', { get: () => mirror });
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
  h.items = async (tid) => { const x = await mirror.turn(tid); return x ? x.items : []; };
  h.diag = () => mirror.snapshot({}).diagnostics.chat_anchors;
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

const settled = (h, n) => waitUntil(async () => {
  const p = await h.page();
  return p && p.total === n && p.turns.every((x) => x.status !== 'open') ? p : null;
}, { timeout: 8000, what: `${n} closed turns` });

// The reply that carries every passage the tests pin.
const LONG_PROMPT = `plan the work ${'carefully and in order, '.repeat(140)}end.`;
const REPLY = [
  `Before the value, a quote. Contact ${E} for access; after the value, another quote that we anchor on.`,
  `Reach out: write to ${E} before noon, please.`,
  `Owner address is ${E} as listed.`,
  `Token ${G} was rotated; the end anchor is here.`,
].join(' ');
const READ_INPUT = { file_path: '/tmp/project/a.md' };

// One conversation: turn 1 (a long prompt, a tool card, the reply), turn 2.
async function world(t, opts = {}) {
  const h = boot(t, opts);
  await h.begin();
  const r = h.records(31);
  r.prompt(LONG_PROMPT, { promptId: 'ca-1' });
  r.assistant([{ type: 'tool_use', name: 'Read', input: READ_INPUT }]);
  const toolId = r.records[r.records.length - 1].message.content[0].id;
  r.toolResult(toolId, 'file a');
  r.assistant([REPLY]);
  r.turnDuration({ durationMs: 40 });
  r.prompt('second prompt', { promptId: 'ca-2' });
  r.assistant(['second reply']);
  r.turnDuration({ durationMs: 40 });
  h.append(r.records);
  await settled(h, 2);
  const items = await h.items('ca-1');
  const reply = items.find((it) => it.kind === 'reply');
  const tool = items.find((it) => it.kind === 'tool_call');
  assert.ok(reply && tool, 'a reply and a tool card');
  h.r = r;
  h.replyId = reply.id;
  h.toolId = tool.id;
  // The reply as served now, and a passage's source offsets in it.
  h.served = async () => (await h.mirror.itemField(h.replyId, { field: 'text' })).text;
  h.posOf = async (exact, nth = 0) => {
    const s = await h.served();
    let at = -1;
    for (let i = 0; i <= nth; i++) at = s.indexOf(exact, at + 1);
    assert.ok(at >= 0, `the passage is served: ${exact}`);
    return { start: at, end: at + exact.length };
  };
  h.range = async (exact, nth) => h.mirror.recordAnchor({ kind: 'item-range', item_id: h.replyId, pos: await h.posOf(exact, nth) });
  return h;
}

const resolveOne = async (h, anchor, id = 'k1', v = 1) => (await h.mirror.resolveAnchors([{ id, v, anchor }]))[0];

// S1-confirm's shape for the three built-in kinds, checked as stated (never
// through U415's validator).
const HEAD = ['v', 'kind', 'conversation_id', 'session_id', 'turn_id'];
const SHAPE = {
  turn: [...HEAD, 'quote', 'fp', 'marks', 'label'],
  item: [...HEAD, 'item_id', 'field', 'quote', 'fp', 'marks', 'label'],
  'item-range': [...HEAD, 'item_id', 'field', 'quote', 'pos', 'ordinal', 'fp', 'marks', 'label'],
};
function assertShape(rec, kind) {
  const keys = Object.keys(rec);
  const want = SHAPE[kind].filter((k) => k !== 'ordinal' || 'ordinal' in rec);
  assert.deepEqual(keys, want, `${kind}: the stated keys, in the stated order`);
  assert.equal(rec.v, 1);
  assert.equal(rec.kind, kind);
  for (const k of ['conversation_id', 'session_id', 'turn_id', 'label']) assert.equal(typeof rec[k], 'string', `${kind}.${k}`);
  assert.deepEqual(Object.keys(rec.quote), ['exact', 'prefix', 'suffix']);
  assert.ok(rec.quote.exact.length > 0 && rec.quote.exact.length <= 2000, `${kind}: quote ≤ 2000 (${rec.quote.exact.length})`);
  assert.ok(rec.quote.prefix.length <= 32 && rec.quote.suffix.length <= 32, `${kind}: prefix/suffix ≤ 32`);
  assert.deepEqual(Object.keys(rec.fp), ['h', 'len']);
  assert.match(rec.fp.h, new RegExp(`^[0-9a-f]{${FP_HEX}}$`));
  assert.ok(Number.isSafeInteger(rec.fp.len) && rec.fp.len >= rec.quote.exact.length);
  assert.ok(Number.isSafeInteger(rec.marks) && rec.marks >= 0);
  assert.equal(rec.marks, marksIn(rec.quote.exact).length, `${kind}: marks counts the quote's marks`);
  if (kind !== 'turn') assert.equal(typeof rec.item_id, 'string');
  if (kind === 'item-range') {
    assert.equal(rec.field, 'text');
    assert.deepEqual(Object.keys(rec.pos), ['start', 'end']);
    assert.equal(rec.pos.end - rec.pos.start, rec.quote.exact.length);
    if ('ordinal' in rec) assert.deepEqual(Object.keys(rec.ordinal), ['index', 'of']);
  }
}

function assertAnswer(a, label) {
  for (const k of Object.keys(a)) assert.ok(ANSWER_KEYS.includes(k), `${label}: ${k} is an answer field`);
  assert.ok(isAnchorState(a.state), `${label}: ${a.state} is an anchor state`);
  assert.notEqual(a.state, 'orphaned', `${label}: never orphaned`);
  assert.ok(SIX.includes(a.visible), `${label}: ${a.visible} is one of the six`);
  assert.equal(a.visible, VISIBLE[a.state], `${label}: VISIBLE[state]`);
  assert.equal(a.explain, EXPLAIN[a.visible], `${label}: its EXPLAIN line`);
}

// ── the vocabulary ───────────────────────────────────────────────────────────

test('anchor-states: the nine old names in order, then indexing and unavailable; VISIBLE onto the six; EXPLAIN as Q6 wrote it', () => {
  assert.ok(Object.isFrozen(ANCHOR_STATES) && Object.isFrozen(VISIBLE) && Object.isFrozen(EXPLAIN));
  assert.deepEqual([...ANCHOR_STATES], ['exact', 're-resolved', 'orphaned', 'hidden', 'masked', 'provisional', 'superseded',
    'expired', 'draw-failed', 'indexing', 'unavailable']);
  assert.deepEqual({ ...VISIBLE }, {
    exact: 'placed', 're-resolved': 'placed', provisional: 'refused', superseded: 'superseded', masked: 'masked',
    indexing: 'indexing', unavailable: 'unavailable', expired: 'unavailable',
  });
  for (const s of Object.keys(VISIBLE)) assert.ok(isAnchorState(s), s);
  assert.deepEqual([...new Set(Object.values(VISIBLE))].sort(), [...SIX].sort(), 'VISIBLE answers exactly the six');
  assert.deepEqual(Object.keys(EXPLAIN), SIX, 'one line per visible state');
  for (const v of SIX) assert.ok(typeof EXPLAIN[v] === 'string' && EXPLAIN[v].length > 0 && !EXPLAIN[v].includes('\n'), v);
  assert.deepEqual({ ...EXPLAIN }, Q6, 'the six lines as written (RULED Q6 = a)');
});

test('the facade: two DISPATCH rows to chat-anchors, async; the source after graph-link, before mod-live', () => {
  assert.deepEqual({ ...DISPATCH.resolveAnchors }, { source: 'chat-anchors', method: 'resolve', async: true });
  assert.deepEqual({ ...DISPATCH.recordAnchor }, { source: 'chat-anchors', method: 'record', async: true });
  const names = SOURCES.map((s) => s.name);
  assert.equal(names.indexOf('chat-anchors'), names.indexOf('graph-link') + 1);
  assert.equal(names.indexOf('mod-live'), names.indexOf('chat-anchors') + 1);
  assert.deepEqual([...BUILTIN_KINDS], ['turn', 'item', 'item-range']);
  assert.equal(MEMORY_MAX, 5000);
});

// ── record + resolve each built-in kind ──────────────────────────────────────

test('record + resolve: a turn, an item (a reply, a tool card), an item-range in a reply — placed exact, each record in its stated shape', async (t) => {
  withTempHome(t);
  const h = await world(t);
  const t1 = await h.mirror.recordAnchor({ kind: 'turn', turn_id: 'ca-1' });
  const t2 = await h.mirror.recordAnchor({ kind: 'turn', turn_id: 'ca-2' });
  const reply = await h.mirror.recordAnchor({ kind: 'item', item_id: h.replyId });
  const card = await h.mirror.recordAnchor({ kind: 'item', item_id: h.toolId });
  const prompt = await h.mirror.recordAnchor({ kind: 'item', item_id: 'p_ca-2' });
  const range = await h.range('the end anchor is here.');
  const twice = await h.range('anchor', 1);
  const recs = { t1, t2, reply, card, prompt, range, twice };
  for (const [name, r] of Object.entries(recs)) {
    assert.deepEqual(Object.keys(r), ['anchor'], `${name}: an anchor`);
    assertShape(r.anchor, r.anchor.kind);
    assert.equal(r.anchor.conversation_id, S1, `${name}: the conversation, from the model`);
    assert.equal(r.anchor.session_id, S1, `${name}: the session, from the model`);
  }
  assert.equal(t1.anchor.turn_id, 'ca-1');
  assert.equal(t1.anchor.label, 'turn 1');
  assert.equal(t2.anchor.label, 'turn 2');
  assert.equal(t1.anchor.quote.exact.length, 2000, 'a long prompt\'s head, cut at quote_max');
  assert.ok(LONG_PROMPT.startsWith(t1.anchor.quote.exact));
  assert.equal(t1.anchor.fp.len, LONG_PROMPT.length);
  assert.equal(t2.anchor.quote.exact, 'second prompt');
  assert.deepEqual([reply.anchor.item_id, reply.anchor.field, reply.anchor.label], [h.replyId, 'text', 'turn 1\'s reply']);
  assert.deepEqual([card.anchor.item_id, card.anchor.field, card.anchor.label], [h.toolId, 'input', 'tool card Read']);
  assert.deepEqual(JSON.parse(card.anchor.quote.exact), READ_INPUT, 'a tool card\'s input head');
  assert.deepEqual([prompt.anchor.item_id, prompt.anchor.label], ['p_ca-2', 'turn 2\'s prompt']);
  assert.equal(range.anchor.quote.exact, 'the end anchor is here.');
  assert.equal(range.anchor.label, 'turn 1\'s reply');
  assert.equal('ordinal' in range.anchor, false, 'a unique passage records no ordinal');
  assert.deepEqual(twice.anchor.ordinal, { index: 1, of: 2 }, 'as recordRange makes one');
  assert.equal(range.anchor.marks, 0);
  assert.equal(reply.anchor.marks, 1, 'the reply\'s head holds the token\'s mark, counted');

  const answers = await h.mirror.resolveAnchors(Object.entries(recs).map(([id, r]) => ({ id, v: 1, anchor: r.anchor })));
  assert.deepEqual(answers.map((a) => a.id), Object.keys(recs), 'in batch order');
  for (const a of answers) {
    assertAnswer(a, a.id);
    assert.equal(a.state, 'exact', `${a.id}: exact`);
    assert.equal(a.visible, 'placed');
  }
  const by = Object.fromEntries(answers.map((a) => [a.id, a]));
  assert.equal(by.t1.turn_id, 'ca-1');
  assert.deepEqual(by.reply.at, { item_id: h.replyId });
  assert.deepEqual(by.card.at, { item_id: h.toolId });
  assert.deepEqual(by.range.at, { item_id: h.replyId, field: 'text', ...range.anchor.pos });
  assert.deepEqual(by.twice.at, { item_id: h.replyId, field: 'text', ...twice.anchor.pos });
  assert.deepEqual([by.range.how, by.twice.how], ['fingerprint', 'fingerprint'], 'the fast path: the served field\'s fingerprint equal, exact at pos');

  // A passage resolved by its quote (the fingerprint changed: a stale fp).
  const stale = { ...range.anchor, fp: { h: '0'.repeat(FP_HEX), len: range.anchor.fp.len } };
  const a = await resolveOne(h, stale, 'stale');
  assert.equal(a.state, 'exact');
  assert.equal(a.how, 'unique');
  assert.deepEqual(a.at, { item_id: h.replyId, field: 'text', ...range.anchor.pos });

  // Invalid requests: an empty range, one over quote_max, a non-text field.
  assert.equal((await h.mirror.recordAnchor({ kind: 'item-range', item_id: h.replyId, pos: { start: 5, end: 5 } })).invalid, true);
  const tooLong = await h.mirror.recordAnchor({ kind: 'item-range', item_id: 'p_ca-1', pos: { start: 0, end: 2001 } });
  assert.equal(tooLong.invalid, true);
  assert.equal(typeof tooLong.hint, 'string');
  assert.equal((await h.mirror.recordAnchor({ kind: 'item-range', item_id: h.toolId, pos: { start: 0, end: 4 } })).invalid, true);
  assert.equal((await h.mirror.recordAnchor({ kind: 'nobody', turn_id: 'ca-1' })).invalid, true);
  assert.deepEqual(await h.mirror.recordAnchor({ kind: 'turn', turn_id: 'no-such-turn' }), { unavailable: true, rule: 'gone' });
  assert.deepEqual(await h.mirror.recordAnchor({ kind: 'item', item_id: 'r_no_such' }), { unavailable: true, rule: 'gone' });
});

// ── a rewind supersedes ──────────────────────────────────────────────────────

test('a rewind (branch()) supersedes a turn: its pins answer superseded with their placement data; a live turn\'s stay placed', async (t) => {
  withTempHome(t);
  const f = rewindFixtures.branch({ sessionId: S1, start: Date.now() - 60000 });
  const h = boot(t);
  await h.mirror.start();
  const base = { sessionId: S1, transcriptPath: h.ch.transcript(S1), cwd: h.ch.cwd };
  for (const hook of f.hooks) h.hooks.publish(rewindFixtures.envelope(hook, base));
  const cut = f.records.findIndex((x) => x.promptId === 'rw-4');
  h.ch.writeTranscript(S1, f.records.slice(0, cut));
  await settled(h, 3);
  const items = await h.items('rw-2');
  const reply2 = items.find((it) => it.kind === 'reply');
  const served = (await h.mirror.itemField(reply2.id, { field: 'text' })).text;
  const at = served.indexOf('rw-2');
  const pins = {
    turn2: await h.mirror.recordAnchor({ kind: 'turn', turn_id: 'rw-2' }),
    reply2: await h.mirror.recordAnchor({ kind: 'item', item_id: reply2.id }),
    range2: await h.mirror.recordAnchor({ kind: 'item-range', item_id: reply2.id, pos: { start: at, end: at + 4 } }),
    turn1: await h.mirror.recordAnchor({ kind: 'turn', turn_id: 'rw-1' }),
  };
  for (const r of Object.values(pins)) assert.ok(r.anchor);
  fs.appendFileSync(h.ch.transcript(S1), jsonl(f.records.slice(cut)));
  await settled(h, 4);
  const sup = await waitUntil(async () => {
    const p = await h.page();
    const s = p.turns.filter((x) => x.superseded).map((x) => x.id);
    return s.length ? s : null;
  }, { timeout: 8000, what: 'the rewind' });
  assert.deepEqual(sup, f.expect.superseded, 'the fixture\'s expected verdict');
  const answers = await h.mirror.resolveAnchors(Object.entries(pins).map(([id, r]) => ({ id, v: 1, anchor: r.anchor })));
  const by = Object.fromEntries(answers.map((a) => [a.id, a]));
  for (const a of answers) assertAnswer(a, a.id);
  for (const id of ['turn2', 'reply2', 'range2']) assert.equal(by[id].state, 'superseded', id);
  assert.equal(by.turn2.turn_id, 'rw-2');
  assert.deepEqual(by.reply2.at, { item_id: reply2.id }, 'the item\'s placement data');
  assert.deepEqual(by.range2.at, { item_id: reply2.id, field: 'text', start: at, end: at + 4 }, 'the passage\'s placement data');
  assert.equal(by.turn1.state, 'exact', 'a turn the rewind kept');
});

// ── learned values mask ──────────────────────────────────────────────────────

test('a learned value inside a recorded passage answers masked with its span, never exact; an unaffected passage stays placed; one masked at create is placed', async (t) => {
  withTempHome(t);
  const h = await world(t);
  const before = await h.served();
  assert.ok(before.includes(E), 'the email is served before it is learned');
  assert.ok(!before.includes(G), 'the github token is masked from the start');
  const tokenMark = marksIn(before).map((m) => before.slice(m.start, m.end))[0];
  const passages = {
    'one-value': `Contact ${E} for access`,
    'ends-inside': `write to ${E.slice(0, 10)}`,
    'wholly-inside': E.slice(3, 15),
    unaffected: 'the end anchor is here.',
    'masked-at-create': `Token ${tokenMark} was rotated`,
  };
  const recs = {};
  for (const [name, exact] of Object.entries(passages)) {
    const nth = name === 'wholly-inside' ? 2 : 0; // the third email: "Owner address is …"
    recs[name] = (await h.range(exact, nth)).anchor;
    assert.ok(recs[name], name);
  }
  assert.equal(recs['masked-at-create'].marks, 1, 'the mark counted at create');
  for (const name of ['one-value', 'ends-inside', 'wholly-inside', 'unaffected']) assert.equal(recs[name].marks, 0, name);
  const all = () => h.mirror.resolveAnchors(Object.entries(recs).map(([id, anchor]) => ({ id, v: 1, anchor })));
  for (const a of await all()) assert.equal(a.state, 'exact', `${a.id}: exact before the value is learned`);

  h.redactor.addKnown(E, 'email');
  const after = await h.served();
  assert.ok(!after.includes(E), 'the email is masked once learned');
  const spans = marksIn(after);
  const answers = await all();
  const by = Object.fromEntries(answers.map((a) => [a.id, a]));
  for (const a of answers) assertAnswer(a, a.id);
  for (const name of ['one-value', 'ends-inside', 'wholly-inside']) {
    assert.equal(by[name].state, 'masked', `${name}: masked`);
    assert.notEqual(by[name].state, 'exact');
    const { start, end } = by[name].at;
    assert.ok(spans.some((m) => m.start < end && m.end > start), `${name}: its span covers a mark`);
  }
  // The one-value span: from "Contact " to " for access", through the mark.
  const ov = after.slice(by['one-value'].at.start, by['one-value'].at.end);
  assert.ok(ov.startsWith('Contact ') && ov.endsWith(' for access') && marksIn(ov).length === 1, 'the one-value span');
  assert.equal(by.unaffected.state, 'exact', 'an unaffected passage in the same reply');
  assert.equal(after.slice(by.unaffected.at.start, by.unaffected.at.end), passages.unaffected);
  assert.equal(by['masked-at-create'].visible, 'placed', 'a mark the pin was made over is no news');
  assert.equal(after.slice(by['masked-at-create'].at.start, by['masked-at-create'].at.end), passages['masked-at-create']);

  // The log's masking view hands the quote masked too (element-log's read):
  // the quote then matches the served text literally, and the extra mark
  // still answers masked, never exact.
  const viewed = h.redactor.value(recs['one-value']);
  assert.notEqual(viewed.quote.exact, recs['one-value'].quote.exact);
  const v = await resolveOne(h, viewed, 'viewed');
  assert.equal(v.state, 'masked');
  assert.deepEqual(v.at, by['one-value'].at);
});

// ── refused ──────────────────────────────────────────────────────────────────

test('record refuses an rh_ reply, an rm_ reply, a hook-sourced tool card and a provisional turn with the refused hint, and writes nothing', async (t) => {
  withTempHome(t);
  const h = boot(t, { modLive: true });
  await h.begin();
  h.prompt('hook-p', 'a provisional turn');
  await waitUntil(async () => { const x = await h.mirror.turn('hook-p'); return x && x.turn; }, { timeout: 8000, what: 'the hook turn' });
  const tool = { use_id: 'toolu_01HookCard', name: 'Bash', input: { command: 'ls' } };
  h.publish('PreToolUse', { tool, prompt_id: 'hook-p' });
  h.mod('turn.start', { turn_id: 'mt-a' });
  h.mod('turn.step', { turn_id: 'mt-a', index: 0, delta: 'Streaming words. ' });
  const has = (want) => waitUntil(async () => {
    const items = await h.items('hook-p');
    return want.every((id) => items.some((it) => it.id === id)) ? items : null;
  }, { timeout: 8000, what: want.join(', ') });
  const items = await has(['rm_hook-p_0', tool.use_id]);
  assert.equal(items.find((it) => it.id === tool.use_id).source, 'hook');
  await sleep(300);
  const files = listing(path.join(h.root, '.web-chat'));
  const diag = h.diag();
  const want = { refused: 'provisional', hint: EXPLAIN.refused };
  const refusedOf = async (input, label) => assert.deepEqual(await h.mirror.recordAnchor(input), want, label);
  await refusedOf({ kind: 'item', item_id: 'rm_hook-p_0' }, 'rm_ (mod-live\'s streamed reply)');
  await refusedOf({ kind: 'item-range', item_id: 'rm_hook-p_0', pos: { start: 0, end: 4 } }, 'an rm_ range');
  await refusedOf({ kind: 'item', item_id: tool.use_id }, 'a hook-sourced card');
  await refusedOf({ kind: 'turn', turn_id: 'hook-p' }, 'a provisional turn');
  await refusedOf({ kind: 'item', item_id: 'p_hook-p' }, 'a provisional turn\'s prompt');
  // The Stop's provisional reply (mod-live's own retires with it).
  h.publish('Stop', { prompt_id: 'hook-p', stop: { last_assistant_message: 'The stop hook\'s reply.' } });
  await has(['rh_hook-p']);
  await refusedOf({ kind: 'item', item_id: 'rh_hook-p' }, 'rh_');
  await refusedOf({ kind: 'item-range', item_id: 'rh_hook-p', pos: { start: 0, end: 4 } }, 'an rh_ range');
  // A hook card in a turn the transcript has bound: refused by its source alone.
  const r = h.records(61);
  r.prompt('a provisional turn', { promptId: 'hook-p' });
  h.append(r.records);
  await waitUntil(async () => { const x = await h.mirror.turn('hook-p'); return x && x.turn && !x.turn.provisional ? x : null; }, { timeout: 8000, what: 'the opener bound' });
  assert.ok((await h.mirror.recordAnchor({ kind: 'turn', turn_id: 'hook-p' })).anchor, 'the bound turn is pinnable');
  const late = { use_id: 'toolu_01LateHookCard', name: 'Read', input: { file_path: '/tmp/project/b.md' } };
  h.publish('PreToolUse', { tool: late, prompt_id: 'hook-p' });
  await has([late.use_id]);
  await refusedOf({ kind: 'item', item_id: late.use_id }, 'a hook card in a bound turn');
  assert.deepEqual(listing(path.join(h.root, '.web-chat')).filter((f) => !f.startsWith('mirror')), files.filter((f) => !f.startsWith('mirror')),
    'nothing written by a record (the index under mirror/ is the transcripts source\'s)');
  const d2 = h.diag();
  assert.equal(d2.records, diag.records + 9);
  assert.equal(d2.memory, diag.memory, 'nothing kept');
});

// ── re-keys ──────────────────────────────────────────────────────────────────

test('a re-key is followed: an anchor on a hook id answers placed with the transcript\'s turn id, and still does after a restart', async (t) => {
  withTempHome(t);
  const h = boot(t);
  await h.begin();
  h.prompt('hook-a', 'turn a');
  await waitUntil(async () => { const x = await h.mirror.turn('hook-a'); return x && x.turn; }, { timeout: 8000, what: 'the hook turn' });
  assert.equal((await h.mirror.recordAnchor({ kind: 'turn', turn_id: 'hook-a' })).refused, 'provisional', 'not yet: no opener bound');
  const r = h.records(41);
  r.prompt('turn a', { promptId: 'rec-a' });
  r.assistant(['reply a']);
  r.turnDuration({ durationMs: 40 });
  h.append(r.records);
  await turnClosed(h, 'rec-a');
  const made = await h.mirror.recordAnchor({ kind: 'turn', turn_id: 'hook-a' });
  assert.equal(made.anchor.turn_id, 'rec-a', 'a record names the turn\'s current id');
  // Anchors that still name the hook's ids (a turn and its prompt item).
  const onHook = { ...made.anchor, turn_id: 'hook-a' };
  const promptOnHook = { ...(await h.mirror.recordAnchor({ kind: 'item', item_id: 'p_rec-a' })).anchor, turn_id: 'hook-a', item_id: 'p_hook-a' };
  const check = async (m, label) => {
    const [a, b] = await m.resolveAnchors([{ id: 'k-turn', v: 1, anchor: onHook }, { id: 'k-prompt', v: 1, anchor: promptOnHook }]);
    assertAnswer(a, label); assertAnswer(b, label);
    assert.deepEqual([a.state, a.turn_id], ['exact', 'rec-a'], `${label}: the turn`);
    assert.deepEqual([b.state, b.turn_id, b.at], ['exact', 'rec-a', { item_id: 'p_rec-a' }], `${label}: its prompt item, re-keyed with it`);
  };
  await check(h.mirror, 'live');
  await sleep(300);
  await h.stop();
  const b = boot(t, { world: h.world });
  await b.mirror.start();
  b.publish('SessionStart', { session: { source: 'resume' } });
  await waitUntil(async () => { const x = await b.mirror.turn('hook-a'); return x && x.turn ? x : null; }, { timeout: 8000, what: 'the restored turn' });
  await check(b.mirror, 'after a restart');
});

// ── gone, never orphaned ─────────────────────────────────────────────────────

test('a missing turn, an unknown conversation and a quote no longer found answer unavailable; no answer is ever orphaned', async (t) => {
  withTempHome(t);
  const h = await world(t);
  const turn = (await h.mirror.recordAnchor({ kind: 'turn', turn_id: 'ca-1' })).anchor;
  const range = (await h.range('another quote that we anchor on.')).anchor;
  const batch = [
    { id: 'missing-turn', v: 1, anchor: { ...turn, turn_id: 'no-such-turn' } },
    { id: 'unknown-conversation', v: 1, anchor: { ...turn, conversation_id: '99999999-9999-4999-8999-999999999999', turn_id: 'gone-turn' } },
    { id: 'missing-item', v: 1, anchor: { ...range, item_id: 'r_msg_gone' } },
    { id: 'not-found', v: 1, anchor: { ...range, fp: { h: '0'.repeat(FP_HEX), len: 1 }, quote: { exact: 'zq xv wk yj nothing like it at all', prefix: '', suffix: '' } } },
    { id: 'bad', v: 1, anchor: null },
    { id: 'expired-kind', v: 1, anchor: { ...turn, kind: 'nobody' } },
  ];
  const answers = await h.mirror.resolveAnchors(batch);
  const by = Object.fromEntries(answers.map((a) => [a.id, a]));
  for (const a of answers) {
    assertAnswer(a, a.id);
    assert.equal(a.visible, 'unavailable', `${a.id}: unavailable`);
  }
  assert.equal(by['missing-turn'].rule, 'gone');
  assert.equal(by['unknown-conversation'].rule, 'gone');
  assert.equal(by['missing-item'].rule, 'gone');
  assert.equal(by['not-found'].how, 'not-found');
  assert.equal(by['expired-kind'].rule, 'kind', 'a kind nobody registered');
  assert.equal(by.bad.rule, 'invalid');
  assert.deepEqual(await h.mirror.resolveAnchors('nope'), []);
});

// ── a list never waits ───────────────────────────────────────────────────────

test('REQ@list-never-waits: while the transcripts source says indexing, every anchor answers indexing with zero reads; memory is not consulted', async (t) => {
  withTempHome(t);
  const spy = { busy: false, calls: {}, indexing: () => spy.busy };
  const h = await world(t, { spy });
  const recs = {
    turn: (await h.mirror.recordAnchor({ kind: 'turn', turn_id: 'ca-1' })).anchor,
    item: (await h.mirror.recordAnchor({ kind: 'item', item_id: h.replyId })).anchor,
    range: (await h.range('the end anchor is here.')).anchor,
  };
  const batch = Object.entries(recs).map(([id, anchor]) => ({ id, v: 1, anchor }));
  for (const a of await h.mirror.resolveAnchors(batch)) assert.equal(a.visible, 'placed', a.id);
  for (const a of await h.mirror.resolveAnchors(batch)) assert.equal(a.visible, 'placed', a.id); // memory holds them now
  spy.busy = true;
  const calls = { ...spy.calls };
  const stats = h.mirror.stats().model;
  const answers = await h.mirror.resolveAnchors(batch);
  for (const a of answers) {
    assertAnswer(a, a.id);
    assert.deepEqual(Object.keys(a), ['id', 'state', 'visible', 'explain'], `${a.id}: indexing, from the pin's own record`);
    assert.equal(a.state, 'indexing');
  }
  assert.deepEqual(spy.calls, calls, 'ZERO engine.read calls (turn, itemField, turns) while indexing');
  assert.deepEqual(h.mirror.stats().model, stats, 'nothing parsed or refilled');
  spy.busy = false;
  for (const a of await h.mirror.resolveAnchors(batch)) assert.equal(a.visible, 'placed', a.id);
  assert.ok(spy.calls.itemField > calls.itemField, 'the reads come back with the conversation');
});

// ── redactOut, no served text ────────────────────────────────────────────────

test('every resolveAnchors and recordAnchor answer passes redactOut: no fake secret, no host path, and no answer carries served text', async (t) => {
  withTempHome(t);
  const h = boot(t);
  await h.begin();
  const fakes = fakeSecrets({ seed: 14 }).filter((f) => !f.context && !f.known).slice(0, 12);
  const words = `Here is what I found in ${h.root}/lib/x.js: ${fakes.map((f) => f.text).join(' and ')} — that is all of it.`;
  const r = h.records(51);
  r.prompt(`please look at ${fakes[0].text}`, { promptId: 'sec-1' });
  r.assistant([words]);
  r.turnDuration({ durationMs: 40 });
  h.append(r.records);
  await settled(h, 1);
  const reply = (await h.items('sec-1')).find((it) => it.kind === 'reply');
  const served = (await h.mirror.itemField(reply.id, { field: 'text' })).text;
  const tail = served.indexOf('that is all of it.');
  const out = [
    await h.mirror.recordAnchor({ kind: 'turn', turn_id: 'sec-1' }),
    await h.mirror.recordAnchor({ kind: 'item', item_id: reply.id }),
    await h.mirror.recordAnchor({ kind: 'item-range', item_id: reply.id, pos: { start: 0, end: Math.min(served.length, 1500) } }),
    await h.mirror.recordAnchor({ kind: 'item-range', item_id: reply.id, pos: { start: tail, end: tail + 10 } }),
  ];
  for (const x of out) assert.ok(x.anchor, 'recorded');
  const answers = await h.mirror.resolveAnchors(out.map((x, i) => ({ id: `k${i}`, v: 1, anchor: x.anchor })));
  for (const a of answers) assertAnswer(a, a.id);
  const text = JSON.stringify([out, answers]);
  assert.deepEqual(findLeaks(text, fakes), [], 'no fake secret in any answer');
  assert.ok(!text.includes(h.root), 'no project root');
  assert.ok(out[2].anchor.quote.exact.includes('<project>'), 'the host path as a reader is served it');
  // Answers carry offsets, ids and the EXPLAIN line, never served text.
  const quotes = out.map((x) => x.anchor.quote.exact).filter((q) => q.length >= 8);
  for (const a of answers) {
    const flat = JSON.stringify(a);
    for (const q of quotes) assert.ok(!flat.includes(q.slice(0, 8)), `${a.id}: no quote text`);
    for (const v of Object.values(a)) if (typeof v === 'string') assert.ok(v.length <= 200, `${a.id}: a short string field`);
  }
});

// ── memory ───────────────────────────────────────────────────────────────────

test('memory: a second resolve of an unchanged pin is a hit; a batch of its conversation drops it; resolve writes nothing under .web-chat/', async (t) => {
  withTempHome(t);
  const h = await world(t);
  const recs = {
    turn: (await h.mirror.recordAnchor({ kind: 'turn', turn_id: 'ca-1' })).anchor,
    item: (await h.mirror.recordAnchor({ kind: 'item', item_id: h.toolId })).anchor,
    range: (await h.range('the end anchor is here.')).anchor,
  };
  const batch = Object.entries(recs).map(([id, anchor]) => ({ id, v: 1, anchor }));
  await sleep(500);
  const files = listing(path.join(h.root, '.web-chat'));
  const d0 = h.diag();
  const first = await h.mirror.resolveAnchors(batch);
  const d1 = h.diag();
  assert.equal(d1.memory_hits, d0.memory_hits, 'the first resolve matches');
  assert.equal(d1.memory, 3, 'three answers kept');
  const second = await h.mirror.resolveAnchors(batch);
  const d2 = h.diag();
  assert.equal(d2.memory_hits, d1.memory_hits + 3, 'the second is three memory hits');
  assert.deepEqual(second, first, 'the same answers');
  assert.equal(d2.resolves, d0.resolves + 6);
  assert.ok(d2.states.exact >= 6);
  // Another version of the element is no hit.
  await h.mirror.resolveAnchors([{ id: 'range', v: 2, anchor: recs.range }]);
  assert.equal(h.diag().memory_hits, d2.memory_hits);
  assert.deepEqual(listing(path.join(h.root, '.web-chat')), files, 'resolve wrote nothing under .web-chat/');
  // A batch about the conversation: memory dropped.
  const n = h.r.records.length;
  h.r.prompt('third prompt', { promptId: 'ca-3' });
  h.r.assistant(['third reply']);
  h.r.turnDuration({ durationMs: 40 });
  h.append(h.r.records.slice(n));
  await settled(h, 3);
  await waitUntil(() => h.diag().memory === 0 || null, { timeout: 4000, what: 'memory dropped' });
  const d3 = h.diag();
  await h.mirror.resolveAnchors(batch);
  assert.equal(h.diag().memory_hits, d3.memory_hits, 'no hit after the batch');
  for (const v of Object.values(h.mirror.snapshot({}).diagnostics.chat_anchors.states)) assert.equal(typeof v, 'number');
});

test('memory is bounded: MEMORY_MAX entries, least recently used out', async () => {
  const turns = new Map();
  const model = { resolveTurn: (id) => id, turn: (id) => turns.get(id) || ((turns.set(id, { id, conversation_id: 'c1', session_id: 's1' })), turns.get(id)), item: () => null, turnsOf: () => [] };
  const probe = { kind: 'probe', record: () => ({ invalid: true, hint: 'no' }), resolve: (a, k) => k.memo.get(a.turn_id) || k.memo.set(a.turn_id, k.answer('exact', { how: 'id' })) };
  const inst = createChatAnchorsSource({ kinds: [probe] }).attach({ model, read: {}, indexing: () => false, log: () => {} });
  const anchor = (i) => ({ v: 1, kind: 'probe', conversation_id: 'c1', session_id: 's1', turn_id: `t${i}` });
  const batch = [];
  for (let i = 0; i <= MEMORY_MAX; i++) batch.push({ id: `e${i}`, v: 1, anchor: anchor(i) });
  await inst.api.resolve(batch);
  assert.equal(inst.diagnostics().chat_anchors.memory, MEMORY_MAX);
  await inst.api.resolve([{ id: 'e0', v: 1, anchor: anchor(0) }, { id: `e${MEMORY_MAX}`, v: 1, anchor: anchor(MEMORY_MAX) }]);
  assert.equal(inst.diagnostics().chat_anchors.memory_hits, 1, 'the oldest went; the newest is a hit');
  inst.onChanges('s1', [], { conversation_id: 'c1' });
  assert.equal(inst.diagnostics().chat_anchors.memory, 0, 'a batch of the conversation drops it all');
  await inst.api.resolve([{ id: 'e1', v: 1, anchor: anchor(1) }]);
  inst.onChanges('s9', [{ type: 'rekey', of: 'turn', from: 'a', to: 'b', conversation_id: 'c1' }], { conversation_id: 'c9' });
  assert.equal(inst.diagnostics().chat_anchors.memory, 0, 'a rekey of the conversation drops it');
  await inst.stop();
});

// ── registerKind ─────────────────────────────────────────────────────────────

test('registerKind: a kind passed through the `kinds` option records and resolves, its note passes unchanged; a duplicate or a bad name is refused', async (t) => {
  withTempHome(t);
  const NOTE = 'the code diff for this turn is still being prepared';
  const probe = {
    kind: 'probe-line',
    async record(input, k) {
      const turn = k.turnOf(input.turn_id);
      if (!turn) return k.unavailable('gone');
      return { anchor: { v: 1, kind: 'probe-line', conversation_id: turn.conversation_id, session_id: turn.session_id, turn_id: turn.id,
        quote: { exact: 'x', prefix: '', suffix: '' }, marks: 0, label: 'probe line 1', file: 'a.md', side: 'new', line: 1, line_fp: { h: '0123456789abcdef' } } };
    },
    resolve: (anchor, k) => k.answer('indexing', { how: 'diff-pending', note: NOTE, at: { file: anchor.file, side: anchor.side, line: anchor.line } }),
  };
  const h = await world(t, { chatAnchors: createChatAnchorsSource({ kinds: [probe] }) });
  const made = await h.mirror.recordAnchor({ kind: 'probe-line', turn_id: 'ca-2' });
  assert.equal(made.anchor.kind, 'probe-line');
  assert.equal(made.anchor.turn_id, 'ca-2');
  const [a, b] = await h.mirror.resolveAnchors([{ id: 'p1', v: 1, anchor: made.anchor }, { id: 'p2', v: 1, anchor: { ...made.anchor, kind: 'unregistered' } }]);
  assertAnswer(a, 'p1');
  assert.deepEqual(a, { id: 'p1', state: 'indexing', visible: 'indexing', explain: EXPLAIN.indexing, how: 'diff-pending',
    at: { file: 'a.md', side: 'new', line: 1 }, turn_id: 'ca-2', note: NOTE }, 'the note through resolveAnchors and redactOut, unchanged');
  assert.deepEqual([b.state, b.rule], ['unavailable', 'kind']);
  assert.ok(h.diag().kinds.includes('probe-line'));

  const engine = { model: {}, read: {}, indexing: () => false, log: () => {} };
  assert.throws(() => createChatAnchorsSource({ kinds: [{ ...probe, kind: 'turn' }] }).attach(engine), /already registered/);
  assert.throws(() => createChatAnchorsSource({ kinds: [{ ...probe, kind: 'Bad Name' }] }).attach(engine), /lowercase word/);
  assert.throws(() => createChatAnchorsSource({ kinds: [{ kind: 'half', record: () => ({}) }] }).attach(engine), /record\(input, k\), resolve\(anchor, k\)/);
  const inst = createChatAnchorsSource().attach(engine);
  inst.api.registerKind('late-kind', probe);
  assert.throws(() => inst.api.registerKind('late-kind', probe), /already registered/);
});
