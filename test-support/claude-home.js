// A fake Claude Code user tier for the chat mirror's tests: the directories
// lib/core/paths userClaudePaths() names (projects/<slug>/ with each session's
// transcript and side directories, sessions/<pid>.json state files, plans,
// synced skills, plugins), the MCP presence rows web-chat's own MCP server
// writes into ~/.web-chat/instances.json, and Claude Code's task-output tree
// (/tmp/claude-<uid>/<slug>/<session>/tasks/<task id>.output).
//
// Generated at test time and never copied from a real ~/.claude, whose
// transcripts and sessions files hold real prompts and secrets (validation
// V16). Everything lands under the test sandbox (test-support/sandbox.js), and
// the fixture refuses to build anywhere else.
//
// It plays CLAUDE CODE, so what Claude Code would record carries the PHYSICAL
// project path: the slug, a sessions file's `cwd` and an MCP row's `root` are
// built from realpath(root). On macOS a test root under /var/folders/… is
// /private/var/folders/… there, exactly as on a real machine, so code under
// test has to compare roots through realpath, as the engine must.
//
// Liveness is the caller's. A sessions file's `procStart` is whatever the test
// passes, and this file never computes one: a test whose record must pass the
// pid + start-time check passes the live value (lib/core/portfiles
// `sampleProcs([pid])`), and one that does not care passes null.
//
//   const ch = claudeHome(t, { root });            // t.after cleans up
//   ch.writeSession({ pid: process.pid, procStart, sessionId });
//   ch.writeTranscript(sessionId, [record, …]);    // objects, or raw lines
//   ch.addMcp({ pid: process.pid, ppid: process.ppid });
//   const out = ch.writeTaskOutput(sessionId, 'b3k9x2', 'building…\n');
//   ch.write('plans/quiet-river.md', '# Plan\n');  // any other file in the tier
//
// Two modes. By default the tree is built in the sandbox's own Claude tier,
// <sandbox>/.claude (one per test-file process), and what the fixture created
// is removed when the test ends, so the tests of a file follow each other
// cleanly; other tests' files may sit beside it, as other projects' do on a
// real machine. `isolate: true` gives the test a private, empty tier instead:
// a fresh directory under the sandbox that CLAUDE_CONFIG_DIR points at until
// the test ends. Make an isolated one BEFORE booting anything that reads the
// Claude tier, which may resolve the directory once at start.

const { home: SANDBOX } = require('./sandbox');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { userClaudePaths, claudeProjectSlug, isSafeId, realpath, fence } = require('../lib/core/paths');
const { readJson, writeJsonAtomic } = require('../lib/core/fsjson');
const registry = require('../lib/util/registry');

// The Claude Code these fakes imitate: the one installed when 0.8.5 was built.
const CLAUDE_CODE_VERSION = '2.1.287';

// A task id as Claude Code names its output file, and as lib/core/claude-files
// accepts one.
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// What sits in each sessions file's `.key` neighbour. Real ones hold a peer
// token, which nothing in web-chat may ever open; this one is a decoy that a
// test can look for in anything that leaves the daemon.
const FAKE_PEER_KEY = 'fake-claude-peer-key-for-tests';

// The isolated tiers in force, innermost last, over the CLAUDE_CONFIG_DIR from
// before the first. t.after hooks run in the order they were registered, so
// nested fixtures unwind outer-first; repointing from this stack keeps the
// innermost tier in force whichever order they unwind in.
const isolated = [];
let beforeIsolation;

