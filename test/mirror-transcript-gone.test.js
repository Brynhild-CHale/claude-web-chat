// Claude Code's cleanup, the one deleter (U451; DECISIONS.md L.3 N1, L.4 O6;
// lib/server/mirror/conversations.js sweepGone / deleteGone over
// lib/core/claude-files transcriptGone).
//
// Pinned:
//   * an ended conversation whose transcript Claude Code deleted: the boot sweep
//     deletes its session's turn index and the diff records its turns name, logs
//     one `[mirror] cleanup` line, and keeps the session in the record;
//   * nothing is deleted when the slug directory is gone or CLAUDE_CONFIG_DIR
//     points elsewhere, for a live conversation whose transcript does not exist
//     yet, or for a session switched off (transcriptPath null) whose transcript
//     is there;
//   * an orphan index (a session no record holds) is judged by the slug its own
//     file records: deleted when that transcript is gone, kept when it exists;
//   * the rule is asked again before each unlink: a transcript that came back
//     keeps its index and diffs;
//   * keepDiff spares a node-linked diff record (RULED Q1 = a), and the log line
//     counts it;
//   * GONE_SWEEP_MS is exported; the sweep runs at start after the first
//     discovery, again from the tick once GONE_SWEEP_MS has passed, and never
//     while the mirror is off.
//
// The Claude tier is a private fake (claudeHome, isolate: true), its transcripts
// built with createRecords; the registry's timers run on an injected clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { createRecords } = require('../test-support/claude-records');
const { withTempHome } = require('../test-support/helpers');
const { projectPaths } = require('../lib/core/paths');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const claudeFiles = require('../lib/core/claude-files');
const {
  createConversations, GONE_SWEEP_MS, GONE_TRIGGER, DISCOVERY_MS,
} = require('../lib/server/mirror/conversations');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const S4 = '44444444-4444-4444-8444-444444444444';

// ── fixtures ─────────────────────────────────────────────────────────────────

function fakeClock() {
  let t = Date.now();
  let seq = 0;
  const pending = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) { seq += 1; pending.set(seq, { at: t + Math.max(0, Number(ms) || 0), fn }); return seq; },
      clearTimeout(id) { pending.delete(id); },
    },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, p] of pending) if (p.at <= end && (!next || p.at < next[1].at)) next = [id, p];
        if (!next) break;
        pending.delete(next[0]);
        t = Math.max(t, next[1].at);
        next[1].fn();
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      }
      t = end;
      await new Promise((r) => setImmediate(r));
    },
  };
}

