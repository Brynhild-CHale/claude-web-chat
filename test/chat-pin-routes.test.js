// Creating and serving chat pins through the element routes (PLAN.md 3A.1's
// route half; DECISIONS.md D3, D4, D5, L1, L4, L6; RULED CHAT@type a,
// REQ@list-never-waits a, REQ@visible-states a, U406@private-chain-member
// Q8 a, U416@chat-chain-liveness S3-confirm a; U416).
//
// The daemon exactly as createServer wires it (withServer), over a scratch git
// repository (test-support/treesnap-fixture, so a turn's code diff is
// recorded) with a private Claude tier (test-support/claude-home) fed only
// synthetic transcripts (test-support/claude-records, rewind-fixtures) and v1
// hook envelopes posted to the hook intake and the turn routes. Pinned:
//   * POST a chat-comment on a turn, an item (a reply, a tool card), an
//     item-range (pos in the reply's served text) and a diff line: each 200,
//     its anchor recorded by the mirror from served text (a client quote and
//     label ignored), placed, with its anchor_label;
//   * D3: on an rh_ reply and on a provisional turn, 409 {state:
//     'provisional', hint} and the element log's bytes unchanged;
//   * GET: every chat record carries state, visible and explain (U414's
//     table); ONE resolveAnchors per request whatever the number of pins (a
//     spy on ctx.mirror, the handlers mounted over the daemon's own engines);
//     ?mount= and ?node= list none; a mirror answering nothing serves each
//     record unavailable from its own record;
//   * served states: a rewind → superseded; a value learned from a
//     session_context record inside a pinned passage → masked, no body holding
//     it; a pin on a turn the mirror never had → unavailable, its quote kept;
//   * PATCH text and shared, reply (user and Claude), DELETE (a drop record):
//     the frames carry each record's answer, and the next frame lacks the
//     deleted pin; PATCH {anchor} 400; an edit from an older v 409 (stale);
//     a page Wipe and New graph leave the pin listed (WIPE@chat);
//   * a private chat pin's Send takes the shared edit first; since and
//     shared_only filter the chat records; a record made with no session
//     takes its served turn's, and a turn with none answers 409;
//   * private: a private chat pin is absent for a remote viewer and lib/client,
//     and every write naming it from them answers 404;
//   * the chain (S3, Q8): a chat pin chained on another lands; a dropped chat
//     id is refused 400; a private member reads 'a private element' for a
//     reader who does not see private records, and the events carry
//     chain_private; a remote read socket's element:chat-comment frame nulls
//     a private page member and a private member deleted since (CHAIN_PRIVATE,
//     K.2-164), the local socket keeping every id.
// A test never requires design/ (CI has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');
const { withServer, waitUntil } = require('../test-support/helpers');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords, jsonl } = require('../test-support/claude-records');
const { treesnapRepo } = require('../test-support/treesnap-fixture');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const rewindFixtures = require('../test-support/rewind-fixtures');
const client = require('../lib/client');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { INTAKE_EVENTS } = require('../lib/server/routes/hooks');
const { mountElementRoutes } = require('../lib/server/routes/elements');
const { VISIBLE, EXPLAIN } = require('../lib/core/anchor-states');
const { SCHEMAS } = require('../lib/core/element-log');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths, projectPaths } = require('../lib/core/paths');
const { WRITER_HEADER } = require('../lib/core/writer-token');

const S1 = '11111111-1111-4111-8111-111111114160';
const S2 = '22222222-2222-4222-8222-222222224160';
const CHAT = Object.keys(SCHEMAS).find((s) => SCHEMAS[s].type === 'chat-comment');
const WAIT = { timeout: 15000, interval: 20 };
const CALL_TIMEOUT_MS = 15000;
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});

const FAKES = fakeSecrets();
const EMAIL = FAKES.find((x) => x.id === 'known-email');
const E = EMAIL.secrets[0];

const PROMPT = 'please bump the answer and read a.md first';
const READ_INPUT = { file_path: '/tmp/project/a.md' };
// The email sits more than a quote's context (32 characters) away from PASSAGE.
const REPLY = `Done. Contact ${E} for access to the staging host. Later on, the end anchor is here.`;
const PASSAGE = 'the end anchor is here.';
const SECRET_PASSAGE = `Contact ${E} for access`;
// A passage 12 characters after the email: its quote's 32-character prefix
// holds the email's tail, not the whole value.
const NEIGHBOUR = 'to the staging host';
const FORGED = { exact: 'a forged quote', prefix: '', suffix: '' };

const SIX = ['placed', 'refused', 'superseded', 'masked', 'indexing', 'unavailable'];
const logBytes = (root) => { try { return fs.readFileSync(projectPaths(root).elementsLog, 'utf8'); } catch { return ''; } };
const logRecords = (root) => logBytes(root).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}

// Every chat record carries one of L4's six states with its one line.
function assertAnswered(e, label) {
  assert.ok(SIX.includes(e.visible), `${label}: ${e.visible} is one of the six`);
  assert.equal(e.visible, VISIBLE[e.state], `${label}: visible is VISIBLE[state] (${e.state})`);
  assert.equal(e.explain, EXPLAIN[e.visible], `${label}: its EXPLAIN line`);
}

