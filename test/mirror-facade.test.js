// The mirror engine's facade (lib/server/mirror/index.js, spec §2.12): the
// source contract and its dispatch table, the read boundary's redaction (§2.9),
// ingest from the hook tap, who interrupted a turn (§2.6, §15.2), the disabled
// state (§2.2), capabilities (§15.1) and the lifecycle.
//
// Pinned:
//   * a source registered through mirror.register hears onIngest,
//     onConversation, onChanges, onTurnOpened and onTurnClosed in the order the
//     engine makes them (a batch it applied itself goes to the OTHER sources),
//     and its api answers through the dispatch table;
//   * every dispatched result passes redactOut — a planted fake secret and the
//     home path are masked on every row — save the two exemptions, skillFold
//     and attachToNode; an attachment's bytes pass untouched while its metadata
//     is redacted; the facade's own reads and its content frames pass too;
//   * an unregistered source (or a missing api method, or a stopped mirror)
//     answers {unavailable: true} for every dispatched method;
//   * ingest is idempotent (by session_id, event, ts and tool.use_id) and never
//     throws on a malformed envelope;
//   * a main-bus control interrupt via tty gives the next interrupted close of
//     its session ended_by 'web'; via hook it outlasts the Esc window and gives
//     'hook'; with none, the transcript's marker gives 'terminal';
//   * capabilities list every key, the control layer's false;
//   * switched off, sources stop, content is dropped and ingests are ignored;
//     switched on, the sources start again;
//   * stop() leaves no open handle: a process that runs the whole lifecycle,
//     with a source that leaks a timer, an interval and a watcher, exits on its
//     own.
//
// The Claude tier is a private fake (test-support/claude-home, isolate: true),
// HOME a throwaway (withTempHome), the facade's clock injected (its timers are
// real), and no envelope names a Claude Code pid, so nothing is sampled.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { withTempHome, waitUntil } = require('../test-support/helpers');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { createRedactor, MASK } = require('../lib/core/redact');
const { createBus } = require('../lib/core/bus');
const { homeDir, projectPaths } = require('../lib/core/paths');
const { createHookTap } = require('../lib/server/hook-tap');
const {
  createMirror, SOURCES, DISPATCH, CAPABILITIES, INTERRUPT_HOLD_MS, HALT_HOLD_MAX_MS,
} = require('../lib/server/mirror');

const REPO = path.resolve(__dirname, '..');
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const CONTROL_KEYS = ['interrupt', 'code_revert', 'fork', 'mod', 'rewind_in_place'];
// The mask's opening, as the redactor writes it (built through MASK, never spelled).
const MASK_OPEN = MASK('x').slice(0, -'x›'.length);

// ── fixtures ─────────────────────────────────────────────────────────────────

function project(t) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-facade-'));
  fs.mkdirSync(path.join(dir, '.web-chat'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A clock the test moves; it starts at the wall clock so file and record times
// stay comparable.
function fakeClock() {
  let t = Date.now();
  return { now: () => t, tick(ms = 1) { t += ms; return t; } };
}

// The facade over a fresh project and a private Claude tier, wired the way
// createServer wires it: the hook tap, the surface's bus, the mirror bus with a
// broadcaster of its own.
function setup(t, options = {}) {
  let mirror = null;
  t.after(async () => { if (mirror) await mirror.stop(); }); // first registered, first run
  withTempHome(t);
  const root = project(t);
  const ch = claudeHome(t, { root, isolate: true });
  const clock = fakeClock();
  const hooks = createHookTap();
  const mainBus = createBus();
  const mirrorBus = createBus({ maxEvents: 2000 });
  const frames = [];
  mirrorBus.setBroadcaster((frame) => frames.push(frame));
  const redactor = createRedactor();
  const logs = [];
  mirror = createMirror({
    root, hooks, mainBus, mirrorBus, redactor, now: clock.now, log: (...a) => logs.push(a.join(' ')),
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    ...options,
  });
  const transitions = [];
  mirror.subscribe((e) => transitions.push(e));
  const h = { root, ch, clock, hooks, mainBus, mirrorBus, frames, redactor, logs, mirror, transitions };
  h.env = (event, extra = {}, sid = S1) => ({
    v: 1, event, ts: clock.tick(), session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd,
    prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
    result: null, session: null, compact: null, stop: null, prompt: null, ask: null, ...extra,
  });
  h.publish = (event, extra, sid) => hooks.publish(h.env(event, extra, sid));
  h.start = (sid = S1) => h.publish('SessionStart', { session: { source: 'startup' } }, sid);
  h.prompt = (pid, text = `prompt ${pid}`, sid = S1) => h.publish('UserPromptSubmit', { prompt_id: pid, prompt: { author: 'user', text } }, sid);
  h.closes = () => transitions.filter((e) => e.op === 'turn-closed');
  h.interrupt = (fields) => mainBus.emit({ event: { kind: 'control', op: 'interrupt', id: `ctl-${clock.tick()}`, ...fields } });
  return h;
}

// A source that records every hook it hears into `log` (shared, so the order
// across sources shows), with the engine it was handed.
function recorder(name, { log = [], api = {} } = {}) {
  const box = { engine: null, log };
  box.source = {
    attach(engine) {
      box.engine = engine;
      return {
        start: async () => { log.push(`${name}.start`); },
        stop: async () => { log.push(`${name}.stop`); },
        onIngest: (env, info) => log.push(`${name}.onIngest:${env.event}:${info.conversation_id}`),
        onConversation: (ev) => log.push(`${name}.onConversation:${ev.change}:${ev.conversation.id}`),
        onChanges: (sid, changes, info) => log.push(`${name}.onChanges:${sid}:${changes.length}:${info.conversation_id}`),
        onTurnOpened: (turn) => log.push(`${name}.onTurnOpened:${turn.id}`),
        onTurnClosed: (turn) => log.push(`${name}.onTurnClosed:${turn.id}:${turn.status}`),
        api,
      };
    },
  };
  return box;
}

// A source with an api and nothing else.
const apiSource = (api) => () => ({ start: async () => {}, stop: async () => {}, api });

// Transcript changes, in the change contract turn-machine.js's header writes down.
const opener = (pid, uuid, parent, text, ts) => ({ type: 'opener', prompt_id: pid, uuid, parent_uuid: parent, kind: 'prompt', text, ts });
const reply = (id, uuid, parent, text, ts) => ({ type: 'item', uuid, parent_uuid: parent, ts, item: { id, kind: 'reply', text } });
const marker = (uuid, parent, ts) => ({ type: 'interrupt', uuid, parent_uuid: parent, ts, text: '[Request interrupted by user]' });
const duration = (uuid, parent, ts, ms = 400) => ({ type: 'turn-duration', uuid, parent_uuid: parent, duration_ms: ms, ts });

// Everything but the revs and the clock: what an envelope's effect is.
function settled(v) {
  if (Array.isArray(v)) return v.map(settled);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) if (k !== 'rev' && k !== 'now') out[k] = settled(v[k]);
    return out;
  }
  return v;
}

