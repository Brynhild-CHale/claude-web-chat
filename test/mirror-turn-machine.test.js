// The mirror's turn machine (lib/server/mirror/turn-machine.js, spec §2.4 rules
// 1–6, §2.6 "Who interrupted", §15.4): hook open, opener binding (same id and
// alias), every close path, events out of order, the provisional reply, the one
// supersede, compaction, agent files, grouping, the graph-link states and the
// turn index's export/restore. Pure unit tests over a real model.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createModel } = require('../lib/server/mirror/model');
const { createTurnMachine, unframe, isRelay, USER_REQUEST_FRAME, FRAME_MARK } = require('../lib/server/mirror/turn-machine');

const C = 'conv-1';
const S = 'sess-1';

// A redactor fake: masks the sentinel and nothing else.
const redactor = {
  text: (s) => s.replace(/SECRET[A-Za-z0-9_]*/g, '[MASK]'),
  value: (v) => JSON.parse(JSON.stringify(v).replace(/SECRET[A-Za-z0-9_]*/g, '[MASK]')),
};

function harness({ interruptedBy } = {}) {
  const model = createModel({ redactor });
  const transitions = [];
  const opened = [];
  const closed = [];
  let clock = 1000;
  const tm = createTurnMachine({
    model,
    now: () => clock,
    interruptedBy,
    transition: (t) => transitions.push(t),
    onTurnOpened: (t) => opened.push(t),
    onTurnClosed: (t) => closed.push(t),
  });
  const hook = (event, fields = {}) => {
    clock += 1;
    return tm.ingest(C, { v: 1, event, ts: clock, session_id: S, transcript_path: '/p/sess-1.jsonl', cwd: '/p', prompt_id: null, ...fields });
  };
  const tx = (...changes) => tm.applyChanges(C, S, changes);
  const closes = () => transitions.filter((t) => t.op === 'turn-closed');
  return { model, tm, transitions, opened, closed, hook, tx, closes, clock: () => clock };
}

// Hook envelopes (envelope v1, §1.3).
const promptEnv = (pid, text, author = 'user') => ({ prompt_id: pid, prompt: { author, text } });
const toolEnv = (pid, useId, name = 'Read') => ({
  prompt_id: pid, tool: { name, use_id: useId, kind: name, label: `${name} · a.js`, call: `${name}(a.js)`, input: { file_path: 'a.js' }, input_hash: 'h' },
});

// Transcript changes, the contract in turn-machine.js's header.
const opener = (pid, uuid, parent, text = `prompt ${pid}`, extra = {}) =>
  ({ type: 'opener', prompt_id: pid, uuid, parent_uuid: parent, kind: 'prompt', text, ts: 50, ...extra });
const reply = (id, uuid, parent, text) => ({ type: 'item', uuid, parent_uuid: parent, item: { id, kind: 'reply', text } });
const toolItem = (id, uuid, parent, name, status = 'done', extra = {}) =>
  ({ type: 'item', uuid, parent_uuid: parent, item: { id, kind: 'tool_call', tool: name, tool_kind: name, label: `${name} · x`, status, ...extra } });
const duration = (uuid, parent, ms = 500) => ({ type: 'turn-duration', uuid, parent_uuid: parent, duration_ms: ms });

// One whole transcript turn: opener, reply, turn_duration — chained.
function txTurn(h, pid, n, parent) {
  const u = (k) => `u${n}${k}`;
  h.tx(opener(pid, u('a'), parent), reply(`r_${pid}`, u('b'), u('a'), `answer ${pid}`), duration(u('c'), u('b')));
  return u('c');
}

const turnsOf = (h) => h.model.turnsOf(C);
const rewoundNotices = (h) => turnsOf(h).flatMap((t) => h.model.itemsOf(t.id) || []).filter((i) => i.notice === 'rewound');

// ---- rule 1: hook open ---------------------------------------------------------------------------

test('rule 1: a UserPromptSubmit opens a provisional turn with a provisional prompt item', () => {
  const h = harness();
  const r = h.hook('UserPromptSubmit', promptEnv('pA', 'fix the rail'));
  assert.deepEqual(r, { ok: true, turn_id: 'pA', opened: true });
  const t = h.model.turn('pA');
  assert.equal(t.status, 'open');
  assert.equal(t.provisional, true);
  assert.equal(t.kind, 'prompt');
  assert.equal(t.author, 'user');
  assert.equal(t.session_id, S);
  assert.equal(t.seq, 1);
  const p = h.model.item('p_pA');
  assert.equal(p.text, 'fix the rail');
  assert.equal(p.source, 'hook');
  assert.equal(p.provisional, true);
  assert.equal(p.origin, 'human');
  assert.deepEqual(h.transitions, [{ kind: 'mirror', op: 'turn-open', conversation_id: C, session_id: S, turn_id: 'pA' }]);
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].id, 'pA');
  assert.equal(h.tm.openTurnOf(C), 'pA');
});

test('rule 1: a prompt with no prompt_id opens h_<ts>', () => {
  const h = harness();
  const r = h.hook('UserPromptSubmit', { prompt: { author: 'user', text: 'hi' } });
  assert.equal(r.turn_id, `h_${h.clock()}`);
  assert.ok(h.model.turn(r.turn_id));
});

test('rule 1: a task notification while a turn is open is absorbed, not a turn', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'build it'));
  const r = h.hook('UserPromptSubmit', promptEnv('pT', '<task-notification><task-id>b1</task-id>…', 'task'));
  assert.deepEqual(r, { ok: true, absorbed: true, turn_id: 'pA' });
  assert.deepEqual(turnsOf(h).map((t) => t.id), ['pA']);
  assert.equal(h.model.turn('pA').status, 'open');
  assert.equal(h.closes().length, 0);
});

