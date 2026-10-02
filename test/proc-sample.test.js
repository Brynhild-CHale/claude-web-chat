// Process facts — lib/core/portfiles: sampleProcs, isPidAlive with a start time,
// parseProcStart / formatProcStart, processCommand.
//
// The chat mirror decides that a Claude Code session has ENDED from these, so the
// rule pinned hardest here is the spec's "a failed sample is no verdict": only
// two outcomes of `ps` are verdicts (exit 0 listing the live pids; exit 1 with
// empty stdout and stderr), and a timeout, a spawn error (EAGAIN), a signal,
// another exit code, stderr text or a line that cannot be read leave EVERY pid at
// {alive: null}. On linux the same rule reads /proc: ENOENT is "gone", any other
// unreadable entry is no verdict for all, and nothing is spawned.
//
// Pinned:
//   * a real sample of this process: alive, started when `ps -o lstart` says
//     (TZ=UTC, the sessions file's procStart format), CPU time, a run state;
//   * a dead pid is alive:false from a real sample, and null from a failed one;
//   * the verdict rules, through an injected spawner and an injected /proc;
//   * isPidAlive without options is the predicate it always was; with startedAt
//     it also requires the start within ±2 s, from a sample or read now, and
//     answers null (no verdict) when the start cannot be read;
//   * processCommand reads this process's command line, and cloudflared's
//     commandOf is the same function.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { spawn, spawnSync } = require('child_process');

const {
  sampleProcs, isPidAlive, parseProcStart, formatProcStart, processCommand,
  PROC_START_TOLERANCE_MS, SAMPLE_TIMEOUT_MS,
} = require('../lib/core/portfiles');
const cloudflared = require('../lib/tunnel/cloudflared');

const NONE = Object.freeze({ alive: null, startedAt: null, cpuMs: null, state: null });
const GONE = Object.freeze({ alive: false, startedAt: null, cpuMs: null, state: null });

// The real-process tests measure parsing, not speed: a loaded machine (parallel
// suites) may take seconds to run one `ps`, so they get room; the 2 s default is
// pinned against the fake below, where it cannot flake.
const ROOMY = 30_000;

// A pid that WAS a process: a child that has exited and been reaped ('exit'
// fires after libuv's waitpid), so nothing answers to it now.
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}