// ── the source contract ──────────────────────────────────────────────────────

test('a registered source hears onIngest, onConversation, onChanges, onTurnOpened and onTurnClosed in order, and its api answers through the dispatch table', async (t) => {
  const h = setup(t);
  const log = [];
  const tx = recorder('transcripts', { log, api: { turns: (cid, q) => ({ conversation_id: cid, q, turns: [] }) } });
  const other = recorder('tasks', { log });
  assert.deepEqual(Object.keys(h.mirror.register('transcripts', tx.source)), ['turns'], 'register answers the api it read');
  h.mirror.register('tasks', other.source);
  await h.mirror.start();
  assert.deepEqual(log.splice(0), ['transcripts.start', 'tasks.start']);

  h.start();
  assert.deepEqual(log.splice(0), [
    `transcripts.onConversation:added:${S1}`, `tasks.onConversation:added:${S1}`,
    `transcripts.onIngest:SessionStart:${S1}`, `tasks.onIngest:SessionStart:${S1}`,
  ], 'the registry\'s change first, then the envelope, after the engine\'s own ingest');

  h.prompt('pA', 'fix the rail');
  assert.deepEqual(log.splice(0), [
    'transcripts.onTurnOpened:pA', 'tasks.onTurnOpened:pA',
    `transcripts.onIngest:UserPromptSubmit:${S1}`, `tasks.onIngest:UserPromptSubmit:${S1}`,
  ]);

  const ts = h.clock.tick();
  const r = tx.engine.applyChanges(S1, [opener('pA', 'u1', null, 'fix the rail', ts), reply('r_m1', 'u2', 'u1', 'Done.', ts)]);
  assert.deepEqual(r, { ok: true, applied: 2 });
  assert.deepEqual(log.splice(0), [`tasks.onChanges:${S1}:2:${S1}`], 'every OTHER source hears the batch');
  assert.equal(h.mirror.snapshot().conversations[0].open_turn_id, 'pA', 'the opener bound the hook\'s turn');

  h.publish('Stop', { prompt_id: 'pA', stop: { last_assistant_message: 'Done.' } });
  assert.deepEqual(log.splice(0), [
    'transcripts.onTurnClosed:pA:done', 'tasks.onTurnClosed:pA:done',
    `transcripts.onIngest:Stop:${S1}`, `tasks.onIngest:Stop:${S1}`,
  ]);

  // The api, through the dispatch table: the arguments as given, the answer
  // through the read boundary.
  assert.deepEqual(await h.mirror.turns(S1, { limit: 5 }), { conversation_id: S1, q: { limit: 5 }, turns: [] });

  await h.mirror.stop();
  assert.deepEqual(log.splice(0), ['tasks.stop', 'transcripts.stop'], 'stopped in reverse order');
});

test('the engine a source is handed: the contract\'s members, the turn machine\'s operations, never the turn writer', async (t) => {
  const h = setup(t);
  const probe = recorder('probe');
  h.mirror.register('probe', probe.source);
  const e = probe.engine;
  assert.deepEqual(Object.keys(e).sort(), [
    'applyChanges', 'beginIndex', 'conversations', 'files', 'graph', 'live', 'log', 'mainBus', 'model', 'name', 'now',
    'paths', 'processGone', 'procs', 'redactor', 'reset', 'restoreSourceStates', 'root', 'sourceStates', 'statusClosed',
    'timers', 'transition', 'watchFile',
  ]);
  assert.ok(Object.isFrozen(e));
  assert.equal(e.name, 'probe');
  assert.equal(e.root, h.root);
  assert.equal(e.paths.mirrorDir, projectPaths(h.root).mirrorDir);
  assert.equal(e.redactor, h.redactor);
  for (const k of ['openTurn', 'closeTurn', 'supersede', 'openTurnOf', 'resolveTurn', 'pendingTurns', 'attachTurn',
    'orphanPending', 'exportTurns', 'restoreTurns', 'refill', 'configure', 'upsertItem', 'upsertTask', 'removeTask',
    'patchTurn', 'scrubText', 'turn', 'item']) {
    assert.equal(typeof e.model[k], 'function', `model.${k}`);
  }
  for (const k of ['claimTurnWriter', 'removeConversation', 'refillTurn', 'takeChanges']) assert.equal(e.model[k], undefined, `no model.${k}`);
  for (const k of ['transcriptFile', 'sessionDirFile', 'taskOutputFile', 'planFile', 'readWindow']) assert.equal(typeof e.files[k], 'function');
  assert.deepEqual(Object.keys(e.conversations).sort(), ['bySession', 'get', 'list', 'markFork', 'noteTitle', 'processOf', 'sessionDir', 'transcriptPath']);
  assert.deepEqual(Object.keys(e.live).sort(), ['liveOf', 'noteActivity']);
  assert.deepEqual(Object.keys(e.timers).sort(), ['clear', 'clearInterval', 'clearTimeout', 'setInterval', 'setTimeout']);
  assert.deepEqual(Object.keys(e.mainBus).sort(), ['read', 'subscribe']);

  // A source cannot apply a batch for a session nobody knows.
  assert.deepEqual(e.applyChanges(S2, []), { ok: false, reason: 'unknown-session', applied: 0 });
  assert.deepEqual(e.applyChanges('../x', []), { ok: false, reason: 'bad-batch', applied: 0 });
});