test('rule 1: a task notification with no turn open opens a task-notification turn', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'go'));
  h.hook('Stop', { prompt_id: 'pA', stop: { last_assistant_message: 'ok' } });
  h.hook('UserPromptSubmit', promptEnv('pT', '<task-notification>done</task-notification>', 'task'));
  const t = h.model.turn('pT');
  assert.equal(t.kind, 'task-notification');
  assert.equal(t.author, 'task-notification');
  assert.equal(h.model.item('p_pT').origin, 'task-notification');
});

test('rule 1: an open turn without a Stop closes interrupted by the next turn', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'one'));
  h.hook('UserPromptSubmit', promptEnv('pB', 'two'));
  const a = h.model.turn('pA');
  assert.equal(a.status, 'interrupted');
  assert.equal('ended_by' in a, false, 'an inferred interruption names nobody');
  assert.deepEqual(h.closes(), [{ kind: 'mirror', op: 'turn-closed', conversation_id: C, session_id: S, turn_id: 'pA', outcome: 'interrupted', by: 'next-turn' }]);
  assert.equal(h.model.turn('pB').status, 'open');
  // When the facade remembers a web interrupt for the session, the close carries it.
  const w = harness({ interruptedBy: (cid, sid) => (cid === C && sid === S ? 'web' : null) });
  w.hook('UserPromptSubmit', promptEnv('pA', 'one'));
  w.hook('UserPromptSubmit', promptEnv('pB', 'two'));
  assert.equal(w.model.turn('pA').ended_by, 'web');
  assert.equal(w.closes()[0].ended_by, 'web');
});

// ---- rule 2: opener binding --------------------------------------------------------------------------

test('rule 2: the transcript opener binds the provisional turn under the same id', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'fix it'));
  h.tx(opener('pA', 'u1', null, 'fix it'));
  assert.deepEqual(turnsOf(h).map((t) => t.id), ['pA']);
  const t = h.model.turn('pA');
  assert.equal('provisional' in t, false);
  assert.equal('replaces' in t, false);
  assert.equal(t.status, 'open');
  const p = h.model.item('p_pA');
  assert.equal(p.source, 'transcript');
  assert.equal('provisional' in p, false);
  assert.equal(h.transitions.filter((x) => x.op === 'turn-open').length, 1, 'binding opens nothing');
});

test('rule 2: when the ids differ the turn is bound by order with one alias, its items re-keyed', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('hA', 'fix it'));
  h.model.takeChanges();
  h.tx(opener('tA', 'u1', null, 'fix it'));
  assert.equal(h.model.turn('hA'), null);
  const t = h.model.turn('tA');
  assert.equal(t.replaces, 'hA');
  assert.equal('provisional' in t, false);
  assert.equal(h.model.item('p_hA'), null);
  assert.equal(h.model.item('p_tA').turn_id, 'tA');
  assert.equal(h.tm.resolve('hA'), 'tA');
  const ch = h.model.takeChanges()[0];
  assert.ok(ch.turns.includes('tA'));
  assert.ok(ch.removed_items.includes('p_hA'));
  assert.ok(ch.items.includes('p_tA'));
  // A later hook that still names the old id reaches the turn.
  h.hook('Stop', { prompt_id: 'hA', stop: { last_assistant_message: 'done' } });
  assert.equal(h.model.turn('tA').status, 'done');
});

test('rule 2: several unbound provisional turns are bound in order', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('hA', 'one'));
  h.hook('UserPromptSubmit', promptEnv('hB', 'two'));
  h.tx(opener('tA', 'u1', null, 'one'));
  h.tx(opener('tB', 'u2', 'u1', 'two'));
  assert.deepEqual(turnsOf(h).map((t) => [t.id, t.replaces]), [['tA', 'hA'], ['tB', 'hB']]);
  assert.equal(h.model.turn('tA').status, 'interrupted');
  assert.equal(h.model.turn('tB').status, 'open');
});

test('rule 2: by order, an opener prefers the unbound provisional turn that holds its prompt', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('hA', 'a prompt whose record never lands'));
  h.hook('UserPromptSubmit', promptEnv('hB', 'the next prompt'));
  h.tx(opener('tB', 'u1', null, 'the next prompt'));
  assert.equal(h.model.turn('tB').replaces, 'hB');
  assert.ok(h.model.turn('hA'), 'the orphaned provisional turn is left alone');
  assert.equal(h.model.turn('hA').provisional, true);
});

test('rule 2: an opener with no provisional turn opens a transcript turn; the next opener closes it', () => {
  const h = harness();
  h.tx(opener('tA', 'u1', null), reply('r_1', 'u2', 'u1', 'hi'));
  const a = h.model.turn('tA');
  assert.equal(a.status, 'open');
  assert.equal('provisional' in a, false);
  h.tx(opener('tB', 'u3', 'u2'));
  assert.equal(h.model.turn('tA').status, 'done');
  assert.deepEqual(h.closes().map((t) => [t.turn_id, t.outcome, t.by]), [['tA', 'done', 'next-turn']]);
  assert.equal(h.model.turn('tB').status, 'open');
  // A re-read of a known opener (catch-up) changes nothing.
  h.tx(opener('tA', 'u1', null));
  assert.equal(h.model.turn('tB').status, 'open');
  assert.equal(turnsOf(h).length, 2);
});

test('rule 2, read from the other side: a hook arriving after the transcript opened the turn joins it', () => {
  const h = harness();
  h.tx(opener('pA', 'u1', null, 'same prompt'));
  assert.deepEqual(h.hook('UserPromptSubmit', promptEnv('pA', 'same prompt')), { ok: true, turn_id: 'pA', known: true });
  assert.equal(turnsOf(h).length, 1);
  // Different ids, the same (redacted) prompt: the hook's id becomes an alias.
  const d = harness();
  d.tx(opener('tA', 'u1', null, 'key SECRET1 here'));
  assert.deepEqual(d.hook('UserPromptSubmit', promptEnv('hA', 'key SECRET1 here')), { ok: true, turn_id: 'tA', bound: true });
  assert.equal(turnsOf(d).length, 1);
  assert.equal(d.model.turn('tA').status, 'open');
  d.hook('Stop', { prompt_id: 'hA', stop: { last_assistant_message: 'ok' } });
  assert.equal(d.model.turn('tA').status, 'done');
});

