// One known set per response (U634; plan.json 5B.4, the GT-13 learning race;
// K.5 J2 and C-13's learned-later clause; corrective to U589 and U415c).
//
// The daemon exactly as createServer wires it (withServer). Through its
// `redactor` getter the test registers a known source with maxAgeMs 0 (so an
// unpinned redactor consults it on EVERY call) that answers null for its first
// k consults and the value after. Pins holding the value are written while it
// is unknown (stored plain), so every occurrence a response serves is masked
// at read or not at all. For each seed one request is made with the source so
// armed:
//   * GET /api/elements (comments, highlights and the chat tail together):
//     every occurrence of the value in the body is masked, or none is — 0
//     straddled bodies over 200 seeds — and the next GET masks all;
//   * GET /api/elements?type=chat-comment through the chat tail (chat pins
//     over a synthetic transcript: test-support/claude-home, claude-records),
//     the same;
//   * a PATCH that edits a highlight: the element:highlight frame it emits
//     (a local socket's) carries the value masked in every record, or in none.
// k is seeded over 1..K, K the consults an unpinned response makes (counted
// with the source never answering, floored at FLOOR so a pinned build still
// spans the old boundaries). Red with only the getter applied (the routes
// composing over many unpinned calls): straddled bodies > 0.
// A test never requires design/ (CI has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { withServer, tmpRoot, waitUntil } = require('../test-support/helpers');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords } = require('../test-support/claude-records');
const { findLeaks } = require('../test-support/fake-secrets');
const client = require('../lib/client');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { MASK } = require('../lib/core/redact');

const S1 = '11111111-1111-4111-8111-111111116340';
const SEEDS = 200;
const FLOOR = 64;
const LABEL = 'u634-known';
const WAIT = { timeout: 15000, interval: 20 };
const CALL_TIMEOUT_MS = 15000;
const PROMPT = 'please read a.md and say what it holds';
const REPLY = 'It holds two parts. The end anchor is here.';
const PANE_TEXT = 'The staging host takes a token for access now.';

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
const learned = (value) => [{ id: 'learned', rule: 'known', secrets: [value] }];
// A body's reading: `plain` when it serves any fragment of the value, `masked`
// when it serves the value's mask; straddled when both.
function reading(body, value) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const plain = findLeaks(raw, learned(value)).length > 0;
  const masked = raw.includes(MASK(LABEL));
  return { plain, masked, straddled: plain && masked };
}
function rangeIn(mount, text, exact) {
  const at = text.indexOf(exact);
  const quote = { exact, prefix: text.slice(Math.max(0, at - 32), at), suffix: text.slice(at + exact.length, at + exact.length + 32) };
  return { v: 1, kind: 'range', mount, quote, pos: { start: at, end: at + exact.length } };
}

// The armed source: off (null) for `k` consults after arm(k), then the value;
// count() the consults since the last arm. `never()` answers null throughout.
function armedSource(value) {
  let mode = 'never';
  let left = 0;
  let calls = 0;
  const fn = () => {
    calls++;
    if (mode === 'on') return value;
    if (mode === 'never') return null;
    if (left > 0) { left--; return null; }
    return value;
  };
  return {
    fn,
    arm(k) { mode = 'armed'; left = k; calls = 0; },
    never() { mode = 'never'; calls = 0; },
    on() { mode = 'on'; calls = 0; },
    count: () => calls,
  };
}