test('a source\'s catch-up runs in index mode: no stream frame until it ends, then one mirror:reset', async (t) => {
  const h = setup(t);
  const tx = recorder('transcripts');
  h.mirror.register('transcripts', tx.source);
  await h.mirror.start();
  h.start();
  const end = tx.engine.beginIndex({ conversation_id: S1 });
  let ts = h.clock.tick();
  let parent = null;
  for (let n = 1; n <= 20; n++) {
    tx.engine.applyChanges(S1, [opener(`P${n}`, `u${n}a`, parent, `old prompt ${n}`, ts), reply(`r_${n}`, `u${n}b`, `u${n}a`, `answer ${n}`, ts),
      duration(`u${n}c`, `u${n}b`, ts)]);
    parent = `u${n}c`;
    ts = h.clock.tick(10);
  }
  h.clock.tick(500);
  await waitUntil(() => h.frames.some((f) => f.type === 'mirror:update'), { timeout: 5000, what: 'the catch-up\'s update frame' });
  assert.equal(h.frames.filter((f) => f.type === 'mirror:stream').length, 0, 'no turn or item frame while indexing');
  end();
  h.clock.tick(500);
  const reset = await waitUntil(() => h.frames.find((f) => f.type === 'mirror:reset'), { timeout: 5000, what: 'the catch-up\'s reset' });
  assert.deepEqual(reset, { type: 'mirror:reset', reason: 'catch-up', conversation_id: S1 });
  assert.equal(h.mirror.snapshot().conversations[0].turn_count, 20);

  // reset(): one more, for a reason of the source's.
  assert.equal(tx.engine.reset({ reason: 'rewritten', conversation_id: S1 }), true);
  h.clock.tick(500);
  await waitUntil(() => h.frames.some((f) => f.type === 'mirror:reset' && f.reason === 'rewritten'), { timeout: 5000, what: 'the source\'s reset' });
});

test('register refuses a bad name, a second source of one name and an attach that returns no source', (t) => {
  const h = setup(t);
  assert.deepEqual(SOURCES.map((s) => s.name), ['live'], 'tranche 1 registers live');
  assert.throws(() => h.mirror.register('live', apiSource({})), /already registered/);
  for (const bad of ['', 'Transcripts', '1x', 'a b', null, 'x'.repeat(33)]) assert.throws(() => h.mirror.register(bad, apiSource({})), /lowercase word/);
  assert.throws(() => h.mirror.register('x', {}), /attach/);
  assert.throws(() => h.mirror.register('y', () => null), /start, stop/);
  assert.throws(() => h.mirror.register('z', () => ({ start() {} })), /start, stop/);
});

test('sourceStates hands the index store each source\'s slice through the redactor, and restoreSourceStates hands it back', (t) => {
  const h = setup(t);
  const [fake] = fakeSecrets({ seed: 3 }).filter((f) => f.rule === 'jwt');
  const restored = [];
  h.mirror.register('a', () => ({
    start: async () => {}, stop: async () => {},
    persistState: (sid) => ({ sid, note: `carried ${fake.text}`, n: 2 }),
    restoreState: (sid, v) => restored.push(['a', sid, v]),
  }));
  h.mirror.register('b', () => ({ start: async () => {}, stop: async () => {}, persistState: () => { throw new Error('a broken source'); } }));
  const probe = recorder('probe');
  h.mirror.register('probe', probe.source);
  const states = probe.engine.sourceStates(S1);
  assert.deepEqual(Object.keys(states), ['a'], 'a source whose persistState throws is left out');
  assert.equal(states.a.sid, S1);
  assert.equal(states.a.n, 2);
  assert.deepEqual(findLeaks(JSON.stringify(states), [fake]), []);
  assert.ok(states.a.note.includes(MASK_OPEN));
  probe.engine.restoreSourceStates(S1, { a: { x: 1 }, nobody: { y: 2 } });
  assert.deepEqual(restored, [['a', S1, { x: 1 }]]);
});

// ── the read boundary (§2.9) ─────────────────────────────────────────────────

test('every dispatched result passes the read boundary: a planted secret and the home path are masked; skillFold and attachToNode are the only exemptions', async (t) => {
  const h = setup(t);
  const fakes = fakeSecrets({ seed: 12 }).filter((f) => !f.context && !f.known);
  const home = homeDir();
  const payload = () => ({
    note: `read ${home}/notes/today.md, then ${h.root}/lib/x.js`,
    secrets: fakes.map((f) => f.text),
    nested: { deeper: [{ line: fakes[0].text }] },
    count: 3,
  });
  const apis = {};
  for (const row of Object.values(DISPATCH)) {
    (apis[row.source] = apis[row.source] || {})[row.method] = () => (row.async ? Promise.resolve(payload()) : payload());
  }
  for (const name of Object.keys(apis)) h.mirror.register(name, apiSource(apis[name]));
  await h.mirror.start();

  const args = {
    turns: [S1, {}], turn: ['t1'], itemField: ['i1', { field: 'text' }], attachment: ['i1', 0], skillFold: [S1],
    forkAnchor: ['t1'], taskOutput: ['k1', {}], markStopRequested: ['k1'], agent: ['a1', {}], workflow: ['w1'],
    diff: [{ turn: 't1' }], nodeTurns: ['n1.1'], nodeSummaries: [], attachToNode: ['n1', { commit: null }],
  };
  assert.deepEqual(Object.keys(args).sort(), Object.keys(DISPATCH).sort(), 'every row is exercised');
  const exempt = [];
  for (const [method, row] of Object.entries(DISPATCH)) {
    const out = h.mirror[method](...args[method]);
    assert.equal(out instanceof Promise, row.async === true, `${method}: ${row.async ? 'a Promise' : 'sync'}`);
    const got = await out;
    const text = JSON.stringify(got);
    if (row.exempt) {
      exempt.push(method);
      assert.deepEqual(got, payload(), `${method} is exempt: as the source gave it`);
      continue;
    }
    assert.deepEqual(findLeaks(text, fakes), [], `${method}: no planted secret survives`);
    assert.ok(text.includes(MASK_OPEN), `${method}: masked, not dropped`);
    assert.ok(!text.includes(home), `${method}: the home directory is masked`);
    assert.ok(!text.includes(h.root), `${method}: the project root is masked`);
    assert.equal(got.note, 'read ~/notes/today.md, then <project>/lib/x.js', method);
    assert.equal(got.count, 3, `${method}: a number passes as it is`);
  }
  assert.deepEqual(exempt.sort(), ['attachToNode', 'skillFold']);
});

