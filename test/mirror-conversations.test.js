// The conversation registry (lib/server/mirror/conversations.js, spec §2.2) and
// the sessions-file watch it drives (lib/server/mirror/claude-state.js, §2.6).
//
// Pinned:
//   * acceptance: a hook envelope counts only when its cwd belongs to this
//     project (a nested project's sessions are the nested daemon's) and its
//     transcript_path passes lib/core/claude-files transcriptFile — else it is
//     ignored as foreign-root or bad-path, and nothing is made of it;
//   * discovery in order of authority: hooks, then a sessions file whose pid is
//     alive with a matching procStart (sampleProcs), then MCP presence rows
//     joined by pid, then the newest-file fallback, only with exactly one
//     recent transcript and dropped once a session is named;
//   * links: /clear by claude_pid and by a sessionId switch under one pid and
//     procStart (waiting for the SessionStart while hooks flow), the race where
//     the next prompt beats the SessionStart (the younger merges into the older),
//     resume (the conversation moves to the new process), fork (forked_from),
//     and formerNames linking a /clear missed while the daemon was down;
//   * SessionEnd never ends a conversation; a gone process does;
//   * conversations.json: written atomically, set aside when corrupt or invalid
//     and rebuilt by discovery, every field checked when read back, bounded to
//     200 by last activity, with a pruned conversation's index and diff files
//     deleted;
//   * the toggle: disabled stops the watches and ignores ingests, re-enabled
//     reloads and rediscovers; a disabled session is never linked;
//   * headless (sdk-cli) conversations are flagged; process.interrupt is the
//     MCP row's interrupt field, null when absent;
//   * no code path opens a sessions `.key` file.
//
// The Claude tier is a private fake (test-support/claude-home, isolate: true),
// HOME is a throwaway (withTempHome), the registry's own timers run on an
// injected clock, and process start times are real: sampleProcs([pid]) of this
// process and of idle child processes, fed back through an injected sampler so
// that one `ps` per pid serves the whole file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome, FAKE_PEER_KEY } = require('../test-support/claude-home');
const { withTempHome, waitUntil } = require('../test-support/helpers');
const portfiles = require('../lib/core/portfiles');
const registry = require('../lib/util/registry');
const { projectPaths, userPaths, userClaudePaths } = require('../lib/core/paths');
const {
  createConversations, CONVERSATIONS_MAX, FALLBACK_WINDOW_MS, CLEAR_GRACE_MS, DISCOVERY_MS, REASONS, LINKED_BY, CHANGES,
} = require('../lib/server/mirror/conversations');
const { createClaudeState, ACTIVE_POLL_MS, IDLE_POLL_MS } = require('../lib/server/mirror/claude-state');
const live = require('../lib/server/mirror/live');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const S4 = '44444444-4444-4444-8444-444444444444';
const S5 = '55555555-5555-4555-8555-555555555555';
const DEAD_PID = 2 ** 30; // never a process: kill 0 says ESRCH

// ── fixtures ─────────────────────────────────────────────────────────────────

function project(t, name = 'p') {
  const dir = fs.mkdtempSync(path.join(SANDBOX, `wc-conv-${name}-`));
  fs.mkdirSync(path.join(dir, '.web-chat'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir; // as the OS tmp spells it: through /var on macOS, which is /private/var
}

// An idle process to stand in for a second Claude Code.
function bystander(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  return child.pid;
}

// Real start times, one sample per pid for the whole file.
const samples = new Map(); // pid → { entry, procStart }
async function liveStart(pid) {
  if (samples.has(pid)) return samples.get(pid).procStart;
  const entry = await waitUntil(async () => {
    const got = (await portfiles.sampleProcs([pid])).get(pid);
    return got && got.alive === true && Number.isFinite(got.startedAt) ? got : null;
  }, { timeout: 20000, interval: 200, what: `a verdict-bearing sample of pid ${pid}` });
  const procStart = portfiles.formatProcStart(entry.startedAt);
  samples.set(pid, { entry, procStart });
  return procStart;
}
// The procStart of a start an hour later: someone else's process on that pid.
const shifted = (procStart) => portfiles.formatProcStart(portfiles.parseProcStart(procStart) + 3600 * 1000);

// sampleProcs, answered from the real samples taken above.
function knownSampler() {
  const calls = [];
  const fn = async (pids) => {
    calls.push([...pids]);
    return new Map(pids.map((p) => [p, samples.has(p) ? samples.get(p).entry : { alive: false, startedAt: null, cpuMs: null, state: null }]));
  };
  fn.calls = calls;
  return fn;
}

// A watchFile stand-in for claude-state: records each watch, reads when told.
function fakeWatches() {
  const watches = [];
  function watchFile(file, onTrigger, opts) {
    const w = {
      file, opts, stopped: false,
      trigger: async (src = 'trigger') => { if (!w.stopped) await onTrigger(src); },
      stop: async () => { w.stopped = true; },
      retarget: async () => {},
      stats: {},
    };
    watches.push(w);
    return w;
  }
  return { watchFile, watches, active: () => watches.filter((w) => !w.stopped) };
}

// The injected clock the registry's timers run on; it starts at the wall clock
// so file times and record times stay comparable.
function fakeClock() {
  let t = Date.now();
  let seq = 0;
  const pending = new Map();
  return {
    now: () => t,
    tick(ms = 10) { t += ms; return t; },
    timers: {
      setTimeout(fn, ms) { seq += 1; pending.set(seq, { at: t + Math.max(0, Number(ms) || 0), fn }); return seq; },
      clearTimeout(id) { pending.delete(id); },
    },
    pendingDelays: () => [...pending.values()].map((p) => p.at - t).sort((a, b) => a - b),
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, p] of pending) if (p.at <= end && (!next || p.at < next[1].at)) next = [id, p];
        if (!next) break;
        pending.delete(next[0]);
        t = Math.max(t, next[1].at);
        next[1].fn();
        await new Promise((r) => setImmediate(r));
      }
      t = end;
      await new Promise((r) => setImmediate(r));
    },
  };
}

const redact = (s) => s.replace(/SECRET\w*/g, '[MASK]');

// A registry over a fresh project and a private Claude tier.
function setup(t, { root, options = {}, watch = fakeWatches(), home = true } = {}) {
  let reg = null;
  t.after(async () => { if (reg) await reg.stop(); }); // first registered, first run
  if (home) withTempHome(t);
  const dir = root || project(t);
  const ch = claudeHome(t, { root: dir, isolate: true });
  const clock = fakeClock();
  const seen = { events: [], transitions: [], states: [], toggles: [], logs: [] };
  const sampler = knownSampler();
  reg = createConversations({
    root: dir,
    now: clock.now,
    timers: clock.timers,
    log: (...a) => seen.logs.push(a.join(' ')),
    redact,
    onConversation: (ev) => seen.events.push(ev),
    transition: (x) => seen.transitions.push(x),
    onSessionState: (cid, rec) => seen.states.push({ cid, rec }),
    onToggle: (s) => seen.toggles.push(s),
    sampleProcs: sampler,
    watchFile: watch ? watch.watchFile : undefined,
    ...options,
  });
  const h = { root: dir, ch, clock, reg, seen, sampler, watch };
  h.env = (event, sid, extra = {}) => ({
    v: 1, event, ts: clock.tick(), session_id: sid, transcript_path: ch.transcript(sid), cwd: ch.cwd,
    prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
    result: null, session: null, compact: null, stop: null, prompt: null, ask: null, ...extra,
  });
  h.start = (sid, pid, source = 'startup', extra = {}) => reg.ingest(h.env('SessionStart', sid, { claude_pid: pid, session: { source }, ...extra }));
  h.end = (sid, pid, reason = 'other') => reg.ingest(h.env('SessionEnd', sid, { claude_pid: pid, session: { reason } }));
  h.prompt = (sid, pid) => reg.ingest(h.env('UserPromptSubmit', sid, { claude_pid: pid, prompt: { author: 'user', text: 'hi' } }));
  h.tool = (sid, pid, extra = {}) => reg.ingest(h.env('PreToolUse', sid, { claude_pid: pid, ...extra }));
  h.changes = () => h.seen.events.map((e) => `${e.change}:${e.conversation.id}`);
  h.file = () => projectPaths(dir).mirrorConversations;
  h.saved = () => JSON.parse(fs.readFileSync(h.file(), 'utf8'));
  return h;
}

const ids = (list) => list.map((c) => c.id).sort();
const sessionIds = (c) => c.sessions.map((s) => s.session_id);

// ── acceptance ───────────────────────────────────────────────────────────────

