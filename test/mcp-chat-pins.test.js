// Claude reads and answers chat pins through its MCP tools (PLAN.md 3A.1's MCP
// half; DECISIONS.md L1, L4, L5; RULED CHAT@type a, REQ@list-never-waits a,
// U414@explain-lines Q6 a; J2: private pins never reach Claude's tools; U419).
//
// The REAL get_comments and reply_comment handlers over a withServer daemon,
// lib/mcp/client swapped in the require cache for a stub that calls the
// daemon through withServer's api (the boot's writer token, so Claude's reply
// verifies), as test/comments-store.test.js's S-14 replay does — nothing can
// auto-spawn a daemon. The project has a private Claude tier
// (test-support/claude-home) fed only a synthetic transcript
// (test-support/claude-records) and v1 hook envelopes. Pinned:
//   * with only a comment pin, the default call answers exactly the comment
//     read's output (the request a comment-only read makes first is
//     unchanged, and no chat key appears);
//   * one comment pin and two chat pins (a passage, a tool card) → the
//     default call lists all three in seq order, next_cursor the max;
//     type 'chat-comment' lists the two; mount=m1 lists the comment only and
//     makes no chat read;
//   * each chat pin is the route's own record, passed through: state,
//     visible, explain (anchor-states EXPLAIN) and anchor_label;
//   * a chat pin on a turn the mirror never had (appended through the
//     domain) is listed unavailable, with its quote (L5);
//   * a private chat pin is absent;
//   * reply_comment on a chat pin appends Claude's reply (the route answers
//     the updated record, under `pin`), and a second get_comments shows it;
//   * an older daemon answering 400 'unknown element type' to the chat read
//     (a typed lib/client HttpError) → the default call answers comments
//     only, never a throw; any other refusal still throws;
//   * both descriptions name chat pins, and the tool list is unchanged.
// A test never requires design/ (CI has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer, tmpRoot, waitUntil, commentBody } = require('../test-support/helpers');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords } = require('../test-support/claude-records');
const { mcpTools } = require('../test-support/doc-truth');
const client = require('../lib/client');
const { hookEnvelope } = require('../lib/hooks/envelope');
const { sessionFields } = require('../lib/hooks/turn-begin');
const { VISIBLE, EXPLAIN } = require('../lib/core/anchor-states');
const { SCHEMAS } = require('../lib/core/element-log');

const S1 = '11111111-1111-4111-8111-111111114190';
const CHAT = Object.keys(SCHEMAS).find((s) => SCHEMAS[s].type === 'chat-comment');
const WAIT = { timeout: 15000, interval: 20 };
const CALL_TIMEOUT_MS = 15000;
const ANCHOR = { mount: 'm1', selector: 'p.lead', text: 'Hello', ordinal: 0 };
const PROMPT = 'please read a.md and say what it holds';
const REPLY = 'It holds two parts. The end anchor is here.';
const PASSAGE = 'The end anchor is here.';
const SIX = ['placed', 'refused', 'superseded', 'masked', 'indexing', 'unavailable'];

// A chat anchor record as the mirror makes one, on a turn this mirror never had.
const GONE_ANCHOR = Object.freeze({
  v: 1, kind: 'item-range', conversation_id: 'conv-u419-gone', session_id: 'sess-u419-gone', turn_id: 't_gone', item_id: 'r_t_gone_0', field: 'text',
  quote: { exact: 'two parts', prefix: 'The plan has ', suffix: '.' }, pos: { start: 13, end: 22 },
  fp: { h: '0123456789abcdef', len: 48 }, marks: 0, label: 'turn 9\'s reply',
});

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}