test('an attachment\'s bytes pass the read boundary untouched while its metadata is redacted', async (t) => {
  const h = setup(t);
  const [fake] = fakeSecrets({ seed: 5 }).filter((f) => f.rule === 'jwt');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7b, 0x22]);
  h.mirror.register('transcripts', apiSource({
    attachment: async () => ({ media_type: 'image/png', name: `shot of ${homeDir()}/x.png ${fake.text}`, bytes, parts: [bytes] }),
  }));
  await h.mirror.start();
  const got = await h.mirror.attachment('i1', 0);
  assert.ok(Buffer.isBuffer(got.bytes) && got.bytes.equals(bytes), 'the bytes, as they were');
  assert.ok(Buffer.isBuffer(got.parts[0]) && got.parts[0].equals(bytes));
  assert.equal(got.media_type, 'image/png');
  assert.ok(got.name.startsWith('shot of ~/x.png '));
  assert.deepEqual(findLeaks(got.name, [fake]), []);
});

test('the facade\'s own reads and its content frames pass the read boundary: a known value learnt later and the home path are masked', async (t) => {
  const h = setup(t);
  const probe = recorder('probe');
  h.mirror.register('probe', probe.source);
  await h.mirror.start();
  const home = homeDir();
  const org = 'org-7d1c2b9e4f6a8035';
  h.start();
  h.prompt('pA', 'clean up');
  h.publish('PermissionRequest', {
    prompt_id: 'pA',
    tool: { name: 'Bash', kind: 'Bash', label: 'Bash · rm', call: `Bash(rm -rf ${home}/scratch --org ${org})`, input: { command: 'rm' }, input_hash: 'h1' },
  });
  const held = probe.engine.model.live(S1);
  assert.equal(held.state, 'waiting');
  assert.ok(held.waiting.summary.includes(home), 'the model holds the call as the redactor passed it');
  // The redactor learns the organisation id after the text was stored.
  h.redactor.addKnown(org, 'org');
  probe.engine.model.upsertTask({ id: 'k1', conversation_id: S1, kind: 'shell', title: `tail ${home}/log`, status: 'running', line: `${org} up` });

  const live = h.mirror.liveOf(S1);
  assert.equal(live.state, 'waiting');
  assert.equal(live.waiting.summary, `Bash(rm -rf ~/scratch --org ${MASK('org')})`);
  assert.deepEqual(h.mirror.liveOf(S1), live, 'by session id as well');
  const snap = h.mirror.snapshot({ level: 'local' });
  assert.equal(snap.conversations[0].live.waiting.summary, live.waiting.summary);
  assert.equal(snap.tasks[0].title, 'tail ~/log');
  const tasks = h.mirror.tasks();
  assert.equal(tasks.tasks[0].line, `${MASK('org')} up`);
  assert.equal(tasks.counts.shells.running, 1);
  for (const v of [live, snap, tasks]) {
    const text = JSON.stringify(v);
    assert.ok(!text.includes(home) && !text.includes(org), text);
  }

  // The frames: the next flush carries the live state and the task.
  h.clock.tick(500);
  const update = await waitUntil(() => h.frames.find((f) => f.type === 'mirror:update' && f.tasks), { timeout: 5000, what: 'an update frame with the task' });
  const frames = JSON.stringify(h.frames.filter((f) => f.type === 'mirror:update' || f.type === 'mirror:stream'));
  assert.ok(!frames.includes(home), 'no frame carries the home directory');
  assert.ok(!frames.includes(org), 'no frame carries the known value');
  assert.equal(update.tasks[0].title, 'tail ~/log');
});

// ── unavailable ──────────────────────────────────────────────────────────────

test('a method whose source is not registered answers {unavailable: true}, nodeSummaries and forkAnchor included', async (t) => {
  const h = setup(t);
  // A registered source without the method answers the same.
  h.mirror.register('graph-link', apiSource({ nodeTurns: () => ({ node: { id: 'n1' }, turns: [] }) }));
  await h.mirror.start();
  for (const [method, row] of Object.entries(DISPATCH)) {
    if (method === 'nodeTurns') continue;
    const out = h.mirror[method]('x', {});
    if (row.async) {
      assert.ok(out instanceof Promise, method);
      assert.deepEqual(await out, { unavailable: true }, method);
    } else {
      assert.deepEqual(out, { unavailable: true }, method);
    }
  }
  assert.deepEqual(h.mirror.nodeSummaries(), { unavailable: true });
  assert.deepEqual(await h.mirror.forkAnchor('t1'), { unavailable: true });
  assert.deepEqual(h.mirror.nodeTurns('n1'), { node: { id: 'n1' }, turns: [] });
  // Once the mirror has stopped, every method.
  await h.mirror.stop();
  assert.deepEqual(h.mirror.nodeTurns('n1'), { unavailable: true });
});

test('a dispatched call that throws: the Promise methods reject, attachToNode answers null so a commit never fails', async (t) => {
  const h = setup(t);
  h.mirror.register('transcripts', apiSource({ turn: () => { throw new TypeError('boom'); } }));
  h.mirror.register('graph-link', apiSource({ attachToNode: () => { throw new TypeError('boom'); }, nodeTurns: () => { throw new TypeError('boom'); } }));
  await h.mirror.start();
  await assert.rejects(h.mirror.turn('t1'), /boom/);
  assert.equal(h.mirror.attachToNode('n1', {}), null);
  assert.ok(h.logs.some((l) => l === 'mirror: graph-link.attachToNode failed (TypeError)'), h.logs.join('\n'));
  assert.throws(() => h.mirror.nodeTurns('n1'), /boom/);
});