// The project, its daemon, a closed turn in its chat mirror, and the pins:
// two comments (one with a reply) and two highlights holding the value, two
// chat pins holding it, and a highlight the PATCH loop edits.
async function world(t) {
  const root = tmpRoot('wc-u634-');
  const ch = claudeHome(t, { root, isolate: true });
  const d = await withServer(t, { root });
  const value = `wcpinned${crypto.randomBytes(12).toString('hex')}`;
  const call = { port: d.port, noSpawn: true, timeout: CALL_TIMEOUT_MS };
  let clock = Date.now();
  const stamp = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
  const env = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
  const envelope = (event, extra = {}) => hookEnvelope({
    hook_event_name: event, session_id: S1, transcript_path: ch.transcript(S1), cwd: ch.cwd, permission_mode: 'default', ...extra,
  }, env, { now: stamp() });
  const fire = async (event, extra) => {
    const r = await client.post('/api/hooks/event', envelope(event, extra), call);
    assert.equal(r.ok, true, `hook ${event}`);
  };
  ch.writeTranscript(S1, []);
  await fire('SessionStart', { source: 'startup', model: 'claude-test' });
  const r = createRecords({ seed: 634, sessionId: S1, cwd: ch.cwd, start: Date.now() - 60000, step: 50 });
  const begin = envelope('UserPromptSubmit', { prompt: PROMPT, prompt_id: 'pv-1' });
  assert.equal((await client.post('/api/turn-begin', { message: PROMPT, author: 'user', ...sessionFields(begin), prompt: begin.prompt }, call)).ok, true);
  r.prompt(PROMPT, { promptId: 'pv-1' });
  r.assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/a.md' }, id: 'toolu_01PvRead' }]);
  r.toolResult('toolu_01PvRead', 'file a');
  r.assistant([REPLY]);
  r.turnDuration({ durationMs: 200, messageCount: 4 });
  ch.writeTranscript(S1, r.records);
  const stop = envelope('Stop', { last_assistant_message: REPLY });
  await client.post('/api/turn-end', { author: 'claude', reply: REPLY, ended: 'stop', ...sessionFields(stop), last_assistant_message: stop.stop.last_assistant_message }, call);
  const items = await waitUntil(async () => {
    const x = await d.srv.mirror.turn('pv-1');
    const its = x ? x.items : [];
    return its.some((it) => it.kind === 'reply' && it.source === 'transcript') && its.some((it) => it.kind === 'tool_call') ? its : null;
  }, { ...WAIT, what: 'pv-1\'s transcript reply and tool card' });
  const reply = items.find((it) => it.kind === 'reply' && it.source === 'transcript');
  const card = items.find((it) => it.kind === 'tool_call');

  // The source, on the daemon's own redactor (the getter), answering nothing yet.
  const src = armedSource(value);
  assert.ok(d.srv.redactor && typeof d.srv.redactor.addKnownSource === 'function', 'createServer answers its redactor');
  assert.equal(d.srv.redactor.addKnownSource(src.fn, LABEL, { maxAgeMs: 0 }), true);

  // The pins, written while the value is unknown (stored plain).
  await ok(d.api.post('/api/render', { id: 'm-pin', html: `<p>${PANE_TEXT}</p>` }), 'render');
  const anchor = rangeIn('m-pin', PANE_TEXT, 'takes a token');
  const c1 = (await ok(d.anonApi.post('/api/elements', { type: 'comment', anchor, payload: { text: `first ${value}`, shared: true } }), 'comment 1')).element;
  await ok(d.anonApi.post(`/api/elements/${c1.id}/reply`, { text: `reply ${value}` }), 'reply');
  await ok(d.anonApi.post('/api/elements', { type: 'comment', anchor, payload: { text: `second ${value}`, shared: true } }), 'comment 2');
  await ok(d.anonApi.post('/api/elements', { type: 'highlight', anchor, payload: { note: `note ${value}` } }), 'highlight 1');
  await ok(d.anonApi.post('/api/elements', { type: 'highlight', anchor, payload: { note: `again ${value}` } }), 'highlight 2');
  const edited = (await ok(d.anonApi.post('/api/elements', { type: 'highlight', anchor, payload: { note: 'edit 0' } }), 'the edited highlight')).element;
  const chat = async (a, text) => (await ok(d.anonApi.post('/api/elements', { type: 'chat-comment', anchor: a, payload: { text, shared: true } }), 'a chat pin')).element;
  await chat({ kind: 'item', item_id: reply.id }, `chat ${value}`);
  await chat({ kind: 'item', item_id: card.id }, `card ${value}`);
  // Precondition: stored plain, so a read with the value unknown serves it whole.
  src.never();
  const before = (await ok(d.anonApi.get('/api/elements'), 'GET')).elements;
  const raw = JSON.stringify(before);
  assert.equal(raw.split(value).length - 1, 7, 'the seven texts serve the value plain while it is unknown');
  assert.equal(before.filter((e) => e.type === 'chat-comment').length, 2, 'the chat tail is in the read');
  return { ...d, src, value, edited };
}