test('a hook envelope opens a conversation; foreign-root, bad-path and malformed envelopes are ignored', async (t) => {
  const h = setup(t);
  const { reg, ch } = h;
  await reg.start();

  assert.deepEqual(h.start(S1, 4242), { ok: true, conversation_id: S1, session_id: S1 });
  const c = reg.get(S1);
  assert.equal(c.id, S1);
  assert.equal(c.current_session_id, S1);
  assert.deepEqual(sessionIds(c), [S1]);
  assert.equal(c.sessions[0].reason, 'start');
  assert.equal(c.process.pid, 4242);
  assert.equal(c.process.linked_by, 'hook');
  assert.equal(c.process.interrupt, null);
  assert.equal(c.process.mod, false);
  assert.equal(c.headless, false);
  assert.equal(c.ended_at, null);
  assert.equal(h.seen.events[0].change, 'added');
  assert.deepEqual(h.seen.transitions[0], { kind: 'mirror', op: 'conversation', conversation_id: S1, change: 'added' });
  assert.equal(reg.bySession(S1).id, S1);
  assert.equal(reg.transcriptPath(S1), ch.transcript(S1), 'the fenced path, though the file does not exist yet (V3)');
  assert.equal(reg.sessionDir(S1), path.join(ch.projectDir, S1));

  // A subdirectory with no .web-chat/ of its own belongs to this project.
  fs.mkdirSync(path.join(h.root, 'src', 'deep'), { recursive: true });
  assert.equal(reg.ingest(h.env('PreToolUse', S1, { cwd: path.join(ch.cwd, 'src', 'deep') })).ok, true);

  // Another project, a nested one, and cwds that are no absolute path.
  const other = fs.realpathSync(project(t, 'other'));
  const nested = path.join(ch.cwd, 'nested');
  fs.mkdirSync(path.join(nested, '.web-chat'), { recursive: true });
  for (const cwd of [other, nested, path.join(nested, 'x'), 'relative/dir', '', 42, null, undefined]) {
    assert.deepEqual(reg.ingest(h.env('SessionStart', S2, { cwd, session: { source: 'startup' } })), { ok: false, ignored: 'foreign-root' }, String(cwd));
  }

  // Transcript paths the fence refuses, or that are another session's.
  const outside = path.join(SANDBOX, `${S2}.jsonl`);
  const linkTarget = path.join(SANDBOX, 'not-a-transcript.jsonl');
  fs.writeFileSync(linkTarget, '{}\n');
  t.after(() => fs.rmSync(linkTarget, { force: true }));
  const link = path.join(ch.projectDir, `${S5}.jsonl`);
  fs.symlinkSync(linkTarget, link);
  for (const [sid, tp] of [
    [S2, outside],
    [S2, `${S2}.jsonl`],
    [S2, path.join(ch.projectDir, 'sub', `${S2}.jsonl`)],
    [S2, path.join(ch.projectDir, `${S2}.json`)],
    [S2, ch.transcript(S3)],
    [S2, `${ch.projectDir}/../${path.basename(ch.projectDir)}/${S2}.jsonl`],
    [S2, null],
    [S5, link],
  ]) {
    assert.deepEqual(reg.ingest(h.env('SessionStart', sid, { transcript_path: tp, session: { source: 'startup' } })), { ok: false, ignored: 'bad-path' }, String(tp));
  }

  // Not an envelope, or no session id that can name a file.
  for (const e of [null, [], 'SessionStart', { ...h.env('SessionStart', S2), session_id: '../x' }, { ...h.env('SessionStart', S2), session_id: '' },
    { ...h.env('SessionStart', S2), session_id: '_leading' }]) {
    assert.deepEqual(reg.ingest(e), { ok: false, ignored: 'bad-envelope' });
  }

  assert.deepEqual(ids(reg.list()), [S1], 'nothing was made of any ignored envelope');
  const { ignored } = reg.stats();
  assert.equal(ignored['foreign-root'], 8);
  assert.equal(ignored['bad-path'], 8);
  assert.equal(ignored['bad-envelope'], 6);
});

test('the daemon\'s root and Claude Code\'s physical cwd are compared by realpath', { skip: process.platform !== 'darwin' && 'macOS /var is a link' }, async (t) => {
  const h = setup(t);
  assert.notEqual(h.root, h.ch.cwd, 'the daemon holds /var/…, Claude Code records /private/var/…');
  await h.reg.start();
  assert.equal(h.start(S1, 4242).ok, true);
});

test('the sessions file is a candidate only while its pid is alive with a matching procStart', async (t) => {
  const P1 = process.pid;
  const [P2, P3, P4, P5] = [bystander(t), bystander(t), bystander(t), bystander(t)];
  const h = setup(t);
  const { ch, reg } = h;
  const [st1, st2, st3, st4] = [await liveStart(P1), await liveStart(P2), await liveStart(P3), await liveStart(P4)];
  await liveStart(P5);
  const elsewhere = fs.realpathSync(project(t, 'elsewhere'));
  const nested = path.join(ch.cwd, 'nested');
  fs.mkdirSync(path.join(nested, '.web-chat'), { recursive: true });

  ch.writeSession({ pid: P1, procStart: st1, sessionId: S1, name: 'a SECRET_NAME here' }); // the candidate
  ch.writeSession({ pid: P2, procStart: shifted(st2), sessionId: S2 }); // the pid holds another process now
  ch.writeSession({ pid: DEAD_PID, procStart: st1, sessionId: S3 }); // gone
  ch.writeSession({ pid: P3, procStart: st3, sessionId: S4, cwd: elsewhere }); // another project's
  ch.writeSession({ pid: P4, procStart: st4, sessionId: S5, cwd: nested }); // the nested project's
  ch.writeSession({ pid: P5, procStart: 'Fr Okt  2 04:22:15 2026', sessionId: '66666666-6666-4666-8666-666666666666' }); // no verdict

  await reg.start();
  assert.deepEqual(ids(reg.list()), [S1]);
  const c = reg.get(S1);
  assert.deepEqual(c.process, {
    pid: P1, proc_start: st1, kind: 'interactive', entrypoint: 'cli', cc_version: '2.1.287',
    linked_by: 'sessions-file', interrupt: null, mod: false,
  });
  assert.equal(c.name, 'a [MASK] here', 'the sessions file\'s name, redacted');
  assert.equal(c.current_session_id, S1);
  // One sample, for the pids whose cwd is here; never another project's.
  assert.equal(h.sampler.calls.length, 1);
  assert.deepEqual(h.sampler.calls[0].sort((a, b) => a - b), [P1, P2, P5, DEAD_PID].sort((a, b) => a - b));

  // A pid already linked as itself is not sampled again.
  await reg.discover();
  assert.equal(h.sampler.calls.length, 2);
  assert.ok(!h.sampler.calls[1].includes(P1));
});

test('an MCP presence row joins a sessions file by pid and vouches for it', async (t) => {
  const P1 = process.pid;
  const [MCP, P5] = [bystander(t), bystander(t)];
  const h = setup(t);
  const { ch, reg } = h;
  const st1 = await liveStart(P1);
  await liveStart(MCP);
  const elsewhere = fs.realpathSync(project(t, 'elsewhere'));
  // Its cwd lies outside the project, but this project's MCP server is its child.
  ch.writeSession({ pid: P1, procStart: st1, sessionId: S1, cwd: elsewhere });
  // A procStart nobody can check: only a row can vouch for it.
  ch.writeSession({ pid: P5, procStart: 'Fr Okt  2 04:22:15 2026', sessionId: S2 });
  await reg.start();
  assert.deepEqual(ids(reg.list()), [], 'without a row neither is this project\'s');

  ch.addMcp({ pid: MCP, ppid: P1, root: ch.cwd });
  await reg.discover();
  assert.deepEqual(ids(reg.list()), [S1]);
  assert.equal(reg.get(S1).process.linked_by, 'mcp');

  registry.deregisterMcp({ pid: MCP });
  ch.addMcp({ pid: process.pid, ppid: P5, root: ch.cwd });
  await reg.discover();
  assert.deepEqual(ids(reg.list()), [S1, S2]);
  assert.equal(reg.get(S2).process.linked_by, 'mcp');
  assert.equal(reg.get(S2).process.proc_start, 'Fr Okt  2 04:22:15 2026');
});