// The real tool modules over a stub lib/mcp/client: `api.get`/`api.post`
// through the daemon, a non-2xx thrown as lib/client's own typed HttpError.
// `tools.intercept(method, path)` may answer first (an older daemon's refusal).
function realTools(t, api) {
  const gets = [];
  const tools = { gets, intercept: null };
  const call = async (method, p, r) => {
    const res = await r;
    if (res.status < 200 || res.status >= 300) throw new client.HttpError(res.status, res.json, method, p);
    return res.json;
  };
  const mcpClientPath = require.resolve('../lib/mcp/client.js');
  const toolPaths = ['../lib/mcp/tools/get_comments.js', '../lib/mcp/tools/reply_comment.js'].map((p) => require.resolve(p));
  const saved = require.cache[mcpClientPath];
  require.cache[mcpClientPath] = {
    id: mcpClientPath, filename: mcpClientPath, loaded: true,
    exports: {
      get: async (p) => {
        gets.push(p);
        if (tools.intercept) { const x = tools.intercept('GET', p); if (x) throw x; }
        return call('GET', p, api().get(p));
      },
      post: (p, body) => call('POST', p, api().post(p, body)),
    },
  };
  for (const p of toolPaths) delete require.cache[p];
  t.after(() => {
    if (saved) require.cache[mcpClientPath] = saved; else delete require.cache[mcpClientPath];
    for (const p of toolPaths) delete require.cache[p];
  });
  const getComments = require('../lib/mcp/tools/get_comments.js');
  const replyComment = require('../lib/mcp/tools/reply_comment.js');
  for (const p of toolPaths) delete require.cache[p];
  return Object.assign(tools, { getComments, replyComment });
}

// The project, its daemon and Claude Code's side: one closed turn whose
// transcript holds a Read tool card and the reply.
async function world(t) {
  const root = tmpRoot('wc-u419-');
  const ch = claudeHome(t, { root, isolate: true });
  const d = await withServer(t, { root });
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
  const r = createRecords({ seed: 419, sessionId: S1, cwd: ch.cwd, start: Date.now() - 60000, step: 50 });
  const begin = envelope('UserPromptSubmit', { prompt: PROMPT, prompt_id: 'mp-1' });
  assert.equal((await client.post('/api/turn-begin', { message: PROMPT, author: 'user', ...sessionFields(begin), prompt: begin.prompt }, call)).ok, true);
  r.prompt(PROMPT, { promptId: 'mp-1' });
  r.assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/a.md' }, id: 'toolu_01MpRead' }]);
  r.toolResult('toolu_01MpRead', 'file a');
  r.assistant([REPLY]);
  r.turnDuration({ durationMs: 200, messageCount: 4 });
  ch.writeTranscript(S1, r.records);
  const stop = envelope('Stop', { last_assistant_message: REPLY });
  await client.post('/api/turn-end', { author: 'claude', reply: REPLY, ended: 'stop', ...sessionFields(stop), last_assistant_message: stop.stop.last_assistant_message }, call);
  const items = await waitUntil(async () => {
    const x = await d.srv.mirror.turn('mp-1');
    const its = x ? x.items : [];
    return its.some((it) => it.kind === 'reply' && it.source === 'transcript') && its.some((it) => it.kind === 'tool_call') ? its : null;
  }, { ...WAIT, what: 'mp-1\'s transcript reply and tool card' });
  const reply = items.find((it) => it.kind === 'reply' && it.source === 'transcript');
  const card = items.find((it) => it.kind === 'tool_call');
  const served = (await d.srv.mirror.itemField(reply.id, { field: 'text' })).text;
  const at = served.indexOf(PASSAGE);
  assert.ok(at >= 0, 'the passage is served');
  const pin = async (anchor, payload) => (await ok(d.api.post('/api/elements', { type: 'chat-comment', anchor, payload: { shared: true, ...payload } }), 'a chat pin')).element;
  return { ...d, reply, card, pos: { start: at, end: at + PASSAGE.length }, pin };
}

function assertAnswered(e, label) {
  assert.equal(e.type, 'chat-comment', label);
  assert.ok(SIX.includes(e.visible), `${label}: ${e.visible} is one of the six`);
  assert.equal(e.visible, VISIBLE[e.state], `${label}: visible is VISIBLE[state] (${e.state})`);
  assert.equal(e.explain, EXPLAIN[e.visible], `${label}: the one table's line`);
  assert.equal(typeof e.anchor_label, 'string', `${label}: anchor_label`);
  assert.ok(e.anchor && e.anchor.quote && typeof e.anchor.quote.exact === 'string', `${label}: its quote`);
}