// ---- rule 3: every close path --------------------------------------------------------------------------

test('rule 3: Stop closes done, and its message is a provisional reply until the transcript\'s lands', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'fix'));
  h.tx(opener('pA', 'u1', null, 'fix'), toolItem('tu1', 'u2', 'u1', 'Read'));
  h.hook('Stop', { prompt_id: 'pA', stop: { last_assistant_message: 'All done.' } });
  const t = h.model.turn('pA');
  assert.equal(t.status, 'done');
  assert.ok(Number.isFinite(t.ended_at));
  assert.deepEqual(h.closes(), [{ kind: 'mirror', op: 'turn-closed', conversation_id: C, session_id: S, turn_id: 'pA', outcome: 'done', by: 'stop' }]);
  assert.equal(h.closed.length, 1);
  const rl = h.model.item('rl_pA');
  assert.equal(rl.text, 'All done.');
  assert.equal(rl.source, 'hook');
  assert.equal(rl.provisional, true);
  assert.equal(h.model.turn('pA').reply_preview, 'All done.');
  h.model.takeChanges();
  // The transcript's reply replaces it.
  h.tx(reply('r_m9', 'u3', 'u2', 'All done.'));
  assert.equal(h.model.item('rl_pA'), null);
  assert.equal(h.model.item('r_m9').source, 'transcript');
  assert.deepEqual(h.model.itemsOf('pA').filter((i) => i.kind === 'reply').map((i) => i.id), ['r_m9']);
  assert.ok(h.model.takeChanges()[0].removed_items.includes('rl_pA'));
});

test('rule 3: no provisional reply when the transcript\'s final reply is already the last word', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'q'));
  h.tx(opener('pA', 'u1', null, 'q'), toolItem('tu1', 'u2', 'u1', 'Read'), reply('r_1', 'u3', 'u2', 'Final.'),
    { type: 'item', uuid: 'u4', item: { id: 'n_x', kind: 'notice', notice: 'info', text: 'a file changed' } });
  h.hook('Stop', { prompt_id: 'pA', stop: { last_assistant_message: 'Final.' } });
  assert.equal(h.model.item('rl_pA'), null);
  assert.equal(h.model.turn('pA').reply_preview, 'Final.');
});

test('rule 3: turn_duration closes a turn with its duration; after a Stop it only sets the duration', () => {
  const h = harness();
  h.tx(opener('tA', 'u1', null), reply('r_1', 'u2', 'u1', 'ok'), duration('u3', 'u2', 1234));
  let t = h.model.turn('tA');
  assert.equal(t.status, 'done');
  assert.equal(t.duration_ms, 1234);
  assert.deepEqual(h.closes().map((x) => [x.outcome, x.by]), [['done', 'transcript']]);

  const s = harness();
  s.hook('UserPromptSubmit', promptEnv('pA', 'go'));
  s.tx(opener('pA', 'u1', null, 'go'), reply('r_1', 'u2', 'u1', 'Working on it.'), toolItem('tu1', 'u3', 'u2', 'Bash'));
  s.hook('Stop', { prompt_id: 'pA', stop: { last_assistant_message: 'Fixed.' } });
  assert.ok(s.model.item('rl_pA'), 'the last word on disk was a tool call');
  s.tx(duration('u4', 'u3', 99));
  t = s.model.turn('pA');
  assert.equal(t.status, 'done');
  assert.equal(t.duration_ms, 99);
  assert.equal(s.closes().length, 1, 'one close, one transition');
  // The backstop: a transcript reply exists, so the provisional one goes with turn_duration.
  assert.equal(s.model.item('rl_pA'), null);
});

test('rule 3: StopFailure closes error', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'go'));
  h.hook('StopFailure', { prompt_id: 'pA', stop: { error: 'model_not_found', last_assistant_message: '' } });
  assert.equal(h.model.turn('pA').status, 'error');
  assert.deepEqual(h.closes().map((x) => [x.outcome, x.by]), [['error', 'stop']]);
});

test('rule 3: live\'s turn-closed {by: status} is consumed: interrupted, by the terminal unless a control event says otherwise', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'go'));
  h.tm.statusClosed({ conversation_id: C, session_id: S, turn_id: 'pA', at: 2000 });
  const t = h.model.turn('pA');
  assert.equal(t.status, 'interrupted');
  assert.equal(t.ended_by, 'terminal');
  assert.equal(t.ended_at, 2000);
  assert.deepEqual(h.closes(), [{ kind: 'mirror', op: 'turn-closed', conversation_id: C, session_id: S, turn_id: 'pA', outcome: 'interrupted', by: 'status', ended_by: 'terminal' }]);
  // An interrupt the facade remembers from the page wins over the default.
  const w = harness({ interruptedBy: () => 'hook' });
  w.hook('UserPromptSubmit', promptEnv('pA', 'go'));
  w.tm.statusClosed({ conversation_id: C, session_id: S });
  assert.equal(w.model.turn('pA').ended_by, 'hook');
  const x = harness();
  x.hook('UserPromptSubmit', promptEnv('pA', 'go'));
  x.tm.statusClosed({ conversation_id: C, turn_id: 'pA', ended_by: 'web' });
  assert.equal(x.model.turn('pA').ended_by, 'web');
  // Nothing open: nothing closes.
  assert.equal(x.tm.statusClosed({ conversation_id: C }), null);
});