// The project, its daemon (a remote viewer opted in at full), a WS client
// that keeps every element:chat-comment frame, and Claude Code's side.
async function world(t) {
  const repo = treesnapRepo(t, { files: { 'src/app.js': 'const answer = 41;\n', 'README.md': 'chat pins\n' } });
  const root = repo.root;
  const ch = claudeHome(t, { root, isolate: true });
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(root)]: 'full' } } });
  const d = await withServer(t, { root, writePortfile: true, seed });
  const call = { port: d.port, noSpawn: true, timeout: CALL_TIMEOUT_MS };
  let clock = Date.now();
  const stamp = () => { clock = Math.max(clock + 1, Date.now()); return clock; };
  const env = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
  const envelope = (event, extra = {}, sid = S1) => hookEnvelope({
    hook_event_name: event, session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd, permission_mode: 'default', ...extra,
  }, env, { now: stamp() });
  // The hook intake is the host's (lib/client, as the mirror hook posts).
  const post = async (e) => { const r = await client.post('/api/hooks/event', e, call); assert.equal(r.ok, true, `hook ${e.event}`); };
  const fire = (event, extra, sid) => post(envelope(event, extra, sid));
  const turnBegin = (promptId, text, sid = S1) => {
    const e = envelope('UserPromptSubmit', { prompt: text, prompt_id: promptId }, sid);
    return client.post('/api/turn-begin', { message: text, author: 'user', ...sessionFields(e), prompt: e.prompt }, call);
  };
  const turnEnd = (reply, sid = S1) => {
    const e = envelope('Stop', { last_assistant_message: reply }, sid);
    return client.post('/api/turn-end', { author: 'claude', reply, ended: 'stop', ...sessionFields(e), last_assistant_message: e.stop.last_assistant_message }, call);
  };
  const snapshots = async () => {
    const s = await client.get('/api/mirror', call);
    return (s.diagnostics && s.diagnostics.git && s.diagnostics.git.snapshots) || 0;
  };
  const items = async (turnId) => { const x = await d.srv.mirror.turn(turnId); return x ? x.items : []; };

  // The element:chat-comment frames a local socket gets.
  const frames = [];
  const sock = d.ws();
  t.after(() => { try { sock.terminate(); } catch {} });
  await new Promise((resolve, reject) => { sock.once('open', resolve); sock.once('error', reject); });
  sock.on('message', (data) => {
    let m = null;
    try { m = JSON.parse(data.toString()); } catch {}
    if (m && m.type === 'element:chat-comment') frames.push(m);
  });

  // Turn cp-1: a Read card, an Edit of src/app.js (its code diff), the reply.
  ch.writeTranscript(S1, []);
  await fire('SessionStart', { source: 'startup', model: 'claude-test' });
  const r = createRecords({ seed: 416, sessionId: S1, cwd: ch.cwd, start: Date.now() - 60000, step: 50 });
  const seen = await snapshots();
  assert.equal((await turnBegin('cp-1', PROMPT)).ok, true);
  await waitUntil(async () => (await snapshots()) > seen, { ...WAIT, what: 'cp-1\'s before-snapshot' });
  const appJs = path.join(root, 'src', 'app.js');
  const edit = { file_path: appJs, old_string: 'const answer = 41;', new_string: 'const answer = 42;' };
  await fire('PreToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_01CpEdit', tool_input: edit });
  repo.write('src/app.js', 'const answer = 42;\n');
  await fire('PostToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_01CpEdit', tool_input: edit, tool_response: { filePath: appJs }, duration_ms: 3 });
  r.prompt(PROMPT, { promptId: 'cp-1' });
  r.assistant([{ type: 'tool_use', name: 'Read', input: READ_INPUT, id: 'toolu_01CpRead' }]);
  r.toolResult('toolu_01CpRead', 'file a');
  r.assistant([{ type: 'tool_use', name: 'Edit', input: edit, id: 'toolu_01CpEdit' }]);
  r.toolResult('toolu_01CpEdit', `The file ${appJs} has been updated.`);
  r.assistant([REPLY]);
  r.turnDuration({ durationMs: 200, messageCount: 6 });
  ch.writeTranscript(S1, r.records);
  await turnEnd(REPLY);
  await waitUntil(async () => {
    const p = await client.get(`/api/mirror/conversations/${S1}/turns?limit=50&items=full`, call);
    const x = (p.turns || []).find((y) => y.id === 'cp-1');
    return x && x.status !== 'open' && x.code && x.code.status === 'ready'
      && (x.items || []).some((it) => it.kind === 'reply' && it.source === 'transcript') ? x : null;
  }, { ...WAIT, what: 'cp-1 closed, its code ready and the transcript\'s reply in' });
  const its = await items('cp-1');
  const reply = its.find((it) => it.kind === 'reply' && it.source === 'transcript');
  const card = its.find((it) => it.kind === 'tool_call' && it.tool === 'Read') || its.find((it) => it.kind === 'tool_call');
  assert.ok(reply && card, 'a reply and a tool card');

  // Turn hook-p: a prompt and a Stop the transcript never records — a
  // provisional turn whose reply is the Stop's rh_.
  assert.equal((await turnBegin('hook-p', 'a provisional turn')).ok, true);
  await turnEnd('The stop hook\'s reply.');
  await waitUntil(async () => (await items('hook-p')).some((it) => it.id === 'rh_hook-p'), { ...WAIT, what: 'the Stop\'s rh_ reply' });

  const served = async () => (await d.srv.mirror.itemField(reply.id, { field: 'text' })).text;
  const posOf = async (exact) => {
    const s = await served();
    const at = s.indexOf(exact);
    assert.ok(at >= 0, `the passage is served: ${exact}`);
    return { start: at, end: at + exact.length };
  };
  const pin = (anchor, payload = {}, api = d.anonApi) => api.post('/api/elements', { type: 'chat-comment', anchor, payload: { text: 'a note', shared: true, ...payload } });
  const list = async (q = '?type=chat-comment', api = d.anonApi) => (await ok(api.get(`/api/elements${q}`), `GET ${q}`)).elements;
  const lib = (method, p, body, headers = {}, { token = false } = {}) => client.request(d.port, method, p, body, {
    headers: { ...headers, ...(token ? { [WRITER_HEADER]: d.writerToken() } : {}) }, timeout: CALL_TIMEOUT_MS,
  });
  return { ...d, repo, ch, r, call, post, fire, envelope, turnBegin, turnEnd, items, frames, reply, card, served, posOf, pin, list, lib };
}