// `ps -o lstart` for one pid as the engine runs it (UTC, C locale), or null.
function lstartOf(pid) {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// ── a stand-in for child_process.spawn that plays one outcome ──
//   { code, signal, stdout, stderr }  close with these
//   { error: 'EAGAIN' }               the spawn fails asynchronously (an 'error' event)
//   { throws: 'EAGAIN' }              the spawn throws synchronously
//   { hang: true }                    never answers: only the timeout ends it
function fakeSpawn(outcome) {
  const fn = (cmd, args, opts) => {
    fn.calls.push({ cmd, args, opts });
    if (outcome.throws) throw Object.assign(new Error(`spawn ps ${outcome.throws}`), { code: outcome.throws });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.signals = [];
    child.kill = (sig) => { child.signals.push(sig); return true; };
    fn.child = child;
    setImmediate(() => {
      if (outcome.error) { child.emit('error', Object.assign(new Error(`spawn ps ${outcome.error}`), { code: outcome.error })); return; }
      if (outcome.hang) return;
      const ended = [child.stdout, child.stderr].map((s) => new Promise((resolve) => s.once('end', resolve)));
      if (outcome.stdout) child.stdout.write(outcome.stdout);
      if (outcome.stderr) child.stderr.write(outcome.stderr);
      child.stdout.end();
      child.stderr.end();
      Promise.all(ended).then(() => child.emit('close', outcome.code === undefined ? 0 : outcome.code, outcome.signal || null));
    });
    return child;
  };
  fn.calls = [];
  return fn;
}

// One line of `ps -o pid=,lstart=,time=,stat=`, padded the way macOS pads it.
function psLine(pid, { start = 'Fri Oct  2 08:50:32 2026', time = '1:02.50', stat = 'Ss' } = {}) {
  return `${String(pid).padStart(5)} ${start}     ${time} ${stat}  \n`;
}

const darwin = (spawnFn, extra = {}) => ({ platform: 'darwin', spawn: spawnFn, ...extra });

// ─────────────────────────────────────────── the real process ────

test('sampleProcs: this process is alive, started when `ps -o lstart` says, with CPU time and a run state', async () => {
  const m = await sampleProcs([process.pid], { timeoutMs: ROOMY });
  assert.ok(m instanceof Map);
  assert.deepEqual([...m.keys()], [process.pid], 'one entry per pid asked about');
  const e = m.get(process.pid);
  assert.equal(e.alive, true);
  assert.ok(Number.isFinite(e.startedAt), 'a start time');
  assert.equal(e.startedAt % 1000, 0, 'whole seconds, as lstart and procStart count them');
  // Independent of ps: Node's own idea of when this process began.
  const byUptime = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(e.startedAt - byUptime) < 5000, `started about process.uptime() ago (${e.startedAt} vs ${Math.round(byUptime)})`);
  assert.ok(Number.isFinite(e.cpuMs) && e.cpuMs >= 0, `CPU time in ms: ${e.cpuMs}`);
  assert.equal(typeof e.state, 'string');
  assert.ok(e.state.length > 0, 'a run state');
  assert.doesNotMatch(e.state, /[TZ]/, 'neither stopped nor a zombie: it is running this test');

  const lstart = lstartOf(process.pid);
  if (process.platform === 'darwin') {
    assert.ok(lstart, 'ps answers for this process');
    assert.equal(e.startedAt, parseProcStart(lstart), 'startedAt IS the lstart text, parsed: the same text the sessions file holds');
    assert.equal(formatProcStart(e.startedAt), lstart, 'and formats back to it, byte for byte');
  } else if (lstart) {
    // linux reads /proc and spawns nothing, while procps computes lstart its own
    // way; they agree within the tolerance isPidAlive applies.
    assert.ok(Math.abs(e.startedAt - parseProcStart(lstart)) <= PROC_START_TOLERANCE_MS, `${e.startedAt} vs ps's ${lstart}`);
  }
});

test('sampleProcs: a dead pid is alive:false from a real sample — and no verdict from a failed one', async () => {
  const dead = await deadPid();
  // darwin: ps exits 1 with empty stdout and stderr (none alive); linux: ENOENT.
  assert.deepEqual((await sampleProcs([dead], { timeoutMs: ROOMY })).get(dead), GONE);
  // darwin: ps exits 0 listing only the live one.
  const both = await sampleProcs([process.pid, dead], { timeoutMs: ROOMY });
  assert.equal(both.get(process.pid).alive, true);
  assert.deepEqual(both.get(dead), GONE);
  // The same dead pid through a ps that could not run says nothing about it.
  const failed = await sampleProcs([dead], darwin(fakeSpawn({ error: 'EAGAIN' })));
  assert.deepEqual(failed.get(dead), NONE);
});

// ───────────────────────────────────── the verdict rules (darwin) ────

test('verdict: exit 0 lists the live pids; an unlisted pid asked about is alive:false', async () => {
  const spawnFn = fakeSpawn({ code: 0, stdout: psLine(4242) + psLine(4244, { start: 'Thu Oct  1 23:18:01 2026', time: '123:03.91', stat: 'T+' }) });
  const m = await sampleProcs([4242, 4243, 4244], darwin(spawnFn));
  assert.deepEqual(m.get(4242), { alive: true, startedAt: Date.UTC(2026, 9, 2, 8, 50, 32), cpuMs: 62_500, state: 'Ss' });
  assert.deepEqual(m.get(4243), GONE, 'asked about, not listed: a verdict that it is not there');
  assert.deepEqual(m.get(4244), { alive: true, startedAt: Date.UTC(2026, 9, 1, 23, 18, 1), cpuMs: 7_383_910, state: 'T+' }, 'a stopped process (T) is alive; minutes past 59 read');

  assert.equal(spawnFn.calls.length, 1, 'ONE ps for every pid');
  const [{ cmd, args, opts }] = spawnFn.calls;
  assert.equal(cmd, 'ps');
  assert.deepEqual(args, ['-o', 'pid=,lstart=,time=,stat=', '-p', '4242,4243,4244']);
  assert.equal(opts.env.TZ, 'UTC', 'lstart in UTC: the sessions file\'s procStart');
  assert.equal(opts.env.LC_ALL, 'C', 'day and month names (and the decimal point) ps formats by the locale');
});

