// "Fork from here" (lib/server/control/fork.js, spec §15.6 first paragraph,
// §15.5; design/chat-mirror-control.md C-CONV-2):
//   * forkArgv: the exact argv for an id pair and web-chat's own label; an id
//     outside the UUID grammar, or a label beyond web-chat's grammar, throws;
//   * the row, driven through the control domain's invoke() (U81) against a
//     stubbed `claude` (fakeBin) that records its argv, environment and stdin:
//     the answer is the new session id and `claude --resume <id>`; the argv is
//     forkArgv's; the environment holds no CLAUDE_CODE_* / WEB_CHAT_* key and
//     keeps CLAUDE_CONFIG_DIR; stdin is /dev/null;
//   * no user text: a turn whose prompt holds a distinctive string never puts it
//     in the argv, the event, the audit line or any answer;
//   * refusals: forkAnchor's unknown, superseded and first, an unavailable
//     transcripts source, and no claude each answer a hint and spawn nothing; a
//     stub that prints garbage, exits 1 or outlives the timeout → fork-failed,
//     with no stderr in the answer or the audit;
//   * limits: a second fork within 5 s is rate_limited; one control event op
//     'fork' per fork that ran, without the command;
//   * features(): ok, claude-missing, no-transcripts; control.features().fork.
// Nothing here runs a real `claude`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { tmpRoot, fakeBin } = require('../test-support/helpers');
const { createBus } = require('../lib/core/bus');
const { projectPaths } = require('../lib/core/paths');
const { runClaudeAsync } = require('../lib/core/claude-cli');
const { createControl } = require('../lib/server/control');
const { installFork, forkArgv, HINTS } = require('../lib/server/control/fork');

const SRC = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const NEW = '33333333-3333-4333-8333-333333333333';
const SECRET = 'ZEBRA-PROMPT-7741-do-not-copy';
const STDERR_SECRET = 'STDERR-ECHO-5512';

// ── fixtures ────────────────────────────────────────────────────────────────

function fakeClock(start = 1_760_000_000_000) {
  let t = start;
  return { now: () => t, tick(ms) { t += ms; return t; } };
}

// A mirror facade with the methods the row reads: forkAnchor, turn, stats.
function fakeMirror({ anchors = {}, headers = {}, sources = ['transcripts'], noAnchor = false } = {}) {
  const m = {
    calls: [],
    async turn(id) {
      const h = headers[id];
      return h ? { turn: h, items: [{ id: `p_${id}`, kind: 'prompt', text: h.prompt.preview }] } : null;
    },
    stats: () => ({ running: true, stopped: false, enabled: true, sources: sources.map((name) => ({ name, started: true })) }),
  };
  if (!noAnchor) {
    m.forkAnchor = async (id) => {
      m.calls.push(id);
      return Object.hasOwn(anchors, id) ? anchors[id] : { refused: 'unknown' };
    };
  }
  return m;
}

function header(id, extra = {}) {
  return {
    id, conversation_id: 'conv-1', session_id: SRC, started_at: Date.UTC(2026, 9, 7, 12, 30),
    prompt: { preview: `please ${SECRET} now`, origin: 'terminal' }, node: null, ...extra,
  };
}