function project(t) {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'wc-gone-'));
  fs.mkdirSync(path.join(dir, '.web-chat'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A stored conversation of one session, in the project's slug.
function stored(id, slug, { ended = true, process = null, sessions = [id] } = {}) {
  const at = Date.now() - 3600 * 1000;
  return {
    id, created_at: at, last_activity_at: at, ended_at: ended ? at + 10 : null, title: null, name: null, forked_from: null,
    current_session_id: sessions[sessions.length - 1],
    sessions: sessions.map((s, i) => ({ session_id: s, slug, reason: i ? 'clear' : 'start', started_at: at + i, ended_at: ended ? at + 10 : null })),
    process,
  };
}

// A world: a project, a private Claude tier, the stored conversations, and a
// registry over them (not started).
function world(t, { conversations = (ch) => [], options = {} } = {}) {
  withTempHome(t);
  const dir = project(t);
  const ch = claudeHome(t, { root: dir, isolate: true });
  const p = projectPaths(dir);
  const clock = fakeClock();
  const logs = [];
  const order = [];
  fs.mkdirSync(path.dirname(p.mirrorConversations), { recursive: true });
  fs.writeFileSync(p.mirrorConversations, JSON.stringify({ v: 1, conversations: conversations(ch) }));
  let reg = null;
  t.after(async () => { if (reg) await reg.stop(); });
  const make = () => {
    reg = createConversations({
      root: dir,
      now: clock.now,
      timers: clock.timers,
      log: (...a) => logs.push(a.join(' ')),
      sampleProcs: async (pids) => new Map(pids.map((x) => [x, { alive: false, startedAt: null, cpuMs: null, state: null }])),
      listSessionPids: () => { order.push('discover'); return []; },
      mcpSessionsFor: () => [],
      transcriptGone: (f) => { order.push('sweep'); return claudeFiles.transcriptGone(f); },
      watchFile: () => ({ stop: async () => {}, retarget: async () => {}, stats: {} }),
      ...options,
    });
    return reg;
  };
  const w = { dir, ch, p, clock, logs, order, make, get reg() { return reg; } };
  // A transcript Claude Code wrote, built with createRecords.
  w.transcript = (sid) => {
    const r = createRecords({ seed: sid.length, sessionId: sid, cwd: ch.cwd });
    r.prompt('hello');
    r.assistant(['hi']);
    ch.writeTranscript(sid, r.records);
    return ch.transcript(sid);
  };
  // A session's index naming `turns`, and a diff record for each.
  w.index = (sid, turns, { slug = ch.slug } = {}) => {
    writeJsonAtomic(p.mirrorIndex(sid), {
      v: 1, session_id: sid, conversation_id: sid, slug, file: null, resume: null,
      turns: turns.map((id) => ({ id, header: { id }, internal: null })),
      state: { meta: {}, skills: { names: [], descriptions: {} }, sources: {} }, saved_at: Date.now(),
    });
    for (const id of turns) writeJsonAtomic(p.mirrorDiff(id), { v: 1, turn_id: id, status: 'ready' });
  };
  w.has = (sid, turns) => ({
    index: fs.existsSync(p.mirrorIndex(sid)),
    diffs: turns.map((id) => fs.existsSync(p.mirrorDiff(id))),
  });
  w.cleanups = () => logs.filter((l) => l.includes('[mirror] cleanup:'));
  return w;
}

// ── the sweep ────────────────────────────────────────────────────────────────

test('an ended conversation whose transcript Claude Code deleted: its index and diffs go at the boot sweep, the session stays', async (t) => {
  const w = world(t, { conversations: (ch) => [stored(S1, ch.slug)] });
  const file = w.transcript(S1);
  w.index(S1, ['t-a', 't-b']);
  fs.unlinkSync(file); // Claude Code's cleanupPeriodDays
  const reg = w.make();
  await reg.start();
  assert.deepEqual(w.has(S1, ['t-a', 't-b']), { index: false, diffs: [false, false] });
  assert.equal(w.cleanups().length, 1, 'one line');
  assert.match(w.cleanups()[0], new RegExp(`session ${S1}.*2 code diffs deleted, 0 kept`));
  assert.ok(w.cleanups()[0].includes(GONE_TRIGGER));
  assert.deepEqual(reg.get(S1).sessions.map((s) => s.session_id), [S1], 'the session stays in the record');
  await reg.flush();
  const saved = JSON.parse(fs.readFileSync(w.p.mirrorConversations, 'utf8'));
  assert.deepEqual(saved.conversations[0].sessions.map((s) => s.session_id), [S1]);
  // Judged once: a later sweep says nothing more.
  reg.sweepGone();
  assert.equal(w.cleanups().length, 1);
});

test('a removed slug directory deletes nothing', async (t) => {
  const w = world(t, { conversations: (ch) => [stored(S1, ch.slug)] });
  w.transcript(S1);
  w.index(S1, ['t-a']);
  fs.rmSync(w.ch.projectDir, { recursive: true, force: true });
  await w.make().start();
  assert.deepEqual(w.has(S1, ['t-a']), { index: true, diffs: [true] });
  assert.equal(w.cleanups().length, 0);
});

test('a CLAUDE_CONFIG_DIR pointed elsewhere deletes nothing', async (t) => {
  const w = world(t, { conversations: (ch) => [stored(S1, ch.slug)] });
  w.transcript(S1);
  w.index(S1, ['t-a']);
  const prev = process.env.CLAUDE_CONFIG_DIR;
  const elsewhere = fs.mkdtempSync(path.join(SANDBOX, 'wc-gone-cfg-'));
  fs.mkdirSync(path.join(elsewhere, 'projects'));
  process.env.CLAUDE_CONFIG_DIR = elsewhere;
  t.after(() => { process.env.CLAUDE_CONFIG_DIR = prev; fs.rmSync(elsewhere, { recursive: true, force: true }); });
  await w.make().start();
  assert.deepEqual(w.has(S1, ['t-a']), { index: true, diffs: [true] });
  assert.equal(w.cleanups().length, 0);
});

test('a live conversation is never swept, though its current transcript does not exist yet', async (t) => {
  const proc = { pid: process.pid, proc_start: null, kind: 'interactive', entrypoint: 'cli', linked_by: 'hook', linked_at: Date.now() };
  const w = world(t, { conversations: (ch) => [stored(S1, ch.slug, { ended: false, process: proc, sessions: [S1, S2] })] });
  w.index(S1, ['t-a']); // an earlier session's index, its transcript absent too
  w.index(S2, ['t-b']);
  const reg = w.make();
  await reg.start();
  assert.equal(reg.get(S1).ended_at, null, 'still live');
  assert.deepEqual(w.has(S1, ['t-a']), { index: true, diffs: [true] });
  assert.deepEqual(w.has(S2, ['t-b']), { index: true, diffs: [true] });
  assert.equal(w.cleanups().length, 0);
});

test('a session switched off (transcriptPath null) whose transcript is there deletes nothing', async (t) => {
  const w = world(t, {
    conversations: (ch) => [stored(S1, ch.slug), stored(S3, null)],
    options: {
      resolveToggle: ({ sessionId, scopes }) => (scopes.includes('session') && sessionId === S1 ? { enabled: false, by: 'session' } : { enabled: true }),
    },
  });
  w.transcript(S1);
  w.index(S1, ['t-a']);
  w.index(S3, ['t-c']); // no slug in its record: transcriptPath null, never "gone"
  const reg = w.make();
  await reg.start();
  assert.equal(reg.transcriptPath(S1), null, 'switched off');
  assert.equal(reg.transcriptPath(S3), null, 'no slug');
  assert.deepEqual(w.has(S1, ['t-a']), { index: true, diffs: [true] });
  assert.deepEqual(w.has(S3, ['t-c']), { index: true, diffs: [true] });
  assert.equal(w.cleanups().length, 0);
});

test('an orphan index is judged by the slug its own file records: gone is deleted, present is kept', async (t) => {
  const w = world(t, { conversations: () => [] });
  const gone = w.transcript(S1);
  w.transcript(S2);
  w.index(S1, ['t-a']);
  w.index(S2, ['t-b']);
  w.index(S3, ['t-c'], { slug: '-no-such-project' }); // its slug directory absent
  fs.unlinkSync(gone);
  const reg = w.make();
  await reg.start();
  for (const sid of [S1, S3]) assert.equal(reg.bySession(sid), null, 'no record holds it');
  assert.deepEqual(w.has(S1, ['t-a']), { index: false, diffs: [false] });
  assert.deepEqual(w.has(S2, ['t-b']), { index: true, diffs: [true] });
  assert.deepEqual(w.has(S3, ['t-c']), { index: true, diffs: [true] });
  assert.equal(w.cleanups().length, 1);
});

test('a transcript recreated between the sweep\'s verdict and the unlink is kept, with its index and diffs', async (t) => {
  let w = null;
  const keepDiff = () => { w.transcript(S1); return false; }; // runs before the first unlink
  w = world(t, { conversations: (ch) => [stored(S1, ch.slug)], options: { keepDiff } });
  const file = w.transcript(S1);
  w.index(S1, ['t-a', 't-b']);
  fs.unlinkSync(file);
  await w.make().start();
  assert.ok(fs.existsSync(file), 'it came back');
  assert.deepEqual(w.has(S1, ['t-a', 't-b']), { index: true, diffs: [true, true] });
  assert.equal(w.cleanups().length, 0);
});

test('keepDiff spares a node-linked diff record; the gone session\'s index and its other diffs go, and the line counts the kept one', async (t) => {
  const asked = [];
  const keepDiff = (id) => { asked.push(id); return id === 't-node'; };
  const w = world(t, { conversations: (ch) => [stored(S1, ch.slug)], options: { keepDiff } });
  const file = w.transcript(S1);
  w.index(S1, ['t-a', 't-node', 't-b']);
  fs.unlinkSync(file);
  await w.make().start();
  assert.deepEqual(w.has(S1, ['t-a', 't-node', 't-b']), { index: false, diffs: [false, true, false] });
  assert.deepEqual(asked, ['t-a', 't-node', 't-b']);
  assert.equal(w.cleanups().length, 1);
  assert.match(w.cleanups()[0], /2 code diffs deleted, 1 kept for graph nodes/);
});

test('GONE_SWEEP_MS is exported; the sweep runs at start after the first discovery, from the tick every GONE_SWEEP_MS, never while the mirror is off', async (t) => {
  assert.equal(GONE_SWEEP_MS, 10 * 60 * 1000);
  const w = world(t, { conversations: (ch) => [stored(S1, ch.slug), stored(S2, ch.slug), stored(S4, ch.slug)] });
  const f1 = w.transcript(S1);
  const f2 = w.transcript(S2);
  const f4 = w.transcript(S4);
  w.index(S1, ['t-1']);
  w.index(S2, ['t-2']);
  w.index(S4, ['t-4']);
  fs.unlinkSync(f1);
  const reg = w.make();
  await reg.start();
  const firstSweep = w.order.indexOf('sweep');
  assert.ok(w.order.indexOf('discover') >= 0 && w.order.indexOf('discover') < firstSweep, `discovery first (${w.order.join(',')})`);
  assert.equal(w.has(S1, ['t-1']).index, false, 'swept at start');

  // Claude Code cleans another: a tick before GONE_SWEEP_MS does not sweep.
  fs.unlinkSync(f2);
  w.order.length = 0;
  await w.clock.advance(DISCOVERY_MS);
  assert.ok(w.order.includes('discover'), 'the tick ran');
  assert.ok(!w.order.includes('sweep'), 'but no sweep yet');
  assert.equal(w.has(S2, ['t-2']).index, true);
  await w.clock.advance(GONE_SWEEP_MS);
  assert.ok(w.order.includes('sweep'), 'the tick swept');
  assert.deepEqual(w.has(S2, ['t-2']), { index: false, diffs: [false] });

  // The mirror off: no sweep, however long.
  fs.writeFileSync(w.p.disabled, '');
  await w.clock.advance(DISCOVERY_MS);
  assert.equal(reg.enabled().enabled, false);
  fs.unlinkSync(f4);
  w.order.length = 0;
  await w.clock.advance(GONE_SWEEP_MS * 3);
  assert.ok(!w.order.includes('sweep'), 'never while off');
  assert.equal(reg.sweepGone(), 0);
  assert.deepEqual(w.has(S4, ['t-4']), { index: true, diffs: [true] });
});