function repointConfigDir() {
  const top = isolated[isolated.length - 1];
  if (top) process.env.CLAUDE_CONFIG_DIR = top;
  else if (beforeIsolation === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = beforeIsolation;
}

// Inside the sandbox, under either spelling of it (macOS's /var is
// /private/var). Lexical on `p`, so a path outside is refused without being
// touched: the fixture never so much as stats a path beyond the sandbox.
const SANDBOX_REAL = realpath(SANDBOX) || SANDBOX;
function inSandbox(p) {
  return fence(SANDBOX, p) !== null || fence(SANDBOX_REAL, p) !== null;
}

// A transcript's lines: one JSON object per line, each ended by '\n'. A string
// element is a line already serialised (or a deliberately broken one); a whole
// string is written as it is, so a test can leave a partial last line.
function jsonl(records) {
  if (typeof records === 'string') return records;
  if (!Array.isArray(records)) throw new TypeError('claudeHome: transcript records are an array of objects or lines, or one raw string');
  return records.map((r) => `${typeof r === 'string' ? r : JSON.stringify(r)}\n`).join('');
}

const VALID_REGISTRY = { validate: (d) => d && Array.isArray(d.instances) };

// Remove one MCP presence row from the registry file it was written to, which
// need not be the current HOME's any more (withTempHome may have moved it).
function dropMcpRow(file, pid) {
  const got = readJson(file, VALID_REGISTRY);
  if (!got.ok) return;
  const id = registry.mcpId(pid);
  const kept = got.value.instances.filter((e) => !(e && e.id === id));
  if (kept.length !== got.value.instances.length) writeJsonAtomic(file, { ...got.value, instances: kept });
}

function claudeHome(t, { root, isolate = false } = {}) {
  if (typeof root !== 'string' || !root) {
    throw new TypeError('claudeHome(t, { root }): root is the project directory the fake sessions run in');
  }

  let area = null; // an isolated tier's private directory
  if (isolate) {
    area = fs.mkdtempSync(path.join(SANDBOX, 'claude-home-'));
    fs.mkdirSync(path.join(area, '.claude'));
    if (!isolated.length) beforeIsolation = process.env.CLAUDE_CONFIG_DIR;
    isolated.push(path.join(area, '.claude'));
    repointConfigDir();
  }

  const made = [];         // directories this fixture created, in order
  const files = new Set(); // files it wrote
  const rows = new Map();  // MCP pid → the registry file its row went to
  let ownedDirs = new Set(); // directories only this project uses (set below)
  let done = false;

  function cleanup() {
    if (done) return;
    done = true;
    for (const [pid, file] of rows) { try { dropMcpRow(file, pid); } catch {} }
    for (const f of files) { try { fs.rmSync(f, { force: true }); } catch {} }
    // Deepest first. A directory only this project uses goes whole; any other
    // goes only when empty, since another test's files may share it.
    for (const d of made.slice().reverse()) {
      try {
        if (ownedDirs.has(d)) fs.rmSync(d, { recursive: true, force: true });
        else fs.rmdirSync(d);
      } catch {}
    }
    if (area) {
      try { fs.rmSync(area, { recursive: true, force: true }); } catch {}
      const i = isolated.lastIndexOf(path.join(area, '.claude'));
      if (i >= 0) isolated.splice(i, 1);
      repointConfigDir();
    }
  }
  if (t && typeof t.after === 'function') t.after(cleanup);

  const tier = userClaudePaths();
  const dir = tier.configDir;
  if (!inSandbox(dir)) {
    cleanup();
    throw new Error(`claudeHome: Claude Code's tier is ${dir}, outside the test sandbox ${SANDBOX}; refusing to build there`);
  }

  const cwd = realpath(root) || path.resolve(root);
  const slug = claudeProjectSlug(cwd);
  const projectDir = tier.projectDir(cwd);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  // Stands in for /tmp: Claude Code's task outputs live in <tmp>/claude-<uid>/.
  const tmpDir = path.join(area || SANDBOX, 'tmp');
  const claudeTmp = path.join(tmpDir, `claude-${uid}`);
  ownedDirs = new Set([projectDir, path.join(claudeTmp, slug)]);

  function mkdirs(d, mode) {
    const missing = [];
    for (let cur = d; !fs.existsSync(cur); cur = path.dirname(cur)) missing.unshift(cur);
    for (const m of missing) {
      fs.mkdirSync(m, mode === undefined ? undefined : { mode });
      made.push(m);
    }
    return d;
  }

  function put(file, data, { append = false } = {}) {
    mkdirs(path.dirname(file));
    if (append) fs.appendFileSync(file, data);
    else fs.writeFileSync(file, data);
    files.add(file);
    return file;
  }

  function sid(sessionId) {
    if (!isSafeId(sessionId)) throw new TypeError(`claudeHome: ${JSON.stringify(sessionId)} is not a session id`);
    return sessionId;
  }

  // ── the tier itself ──
  function file(rel) {
    const p = fence(dir, rel);
    if (!p || p === dir) throw new TypeError(`claudeHome: ${JSON.stringify(rel)} is not a file inside ${dir}`);
    return p;
  }

  // ── transcripts ──
  const transcript = (sessionId) => path.join(projectDir, `${sid(sessionId)}.jsonl`);

  // ── sessions files ──
  // <sessions>/<pid>.json as Claude Code writes it, with defaults for an idle
  // interactive session in this project; every field can be overridden, and
  // any other is written as given. `procStart` is required (null is allowed).
  function writeSession(fields = {}) {
    if (!Object.prototype.hasOwnProperty.call(fields, 'procStart')) {
      throw new TypeError('claudeHome writeSession: pass procStart. The caller supplies it: sampleProcs([pid]) from lib/core/portfiles for a live process, or null for a record without one');
    }
    const { pid, procStart, key = true, ...rest } = fields;
    const stateFile = tier.claudeSessionStateFile(pid);
    if (!stateFile) throw new TypeError(`claudeHome writeSession: pid ${JSON.stringify(pid)} is not a positive integer`);
    const now = Date.now();
    const record = {
      pid,
      sessionId: crypto.randomUUID(),
      cwd,
      startedAt: now,
      procStart,
      version: CLAUDE_CODE_VERSION,
      kind: 'interactive',
      entrypoint: 'cli',
      status: 'idle',
      updatedAt: now,
      statusUpdatedAt: now,
      ...rest,
    };
    put(stateFile, JSON.stringify(record));
    if (key) {
      const keyFile = path.join(tier.sessionsDir, `${pid}.key`);
      put(keyFile, FAKE_PEER_KEY);
      fs.chmodSync(keyFile, 0o600);
    }
    return { file: stateFile, record };
  }

  function removeSession(pid) {
    const stateFile = tier.claudeSessionStateFile(pid);
    if (!stateFile) return;
    for (const f of [stateFile, path.join(tier.sessionsDir, `${pid}.key`)]) {
      fs.rmSync(f, { force: true });
      files.delete(f);
    }
  }

  // ── MCP presence rows ──
  // Written by the registry's own writer (lib/util/registry registerMcp), so
  // the row has the shape web-chat's MCP server gives it. Fields that writer
  // does not take (or takes differently) are patched onto the row as given.
  // The row is written whether or not its pids are alive: liveness is the
  // reader's question, and a dead row is a fixture too.
  function addMcp({ pid = process.pid, ppid = process.ppid, root: rowRoot = cwd, channel = false, ...fields } = {}) {
    const registryFile = registry.registryPath();
    registry.registerMcp({ root: rowRoot, pid, ppid, channel, ...fields });
    const got = readJson(registryFile, VALID_REGISTRY);
    const id = registry.mcpId(pid);
    const at = got.ok ? got.value.instances.findIndex((e) => e && e.id === id) : -1;
    if (at < 0) throw new Error(`claudeHome addMcp: the presence row for pid ${pid} was not written to ${registryFile}`);
    rows.set(pid, registryFile);
    const patch = {};
    for (const [k, v] of Object.entries(fields)) {
      if (JSON.stringify(got.value.instances[at][k]) !== JSON.stringify(v)) patch[k] = v;
    }
    if (Object.keys(patch).length) {
      got.value.instances[at] = { ...got.value.instances[at], ...patch };
      writeJsonAtomic(registryFile, got.value);
    }
    return got.value.instances[at];
  }

  function removeMcp(pid) {
    const registryFile = rows.get(pid);
    if (!registryFile) return;
    dropMcpRow(registryFile, pid);
    rows.delete(pid);
  }

  // ── task outputs ──
  // <tmp>/claude-<uid>/<slug>/<session>/tasks/: the claude-<uid> directory is
  // 0700 and this uid's, as Claude Code makes it. A task's output path is only
  // ever read out of transcript text, never derived, so a test writes the path
  // this returns into the records it builds.
  function taskDir(sessionId) {
    const id = sid(sessionId);
    mkdirs(claudeTmp, 0o700);
    return mkdirs(path.join(claudeTmp, slug, id, 'tasks'));
  }

  function taskOutput(sessionId, taskId) {
    if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
      throw new TypeError(`claudeHome: ${JSON.stringify(taskId)} is not a task id`);
    }
    return path.join(taskDir(sessionId), `${taskId}.output`);
  }

  mkdirs(tier.sessionsDir);
  mkdirs(projectDir);

  return {
    dir,                         // the fake ~/.claude (CLAUDE_CONFIG_DIR while the test runs)
    root,                        // the project root, as given
    cwd,                         // its physical path: what Claude Code records
    slug,                        // claudeProjectSlug(cwd)
    projectsDir: tier.projectsDir,
    projectDir,                  // <dir>/projects/<slug>, made
    sessionsDir: tier.sessionsDir, // <dir>/sessions, made
    tmpDir,                      // stands in for /tmp
    uid,
    file,
    write: (rel, data) => put(file(rel), data),
    transcript,
    writeTranscript: (sessionId, records) => put(transcript(sessionId), jsonl(records)),
    appendTranscript: (sessionId, records) => put(transcript(sessionId), jsonl(records), { append: true }),
    sessionDir: (sessionId) => mkdirs(path.join(projectDir, sid(sessionId))),
    writeSession,
    removeSession,
    addMcp,
    removeMcp,
    taskDir,
    writeTaskOutput: (sessionId, taskId, text) => put(taskOutput(sessionId, taskId), text),
    appendTaskOutput: (sessionId, taskId, text) => put(taskOutput(sessionId, taskId), text, { append: true }),
    cleanup,
  };
}

module.exports = { claudeHome, CLAUDE_CODE_VERSION, FAKE_PEER_KEY };
