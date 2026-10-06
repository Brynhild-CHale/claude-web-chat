// The tasks source (lib/server/mirror/tasks.js, spec §2.5 "Shells and
// monitors", §2.6, §2.10, §2.12, §5.5, §5.6, §6.9), registered on a REAL
// createMirror beside the real transcripts source (U28a) with an in-memory fake
// of its store, the way U51 will register it.
//
// Pinned:
//   * a transcript's background Bash makes one running 'shell' row keyed by the
//     task id; output growth sets the line and meta.port; the footer ends it
//     (failed, exit 3) and taskOutput's tail ends on it;
//   * a PostToolUse before the transcript makes the row and the transcript
//     fills the same one; a call inside an agent carries its owner;
//   * a fake key is masked in the line and the output; a command reading
//     ~/.ssh/id_rsa gives a WITHHELD output; no answer, row or frame of this
//     source carries the output path, '.output' or the tmp directory;
//   * a path the fence refuses gives can.output false and is never opened;
//   * paging with `to` passed back loses and doubles no line;
//   * a monitor counts each event once (a second read of the same batches
//     counts nothing), its expiry ends it 'expired', and an hour of silence
//     leaves it running;
//   * TaskStop → killed by 'claude'; a bare [killed] → killed, nobody named;
//     a grep, a Read or a TaskStop for another id quoting the stopped
//     sentence ends nothing;
//   * the registry's 'ended' stops the conversation's rows (session-end); a
//     SessionEnd for /clear stops nothing;
//   * Stop's background_tasks makes a row for an unknown id and reads the
//     footer of a running row the list leaves out;
//   * markStopRequested marks a running shell and a running agent row, and
//     answers null for a finished or unknown id;
//   * no output 5 s after the start sets meta.no_output_yet and growth clears
//     it; a finished row goes 30 minutes after it ended (injected clock and
//     timers);
//   * a restart restores the running row and its watch resumes;
//   * stop() leaves no watch and no timer of this source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { withTempHome, waitUntil } = require('../test-support/helpers');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { createRecords, taskNotificationText } = require('../test-support/claude-records');
const { createRedactor, WITHHELD } = require('../lib/core/redact');
const { createBus } = require('../lib/core/bus');
const { createHookTap } = require('../lib/server/hook-tap');
const { createMirror, SOURCES } = require('../lib/server/mirror');
const { createTailer } = require('../lib/server/mirror/tail');
const { createTranscriptsSource } = require('../lib/server/mirror/transcripts');
const tasks = require('../lib/server/mirror/tasks');

const { createTasksSource } = tasks;
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const PID = 4242;
const AGENT = 'a0123456789abcdef';

// ── the harness ──────────────────────────────────────────────────────────────

function project(t) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-tasks-'));
  fs.mkdirSync(path.join(dir, '.web-chat'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The transcripts source's store contract, in memory; `saved` outlives mirrors.
function fakeStore() {
  const saved = new Map();
  const pending = new Map();
  async function flush(sid) {
    for (const [k, fn] of [...pending]) {
      if (sid && k !== sid) continue;
      pending.delete(k);
      const snap = fn();
      if (snap) saved.set(k, JSON.parse(JSON.stringify(snap)));
    }
  }
  const create = () => ({
    async load(sid) {
      const ix = saved.get(sid);
      return ix ? { ok: true, index: JSON.parse(JSON.stringify(ix)) } : { ok: false, reason: 'absent' };
    },
    schedule(sid, fn) { pending.set(sid, fn); },
    flush,
    drop(sid) { pending.delete(sid); },
    async readRange(file, { from, to }) {
      const s = fs.readFileSync(file).subarray(from, to).toString('utf8');
      const cut = s.lastIndexOf('\n');
      return cut < 0 ? '' : s.slice(0, cut + 1);
    },
    async stop() { await flush(); },
  });
  return { create, saved };
}

// A clock and timers for the tasks source alone: a timeout of a second or more
// waits until advance() passes it; a shorter one runs on Node's timers.
function fakeClock(start = Date.now()) {
  let t = start;
  let seq = 0;
  const held = new Map();
  const real = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const h = { id: ++seq };
      if (ms >= 1000) held.set(h, { at: t + ms, fn });
      else real.set(h, setTimeout(() => { real.delete(h); fn(); }, ms));
      return h;
    },
    clearTimeout(h) {
      held.delete(h);
      if (real.has(h)) { clearTimeout(real.get(h)); real.delete(h); }
    },
    setInterval() { throw new Error('the tasks source sets no interval'); },
    clearInterval() {},
    clear(h) { timers.clearTimeout(h); },
  };
  return {
    now: () => t,
    timers,
    held: () => held.size + real.size,
    advance(ms) {
      t += ms;
      for (;;) {
        const due = [...held].filter(([, v]) => v.at <= t).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        held.delete(due[0]);
        due[1].fn();
      }
    },
  };
}