// The daemon's own engines under a second app, the mirror wrapped (a spy).
async function spyApp(t, w, mirror) {
  const ctx = {
    state: w.srv.state, bus: w.srv.bus, audience: w.srv.audience, writers: w.srv.writers, graph: w.srv.graph,
    elementTypes: w.srv.elementTypes, mirror,
  };
  const app = express();
  app.use(express.json());
  mountElementRoutes(app, ctx);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (method, p, body) => client.request(server.address().port, method, p, body, { timeout: CALL_TIMEOUT_MS });
}

// A chat anchor record as U414 makes one, on a turn this mirror never had.
const GONE_ANCHOR = Object.freeze({
  v: 1, kind: 'item-range', conversation_id: 'conv-u416-gone', session_id: 'sess-u416-gone', turn_id: 't_gone', item_id: 'r_t_gone_0', field: 'text',
  quote: { exact: 'two parts', prefix: 'The plan has ', suffix: '.' }, pos: { start: 13, end: 22 },
  fp: { h: '0123456789abcdef', len: 48 }, marks: 0, label: 'turn 9\'s reply',
});

test('chat pins through the element routes, end to end', { timeout: 180000 }, async (t) => {
  const w = await world(t);
  const ids = {};

  await t.test('POST: a turn, a reply, a tool card, a passage and a diff line — each anchor recorded from served text, placed, labelled', async () => {
    const before = w.srv.elements.maxSeq();
    const cases = [
      ['turn', { kind: 'turn', turn_id: 'cp-1', quote: FORGED, label: 'forged' }, 'on turn 1', PROMPT],
      ['reply', { kind: 'item', item_id: w.reply.id, quote: FORGED }, 'on turn 1\'s reply', null],
      ['card', { kind: 'item', item_id: w.card.id, quote: FORGED }, `on tool card ${w.card.tool}`, null],
      ['passage', { kind: 'item-range', item_id: w.reply.id, pos: await w.posOf(PASSAGE), quote: FORGED }, `on turn 1's reply: "${PASSAGE}"`, PASSAGE],
      ['diff', { kind: 'diff-line', turn_id: 'cp-1', file: 'src/app.js', side: 'new', line: 1, quote: FORGED }, 'on diff line src/app.js:1', '+const answer = 42;'],
    ];
    for (const [name, anchor, label, exact] of cases) {
      const body = await ok(w.pin(anchor, { text: `on the ${name}` }), `POST ${name}`);
      const el = body.element;
      ids[name] = el.id;
      assert.equal(el.type, 'chat-comment', name);
      assert.equal(el.schema, CHAT, name);
      assert.match(el.id, /^k\d+$/, `${name}: a chat id`);
      assert.equal(el.anchor.kind, anchor.kind, name);
      assert.equal(el.anchor.conversation_id, S1, `${name}: the model's conversation`);
      assert.equal(el.anchor.session_id, S1, `${name}: the model's session`);
      assert.notEqual(el.anchor.quote.exact, FORGED.exact, `${name}: the client's quote is never read`);
      assert.notEqual(el.anchor.label, 'forged', `${name}: nor its label`);
      if (exact) assert.equal(el.anchor.quote.exact, exact, `${name}: the served text's quote`);
      assert.equal(el.anchor_label, label, `${name}: anchor_label`);
      assert.equal(el.state, 'exact', `${name}: placed exact`);
      assertAnswered(el, name);
      assert.deepEqual(el.chain, [], `${name}: no chain`);
    }
    // The served text: the reply's own head, the card's input.
    const reply = (await w.list()).find((e) => e.id === ids.reply);
    assert.ok(REPLY.startsWith(reply.anchor.quote.exact.slice(0, 5)), 'the reply\'s head');
    assert.deepEqual(reply.at, { item_id: w.reply.id });
    assert.equal((w.srv.state.elements || []).filter((r) => /^k/.test(r)).length, 0, 'no reference on the surface (no putRef)');
    assert.ok(w.srv.elements.maxSeq() > before);
  });

  await t.test('D3: an rh_ reply and a provisional turn answer 409 {state: provisional, hint}; nothing is minted', async () => {
    const bytes = logBytes(w.root);
    const seq = w.srv.elements.maxSeq();
    for (const anchor of [
      { kind: 'item', item_id: 'rh_hook-p' },
      { kind: 'item-range', item_id: 'rh_hook-p', pos: { start: 0, end: 4 } },
      { kind: 'turn', turn_id: 'hook-p' },
    ]) {
      const r = await w.pin(anchor);
      assert.equal(r.status, 409, `${JSON.stringify(anchor)}: ${r.text}`);
      assert.deepEqual(r.json, { error: 'provisional', state: 'provisional', hint: EXPLAIN.refused });
    }
    assert.equal(logBytes(w.root), bytes, 'the element log\'s bytes are unchanged');
    assert.equal(w.srv.elements.maxSeq(), seq, 'no id minted');
    // The other refusals: a page anchor on a chat type, a chat anchor on a
    // page type, a malformed request, a target the mirror has not got.
    assert.equal((await w.pin({ mount: 'm1', selector: 'p', text: 'x', ordinal: 0 })).status, 400);
    const page = await w.anonApi.post('/api/elements', { type: 'highlight', anchor: { kind: 'turn', turn_id: 'cp-1' }, payload: { note: 'n' } });
    assert.equal(page.status, 400, page.text);
    assert.equal(page.json.error, 'a chat anchor on a page element');
    assert.equal((await w.pin({ kind: 'item-range', item_id: w.reply.id, pos: { start: 3, end: 3 } })).status, 400);
    const gone = await w.pin({ kind: 'turn', turn_id: 'no-such-turn' });
    assert.equal(gone.status, 404, gone.text);
    assert.equal(gone.json.error, 'not found');
    assert.equal(logBytes(w.root), bytes, 'still nothing written');
  });

  await t.test('GET: one resolveAnchors per request whatever the number of pins; ?mount= and ?node= list none; a silent mirror serves each record unavailable', async () => {
    let calls = 0;
    const real = w.srv.mirror;
    const spy = {
      recordAnchor: (input) => real.recordAnchor(input),
      turn: (id) => real.turn(id),
      resolveAnchors: (batch) => { calls += 1; return real.resolveAnchors(batch); },
    };
    const at = await spyApp(t, w, spy);
    const chat = (await at('GET', '/api/elements?type=chat-comment')).body.elements;
    assert.ok(chat.length >= 5, `the pins: ${chat.length}`);
    assert.equal(calls, 1, 'one batched resolve for the request');
    for (const e of chat) assertAnswered(e, e.id);
    await at('GET', '/api/elements');
    assert.equal(calls, 2, 'one more for a read of every type');
    await at('GET', '/api/elements?type=comment');
    assert.equal(calls, 2, 'none for a read without a chat type');
    const byMount = (await at('GET', '/api/elements?mount=m1')).body.elements;
    assert.equal(byMount.filter((e) => e.type === 'chat-comment').length, 0, '?mount= lists no chat pin');
    assert.equal(calls, 2, 'and resolves nothing');
    // A node: a pane, a turn that commits it.
    await ok(w.api.post('/api/turn-begin', { message: 'a node' }), 'turn-begin');
    await ok(w.api.post('/api/render', { id: 'cp-pane', html: '<p>a pane</p>' }), 'render');
    const node = (await ok(w.api.post('/api/turn-end', { author: 'claude' }), 'turn-end')).node_id;
    assert.ok(node, 'a node committed');
    const byNode = (await at('GET', `/api/elements?node=${encodeURIComponent(node)}`)).body.elements;
    assert.equal(byNode.filter((e) => e.type === 'chat-comment').length, 0, '?node= lists no chat pin');
    assert.equal(calls, 2);
    // A mirror stopped or off answers {unavailable: true}: each record is served from its own record.
    const silent = await spyApp(t, w, { ...spy, resolveAnchors: async () => ({ unavailable: true }) });
    const off = (await silent('GET', '/api/elements?type=chat-comment')).body;
    assert.equal(off.elements.length, chat.length);
    for (const e of off.elements) {
      assert.deepEqual([e.state, e.visible, e.explain], ['unavailable', 'unavailable', EXPLAIN.unavailable], e.id);
      assert.ok(e.anchor.quote.exact && e.anchor_label, `${e.id}: its quote and label still served`);
    }
    assert.equal(typeof off.respond_hint, 'string', 'respond_hint rides a chat read');
    // A facade with no recordAnchor at all: a create answers 503.
    const none = await spyApp(t, w, { resolveAnchors: spy.resolveAnchors });
    const r = await none('POST', '/api/elements', { type: 'chat-comment', anchor: { kind: 'turn', turn_id: 'cp-1' }, payload: { text: 'x' } });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, 'mirror unavailable');
  });

  await t.test('served states: a pin on a turn the mirror never had is unavailable, its quote kept', async () => {
    const gone = w.srv.elements.addElement({ type: 'chat-comment', schema: CHAT, payload: { text: 'old', shared: true, replies: [], anchor: GONE_ANCHOR, chain: [] }, author: 'user' });
    const e = (await w.list()).find((x) => x.id === gone.id);
    assert.equal(e.state, 'unavailable');
    assertAnswered(e, 'gone');
    assert.equal(e.anchor.quote.exact, 'two parts', 'its quote readable');
    assert.equal(e.anchor_label, 'on turn 9\'s reply: "two parts"');
    ids.gone = gone.id;
  });

  await t.test('PATCH, reply, DELETE and the frames: each frame carries every record\'s answer', async () => {
    const id = ids.passage;
    const nFrames = () => w.frames.length;
    let n = nFrames();
    const edited = await ok(w.anonApi.patch(`/api/elements/${id}`, { text: 'edited words' }), 'PATCH text');
    assert.equal(edited.element.text, 'edited words');
    assert.equal(edited.element.state, 'exact');
    const v2 = edited.element.v;
    await waitUntil(() => nFrames() > n, { ...WAIT, what: 'the edit\'s frame' });
    const last = () => w.frames[w.frames.length - 1];
    for (const e of last().elements) assertAnswered(e, `frame ${e.id}`);
    assert.ok(last().elements.some((e) => e.id === id && e.text === 'edited words'));

    const priv = await ok(w.anonApi.patch(`/api/elements/${id}`, { shared: false }), 'PATCH shared');
    assert.equal(priv.element.shared, false);
    await ok(w.anonApi.patch(`/api/elements/${id}`, { shared: true }), 'PATCH shared back');
    const stale = await w.anonApi.patch(`/api/elements/${id}`, { text: 'from an older read', base_v: v2 });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.json.error, 'stale version');
    assert.equal(stale.json.hint, 'the element changed since you read it: read it again and retry');
    const re = await w.anonApi.patch(`/api/elements/${id}`, { anchor: { kind: 'turn', turn_id: 'cp-1' } });
    assert.equal(re.status, 400, re.text);
    assert.equal(re.json.error, 'a chat pin is not re-anchored');

    const since = w.srv.bus.read({ since: 0 }).events.length ? w.srv.bus.read({ since: 0 }).events.slice(-1)[0].seq : 0;
    const user = await ok(w.anonApi.post(`/api/elements/${id}/reply`, { text: 'a user reply', author: 'user' }), 'reply user');
    const claude = await ok(w.api.post(`/api/elements/${id}/reply`, { text: 'Claude\'s answer', author: 'claude' }), 'reply claude');
    assert.deepEqual(claude.element.replies.map((x) => [x.author, x.text]), [['user', 'a user reply'], ['claude', 'Claude\'s answer']]);
    assert.equal(user.element.state, 'exact');
    const replies = w.srv.bus.read({ since }).events.filter((e) => e.kind === 'element' && e.type === 'chat-comment' && e.op === 'reply');
    assert.deepEqual(replies.map((e) => [e.id, e.author, e.mount]), [[id, 'user', null], [id, 'claude', null]], 'each reply event carries its author (the self-wake gate)');
    const unverified = await w.anonApi.post(`/api/elements/${id}/reply`, { text: 'not Claude', author: 'claude' });
    assert.equal(unverified.status, 403, 'author claude needs Claude\'s writer token');

    n = nFrames();
    const del = await ok(w.anonApi.del(`/api/elements/${ids.card}`), 'DELETE');
    assert.equal(del.removed, ids.card);
    assert.ok(logRecords(w.root).some((x) => x.t === 'drop' && x.id === ids.card), 'a drop record in the log');
    await waitUntil(() => nFrames() > n, { ...WAIT, what: 'the delete\'s frame' });
    assert.ok(!last().elements.some((e) => e.id === ids.card), 'the next frame lacks the deleted pin');
    for (const e of last().elements) assertAnswered(e, `frame ${e.id}`);
    assert.ok(!(await w.list()).some((e) => e.id === ids.card), 'GET lacks it');
    assert.equal((await w.anonApi.del(`/api/elements/${ids.card}`)).status, 404, 'a second Delete');
    assert.equal((await w.anonApi.patch(`/api/elements/${ids.card}`, { text: 'x' })).status, 404, 'an edit of a dropped pin');
  });

  await t.test('WIPE@chat end to end: a page Wipe and New graph leave every chat pin listed', async () => {
    const before = (await w.list()).map((e) => e.id).sort();
    await ok(w.api.post('/api/graph/wipe', {}), 'wipe');
    assert.deepEqual((await w.list()).map((e) => e.id).sort(), before, 'after a Wipe');
    await ok(w.api.post('/api/graph/new', {}), 'new graph');
    assert.deepEqual((await w.list()).map((e) => e.id).sort(), before, 'after New graph');
  });

  await t.test('send: a shared chat pin\'s Send to Claude answers 200 with its item', async () => {
    const sent = await ok(w.anonApi.post(`/api/elements/${ids.turn}/send`, { device: 'desktop' }), 'send');
    assert.equal(typeof sent.item.id, 'string');
    assert.equal(sent.element.id, ids.turn);
    assertAnswered(sent.element, 'send');
  });

  await t.test('send: a private chat pin first takes the shared edit, then answers 200 with its item', async () => {
    const mine = (await ok(w.pin({ kind: 'turn', turn_id: 'cp-1' }, { text: 'mine, then sent', shared: false }), 'private pin')).element;
    assert.equal(mine.shared, false);
    const sent = await ok(w.anonApi.post(`/api/elements/${mine.id}/send`, { device: 'desktop' }), 'send a private chat pin');
    assert.equal(typeof sent.item.id, 'string', 'the shared edit raised its item');
    assert.equal(sent.element.shared, true, 'it is shared now');
    assertAnswered(sent.element, 'private send');
  });

  await t.test('GET: since and shared_only filter the chat records', async () => {
    const cursor = (await ok(w.anonApi.get('/api/elements?type=chat-comment'), 'GET')).next_cursor;
    const fresh = (await ok(w.pin({ kind: 'turn', turn_id: 'cp-1' }, { text: 'after the cursor' }), 'a shared pin')).element;
    const hidden = (await ok(w.pin({ kind: 'turn', turn_id: 'cp-1' }, { text: 'a private one after the cursor', shared: false }), 'a private pin')).element;
    const after = await w.list(`?type=chat-comment&since=${cursor}`);
    assert.deepEqual(after.map((e) => e.id).sort(), [fresh.id, hidden.id].sort(), 'since: only the records written after the cursor');
    for (const e of after) assertAnswered(e, `since ${e.id}`);
    const shared = await w.list('?type=chat-comment&shared_only=1');
    assert.ok(shared.length > 0 && shared.every((e) => e.shared !== false), 'shared_only: no private chat record');
    assert.ok(!shared.some((e) => e.id === hidden.id) && shared.some((e) => e.id === fresh.id));
    await ok(w.anonApi.del(`/api/elements/${hidden.id}`), 'tidy: drop the private one');
  });

  await t.test('frames: two chat writes whose resolves finish out of order still emit in write order — the last frame is the live set', async () => {
    const a = (await ok(w.pin({ kind: 'turn', turn_id: 'cp-1' }, { text: 'first to go' }), 'pin a')).element;
    const b = (await ok(w.pin({ kind: 'turn', turn_id: 'cp-1' }, { text: 'second to go' }), 'pin b')).element;
    const real = w.srv.mirror;
    let held = false;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const spy = {
      recordAnchor: (input) => real.recordAnchor(input),
      turn: (id) => real.turn(id),
      resolveAnchors: async (batch) => {
        if (!held) { held = true; await gate; }
        return real.resolveAnchors(batch);
      },
    };
    const at = await spyApp(t, w, spy);
    const n = w.frames.length;
    const pa = at('DELETE', `/api/elements/${a.id}`);
    await waitUntil(() => held, { ...WAIT, what: 'the first Delete\'s resolve held' });
    const pb = at('DELETE', `/api/elements/${b.id}`);
    await waitUntil(() => logRecords(w.root).some((x) => x.t === 'drop' && x.id === b.id), { ...WAIT, what: 'the second Delete written' });
    release();
    const [ra, rb] = await Promise.all([pa, pb]);
    assert.equal(ra.status, 200, JSON.stringify(ra.body));
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    await waitUntil(() => w.frames.length >= n + 2, { ...WAIT, what: 'both Deletes\' frames' });
    const live = w.srv.elements.chatRecords('chat-comment').map((r) => r.id).sort();
    const last = w.frames[w.frames.length - 1].elements.map((e) => e.id).sort();
    assert.ok(!live.includes(a.id) && !live.includes(b.id), 'both pins dropped');
    assert.deepEqual(last, live, 'the last frame is read after the last write');
  });

  await t.test('POST: an anchor recorded with no session takes its served turn\'s, and a turn with none is still arriving (409, nothing minted)', async () => {
    const real = w.srv.mirror;
    const headless = async (input) => {
      const made = await real.recordAnchor(input);
      return made && made.anchor ? { ...made, anchor: { ...made.anchor, session_id: null } } : made;
    };
    const filled = await spyApp(t, w, { recordAnchor: headless, turn: (id) => real.turn(id), resolveAnchors: (b) => real.resolveAnchors(b) });
    const r = await filled('POST', '/api/elements', { type: 'chat-comment', anchor: { kind: 'turn', turn_id: 'cp-1' }, payload: { text: 'a headless record' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.element.anchor.session_id, S1, 'the served turn\'s session');
    const bytes = logBytes(w.root);
    const none = await spyApp(t, w, { recordAnchor: headless, turn: async () => null, resolveAnchors: (b) => real.resolveAnchors(b) });
    const p = await none('POST', '/api/elements', { type: 'chat-comment', anchor: { kind: 'turn', turn_id: 'cp-1' }, payload: { text: 'no session yet' } });
    assert.equal(p.status, 409, JSON.stringify(p.body));
    assert.equal(p.body.state, 'provisional');
    assert.equal(logBytes(w.root), bytes, 'nothing written');
    await ok(w.anonApi.del(`/api/elements/${r.body.element.id}`), 'tidy');
  });

  await t.test('private: absent for a remote viewer and lib/client; every write naming it from them answers 404', async () => {
    const priv = (await ok(w.pin({ kind: 'turn', turn_id: 'cp-1' }, { text: 'my own note', shared: false }), 'private pin')).element;
    ids.priv = priv.id;
    assert.equal(priv.shared, false);
    assert.ok((await w.list()).some((e) => e.id === priv.id), 'a local browser sees it');
    for (const [who, headers, opts] of [['remote', REMOTE, {}], ['lib/client', {}, {}], ['lib/client + token', {}, { token: true }]]) {
      const g = await w.lib('GET', '/api/elements?type=chat-comment', null, headers, opts);
      assert.equal(g.status, 200, `${who}: ${JSON.stringify(g.body)}`);
      assert.ok(!g.body.elements.some((e) => e.id === priv.id || e.shared === false), `${who}: no private chat pin`);
      assert.ok(!JSON.stringify(g.body).includes('my own note'), `${who}: no private text`);
      for (const [method, p, body] of [
        ['PATCH', `/api/elements/${priv.id}`, { text: 'x' }],
        ['POST', `/api/elements/${priv.id}/reply`, { text: 'x', author: 'user' }],
        ['POST', `/api/elements/${priv.id}/send`, { device: 'desktop' }],
        ['DELETE', `/api/elements/${priv.id}`, null],
      ]) {
        const r = await w.lib(method, p, body, headers, opts);
        assert.equal(r.status, 404, `${who} ${method} ${p}: ${r.status} ${JSON.stringify(r.body)}`);
        assert.deepEqual(r.body, { error: 'not found', id: priv.id });
      }
    }
  });

  await t.test('the chain (S3, Q8): a chat pin on a chat pin lands; a dropped one is refused; a private member reads \'a private element\'', async () => {
    const on = await ok(w.pin({ kind: 'turn', turn_id: 'cp-1' }, { text: 'on the other pin', chain: [ids.turn] }), 'chained');
    assert.deepEqual(on.element.chain, [ids.turn]);
    assert.equal(on.element.chain_label, `on chat comment ${ids.turn}`);
    const dropped = await w.pin({ kind: 'turn', turn_id: 'cp-1' }, { chain: [ids.card] });
    assert.equal(dropped.status, 400, dropped.text);
    assert.equal(dropped.json.error, 'bad chain');
    assert.equal((await w.pin({ kind: 'turn', turn_id: 'cp-1' }, { chain: ['k999999'] })).status, 400, 'an id the log never had');
    // A private chat pin is not found by a request that does not see private
    // records (C-16-2), in the chat branch of the chain too: Claude's tools
    // cannot name one in a chain (nor learn that it exists), and nothing is minted.
    const seqBefore = w.srv.elements.maxSeq();
    const probe = await w.lib('POST', '/api/elements', { type: 'chat-comment', anchor: { kind: 'turn', turn_id: 'cp-1' }, payload: { text: 'a probe', shared: true, chain: [ids.priv] } }, {}, { token: true });
    assert.equal(probe.status, 400, `a private chat member from Claude's tools: ${JSON.stringify(probe.body)}`);
    assert.equal(probe.body.error, 'bad chain');
    assert.equal(w.srv.elements.maxSeq(), seqBefore, 'nothing minted');

    const since = w.srv.bus.read({ since: 0 }).events.slice(-1)[0].seq;
    const mixed = await ok(w.pin({ kind: 'turn', turn_id: 'cp-1' }, { text: 'over a private one', chain: [ids.priv, ids.turn] }), 'chained on a private pin');
    const local = (await w.list()).find((e) => e.id === mixed.element.id);
    assert.deepEqual(local.chain, [ids.priv, ids.turn], 'a local browser sees every member');
    assert.equal(local.chain_label, `on chat comment ${ids.priv} › chat comment ${ids.turn}`);
    for (const [who, headers, opts] of [['lib/client (Claude\'s tools)', {}, { token: true }], ['remote', REMOTE, {}]]) {
      const e = (await w.lib('GET', '/api/elements?type=chat-comment', null, headers, opts)).body.elements.find((x) => x.id === mixed.element.id);
      assert.ok(e, who);
      assert.deepEqual(e.chain, [null, ids.turn], `${who}: the private member's id is null`);
      assert.equal(e.chain_label, `on a private element › chat comment ${ids.turn}`, `${who}: no type, no id`);
    }
    const add = w.srv.bus.read({ since }).events.find((e) => e.kind === 'element' && e.op === 'add' && e.id === mixed.element.id);
    assert.deepEqual(add.chain_private, [ids.priv], 'the add event carries the ids-only chain_private');
    const edit = await ok(w.anonApi.patch(`/api/elements/${mixed.element.id}`, { text: 'reworded' }), 'edit chained');
    assert.ok(edit.element);
    const ev = w.srv.bus.read({ since }).events.find((e) => e.kind === 'element' && e.op === 'edit' && e.id === mixed.element.id);
    assert.deepEqual(ev.chain_private, [ids.priv], 'and its edit event');
  });

  // K.2-164 (Q8 a, U406a's rule): the element:chat-comment frame's own list
  // knows only its chat records, so a private PAGE element under a chat pin's
  // chain, and a private chat pin deleted since, are named by the log's answer
  // (domain/elements chainPrivate), which emitElements attaches under
  // CHAIN_PRIVATE. Each is red with that attachment removed.
  await t.test('frames: a remote read socket\'s element:chat-comment frame reads [null, …] for a private page member and a deleted private member; the local socket keeps the ids', async () => {
    const listen = async (headers) => {
      const got = [];
      const sock = new WebSocket(`ws://localhost:${w.port}/ws`, { headers });
      sock.on('message', (data) => { try { got.push(JSON.parse(data.toString())); } catch {} });
      await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
      t.after(() => { try { sock.terminate(); } catch {} });
      await waitUntil(() => got.some((f) => f.type === 'hello'), { ...WAIT, what: 'hello' });
      return got;
    };
    const frameWhere = (got, pred, what) => waitUntil(() => got.filter((f) => f.type === 'element:chat-comment').reverse().find(pred), { ...WAIT, what });
    await ok(w.api.post('/api/render', { id: 'cp-chain', html: '<p>Hello</p>' }), 'render');
    const RANGE = { v: 1, kind: 'range', mount: 'cp-chain', quote: { exact: 'Hello', prefix: '', suffix: '' }, pos: { start: 0, end: 5 } };
    const hp = (await ok(w.anonApi.post('/api/elements', { type: 'highlight', anchor: RANGE, payload: { note: 'wc-u416-private-hl', shared: false } }), 'private highlight')).element.id;
    const kp = (await ok(w.pin({ kind: 'turn', turn_id: 'cp-1' }, { text: 'wc-u416-private-chat', shared: false }), 'private chat pin')).element.id;
    const remote = await listen(REMOTE);
    const local = await listen({});
    const chained = (await ok(w.pin({ kind: 'turn', turn_id: 'cp-1' }, { text: 'over a private highlight and a private chat pin', chain: [hp, kp, ids.turn] }), 'chained')).element.id;
    const has = (f) => f.elements.some((e) => e.id === chained);
    const chainIn = (f) => f.elements.find((e) => e.id === chained).chain;
    assert.deepEqual(chainIn(await frameWhere(local, has, 'local frame')), [hp, kp, ids.turn], 'the local socket keeps every id');
    assert.deepEqual(chainIn(await frameWhere(remote, has, 'remote frame')), [null, null, ids.turn], 'a remote read socket: the private highlight and chat pin null');
    // The private chat pin deleted: no longer in the frame's own list.
    await ok(w.anonApi.del(`/api/elements/${kp}`), 'delete the private chat pin');
    const gone = (f) => has(f) && !f.elements.some((e) => e.id === kp);
    assert.deepEqual(chainIn(await frameWhere(local, gone, 'local frame after the delete')), [hp, kp, ids.turn], 'the local socket still keeps every id');
    assert.deepEqual(chainIn(await frameWhere(remote, gone, 'remote frame after the delete')), [null, null, ids.turn], 'a remote read socket: the deleted private member null');
    const sent = JSON.stringify(remote.filter((f) => f.type === 'element:chat-comment'));
    assert.ok(!sent.includes(`"${hp}"`) && !sent.includes(`"${kp}"`), 'neither private id is in any chat frame the remote socket got');
    await ok(w.anonApi.del(`/api/elements/${chained}`), 'tidy');
  });

  await t.test('served states: a rewind in the terminal supersedes a pinned turn', async () => {
    const f = rewindFixtures.branch({ sessionId: S2, start: Date.now() - 60000 });
    w.ch.writeTranscript(S2, []);
    const base = { sessionId: S2, transcriptPath: w.ch.transcript(S2), cwd: w.ch.cwd };
    for (const hook of f.hooks) {
      if (INTAKE_EVENTS.includes(hook.event)) await w.post(rewindFixtures.envelope(hook, base));
    }
    const cut = f.records.findIndex((x) => x.promptId === 'rw-4');
    w.ch.writeTranscript(S2, f.records.slice(0, cut));
    await waitUntil(async () => { const x = await w.srv.mirror.turn('rw-3'); return x && x.turn && x.turn.status !== 'open'; }, { ...WAIT, what: 'rw-3 closed' });
    const pinned = (await ok(w.pin({ kind: 'turn', turn_id: 'rw-2' }, { text: 'on a turn to be rewound' }), 'pin rw-2')).element;
    assert.equal(pinned.state, 'exact');
    fs.appendFileSync(w.ch.transcript(S2), jsonl(f.records.slice(cut)));
    const e = await waitUntil(async () => {
      const x = (await w.list()).find((y) => y.id === pinned.id);
      return x && x.state === 'superseded' ? x : null;
    }, { ...WAIT, what: 'the pin superseded' });
    assertAnswered(e, 'superseded');
    assert.equal(e.explain, EXPLAIN.superseded);
    assert.equal(e.anchor_label, 'on turn 2');
  });

  let neighbour = null;
  await t.test('served states: a session_context record teaching an email inside a pinned passage → masked, and no body holds it', async () => {
    const made = (await ok(w.pin({ kind: 'item-range', item_id: w.reply.id, pos: await w.posOf(SECRET_PASSAGE) }, { text: 'about the contact' }), 'pin the passage')).element;
    assert.equal(made.state, 'exact', 'placed before the value is known');
    neighbour = (await ok(w.pin({ kind: 'item-range', item_id: w.reply.id, pos: await w.posOf(NEIGHBOUR) }, { text: 'next to it' }), 'pin the neighbour')).element;
    assert.ok(findLeaks(JSON.stringify(logRecords(w.root).find((x) => x.id === neighbour.id && x.payload).payload.anchor.quote.prefix), [EMAIL]).length, 'precondition: the neighbour\'s stored prefix holds the email\'s tail');
    w.r.sessionContext({ userEmail: E });
    w.ch.writeTranscript(S1, w.r.records);
    const e = await waitUntil(async () => {
      const x = (await w.list()).find((y) => y.id === made.id);
      return x && x.state === 'masked' ? x : null;
    }, { ...WAIT, what: 'the pin masked' });
    assertAnswered(e, 'masked');
    for (const [who, get] of [
      ['local', () => w.anonApi.get('/api/elements')],
      ['lib/client', () => w.lib('GET', '/api/elements', null, {}, { token: true })],
      ['remote', () => w.lib('GET', '/api/elements?type=chat-comment', null, REMOTE)],
    ]) {
      const r = await get();
      const body = r.json || r.body;
      // Every record but the neighbour's (its context has its own test below).
      const text = JSON.stringify({ ...body, elements: body.elements.filter((x) => x.id !== neighbour.id) });
      const leaks = findLeaks(text, [EMAIL]);
      assert.deepEqual(leaks, [], `${who}: no body holds the email: ${leaks.map((l) => text.slice(Math.max(0, l.at - 200), l.at + 40)).join(' | ')}`);
      const mine = body.elements.find((x) => x.id === made.id);
      if (mine) assert.ok(!JSON.stringify(mine).includes('@example.com'), `${who}: the masked pin's record never shows it`);
    }
  });

  // U416@learned-later-context, closed by U415a (DECISIONS K.2-164): a passage
  // beside a value learned after it was pinned keeps the value's tail in its
  // stored quote's 32-character prefix; the read view (domain/elements.js
  // maskQuoteContext) masks that fragment at every read, the log unchanged.
  await t.test('a passage beside a value learned later: its quote context holds no fragment of the value', async () => {
    const e = (await w.list('?type=chat-comment', w.anonApi)).find((x) => x.id === neighbour.id);
    assert.deepEqual(findLeaks(JSON.stringify(e), [EMAIL]), [], 'the neighbour\'s record holds no fragment of the email');
  });
});