test('get_comments and reply_comment on chat pins, over a real daemon', { timeout: 120000 }, async (t) => {
  const w = await world(t);
  const tools = realTools(t, () => w.api);
  const { getComments, replyComment, gets } = tools;
  const ids = {};

  await t.test('only a comment pin: the default answer is the comment read\'s, and the comment request goes first', async () => {
    ids.comment = (await ok(w.api.post('/api/elements', commentBody({ text: 'a page note', anchor: ANCHOR })), 'comment')).pin.id;
    gets.length = 0;
    const out = await getComments.handler({});
    assert.equal(gets[0], '/api/elements?type=comment&shared_only=1', 'the comment request, first and unchanged');
    assert.equal(gets[1], '/api/elements?type=chat-comment&shared_only=1', 'then the chat read');
    assert.deepEqual(Object.keys(out), ['comments', 'next_cursor', 'respond_hint']);
    const body = await ok(w.api.get('/api/elements?type=comment&shared_only=1'), 'the comment read');
    assert.equal(JSON.stringify(out), JSON.stringify({ comments: body.elements, next_cursor: body.next_cursor, respond_hint: body.respond_hint }), 'byte-equal to the comment read');
  });

  await t.test('a comment and two chat pins: listed together in seq order, next_cursor the max; type and mount narrow it', async () => {
    ids.passage = (await w.pin({ kind: 'item-range', item_id: w.reply.id, pos: w.pos }, { text: 'on the passage' })).id;
    ids.card = (await w.pin({ kind: 'item', item_id: w.card.id }, { text: 'on the card' })).id;
    const out = await getComments.handler({});
    assert.deepEqual(out.comments.map((e) => e.id), [ids.comment, ids.passage, ids.card], 'all three in seq order');
    const seqs = out.comments.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(out.next_cursor, w.srv.elements.maxSeq(), 'next_cursor is the max');
    assert.ok(out.next_cursor >= Math.max(...seqs));
    assert.equal(typeof out.respond_hint, 'string');
    // Each chat pin is the route's own record, passed through.
    const route = (await ok(w.api.get('/api/elements?type=chat-comment&shared_only=1'), 'the chat read')).elements;
    for (const id of [ids.passage, ids.card]) {
      const e = out.comments.find((x) => x.id === id);
      assertAnswered(e, id);
      assert.equal(e.state, 'exact', `${id}: placed`);
      assert.deepEqual(e, route.find((x) => x.id === id), `${id}: as the route serves it`);
    }
    assert.equal(out.comments.find((x) => x.id === ids.passage).anchor.quote.exact, PASSAGE);
    assert.equal(out.comments.find((x) => x.id === ids.passage).anchor_label, `on turn 1's reply: "${PASSAGE}"`);
    assert.equal(out.comments.find((x) => x.id === ids.card).anchor_label, `on tool card ${w.card.tool}`);

    const chatOnly = await getComments.handler({ type: 'chat-comment' });
    assert.deepEqual(Object.keys(chatOnly), ['comments', 'next_cursor', 'respond_hint']);
    assert.deepEqual(chatOnly.comments.map((e) => e.id), [ids.passage, ids.card], 'type chat-comment lists the two');

    gets.length = 0;
    const scoped = await getComments.handler({ mount: 'm1' });
    assert.deepEqual(scoped.comments.map((e) => e.id), [ids.comment], 'mount=m1 lists the comment only');
    assert.deepEqual(gets, ['/api/elements?type=comment&shared_only=1&mount=m1'], 'and makes no chat read');

    const commentOnly = await getComments.handler({ type: 'comment' });
    assert.deepEqual(commentOnly.comments.map((e) => e.id), [ids.comment], 'type comment lists the page\'s only');

    const after = await getComments.handler({ since: out.comments.find((x) => x.id === ids.passage).seq });
    assert.deepEqual(after.comments.map((e) => e.id), [ids.card], 'since filters both reads');
  });

  await t.test('a chat pin on a turn the mirror never had is listed unavailable, its quote and explain kept (L5)', async () => {
    const gone = w.srv.elements.addElement({ type: 'chat-comment', schema: CHAT, payload: { text: 'old', shared: true, replies: [], anchor: GONE_ANCHOR, chain: [] }, author: 'user' });
    ids.gone = gone.id;
    const e = (await getComments.handler({})).comments.find((x) => x.id === gone.id);
    assert.ok(e, 'listed');
    assertAnswered(e, 'gone');
    assert.equal(e.state, 'unavailable');
    assert.equal(e.explain, EXPLAIN.unavailable);
    assert.equal(e.anchor.quote.exact, 'two parts', 'its quote readable');
    assert.equal(e.anchor_label, 'on turn 9\'s reply: "two parts"');
  });

  await t.test('a private chat pin is absent', async () => {
    const mine = await w.pin({ kind: 'item', item_id: w.card.id }, { text: 'mine alone', shared: false });
    assert.equal(mine.shared, false);
    const all = await getComments.handler({});
    assert.ok(!all.comments.some((e) => e.id === mine.id), 'not in the default list');
    assert.ok(!JSON.stringify(all).includes('mine alone'), 'nor its text');
    assert.ok(!(await getComments.handler({ type: 'chat-comment' })).comments.some((e) => e.id === mine.id), 'nor in the chat read');
  });

  await t.test('reply_comment on a chat pin appends Claude\'s reply; the next get_comments shows it', async () => {
    const r = await replyComment.handler({ id: ids.passage, text: 'answered on the chat' });
    assert.deepEqual(Object.keys(r), ['ok', 'pin']);
    assert.equal(r.ok, true);
    assert.equal(r.pin.id, ids.passage);
    assert.equal(r.pin.type, 'chat-comment');
    assert.deepEqual(r.pin.replies.map((x) => [x.author, x.text]), [['claude', 'answered on the chat']]);
    const again = (await getComments.handler({})).comments.find((x) => x.id === ids.passage);
    assert.deepEqual(again.replies.map((x) => [x.author, x.text]), [['claude', 'answered on the chat']]);
    assertAnswered(again, 'after the reply');
  });

  await t.test('a page comment written after the chat pins: the merge is in seq order, not the comments first', async () => {
    const later = (await ok(w.api.post('/api/elements', commentBody({ text: 'a later page note', anchor: ANCHOR })), 'comment')).pin.id;
    const out = await getComments.handler({});
    const seqs = out.comments.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'seq order across both reads');
    const at = (id) => out.comments.findIndex((e) => e.id === id);
    assert.ok(at(later) > at(ids.card), 'the later comment sits after the chat pins written before it');
    assert.ok(at(ids.comment) < at(ids.card), 'and the first comment before them');
  });

  await t.test('an older daemon: a typed 400 \'unknown element type\' on the chat read → comments only; another refusal throws', async () => {
    tools.intercept = (method, p) => (/type=chat-comment/.test(p)
      ? new client.HttpError(400, { error: 'unknown element type', type: 'chat-comment', hint: 'x' }, method, p) : null);
    const out = await getComments.handler({});
    const body = await ok(w.api.get('/api/elements?type=comment&shared_only=1'), 'the comment read');
    assert.equal(JSON.stringify(out), JSON.stringify({ comments: body.elements, next_cursor: body.next_cursor, respond_hint: body.respond_hint }), 'comments only, as today');
    tools.intercept = (method, p) => (/type=chat-comment/.test(p) ? new client.HttpError(503, { error: 'mirror unavailable' }, method, p) : null);
    await assert.rejects(() => getComments.handler({}), (e) => e.status === 503);
    tools.intercept = null;
  });

  await t.test('the descriptions name chat pins; the tool list is unchanged', () => {
    assert.match(getComments.description, /chat/);
    assert.match(getComments.description, /chat-comment/);
    for (const word of ['placed', 'superseded', 'masked', 'indexing', 'unavailable', 'tool card', 'diff', 'anchor_label', 'explain']) {
      assert.ok(getComments.description.includes(word), `get_comments' description names ${word}`);
    }
    assert.match(getComments.inputSchema.properties.type.description, /chat-comment/);
    assert.match(replyComment.description, /chat/);
    const names = mcpTools();
    assert.equal(names.length, 24);
    assert.ok(names.includes('get_comments') && names.includes('reply_comment'));
  });
});