// A real facade with `live`, `transcripts` and the tasks source. `wrap` lets a
// test replace engine members the tasks source sees (a clock, timers, a spy).
function setup(t, { store = fakeStore(), root = null, ch = null, pollMs = 40, wrap = null } = {}) {
  let mirror = null;
  t.after(async () => { if (mirror) await mirror.stop(); });
  if (!root) {
    withTempHome(t);
    root = project(t);
    ch = claudeHome(t, { root, isolate: true });
  }
  const transcripts = createTranscriptsSource({ createStore: store.create, createTailer, pollMs: 30 });
  const source = createTasksSource({ pollMs });
  const probe = { engine: null };
  const spy = { windows: [], watches: [], watchStops: 0 };
  const attachTasks = (engine) => {
    const files = Object.freeze({
      ...engine.files,
      readWindow: (file, opts) => { spy.windows.push(String(file)); return engine.files.readWindow(file, opts); },
    });
    const watchFile = (file, onTrigger, opts) => {
      spy.watches.push(String(file));
      const w = engine.watchFile(file, onTrigger, wrap && wrap.watchOpts ? { ...opts, ...wrap.watchOpts } : opts);
      return { ...w, trigger: w.trigger, stop: () => { spy.watchStops += 1; return w.stop(); } };
    };
    let e = { ...engine, files, watchFile };
    if (wrap && wrap.clock) e = { ...e, now: wrap.clock.now, timers: wrap.clock.timers };
    return source.attach(Object.freeze(e));
  };
  const replay = { batches: [] };
  const hooks = createHookTap();
  const mirrorBus = createBus({ maxEvents: 2000 });
  const frames = [];
  mirrorBus.setBroadcaster((frame) => frames.push(frame));
  mirror = createMirror({
    root, hooks, mainBus: createBus(), mirrorBus, redactor: createRedactor(), log: () => {},
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    isPidAlive: () => true,
    sources: [...SOURCES.filter((s) => s.name === 'live'),
      { name: 'transcripts', attach: transcripts.attach },
      { name: 'tasks', attach: attachTasks },
      { name: 'probe', attach: (engine) => {
        probe.engine = engine;
        return { start: async () => {}, stop: async () => {}, onChanges: (sid, changes, { conversation_id }) => replay.batches.push([sid, changes, conversation_id]) };
      } }],
  });
  let ts = Date.now();
  const h = { root, ch, store, hooks, mirror, frames, probe, spy, replay, answers: [] };
  h.env = (event, extra = {}, sid = S1) => ({
    v: 1, event, ts: ++ts, session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd,
    prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
    result: null, session: null, compact: null, stop: null, prompt: null, ask: null, ...extra,
  });
  h.publish = (event, extra, sid) => hooks.publish(h.env(event, extra, sid));
  h.sessionStart = (source = 'startup') => h.publish('SessionStart', { session: { source }, claude_pid: PID });
  h.records = (seed = 1) => createRecords({ seed, sessionId: S1, cwd: ch.cwd, start: Date.now(), step: 10 });
  h.rows = () => mirror.tasks().tasks;
  h.row = (id) => h.rows().find((x) => x.id === id) || null;
  h.waitRow = (id, pred, what) => waitUntil(() => { const r = h.row(id); return r && pred(r) ? r : null; }, { timeout: 8000, what: what || `row ${id}` });
  h.output = async (id, q) => { const v = await mirror.taskOutput(id, q); h.answers.push(v); return v; };
  h.replayAll = () => {
    for (const [sid, changes, cid] of replay.batches.splice(0)) probe.engine.applyChanges(sid, changes, { conversation_id: cid });
  };
  return h;
}

const bgSentence = (id, file) => `Command running in background with ID: ${id}. Output is being written to: ${file}.`;

// A turn whose Bash call starts a background shell: prompt, tool_use, result.
function bgTurn(r, { id, file, command = 'npm run dev', description = 'Start the dev server', useId = `toolu_01${id}`, promptId = `p-${id}` }) {
  r.prompt(`run ${id}`, { promptId });
  r.assistant([{ type: 'tool_use', name: 'Bash', input: { command, description, run_in_background: true }, id: useId }]);
  r.toolResult(useId, bgSentence(id, file), { taskId: id });
  return useId;
}

// What leaves the source must never name the file.
function assertNoPath(h, file, what) {
  const tasksOut = JSON.stringify([h.mirror.tasks(), h.answers, h.frames]);
  for (const needle of [file, '.output', h.ch.tmpDir, path.dirname(file)]) {
    assert.ok(!tasksOut.includes(needle), `${what}: no row, answer or frame names ${needle}`);
  }
}

// ── the constants ────────────────────────────────────────────────────────────

test('the constants and the parsers are exported', () => {
  assert.equal(tasks.POLL_MS, 2000);
  assert.equal(tasks.NO_OUTPUT_MS, 5000);
  assert.equal(tasks.FINISHED_KEEP_MS, 30 * 60 * 1000);
  assert.equal(tasks.OUTPUT_MAX, 262144);
  assert.equal(tasks.LINE_WINDOW, 4096);
  assert.equal(tasks.FOOTER_BYTES, 64);
  assert.equal(tasks.TASKS_WATCH_MAX, 64);
  assert.equal(tasks.STATE_VERSION, 1);
  const bg = tasks.BG_START_RE.exec(bgSentence('b1x2y3', '/tmp/claude-501/-p/s/tasks/b1x2y3.output'));
  assert.deepEqual([bg[1], bg[2]], ['b1x2y3', '/tmp/claude-501/-p/s/tasks/b1x2y3.output']);
  assert.equal(tasks.MONITOR_START_RE.exec('Monitor started (task bm77, expires in 1m unless the source ends first)')[1], 'bm77');
  assert.equal(tasks.STOPPED_RE.exec('Successfully stopped task: b1x2y3 (npm run dev)')[1], 'b1x2y3');
  assert.equal(tasks.FOOTER_RE.exec('x\n[exited with code 3]\n')[1], '3');
  assert.ok(tasks.FOOTER_RE.test('x\n[killed]\n'));
  assert.equal(tasks.PORT_RE.exec('listening on http://localhost:5173/')[2], '5173');
  assert.equal(typeof createTasksSource().attach, 'function');
  const src = fs.readFileSync(require.resolve('../lib/server/mirror/tasks.js'), 'utf8');
  for (const banned of ['process.kill(', 'readdir', 'fs.watch(', 'readFileSync(', 'createReadStream(']) {
    assert.ok(!src.includes(banned), `tasks.js never reaches ${banned}`);
  }
});

// ── a shell from the transcript ──────────────────────────────────────────────