test('rule 3: an interrupt marker then turn_duration closes interrupted, by the terminal', () => {
  const h = harness();
  h.tx(opener('tA', 'u1', null), toolItem('tu1', 'u2', 'u1', 'Bash', 'interrupted'),
    { type: 'interrupt', uuid: 'u3', parent_uuid: 'u2', text: '[Request interrupted by user for tool use]' });
  assert.equal(h.model.turn('tA').status, 'open', 'the marker alone closes nothing');
  const n = h.model.item('n_u3');
  assert.equal(n.kind, 'notice');
  assert.equal(n.notice, 'interrupted');
  h.tx(duration('u4', 'u3', 300));
  const t = h.model.turn('tA');
  assert.equal(t.status, 'interrupted');
  assert.equal(t.ended_by, 'terminal');
  assert.equal(t.duration_ms, 300);
  assert.deepEqual(h.closes().map((x) => [x.outcome, x.by, x.ended_by]), [['interrupted', 'transcript', 'terminal']]);
});

test('rule 3: the process gone abandons the open turn', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'go'));
  h.tm.processGone(C, { at: 5000 });
  assert.equal(h.model.turn('pA').status, 'abandoned');
  assert.deepEqual(h.closes().map((x) => [x.outcome, x.by]), [['abandoned', 'process-gone']]);
  assert.equal(h.tm.processGone(C), null);
});

test('rule 3: the first close wins, and a late Stop corrects a presumed interruption', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'go'));
  h.tx(opener('pA', 'u1', null, 'go'));
  h.hook('Stop', { prompt_id: 'pA', stop: { last_assistant_message: 'ok' } });
  h.tx(duration('u2', 'u1', 10));
  h.tm.statusClosed({ conversation_id: C, turn_id: 'pA' });
  assert.equal(h.model.turn('pA').status, 'done');
  assert.equal(h.closes().length, 1);
  assert.equal(h.tm.closeTurn(C, 'pA', { outcome: 'error' }), null);

  const late = harness();
  late.hook('UserPromptSubmit', promptEnv('pA', 'go'));
  late.tm.statusClosed({ conversation_id: C, turn_id: 'pA' });
  assert.equal(late.model.turn('pA').ended_by, 'terminal');
  late.hook('Stop', { prompt_id: 'pA', stop: { last_assistant_message: 'finished after all' } });
  const t = late.model.turn('pA');
  assert.equal(t.status, 'done');
  assert.equal('ended_by' in t, false);
  assert.equal(late.closes().length, 1, 'the late Stop emits no second close');
  assert.equal(late.model.item('rl_pA').text, 'finished after all');
});

test('closeTurn with ended_by sets it on the header; without it the field stays absent', () => {
  const h = harness();
  const cases = [
    [{ outcome: 'interrupted', ended_by: 'web' }, 'web'],
    [{ outcome: 'interrupted', ended_by: 'hook' }, 'hook'],
    [{ outcome: 'interrupted', ended_by: 'terminal' }, 'terminal'],
    [{ outcome: 'interrupted' }, undefined],
    [{ outcome: 'interrupted', ended_by: 'bogus' }, undefined],
    [{ outcome: 'done', ended_by: 'web' }, undefined], // ended_by belongs to an interrupted turn only
  ];
  cases.forEach(([opts, want], i) => {
    const id = `t${i}`;
    h.tm.openTurn(C, { id, session_id: S });
    const header = h.tm.closeTurn(C, id, { by: 'status', ...opts });
    assert.equal(header.ended_by, want, JSON.stringify(opts));
    assert.equal('ended_by' in h.model.turn(id), want !== undefined);
    const tr = h.closes().find((x) => x.turn_id === id);
    assert.equal(tr.ended_by, want);
    assert.equal(h.model.serializeTurn(id).ended_by, want);
  });
});

// ---- events out of order -----------------------------------------------------------------------------

test('events out of order: a PostToolUse before its PreToolUse leaves the call done, never running', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'read it'));
  h.hook('PostToolUse', { ...toolEnv('pA', 'tu1'), ts: 5130, result: { ok: true, duration_ms: 20, fields: { agentId: 'ag1' } } });
  let it = h.model.item('tu1');
  assert.equal(it.status, 'done');
  assert.equal(it.started_at, 5110, 'estimated from the duration');
  assert.equal(it.provisional, true);
  h.hook('PreToolUse', { ...toolEnv('pA', 'tu1'), ts: 5112 });
  it = h.model.item('tu1');
  assert.equal(it.status, 'done', 'a late PreToolUse is data, never a running step');
  assert.equal(it.started_at, 5112);
  assert.equal(it.ended_at, 5130);
  assert.equal(it.label, 'Read · a.js');
  assert.deepEqual({ ...it.links }, { agent_id: 'ag1' });
  // The transcript's tool_use lands later still, then its result.
  h.tx(opener('pA', 'u1', null, 'read it'), toolItem('tu1', 'u2', 'u1', 'Read', 'running'));
  assert.equal(h.model.item('tu1').status, 'done');
  h.tx(toolItem('tu1', 'u3', 'u2', 'Read', 'done', { result: { preview: '120 lines', is_error: false } }));
  it = h.model.item('tu1');
  assert.equal(it.source, 'transcript');
  assert.equal(it.result.preview, '120 lines');
  assert.equal(it.turn_id, 'pA');
  // A failing call: error with its message.
  h.hook('PreToolUse', { ...toolEnv('pA', 'tu2', 'Bash') });
  h.hook('PostToolUseFailure', { ...toolEnv('pA', 'tu2', 'Bash'), result: { ok: false, error: 'exit 1', duration_ms: 3 } });
  assert.equal(h.model.item('tu2').status, 'error');
  assert.equal(h.model.item('tu2').result.preview, 'exit 1');
  assert.equal(h.model.turn('pA').counts.tool_errors, 1);
});

