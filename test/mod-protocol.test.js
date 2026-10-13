// The mod's wire (lib/core/mod-protocol.js, spec §15.7): the allowlists, the
// event kinds and the validators every side of the bridge reads.
//
// Pinned:
//   * OPS, MOD_COMMANDS, EVENT_KINDS and BRIDGE_ONLY_KINDS are frozen, and are
//     §15.7's lists exactly;
//   * MOD_COMMANDS shares nothing with the config-persisting and panel
//     commands (ruling Q10);
//   * validateOp refuses an unknown op, every forbidden command name, rename
//     with a newline or a leading '/', resume with a non-UUID, a submit whose
//     first non-blank character is '/', a permissionDecision holding
//     'bypassPermissions' anywhere or a destination other than 'session', and
//     any extra key;
//   * the task-id grammar is lib/channel/envelope STOP_TASK_ID_RE's;
//   * validateEvent drops unknown keys, cuts every capped string, keeps only
//     id/name/bounded input of tool_use blocks and tool_use_id/is_error of
//     tool_result blocks, and answers null for an unknown kind;
//   * validateHello takes exactly its eight keys; validateResult its five.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const P = require('../lib/core/mod-protocol');
const { STOP_TASK_ID_RE } = require('../lib/channel/envelope');

const {
  OPS, MOD_COMMANDS, EVENT_KINDS, BRIDGE_ONLY_KINDS, validateOp, validateEvent, validateHello, validateResult,
  DELTA_MAX, TEXT_MAX, INPUT_MAX, ARG_TEXT_MAX,
} = P;

const SID = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607';
const AT = 1790000000000;

// ── the lists ───────────────────────────────────────────────────────────────

test('the lists are frozen and are §15.7\'s, exactly', () => {
  for (const list of [OPS, MOD_COMMANDS, EVENT_KINDS, BRIDGE_ONLY_KINDS]) {
    assert.ok(Object.isFrozen(list));
    assert.throws(() => { 'use strict'; list.push('x'); });
  }
  assert.deepEqual([...OPS], ['abort', 'taskStop', 'submit', 'command', 'fill', 'permissionDecision', 'usage', 'messages']);
  assert.deepEqual([...MOD_COMMANDS], ['plan', 'compact', 'context', 'clear', 'rename', 'resume', 'recap']);
  assert.deepEqual([...EVENT_KINDS], [
    'session.start', 'turn.start', 'turn.step', 'turn.complete', 'tool.call', 'tool.done', 'session.append',
    'session.compact', 'session.measure', 'prompt.submit', 'permission.request', 'permission.settled',
  ]);
  assert.deepEqual([...BRIDGE_ONLY_KINDS], ['session.end', 'diag']);
  assert.equal(EVENT_KINDS.filter((k) => BRIDGE_ONLY_KINDS.includes(k)).length, 0);
  assert.equal(P.MOD_PROTOCOL, 1);
  assert.equal(P.MOD_EVENT, 'ModEvent');
  assert.equal(P.MOD_MIN_CLAUDE, '2.1.287');
  assert.deepEqual(
    [P.BODY_MAX, P.BATCH_MAX, P.DELTA_MAX, P.TEXT_MAX, P.INPUT_MAX, P.ARG_TEXT_MAX, P.OPS_WAIT_MAX_MS, P.FLUSH_MS,
      P.QUEUE_MAX, P.WAITERS_MAX, P.STALE_MS, P.TAP_RATE],
    [65536, 50, 4096, 32768, 8192, 16384, 20000, 100, 32, 32, 60000, 30],
  );
});

test('MOD_COMMANDS is disjoint from the config-persisting and panel commands (Q10)', () => {
  const deny = ['model', 'config', 'permissions', 'autocompact', 'login', 'logout', 'mcp', 'plugin', 'hooks', 'add-dir', 'terminal-setup'];
  assert.deepEqual(MOD_COMMANDS.filter((c) => deny.includes(c)), []);
  for (const name of deny) {
    const r = validateOp('command', { name });
    assert.equal(r.ok, false, name);
    assert.equal(r.refused, 'not-allowed', name);
  }
});