test('a background Bash in the transcript: one running shell row; its line, port, footer and output', async (t) => {
  const h = setup(t);
  await h.mirror.start();
  h.sessionStart();
  const id = 'b1x2y3';
  const file = h.ch.writeTaskOutput(S1, id, '');
  // A first turn, then the shell's turn appended to the file being followed.
  const r = h.records();
  r.prompt('hello', { promptId: 'p-hello' });
  r.assistant(['Hello.']);
  r.turnDuration({ durationMs: 10 });
  h.ch.writeTranscript(S1, r.records);
  await waitUntil(async () => { const p = await h.mirror.turns(S1, { limit: 10 }); return p && p.total === 1; }, { timeout: 8000, what: 'the first turn' });
  const n0 = r.records.length;
  const useId = bgTurn(r, { id, file });
  h.ch.appendTranscript(S1, r.records.slice(n0));
  const row = await h.waitRow(id, (x) => x.status === 'running' && x.turn_id, 'the running shell row');
  assert.equal(row.kind, 'shell');
  assert.equal(row.title, 'Start the dev server');
  assert.equal(row.tool_use_id, useId);
  assert.equal(row.conversation_id, S1);
  assert.deepEqual(row.can, { output: true, open: false, stop: true });
  assert.equal(h.rows().length, 1, 'one row');
  assert.deepEqual(h.mirror.tasks().counts.shells, { running: 1, total: 1 });
  assert.equal(row.turn_id, h.probe.engine.model.item(useId).turn_id, 'the row sits in its call\'s turn');

  h.ch.appendTaskOutput(S1, id, '> vite\n  listening on http://localhost:5173/\n');
  const live = await h.waitRow(id, (x) => x.meta && x.meta.port === 5173, 'the port hint');
  assert.equal(live.line, 'listening on http://localhost:5173/');
  const evidence = h.mirror.liveOf(S1).evidence;
  assert.ok(Number.isFinite(evidence.task_output_at), 'the growth is progress evidence');

  h.ch.appendTaskOutput(S1, id, 'oops\n\n[exited with code 3]\n');
  const done = await h.waitRow(id, (x) => x.status !== 'running', 'the footer');
  assert.equal(done.status, 'failed');
  assert.equal(done.exit_code, 3);
  assert.equal(done.line, 'oops', 'the line is the last line that is not the footer');
  assert.equal(done.can.stop, false);
  assert.ok(Number.isFinite(done.ended_at));
  assert.equal(done.stopped_by, undefined);
  assert.deepEqual(h.mirror.tasks().counts.shells, { running: 0, total: 1 });

  const out = await h.output(id, { tail: 16384 });
  assert.ok(out.text.trimEnd().endsWith('[exited with code 3]'), 'the tail ends on the footer');
  assert.equal(out.footer, '[exited with code 3]');
  assert.equal(out.ended, true);
  assert.equal(out.eof, true);
  assert.equal(out.exit_code, 3);
  assert.equal(out.task_id, id);
  assert.equal(out.size, fs.statSync(file).size);
  assert.equal(await h.output('b-unknown', {}), null, 'an unknown id answers null');
  await h.mirror.stop();
  const carried = h.frames.filter((f) => f.type === 'mirror:update' && (f.tasks || []).some((x) => x.id === id));
  assert.ok(carried.length > 0, 'a mirror:update frame carried the row');
  assertNoPath(h, file, 'the shell');
});

// ── the hook before the transcript ───────────────────────────────────────────

test('a PostToolUse before the transcript makes the row, the transcript fills the same one', async (t) => {
  const h = setup(t);
  await h.mirror.start();
  h.sessionStart();
  const id = 'b7hook';
  const file = h.ch.writeTaskOutput(S1, id, 'starting\n');
  const useId = 'toolu_01Hook';
  const input = { command: 'npm test -- --watch', description: 'Watch the tests', run_in_background: true };
  h.publish('PostToolUse', {
    tool: { name: 'Bash', use_id: useId, input },
    result: { ok: true, duration_ms: 12, fields: { backgroundTaskId: id, outputFile: file } },
    agent: { id: AGENT, type: 'general-purpose' },
  });
  const first = h.row(id);
  assert.ok(first, 'the hook made the row at once');
  assert.equal(first.status, 'running');
  assert.equal(first.title, 'Watch the tests');
  assert.deepEqual(first.owner, { agent_id: AGENT, title: 'general-purpose' }, 'a call inside an agent carries its owner');
  assert.equal(first.can.output, true, 'outputFile from result.fields');
  await h.waitRow(id, (x) => x.line === 'starting', 'the first line');

  const r = h.records();
  r.prompt('watch the tests', { promptId: 'p-hook' });
  r.assistant([{ type: 'tool_use', name: 'Bash', input, id: useId }]);
  r.toolResult(useId, bgSentence(id, file), { taskId: id });
  h.ch.writeTranscript(S1, r.records);
  await waitUntil(() => h.probe.engine.model.item(useId) && h.probe.engine.model.item(useId).result, { timeout: 8000, what: 'the transcript\'s result' });
  const row = await h.waitRow(id, (x) => x.turn_id === h.probe.engine.model.item(useId).turn_id, 'the row in its call\'s turn');
  assert.equal(h.rows().length, 1, 'exactly one row');
  assert.equal(row.tool_use_id, useId);
  assert.deepEqual(row.owner, { agent_id: AGENT, title: 'general-purpose' });
  assert.deepEqual(h.mirror.tasks().counts.shells, { running: 1, total: 1 });

  // An agent the model already holds names the owner by its row's title.
  const agent2 = 'a00000000000000b2';
  h.probe.engine.model.upsertTask({
    id: agent2, conversation_id: S1, kind: 'agent', title: 'Explore the repo', status: 'running', started_at: Date.now(),
    line: '', meta: {}, turn_id: null, tool_use_id: null, can: { output: false, open: true, stop: true },
  });
  h.publish('PostToolUse', {
    tool: { name: 'Bash', use_id: 'toolu_01Hook2', input: { command: 'sleep 99', description: 'Wait', run_in_background: true } },
    result: { ok: true, fields: { backgroundTaskId: 'b7hook2' } },
    agent: { id: agent2, type: 'Explore' },
  });
  assert.deepEqual(h.row('b7hook2').owner, { agent_id: agent2, title: 'Explore the repo' }, 'the agent row\'s title, before its type');
  assert.equal(h.row('b7hook2').can.output, false, 'no outputFile, no output');
  await h.mirror.stop();
  assertNoPath(h, file, 'the hook row');
});

test('a hook naming a file Claude Code has not made yet: the fence is asked again, and the file then followed', async (t) => {
  const clock = fakeClock();
  const h = setup(t, { wrap: { clock } });
  await h.mirror.start();
  h.sessionStart();
  const id = 'blate1';
  const file = path.join(h.ch.taskDir(S1), `${id}.output`); // not written yet
  h.publish('PostToolUse', {
    tool: { name: 'Bash', use_id: 'toolu_01Late', input: { command: 'npm run dev', description: 'Dev', run_in_background: true } },
    result: { ok: true, fields: { backgroundTaskId: id, outputFile: file } },
    ts: clock.now(),
  });
  assert.equal(h.row(id).can.output, false, 'refused while the file is missing');
  fs.writeFileSync(file, 'ready on 127.0.0.1:8080\n');
  clock.advance(tasks.NO_OUTPUT_MS);
  const row = await h.waitRow(id, (x) => x.can.output && x.meta.port === 8080, 'the file followed');
  assert.equal(row.line, 'ready on 127.0.0.1:8080');
  await h.mirror.stop();
  assertNoPath(h, file, 'the late file');
});

// ── redaction ────────────────────────────────────────────────────────────────