test('process.interrupt is the MCP row\'s interrupt field, null when absent', async (t) => {
  const P1 = process.pid;
  const MCP = bystander(t);
  const h = setup(t);
  const { ch, reg } = h;
  ch.writeSession({ pid: P1, procStart: await liveStart(P1), sessionId: S1 });
  await reg.start();
  assert.equal(reg.get(S1).process.interrupt, null, 'no row');

  ch.addMcp({ pid: MCP, ppid: P1, root: ch.cwd, interrupt: 'tty' });
  await reg.discover();
  assert.equal(reg.get(S1).process.interrupt, 'tty');
  assert.equal(reg.processOf(S1).interrupt, 'tty');
  const updated = h.seen.events.filter((e) => e.change === 'updated' && e.conversation.id === S1);
  assert.equal(updated[updated.length - 1].conversation.process.interrupt, 'tty');

  registry.updateMcp(MCP, { interrupt: null });
  await reg.discover();
  assert.equal(reg.get(S1).process.interrupt, null, 'the row says null');

  registry.updateMcp(MCP, { interrupt: 'tty' });
  await reg.discover();
  assert.equal(reg.get(S1).process.interrupt, 'tty');

  ch.removeMcp(MCP);
  await reg.discover();
  assert.equal(reg.get(S1).process.interrupt, null, 'the row is gone');
  assert.ok(!h.seen.transitions.some((x) => x.change === 'updated'));
});

test('a hook outranks the sessions file, which fills in what the hook does not carry', async (t) => {
  const P1 = process.pid;
  const h = setup(t);
  const { ch, reg } = h;
  await reg.start();
  h.start(S1, P1);
  assert.equal(reg.get(S1).process.proc_start, null);
  ch.writeSession({ pid: P1, procStart: await liveStart(P1), sessionId: S1, kind: 'bg', version: '2.1.290' });
  await reg.discover();
  const p = reg.get(S1).process;
  assert.equal(p.linked_by, 'hook');
  assert.equal(p.proc_start, samples.get(P1).procStart);
  assert.equal(p.kind, 'bg');
  assert.equal(p.cc_version, '2.1.290');
  assert.equal(h.sampler.calls.length, 0, 'a process already linked is not sampled');
});

test('nested-project sessions are left to the nested daemon', async (t) => {
  const P1 = process.pid;
  const MCP = bystander(t);
  const h = setup(t);
  const { ch, reg } = h;
  const nested = path.join(ch.cwd, 'nested');
  fs.mkdirSync(path.join(nested, '.web-chat'), { recursive: true });
  const st1 = await liveStart(P1);
  ch.writeSession({ pid: P1, procStart: st1, sessionId: S1, cwd: nested });
  ch.addMcp({ pid: MCP, ppid: P1, root: nested });
  await reg.start();
  assert.deepEqual(ids(reg.list()), [], 'not the outer project\'s');
  assert.deepEqual(reg.ingest(h.env('SessionStart', S1, { cwd: nested, claude_pid: P1, session: { source: 'startup' } })),
    { ok: false, ignored: 'foreign-root' });

  // The nested daemon takes it, by the sessions file and by the hook alike.
  const inner = createConversations({ root: nested, sampleProcs: knownSampler(), watchFile: fakeWatches().watchFile, redact, timers: h.clock.timers, now: h.clock.now });
  t.after(() => inner.stop());
  await inner.start();
  assert.deepEqual(ids(inner.list()), [S1]);
  assert.equal(inner.get(S1).process.linked_by, 'sessions-file');
  assert.equal(inner.ingest(h.env('PreToolUse', S1, { cwd: nested, claude_pid: P1 })).ok, true);
});

test('discovery with the real sampler: procStart from sampleProcs([process.pid])', async (t) => {
  const h = setup(t, { options: { sampleProcs: portfiles.sampleProcs } });
  const { ch, reg } = h;
  ch.writeSession({ pid: process.pid, procStart: await liveStart(process.pid), sessionId: S1 });
  ch.writeSession({ pid: DEAD_PID, procStart: samples.get(process.pid).procStart, sessionId: S2 });
  await reg.start();
  // A loaded machine can leave one `ps` without a verdict; a later tick decides.
  await waitUntil(async () => { await reg.discover(); return reg.get(S1); }, { timeout: 20000, interval: 200, what: 'the live session' });
  assert.deepEqual(ids(reg.list()), [S1]);
  assert.equal(reg.get(S1).process.linked_by, 'sessions-file');
});

// ── the newest-file fallback ────────────────────────────────────────────────

function transcript(h, sid, { ageMs = 0 } = {}) {
  h.ch.writeTranscript(sid, [{ type: 'user', sessionId: sid }]);
  if (ageMs) {
    const at = (Date.now() - ageMs) / 1000;
    fs.utimesSync(h.ch.transcript(sid), at, at);
  }
}

test('the newest-file fallback: exactly one recent transcript is provisional, dropped once another session is named', async (t) => {
  const h = setup(t);
  const { reg } = h;
  transcript(h, S1);
  transcript(h, S2, { ageMs: FALLBACK_WINDOW_MS + 60000 });
  await reg.start();
  const c = reg.get(S1);
  assert.ok(c, 'the one transcript that changed in the last two minutes');
  assert.equal(c.provisional, true);
  assert.equal(c.process, null);
  assert.equal(reg.stats().provisional, S1);
  await reg.flush();
  assert.deepEqual(h.saved().conversations, [], 'a guess is never persisted');

  // A hook names another session: the guess goes.
  h.start(S3, 4242);
  assert.equal(reg.get(S1), null);
  const removed = h.seen.events.find((e) => e.change === 'removed');
  assert.equal(removed.conversation.id, S1);
  assert.equal(removed.reason, 'fallback');
  assert.ok(h.seen.transitions.some((x) => x.change === 'removed' && x.conversation_id === S1));
  assert.deepEqual(ids(reg.list()), [S3]);
});

test('the newest-file fallback is kept when a hook names its own session', async (t) => {
  const h = setup(t);
  const { reg } = h;
  transcript(h, S1);
  await reg.start();
  assert.equal(reg.get(S1).provisional, true);
  h.prompt(S1, 4242);
  const c = reg.get(S1);
  assert.equal(c.provisional, undefined, 'no longer a guess');
  assert.equal(c.process.pid, 4242);
  await reg.flush();
  assert.deepEqual(h.saved().conversations.map((x) => x.id), [S1]);
});

test('the newest-file fallback is dropped once a sessions file names a session', async (t) => {
  const h = setup(t);
  const { ch, reg } = h;
  transcript(h, S1);
  await reg.start();
  assert.equal(reg.get(S1).provisional, true);
  ch.writeSession({ pid: process.pid, procStart: await liveStart(process.pid), sessionId: S2 });
  await reg.discover();
  assert.equal(reg.get(S1), null);
  assert.deepEqual(ids(reg.list()), [S2]);
});

test('no fallback with two recent transcripts, a recent hook, or a live sessions file', async (t) => {
  await t.test('two recent transcripts', async (t2) => {
    const h = setup(t2);
    transcript(h, S1);
    transcript(h, S2);
    await h.reg.start();
    assert.deepEqual(ids(h.reg.list()), []);
  });
  await t.test('a hook in the last two minutes', async (t2) => {
    const h = setup(t2);
    await h.reg.start();
    h.start(S3, 4242);
    transcript(h, S1);
    await h.reg.discover();
    assert.deepEqual(ids(h.reg.list()), [S3]);
    h.clock.tick(FALLBACK_WINDOW_MS + 1000);
    await h.reg.discover();
    assert.deepEqual(ids(h.reg.list()), [S3], 'S3\'s own transcript is not one of the recent files');
  });
  await t.test('a live sessions file', async (t2) => {
    const h = setup(t2);
    h.ch.writeSession({ pid: process.pid, procStart: await liveStart(process.pid), sessionId: S2 });
    transcript(h, S1);
    await h.reg.start();
    assert.deepEqual(ids(h.reg.list()), [S2]);
  });
});

// ── links ────────────────────────────────────────────────────────────────────

test('/clear linked by claude_pid: the new session joins the conversation, which goes on', async (t) => {
  const h = setup(t);
  const { reg } = h;
  await reg.start();
  h.start(S1, 4242);
  h.prompt(S1, 4242);
  h.end(S1, 4242, 'clear');
  const r = h.start(S2, 4242, 'clear');
  assert.equal(r.conversation_id, S1, 'routed to the conversation, not a new one');
  const c = reg.get(S1);
  assert.deepEqual(sessionIds(c), [S1, S2]);
  assert.deepEqual(c.sessions.map((s) => s.reason), ['start', 'clear']);
  assert.ok(Number.isFinite(c.sessions[0].ended_at), 'the old session is over');
  assert.equal(c.sessions[1].ended_at, undefined);
  assert.equal(c.current_session_id, S2);
  assert.equal(c.ended_at, null, 'the conversation is not');
  assert.equal(reg.bySession(S2).id, S1);
  assert.deepEqual(ids(reg.list()), [S1]);
  const linked = h.seen.events.find((e) => e.change === 'linked');
  assert.equal(linked.session_id, S2);
  assert.equal(linked.previous_session_id, S1, 'the session whose file is drained first');
  assert.equal(linked.reason, 'clear');
  assert.ok(h.seen.transitions.some((x) => x.change === 'linked' && x.conversation_id === S1));
  assert.equal(reg.transcriptPath(S1), h.ch.transcript(S1), 'the old session is still read');
});