// The daemon's local 'YYYY-MM-DD HH:MM' for a time, as the row labels one.
function localTime(ms) {
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// A stub `claude`: records {argv, env, stdin} as one JSONL line in REC, then
// behaves per MODE.
const STUB = `
const fs = require('fs');
let stdinLen = -1, rdev = null;
try { stdinLen = fs.readFileSync(0).length; rdev = fs.fstatSync(0).rdev; } catch {}
fs.appendFileSync(process.env.REC, JSON.stringify({ argv: process.argv.slice(2), env: process.env, stdinLen, rdev, devnull: fs.statSync('/dev/null').rdev }) + '\\n');
const mode = process.env.MODE;
if (mode === 'ok') process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: process.env.NEW_SID, total_cost_usd: 0 }));
else if (mode === 'garbage') process.stdout.write('not json at all');
else if (mode === 'same') process.stdout.write(JSON.stringify({ session_id: process.env.SRC_SID }));
else if (mode === 'notuuid') process.stdout.write(JSON.stringify({ session_id: 'abc; touch /tmp/wc-fork-pwned' }));
else if (mode === 'exit1') { process.stderr.write('error: ' + process.env.LEAK + '\\n'); process.exit(1); }
else if (mode === 'sleep') { process.stderr.write(process.env.LEAK); setTimeout(() => {}, 120000); }
`;

function stubClaude(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-fork-stub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'stub.js');
  fs.writeFileSync(script, STUB);
  const rec = path.join(dir, 'rec.jsonl');
  const { bin } = fakeBin(t, { name: 'claude', script, env: { REC: rec, MODE: mode, NEW_SID: NEW, SRC_SID: SRC, LEAK: STDERR_SECRET } });
  return {
    bin,
    records: () => (fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

function setup(t, {
  mode = 'ok', anchors = { t2: { session_id: SRC, parent_uuid: PARENT } }, headers = { t2: header('t2') },
  mirror, findClaude, runner, graph = null, sources,
} = {}) {
  const root = tmpRoot('wc-fork-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = fakeClock();
  const bus = createBus();
  const events = [];
  const off = bus.subscribe((e) => { if (e.kind === 'control') events.push(e); });
  t.after(off);
  const control = createControl({ root, bus, now: clock.now });
  t.after(() => control.stop());
  const stub = stubClaude(t, mode);
  const m = mirror || fakeMirror({ anchors, headers, sources });
  const fork = installFork(control, {
    mirror: m, graph, root, bus, now: clock.now,
    findClaude: findClaude || (() => stub.bin),
    runClaudeAsync: runner || runClaudeAsync,
  });
  const auditLines = () => {
    const f = projectPaths(root).controlAudit;
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { root, clock, control, fork, stub, events, mirror: m, auditLines };
}

// Capture the row a fake control is handed.
function captureRow(opts = {}) {
  let row = null;
  const control = { action(name, spec) { assert.equal(name, 'fork'); row = spec; return () => {}; } };
  const fork = installFork(control, { root: os.tmpdir(), findClaude: () => '/bin/false', ...opts });
  return { row, fork };
}

// ── forkArgv ────────────────────────────────────────────────────────────────

test('forkArgv: the exact argv for a valid id pair and web-chat\'s own label', () => {
  assert.deepEqual(forkArgv({ label: 'fork of n1.12', sessionId: SRC, parentUuid: PARENT }), [
    '-p', '/rename fork of n1.12',
    '--resume', SRC,
    '--resume-session-at', PARENT,
    '--fork-session',
    '--output-format', 'json',
  ]);
  assert.ok(!forkArgv({ label: 'fork of n1.12', sessionId: SRC, parentUuid: PARENT }).some((a) => /\/cost/.test(a)), '/rename, never /cost');
  assert.doesNotThrow(() => forkArgv({ label: 'fork of 2026-10-07 12:30', sessionId: SRC, parentUuid: PARENT }));
  assert.doesNotThrow(() => forkArgv({ label: `fork of ${'a'.repeat(48)}`, sessionId: SRC, parentUuid: PARENT }));
});

test('forkArgv: an id outside the UUID grammar, or a label beyond web-chat\'s, throws', () => {
  const ok = { label: 'fork of n1.2', sessionId: SRC, parentUuid: PARENT };
  for (const bad of ['', 'not-a-uuid', `${SRC} --x`, `${SRC}\n`, '--help', SRC.slice(0, 35), null, 7]) {
    assert.throws(() => forkArgv({ ...ok, sessionId: bad }), TypeError, `session ${JSON.stringify(bad)}`);
    assert.throws(() => forkArgv({ ...ok, parentUuid: bad }), TypeError, `parent ${JSON.stringify(bad)}`);
  }
  for (const bad of [
    'fork of n1.2"', 'fork of n1.2\'', 'fork of n1\n.2', 'fork of n1;2', `fork of ${'a'.repeat(49)}`,
    'fork of ', 'n1.2', 'fork of $(id)', 'fork of n1.2‮', 'FORK OF n1', null,
  ]) {
    assert.throws(() => forkArgv({ ...ok, label: bad }), TypeError, `label ${JSON.stringify(bad)}`);
  }
});

// ── the row through invoke() ────────────────────────────────────────────────

test('a fork against a stubbed claude answers the session id and the resume command; argv, env and stdin are as specified', async (t) => {
  const s = setup(t);
  const saved = {};
  for (const k of ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'WEB_CHAT_CHANNEL', 'CLAUDE_CONFIG_DIR']) saved[k] = process.env[k];
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  process.env.CLAUDE_CODE_SESSION_ID = SRC;
  process.env.WEB_CHAT_CHANNEL = '1';
  process.env.CLAUDE_CONFIG_DIR = '/tmp/wc-fork-profile';

  const a = await s.control.invoke('fork', { turn_id: 't2' }, {});
  assert.deepEqual(a, { ok: true, session_id: NEW, command: `claude --resume ${NEW}` });

  const recs = s.stub.records();
  assert.equal(recs.length, 1, 'one spawn');
  assert.deepEqual(recs[0].argv, forkArgv({ label: `fork of ${localTime(Date.UTC(2026, 9, 7, 12, 30))}`, sessionId: SRC, parentUuid: PARENT }));
  for (const k of Object.keys(recs[0].env)) {
    assert.ok(!k.startsWith('CLAUDE_CODE_'), `${k} is not inherited`);
    // fakeBin's own wrapper sets REC/MODE/…; nothing named WEB_CHAT_* survives.
    assert.ok(!k.startsWith('WEB_CHAT_'), `${k} is not inherited`);
  }
  assert.equal(recs[0].env.CLAUDE_CONFIG_DIR, '/tmp/wc-fork-profile', 'CLAUDE_CONFIG_DIR is kept');
  assert.equal(recs[0].stdinLen, 0, 'stdin reads EOF at once');
  assert.equal(recs[0].rdev, recs[0].devnull, 'stdin is /dev/null');

  // One event, content-free, never the command.
  assert.equal(s.events.length, 1);
  const ev = s.events[0];
  assert.deepEqual(
    { kind: ev.kind, op: ev.op, conversation_id: ev.conversation_id, session_id: ev.session_id, outcome: ev.outcome },
    { kind: 'control', op: 'fork', conversation_id: 'conv-1', session_id: SRC, outcome: 'forked' },
  );
  assert.match(ev.id, /^fk_[0-9a-z]+$/);
  assert.ok(!JSON.stringify(ev).includes('--resume') && !JSON.stringify(ev).includes(NEW), 'no command, no new id on the event');

  // One audit line, ids only.
  const lines = s.auditLines();
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].action, lines[0].outcome, lines[0].target], ['fork', 'accepted', { turn_id: 't2' }]);
  assert.ok(!JSON.stringify(lines).includes('--resume'));
});

test('the label is the turn\'s node label (lib/server/domain/refs), else its time; a label off web-chat\'s grammar is never used', async (t) => {
  // A graph whose n2 is labelled n1.1, and a header still carrying the node id.
  const graph = {
    nodes: new Map([['n1', {}], ['n2', {}]]),
    topology: new Map([
      ['n1', { id: 'n1', parent_id: null, children: ['n2'], created_at: 1 }],
      ['n2', { id: 'n2', parent_id: 'n1', children: [], created_at: 2 }],
    ]),
  };
  const s = setup(t, { graph, headers: { t2: header('t2', { node: { id: 'n2', label: 'n2', role: 'last' } }) } });
  assert.equal((await s.control.invoke('fork', { turn_id: 't2' }, {})).ok, true);
  assert.equal(s.stub.records()[0].argv[1], '/rename fork of n1.1');

  const { row } = captureRow({ graph, mirror: fakeMirror({ headers: { t2: header('t2', { node: { id: 'n2', label: 'n2' } }) } }) });
  assert.deepEqual(await row.describe({ turn_id: 't2' }), {
    title: 'Fork from here',
    summary: 'Fork this conversation from before turn n1.1. The original is kept; no files are restored; no cost.',
  });

  // A node label that is not web-chat's grammar falls back to the time.
  const odd = captureRow({ mirror: fakeMirror({ headers: { t3: header('t3', { node: { id: 'nX', label: 'x"; rm -rf ~' }, started_at: null }) } }) });
  const d = await odd.row.describe({ turn_id: 't3' });
  assert.equal(d.summary, 'Fork this conversation from before turn an earlier turn. The original is kept; no files are restored; no cost.');
  // …and with a time, the daemon's local time.
  const timed = captureRow({ mirror: fakeMirror({ headers: { t4: header('t4', { node: { id: 'nX', label: 'a;b' } }) } }) });
  assert.match((await timed.row.describe({ turn_id: 't4' })).summary, new RegExp(`before turn ${localTime(Date.UTC(2026, 9, 7, 12, 30))}\\.`));
});

test('params: {turn} from a query or {turn_id} from a body, the same target; anything else is a bad target', () => {
  const { row } = captureRow();
  assert.deepEqual(row.fields, ['turn_id']);
  assert.deepEqual(row.layouts, ['confirm']);
  assert.deepEqual(row.limit, { scope: 'project', ms: 5000 });
  assert.deepEqual(row.params({ turn: 't2' }), { turn_id: 't2' });
  assert.deepEqual(row.params({ turn_id: 't2' }), { turn_id: 't2' });
  assert.equal(row.key(row.params({ turn: 't2' })), row.key(row.params({ turn_id: 't2' })));
  for (const bad of [{}, { turn: '' }, { turn: 't 2' }, { turn: 't2', turn_id: 't3' }, { turn: ['t2'] }, { turn: 'x'.repeat(101) }, { turn: `t2${SECRET}"` }]) {
    assert.throws(() => row.params(bad), `${JSON.stringify(bad)} is refused`);
  }
});

test('no user text: the prompt\'s distinctive string reaches no argv, event, audit line or answer', async (t) => {
  const s = setup(t);
  const a = await s.control.invoke('fork', { turn_id: 't2' }, {});
  const r1 = await s.control.invoke('fork', { turn_id: 't2' }, {}); // rate_limited
  s.clock.tick(6000);
  const r2 = await s.control.invoke('fork', { turn_id: 'nope' }, {}); // unknown
  const { row } = captureRow({ mirror: s.mirror });
  const desc = await row.describe({ turn_id: 't2' });
  const everything = JSON.stringify({
    a, r1, r2, desc, argv: s.stub.records().map((r) => r.argv), events: s.events, audit: s.auditLines(),
  });
  assert.ok(!everything.includes(SECRET), 'the prompt never leaves the transcript');
  assert.ok(!everything.includes('ZEBRA'));
});

for (const code of ['unknown', 'superseded', 'first']) {
  test(`forkAnchor ${code} refuses with its hint and spawns nothing`, async (t) => {
    const s = setup(t, { anchors: { t2: { refused: code } } });
    const a = await s.control.invoke('fork', { turn_id: 't2' }, {});
    assert.deepEqual(a, { ok: false, refused: code, hint: HINTS[code] });
    assert.equal(s.stub.records().length, 0, 'nothing spawned');
    assert.equal(s.events.length, 0);
    assert.equal(s.auditLines()[0].outcome, `refused:${code}`);
    // A refusal hands its window back: another turn may fork at once.
    s.mirror.forkAnchor = async () => ({ session_id: SRC, parent_uuid: PARENT });
    assert.equal((await s.control.invoke('fork', { turn_id: 't2' }, {})).ok, true);
  });
}

test('an anchor outside the UUID grammar, a throwing forkAnchor and an unavailable source refuse and spawn nothing', async (t) => {
  const s = setup(t, { anchors: { t2: { session_id: '../../etc', parent_uuid: PARENT }, t3: { session_id: SRC, parent_uuid: '--help' }, t4: { unavailable: true } } });
  assert.equal((await s.control.invoke('fork', { turn_id: 't2' }, {})).refused, 'unknown');
  assert.equal((await s.control.invoke('fork', { turn_id: 't3' }, {})).refused, 'unknown');
  const u = await s.control.invoke('fork', { turn_id: 't4' }, {});
  assert.deepEqual(u, { ok: false, refused: 'no-transcripts', hint: HINTS['no-transcripts'] });
  s.mirror.forkAnchor = async () => { throw new Error('boom'); };
  assert.equal((await s.control.invoke('fork', { turn_id: 't2' }, {})).refused, 'unknown');
  assert.equal(s.stub.records().length, 0);
});

test('no claude → claude-missing, with a hint that names the install, and nothing spawned', async (t) => {
  const s = setup(t, { findClaude: () => null });
  const a = await s.control.invoke('fork', { turn_id: 't2' }, {});
  assert.deepEqual(a, { ok: false, refused: 'claude-missing', hint: HINTS['claude-missing'] });
  assert.match(a.hint, /install Claude Code/);
  assert.equal(s.stub.records().length, 0);
});

// Timeouts with headroom for a loaded machine (spec §10.1): a stub that answers
// at once is ended by its answer, so its timeout is generous and never the
// clock that ends it; the 'sleep' stub records its run before it sleeps 120 s,
// and its 2 s timeout leaves a Node child's start-up under load room to land
// that record before the runner kills it. The sleep is far past the suite's
// 60 s per-test timeout, so a runner that never kills it fails the case by a
// whole minute, not by the few ms a sleep equal to that timeout would leave.
const ANSWER_TIMEOUT_MS = 15_000;
const SLEEP_TIMEOUT_MS = 2_000;
for (const [mode, why] of [['garbage', 'prints garbage'], ['exit1', 'exits 1'], ['sleep', 'sleeps past the timeout'], ['same', 'answers its own source'], ['notuuid', 'answers a session id outside the UUID grammar']]) {
  test(`a stub that ${why} → fork-failed, with no stderr in the answer or the audit`, async (t) => {
    const timeoutMs = mode === 'sleep' ? SLEEP_TIMEOUT_MS : ANSWER_TIMEOUT_MS;
    const s = setup(t, { mode, runner: (argv, o) => runClaudeAsync(argv, { ...o, timeoutMs }) });
    const a = await s.control.invoke('fork', { turn_id: 't2' }, {});
    assert.deepEqual(a, { ok: false, refused: 'fork-failed', hint: HINTS['fork-failed'] });
    assert.equal(s.stub.records().length, 1, 'it ran once');
    const audit = s.auditLines();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].outcome, 'refused:fork-failed');
    const all = JSON.stringify({ a, audit, events: s.events });
    assert.ok(!all.includes(STDERR_SECRET), 'stderr never leaves the runner');
    assert.ok(!all.includes('--resume'), 'no command');
    assert.equal(s.events.length, 1);
    assert.equal(s.events[0].outcome, 'failed');
  });
}