test('verdict: exit 1 with empty stdout and stderr means none of them exists', async () => {
  const m = await sampleProcs([4242, 4243], darwin(fakeSpawn({ code: 1 })));
  assert.deepEqual(m.get(4242), GONE);
  assert.deepEqual(m.get(4243), GONE);
});

test('verdict: a ps that never answers is no verdict at the timeout, and is killed', async () => {
  assert.equal(SAMPLE_TIMEOUT_MS, 2000, 'the spec\'s 2 s bound is the default');
  const spawnFn = fakeSpawn({ hang: true });
  const m = await sampleProcs([4242, 4243], darwin(spawnFn, { timeoutMs: 50 }));
  assert.deepEqual(m.get(4242), NONE);
  assert.deepEqual(m.get(4243), NONE);
  assert.deepEqual(spawnFn.child.signals, ['SIGKILL'], 'the hung ps is not left running');
});

test('verdict: a spawn error (EAGAIN under load), thrown or emitted, is no verdict', async () => {
  for (const outcome of [{ error: 'EAGAIN' }, { throws: 'EAGAIN' }, { error: 'ENOENT' }]) {
    const m = await sampleProcs([4242, 4243], darwin(fakeSpawn(outcome)));
    assert.deepEqual(m.get(4242), NONE, JSON.stringify(outcome));
    assert.deepEqual(m.get(4243), NONE, JSON.stringify(outcome));
  }
});

test('verdict: a ps ended by a signal is no verdict, whatever it printed first', async () => {
  const m = await sampleProcs([4242, 4243], darwin(fakeSpawn({ code: null, signal: 'SIGTERM', stdout: psLine(4242) })));
  assert.deepEqual(m.get(4242), NONE);
  assert.deepEqual(m.get(4243), NONE, 'never alive:false for the pid it did not get to list');
});

test('verdict: anything on stderr is no verdict, with exit 0 or exit 1', async () => {
  const listing = await sampleProcs([4242, 4243], darwin(fakeSpawn({ code: 0, stdout: psLine(4242), stderr: 'ps: a warning\n' })));
  assert.deepEqual(listing.get(4242), NONE);
  assert.deepEqual(listing.get(4243), NONE);
  const refused = await sampleProcs([4242], darwin(fakeSpawn({ code: 1, stderr: 'ps: process id too large: 4242\n' })));
  assert.deepEqual(refused.get(4242), NONE, 'exit 1 is a verdict only with nothing on stderr');
});

test('verdict: another exit code, exit 1 with output, or a listing this cannot read is no verdict', async () => {
  const cases = [
    { code: 2 },
    { code: 1, stdout: psLine(4242) },
    { code: 0, stdout: '' },
    { code: 0, stdout: '4242 garbage\n' },
    { code: 0, stdout: psLine(4242) + psLine(5555) },
    { code: 0, stdout: psLine(4242) + psLine(4242) },
    { code: 0, stdout: psLine(4242, { start: 'Fr.  2 Okt. 08:50:32 2026' }) },
  ];
  for (const outcome of cases) {
    const m = await sampleProcs([4242, 4243], darwin(fakeSpawn(outcome)));
    assert.deepEqual(m.get(4242), NONE, JSON.stringify(outcome));
    assert.deepEqual(m.get(4243), NONE, JSON.stringify(outcome));
  }
});