test('/clear when the next prompt beats the SessionStart: the younger merges into the older', async (t) => {
  const h = setup(t);
  const { reg } = h;
  await reg.start();
  h.start(S1, 4242);
  const startTs = h.clock.tick();
  h.prompt(S2, 4242); // the sync prompt hook lands first
  assert.deepEqual(ids(reg.list()), [S1, S2]);
  // The async SessionStart(clear) arrives late, stamped before the prompt.
  const r = reg.ingest({ ...h.env('SessionStart', S2, { claude_pid: 4242, session: { source: 'clear' } }), ts: startTs });
  assert.equal(r.conversation_id, S1);
  assert.deepEqual(ids(reg.list()), [S1]);
  const c = reg.get(S1);
  assert.deepEqual(sessionIds(c), [S1, S2]);
  assert.equal(c.sessions[1].reason, 'clear');
  assert.equal(c.current_session_id, S2);
  const merged = h.seen.events.find((e) => e.change === 'merged');
  assert.equal(merged.conversation.id, S2);
  assert.equal(merged.merged_into, S1);
  assert.equal(merged.conversation.merged_into, S1, 'the view says so too (live.js drops it by that)');
  assert.ok(h.seen.transitions.some((x) => x.change === 'merged' && x.conversation_id === S2 && x.merged_into === S1));
  assert.equal(reg.get(S2).id, S1, 'a late caller with the old id finds the survivor');
  assert.equal(reg.bySession(S2).id, S1);
});

test('/clear linked by the sessions file switching sessionId under one pid and procStart', async (t) => {
  const P1 = process.pid;
  const h = setup(t);
  const { ch, reg, watch } = h;
  const st1 = await liveStart(P1);
  ch.writeSession({ pid: P1, procStart: st1, sessionId: S1 });
  await reg.start();
  await waitUntil(() => watch.active().length === 1, { what: 'the watch on the linked process' });
  const w = watch.active()[0];
  assert.equal(w.file, userClaudePaths().claudeSessionStateFile(P1));
  await w.trigger('start');

  // No hooks flow here: the switch is linked at once.
  ch.writeSession({ pid: P1, procStart: st1, sessionId: S2 });
  await w.trigger('file');
  const c = reg.get(S1);
  assert.deepEqual(sessionIds(c), [S1, S2]);
  assert.equal(c.sessions[1].reason, 'clear');
  assert.equal(c.current_session_id, S2);
  // The same switch, found by a discovery tick instead.
  ch.writeSession({ pid: P1, procStart: st1, sessionId: S3 });
  await reg.discover();
  assert.deepEqual(sessionIds(reg.get(S1)), [S1, S2, S3]);

  // A record from another process on the same pid is not this conversation's.
  ch.writeSession({ pid: P1, procStart: shifted(st1), sessionId: S4 });
  await w.trigger('file');
  assert.equal(reg.bySession(S4), null);
});

test('a sessionId switch while hooks flow waits for the SessionStart that says what it was', async (t) => {
  const P1 = process.pid;
  const h = setup(t);
  const { ch, reg, watch, clock } = h;
  const st1 = await liveStart(P1);
  ch.writeSession({ pid: P1, procStart: st1, sessionId: S1 });
  await reg.start();
  h.tool(S1, P1); // hooks flow for this conversation
  await waitUntil(() => watch.active().length === 1, { what: 'the watch' });
  const w = watch.active()[0];
  await w.trigger('start');

  // An in-place /fork: the file switches first, the SessionStart comes after.
  ch.writeSession({ pid: P1, procStart: st1, sessionId: S2 });
  await w.trigger('file');
  assert.equal(reg.bySession(S2), null, 'not taken for a /clear yet');
  assert.equal(reg.stats().pending_clears, 1);
  assert.ok(clock.pendingDelays().includes(CLEAR_GRACE_MS));
  h.start(S2, P1, 'fork');
  assert.equal(reg.get(S2).forked_from, S1, 'the hook said fork');
  assert.equal(reg.stats().pending_clears, 0);
  await clock.advance(CLEAR_GRACE_MS + 10);
  assert.deepEqual(sessionIds(reg.get(S1)), [S1], 'and nothing was linked when the grace ran out');

  // No SessionStart at all: after the grace it is a /clear.
  await waitUntil(() => watch.active().some((x) => x !== w), { what: 'the watch moving to the fork' });
  const w2 = watch.active().find((x) => x !== w);
  await w2.trigger('start');
  ch.writeSession({ pid: P1, procStart: st1, sessionId: S3 });
  await w2.trigger('file');
  assert.equal(reg.bySession(S3), null);
  await clock.advance(CLEAR_GRACE_MS + 10);
  assert.equal(reg.bySession(S3).id, S2);
  assert.equal(reg.get(S2).current_session_id, S3);
});

test('resume moves a conversation to the new process, and revives it', async (t) => {
  const h = setup(t);
  const { reg } = h;
  await reg.start();
  h.start(S1, 7001);
  h.prompt(S1, 7001);
  assert.equal(reg.processGone(S1, { pid: 7001, at: h.clock.tick() }), true);
  assert.ok(Number.isFinite(reg.get(S1).ended_at));
  assert.equal(reg.get(S1).process, null, 'an ended conversation has no process');

  h.clock.tick(5000);
  h.start(S1, 7002, 'resume');
  const c = reg.get(S1);
  assert.equal(c.process.pid, 7002);
  assert.equal(c.ended_at, null);
  assert.equal(c.sessions[0].ended_at, undefined, 'its session is being written again');
  assert.equal(reg.conversationOfPid(7002), S1);
  assert.equal(reg.conversationOfPid(7001), null);
  const linked = h.seen.events.filter((e) => e.change === 'linked').pop();
  assert.equal(linked.reason, 'resume');

  assert.equal(reg.processGone(S1, { pid: 7001 }), false, 'a verdict on the process it left changes nothing');
  assert.equal(reg.get(S1).ended_at, null);
  assert.equal(reg.processGone(S1, { pid: 7002, at: h.clock.tick() }), true);
});

test('an in-place /resume moves the process; the conversation it left keeps it as its last', async (t) => {
  const h = setup(t);
  const { reg } = h;
  await reg.start();
  h.start(S1, 7000);
  reg.processGone(S1, { pid: 7000, at: h.clock.tick() });
  h.start(S2, 7001);
  assert.equal(reg.conversationOfPid(7001), S2);

  h.end(S2, 7001, 'resume');
  h.start(S1, 7001, 'resume');
  assert.equal(reg.conversationOfPid(7001), S1);
  assert.equal(reg.get(S1).process.pid, 7001);
  assert.equal(reg.get(S1).ended_at, null);
  const left = reg.get(S2);
  assert.ok(Number.isFinite(left.sessions[0].ended_at));
  assert.equal(left.ended_at, null, 'its process is not gone');
  assert.equal(left.process.pid, 7001);

  // And back again (the TUI's /resume to the other conversation).
  h.start(S2, 7001, 'resume');
  assert.equal(reg.conversationOfPid(7001), S2);
  assert.ok(Number.isFinite(reg.get(S1).sessions[0].ended_at));

  // The process exits: both end.
  assert.equal(reg.processGone(S1, { pid: 7001, at: h.clock.tick() }), true);
  assert.equal(reg.processGone(S2, { pid: 7001, at: h.clock.tick() }), true);
});