test('lib/core/mod-protocol is a core leaf: it requires only lib/core and node built-ins', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core', 'mod-protocol.js'), 'utf8');
  const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  for (const r of reqs) assert.ok(r.startsWith('./') || !r.includes('/'), r);
  assert.ok(!/CLAUDE_CODE_MESSAGING_TOKEN/.test(src));
});

// ── ops ─────────────────────────────────────────────────────────────────────

test('validateOp: an unknown op, or an op that is not a string, is not-allowed', () => {
  for (const op of ['kill', 'eval', 'Abort', '', null, 7, 'constructor', '__proto__']) {
    const r = validateOp(op, {});
    assert.equal(r.ok, false);
    assert.equal(r.refused, 'not-allowed');
    assert.equal(typeof r.hint, 'string');
  }
});

test('validateOp: the argless ops take nothing, and an extra key is bad-args', () => {
  for (const op of ['abort', 'usage', 'messages']) {
    assert.deepEqual(validateOp(op, {}), { ok: true, args: {} });
    assert.deepEqual(validateOp(op), { ok: true, args: {} });
    assert.equal(validateOp(op, { turnId: 't1' }).refused, 'bad-args');
    assert.equal(validateOp(op, 'x').refused, 'bad-args');
    assert.equal(validateOp(op, [1]).refused, 'bad-args');
  }
});

test('validateOp: taskStop takes STOP_TASK_ID_RE\'s grammar, no more', () => {
  const samples = ['a', 'b3k9x2', 'a'.repeat(64), 'a'.repeat(65), '', 'x y', '../x', 'ab_c-D9', 'é', 'a/b', 'a.b'];
  for (const id of samples) {
    const r = validateOp('taskStop', { task_id: id });
    assert.equal(r.ok, STOP_TASK_ID_RE.test(id), id);
    assert.equal(P.isTaskId(id), STOP_TASK_ID_RE.test(id), id);
  }
  assert.equal(validateOp('taskStop', { task_id: 'b1', agent: 'x' }).refused, 'bad-args');
  assert.equal(validateOp('taskStop', {}).refused, 'bad-args');
});

test('validateOp: submit refuses a slash text, a blank one, an over-long one and any extra key', () => {
  assert.deepEqual(validateOp('submit', { text: 'hello' }), { ok: true, args: { text: 'hello' } });
  assert.equal(validateOp('submit', { text: 'a / b' }).ok, true, 'a slash later on is text');
  for (const text of ['/compact', '  /model opus', '\n\t/clear', '/']) {
    const r = validateOp('submit', { text });
    assert.equal(r.refused, 'bad-args', JSON.stringify(text));
    assert.match(r.hint, /command/);
  }
  for (const text of ['', '   ', 'x'.repeat(ARG_TEXT_MAX + 1), 7, null]) assert.equal(validateOp('submit', { text }).refused, 'bad-args');
  assert.equal(validateOp('submit', { text: 'x'.repeat(ARG_TEXT_MAX) }).ok, true);
  assert.equal(validateOp('submit', { text: 'hi', asUser: true }).refused, 'bad-args');
});

test('validateOp: command — the argless five, rename and resume', () => {
  for (const name of ['plan', 'compact', 'context', 'clear', 'recap']) {
    assert.deepEqual(validateOp('command', { name }), { ok: true, args: { name } });
    assert.deepEqual(validateOp('command', { name, args: '' }), { ok: true, args: { name } });
    assert.equal(validateOp('command', { name, args: 'more' }).refused, 'bad-args', name);
  }
  assert.deepEqual(validateOp('command', { name: 'rename', args: 'fork of n1.12' }), { ok: true, args: { name: 'rename', args: 'fork of n1.12' } });
  for (const args of ['a\nb', '/model', '', ' ', 'x'.repeat(65), 'a\u0000b', 'a‮b', undefined, 5]) {
    assert.equal(validateOp('command', { name: 'rename', args }).refused, 'bad-args', JSON.stringify(args));
  }
  assert.equal(validateOp('command', { name: 'rename', args: 'x'.repeat(64) }).ok, true);
  assert.deepEqual(validateOp('command', { name: 'resume', args: SID.toUpperCase() }), { ok: true, args: { name: 'resume', args: SID } });
  for (const args of ['not-a-uuid', `${SID}x`, '', undefined, '../../x']) {
    assert.equal(validateOp('command', { name: 'resume', args }).refused, 'bad-args', String(args));
  }
  for (const name of ['/plan', 'Plan', 'resume ', 'cost', 'exit', undefined]) {
    assert.equal(validateOp('command', { name }).refused, 'not-allowed', String(name));
  }
  assert.equal(validateOp('command', { name: 'plan', extra: 1 }).refused, 'bad-args');
});