test('the run passes the found claude, the project root and a 30 s timeout to the runner', async (t) => {
  const seen = [];
  const s = setup(t, { runner: (argv, o) => { seen.push(o); return Promise.resolve({ ok: true, stdout: JSON.stringify({ session_id: NEW }) }); } });
  assert.equal((await s.control.invoke('fork', { turn_id: 't2' }, {})).ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cwd, s.root);
  assert.equal(seen[0].timeoutMs, 30_000);
  assert.equal(seen[0].bin, s.stub.bin);
  assert.equal(seen[0].env, undefined, 'the runner scrubs the daemon\'s own environment');
});

test('limits: a second fork within 5 s is rate_limited and spawns nothing; after 5 s it runs', async (t) => {
  const s = setup(t, { anchors: { t2: { session_id: SRC, parent_uuid: PARENT }, t3: { session_id: SRC, parent_uuid: PARENT } }, headers: { t2: header('t2'), t3: header('t3') } });
  assert.equal((await s.control.invoke('fork', { turn_id: 't2' }, {})).ok, true);
  s.clock.tick(4000);
  const second = await s.control.invoke('fork', { turn_id: 't3' }, {});
  assert.equal(second.refused, 'rate_limited', 'one bucket per project, any turn');
  assert.equal(s.stub.records().length, 1);
  s.clock.tick(1500);
  assert.equal((await s.control.invoke('fork', { turn_id: 't3' }, {})).ok, true);
  assert.equal(s.stub.records().length, 2);
  assert.equal(s.events.filter((e) => e.op === 'fork').length, 2, 'one event per fork that ran');
  assert.ok(s.events.every((e) => !('command' in e)));
});