test('a hook event for a closed turn is routed by its prompt_id; a late one without it, by the session\'s latest turn', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'go'));
  h.hook('PreToolUse', toolEnv('pA', 'tu1'));
  h.hook('Stop', { prompt_id: 'pA', stop: { last_assistant_message: 'ok' } });
  h.hook('UserPromptSubmit', promptEnv('pB', 'next'));
  h.hook('PostToolUse', { ...toolEnv('pA', 'tu1'), result: { ok: true, duration_ms: 5 } });
  assert.equal(h.model.item('tu1').turn_id, 'pA');
  assert.equal(h.model.item('tu1').status, 'done');
  assert.equal(h.model.turn('pB').counts.tools, 0);
});

test('a subagent\'s tool hooks are its own stream, not items of the main turn', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'go'));
  assert.deepEqual(h.hook('PreToolUse', { ...toolEnv('pA', 'tuX'), agent: { id: 'ag1', type: 'Explore' } }), { ok: true, ignored: 'agent' });
  assert.equal(h.model.item('tuX'), null);
});

// ---- rule 4: supersede --------------------------------------------------------------------------------

function threeTurns() {
  const h = harness();
  const e1 = txTurn(h, 'T1', 1, null);
  const e2 = txTurn(h, 'T2', 2, e1);
  txTurn(h, 'T3', 3, e2);
  h.model.takeChanges();
  return { h, e1, e2 };
}

test('rule 4: a branch marks the later turns superseded and adds one rewound notice', () => {
  const { h, e1 } = threeTurns();
  h.tx(opener('T4', 'u4a', e1, 'try again', { ts: 777 })); // the prompt chains to the end of T1: T2 and T3 are abandoned
  const s = Object.fromEntries(turnsOf(h).map((t) => [t.id, t.superseded === true]));
  assert.deepEqual(s, { T1: false, T2: true, T3: true, T4: false });
  const notices = rewoundNotices(h);
  assert.equal(notices.length, 1);
  const n = notices[0];
  assert.equal(n.id, 'rw_T2');
  assert.equal(n.turn_id, 'T2');
  assert.equal(n.reason, 'branch');
  assert.equal(n.at, 777);
  assert.equal(n.returned_to, 'T1');
  assert.equal(n.through_turn_id, 'T3');
  const t2items = h.model.itemsOf('T2');
  assert.equal(t2items[0].id, 'rw_T2', 'the notice sits at the top of the superseded run');
  const ch = h.model.takeChanges()[0];
  assert.ok(ch.turns.includes('T2') && ch.turns.includes('T3'));
  assert.ok(ch.items.includes('rw_T2'));
  assert.equal(h.model.turn('T4').status, 'open');
});

test('rule 4: a second supersede call changes nothing', () => {
  const { h, e1 } = threeTurns();
  h.tx(opener('T4', 'u4a', e1));
  h.model.takeChanges();
  assert.deepEqual(h.tm.supersede(C, 'T2', { reason: 'anchor' }), { ok: true, superseded: [] });
  assert.deepEqual(h.tm.supersede(C, 'T3', { reason: 'reset', until: 'T4' }), { ok: true, superseded: [] },
    'every turn in its range is superseded already');
  assert.deepEqual(h.model.takeChanges(), []);
  assert.equal(rewoundNotices(h).length, 1);
  assert.equal(h.model.item('rw_T2').reason, 'branch', 'the first notice stands');
});

test('rule 4: re-asking a turn in place supersedes it, even when the parent record is unknown', () => {
  const h = harness();
  const e1 = txTurn(h, 'T1', 1, null);
  // T2's opener chains to a record the normalizer never forwarded (uX).
  h.tx(opener('T2', 'u2a', 'uX'), reply('r_T2', 'u2b', 'u2a', 'a'), duration('u2c', 'u2b'));
  h.tx(opener('T3', 'u3a', 'uX')); // the same parent as T2's: a rewind to T2's prompt
  assert.equal(h.model.turn('T2').superseded, true);
  assert.equal(h.model.turn('T3').superseded, undefined);
  assert.equal(h.model.turn('T1').superseded, undefined);
  assert.equal(h.model.item('rw_T2').returned_to, 'T1');
  assert.ok(e1);
});

test('rule 4: a rewind to the first prompt (a new root) supersedes every earlier turn of the session', () => {
  const { h } = threeTurns();
  h.tx(opener('T4', 'u4a', null));
  assert.deepEqual(turnsOf(h).map((t) => t.superseded === true), [true, true, true, false]);
  assert.equal(h.model.item('rw_T1').returned_to, null);
});

test('rule 4: with a provisional turn for the new prompt, the branch stops at it', () => {
  const { h, e1 } = threeTurns();
  h.hook('UserPromptSubmit', promptEnv('T4', 'try again'));
  h.tx(opener('T4', 'u4a', e1, 'try again'));
  assert.deepEqual(turnsOf(h).map((t) => [t.id, t.superseded === true]), [['T1', false], ['T2', true], ['T3', true], ['T4', false]]);
  assert.equal('provisional' in h.model.turn('T4'), false, 'and is bound');
});