test('validateOp: fill takes 0..ARG_TEXT_MAX characters', () => {
  assert.deepEqual(validateOp('fill', { text: '' }), { ok: true, args: { text: '' } });
  assert.equal(validateOp('fill', { text: '/compact' }).ok, true, 'fill only fills the box; it never submits');
  assert.equal(validateOp('fill', { text: 'x'.repeat(ARG_TEXT_MAX + 1) }).refused, 'bad-args');
  assert.equal(validateOp('fill', { text: 'x', mode: 'append' }).refused, 'bad-args');
});

test('validateOp: permissionDecision never grants a bypass and never writes outside the session', () => {
  const ok = { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] };
  const r = validateOp('permissionDecision', { request_id: 'ask_1', decision: ok });
  assert.equal(r.ok, true);
  assert.deepEqual(r.args.decision, ok);
  assert.notEqual(r.args.decision, ok, 'a copy');
  for (const decision of [
    { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] },
    { behavior: 'allow', deep: { deeper: ['x', { y: 'bypassPermissions' }] } },
    { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'userSettings' }] },
    { behavior: 'allow', updatedPermissions: [{ type: 'addRules', destination: 'localSettings' }] },
    { behavior: 'allow', destination: null },
    { bypassPermissions: true },
  ]) {
    assert.equal(validateOp('permissionDecision', { request_id: 'ask_1', decision }).refused, 'not-allowed', JSON.stringify(decision));
  }
  assert.equal(validateOp('permissionDecision', { request_id: 'a/b', decision: ok }).refused, 'bad-args');
  assert.equal(validateOp('permissionDecision', { request_id: 'ask_1', decision: [] }).refused, 'bad-args');
  assert.equal(validateOp('permissionDecision', { request_id: 'ask_1', decision: { note: 'x'.repeat(9000) } }).refused, 'bad-args');
  assert.equal(validateOp('permissionDecision', { request_id: 'ask_1', decision: ok, extra: 1 }).refused, 'bad-args');
  let deep = {};
  const top = deep;
  for (let i = 0; i < 40; i++) { deep.x = {}; deep = deep.x; }
  assert.equal(validateOp('permissionDecision', { request_id: 'ask_1', decision: top }).refused, 'bad-args');
});

// ── events ──────────────────────────────────────────────────────────────────

test('validateEvent: an unknown kind, or a malformed required field, is null', () => {
  for (const kind of ['tool.result', 'session.receive', '', null, 'constructor']) assert.equal(validateEvent(kind, { at: AT }), null);
  assert.equal(validateEvent('turn.start', null), null);
  assert.equal(validateEvent('turn.start', { at: AT }), null, 'no turn_id');
  assert.equal(validateEvent('turn.start', { at: AT, turn_id: 'a b' }), null);
  assert.equal(validateEvent('turn.step', { at: AT, turn_id: 't', index: -1, delta: 'x' }), null);
  assert.equal(validateEvent('tool.done', { at: AT, tool_use_id: 'tu' }), null, 'no ok');
  assert.equal(validateEvent('permission.settled', { at: AT, request_id: 'r1', by: 'claude' }), null);
  assert.equal(validateEvent('session.append', { at: AT, uuid: 'nope', message: { role: 'user', content: [] } }), null);
});