// ── ingest ───────────────────────────────────────────────────────────────────

test('ingest is idempotent: an envelope seen before, directly or through the tap, changes nothing', async (t) => {
  const h = setup(t);
  const probe = recorder('probe');
  h.mirror.register('probe', probe.source);
  await h.mirror.start();
  const tool = { name: 'Read', use_id: 'tu1', kind: 'Read', label: 'Read · a.js', call: 'Read(a.js)', input: { file_path: 'a.js' }, input_hash: 'h1' };
  const seq = [
    h.env('SessionStart', { session: { source: 'startup' } }),
    h.env('UserPromptSubmit', { prompt_id: 'pA', prompt: { author: 'user', text: 'read it' } }),
    h.env('PreToolUse', { prompt_id: 'pA', tool }),
    h.env('PostToolUse', { prompt_id: 'pA', tool, result: { ok: true, duration_ms: 3 } }),
    h.env('PreToolUse', { prompt_id: 'pA', tool: { ...tool, use_id: 'tu2' } }),
  ];
  for (const env of seq) h.mirror.ingest(env);
  // The §2.6 transitions an envelope makes (a flush's `update` ring event comes
  // with the timer, whatever is ingested).
  const made = () => h.transitions.filter((e) => e.op !== 'update' && e.op !== 'reset').length;
  const once = {
    snapshot: settled(h.mirror.snapshot({ level: 'local' })),
    transitions: made(),
    heard: probe.log.length,
    accepted: h.mirror.stats().ingest.accepted,
  };
  assert.equal(once.accepted, seq.length);
  assert.ok(once.transitions > 0);
  for (const env of seq) h.mirror.ingest({ ...env });
  for (const env of seq) h.hooks.publish(env);
  assert.deepEqual(settled(h.mirror.snapshot({ level: 'local' })), once.snapshot);
  assert.equal(made(), once.transitions, 'no transition again');
  assert.equal(probe.log.length, once.heard, 'no source heard them again');
  const { accepted, duplicates } = h.mirror.stats().ingest;
  assert.equal(accepted, seq.length);
  assert.equal(duplicates, 2 * seq.length);
  // Two envelopes of one session, event and millisecond are still two when
  // their tools differ.
  const ts = h.clock.tick();
  h.mirror.ingest({ ...h.env('PreToolUse', { prompt_id: 'pA', tool: { ...tool, use_id: 'tu3', input_hash: 'h3' } }), ts });
  h.mirror.ingest({ ...h.env('PreToolUse', { prompt_id: 'pA', tool: { ...tool, use_id: 'tu4', input_hash: 'h4' } }), ts });
  assert.equal(h.mirror.stats().ingest.accepted, seq.length + 2);
});

test('ingest never throws on a malformed envelope, and makes nothing of one', async (t) => {
  const h = setup(t);
  await h.mirror.start();
  h.start();
  const before = settled(h.mirror.snapshot({ level: 'local' }));
  const accepted = h.mirror.stats().ingest.accepted;
  const throwing = { get session_id() { throw new Error('a getter that throws'); }, event: 'Stop' };
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('a trap that throws'); } });
  const bad = [
    undefined, null, 42, 'SessionStart', [], {}, Object.create(null), { event: 5 }, { session_id: {} },
    { event: 'PreToolUse', session_id: S1 }, // no transcript path, no cwd
    { ...h.env('PreToolUse'), tool: 'Read', result: 7, agent: [], ask: 'x' },
    { ...h.env('PreToolUse'), cwd: '/nowhere/at/all' },
    { ...h.env('PreToolUse'), transcript_path: '/etc/passwd' },
    { ...h.env('Stop'), session_id: '../../x' },
    { ...h.env('PermissionResolved'), synthetic: true, session_id: S2 },
    throwing, hostile,
  ];
  for (const env of bad) assert.doesNotThrow(() => h.mirror.ingest(env));
  for (const env of bad.slice(0, -2)) assert.doesNotThrow(() => h.hooks.publish(env));
  assert.equal(h.mirror.stats().ingest.accepted, accepted + 1, 'only the one with a malformed tool and result was this project\'s');
  const after = settled(h.mirror.snapshot({ level: 'local' }));
  assert.deepEqual(after.conversations.map((c) => c.id), before.conversations.map((c) => c.id));
  assert.ok(h.mirror.stats().ingest.ignored['foreign-root'] >= 1);
  assert.ok(h.mirror.stats().ingest.ignored['bad-path'] >= 1);
});

test('ingest before start, and after stop, is ignored', async (t) => {
  const h = setup(t);
  h.mirror.ingest(h.env('SessionStart', { session: { source: 'startup' } }));
  assert.equal(h.mirror.stats().ingest.accepted, 0);
  assert.equal(h.mirror.stats().ingest.ignored['not-running'], 1);
  await h.mirror.start();
  h.start();
  assert.equal(h.mirror.stats().ingest.accepted, 1);
  await h.mirror.stop();
  h.mirror.ingest(h.env('UserPromptSubmit', { prompt_id: 'pA', prompt: { author: 'user', text: 'x' } }));
  assert.equal(h.mirror.stats().ingest.accepted, 1);
});

// ── who interrupted (§2.6, §15.2) ────────────────────────────────────────────

