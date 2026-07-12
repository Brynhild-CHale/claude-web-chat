// Smoke coverage for the three-scope toggle (lib/toggle). Most-restrictive-wins:
// user (~/.web-chat/disabled) · project (cwd/.web-chat, absent = not installed =
// silent no-op) · session (~/.web-chat/sessions/<id>.json {enabled:false}).
// Isolated via withTempHome (HOME redirect) + explicit tmp cwds — never the real
// ~/.web-chat or the dev repo's own .web-chat.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { withTempHome, tmpRoot } = require('../test-support/helpers');
const scopes = require('../lib/toggle/scopes');
const policy = require('../lib/toggle/policy');

// A dir with NO .web-chat (project "not installed").
function bareDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wc-bare-'));
}

test('user scope: off by default, on when ~/.web-chat/disabled exists', (t) => {
  const home = withTempHome(t);
  assert.equal(scopes.user.isDisabled(), false);
  fs.mkdirSync(path.join(home, '.web-chat'), { recursive: true });
  fs.writeFileSync(path.join(home, '.web-chat', 'disabled'), '');
  assert.equal(scopes.user.isDisabled(), true);
});

test('project scope: not-installed is disabled; installed toggles on the marker', () => {
  assert.equal(scopes.project.isDisabled({ cwd: bareDir() }), true); // no .web-chat
  const proj = tmpRoot('wc-proj-'); // tmpRoot() creates .web-chat
  assert.equal(scopes.project.isDisabled({ cwd: proj }), false);
  fs.writeFileSync(path.join(proj, '.web-chat', 'disabled'), '');
  assert.equal(scopes.project.isDisabled({ cwd: proj }), true);
});

test('session scope: only {enabled:false} disables; missing/garbage is safe', (t) => {
  const home = withTempHome(t);
  assert.equal(scopes.session.isDisabled({}), false); // no sessionId
  assert.equal(scopes.session.isDisabled({ sessionId: 's1' }), false); // no file
  const sdir = path.join(home, '.web-chat', 'sessions');
  fs.mkdirSync(sdir, { recursive: true });
  const f = path.join(sdir, 's1.json');
  fs.writeFileSync(f, JSON.stringify({ enabled: false }));
  assert.equal(scopes.session.isDisabled({ sessionId: 's1' }), true);
  fs.writeFileSync(f, JSON.stringify({ enabled: true }));
  assert.equal(scopes.session.isDisabled({ sessionId: 's1' }), false);
  fs.writeFileSync(f, 'not json{');
  assert.equal(scopes.session.isDisabled({ sessionId: 's1' }), false); // does not throw
});

test('policy.resolve: most-restrictive-wins with scope attribution', (t) => {
  const home = withTempHome(t);
  const proj = tmpRoot('wc-proj-');
  assert.deepEqual(policy.resolve({ cwd: proj }), { enabled: true });
  // project not installed -> disabled, attributed to project
  assert.deepEqual(policy.resolve({ cwd: bareDir() }), { enabled: false, by: 'project' });
  // user AND project both disabled -> user wins (first in ALL_SCOPES)
  fs.mkdirSync(path.join(home, '.web-chat'), { recursive: true });
  fs.writeFileSync(path.join(home, '.web-chat', 'disabled'), '');
  fs.writeFileSync(path.join(proj, '.web-chat', 'disabled'), '');
  assert.deepEqual(policy.resolve({ cwd: proj }), { enabled: false, by: 'user' });
});

test('policy.resolve: scope subset ignores session; unknown scope is skipped', (t) => {
  const home = withTempHome(t);
  const proj = tmpRoot('wc-proj-');
  const sdir = path.join(home, '.web-chat', 'sessions');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'x.json'), JSON.stringify({ enabled: false }));
  // the MCP gate uses scopes:['user','project'] — a disabled session is invisible to it
  assert.deepEqual(policy.resolve({ scopes: ['user', 'project'], cwd: proj, sessionId: 'x' }), { enabled: true });
  // an unknown scope name is skipped without throwing
  assert.deepEqual(policy.resolve({ scopes: ['bogus', 'user'], cwd: proj }), { enabled: true });
});
