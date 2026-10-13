// OPT-IN (spec §10.1, §15.7; WEB_CHAT_E2E_CLAUDE=1 — the maintainer's run,
// never a seat's, and never CI's): the web-chat mod in a REAL Claude Code.
//
// A scratch project under the sandbox HOME, a web-chat daemon at its root
// (withServer, with its portfile), the real `claude-web-chat mod on` (the
// project's marketplace and the plugin at local scope, through the real
// `claude`), then one headless `claude -p 'reply with ok'` there. While it
// runs, GET /api/bridge/status must show one attached session; its diag must
// carry the turn's shapes (the mod sends it after the first turn.complete) and
// the bridge must have accepted the turn's events. `mod off` after, which must
// leave the throwaway profile's user settings as they began.
//
// HOME is the test's sandbox; CLAUDE_CONFIG_DIR is a logged-in THROWAWAY
// profile the maintainer names in WEB_CHAT_E2E_CLAUDE_CONFIG_DIR — read by
// test-support/helpers' e2eGate(['claude']).claudeConfigDir, never here, and
// never ~/.claude. While it is unset the test skips, naming the variable. A
// daemon whose GET /api/bridge/status is not 200 FAILS (U94a wired ctx.bridge):
// an unwired bridge is a regression, never a skip.
//
//   WEB_CHAT_E2E_CLAUDE=1 WEB_CHAT_E2E_CLAUDE_CONFIG_DIR=<dir> \
//     node --test --test-timeout=240000 --import ./test-support/sandbox.js test/claude-mod-e2e.test.js
//
// One haiku-sized turn (a few cents).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { e2eGate, withServer, waitUntil } = require('../test-support/helpers');
const { request } = require('../lib/client');

const gate = e2eGate(['claude']);
const skip = gate.skip || (gate.claudeConfigDir
  ? false
  : 'WEB_CHAT_E2E_CLAUDE=1, but no throwaway Claude config directory is named — set WEB_CHAT_E2E_CLAUDE_CONFIG_DIR to a logged-in profile that is not ~/.claude');

const hashOf = (file) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
};

test('mod on, one real `claude -p` turn attaches and its turn reaches the bridge; mod off', { skip, timeout: 240_000 }, async (t) => {
  const mod = require('../lib/cli/commands/mod');
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = gate.claudeConfigDir;
  t.after(() => { if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg; });
  const userSettings = path.join(gate.claudeConfigDir, 'settings.json');
  const settingsBefore = hashOf(userSettings);

  await withServer(t, { writePortfile: true }, async (ctx) => {
    const status = async () => request(ctx.port, 'GET', '/api/bridge/status', null);
    const first = await status();
    assert.equal(first.status, 200, 'GET /api/bridge/status answers 200: the daemon wires its mod bridge (ctx.bridge)');

    const lines = [];
    const on = await mod(['on'], { cwd: ctx.root, log: (l) => lines.push(l) });
    assert.equal(on.ok, true, lines.join('\n'));

    let seen = null;
    const child = spawn(gate.claude, ['-p', 'reply with ok'], {
      cwd: ctx.root,
      env: { ...process.env, CLAUDE_CONFIG_DIR: gate.claudeConfigDir, HOME: ctx.home || process.env.HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const exited = new Promise((r) => child.on('close', r));
    // Poll while it runs: a -p session detaches when it ends.
    let running = true;
    exited.then(() => { running = false; });
    while (running) {
      const s = await status();
      const sessions = (s.body && s.body.sessions) || [];
      if (sessions.length === 1) seen = { ...sessions[0] };
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(seen, `a session attached while claude -p ran\n${out}`);
    assert.ok(seen.counters.events_accepted >= 2, 'the turn\'s events reached the bridge');
    assert.ok(seen.shapes['turn.complete'], 'the diag after its first turn.complete');

    const log = fs.readFileSync(path.join(ctx.root, '.web-chat', 'mod', 'bridge.log'), 'utf8');
    assert.match(log, /"what":"hello"/);
    await waitUntil(() => /"what":"detach"/.test(fs.readFileSync(path.join(ctx.root, '.web-chat', 'mod', 'bridge.log'), 'utf8')),
      { timeout: 10_000, what: 'the detach at session end' });

    const off = await mod(['off'], { cwd: ctx.root, log: (l) => lines.push(l) });
    assert.equal(off.ok, true, lines.join('\n'));
    assert.equal(hashOf(userSettings), settingsBefore, 'user settings end as they began');
  });
});