test('validateEvent: unknown keys are dropped; at and agent_id kept', () => {
  assert.deepEqual(validateEvent('turn.start', { kind: 'turn.start', at: AT, turn_id: 't1', text: 'secret', token: 'x' }),
    { kind: 'turn.start', at: AT, turn_id: 't1' });
  assert.deepEqual(validateEvent('session.start', { at: AT, cwd: '/u/p', agent_id: 'a1' }), { kind: 'session.start', at: AT, agent_id: 'a1' });
  assert.equal(validateEvent('session.start', {}).at, null, 'no at: null');
  assert.deepEqual(validateEvent('prompt.submit', { at: AT, origin: { kind: 'user', as_user: true, x: 1 }, text: 'my prompt' }),
    { kind: 'prompt.submit', at: AT, origin: { kind: 'user', as_user: true } });
  assert.deepEqual(validateEvent('session.end', { at: AT, reason: 'exit', sessionId: SID }), { kind: 'session.end', at: AT, reason: 'exit' });
  assert.deepEqual(validateEvent('permission.settled', { at: AT, request_id: 'r1', by: 'web', decision: {} }),
    { kind: 'permission.settled', at: AT, request_id: 'r1', by: 'web' });
});

test('validateEvent: every capped string is cut at its cap', () => {
  const step = validateEvent('turn.step', { at: AT, turn_id: 't1', index: 3, message_id: 'msg_1', delta: 'd'.repeat(DELTA_MAX + 50) });
  assert.equal(step.delta.length, DELTA_MAX);
  assert.equal(step.message_id, 'msg_1');
  const done = validateEvent('turn.complete', {
    at: AT, turn_id: 't1', reason: 'end_turn', text: 't'.repeat(TEXT_MAX + 1),
    usage: { input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 2, cost: 9, model: 'x' },
  });
  assert.equal(done.text.length, TEXT_MAX);
  assert.deepEqual(done.usage, { input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 2 });
  // A surrogate pair is never split.
  const emoji = validateEvent('turn.step', { at: AT, turn_id: 't1', index: 0, delta: `${'x'.repeat(DELTA_MAX - 1)}😀` });
  assert.equal(emoji.delta.length, DELTA_MAX - 1);
  const call = validateEvent('tool.call', { at: AT, tool_use_id: 'toolu_1', tool: 'Write', input: { file_path: '/p/a', content: 'c'.repeat(5 * 1024 * 1024) } });
  assert.ok(Buffer.byteLength(JSON.stringify(call.input)) <= INPUT_MAX);
  assert.equal(call.input.file_path, '/p/a');
  const req = validateEvent('permission.request', { at: AT, request_id: 'r1', tool: 'Bash', tool_use_id: 'toolu_2', input: { command: 'x'.repeat(20000) } });
  assert.ok(Buffer.byteLength(JSON.stringify(req.input)) <= INPUT_MAX);
});

test('validateEvent: session.append keeps a bounded row — text cut, tool_use id/name/input, tool_result tool_use_id/is_error', () => {
  const ev = validateEvent('session.append', {
    at: AT, uuid: SID, agent_id: 'a1', origin: { kind: 'user' }, door: 'x',
    message: {
      role: 'assistant', id: 'msg_1', model: 'claude-x', usage: { input_tokens: 1 },
      content: [
        { type: 'text', text: 'a'.repeat(TEXT_MAX - 10), citations: [] },
        { type: 'text', text: 'b'.repeat(100) },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls', huge: 'h'.repeat(20000) }, caller: 'x' },
        { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'the output, secret' },
        { type: 'thinking', thinking: 'private', signature: 'sig' },
      ],
    },
  });
  assert.equal(ev.uuid, SID);
  assert.equal(ev.agent_id, 'a1');
  assert.deepEqual(ev.origin, { kind: 'user' });
  assert.equal(ev.door, undefined);
  assert.deepEqual(Object.keys(ev.message), ['role', 'id', 'model', 'content']);
  const [t1, t2, use, res, think] = ev.message.content;
  assert.equal(t1.text.length + t2.text.length, TEXT_MAX, 'the row\'s text, TEXT_MAX in all');
  assert.deepEqual(Object.keys(use), ['type', 'id', 'name', 'input']);
  assert.ok(Buffer.byteLength(JSON.stringify(use.input)) <= INPUT_MAX);
  assert.deepEqual(res, { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false });
  assert.deepEqual(think, { type: 'thinking' });
  assert.ok(!JSON.stringify(ev).includes('secret'));
  assert.ok(!JSON.stringify(ev).includes('private'));
});