test('a fork becomes its own conversation with forked_from', async (t) => {
  const h = setup(t);
  const { reg } = h;
  await reg.start();
  h.start(S1, 7001);
  // An in-place /fork: the process was writing S1.
  h.start(S2, 7001, 'fork');
  const f = reg.get(S2);
  assert.equal(f.forked_from, S1);
  assert.equal(f.sessions[0].reason, 'fork');
  assert.equal(reg.conversationOfPid(7001), S2);
  assert.ok(Number.isFinite(reg.get(S1).sessions[0].ended_at));
  assert.equal(h.seen.events.find((e) => e.change === 'added' && e.conversation.id === S2).conversation.forked_from, S1);

  // A fork from a new process names no source; the transcript's copied turns do.
  h.start(S3, 7009, 'fork');
  assert.equal(reg.get(S3).forked_from, null);
  assert.equal(reg.markFork(S3, { forked_from: S1 }), true);
  assert.equal(reg.get(S3).forked_from, S1);
  assert.equal(reg.markFork(S3, { forked_from: S2 }), false, 'once');
  assert.equal(reg.markFork(S3, { forked_from: S3 }), false);
  assert.equal(reg.markFork(S1, { forked_from: 'nope' }), false);
  await reg.flush();
  assert.equal(h.saved().conversations.find((c) => c.id === S3).forked_from, S1);
});

function storedConversation(id, { sessions = [id], process = null, ended_at = null, last_activity_at, title = null } = {}) {
  const at = last_activity_at || Date.now() - 60000;
  return {
    id, created_at: at - 1000, last_activity_at: at, ended_at, title, name: null, forked_from: null,
    current_session_id: sessions[sessions.length - 1],
    sessions: sessions.map((s, i) => ({ session_id: s, slug: null, reason: i ? 'clear' : 'start', started_at: at - 1000 + i, ended_at: null })),
    process,
  };
}
function writeStored(h, list) {
  fs.mkdirSync(path.dirname(h.file()), { recursive: true });
  fs.writeFileSync(h.file(), JSON.stringify({ v: 1, conversations: list }));
}

test('formerNames links a /clear missed while the daemon was down', async (t) => {
  const P1 = process.pid;
  const h = setup(t);
  const { ch, reg } = h;
  const st1 = await liveStart(P1);
  writeStored(h, [storedConversation(S1, { process: { pid: P1, proc_start: st1, kind: 'interactive', entrypoint: 'cli', linked_by: 'hook', linked_at: Date.now() - 60000 } })]);
  transcript(h, S2); // the intermediate session's file: it is shown too
  ch.writeSession({ pid: P1, procStart: st1, sessionId: S3, formerNames: [{ sessionId: S1 }, { sessionId: S2 }] });
  await reg.start();
  assert.deepEqual(ids(reg.list()), [S1]);
  const c = reg.get(S1);
  assert.deepEqual(sessionIds(c), [S1, S2, S3]);
  assert.deepEqual(c.sessions.map((s) => s.reason), ['start', 'clear', 'clear']);
  assert.equal(c.current_session_id, S3);
  assert.equal(h.seen.events[0].change, 'added');
  assert.equal(h.seen.events[0].restored, true);
});

test('at boot a live pid and procStart matching a stored process is relinked, a /clear included', async (t) => {
  const P1 = process.pid;
  await t.test('the same session', async (t2) => {
    const h = setup(t2);
    const st1 = await liveStart(P1);
    writeStored(h, [storedConversation(S1, { process: { pid: P1, proc_start: st1, linked_by: 'hook', linked_at: Date.now() - 60000 } })]);
    h.ch.writeSession({ pid: P1, procStart: st1, sessionId: S1 });
    await h.reg.start();
    assert.deepEqual(sessionIds(h.reg.get(S1)), [S1]);
    assert.equal(h.reg.get(S1).process.pid, P1);
  });
  await t.test('an unknown session under the same pid and procStart: a missed /clear', async (t2) => {
    const h = setup(t2);
    const st1 = await liveStart(P1);
    writeStored(h, [storedConversation(S1, { process: { pid: P1, proc_start: st1, linked_by: 'hook', linked_at: Date.now() - 60000 } })]);
    h.ch.writeSession({ pid: P1, procStart: st1, sessionId: S3 });
    await h.reg.start();
    assert.deepEqual(sessionIds(h.reg.get(S1)), [S1, S3]);
  });
  await t.test('the same pid with another start is another process', async (t2) => {
    const h = setup(t2);
    const st1 = await liveStart(P1);
    writeStored(h, [storedConversation(S1, { process: { pid: P1, proc_start: shifted(st1), linked_by: 'hook', linked_at: Date.now() - 60000 } })]);
    h.ch.writeSession({ pid: P1, procStart: st1, sessionId: S3 });
    await h.reg.start();
    assert.deepEqual(ids(h.reg.list()), [S1, S3]);
    assert.deepEqual(sessionIds(h.reg.get(S1)), [S1]);
  });
});

test('a link found later merges the younger conversation into the older', async (t) => {
  const P1 = process.pid;
  const h = setup(t);
  const { ch, reg } = h;
  await reg.start();
  h.start(S1, P1);
  h.clock.tick(1000);
  reg.ingest(h.env('UserPromptSubmit', S2, { claude_pid: null })); // no CLAUDE_PID: nothing links it yet
  assert.deepEqual(ids(reg.list()), [S1, S2]);
  ch.writeSession({ pid: P1, procStart: await liveStart(P1), sessionId: S2, formerNames: [{ sessionId: S1 }] });
  await reg.discover();
  assert.deepEqual(ids(reg.list()), [S1]);
  assert.deepEqual(sessionIds(reg.get(S1)), [S1, S2]);
  assert.equal(reg.get(S1).current_session_id, S2);
  const merged = h.seen.events.find((e) => e.change === 'merged');
  assert.equal(merged.conversation.id, S2);
  assert.equal(merged.merged_into, S1);
});

test('a sessions file that has not caught up with a hook never moves a conversation back', async (t) => {
  const P1 = process.pid;
  const h = setup(t);
  const { ch, reg } = h;
  const st1 = await liveStart(P1);
  await reg.start();
  h.start(S1, P1);
  // The file, written before the /clear the hooks are about to report.
  ch.writeSession({ pid: P1, procStart: st1, sessionId: S1, updatedAt: h.clock.now() - 60000 });
  await reg.discover();
  h.end(S1, P1, 'clear');
  h.start(S2, P1, 'clear');
  assert.equal(reg.get(S1).current_session_id, S2);
  await reg.discover();
  assert.equal(reg.get(S1).current_session_id, S2, 'a record dated before the switch');
  ch.writeSession({ pid: P1, procStart: st1, sessionId: S1, updatedAt: undefined, statusUpdatedAt: undefined });
  await reg.discover();
  assert.equal(reg.get(S1).current_session_id, S2, 'a record with no date at all');

  // Nor back to the conversation a hook moved the process away from.
  reg.ingest(h.env('SessionStart', S3, { claude_pid: 9999, session: { source: 'startup' } }));
  reg.processGone(S3, { pid: 9999, at: h.clock.tick() });
  h.clock.tick(1000);
  h.start(S3, P1, 'resume');
  assert.equal(reg.conversationOfPid(P1), S3);
  ch.writeSession({ pid: P1, procStart: st1, sessionId: S2, updatedAt: h.clock.now() - 500 });
  await reg.discover();
  assert.equal(reg.conversationOfPid(P1), S3);
  assert.equal(reg.get(S3).sessions[0].ended_at, undefined, 'the session the process writes is not ended by an old record');
  assert.ok(Number.isFinite(reg.get(S1).sessions.find((s) => s.session_id === S2).ended_at));
  // A newer one does move it: an in-place /resume the hooks did not report.
  ch.writeSession({ pid: P1, procStart: st1, sessionId: S2, updatedAt: h.clock.tick(1000) });
  await reg.discover();
  assert.equal(reg.conversationOfPid(P1), S1);
  assert.equal(reg.get(S1).current_session_id, S2);
});

test('a presence row never vouches for a sessions file another process wrote', async (t) => {
  const [MCP, P2] = [bystander(t), bystander(t)];
  const h = setup(t);
  const { ch, reg } = h;
  await liveStart(MCP);
  const st2 = await liveStart(P2);
  ch.addMcp({ pid: MCP, ppid: P2, root: ch.cwd });
  // A file left by an earlier process that held P2's pid: its start is not P2's.
  ch.writeSession({ pid: P2, procStart: shifted(st2), sessionId: S2 });
  await reg.start();
  assert.deepEqual(ids(reg.list()), []);
  ch.writeSession({ pid: P2, procStart: st2, sessionId: S2 });
  await reg.discover();
  assert.deepEqual(ids(reg.list()), [S2]);
});

// ── ending ───────────────────────────────────────────────────────────────────