test('rule 4: a compaction is never a rewind', () => {
  const h = harness();
  const e1 = txTurn(h, 'T1', 1, null);
  h.tx(opener('T2', 'u2a', e1, '/compact', { kind: 'command' }),
    { type: 'compact', uuid: 'uC', parent_uuid: null, tail_uuid: 'u1b', trigger: 'manual', tokens: { pre: 9000, post: 900 }, duration_ms: 4586 },
    { type: 'compact-summary', uuid: 'uS', parent_uuid: 'uC', text: 'The conversation so far…' },
    duration('u2c', 'uS'));
  const c = h.model.item('c_uC');
  assert.equal(c.kind, 'compact');
  assert.equal(c.trigger, 'manual');
  assert.equal(c.summary, 'The conversation so far…');
  assert.deepEqual({ ...c.tokens }, { pre: 9000, post: 900 });
  assert.equal(h.model.turn('T2').author, 'system', 'a command turn is the system\'s');
  // The next prompt chains through the boundary, or onto the preserved tail.
  h.tx(opener('T3', 'u3a', 'uC'));
  h.tx(opener('T4', 'u4a', 'u1b'));
  assert.equal(turnsOf(h).some((t) => t.superseded), false);
  assert.equal(rewoundNotices(h).length, 0);
});

test('rule 4: an unknown parent is never read as a rewind', () => {
  const { h } = threeTurns();
  h.tx(opener('T4', 'u4a', 'never-seen'));
  assert.equal(turnsOf(h).some((t) => t.superseded), false);
  // And an opener that does not say its parent is never tested at all.
  const { h: g } = threeTurns();
  g.tx({ type: 'opener', prompt_id: 'T4', uuid: 'u4a', kind: 'prompt', text: 'x' });
  assert.equal(turnsOf(g).some((t) => t.superseded), false);
});

test('rule 4: the rewinds source\'s reset and anchor go through the same supersede', () => {
  const { h } = threeTurns();
  const r = h.tm.supersede(C, 'T1', { reason: 'reset', until: 'T3', at: 4242 });
  assert.deepEqual(r.superseded, ['T1', 'T2']);
  assert.equal(h.model.turn('T3').superseded, undefined);
  const n = h.model.item('rw_T1');
  assert.equal(n.reason, 'reset');
  assert.equal(n.returned_to, null);
  assert.equal(n.text, 'Conversation reset');
  assert.deepEqual(h.tm.supersede(C, 'nope'), { ok: false, reason: 'unknown-turn', superseded: [] });
});

test('rule 4: an anchor and the branch it foretells leave one notice', () => {
  const { h, e1 } = threeTurns();
  h.tm.supersede(C, 'T2', { reason: 'anchor' }); // a headless last-prompt {rewound: true}
  h.tx(opener('T4', 'u4a', e1)); // then the prompt that chains to the anchor
  assert.equal(rewoundNotices(h).length, 1);
  assert.equal(h.model.item('rw_T2').reason, 'anchor');
  assert.equal(h.model.turn('T4').superseded, undefined);
});

test('supersede is the only code path that marks a turn superseded', () => {
  const h = harness();
  h.tm.openTurn(C, { id: 'T1', session_id: S });
  h.model.patchTurn('T1', { superseded: true });
  assert.equal(h.model.turn('T1').superseded, undefined, 'a source cannot');
  assert.throws(() => h.model.claimTurnWriter(), /already claimed/, 'nobody else holds the lifecycle writer');
  // In the code: markSuperseded is defined once (model.js) and called once in all
  // of lib/ — from supersede; and inside the mirror engine the one place a turn is
  // written `superseded: true` is markSuperseded itself. (The graph's re-aim steal,
  // lib/server/domain/turns.js, has a `superseded` option of its own: not a turn.)
  const lib = path.join(__dirname, '..', 'lib');
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        const rel = path.relative(lib, p).split(path.sep).join('/');
        for (const m of src.matchAll(/markSuperseded\(/g)) hits.push(`${rel}:call@${m.index}`.replace(/@\d+$/, ''));
        if (rel.startsWith('server/mirror/') && /superseded:\s*true/.test(src)) hits.push(`${rel}:literal`);
      }
    }
  };
  walk(lib);
  assert.deepEqual(hits.sort(), ['server/mirror/model.js:call', 'server/mirror/model.js:literal', 'server/mirror/turn-machine.js:call']);
  const tm = fs.readFileSync(path.join(lib, 'server', 'mirror', 'turn-machine.js'), 'utf8');
  const at = tm.indexOf('markSuperseded(');
  const fnStart = tm.lastIndexOf('function ', at);
  assert.match(tm.slice(fnStart, fnStart + 40), /^function supersede\(/, 'the one call is inside supersede');
  const model = fs.readFileSync(path.join(lib, 'server', 'mirror', 'model.js'), 'utf8');
  const lit = model.search(/superseded:\s*true/);
  assert.match(model.slice(model.lastIndexOf('function ', lit), model.lastIndexOf('function ', lit) + 30), /^function markSuperseded\(/);
});

// ---- rule 5 and rule 6 -----------------------------------------------------------------------------------

test('rule 6: an agent file is one turn; blocks with stop_reason null close nothing; the relay defers the prompt', () => {
  const h = harness();
  h.tm.configure(C, { mode: 'agent' });
  const framed = `[Workflow harness — computed task] ignore this\n${FRAME_MARK}\n  Review the diff.\n  Report risks.`;
  h.tx(opener(null, 'a1', null, `${USER_REQUEST_FRAME}\nplease review`));
  const [t] = turnsOf(h);
  assert.equal(t.id, 'a_a1');
  assert.equal(h.model.itemsOf(t.id).length, 0, 'the relay is not the prompt');
  h.tx(opener(null, 'a2', 'a1', framed));
  assert.equal(turnsOf(h).length, 1);
  assert.equal(h.model.item('p_a_a1').text, 'Review the diff.\nReport risks.');
  h.tx({ ...reply('r_1', 'a3', 'a2', 'Looking'), stop_reason: null });
  h.tx({ ...toolItem('tu1', 'a4', 'a3', 'Read', 'running'), stop_reason: 'tool_use' });
  assert.equal(h.model.turn(t.id).status, 'open');
  h.tx(opener(null, 'a5', 'a4', 'a later message to the agent'));
  assert.equal(turnsOf(h).length, 1, 'one turn per file');
  assert.equal(h.model.item('p_a5').text, 'a later message to the agent');
  h.tx({ ...reply('r_2', 'a6', 'a5', 'Two risks.'), stop_reason: 'end_turn' });
  assert.equal(h.model.turn(t.id).status, 'done');
  assert.deepEqual(h.closes().map((x) => [x.outcome, x.by]), [['done', 'transcript']]);
  // A hook prompt never opens a turn in an agent stream.
  assert.deepEqual(h.hook('UserPromptSubmit', promptEnv('pZ', 'x')), { ok: true, ignored: true });
});

