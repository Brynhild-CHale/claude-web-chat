// OPT-IN (spec §10.1, §15.2; WEB_CHAT_E2E_CLAUDE=1 — the maintainer's run,
// never a seat's, and never CI's): the halt flag stops a REAL headless Claude
// Code turn at its first tool.
//
// A scratch project whose .claude/settings.json holds web-chat's hook handlers,
// halt handlers included — written by lib/setup/registration's applyHooks, never
// by hand — and no .web-chat/, so every other web-chat hook is a no-op there.
// The control domain writes the flag through interrupt.js's hook path (an
// 'after-step' request for a working conversation whose session is the turn's
// --session-id), then one `claude -p` turn is asked to run a tool that would
// write a marker file. Asserted: the result's terminal_reason is hook_stopped,
// the marker is absent, and the flag is gone once the turn closes (the
// mirror's turn-closed, which a fake facade reports here when the process
// exits).
//
// HOME is the test's sandbox; CLAUDE_CONFIG_DIR is a logged-in THROWAWAY
// profile the maintainer names in WEB_CHAT_E2E_CLAUDE_CONFIG_DIR — read by
// test-support/helpers' e2eGate(['claude']).claudeConfigDir, never here, and
// never ~/.claude. While it is unset the test skips, naming the variable.
//
//   WEB_CHAT_E2E_CLAUDE=1 WEB_CHAT_E2E_CLAUDE_CONFIG_DIR=<dir> \
//     node --test --test-timeout=120000 --import ./test-support/sandbox.js test/control-halt-e2e.test.js
//
// One haiku turn, a few cents.

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

test('a real headless turn stops at its first tool with terminal_reason hook_stopped, and the flag is gone once the turn closes', { skip, timeout: 120_000 }, async (t) => {
  const { applyHooks } = require('../lib/setup/registration');
  const { userPaths } = require('../lib/core/paths');
  const { createControl } = require('../lib/server/control');

  const home = withTempHome(t);
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-halt-e2e-')));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const hooks = applyHooks(project);
  assert.ok(hooks.events.includes('PreToolUse'), 'the halt handlers are registered');
  assert.match(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'), /claude-web-chat-hook-halt\.sh/);

  const sid = crypto.randomUUID();
  const subs = new Set();
  const mirror = {
    snapshot: () => ({ conversations: [{ id: 'c1', name: 'e2e', current_session_id: sid, process: null, live: { state: 'working' } }] }),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-halt-e2e-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const control = createControl({ root, mirror });
  t.after(() => control.stop());
  await control.start();

  const a = await control.invoke('interrupt', { conversation_id: 'c1', mode: 'after-step' }, {});
  assert.deepEqual([a.ok, a.via], [true, 'hook'], JSON.stringify(a));
  const flag = userPaths().haltFlag(sid);
  assert.ok(fs.existsSync(flag), 'the flag is written before the turn');

  const marker = path.join(project, 'marker.txt');
  const env = {
    HOME: home,
    CLAUDE_CONFIG_DIR: gate.claudeConfigDir,
    PATH: [path.dirname(gate.claude), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
  };
  const r = spawnSync(gate.claude, [
    '-p', `Use the Bash tool to run exactly this command and nothing else: touch ${marker}`,
    '--session-id', sid,
    '--output-format', 'json',
    '--model', 'haiku',
    '--allowedTools', 'Bash',
    '--max-turns', '3',
  ], { cwd: project, env, encoding: 'utf8', input: '', timeout: 110_000 });
  assert.equal(r.error, undefined, `claude ran (${r.error && r.error.code})`);
  let out = null;
  try { out = JSON.parse(r.stdout); } catch {}
  assert.ok(out, `a JSON result: ${String(r.stdout).slice(0, 400)} ${String(r.stderr).slice(0, 400)}`);
  assert.equal(out.terminal_reason, 'hook_stopped', JSON.stringify(out).slice(0, 600));
  assert.equal(fs.existsSync(marker), false, 'the tool never ran');

  // The turn closed: the mirror says so, and the flag goes with it.
  for (const fn of [...subs]) fn({ kind: 'mirror', op: 'turn-closed', conversation_id: 'c1', session_id: sid, turn_id: 'p1', outcome: 'interrupted', by: 'stop' });
  assert.equal(fs.existsSync(flag), false, 'no flag outlives its turn');
});
