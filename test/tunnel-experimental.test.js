// Remote access ships as experimental in 0.8.5 (the maintainer's ruling of
// 2026-10-15): every place a user meets it says it is unstable and used at
// their own risk — the tunnel command's usage, `setup` and `up` before anything
// else, the CLI help, the browser setup page, the portal's page, the docs, the
// README, the rules Claude reads and the release notes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const tunnel = require('../lib/cli/commands/tunnel');
const { main } = require('../lib/cli');
const { withTempHome } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const { EXPERIMENTAL_NOTE } = tunnel;
const RISK = /experimental[\s\S]*unstable[\s\S]*at your own risk/i;

test('the note says experimental, unstable and at your own risk', () => {
  assert.match(EXPERIMENTAL_NOTE, RISK);
});

test('tunnel help: the note is the line after the usage line', async () => {
  const lines = [];
  await tunnel(['help'], { log: (s) => lines.push(String(s)) });
  assert.equal(lines.join('\n').split('\n')[1], EXPERIMENTAL_NOTE);
});

test('the CLI help says it under the tunnel command', (t) => {
  const out = [];
  const prev = console.log;
  console.log = (s) => out.push(String(s));
  t.after(() => { console.log = prev; });
  main(['help']);
  console.log = prev;
  assert.match(out.join('\n'), /^ {2}tunnel <setup\|up\|down\|status\|logs>\n {24}EXPERIMENTAL and unstable: use it at your own risk\./m);
});

test('tunnel up and tunnel setup say it first, before they do (or refuse) anything', async (t) => {
  withTempHome(t);
  const env = { ...process.env };
  delete env.WEB_CHAT_HOST;

  const up = [];
  await assert.rejects(tunnel(['up'], { log: (s) => up.push(String(s)), env, waitMs: 200 }), /tunnel setup/);
  assert.equal(up[0], EXPERIMENTAL_NOTE, 'up: the note, then the refusal (no config here)');

  const setup = [];
  const prompt = { line: async () => '', secret: async () => '', confirm: async (q, { def = false } = {}) => def, close() {} };
  const noNetwork = async () => { throw new Error('no network in this test'); };
  try {
    await tunnel(['setup', '--no-input'], { log: (s) => setup.push(String(s)), prompt, env, fetchJwks: noNetwork });
  } catch { /* an empty setup is refused; only its first line matters here */ }
  assert.equal(setup[0], EXPERIMENTAL_NOTE, 'setup: the note first');
});

test('the browser setup page and the portal\'s page show it', () => {
  const page = read('lib/server/tunnel-setup/public/index.html');
  const banner = /<p id="experimental" class="banner warn">([\s\S]*?)<\/p>/.exec(page);
  assert.ok(banner, 'the setup page\'s banner');
  assert.match(banner[1], RISK);
  assert.ok(page.indexOf('id="experimental"') < page.indexOf('id="st-h"'), 'above the status card');

  const portal = read('lib/portal/public/index.html');
  const line = /<p id="experimental">([\s\S]*?)<\/p>/.exec(portal);
  assert.ok(line, 'the portal page\'s line');
  assert.match(line[1], RISK);
});

test('the docs, the README, the rules and the release notes say it', () => {
  assert.match(read('docs/remote-access.md').split('\n').slice(0, 8).join('\n'), /\*\*Experimental\.\*\*[\s\S]*at your own risk/,
    'remote-access.md opens with it');
  assert.match(read('README.md'), /`claude-web-chat tunnel` puts[^\n]*experimental and unstable: use it at your own risk/);
  assert.match(read('templates/rules/web-chat.md'), /Remote access \(`claude-web-chat tunnel`\) is experimental and unstable/);
  assert.match(read('docs/guide.md'), /^tunnel \[verb\] +EXPERIMENTAL and unstable \(use it at your own risk\)/m);
  const cl = read('CHANGELOG.md');
  const unreleased = cl.slice(cl.indexOf('## ['), cl.indexOf('## [', cl.indexOf('## [') + 4));
  assert.match(unreleased.split('### ')[0], /\*\*Remote access is experimental\.\*\*[\s\S]*at your own risk/,
    'the release notes open with it, before Upgrading');
});