test('a mainBus control interrupt via tty makes the next interrupted close of that session carry ended_by web', async (t) => {
  const h = setup(t);
  const tx = recorder('transcripts');
  h.mirror.register('transcripts', tx.source);
  await h.mirror.start();
  h.start();
  h.prompt('pA', 'run the tests');
  tx.engine.applyChanges(S1, [opener('pA', 'u1', null, 'run the tests', h.clock.tick())]);
  h.interrupt({ conversation_id: S1, session_id: S1, via: 'tty', target_pid: 4242, expires_at: h.clock.now() + 2000 });
  h.clock.tick(800);
  tx.engine.applyChanges(S1, [marker('u2', 'u1', h.clock.tick()), duration('u3', 'u2', h.clock.tick())]);
  const [closed] = h.closes();
  assert.equal(closed.turn_id, 'pA');
  assert.equal(closed.outcome, 'interrupted');
  assert.equal(closed.by, 'transcript');
  assert.equal(closed.ended_by, 'web', 'turn-closed carries who stopped it');
  assert.equal(h.mirror.liveOf(S1).last_turn.ended_by, 'web');
  assert.equal(h.mirror.stats().interrupts, 0, 'the request is spent with its turn');

  // The next turn's interruption, with no request, is the terminal's.
  h.prompt('pB', 'again');
  tx.engine.applyChanges(S1, [opener('pB', 'u4', 'u3', 'again', h.clock.tick()), marker('u5', 'u4', h.clock.tick()), duration('u6', 'u5', h.clock.tick())]);
  assert.equal(h.closes()[1].ended_by, 'terminal');

  // The next prompt arriving with no Stop closes the open turn interrupted: a
  // request names the page.
  h.prompt('pC', 'one');
  h.interrupt({ session_id: S1, via: 'tty', expires_at: h.clock.now() + 2000 });
  h.prompt('pD', 'two');
  const c = h.closes()[2];
  assert.deepEqual([c.turn_id, c.by, c.ended_by], ['pC', 'next-turn', 'web']);
});

test('a halt (via hook) outlasts the Esc window, until its turn closes, and gives ended_by hook; an Esc request expires', async (t) => {
  const h = setup(t);
  const tx = recorder('transcripts');
  h.mirror.register('transcripts', tx.source);
  await h.mirror.start();
  h.start();
  h.prompt('pA', 'build');
  tx.engine.applyChanges(S1, [opener('pA', 'u1', null, 'build', h.clock.tick())]);
  // The halt flag's expiry is epoch seconds, ten minutes ahead.
  h.interrupt({ conversation_id: S1, session_id: S1, via: 'hook', expires_at: Math.floor(h.clock.now() / 1000) + 600 });
  h.clock.tick(INTERRUPT_HOLD_MS + 50000); // the running tool takes a minute to end
  tx.engine.applyChanges(S1, [marker('u2', 'u1', h.clock.tick()), duration('u3', 'u2', h.clock.tick())]);
  assert.equal(h.closes()[0].ended_by, 'hook');
  assert.equal(h.mirror.liveOf(S1).last_turn.ended_by, 'hook');

  // An Esc request is held INTERRUPT_HOLD_MS at most.
  h.prompt('pB', 'again');
  tx.engine.applyChanges(S1, [opener('pB', 'u4', 'u3', 'again', h.clock.tick())]);
  h.interrupt({ conversation_id: S1, session_id: S1, via: 'tty', expires_at: h.clock.now() + 2000 });
  h.clock.tick(INTERRUPT_HOLD_MS + 1);
  tx.engine.applyChanges(S1, [marker('u5', 'u4', h.clock.tick()), duration('u6', 'u5', h.clock.tick())]);
  assert.equal(h.closes()[1].ended_by, 'terminal');

  // A halt with no expiry is held HALT_HOLD_MAX_MS at most.
  h.prompt('pC', 'third');
  tx.engine.applyChanges(S1, [opener('pC', 'u7', 'u6', 'third', h.clock.tick())]);
  h.interrupt({ session_id: S1, via: 'hook' });
  h.clock.tick(HALT_HOLD_MAX_MS + 1);
  tx.engine.applyChanges(S1, [marker('u8', 'u7', h.clock.tick()), duration('u9', 'u8', h.clock.tick())]);
  assert.equal(h.closes()[2].ended_by, 'terminal');
});

test('with no control event an interrupt marker gives ended_by terminal; another session\'s request, or a stray via, names nobody', async (t) => {
  const h = setup(t);
  const tx = recorder('transcripts');
  h.mirror.register('transcripts', tx.source);
  await h.mirror.start();
  h.start();
  h.start(S2);
  h.prompt('pA', 'go');
  tx.engine.applyChanges(S1, [opener('pA', 'u1', null, 'go', h.clock.tick())]);
  h.interrupt({ conversation_id: S2, session_id: S2, via: 'tty', expires_at: h.clock.now() + 2000 });
  h.interrupt({ conversation_id: S1, session_id: S1, via: 'telepathy' });
  h.mainBus.emit({ event: { kind: 'control', op: 'restore', session_id: S1, via: 'tty' } });
  tx.engine.applyChanges(S1, [marker('u2', 'u1', h.clock.tick()), duration('u3', 'u2', h.clock.tick())]);
  const [closed] = h.closes();
  assert.deepEqual([closed.turn_id, closed.outcome, closed.ended_by], ['pA', 'interrupted', 'terminal']);
  // A turn that ends normally carries no ended_by at all.
  h.prompt('pB', 'fine');
  h.publish('Stop', { prompt_id: 'pB', stop: { last_assistant_message: 'ok' } });
  assert.equal('ended_by' in h.closes()[1], false);
});

test('a StopFailure\'s message rides into the live state\'s last_turn', async (t) => {
  const h = setup(t);
  await h.mirror.start();
  h.start();
  h.prompt('pA', 'go');
  h.publish('StopFailure', { prompt_id: 'pA', stop: { error: `API Error: 529 overloaded at ${homeDir()}/x` } });
  const live = h.mirror.liveOf(S1);
  assert.equal(live.last_turn.id, 'pA');
  assert.equal(live.last_turn.outcome, 'error');
  assert.equal(live.last_turn.error, 'API Error: 529 overloaded at ~/x');
  // It stays through the live state's later recomputes.
  h.publish('PreToolUse', { tool: { name: 'Read', use_id: 'tu9', kind: 'Read', label: 'Read · b.js', input: {}, input_hash: 'h9' } });
  h.publish('PostToolUse', { tool: { name: 'Read', use_id: 'tu9', kind: 'Read', label: 'Read · b.js', input: {}, input_hash: 'h9' }, result: { ok: true } });
  assert.equal(h.mirror.liveOf(S1).last_turn.error, live.last_turn.error);
});

// ── capabilities (§15.1) ─────────────────────────────────────────────────────

