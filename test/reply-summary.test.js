// D7 — a node records Claude's side of the turn, not only the prompt.
//
// The Stop hook (lib/hooks/turn-end) reads the final assistant message from its
// payload (`last_assistant_message`, else the tail of `transcript_path`), sends
// a short summary (lib/core/reply summarizeReply) with /api/turn-end, and the
// daemon stores it as `trigger.reply` on the committed node — or on the folded
// entry, for a turn that changed nothing, which then rides onto the next node.
// No payload → no field at all.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer, tmpRoot } = require('../test-support/helpers');
const { REPLY_SUMMARY_MAX, summarizeReply } = require('../lib/core/reply');
const { replySummary, lastAssistantText } = require('../lib/hooks/reply');
const turnEnd = require('../lib/hooks/turn-end');

const PROBE = { probeMs: 5000 };

// ── summarizeReply ─────────────────────────────────────────────────────────

test('summarizeReply collapses whitespace and caps at REPLY_SUMMARY_MAX with an ellipsis', () => {
  assert.equal(summarizeReply('  Done.\n\n  Fixed   the\tbug.  '), 'Done. Fixed the bug.');
  const long = 'word '.repeat(200);
  const s = summarizeReply(long);
  assert.equal(Array.from(s).length, REPLY_SUMMARY_MAX);
  assert.ok(s.endsWith('…'));
  assert.equal(summarizeReply(s), s, 'a summary is a fixed point — the daemon re-applying it changes nothing');
  assert.equal(summarizeReply('x'.repeat(REPLY_SUMMARY_MAX)), 'x'.repeat(REPLY_SUMMARY_MAX), 'exactly at the cap is not cut');
});

test('summarizeReply never splits a code point and refuses non-strings', () => {
  const s = summarizeReply('😀'.repeat(400));
  assert.equal(Array.from(s).length, REPLY_SUMMARY_MAX);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s), 'no lone high surrogate');
  for (const v of [undefined, null, 42, {}, ['a'], '   \n ']) assert.equal(summarizeReply(v), '');
});

// ── reading the reply out of the hook payload ──────────────────────────────

function transcript(lines) {
  const dir = tmpRoot('wc-reply-');
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}
const user = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const toolResult = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
const asst = (id, blocks, extra = {}) => ({ type: 'assistant', ...extra, message: { id, role: 'assistant', content: blocks } });
const text = (t) => ({ type: 'text', text: t });
const toolUse = () => ({ type: 'tool_use', id: 't', name: 'Bash', input: {} });

test('lastAssistantText: the final message of THIS turn, its text blocks joined', () => {
  const file = transcript([
    user('first prompt'),
    asst('m0', [text('the OLD reply')]),
    user('second prompt'),
    asst('m1', [text('Let me look.')]),
    asst('m1', [toolUse()]),
    toolResult(),
    asst('m2', [text('Fixed it.')]),
    asst('m2', [text('Tests pass.')]),
    asst('sub', [text('a subagent said this')], { isSidechain: true }),
    { type: 'system', content: 'hook ran' },
  ]);
  assert.equal(lastAssistantText(file), 'Fixed it.\nTests pass.');

  // Two text messages back to back: only the LAST message is the reply.
  const back = transcript([user('p'), asst('a1', [text('Checking.')]), asst('a2', [text('Done.')])]);
  assert.equal(lastAssistantText(back), 'Done.');
});

test('lastAssistantText: a turn with no text reply does not borrow the previous turn\'s', () => {
  const file = transcript([
    user('first'),
    asst('m0', [text('earlier answer')]),
    user('second'),
    asst('m1', [toolUse()]),
    toolResult(),
  ]);
  assert.equal(lastAssistantText(file), '');
});

test('lastAssistantText: reads only the tail, and survives a cut first line and a missing file', () => {
  const file = transcript([
    user('p'),
    asst('pad', [text('x'.repeat(5000))]),
    user('q'),
    asst('m9', [text('the end')]),
  ]);
  assert.equal(lastAssistantText(file, { tailBytes: 200 }), 'the end', 'the torn first line of the tail is skipped');
  assert.equal(lastAssistantText(path.join(tmpRoot('wc-reply-'), 'nope.jsonl')), '');
});

test('replySummary prefers last_assistant_message, falls back to the transcript, else empty', () => {
  const file = transcript([user('p'), asst('m', [text('from   the\ntranscript')])]);
  assert.equal(replySummary({ last_assistant_message: 'direct\n reply', transcript_path: file }), 'direct reply');
  assert.equal(replySummary({ last_assistant_message: '   ', transcript_path: file }), 'from the transcript');
  assert.equal(replySummary({ transcript_path: file }), 'from the transcript');
  assert.equal(replySummary({}), '');
  assert.equal(replySummary({ transcript_path: 42 }), '');
});