test('sampleProcs: only usable pids reach ps — one bad pid never costs the others their verdict', async () => {
  const spawnFn = fakeSpawn({ code: 0, stdout: psLine(4242) });
  const asked = [0, -1, 1.5, '4242', NaN, null, 100000, 4242, 4242];
  const m = await sampleProcs(asked, darwin(spawnFn));
  assert.deepEqual(spawnFn.calls[0].args.slice(-1), ['4242'], 'one pid on the command line, once: macOS ps refuses anything over 99999 on stderr, which would void the call');
  assert.equal(m.get(4242).alive, true);
  for (const bad of [0, -1, 1.5, '4242', NaN, null, 100000]) assert.deepEqual(m.get(bad), NONE, `${String(bad)} is not a pid to sample`);
  assert.equal(m.size, asked.length - 1, 'one entry per distinct pid');

  const never = fakeSpawn({ code: 0 });
  assert.equal((await sampleProcs([], darwin(never))).size, 0);
  assert.deepEqual((await sampleProcs([0, 'x'], darwin(never))).get('x'), NONE);
  assert.equal(never.calls.length, 0, 'nothing to sample, nothing spawned');
});

test('sampleProcs: a platform with neither ps nor /proc to read is no verdict, and spawns nothing', async () => {
  const spawnFn = fakeSpawn({ code: 0, stdout: psLine(4242) });
  const m = await sampleProcs([4242], { platform: 'win32', spawn: spawnFn });
  assert.deepEqual(m.get(4242), NONE);
  assert.equal(spawnFn.calls.length, 0);
});

// ──────────────────────────────────────────────── linux: /proc ────

// A fake /proc: a path maps to its text, or to an errno code to throw.
function fakeProc(files) {
  const readFile = (p) => {
    readFile.reads.push(p);
    const v = files[p];
    if (v === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });
    if (typeof v === 'object') throw Object.assign(new Error(`${v.code}: ${p}`), { code: v.code });
    return v;
  };
  readFile.reads = [];
  return readFile;
}

// /proc/<pid>/stat: pid (comm) then fields 3.. — state is field 3, utime 14,
// stime 15, starttime 22. rsslim (field 25) is past 2^53, as it is in life.
function statLine(pid, comm, { state = 'S', utime = 150, stime = 50, starttime = 123456 } = {}) {
  const fields = [state, 1, pid, pid, 0, -1, 4194560, 2345, 0, 0, 0, utime, stime, 0, 0, 20, 0, 11, 0, starttime, 1234567890, 4321, '18446744073709551615'];
  return `${pid} (${comm}) ${fields.join(' ')}\n`;
}

const BTIME = 1790900000;
const PROC_STAT = `cpu  1 2 3 4\nbtime ${BTIME}\nprocesses 99\n`;

test('linux: /proc/<pid>/stat and btime, nothing spawned; ENOENT is gone; comm may hold ") "', async () => {
  const readFile = fakeProc({
    '/proc/stat': PROC_STAT,
    '/proc/4242/stat': statLine(4242, 'a) (b'),
    '/proc/4244/stat': statLine(4244, 'claude', { state: 'T', utime: 9, stime: 1, starttime: 99 }),
  });
  const spawnFn = fakeSpawn({ code: 0 });
  const m = await sampleProcs([4242, 4243, 4244, 100000], { platform: 'linux', readFile, spawn: spawnFn });
  assert.deepEqual(m.get(4242), { alive: true, startedAt: (BTIME + 1234) * 1000, cpuMs: 2000, state: 'S' },
    'start = btime + whole seconds since boot (USER_HZ 100), as procps counts lstart; cpu = utime + stime');
  assert.deepEqual(m.get(4243), GONE, 'no /proc/4243: a verdict');
  assert.deepEqual(m.get(4244), { alive: true, startedAt: BTIME * 1000, cpuMs: 100, state: 'T' }, 'stopped');
  assert.deepEqual(m.get(100000), GONE, 'linux pids run past 99999; /proc says whether one exists');
  assert.equal(spawnFn.calls.length, 0, 'nothing spawned on linux');
});