test('validateEvent: session.measure keeps numbers only; diag keeps names only', () => {
  assert.deepEqual(validateEvent('session.measure', {
    at: AT, changed: ['context', 'bad name', 7], used: 1200, limit: 200000, name: 'x', nested: { a: 1, b: 'no' },
  }), { kind: 'session.measure', at: AT, changed: ['context'], used: 1200, limit: 200000, nested: { a: 1 } });
  const d = validateEvent('diag', { at: AT, shapes: { 'turn.step': ['turnId', 'index', 'chunk.delta', 'has space', 'x'.repeat(200)], 'bad key!': ['a'] } });
  assert.deepEqual(d, { kind: 'diag', at: AT, shapes: { 'turn.step': ['turnId', 'index', 'chunk.delta'] } });
  assert.equal(validateEvent('diag', { at: AT }), null);
});

// ── the hello and the result ────────────────────────────────────────────────

function hello(extra = {}) {
  return { v: 1, protocol: 1, session_id: SID, cc_version: '2.1.296', mod_version: '0.8.5', ops: [...OPS], events: [...EVENT_KINDS], root: '/u/p', ...extra };
}

test('validateHello: exactly its eight keys, each well formed', () => {
  const r = validateHello(hello({ session_id: SID.toUpperCase() }));
  assert.equal(r.ok, true);
  assert.equal(r.hello.session_id, SID);
  assert.equal(validateHello(hello({ protocol: 7 })).ok, true, 'another protocol is the bridge\'s 409, not a malformed hello');
  assert.match(validateHello(hello({ token: 'x' })).hint, /unknown field token/);
  assert.equal(validateHello(hello({ messaging_token: 'x' })).ok, false);
  for (const k of P.HELLO_KEYS) {
    const b = hello();
    delete b[k];
    assert.equal(validateHello(b).ok, false, k);
  }
  for (const bad of [
    { v: 2 }, { protocol: '1' }, { session_id: 'not-a-uuid' }, { cc_version: 'latest' }, { cc_version: '2.1' },
    { mod_version: '' }, { ops: 'abort' }, { events: [1] }, { root: 'relative/p' }, { root: '' }, { root: '/u/\0p' },
  ]) assert.equal(validateHello(hello(bad)).ok, false, JSON.stringify(bad));
  assert.equal(validateHello(null).ok, false);
  assert.equal(validateHello([]).ok, false);
});

test('validateResult: {id, ok, result?, refused?, error?}; result capped, error cut', () => {
  assert.deepEqual(validateResult({ id: 'op_abc12', ok: true, result: { n: 1 } }), { ok: true, result: { id: 'op_abc12', ok: true, result: { n: 1 } } });
  const e = validateResult({ id: 'op_abc12', ok: false, refused: 'no-turn', error: 'e'.repeat(500) });
  assert.equal(e.result.refused, 'no-turn');
  assert.equal(e.result.error.length, 200);
  assert.equal(validateResult({ id: 'op_abc12', ok: false, refused: 'Has Spaces' }).result.refused, 'failed');
  const big = validateResult({ id: 'op_abc12', ok: true, result: 'x'.repeat(9000) });
  assert.equal(big.ok, false);
  assert.equal(big.refused, 'too-large');
  assert.equal(big.id, 'op_abc12');
  for (const bad of [{ id: 'x', ok: true }, { id: 'op_1', ok: 'yes' }, { id: 'op_1', ok: true, extra: 1 }, null]) {
    assert.equal(validateResult(bad).ok, false, JSON.stringify(bad));
  }
});