test('capabilities list every key, the control layer\'s false in tranche 1', async (t) => {
  const h = setup(t);
  await h.mirror.start();
  const caps = h.mirror.snapshot({ level: 'local' }).capabilities;
  assert.deepEqual(Object.keys(caps), ['answer', 'task_stop', 'queue_message', 'turn_diff', 'node_diff', 'attachments',
    'agent_items', 'interrupt', 'code_revert', 'fork', 'mod', 'rewind_in_place']);
  assert.deepEqual(Object.keys(caps), Object.keys(CAPABILITIES));
  for (const k of Object.keys(caps)) assert.equal(caps[k], false, `${k}: no source behind it in tranche 1`);
  // A source behind a key turns that key on, and only that one; the control
  // layer's stay off whatever registers.
  h.mirror.register('codediff', apiSource({ diff: async () => ({}) }));
  h.mirror.register('graph-link', apiSource({ nodeTurns: () => ({}), attachToNode: () => null }));
  h.mirror.register('transcripts', apiSource({ attachment: async () => null }));
  const after = h.mirror.snapshot({ level: 'local' }).capabilities;
  assert.deepEqual(Object.keys(after).filter((k) => after[k]).sort(), ['attachments', 'node_diff', 'turn_diff']);
  for (const k of CONTROL_KEYS) assert.equal(after[k], false, k);
  // Below `read` the snapshot carries no capabilities, and no content.
  const basic = h.mirror.snapshot({ level: 'basic' });
  assert.deepEqual(Object.keys(basic).sort(), ['aggregate', 'asks', 'conversations', 'now', 'primary', 'rev']);
});

// ── the snapshot, the status and the summary ─────────────────────────────────

test('snapshot names the primary — never a headless conversation — and bounds the ended ones by since', async (t) => {
  const h = setup(t);
  await h.mirror.start();
  h.start(S1);
  // A `claude -p` working: every one of its envelopes says sdk-cli.
  h.publish('SessionStart', { session: { source: 'startup' }, entrypoint: 'sdk-cli' }, S2);
  h.publish('UserPromptSubmit', { prompt_id: 'pH', prompt: { author: 'user', text: 'headless work' }, entrypoint: 'sdk-cli' }, S2);
  const snap = h.mirror.snapshot({ level: 'local' });
  assert.equal(snap.primary, S1, 'the idle interactive session, not the working headless one');
  assert.deepEqual(snap.aggregate, { state: 'idle', conversations: 1 });
  assert.deepEqual(snap.conversations.map((c) => [c.id, c.headless]).sort(), [[S1, false], [S2, true]]);
  for (const c of snap.conversations) assert.equal(c.process, null, 'no pid named: no process');
  const st = h.mirror.status();
  assert.deepEqual(Object.keys(st).sort(), ['aggregate', 'conversations', 'now', 'rev']);
  assert.equal(st.conversations.length, 2);
  const sum = h.mirror.summary();
  assert.deepEqual(Object.keys(sum).sort(), ['conversations', 'enabled', 'last_hook_at', 'state']);
  assert.deepEqual([sum.enabled, sum.state, sum.conversations], [true, 'idle', 2]);
  assert.equal(sum.last_hook_at, h.clock.now());
  assert.equal(h.mirror.conversationOfPid(4242), null);
  assert.deepEqual(h.mirror.enabled(), { enabled: true });
});

// ── the disabled state (§2.2) ────────────────────────────────────────────────

test('switched off: sources stop, content is dropped and ingests are ignored; switched on, the sources start again', async (t) => {
  const h = setup(t, { conversationsOptions: { discoveryMs: 40 } });
  const probe = recorder('probe');
  h.mirror.register('probe', probe.source);
  await h.mirror.start();
  h.start();
  h.prompt('pA', 'one');
  assert.equal(h.mirror.snapshot().conversations.length, 1);

  const flag = projectPaths(h.root).disabled;
  fs.writeFileSync(flag, '');
  await waitUntil(() => h.mirror.enabled().enabled === false, { timeout: 10000, what: 'the toggle to read the marker' });
  assert.deepEqual(h.mirror.enabled(), { enabled: false, scope: 'project' });
  await waitUntil(() => probe.log.includes('probe.stop'), { timeout: 5000, what: 'the source to stop' });
  assert.ok(probe.log.includes(`probe.onConversation:removed:${S1}`));
  assert.equal(h.mirror.snapshot().conversations.length, 0, 'the content is dropped');
  assert.equal(h.mirror.summary().enabled, false);
  const accepted = h.mirror.stats().ingest.accepted;
  h.prompt('pB', 'two');
  assert.equal(h.mirror.stats().ingest.accepted, accepted, 'ignored while switched off');
  h.clock.tick(500);
  await waitUntil(() => h.frames.some((f) => f.type === 'mirror:reset' && f.reason === 'disabled'), { timeout: 5000, what: 'the disabled reset' });

  fs.rmSync(flag);
  await waitUntil(() => h.mirror.enabled().enabled === true, { timeout: 10000, what: 'the toggle to read the marker gone' });
  await waitUntil(() => probe.log.filter((l) => l === 'probe.start').length === 2, { timeout: 5000, what: 'the source to start again' });
  h.prompt('pC', 'three');
  assert.equal(h.mirror.stats().ingest.accepted, accepted + 1);
  h.clock.tick(500);
  await waitUntil(() => h.frames.some((f) => f.type === 'mirror:reset' && f.reason === 'enabled'), { timeout: 5000, what: 'the enabled reset' });
  assert.equal(h.mirror.snapshot().conversations.length, 1, 'rediscovered from the next envelope');
});

// ── the lifecycle ────────────────────────────────────────────────────────────