test('SessionEnd never ends a conversation; a gone process does', async (t) => {
  const h = setup(t);
  const { reg } = h;
  await reg.start();
  h.start(S1, 7001);
  for (const reason of ['clear', 'resume', 'other', 'prompt_input_exit', 'logout']) {
    h.end(S1, 7001, reason);
    assert.equal(reg.get(S1).ended_at, null, reason);
  }
  assert.ok(Number.isFinite(reg.get(S1).sessions[0].ended_at), 'the session is marked ended');
  assert.ok(!h.seen.events.some((e) => e.change === 'ended'));

  // A SessionEnd stamped before the session's newest SessionStart is stale.
  h.start(S2, 7002);
  const before = h.clock.now();
  h.start(S2, 7002, 'resume');
  reg.ingest({ ...h.env('SessionEnd', S2, { claude_pid: 7002, session: { reason: 'other' } }), ts: before - 1 });
  assert.equal(reg.get(S2).sessions[0].ended_at, undefined);

  const at = h.clock.tick();
  assert.equal(reg.processGone(S1, { pid: 7001, at }), true);
  const c = reg.get(S1);
  assert.equal(c.ended_at, at);
  assert.equal(c.process, null);
  const ended = h.seen.events.find((e) => e.change === 'ended');
  assert.equal(ended.conversation.id, S1);
  assert.equal(ended.at, at);
  assert.ok(h.seen.transitions.some((x) => x.change === 'ended' && x.conversation_id === S1));
  assert.equal(reg.processGone(S1, { pid: 7001 }), false, 'once');
  assert.equal(reg.processGone('nope', {}), false);

  // A late envelope from the dead process (its hook ran before the verdict)
  // revives nothing.
  reg.ingest({ ...h.env('PostToolUse', S1, { claude_pid: 7001 }), ts: at - 100 });
  assert.equal(reg.get(S1).ended_at, at);
  await reg.flush();
  assert.equal(h.saved().conversations.find((x) => x.id === S1).ended_at, at);

  // A conversation no process is known for cannot be proven gone.
  reg.ingest(h.env('SessionStart', S3, { claude_pid: null, session: { source: 'startup' } }));
  h.end(S3, null, 'other');
  assert.equal(reg.processGone(S3, {}), false);
  assert.equal(reg.get(S3).ended_at, null);
});

// ── persistence ──────────────────────────────────────────────────────────────

test('conversations.json is written atomically, in the shape of spec §2.2', async (t) => {
  const h = setup(t);
  const { reg } = h;
  await reg.start();
  const renames = [];
  const directWrites = [];
  const { renameSync, writeFileSync } = fs;
  fs.renameSync = function watched(from, to, ...rest) { renames.push([String(from), String(to)]); return renameSync.call(this, from, to, ...rest); };
  fs.writeFileSync = function watched(p, ...rest) { if (typeof p === 'string' && p === h.file()) directWrites.push(p); return writeFileSync.call(this, p, ...rest); };
  try {
    h.start(S1, 7001, 'startup', { entrypoint: 'sdk-cli' });
    h.start(S2, 7001, 'clear', { entrypoint: 'sdk-cli' });
    await reg.flush();
  } finally {
    fs.renameSync = renameSync;
    fs.writeFileSync = writeFileSync;
  }
  assert.deepEqual(directWrites, [], 'never written in place');
  const onto = renames.filter(([, to]) => to === h.file());
  assert.ok(onto.length >= 1, 'renamed onto it');
  for (const [from] of onto) assert.equal(path.dirname(from), path.dirname(h.file()), 'from a sibling temp file');
  assert.deepEqual(fs.readdirSync(path.dirname(h.file())).filter((f) => f.includes('.tmp')), [], 'no temp file left');

  const saved = h.saved();
  assert.equal(saved.v, 1);
  assert.equal(saved.conversations.length, 1);
  const c = saved.conversations[0];
  for (const k of ['id', 'created_at', 'last_activity_at', 'ended_at', 'title', 'forked_from', 'sessions', 'process']) assert.ok(k in c, k);
  assert.equal(c.id, S1);
  assert.deepEqual(c.sessions.map((s) => [s.session_id, s.slug, s.reason]), [[S1, h.ch.slug, 'start'], [S2, h.ch.slug, 'clear']]);
  for (const s of c.sessions) for (const k of ['started_at', 'ended_at']) assert.ok(k in s);
  assert.equal(c.process.pid, 7001);
  assert.equal(c.process.entrypoint, 'sdk-cli');
  for (const k of ['proc_start', 'kind']) assert.ok(k in c.process, k);
});

test('a corrupt or invalid conversations.json is set aside and the registry rebuilt by discovery', async (t) => {
  for (const [body, tag] of [['{"v": 1, "conversations": [', 'corrupt'], ['{"v": 2, "conversations": []}', 'invalid'], ['[]', 'invalid']]) {
    await t.test(tag + ': ' + body, async (t2) => {
      const h = setup(t2);
      fs.mkdirSync(path.dirname(h.file()), { recursive: true });
      fs.writeFileSync(h.file(), body);
      h.ch.writeSession({ pid: process.pid, procStart: await liveStart(process.pid), sessionId: S1 });
      await h.reg.start();
      const aside = fs.readdirSync(path.dirname(h.file())).filter((f) => f.startsWith(`conversations.json.${tag}-`));
      assert.equal(aside.length, 1, 'kept aside, not deleted');
      assert.equal(fs.readFileSync(path.join(path.dirname(h.file()), aside[0]), 'utf8'), body);
      assert.deepEqual(ids(h.reg.list()), [S1], 'rebuilt by discovery');
      await h.reg.flush();
      assert.deepEqual(h.saved().conversations.map((c) => c.id), [S1], 'and written afresh');
    });
  }
});

test('every field of conversations.json is checked when it is read back', async (t) => {
  const h = setup(t);
  const good = storedConversation(S1, { process: { pid: 7001, proc_start: 'Fri Oct  2 04:22:15 2026', kind: 'interactive', entrypoint: 'cli', cc_version: '2.1.287', linked_by: 'hook', linked_at: 1 } });
  good.sessions[0].slug = h.ch.slug;
  writeStored(h, [
    good,
    { ...storedConversation(S2), sessions: [{ session_id: S2, slug: '../../etc', reason: 'evil', started_at: 'x' }] },
    { ...storedConversation(S3), sessions: [{ session_id: S1, slug: null, reason: 'start', started_at: 1 }] }, // S1 is taken
    { ...storedConversation('../escape') },
    { ...storedConversation(S4), forked_from: S4, title: 'x'.repeat(301), process: { pid: 'x' } },
    'not an object',
    null,
  ]);
  await h.reg.start();
  assert.deepEqual(ids(h.reg.list()), [S1, S2, S4]);
  assert.equal(h.reg.transcriptPath(S1), h.ch.transcript(S1));
  const bad = h.reg.get(S2);
  assert.equal(bad.sessions[0].reason, 'start');
  assert.equal(h.reg.transcriptPath(S2), null, 'a slug that is not one names no file');
  assert.equal(h.reg.sessionDir(S2), null);
  assert.equal(h.reg.get(S4).forked_from, null);
  assert.equal(h.reg.get(S4).title, undefined);
  assert.equal(h.reg.get(S4).process, null);
  assert.equal(h.reg.get(S1).process.proc_start, 'Fri Oct  2 04:22:15 2026');
  assert.ok(h.seen.events.every((e) => e.change === 'added' && e.restored === true));
});

test('conversations.json is bounded to 200 by last activity; a pruned one\'s index and diff files go', async (t) => {
  const h = setup(t);
  const p = projectPaths(h.root);
  const base = Date.now() - 10 * 24 * 3600 * 1000;
  const sid = (i) => `c${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`;
  const list = [];
  for (let i = 0; i < CONVERSATIONS_MAX + 5; i++) {
    list.push(storedConversation(sid(i), { ended_at: base + i, last_activity_at: base + i }));
  }
  // The newest has no process and an open session: not prunable first anyway.
  writeStored(h, list);
  const files = (i) => ({ index: p.mirrorIndex(sid(i)), diff: p.mirrorDiff(`turn-${i}`) });
  for (const i of [0, 4, 5]) {
    fs.mkdirSync(path.dirname(files(i).index), { recursive: true });
    fs.writeFileSync(files(i).index, JSON.stringify({ v: 1, session_id: sid(i), turns: [{ id: `turn-${i}` }, { id: '../escape' }, null] }));
    fs.mkdirSync(path.dirname(files(i).diff), { recursive: true });
    fs.writeFileSync(files(i).diff, '{}');
  }
  await h.reg.start();
  await h.reg.flush();
  assert.equal(h.reg.list().length, CONVERSATIONS_MAX);
  assert.equal(h.reg.get(sid(0)), null);
  assert.equal(h.reg.get(sid(4)), null);
  assert.ok(h.reg.get(sid(5)), 'the sixth oldest stays');
  for (const i of [0, 4]) {
    assert.equal(fs.existsSync(files(i).index), false, `index ${i} deleted`);
    assert.equal(fs.existsSync(files(i).diff), false, `diff ${i} deleted`);
  }
  assert.equal(fs.existsSync(files(5).index), true, 'a kept conversation\'s files stay');
  assert.equal(fs.existsSync(files(5).diff), true);
  assert.equal(h.saved().conversations.length, CONVERSATIONS_MAX);
  assert.ok(!h.seen.events.some((e) => e.change === 'removed'), 'never announced, so never removed');
});