test('unframe and isRelay read the workflow frame as rebuild_wf.py does', () => {
  assert.equal(unframe('plain prompt'), 'plain prompt');
  assert.equal(unframe(`head\n${FRAME_MARK}\n\n  line one\n    indented\n  line two\n`), 'line one\n  indented\nline two');
  assert.equal(isRelay(`${USER_REQUEST_FRAME} hi`), true);
  assert.equal(isRelay('hi'), false);
});

// ---- grouping, permissions, redaction ------------------------------------------------------------------

test('grouping through the machine: ▸ 3 tool calls · Read, Edit, Bash', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'fix the rail'));
  h.hook('PreToolUse', toolEnv('pA', 'tu1', 'Read'));
  h.hook('PreToolUse', toolEnv('pA', 'tu2', 'Edit'));
  h.hook('PreToolUse', toolEnv('pA', 'tu3', 'Bash'));
  h.tx(opener('pA', 'u1', null, 'fix the rail'), reply('r_1', 'u2', 'u1', 'On it.'),
    toolItem('tu1', 'u3', 'u2', 'Read'), toolItem('tu2', 'u4', 'u3', 'Edit'), toolItem('tu3', 'u5', 'u4', 'Bash'),
    reply('r_2', 'u6', 'u5', 'Fixed.'));
  const t = h.model.turn('pA');
  assert.equal(t.groups.length, 1);
  const g = t.groups[0];
  assert.equal(`▸ ${g.count} tool calls · ${g.names.join(', ')}`, '▸ 3 tool calls · Read, Edit, Bash');
  assert.deepEqual([...t.tool_names], ['Read', 'Edit', 'Bash']);
  assert.deepEqual(h.model.itemsOf('pA').map((i) => i.id), ['p_pA', 'r_1', 'tu1', 'tu2', 'tu3', 'r_2']);
});

test('permissions: a PermissionRequest with its tool_use_id marks the call awaiting; a decision and a resolution follow it', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'deploy'));
  h.hook('PreToolUse', toolEnv('pA', 'tu1', 'Bash'));
  // Tranches 1–3: the payload has no tool_use_id (V3), and the item is left alone.
  assert.deepEqual(h.hook('PermissionRequest', { prompt_id: 'pA', tool: { name: 'Bash', input_hash: 'h' } }), { ok: true, ignored: true });
  assert.equal(h.model.item('tu1').awaiting, undefined);
  h.hook('PermissionRequest', { ...toolEnv('pA', 'tu1', 'Bash'), ask: { id: 'ask_1', kind: 'permission' } });
  assert.deepEqual({ ...h.model.item('tu1').awaiting }, { kind: 'permission', status: 'pending', ask_id: 'ask_1' });
  h.tx(opener('pA', 'u1', null, 'deploy'), { type: 'permission-decision', uuid: 'u2', parent_uuid: 'u1', tool_use_id: 'tu1', decision: 'allow' });
  assert.equal(h.model.item('tu1').awaiting.status, 'decided');
  assert.equal(h.model.item('tu1').awaiting.decision, 'allow');
  assert.deepEqual(h.transitions.find((t) => t.op === 'permission-decision'),
    { kind: 'mirror', op: 'permission-decision', conversation_id: C, session_id: S, tool_use_id: 'tu1', decision: 'allow' });
  h.hook('PermissionResolved', { prompt_id: 'pA', ask: { id: 'ask_1', outcome: 'allowed', by: 'web' }, synthetic: true });
  assert.deepEqual({ ...h.model.item('tu1').awaiting }, { kind: 'permission', status: 'resolved', ask_id: 'ask_1', decision: 'allow', outcome: 'allowed', by: 'web' });
  assert.equal(h.model.item('tu1').status, 'running', 'the wait is not the call');
  // A question asked through AskUserQuestion awaits as a question.
  h.hook('PermissionRequest', { ...toolEnv('pA', 'tu9', 'AskUserQuestion') });
  assert.equal(h.model.item('tu9').awaiting.kind, 'question');
});

test('every string the machine stores passes the model\'s redactor', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'token SECRETabc'));
  h.hook('PreToolUse', { prompt_id: 'pA', tool: { name: 'Bash', use_id: 'tu1', kind: 'Bash', label: 'Bash · echo SECRETdef', call: 'Bash(echo SECRETdef)', input: { command: 'echo SECRETdef' } } });
  h.hook('Stop', { prompt_id: 'pA', stop: { last_assistant_message: 'printed SECRETghi' } });
  h.tx(opener('pA', 'u1', null, 'token SECRETabc'));
  const all = JSON.stringify([turnsOf(h), ...turnsOf(h).map((t) => h.model.itemsOf(t.id))]);
  assert.equal(all.includes('SECRET'), false);
  assert.ok(all.includes('[MASK]'));
});

// ---- the graph link -------------------------------------------------------------------------------------