test('stop() clears every timer and watcher made through the engine, even those a source leaves', async (t) => {
  const h = setup(t);
  let fired = 0;
  const watched = path.join(h.root, 'watched.txt');
  fs.writeFileSync(watched, 'x');
  let engine = null;
  h.mirror.register('leaky', (e) => {
    engine = e;
    return {
      start: async () => {
        e.timers.setInterval(() => { fired += 1; }, 10);
        e.timers.setTimeout(() => { fired += 1000; }, 60000);
        e.watchFile(watched, () => {}, { pollMs: 50 });
        e.mainBus.subscribe(() => { fired += 1000000; });
      },
      stop: async () => {}, // leaves everything to the facade
    };
  });
  await h.mirror.start();
  h.start();
  h.prompt('pA', 'go');
  await waitUntil(() => fired > 0, { timeout: 5000, what: 'the interval to fire' });
  assert.ok(h.mirror.stats().timers >= 2);
  assert.equal(h.mirror.stats().watchers, 1);
  await h.mirror.stop();
  assert.equal(h.mirror.stats().timers, 0);
  assert.equal(h.mirror.stats().watchers, 0);
  const after = fired;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fired, after, 'nothing fires after stop');
  h.mainBus.emit({ event: { kind: 'store' } });
  assert.equal(fired, after, 'the source\'s main-bus subscription is gone');
  assert.equal(engine.timers.setTimeout(() => {}, 10), null, 'nothing is armed after stop');
  await engine.watchFile(watched, () => {}).stop();
  assert.equal(h.mirror.stats().watchers, 0);
  assert.equal(await h.mirror.stop(), undefined, 'stop is idempotent');
  assert.equal(await h.mirror.start(), undefined, 'a stopped mirror does not start again');
});

test('the engine\'s setInterval runs on a base that has only setTimeout, and stop() ends it', async (t) => {
  const h = setup(t, { timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (x) => clearTimeout(x) } });
  let fired = 0;
  let engine = null;
  let handle = null;
  h.mirror.register('ticker', (e) => {
    engine = e;
    return { start: async () => { handle = e.timers.setInterval(() => { fired += 1; }, 5); }, stop: async () => {} };
  });
  await h.mirror.start();
  await waitUntil(() => fired >= 3, { timeout: 5000, what: 'the chained interval to fire three times' });
  engine.timers.clearInterval(handle);
  const cleared = fired;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fired, cleared, 'clearInterval ends the chain');
  engine.timers.setInterval(() => { fired += 1; }, 5);
  await h.mirror.stop();
  const after = fired;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fired, after, 'stop() ends it');
  assert.equal(h.mirror.stats().timers, 0);
});

// The child runs the whole lifecycle — a pid it links and samples, the
// registry's watches, the flush, a source that leaves a timer, an interval, a
// watcher and a subscription behind — and must exit on its own: any handle
// left open would hold it.
const CHILD = `
const path = require('path');
const cfg = JSON.parse(process.env.WC_FACADE_CHILD);
const lib = (p) => require(path.join(cfg.repo, p));
const { createMirror } = lib('lib/server/mirror');
const { createRedactor } = lib('lib/core/redact');
const { createHookTap } = lib('lib/server/hook-tap');
const { createBus } = lib('lib/core/bus');
(async () => {
  const hooks = createHookTap();
  const mainBus = createBus();
  const mirror = createMirror({ root: cfg.root, hooks, mainBus, mirrorBus: createBus({ maxEvents: 2000 }), redactor: createRedactor() });
  mirror.register('leaky', (e) => ({
    start: async () => {
      e.timers.setInterval(() => {}, 20);
      e.timers.setTimeout(() => {}, 600000);
      e.watchFile(cfg.watched, () => {}, { pollMs: 50 });
      e.mainBus.subscribe(() => {});
    },
    stop: async () => {},
  }));
  await mirror.start();
  let ts = Date.now();
  const env = (event, extra) => Object.assign({ v: 1, event, ts: ++ts, session_id: cfg.sid, transcript_path: cfg.transcript,
    cwd: cfg.cwd, prompt_id: 'pA', claude_pid: process.pid, entrypoint: 'cli' }, extra);
  hooks.publish(env('SessionStart', { session: { source: 'startup' } }));
  hooks.publish(env('UserPromptSubmit', { prompt: { author: 'user', text: 'go' } }));
  hooks.publish(env('PreToolUse', { tool: { name: 'Bash', use_id: 'tu1', kind: 'Bash', label: 'Bash · ls', input: { command: 'ls' }, input_hash: 'h' } }));
  mainBus.emit({ event: { kind: 'control', op: 'interrupt', id: 'c1', session_id: cfg.sid, via: 'tty', expires_at: Date.now() + 2000 } });
  await new Promise((r) => setTimeout(r, 400));
  await mirror.stop();
  process.stdout.write(JSON.stringify(mirror.stats()) + '\\n');
})().catch((e) => { process.stderr.write(String(e && e.stack)); process.exitCode = 2; });
`;

test('stop() leaves no open handle: a process that runs the whole lifecycle exits on its own', async (t) => {
  const h = setup(t);
  const watched = path.join(h.root, 'watched.txt');
  fs.writeFileSync(watched, 'x');
  const cfg = { repo: REPO, root: h.root, sid: S1, transcript: h.ch.transcript(S1), cwd: h.ch.cwd, watched };
  const child = spawn(process.execPath, ['-e', CHILD], {
    env: { ...process.env, WC_FACADE_CHILD: JSON.stringify(cfg) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = await new Promise((resolve) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ timedOut: true, out, err }); }, 30000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
  assert.equal(result.timedOut, undefined, `the process was still running 30 s on: a handle outlived stop()\n${result.err}`);
  assert.equal(result.code, 0, result.err);
  const stats = JSON.parse(result.out.trim().split('\n').pop());
  assert.equal(stats.ingest.accepted, 3);
  assert.equal(stats.timers, 0);
  assert.equal(stats.watchers, 0);
  assert.equal(stats.conversations.watching, 0, 'the sessions-file watch is gone');
});

test('a source registered after start starts at once, and ready resolves once start has finished', async (t) => {
  const h = setup(t);
  const before = await Promise.race([h.mirror.ready.then(() => 'ready'), new Promise((r) => setTimeout(() => r('pending'), 50))]);
  assert.equal(before, 'ready', 'ready before start() holds nobody');
  const started = h.mirror.start();
  assert.equal(h.mirror.start(), started, 'start is idempotent');
  await h.mirror.ready;
  const late = recorder('late');
  h.mirror.register('late', late.source);
  await waitUntil(() => late.log.includes('late.start'), { timeout: 2000, what: 'the late source to start' });
});