test('linux: an unreadable /proc entry other than ENOENT is no verdict for every pid', async () => {
  const base = { '/proc/stat': PROC_STAT, '/proc/4242/stat': statLine(4242, 'node') };
  const cases = [
    ['EACCES on one pid', { ...base, '/proc/4243/stat': { code: 'EACCES' } }],
    ['EMFILE on one pid', { ...base, '/proc/4243/stat': { code: 'EMFILE' } }],
    ['ESRCH on one pid', { ...base, '/proc/4243/stat': { code: 'ESRCH' } }],
    ['no /proc/stat', { '/proc/4242/stat': statLine(4242, 'node') }],
    ['no btime', { ...base, '/proc/stat': 'cpu 1 2 3\n' }],
    ['a stat that is not one', { ...base, '/proc/4243/stat': 'garbage' }],
    ['a stat for another pid', { ...base, '/proc/4243/stat': statLine(9999, 'node') }],
    ['a stat cut short', { ...base, '/proc/4243/stat': '4243 (node) S 1 2 3' }],
  ];
  for (const [what, files] of cases) {
    const m = await sampleProcs([4242, 4243, 4244], { platform: 'linux', readFile: fakeProc(files) });
    for (const pid of [4242, 4243, 4244]) assert.deepEqual(m.get(pid), NONE, `${what}: pid ${pid}`);
  }
});

// ──────────────────────────────────────────── parse / format ────

test('parseProcStart reads the lstart text as UTC; formatProcStart writes it back', () => {
  const ms = Date.UTC(2026, 9, 2, 8, 50, 32);
  assert.equal(parseProcStart('Fri Oct  2 08:50:32 2026'), ms);
  assert.equal(parseProcStart('  Fri Oct 2 08:50:32 2026    '), ms, 'ps pads the column; spacing is not significant');
  assert.equal(parseProcStart('Thu Oct 22 23:59:59 2026'), Date.UTC(2026, 9, 22, 23, 59, 59));
  assert.equal(formatProcStart(ms), 'Fri Oct  2 08:50:32 2026', 'the day padded with a space, as ps pads it');
  assert.equal(formatProcStart(Date.UTC(2026, 9, 22, 23, 59, 59)), 'Thu Oct 22 23:59:59 2026');
  assert.equal(formatProcStart(ms + 999), 'Fri Oct  2 08:50:32 2026', 'whole seconds');
  for (const t of [0, Date.UTC(2024, 1, 29, 0, 0, 0), Date.UTC(2031, 11, 31, 12, 0, 1)]) {
    assert.equal(parseProcStart(formatProcStart(t)), t, `round trip ${t}`);
  }
  for (const bad of [
    'Fr.  2 Okt. 08:52:47 2026', // de_DE: no verdict, never a mismatch
    '金 10/ 2 08:52:47 2026', // ja_JP
    'Sat Oct  2 08:50:32 2026', // the wrong weekday for the date
    'Sat Feb 30 08:50:32 2026', // no such date
    'Fri Oct  2 24:00:00 2026',
    'Fri Oct  2 08:60:32 2026',
    '2026-10-02T08:50:32Z',
    '',
    null,
    1790931737000,
  ]) assert.equal(parseProcStart(bad), null, String(bad));
  assert.equal(formatProcStart(NaN), null);
  assert.equal(formatProcStart('Fri Oct  2 08:50:32 2026'), null);
});

// ───────────────────────────────────────────────── isPidAlive ────

test('isPidAlive without options is the predicate it always was', async () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(await deadPid()), false);
  assert.equal(isPidAlive(String(process.pid)), false, 'a number, or false');
  assert.equal(isPidAlive(undefined), false);
  assert.equal(isPidAlive(null), false);
  assert.deepEqual([process.pid, process.ppid].filter(isPidAlive), [process.pid, process.ppid], 'as a callback: the index it is handed is no option');
  assert.equal(isPidAlive(process.pid, {}), true, 'options without startedAt change nothing');
  assert.equal(isPidAlive(process.pid, { sample: new Map() }), true, 'nor does a sample on its own');
});