test('the graph link: closed turns are pending until attached to a node or orphaned', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'a'));
  assert.equal(h.tm.linkState('pA'), 'open');
  assert.deepEqual(h.tm.pendingTurns(), []);
  h.hook('Stop', { prompt_id: 'pA' });
  h.hook('UserPromptSubmit', promptEnv('pB', 'b'));
  h.hook('Stop', { prompt_id: 'pB' });
  h.hook('UserPromptSubmit', promptEnv('pC', 'c'));
  h.hook('Stop', { prompt_id: 'pC' });
  assert.deepEqual(h.tm.pendingTurns().map((t) => t.id), ['pA', 'pB', 'pC']);
  assert.equal(h.tm.attach('pA', { id: 'n7', label: 'n1.7', role: 'folded' }).folded_into.label, 'n1.7');
  h.tm.attach('pB', { id: 'n7', label: 'n1.7', role: 'commit' });
  const b = h.model.serializeTurn('pB');
  assert.deepEqual(b.node, { id: 'n7', label: 'n1.7', role: 'commit' });
  assert.equal(b.folded_into, null);
  assert.deepEqual(h.model.turn('pA').node, { id: 'n7', label: 'n1.7', role: 'folded' });
  assert.equal(h.tm.linkState('pA'), 'attached');
  assert.deepEqual(h.tm.orphanPending({ before: 0 }), [], 'only turns that ended before then');
  assert.deepEqual(h.tm.orphanPending(), ['pC']);
  assert.equal(h.tm.linkState('pC'), 'orphaned');
  assert.deepEqual(h.tm.pendingTurns(), []);
  h.hook('UserPromptSubmit', promptEnv('pD', 'd'));
  assert.equal(h.tm.attach('pD', { id: 'n8' }), null, 'an open turn attaches nothing');
});

// ---- the turn index -------------------------------------------------------------------------------------

test('the turn index: exported turns restore, their rewinds replayed through supersede, their items refilled', () => {
  const { h, e1 } = threeTurns();
  h.tx({ ...opener('T4', 'u4a', e1), offset: { start: 900, end: 960 } }, { ...reply('r_T4', 'u4b', 'u4a', 'again'), offset: { start: 960, end: 1000 } });
  const records = h.tm.exportTurns(S);
  assert.deepEqual(records.map((r) => r.header.id), ['T1', 'T2', 'T3', 'T4']);
  assert.deepEqual(records[1].internal.rewind, { reason: 'branch', at: 50, through: 'T3' });
  assert.deepEqual(records[3].internal.segment, { from: 900, to: 1000 });
  const json = JSON.parse(JSON.stringify(records)); // through a file and back

  const g = harness();
  assert.deepEqual(g.tm.restoreTurns(C, json), { ok: true, restored: 4 });
  assert.deepEqual(turnsOf(g).map((t) => [t.id, t.superseded === true, t.status]),
    [['T1', false, 'done'], ['T2', true, 'done'], ['T3', true, 'done'], ['T4', false, 'open']]);
  assert.equal(g.model.turn('T2').reply_preview, 'answer T2', 'the derived header came back');
  assert.equal(g.model.isEvicted('T1'), true, 'items wait for a refill');
  assert.deepEqual(g.tm.segmentOf('T4'), { from: 900, to: 1000 });
  assert.equal(g.tm.openTurnOf(C), 'T4');
  // Refill re-reads the byte range's changes; a superseded turn gets its notice back.
  g.tm.refill('T2', [opener('T2', 'u2a', 'u1c'), reply('r_T2', 'u2b', 'u2a', 'answer T2'), duration('u2c', 'u2b')]);
  assert.deepEqual(g.model.itemsOf('T2').map((i) => i.id), ['rw_T2', 'p_T2', 'r_T2']);
  // The chain continues where it left off: a prompt after T4's last record is linear.
  g.tx(opener('T5', 'u5a', 'u4b'));
  assert.equal(g.model.turn('T5').seq, 5);
  assert.equal(g.model.turn('T4').status, 'done');
  assert.equal(turnsOf(g).filter((t) => t.superseded).length, 2);
  assert.equal(rewoundNotices(g).length, 1);
});

// ---- the transitions and purity ------------------------------------------------------------------------

test('transitions are compact and content-free', () => {
  const h = harness();
  h.hook('UserPromptSubmit', promptEnv('pA', 'secret plan'));
  h.hook('Stop', { prompt_id: 'pA', stop: { last_assistant_message: 'the plan' } });
  const allowed = new Set(['kind', 'op', 'conversation_id', 'session_id', 'turn_id', 'outcome', 'by', 'ended_by', 'tool_use_id', 'decision']);
  for (const t of h.transitions) {
    for (const k of Object.keys(t)) assert.ok(allowed.has(k), `transition field ${k}`);
    assert.equal(JSON.stringify(t).includes('plan'), false);
  }
});

test('the machine is pure: no I/O and no timer, whatever it is fed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'mirror', 'turn-machine.js'), 'utf8');
  assert.deepEqual(src.match(/require\([^)]*\)/g), ["require('./model')"]);
  for (const banned of ['setTimeout', 'setInterval', 'setImmediate', 'nextTick', 'process.', 'fs.']) {
    assert.equal(src.includes(banned), false, `turn-machine.js mentions ${banned}`);
  }
  const saved = {};
  const names = ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'];
  const calls = [];
  for (const n of names) { saved[n] = globalThis[n]; globalThis[n] = (...a) => { calls.push(n); return saved[n](...a); }; }
  try {
    const { h, e1 } = threeTurns();
    h.hook('UserPromptSubmit', promptEnv('T4', 'x'));
    h.hook('PreToolUse', toolEnv('T4', 'tu1'));
    h.tx(opener('T4', 'u4a', e1), toolItem('tu1', 'u4b', 'u4a', 'Read'));
    h.hook('Stop', { prompt_id: 'T4', stop: { last_assistant_message: 'y' } });
    h.tm.statusClosed({ conversation_id: C });
    h.tm.processGone(C);
    h.tm.restoreTurns('conv-2', h.tm.exportTurns(S));
  } finally {
    for (const n of names) globalThis[n] = saved[n];
  }
  assert.deepEqual(calls, []);
});