test('at the bound, a new conversation prunes the least active one nobody writes', async (t) => {
  const h = setup(t, { options: { maxConversations: 3 } });
  const { reg } = h;
  const p = projectPaths(h.root);
  await reg.start();
  h.start(S1, 7001);
  h.start(S2, 7002);
  h.start(S3, 7003);
  reg.processGone(S2, { pid: 7002, at: h.clock.tick() }); // the one nobody writes
  h.tool(S1, 7001);
  for (const [sid, turn] of [[S2, 'turn-s2'], [S3, 'turn-s3']]) {
    fs.mkdirSync(path.dirname(p.mirrorIndex(sid)), { recursive: true });
    fs.writeFileSync(p.mirrorIndex(sid), JSON.stringify({ v: 1, turns: [{ id: turn }] }));
    fs.mkdirSync(path.dirname(p.mirrorDiff(turn)), { recursive: true });
    fs.writeFileSync(p.mirrorDiff(turn), '{}');
  }
  h.start(S4, 7004);
  assert.deepEqual(ids(reg.list()), [S1, S3, S4]);
  const removed = h.seen.events.find((e) => e.change === 'removed');
  assert.equal(removed.conversation.id, S2);
  assert.equal(removed.reason, 'pruned');
  assert.ok(h.seen.transitions.some((x) => x.change === 'removed' && x.conversation_id === S2));
  await reg.flush();
  assert.deepEqual(h.saved().conversations.map((c) => c.id).sort(), [S1, S3, S4].sort());
  assert.equal(fs.existsSync(p.mirrorIndex(S2)), false, 'the pruned one\'s index');
  assert.equal(fs.existsSync(p.mirrorDiff('turn-s2')), false, 'and its diffs');
  assert.equal(fs.existsSync(p.mirrorIndex(S3)), true);
  assert.equal(fs.existsSync(p.mirrorDiff('turn-s3')), true);
});

test('a repeated envelope changes nothing', async (t) => {
  const h = setup(t);
  const { reg } = h;
  await reg.start();
  h.start(S1, 7001);
  const clear = h.env('SessionStart', S2, { claude_pid: 7001, session: { source: 'clear' } });
  reg.ingest(clear);
  const strip = (list) => JSON.parse(JSON.stringify(list)).map((c) => { delete c.last_activity_at; return c; });
  const before = strip(reg.list());
  const events = h.seen.events.length;
  for (const e of [clear, { ...clear }, h.env('SessionStart', S1, { claude_pid: 7001, session: { source: 'compact' } })]) {
    assert.equal(reg.ingest(e).conversation_id, S1);
  }
  assert.equal(h.seen.events.length, events, 'no event');
  assert.deepEqual(strip(reg.list()), before, 'nothing but activity moved');
});

test('an envelope before start() is held to the toggle too', async (t) => {
  const h = setup(t);
  fs.writeFileSync(projectPaths(h.root).disabled, '');
  assert.deepEqual(h.start(S1, 7001), { ok: false, ignored: 'disabled' });
  assert.deepEqual(h.seen.toggles, [{ enabled: false, scope: 'project' }]);
  await h.reg.start();
  await h.reg.ready;
  assert.deepEqual(h.reg.list(), []);
  assert.equal(fs.existsSync(h.file()), false);
});

// ── the toggle ───────────────────────────────────────────────────────────────

test('the toggle disables tailing and rediscovery resumes when re-enabled', async (t) => {
  const P1 = process.pid;
  const h = setup(t);
  const { ch, reg, watch } = h;
  ch.writeSession({ pid: P1, procStart: await liveStart(P1), sessionId: S1 });
  await reg.start();
  assert.deepEqual(ids(reg.list()), [S1]);
  await waitUntil(() => watch.active().length === 1, { what: 'the watch' });

  const marker = projectPaths(h.root).disabled;
  fs.writeFileSync(marker, '');
  await reg.tick();
  assert.deepEqual(h.seen.toggles, [{ enabled: false, scope: 'project' }]);
  assert.deepEqual(reg.enabled(), { enabled: false, scope: 'project' });
  assert.equal(watch.active().length, 0, 'every watch stopped');
  assert.deepEqual(reg.list(), [], 'nothing in memory');
  assert.deepEqual(reg.ingest(h.env('SessionStart', S2, { claude_pid: 7002, session: { source: 'startup' } })), { ok: false, ignored: 'disabled' });
  assert.equal(reg.processGone(S1, {}), false);
  assert.deepEqual(h.saved().conversations.map((c) => c.id), [S1], 'the file is kept');
  const sampled = h.sampler.calls.length;
  await reg.tick();
  assert.equal(h.sampler.calls.length, sampled, 'no discovery while disabled');

  fs.rmSync(marker);
  const before = h.seen.events.length;
  await reg.tick();
  assert.deepEqual(h.seen.toggles[1], { enabled: true });
  const back = h.seen.events.slice(before);
  assert.equal(back[0].change, 'added');
  assert.equal(back[0].restored, true);
  assert.deepEqual(ids(reg.list()), [S1]);
  await waitUntil(() => watch.active().length === 1, { what: 'the watch again' });
  assert.equal(reg.ingest(h.env('SessionStart', S2, { claude_pid: 7002, session: { source: 'startup' } })).ok, true);
});

test('the user scope disables it too, from start', async (t) => {
  const h = setup(t);
  fs.mkdirSync(userPaths().root, { recursive: true });
  fs.writeFileSync(userPaths().disabled, '');
  h.ch.writeSession({ pid: process.pid, procStart: await liveStart(process.pid), sessionId: S1 });
  await h.reg.start();
  assert.deepEqual(h.seen.toggles, [{ enabled: false, scope: 'user' }]);
  assert.deepEqual(h.reg.list(), []);
  assert.equal(h.sampler.calls.length, 0);
  assert.equal(fs.existsSync(h.file()), false, 'nothing written');
  fs.rmSync(userPaths().disabled);
  await h.reg.tick();
  assert.deepEqual(ids(h.reg.list()), [S1]);
});

test('a session the session toggle disabled is never linked, by hook or by sessions file', async (t) => {
  const h = setup(t);
  fs.mkdirSync(path.dirname(userPaths().sessionFile(S2)), { recursive: true });
  fs.writeFileSync(userPaths().sessionFile(S2), JSON.stringify({ enabled: false }));
  h.ch.writeSession({ pid: process.pid, procStart: await liveStart(process.pid), sessionId: S2 });
  await h.reg.start();
  assert.deepEqual(h.reg.list(), []);
  assert.deepEqual(h.start(S2, 7002), { ok: false, ignored: 'session-disabled' });
  assert.equal(h.start(S1, 7001).ok, true);
});

// ── headless ─────────────────────────────────────────────────────────────────

test('headless (sdk-cli) conversations are flagged', async (t) => {
  const P1 = process.pid;
  const h = setup(t);
  await h.reg.start();
  h.start(S1, 7001, 'startup', { entrypoint: 'sdk-cli' });
  h.start(S2, 7002, 'startup', { entrypoint: 'cli' });
  assert.equal(h.reg.get(S1).headless, true);
  assert.equal(h.reg.get(S1).process.entrypoint, 'sdk-cli');
  assert.equal(h.reg.get(S2).headless, false);
  h.ch.writeSession({ pid: P1, procStart: await liveStart(P1), sessionId: S3, entrypoint: 'sdk-cli' });
  await h.reg.discover();
  assert.equal(h.reg.get(S3).headless, true);
  // Still flagged once it has ended (the switcher keeps it behind "headless").
  h.reg.processGone(S1, { pid: 7001, at: h.clock.tick() });
  assert.equal(h.reg.get(S1).headless, true);
});

// ── the sessions-file watch ──────────────────────────────────────────────────