test('isPidAlive with startedAt: alive AND started within ±2 s of it — from a sample, or read now', async () => {
  assert.equal(PROC_START_TOLERANCE_MS, 2000, 'the spec\'s ±2 s');
  const sample = await sampleProcs([process.pid], { timeoutMs: ROOMY });
  const start = sample.get(process.pid).startedAt;
  assert.ok(Number.isFinite(start), 'precondition: this process sampled');

  // Read now: no sample passed, so the start is read synchronously.
  const now = { timeoutMs: ROOMY };
  assert.equal(isPidAlive(process.pid, { startedAt: start, ...now }), true);
  assert.equal(isPidAlive(process.pid, { startedAt: start + 1500, ...now }), true, 'inside');
  assert.equal(isPidAlive(process.pid, { startedAt: start - 2000, ...now }), true, 'the bound is inclusive');
  assert.equal(isPidAlive(process.pid, { startedAt: start + 2500, ...now }), false, 'outside: someone else\'s process');
  assert.equal(isPidAlive(process.pid, { startedAt: start - 3_600_000, ...now }), false);
  assert.equal(isPidAlive(process.pid, { startedAt: formatProcStart(start), ...now }), true, 'a procStart string is read with parseProcStart');
  assert.equal(isPidAlive(process.pid, { startedAt: formatProcStart(start + 10_000), ...now }), false);

  // From the sample: nothing spawned.
  assert.equal(isPidAlive(process.pid, { startedAt: start + 1999, sample }), true);
  assert.equal(isPidAlive(process.pid, { startedAt: start - 2001, sample }), false);
  assert.equal(isPidAlive(process.pid, { startedAt: start, sample: sample.get(process.pid) }), true, 'one entry of it works too');

  // Kill 0 comes first: a dead pid is false whatever start is claimed.
  const dead = await deadPid();
  assert.equal(isPidAlive(dead, { startedAt: start, ...now }), false);
  assert.equal(isPidAlive(dead, { startedAt: start, sample: { alive: true, startedAt: start, cpuMs: 0, state: 'S' } }), false, 'a stale sample cannot revive it');
});

test('isPidAlive with startedAt answers null — no verdict — when the start cannot be read', () => {
  const start = Date.UTC(2026, 9, 2, 8, 50, 32);
  const failed = new Map([[process.pid, { ...NONE }]]);
  assert.equal(isPidAlive(process.pid, { startedAt: start, sample: failed }), null, 'a failed sample');
  assert.equal(isPidAlive(process.pid, { startedAt: start, sample: new Map() }), null, 'a sample without this pid');
  assert.equal(isPidAlive(process.pid, { startedAt: start, sample: undefined }), null, 'a sample passed as nothing: still nothing spawned');
  assert.equal(isPidAlive(process.pid, { startedAt: start, sample: { alive: true, startedAt: null, cpuMs: 1, state: 'S' } }), null, 'listed, its start unreadable');
  assert.equal(isPidAlive(process.pid, { startedAt: 'Fr.  2 Okt. 08:52:47 2026', sample: new Map([[process.pid, { alive: true, startedAt: start, cpuMs: 1, state: 'S' }]]) }), null,
    'a procStart this cannot read (another locale) is no verdict, never a different process');
  assert.equal(isPidAlive(process.pid, { startedAt: NaN, sample: failed }), null);
  assert.equal(isPidAlive(process.pid, { startedAt: start, sample: new Map([[process.pid, { ...GONE }]]) }), false,
    'a verdict that the pid was empty: whatever answers to it now is not the process that started then');
});

// ─────────────────────────────────────────────── processCommand ────

test('processCommand: this process\'s command line; null for a dead pid or anything that is not one', async () => {
  const cmd = processCommand(process.pid);
  assert.equal(typeof cmd, 'string');
  assert.ok(cmd.startsWith(process.argv0), `the argv as exec'd, from argv[0]: ${cmd}`);
  if (process.argv[1] && path.basename(process.argv[1]) === path.basename(__filename)) {
    assert.ok(cmd.includes(path.basename(__filename)), `the test file this process runs is on it: ${cmd}`);
  }
  assert.equal(processCommand(await deadPid()), null);
  for (const bad of [0, -1, 1.5, NaN, null, undefined, `${process.pid}`, `${process.pid},1`, '-A']) {
    assert.equal(processCommand(bad), null, `${String(bad)}: one positive integer pid, never a list or an option`);
  }
  assert.equal(cloudflared.commandOf, processCommand, 'the tunnel\'s pid-reuse check reads the same function');
});
