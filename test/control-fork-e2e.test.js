// OPT-IN (spec §10.1, §15.6; WEB_CHAT_E2E_CLAUDE=1 — the maintainer's run,
// never a seat's, and never CI's): "Fork from here" against a REAL Claude Code.
//
// A scratch project; two headless `claude -p` turns in one session (the first
// with --session-id, the second --resume'd), each prompt carrying a marker. The
// second prompt's anchor (the parentUuid of its user record, read from the real
// transcript) is handed to the fork row through a fake mirror's forkAnchor, and
// the row runs through the control domain's invoke() — forkArgv, the scrubbed
// environment, stdin /dev/null, the project root as cwd. Asserted: the answer
// is a new session id and `claude --resume <id>`; the new session's transcript
// holds the first prompt and ends before the second; the original transcript is
// byte for byte what it was before the fork.
//
// HOME is the test's sandbox; CLAUDE_CONFIG_DIR is a logged-in THROWAWAY
// profile the maintainer names in WEB_CHAT_E2E_CLAUDE_CONFIG_DIR — read by
// test-support/helpers' e2eGate(['claude']).claudeConfigDir, never here, and
// never ~/.claude. While it is unset the test skips, naming the variable.
//
//   WEB_CHAT_E2E_CLAUDE=1 WEB_CHAT_E2E_CLAUDE_CONFIG_DIR=<dir> \
//     node --test --test-timeout=180000 --import ./test-support/sandbox.js test/control-fork-e2e.test.js
//
// Two haiku turns (a few cents); the fork itself makes no model call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { e2eGate, withTempHome } = require('../test-support/helpers');

const gate = e2eGate(['claude']);
const skip = gate.skip || (gate.claudeConfigDir
  ? false
  : 'WEB_CHAT_E2E_CLAUDE=1, but no throwaway Claude config directory is named — set WEB_CHAT_E2E_CLAUDE_CONFIG_DIR to a logged-in profile that is not ~/.claude');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The transcript of a session, wherever Claude Code put its project slug.
function transcriptOf(configDir, sid) {
  const projects = path.join(configDir, 'projects');
  if (!fs.existsSync(projects)) return null;
  for (const slug of fs.readdirSync(projects)) {
    const f = path.join(projects, slug, `${sid}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function records(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// The text of a user record's message, however its content is shaped.
function userText(rec) {
  if (!rec || rec.type !== 'user' || !rec.message) return '';
  const c = rec.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return '';
}

test('a real fork answers a new session whose transcript ends before the forked prompt; the original is byte-identical', { skip, timeout: 180_000 }, async (t) => {
  const { createControl } = require('../lib/server/control');
  const { installFork } = require('../lib/server/control/fork');
  const { runClaudeAsync } = require('../lib/core/claude-cli');

  const home = withTempHome(t);
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-fork-e2e-')));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const env = {
    HOME: home,
    CLAUDE_CONFIG_DIR: gate.claudeConfigDir,
    PATH: [path.dirname(gate.claude), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
  };
  const run = (argv) => {
    const r = spawnSync(gate.claude, argv, { cwd: project, env, encoding: 'utf8', input: '', timeout: 80_000 });
    assert.equal(r.error, undefined, `claude ran (${r.error && r.error.code})`);
    let out = null;
    try { out = JSON.parse(r.stdout); } catch {}
    assert.ok(out, `a JSON result: ${String(r.stdout).slice(0, 400)} ${String(r.stderr).slice(0, 400)}`);
    return out;
  };

  const tag = crypto.randomBytes(4).toString('hex');
  const FIRST = `FIRST-${tag}`;
  const SECOND = `SECOND-${tag}`;
  const sid = crypto.randomUUID();
  const one = run(['-p', `Reply with exactly the word ${FIRST} and nothing else.`, '--session-id', sid, '--output-format', 'json', '--model', 'haiku', '--max-turns', '1']);
  assert.equal(one.session_id, sid);
  const two = run(['-p', `Reply with exactly the word ${SECOND} and nothing else.`, '--resume', sid, '--output-format', 'json', '--model', 'haiku', '--max-turns', '1']);
  const source = two.session_id;
  assert.match(source, UUID_RE);

  const original = transcriptOf(gate.claudeConfigDir, source);
  assert.ok(original, 'the source transcript exists');
  const recs = records(original);
  assert.ok(recs.some((r) => userText(r).includes(FIRST)), 'the transcript holds the first prompt');
  const second = recs.find((r) => userText(r).includes(SECOND));
  assert.ok(second, 'the transcript holds the second prompt');
  assert.match(String(second.parentUuid), UUID_RE, 'the second prompt has a parent record');
  const before = fs.readFileSync(original);

  // The row, through the control domain, with the real transcript's anchor.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-fork-e2e-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const control = createControl({ root });
  t.after(() => control.stop());
  const mirror = {
    forkAnchor: async (id) => (id === 'turn-2' ? { session_id: source, parent_uuid: second.parentUuid } : { refused: 'unknown' }),
    turn: async (id) => (id === 'turn-2' ? { turn: { id, conversation_id: 'c1', session_id: source, started_at: null, node: { id: 'n2', label: 'n1.1' } } } : null),
  };
  installFork(control, {
    mirror, root: project,
    findClaude: () => gate.claude,
    // The daemon's environment is this test's; the profile and HOME are the sandbox's.
    runClaudeAsync: (argv, o) => runClaudeAsync(argv, { ...o, env: { ...process.env, ...env } }),
  });

  const a = await control.invoke('fork', { turn_id: 'turn-2' }, {});
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.match(a.session_id, UUID_RE);
  assert.notEqual(a.session_id, source, 'a new session');
  assert.equal(a.command, `claude --resume ${a.session_id}`);

  const forked = transcriptOf(gate.claudeConfigDir, a.session_id);
  assert.ok(forked, 'the fork has a transcript');
  const frecs = records(forked);
  assert.ok(frecs.some((r) => userText(r).includes(FIRST)), 'the fork keeps the first prompt');
  assert.ok(!frecs.some((r) => userText(r).includes(SECOND)), 'the fork ends before the second prompt');

  assert.ok(Buffer.compare(fs.readFileSync(original), before) === 0, 'the original transcript is byte-identical');
});