test('claude-state watches each linked process\'s file, every 1 s while not idle and 5 s while idle', async (t) => {
  const ch = claudeHome(t, { root: project(t), isolate: true });
  ch.writeSession({ pid: 4242, procStart: null, sessionId: S1, status: 'busy' });
  const watch = fakeWatches();
  let state = 'working';
  const records = [];
  const cs = createClaudeState({ watchFile: watch.watchFile, stateOf: () => state, onRecord: (cid, pid, rec) => records.push({ cid, pid, rec }) });
  t.after(() => cs.stop());
  assert.equal(ACTIVE_POLL_MS, 1000);
  assert.equal(IDLE_POLL_MS, 5000);

  await cs.link('c1', 4242);
  assert.equal(watch.watches.length, 1);
  const w = watch.watches[0];
  assert.equal(w.file, path.join(ch.sessionsDir, '4242.json'));
  assert.equal(w.opts.pollMs, ACTIVE_POLL_MS);
  assert.ok(!w.opts.dirWatch, 'never a directory watch');
  assert.equal(records.length, 1, 'read at once');
  assert.equal(records[0].rec.status, 'busy');

  state = 'idle';
  await w.trigger('poll'); // the cadence is read after each read
  assert.equal(w.stopped, true);
  assert.equal(watch.active().length, 1);
  assert.equal(watch.active()[0].opts.pollMs, IDLE_POLL_MS);
  assert.equal(records.length, 1, 'an unchanged file is not handed on again');

  state = 'question';
  cs.retune();
  assert.equal(watch.active()[0].opts.pollMs, ACTIVE_POLL_MS);
  assert.deepEqual(cs.linked(), [{ cid: 'c1', pid: 4242, pollMs: ACTIVE_POLL_MS }]);

  await cs.unlink('c1');
  assert.equal(watch.active().length, 0);
  await cs.link('c1', 'x');
  await cs.link('c1', -1);
  assert.equal(watch.active().length, 0, 'only an integer pid names a file');
});

test('claude-state hands on each changed record, and null once the file is gone', async (t) => {
  const ch = claudeHome(t, { root: project(t), isolate: true });
  ch.writeSession({ pid: 4243, procStart: null, sessionId: S1, status: 'busy', startedAt: 1, updatedAt: 1, statusUpdatedAt: 1 });
  const records = [];
  const cs = createClaudeState({ onRecord: (cid, pid, rec) => records.push({ cid, pid, rec }), activeMs: 20, idleMs: 20 });
  t.after(() => cs.stop());
  await cs.link('c1', 4243);
  assert.equal(records.length, 1);
  assert.equal(records[0].rec.status, 'busy');
  assert.equal(cs.recordOf('c1').status, 'busy');

  ch.writeSession({ pid: 4243, procStart: null, sessionId: S1, status: 'idle', startedAt: 1, updatedAt: 2, statusUpdatedAt: 2 });
  await waitUntil(() => records.length === 2, { timeout: 10000, what: 'the change, from the watch or the poll' });
  assert.equal(records[1].rec.status, 'idle');

  ch.writeSession({ pid: 4243, procStart: null, sessionId: S1, status: 'idle', startedAt: 1, updatedAt: 2, statusUpdatedAt: 2 });
  await cs.read('c1');
  assert.equal(records.length, 2, 'the same content is not handed on twice');

  ch.removeSession(4243);
  await waitUntil(() => records.length === 3, { timeout: 10000, what: 'the file gone' });
  assert.equal(records[2].rec, null);
  await cs.stop();
  await cs.stop(); // idempotent
});

test('claude-state: a file missing at the first read is not reported gone by the next', async (t) => {
  const watch = fakeWatches();
  let current = null;
  const records = [];
  const cs = createClaudeState({
    watchFile: watch.watchFile,
    readSessionState: () => current,
    onRecord: (cid, pid, rec, info) => records.push({ rec, first: info.first }),
  });
  t.after(() => cs.stop());
  await cs.link('c1', 4246);
  const w = watch.watches[0];
  await w.trigger('poll');
  await w.trigger('poll');
  assert.deepEqual(records, [], 'never there, so never gone');
  assert.equal(cs.recordOf('c1'), null);

  current = Object.freeze({ pid: 4246, sessionId: S1, status: 'busy' });
  await w.trigger('poll');
  assert.deepEqual(records, [{ rec: current, first: false }], 'it appears: a change');
  await w.trigger('poll');
  assert.equal(records.length, 1);
  current = null;
  await w.trigger('poll');
  assert.deepEqual(records.at(-1), { rec: null, first: false }, 'there, then gone');
});

test('the live machine hears a process\'s sessions file only through the conversation it writes now', async (t) => {
  const P1 = process.pid;
  const h = setup(t);
  const { ch, reg, watch } = h;
  ch.writeSession({ pid: P1, procStart: await liveStart(P1), sessionId: S1, status: 'busy' });
  await reg.start();
  await waitUntil(() => watch.active().length === 1, { what: 'the watch' });
  await watch.active()[0].trigger('start');
  assert.deepEqual(h.seen.states.map((s) => [s.cid, s.rec && s.rec.status]), [[S1, 'busy']]);

  // The process resumes another conversation in place: S1 hears null, S2 the file.
  reg.ingest(h.env('SessionStart', S2, { claude_pid: 9999, session: { source: 'startup' } }));
  reg.processGone(S2, { pid: 9999, at: h.clock.tick() });
  h.start(S2, P1, 'resume');
  assert.equal(reg.conversationOfPid(P1), S2);
  await waitUntil(() => watch.active().length === 1 && watch.active()[0] !== watch.watches[0], { what: 'the watch moving' });
  await watch.active()[0].trigger('start');
  const tail = h.seen.states.slice(1).map((s) => [s.cid, s.rec && s.rec.status]);
  assert.deepEqual(tail, [[S1, null], [S2, 'busy']]);
});

test('no code path opens a sessions .key file', async (t) => {
  const P1 = process.pid;
  const h = setup(t, { watch: null }); // the real watch engine
  const { ch, reg } = h;
  const st1 = await liveStart(P1);
  ch.writeSession({ pid: P1, procStart: st1, sessionId: S1, formerNames: [{ sessionId: S2 }] });
  ch.writeSession({ pid: 4244, procStart: null, sessionId: S3 }); // not a live candidate
  // A key reached under a sessions-file name.
  fs.symlinkSync(path.join(ch.sessionsDir, `${P1}.key`), path.join(ch.sessionsDir, '4245.json'));
  const opened = [];
  const names = ['openSync', 'readFileSync', 'open', 'readFile', 'createReadStream'];
  const saved = names.map((n) => [n, fs[n]]);
  const savedP = { open: fs.promises.open, readFile: fs.promises.readFile };
  const note = (p) => { if (typeof p === 'string' || Buffer.isBuffer(p)) opened.push(String(p)); };
  for (const [n, original] of saved) fs[n] = function watched(p, ...rest) { note(p); return original.call(this, p, ...rest); };
  fs.promises.open = function watched(p, ...rest) { note(p); return savedP.open.call(this, p, ...rest); };
  fs.promises.readFile = function watched(p, ...rest) { note(p); return savedP.readFile.call(this, p, ...rest); };
  try {
    await reg.start();
    h.tool(S1, P1);
    await reg.discover();
    await waitUntil(() => h.seen.states.length >= 1, { timeout: 10000, what: 'the watch\'s first read' });
    await reg.flush();
  } finally {
    for (const [n, original] of saved) fs[n] = original;
    fs.promises.open = savedP.open;
    fs.promises.readFile = savedP.readFile;
  }
  assert.ok(opened.some((p) => p.endsWith(`${P1}.json`)), 'the sessions files were read');
  assert.deepEqual(opened.filter((p) => p.endsWith('.key')), [], 'no .key file was opened');
  const everything = JSON.stringify({ list: reg.list(), seen: h.seen });
  assert.ok(!everything.includes(FAKE_PEER_KEY), 'and no key content went anywhere');
});

// ── the exports ──────────────────────────────────────────────────────────────

test('the vocabularies and constants are exported by name', () => {
  assert.deepEqual(REASONS, ['start', 'clear', 'resume', 'fork']);
  assert.deepEqual(LINKED_BY, ['hook', 'sessions-file', 'mcp']);
  assert.deepEqual(CHANGES, ['added', 'linked', 'merged', 'ended', 'removed']);
  assert.equal(CONVERSATIONS_MAX, 200);
  assert.equal(FALLBACK_WINDOW_MS, 2 * 60 * 1000);
  assert.equal(DISCOVERY_MS, live.DISCOVERY_MS, 'the one home of §2.6\'s discovery tick');
  assert.equal(DISCOVERY_MS, 10000);
});