test('a fake key is masked in the line and the output; an ssh key read is withheld', async (t) => {
  const h = setup(t);
  await h.mirror.start();
  h.sessionStart();
  const fake = fakeSecrets().find((f) => f.id === 'sk-anthropic-api');
  const a = 'bkey01';
  const fileA = h.ch.writeTaskOutput(S1, a, '');
  const b = 'bssh02';
  const fileB = h.ch.writeTaskOutput(S1, b, '');
  const r = h.records();
  bgTurn(r, { id: a, file: fileA, command: 'node server.js', description: 'Serve' });
  r.turnDuration({ durationMs: 10 });
  bgTurn(r, { id: b, file: fileB, command: 'sleep 1; cat ~/.ssh/id_rsa', description: 'Read the key' });
  h.ch.writeTranscript(S1, r.records);
  await h.waitRow(a, (x) => x.status === 'running');
  await h.waitRow(b, (x) => x.status === 'running');
  // Both turns read in one batch: each row sits in its own call's turn, not
  // the conversation's open one (the second).
  const turnA = h.probe.engine.model.item(`toolu_01${a}`).turn_id;
  const turnB = h.probe.engine.model.item(`toolu_01${b}`).turn_id;
  assert.notEqual(turnA, turnB);
  assert.equal(h.row(a).turn_id, turnA, 'the first row is in the first call\'s turn');
  assert.equal(h.row(b).turn_id, turnB);
  h.ch.appendTaskOutput(S1, a, `boot\n${fake.text}\n`);
  h.ch.appendTaskOutput(S1, b, 'ssh-ed25519-private-material-AAAAC3Nza\nsecond line of it\n');
  const rowA = await h.waitRow(a, (x) => x.line && x.line !== 'boot' && x.line.length > 0, 'the key line');
  assert.deepEqual(findLeaks(rowA, [fake]), [], 'the line masks the key');
  assert.ok(rowA.line.startsWith('calling the API with'), 'the rest of the line stays');
  const outA = await h.output(a, {});
  assert.deepEqual(findLeaks(outA, [fake]), [], 'the output masks the key');
  assert.ok(outA.text.includes('boot'));
  const rowB = await h.waitRow(b, (x) => x.line, 'the withheld line');
  assert.equal(rowB.line, WITHHELD('ssh'));
  const outB = await h.output(b, {});
  assert.equal(outB.text, WITHHELD('ssh'), 'the output is withheld whole');
  assert.ok(!JSON.stringify([rowB, outB]).includes('AAAAC3Nza'));
  await h.mirror.stop();
  assertNoPath(h, fileA, 'the key shell');
  assertNoPath(h, fileB, 'the ssh shell');
});

// ── the fence ────────────────────────────────────────────────────────────────

test('a path the fence refuses gives can.output false and is never opened', async (t) => {
  const h = setup(t);
  await h.mirror.start();
  h.sessionStart();
  const real = h.ch.writeTaskOutput(S1, 'breal0', 'secret output\n');
  const link = path.join(h.ch.taskDir(S1), 'blink1.output');
  fs.symlinkSync(real, link);
  const outside = path.join(h.root, 'tasks', 'bout02.output');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, 'outside\n');
  const otherUid = real.replace(`claude-${h.ch.uid}`, `claude-${h.ch.uid + 1}`).replace('breal0', 'buid03');
  const r = h.records();
  bgTurn(r, { id: 'blink1', file: link });
  r.turnDuration({ durationMs: 10 });
  bgTurn(r, { id: 'bout02', file: outside });
  r.turnDuration({ durationMs: 10 });
  bgTurn(r, { id: 'buid03', file: otherUid });
  h.ch.writeTranscript(S1, r.records);
  for (const id of ['blink1', 'bout02', 'buid03']) {
    const row = await h.waitRow(id, (x) => x.status === 'running', id);
    assert.equal(row.can.output, false, `${id}: no output`);
    assert.equal(await h.output(id, {}), null, `${id}: output answers null`);
  }
  assert.deepEqual(h.spy.windows, [], 'no window was read');
  assert.deepEqual(h.spy.watches, [], 'no watch was set');
  assert.equal(h.mirror.snapshot({}).diagnostics.tasks.refused, 3);
  await h.mirror.stop();
});

// ── paging ───────────────────────────────────────────────────────────────────