test('features(): ok with a claude and the transcripts source; claude-missing and no-transcripts otherwise', async (t) => {
  const s = setup(t);
  assert.deepEqual(s.fork.features(), { ok: true });
  assert.deepEqual(s.control.features().fork, { ok: true });

  assert.deepEqual(captureRow({ mirror: fakeMirror(), findClaude: () => null }).fork.features(), { ok: false, reason: 'claude-missing' });
  assert.deepEqual(captureRow({ mirror: null }).fork.features(), { ok: false, reason: 'no-transcripts' });
  assert.deepEqual(captureRow({ mirror: fakeMirror({ noAnchor: true }) }).fork.features(), { ok: false, reason: 'no-transcripts' });
  assert.deepEqual(captureRow({ mirror: fakeMirror({ sources: ['tasks'] }) }).fork.features(), { ok: false, reason: 'no-transcripts' });
  const stopped = fakeMirror();
  stopped.stats = () => ({ stopped: true, enabled: true, sources: [{ name: 'transcripts' }] });
  assert.deepEqual(captureRow({ mirror: stopped }).fork.features(), { ok: false, reason: 'no-transcripts' });

  const none = setup(t, { findClaude: () => null });
  assert.deepEqual(none.control.features().fork, { ok: false, reason: 'claude-missing' });
});

test('features() memoises findClaude for 60 s; a check always looks again', async (t) => {
  let calls = 0;
  let found = '/bin/false';
  const clock = fakeClock();
  const { row, fork } = captureRow({ mirror: fakeMirror({ anchors: { t2: { session_id: SRC, parent_uuid: PARENT } } }), now: clock.now, findClaude: () => { calls += 1; return found; } });
  fork.features();
  fork.features();
  assert.equal(calls, 1);
  found = null;
  assert.deepEqual(fork.features(), { ok: true }, 'memoised');
  clock.tick(60_001);
  assert.deepEqual(fork.features(), { ok: false, reason: 'claude-missing' });
  found = '/bin/false';
  assert.equal(await row.check({ turn_id: 't2' }), null, 'the check finds it at once');
});

test('installFork refuses a missing control or root', () => {
  assert.throws(() => installFork(null, { root: os.tmpdir() }), TypeError);
  assert.throws(() => installFork({ action() {} }, {}), TypeError);
});