// K: the consults one request makes unpinned is at most this; floored.
async function spanOf(w, request) {
  w.src.never();
  await request();
  return Math.max(w.src.count(), FLOOR);
}

// One seeded loop: arm k, make the request, read what it served; then, the
// source answering the value throughout, the next one masks all.
async function seeded(w, request, what) {
  const K = await spanOf(w, request);
  const straddled = [];
  for (let s = 0; s < SEEDS; s++) {
    const k = 1 + (s % K);
    w.src.arm(k);
    const got = reading(await request(), w.value);
    if (got.straddled) straddled.push(k);
    w.src.on();
    const next = reading(await request(), w.value);
    assert.ok(next.masked && !next.plain, `${what}, seed ${s}: the next one masks all`);
  }
  return { K, straddled };
}

test('one GET /api/elements, one /api/elements?type=chat-comment and one element frame are each served under ONE known set', { timeout: 300000 }, async (t) => {
  const w = await world(t);

  await t.test('GET /api/elements (page records and the chat tail): 0 straddled bodies over 200 seeds', async () => {
    const get = async () => (await ok(w.anonApi.get('/api/elements'), 'GET')).elements;
    const { K, straddled } = await seeded(w, get, 'GET /api/elements');
    t.diagnostic(`GET /api/elements: K=${K}, straddled ${straddled.length}/${SEEDS}`);
    assert.deepEqual(straddled, [], `no body mixes the value masked and plain (k: ${straddled.join(',')})`);
  });

  await t.test('GET /api/elements?type=chat-comment (the chat tail alone): 0 straddled bodies over 200 seeds', async () => {
    const get = async () => (await ok(w.anonApi.get('/api/elements?type=chat-comment'), 'GET chat')).elements;
    const { K, straddled } = await seeded(w, get, 'GET ?type=chat-comment');
    t.diagnostic(`GET ?type=chat-comment: K=${K}, straddled ${straddled.length}/${SEEDS}`);
    assert.deepEqual(straddled, [], `no chat body mixes the value masked and plain (k: ${straddled.join(',')})`);
  });

  await t.test('a PATCH on a highlight: its element:highlight frame carries the value masked in every record or in none, over 200 seeds', async () => {
    const frames = [];
    const sock = w.ws();
    t.after(() => { try { sock.terminate(); } catch {} });
    sock.on('message', (data) => {
      let m = null;
      try { m = JSON.parse(data.toString()); } catch {}
      if (m && m.type === 'element:highlight') frames.push(m);
    });
    await new Promise((resolve, reject) => { sock.once('open', resolve); sock.once('error', reject); });
    let n = 0;
    const patch = async () => {
      n++;
      const note = `edit ${n}`;
      await ok(w.anonApi.patch(`/api/elements/${w.edited.id}`, { payload: { note } }), 'PATCH');
      return waitUntil(() => frames.find((f) => (f.elements || []).some((e) => e.id === w.edited.id && e.note === note)), { ...WAIT, what: `the frame of ${note}` });
    };
    const { K, straddled } = await seeded(w, patch, 'the PATCH frame');
    t.diagnostic(`element:highlight frames: K=${K}, straddled ${straddled.length}/${SEEDS}`);
    assert.deepEqual(straddled, [], `no frame mixes the value masked and plain (k: ${straddled.join(',')})`);
  });
});