test('paging: `to` passed back as `from` loses and doubles no line', async (t) => {
  const h = setup(t);
  await h.mirror.start();
  h.sessionStart();
  const id = 'bpage1';
  const lines = Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(4, '0')} ${'x'.repeat(i % 37)}`);
  const file = h.ch.writeTaskOutput(S1, id, `${lines.join('\n')}\n[exited with code 0]\n`);
  const r = h.records();
  bgTurn(r, { id, file, command: 'seq 400' });
  h.ch.writeTranscript(S1, r.records);
  await h.waitRow(id, (x) => x.status === 'done', 'the finished row');
  const got = [];
  let from = 0;
  for (let i = 0; i < 100; i++) {
    const page = await h.output(id, { from, max: 997 });
    assert.ok(page.to > from || page.eof, 'every page moves on');
    got.push(page.text);
    if (page.eof) { assert.equal(page.footer, '[exited with code 0]'); break; }
    assert.ok(page.text.endsWith('\n'), 'a middle page ends on a whole line');
    from = page.to;
  }
  const text = got.join('');
  assert.deepEqual(text.split('\n').filter((l) => l.startsWith('line ')), lines, 'every line once, in order');
  assert.ok(text.trimEnd().endsWith('[exited with code 0]'));
  await h.mirror.stop();
});

// ── monitors ─────────────────────────────────────────────────────────────────

function monitorEvent(r, id, event) {
  const text = taskNotificationText({ taskId: id, status: null, summary: 'Monitor event', event });
  r.queuedCommand(text, { commandMode: 'task-notification' });
}

test('a monitor: events counted once, an hour of silence stays running, the expiry ends it', async (t) => {
  const clock = fakeClock();
  const h = setup(t, { wrap: { clock } });
  await h.mirror.start();
  h.sessionStart();
  const id = 'bmon01';
  const r = h.records();
  r.prompt('watch the log', { promptId: 'p-mon' });
  r.assistant([{ type: 'tool_use', name: 'Monitor', input: { command: 'tail -f app.log | grep ERROR', description: 'Errors in app.log' }, id: 'toolu_01Mon' }]);
  r.toolResult('toolu_01Mon', `Monitor started (task ${id}, expires in 1m unless the source ends first; events arrive as notifications)`, { toolUseResult: { taskId: id, timeoutMs: 60000, persistent: false } });
  monitorEvent(r, id, 'ERROR one');
  monitorEvent(r, id, 'ERROR two');
  monitorEvent(r, id, 'ERROR three');
  h.ch.writeTranscript(S1, r.records);
  const row = await h.waitRow(id, (x) => x.meta && x.meta.events === 3, 'three events');
  assert.equal(row.kind, 'monitor');
  assert.equal(row.status, 'running');
  assert.equal(row.line, 'ERROR three');
  assert.ok(Number.isFinite(row.meta.last_event_at));
  assert.deepEqual(row.can, { output: false, open: true, stop: true });
  assert.deepEqual(h.mirror.tasks().counts.monitors, { running: 1, total: 1 });

  // The same batches again, as a catch-up re-read hands them: nothing more.
  assert.ok(h.replay.batches.length > 0);
  h.replayAll();
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(h.row(id).meta.events, 3, 'a second read counts nothing');

  clock.advance(60 * 60 * 1000);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(h.row(id).status, 'running', 'an hour of silence: still running');
  assert.deepEqual(h.mirror.tasks().counts.monitors, { running: 1, total: 1 });

  const n0 = r.records.length;
  r.at(clock.now()); // the notice is written an hour on, by the source's clock too
  monitorEvent(r, id, '[Monitor expired after 60s with 3 events delivered. Re-arm it if you still need the watch.]');
  h.ch.appendTranscript(S1, r.records.slice(n0));
  const ended = await h.waitRow(id, (x) => x.status !== 'running', 'the expiry');
  assert.equal(ended.status, 'expired');
  assert.equal(ended.meta.events, 3, 'the expiry is not an event');
  assert.ok(ended.line.startsWith('[Monitor expired'));
  assert.ok(h.row(id), 'a finished row stays a while');
  await h.mirror.stop();
});

// ── a start a catch-up replays ───────────────────────────────────────────────

test('a replayed start is checked once: an old ended file goes at once, a recent one ends at its mtime', async (t) => {
  const h = setup(t);
  await h.mirror.start();
  h.sessionStart();
  const old = h.ch.writeTaskOutput(S1, 'bold01', 'built\n[exited with code 0]\n');
  const twoHours = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(old, twoHours, twoHours);
  const recent = h.ch.writeTaskOutput(S1, 'bnew02', 'tested\n[exited with code 1]\n');
  const oneMinute = Math.floor((Date.now() - 60 * 1000) / 1000);
  fs.utimesSync(recent, oneMinute, oneMinute);
  const r = h.records();
  bgTurn(r, { id: 'bold01', file: old, command: 'npm run build' });
  r.turnDuration({ durationMs: 10 });
  bgTurn(r, { id: 'bnew02', file: recent, command: 'npm test' });
  r.turnDuration({ durationMs: 10 });
  h.ch.writeTranscript(S1, r.records);
  const done = await h.waitRow('bnew02', (x) => x.status !== 'running', 'the recent file\'s footer');
  assert.equal(done.status, 'failed');
  assert.equal(done.exit_code, 1);
  assert.equal(done.ended_at, oneMinute * 1000, 'ended at the file\'s mtime');
  await waitUntil(() => h.spy.windows.filter((f) => f === old).length > 0, { what: 'the old file\'s one read' });
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(h.row('bold01'), null, 'a file that ended over 30 minutes ago leaves no row');
  assert.ok(!h.spy.watches.includes(old) && !h.spy.watches.includes(recent), 'no watch for a file that already ended');
  await h.mirror.stop();
});

test('an idle notification\'s <output-file> gives a monitor its output', async (t) => {
  const h = setup(t);
  await h.mirror.start();
  h.sessionStart();
  const id = 'bmon09';
  const r = h.records();
  r.prompt('watch it', { promptId: 'p-m9' });
  r.assistant([{ type: 'tool_use', name: 'Monitor', input: { command: 'tail -f x.log', description: 'Watch x' }, id: 'toolu_01M9' }]);
  r.toolResult('toolu_01M9', `Monitor started (task ${id}, expires in 1m unless the source ends first)`);
  r.assistant(['Watching.']);
  r.turnDuration({ durationMs: 10 });
  h.ch.writeTranscript(S1, r.records);
  const row = await h.waitRow(id, (x) => x.status === 'running', 'the monitor');
  assert.equal(row.can.output, false, 'a monitor start names no file');
  const file = h.ch.writeTaskOutput(S1, id, 'line a\nline b\n[exited with code 0]\n');
  const n0 = r.records.length;
  r.taskNotification({ taskId: id, toolUseId: 'toolu_01M9', outputFile: file, status: 'completed', summary: 'Monitor "Watch x" stream ended', event: 'line b' });
  h.ch.appendTranscript(S1, r.records.slice(n0));
  const done = await h.waitRow(id, (x) => x.status === 'done', 'the end');
  assert.equal(done.can.output, true, 'the notification named the file');
  const out = await h.output(id, {});
  assert.ok(out.text.includes('line a'));
  await h.mirror.stop();
  assertNoPath(h, file, 'the monitor');
});

// ── TaskStop and the bare footer ─────────────────────────────────────────────

test('a TaskStop result ends a row killed by claude; a bare [killed] names nobody', async (t) => {
  const h = setup(t);
  await h.mirror.start();
  h.sessionStart();
  const a = 'bstop1';
  const b = 'bkill2';
  const fileA = h.ch.writeTaskOutput(S1, a, 'serving\n');
  const fileB = h.ch.writeTaskOutput(S1, b, 'looping\n');
  const r = h.records();
  bgTurn(r, { id: a, file: fileA });
  r.turnDuration({ durationMs: 10 });
  bgTurn(r, { id: b, file: fileB, command: 'while true; do sleep 1; done', description: 'Loop' });
  h.ch.writeTranscript(S1, r.records);
  await h.waitRow(a, (x) => x.line === 'serving');
  await h.waitRow(b, (x) => x.line === 'looping');
  const n0 = r.records.length;
  r.assistant([{ type: 'tool_use', name: 'TaskStop', input: { task_id: a }, id: 'toolu_01Stop' }]);
  r.toolResult('toolu_01Stop', `Successfully stopped task: ${a} (npm run dev)`, { toolUseResult: { message: `Successfully stopped task: ${a} (npm run dev)`, task_id: a, task_type: 'local_bash' } });
  h.ch.appendTranscript(S1, r.records.slice(n0));
  const stopped = await h.waitRow(a, (x) => x.status !== 'running', 'the TaskStop');
  assert.equal(stopped.status, 'killed');
  assert.equal(stopped.stopped_by, 'claude');
  h.ch.appendTaskOutput(S1, b, '\n[killed]\n');
  const killed = await h.waitRow(b, (x) => x.status !== 'running', 'the bare footer');
  assert.equal(killed.status, 'killed');
  assert.equal(killed.stopped_by, undefined, 'a bare [killed] names nobody');
  assert.equal(killed.exit_code, undefined);
  // The footer TaskStop writes afterwards changes nothing: the first end wins.
  h.ch.appendTaskOutput(S1, a, '\n[killed]\n');
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(h.row(a).stopped_by, 'claude');
  await h.mirror.stop();
});

test('a foreground Bash quoting the stopped sentence leaves the row running; a TaskStop result ends it', async (t) => {
  const h = setup(t);
  await h.mirror.start();
  h.sessionStart();
  const a = 'bquot1';
  const fileA = h.ch.writeTaskOutput(S1, a, 'serving\n');
  const r = h.records();
  bgTurn(r, { id: a, file: fileA });
  r.turnDuration({ durationMs: 10 });
  h.ch.writeTranscript(S1, r.records);
  await h.waitRow(a, (x) => x.line === 'serving');
  let n0 = r.records.length;
  // A grep (and a cat) whose output quotes the TaskStop sentence for the live
  // row; then a TaskStop whose input names ANOTHER task while its result quotes
  // this one. None of them is this row's stop (spec §2.5).
  r.prompt('search the transcripts', { promptId: 'p-qgrep' });
  r.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'grep -r "Successfully stopped" ~/.claude/projects', description: 'Search transcripts' }, id: 'toolu_01QGrep' }]);
  r.toolResult('toolu_01QGrep', `x.jsonl: Successfully stopped task: ${a} (npm run dev)`);
  r.assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/notes.txt' }, id: 'toolu_01QRead' }]);
  r.toolResult('toolu_01QRead', `Successfully stopped task: ${a}`);
  r.assistant([{ type: 'tool_use', name: 'TaskStop', input: { task_id: 'bother9' }, id: 'toolu_01QOther' }]);
  r.toolResult('toolu_01QOther', `Successfully stopped task: ${a} (npm run dev)`);
  r.turnDuration({ durationMs: 10 });
  // A later real start in the same append: once it is a row, the quotes were read.
  const sentinel = 'bsent4';
  const fileSentinel = h.ch.writeTaskOutput(S1, sentinel, 'ready\n');
  bgTurn(r, { id: sentinel, file: fileSentinel, description: 'Sentinel' });
  h.ch.appendTranscript(S1, r.records.slice(n0));
  await h.waitRow(sentinel, (x) => x.line === 'ready', 'the start after the quotes');
  assert.equal(h.row(a).status, 'running', 'a quoted stop sentence ends nothing');
  assert.equal(h.row(a).stopped_by, undefined);
  // The real TaskStop still ends it, killed by claude.
  n0 = r.records.length;
  r.assistant([{ type: 'tool_use', name: 'TaskStop', input: { task_id: a }, id: 'toolu_01QStop' }]);
  r.toolResult('toolu_01QStop', `Successfully stopped task: ${a} (npm run dev)`, { toolUseResult: { message: `Successfully stopped task: ${a} (npm run dev)`, task_id: a, task_type: 'local_bash' } });
  h.ch.appendTranscript(S1, r.records.slice(n0));
  const stopped = await h.waitRow(a, (x) => x.status !== 'running', 'the TaskStop');
  assert.equal(stopped.status, 'killed');
  assert.equal(stopped.stopped_by, 'claude');
  assert.equal(h.row(sentinel).status, 'running');
  await h.mirror.stop();
});

test('a foreground Bash quoting the start sentence starts nothing and retitles nothing', async (t) => {
  const h = setup(t);
  await h.mirror.start();
  h.sessionStart();
  const real = 'breal7';
  const fileReal = h.ch.writeTaskOutput(S1, real, 'serving\n');
  const r = h.records();
  bgTurn(r, { id: real, file: fileReal, description: 'Real server' });
  h.ch.writeTranscript(S1, r.records);
  await h.waitRow(real, (x) => x.line === 'serving');
  const n0 = r.records.length;
  // A grep over transcripts: no run_in_background, no backgroundTaskId, and its
  // output quotes the sentence for an unknown id and for the real row's id.
  r.prompt('search the transcripts', { promptId: 'p-grep' });
  r.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'grep -r "running in background" ~/.claude/projects', description: 'Search transcripts' }, id: 'toolu_01Grep' }]);
  r.toolResult('toolu_01Grep', [
    `a.jsonl: ${bgSentence('bghost', path.join(h.ch.tmpDir, 'bghost.output'))}`,
    `b.jsonl: ${bgSentence(real, fileReal)}`,
  ].join('\n'));
  r.turnDuration({ durationMs: 10 });
  // A later real start in the same append: once it is a row, the grep was read.
  const sentinel = 'bsent3';
  const fileSentinel = h.ch.writeTaskOutput(S1, sentinel, 'ready\n');
  bgTurn(r, { id: sentinel, file: fileSentinel, description: 'Sentinel' });
  h.ch.appendTranscript(S1, r.records.slice(n0));
  await h.waitRow(sentinel, (x) => x.line === 'ready', 'the start after the grep');
  assert.equal(h.row('bghost'), null, 'a quoted sentence for an unknown id makes no row');
  assert.deepEqual(h.rows().map((x) => x.id).sort(), [real, sentinel].sort());
  assert.equal(h.row(real).title, 'Real server', 'the grep\'s description never retitles the real row');
  assert.equal(h.row(real).tool_use_id, `toolu_01${real}`);
  assert.equal(h.mirror.tasks().counts.shells.total, 2);
  await h.mirror.stop();
});

// ── the conversation's end ───────────────────────────────────────────────────

test('the registry\'s ended stops every running row; a SessionEnd for /clear stops nothing', async (t) => {
  const h = setup(t);
  await h.mirror.start();
  h.sessionStart();
  const id = 'bend01';
  const file = h.ch.writeTaskOutput(S1, id, 'up\n');
  const r = h.records();
  bgTurn(r, { id, file });
  h.ch.writeTranscript(S1, r.records);
  await h.waitRow(id, (x) => x.line === 'up');
  h.publish('PostToolUse', {
    tool: { name: 'Monitor', use_id: 'toolu_01M2', input: { command: 'tail -f x', description: 'Tail x' } },
    result: { ok: true, fields: { taskId: 'bmon02' } },
  });
  assert.equal(h.row('bmon02').kind, 'monitor');
  // Another conversation's monitor: S1's end is not its end.
  h.publish('SessionStart', { session: { source: 'startup' }, claude_pid: PID + 1 }, S2);
  h.publish('PostToolUse', {
    tool: { name: 'Monitor', use_id: 'toolu_01M3', input: { command: 'tail -f y', description: 'Tail y' } },
    result: { ok: true, fields: { taskId: 'bmon03' } },
  }, S2);
  assert.ok(h.row('bmon03'), 'the other conversation\'s monitor');
  assert.notEqual(h.row('bmon03').conversation_id, h.row('bmon02').conversation_id);
  h.publish('SessionEnd', { session: { reason: 'clear' } });
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(h.row(id).status, 'running', 'background tasks outlive /clear');
  assert.equal(h.row('bmon02').status, 'running');
  assert.ok(h.probe.engine.processGone, 'the probe holds the engine');
  h.probe.engine.processGone(S1, { at: Date.now() });
  const a = await h.waitRow(id, (x) => x.status !== 'running', 'the session end');
  assert.equal(a.status, 'stopped');
  assert.equal(a.stopped_by, 'session-end');
  const b = h.row('bmon02');
  assert.equal(b.status, 'stopped');
  assert.equal(b.stopped_by, 'session-end');
  assert.equal(h.row('bmon03').status, 'running', 'only the ended conversation\'s rows stop');
  await h.mirror.stop();
});

// ── Stop's background_tasks ──────────────────────────────────────────────────

test('Stop\'s background_tasks: an unknown id makes a row, a running row left out gets its footer read', async (t) => {
  // Only the Stop may look at the file: no file watch, and a poll that never comes.
  const h = setup(t, { wrap: { watchOpts: { fileWatch: false, pollMs: 600000 } } });
  await h.mirror.start();
  h.sessionStart();
  const id = 'blist1';
  const file = h.ch.writeTaskOutput(S1, id, 'building\n');
  const r = h.records();
  bgTurn(r, { id, file, command: 'make', description: 'Build' });
  h.ch.writeTranscript(S1, r.records);
  await h.waitRow(id, (x) => x.line === 'building');
  await waitUntil(() => h.spy.watches.length === 1, { what: 'the watch' });
  // A running shell of another conversation, whose file also ends unseen: a
  // Stop of S1's conversation reconciles S1's rows only.
  h.publish('SessionStart', { session: { source: 'startup' }, claude_pid: PID + 1 }, S2);
  const other = 'bother';
  const otherFile = h.ch.writeTaskOutput(S2, other, 'elsewhere\n');
  h.publish('PostToolUse', {
    tool: { name: 'Bash', use_id: 'toolu_01Other', input: { command: 'make other', description: 'Other build', run_in_background: true } },
    result: { ok: true, fields: { backgroundTaskId: other, outputFile: otherFile } },
  }, S2);
  await h.waitRow(other, (x) => x.line === 'elsewhere', 'the other conversation\'s row');
  assert.notEqual(h.row(other).conversation_id, h.row(id).conversation_id);
  await waitUntil(() => h.spy.watches.length === 2, { what: 'the other watch' });
  h.ch.appendTaskOutput(S2, other, '[exited with code 0]\n');
  h.ch.appendTaskOutput(S1, id, 'linked\n[exited with code 0]\n');
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(h.row(id).status, 'running', 'nothing has looked yet');
  h.publish('Stop', { stop: { last_assistant_message: 'ok', background_tasks: [
    { id: 'bnew09', type: 'shell', status: 'running', description: 'Tail the log', command: 'tail -f build.log' },
    { id: AGENT, type: 'subagent', status: 'running', description: 'Explore', agent_type: 'Explore' },
  ] } });
  const made = h.row('bnew09');
  assert.ok(made, 'a listed unknown shell makes a row');
  assert.equal(made.status, 'running');
  assert.equal(made.title, 'Tail the log');
  assert.equal(made.can.output, false, 'no path for it');
  assert.equal(h.row(AGENT), null, 'an agent is not this source\'s');
  const done = await h.waitRow(id, (x) => x.status !== 'running', 'the footer read the Stop asked for');
  assert.equal(done.status, 'done');
  assert.equal(done.exit_code, 0);
  assert.equal(done.line, 'linked');
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(h.row(other).status, 'running', 'another conversation\'s row is not this Stop\'s to read');
  await h.mirror.stop();
});

// ── markStopRequested ────────────────────────────────────────────────────────

test('markStopRequested marks a running shell and a running agent row; finished and unknown answer null', async (t) => {
  const clock = fakeClock();
  const h = setup(t, { wrap: { clock } });
  await h.mirror.start();
  h.sessionStart();
  const id = 'bmark1';
  const file = h.ch.writeTaskOutput(S1, id, 'running\n');
  const r = h.records();
  bgTurn(r, { id, file });
  h.ch.writeTranscript(S1, r.records);
  await h.waitRow(id, (x) => x.line === 'running');
  const marked = h.mirror.markStopRequested(id);
  assert.equal(marked.id, id);
  assert.equal(marked.stop_requested_at, clock.now());
  assert.ok(Number.isFinite(marked.rev), 'serialized');
  assert.equal(h.row(id).stop_requested_at, clock.now());

  h.probe.engine.model.upsertTask({
    id: AGENT, conversation_id: S1, kind: 'agent', title: 'Explore the repo', status: 'running', started_at: Date.now(),
    line: '', meta: {}, turn_id: null, tool_use_id: null, can: { output: false, open: true, stop: true },
  });
  const agent = h.mirror.markStopRequested(AGENT);
  assert.equal(agent.kind, 'agent');
  assert.equal(agent.stop_requested_at, clock.now(), 'Cancel per agent: the mark is generic');

  h.ch.appendTaskOutput(S1, id, '[exited with code 0]\n');
  await h.waitRow(id, (x) => x.status === 'done');
  assert.equal(h.mirror.markStopRequested(id), null, 'a finished row answers null');
  assert.equal(h.mirror.markStopRequested('bnope9'), null, 'an unknown id answers null');
  await h.mirror.stop();
});

// ── no output yet, and the 30 minutes ────────────────────────────────────────

test('no output 5 s after the start sets no_output_yet, growth clears it; a finished row goes 30 minutes later', async (t) => {
  const clock = fakeClock();
  const h = setup(t, { wrap: { clock } });
  await h.mirror.start();
  h.sessionStart();
  const id = 'bquiet';
  const file = h.ch.writeTaskOutput(S1, id, '');
  const r = createRecords({ seed: 1, sessionId: S1, cwd: h.ch.cwd, start: clock.now(), step: 10 });
  bgTurn(r, { id, file, command: 'python3 slow.py', description: 'Slow job' });
  h.ch.writeTranscript(S1, r.records);
  await h.waitRow(id, (x) => x.status === 'running' && x.can.output);
  assert.equal(h.row(id).meta.no_output_yet, undefined);
  clock.advance(4000);
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(h.row(id).meta.no_output_yet, undefined, 'not before 5 s');
  clock.advance(1500);
  await h.waitRow(id, (x) => x.meta.no_output_yet === true, 'no_output_yet');
  h.ch.appendTaskOutput(S1, id, 'finally\n');
  const grown = await h.waitRow(id, (x) => x.meta.no_output_yet === false, 'growth clears it');
  assert.equal(grown.line, 'finally');
  h.ch.appendTaskOutput(S1, id, '[exited with code 0]\n');
  const done = await h.waitRow(id, (x) => x.status === 'done');
  // The keep timer runs from ended_at (the file's mtime) on the source's clock.
  const left = done.ended_at + tasks.FINISHED_KEEP_MS - clock.now();
  clock.advance(left - 1000);
  assert.ok(h.row(id), 'still there a second before');
  clock.advance(2000);
  assert.equal(h.row(id), null, 'removed 30 minutes after it ended');
  assert.deepEqual(h.mirror.tasks().counts.shells, { running: 0, total: 0 });
  await h.mirror.stop();
});

// ── restart ──────────────────────────────────────────────────────────────────

test('restart: the persisted slice brings the running row back and its watch resumes', async (t) => {
  const store = fakeStore();
  const a = setup(t, { store });
  await a.mirror.start();
  a.sessionStart();
  const id = 'brest1';
  const file = a.ch.writeTaskOutput(S1, id, 'first\n');
  const r = a.records();
  bgTurn(r, { id, file, command: 'npm run serve', description: 'Serve' });
  r.assistant(['Started.']);
  r.turnDuration({ durationMs: 20 });
  a.ch.writeTranscript(S1, r.records);
  await a.waitRow(id, (x) => x.line === 'first');
  await a.mirror.stop();
  const slice = store.saved.get(S1).state.sources.tasks;
  assert.equal(slice.v, tasks.STATE_VERSION);
  assert.equal(slice.rows.length, 1);
  assert.equal(slice.rows[0].id, id);
  assert.equal(slice.rows[0].status, 'running');

  const b = setup(t, { store, root: a.root, ch: a.ch });
  await b.mirror.start();
  b.sessionStart('resume');
  const back = await b.waitRow(id, (x) => x.status === 'running', 'the restored row');
  assert.equal(back.title, 'Serve');
  assert.equal(back.can.output, true);
  b.ch.appendTaskOutput(S1, id, 'second\n');
  await b.waitRow(id, (x) => x.line === 'second', 'the resumed watch');
  assert.equal(b.rows().length, 1);
  await b.mirror.stop();
  assertNoPath(b, file, 'the restored row');
});

// ── the watch cap ────────────────────────────────────────────────────────────

test('at most TASKS_WATCH_MAX watches; a waiting row is watched when a slot frees', async (t) => {
  const h = setup(t, { pollMs: 200 });
  await h.mirror.start();
  h.sessionStart();
  const r = h.records();
  const n = tasks.TASKS_WATCH_MAX + 2;
  for (let i = 0; i < n; i++) {
    const id = `bcap${String(i).padStart(3, '0')}`;
    bgTurn(r, { id, file: h.ch.writeTaskOutput(S1, id, 'up\n') });
    r.turnDuration({ durationMs: 10 });
  }
  h.ch.writeTranscript(S1, r.records);
  await waitUntil(() => h.rows().filter((x) => x.line === 'up').length === n, { timeout: 15000, what: 'every row read once' });
  await waitUntil(() => h.spy.watches.length === tasks.TASKS_WATCH_MAX, { timeout: 8000, what: 'the cap reached' });
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(h.spy.watches.length, tasks.TASKS_WATCH_MAX, 'no watch past the cap');
  assert.equal(h.mirror.snapshot({}).diagnostics.tasks.watching, tasks.TASKS_WATCH_MAX);
  assert.equal(h.mirror.snapshot({}).diagnostics.tasks.running, n);
  const first = path.basename(h.spy.watches[0], '.output');
  h.ch.appendTaskOutput(S1, first, '[exited with code 0]\n');
  await h.waitRow(first, (x) => x.status === 'done', 'the watched row ends');
  await waitUntil(() => h.spy.watches.length === tasks.TASKS_WATCH_MAX + 1, { timeout: 8000, what: 'a waiting row takes the slot' });
  assert.equal(h.mirror.snapshot({}).diagnostics.tasks.watching, tasks.TASKS_WATCH_MAX);
  assert.equal(new Set(h.spy.watches).size, tasks.TASKS_WATCH_MAX + 1, 'a new file, not the ended one again');
  await h.mirror.stop();
});

// ── stop ─────────────────────────────────────────────────────────────────────

test('stop() leaves no watch and no timer of the source', async (t) => {
  const clock = fakeClock();
  const h = setup(t, { wrap: { clock } });
  await h.mirror.start();
  h.sessionStart();
  const r = h.records();
  const files = [];
  for (const id of ['bs0001', 'bs0002', 'bs0003']) {
    const file = h.ch.writeTaskOutput(S1, id, '');
    files.push(file);
    bgTurn(r, { id, file });
    r.turnDuration({ durationMs: 10 });
  }
  h.ch.writeTranscript(S1, r.records);
  await waitUntil(() => h.spy.watches.length === 3, { timeout: 8000, what: 'three watches' });
  assert.ok(clock.held() >= 3, 'the no-output timers are armed');
  assert.equal(h.mirror.snapshot({}).diagnostics.tasks.watching, 3);
  await h.mirror.stop();
  assert.equal(h.spy.watchStops, 3, 'every watch stopped');
  assert.equal(clock.held(), 0, 'every timer cleared');
  assert.equal(h.mirror.stats().watchers, 0);
});