// ── hook → route → node ────────────────────────────────────────────────────

async function node(api, id) {
  return (await api.get(`/api/graph/node/${id}`)).json;
}

test('hook → /api/turn-end → the committed node carries trigger.reply', async (t) => {
  const { api, root } = await withServer(t, { writePortfile: true });
  await api.post('/api/turn-begin', { message: 'render a plan' });
  await api.post('/api/render', { id: 'p1', html: '<p>plan</p>' });
  await turnEnd({ last_assistant_message: 'Rendered the plan.\n\nTell me what to change.' }, { root, ...PROBE });
  const g = (await api.get('/api/graph')).json;
  assert.equal(g.nodes.length, 1);
  const n = await node(api, g.active);
  assert.equal(n.trigger.message, 'render a plan');
  assert.equal(n.trigger.reply, 'Rendered the plan. Tell me what to change.');
});

test('hook with no reply in the payload → the node has no reply key at all', async (t) => {
  const { api, root } = await withServer(t, { writePortfile: true });
  await api.post('/api/turn-begin', { message: 'render' });
  await api.post('/api/render', { id: 'p1', html: '<p>a</p>' });
  await turnEnd({}, { root, ...PROBE });
  const n = await node(api, (await api.get('/api/graph')).json.active);
  assert.ok(n.trigger, 'committed');
  assert.equal(Object.hasOwn(n.trigger, 'reply'), false);
});

test('the route re-summarises: a long or non-string reply cannot bloat the node', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/turn-begin', { message: 'a' });
  await api.post('/api/render', { id: 'p1', html: '<p>a</p>' });
  await api.post('/api/turn-end', { author: 'claude', reply: 'y '.repeat(5000) });
  let n = await node(api, (await api.get('/api/graph')).json.active);
  assert.equal(Array.from(n.trigger.reply).length, REPLY_SUMMARY_MAX);

  await api.post('/api/turn-begin', { message: 'b' });
  await api.post('/api/render', { id: 'p1', html: '<p>b</p>' });
  await api.post('/api/turn-end', { author: 'claude', reply: { evil: true } });
  n = await node(api, (await api.get('/api/graph')).json.active);
  assert.equal(Object.hasOwn(n.trigger, 'reply'), false);
});

test('a no-change turn\'s reply rides in its folded entry onto the next committed node', async (t) => {
  const { api, root } = await withServer(t, { writePortfile: true });
  await api.post('/api/turn-begin', { message: 'just asking' });
  await turnEnd({ last_assistant_message: 'Here is the answer, in chat.' }, { root, ...PROBE });
  let g = (await api.get('/api/graph')).json;
  assert.equal(g.nodes.length, 0, 'nothing committed');

  await api.post('/api/turn-begin', { message: 'no reply this time' });
  await turnEnd({}, { root, ...PROBE });

  await api.post('/api/turn-begin', { message: 'now render' });
  await api.post('/api/render', { id: 'p1', html: '<p>hi</p>' });
  await turnEnd({ last_assistant_message: 'Rendered.' }, { root, ...PROBE });
  g = (await api.get('/api/graph')).json;
  const n = await node(api, g.active);
  assert.equal(n.trigger.reply, 'Rendered.');
  assert.equal(n.folded.length, 2);
  assert.equal(n.folded[0].message, 'just asking');
  assert.equal(n.folded[0].reply, 'Here is the answer, in chat.');
  assert.equal(Object.hasOwn(n.folded[1], 'reply'), false, 'a folded turn with no reply has no key');

  // …and the replay caption shows both sides.
  const p = (await api.get('/api/replay/path')).json;
  const step = p.steps[p.steps.length - 1];
  assert.equal(step.prompt, 'now render');
  assert.equal(step.reply, 'Rendered.');
  assert.equal(step.folded[0].reply, 'Here is the answer, in chat.');
});

test('the unlocked-turn commit (daemon spawned mid-turn) records the reply too', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'p1', html: '<p>a</p>' });
  const r = await api.post('/api/turn-end', { author: 'claude', reply: 'Started the surface.' });
  assert.equal(r.json.unlocked, true);
  const n = await node(api, r.json.node_id);
  assert.equal(n.trigger.kind, 'unlocked-turn');
  assert.equal(n.trigger.reply, 'Started the surface.');
});
