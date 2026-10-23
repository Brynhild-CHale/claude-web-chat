// `claude-web-chat pack install <url>` of a pack that ships an element type
// (annotation engine tranche 2, U322a; DECISIONS.md K.4, reading (ii): "fully
// approve during install"). With a person at the terminal it is staged as
// `pack get` stages it, its review prints — the element types with their
// draw.js — and the person says yes before anything installs; a no leaves it
// in quarantine with the approve command; --yes accepts. With no one at the
// terminal (a pipe, CI, --no-input) it is refused with the reviewed path, as
// before.
//
// The terminal is lib/cli/prompt's own seam (stdin/stdout/env), handed in
// through `pack(args, {root, promptOpts})`: a stream that says it is a TTY and
// answers each [y/N] in turn. The no-terminal run is the real CLI, spawned.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');

const { packFixture, tmpDir, fakeForge, repoWithArchive } = require('../test-support/packs');
const { withTempHome } = require('../test-support/helpers');
const { projectPaths } = require('../lib/core/paths');
const { readAudit, findPack } = require('../lib/packs/store');
const packs = require('../lib/packs/install');
const pack = require('../lib/cli/commands/pack');

const SHA = 'a'.repeat(40);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>\n';
const DRAW = "export default function draw(el, ctx) { ctx.box(el).textContent = 'sticky'; }\n";

function elementPack({ name = 'mark-pack', type = 'sticky' } = {}) {
  const body = { type, family: 'page', remote: { see: 'read', send: 'full' }, schema: `${type}@1`, reads: [`${type}@1`], anchors: ['element', 'range'] };
  return packFixture({
    name, version: '1.0.0', components: [], skill: false,
    manifest: { name, version: '1.0.0', description: 'Sticky notes on the surface.', elements: [type] },
    extraFiles: {
      [`elements/${type}/element.json`]: JSON.stringify(body, null, 2) + '\n',
      [`elements/${type}/draw.js`]: DRAW,
      [`elements/${type}/assets/icon.svg`]: SVG,
    },
  });
}

function project(t) {
  withTempHome(t);
  const root = tmpDir('wc-pacli-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  // announce() must find no daemon: never the developer's.
  const port = process.env.WEB_CHAT_PORT;
  delete process.env.WEB_CHAT_PORT;
  t.after(() => { if (port !== undefined) process.env.WEB_CHAT_PORT = port; });
  return root;
}

// A terminal that answers each [y/N] question with the next of `answers`,
// and everything the run printed.
function terminal(t, answers) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const asked = [];
  let out = '';
  stdout.on('data', (d) => {
    const s = d.toString();
    out += s;
    if (/\[y\/N\]/.test(s)) {
      asked.push(s.trim());
      const a = answers.shift();
      assert.ok(a !== undefined, `asked more than expected: ${s}`);
      setImmediate(() => stdin.write(`${a}\n`));
    }
  });
  const logged = [];
  t.mock.method(console, 'log', (...a) => { logged.push(a.join(' ')); });
  t.mock.method(process, 'exit', (code) => { throw new Error(`process.exit(${code}): ${logged.join('\n')}`); });
  return {
    promptOpts: { stdin, stdout, env: {}, log: (s) => logged.push(s) },
    asked,
    text: () => `${logged.join('\n')}\n${out}`,
  };
}

const typeDir = (root) => path.join(projectPaths(root).elementTypesDir, 'sticky');
const quarantined = (root) => packs.listInstalled({ root }).quarantined.map((q) => q.name);

test('at a terminal: the review prints, a yes installs it (actor cli), staged first as `pack get` stages it', async (t) => {
  const root = project(t);
  const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack(), { sha: SHA }) } });
  const term = terminal(t, ['y', 'y']);
  await pack(['install', forge.url('acme', 'marks')], { root, promptOpts: term.promptOpts });
  assert.equal(term.asked.length, 2, 'the install question, then the approve question');
  assert.match(term.asked[1], /Install it\? \[y\/N\]/);
  const text = term.text();
  assert.match(text, /"mark-pack" ships element type \(sticky\)/);
  assert.match(text, /element types\n {4}sticky {2}\[schema sticky@1 · reads sticky@1 · anchors element, range · draw\.js — RUNS IN THE SURFACE PAGE\]/, 'the element section as `pack review` prints it');
  assert.equal(fs.readFileSync(path.join(typeDir(root), 'draw.js'), 'utf8'), DRAW);
  assert.deepEqual(findPack(root, 'mark-pack', 'local').pack.elements, ['sticky']);
  assert.deepEqual(quarantined(root), []);
  assert.deepEqual(readAudit(root).slice(-2).map((e) => [e.op, e.actor]), [['quarantine', 'cli'], ['approve', 'cli']]);
});

test('at a terminal: a no leaves it in quarantine, with the approve command', async (t) => {
  const root = project(t);
  const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack(), { sha: SHA }) } });
  const term = terminal(t, ['y', 'n']);
  await pack(['install', forge.url('acme', 'marks')], { root, promptOpts: term.promptOpts });
  assert.equal(term.asked.length, 2);
  assert.match(term.text(), /not installed — "mark-pack" stays in quarantine/);
  assert.match(term.text(), /claude-web-chat pack approve mark-pack/);
  assert.equal(fs.existsSync(typeDir(root)), false, 'nothing installed');
  assert.equal(findPack(root, 'mark-pack', 'local'), null);
  assert.deepEqual(quarantined(root), ['mark-pack'], 'staged for the card or `pack approve`');
});

test('at a terminal, --yes accepts both questions without asking', async (t) => {
  const root = project(t);
  const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack(), { sha: SHA }) } });
  const term = terminal(t, []);
  await pack(['install', forge.url('acme', 'marks'), '--yes'], { root, promptOpts: term.promptOpts });
  assert.equal(term.asked.length, 0);
  assert.match(term.text(), /Install it\? \[y\/N\]\n {2}\(--yes — installing\)/);
  assert.ok(fs.existsSync(path.join(typeDir(root), 'draw.js')));
});

test('at a terminal, a pack with no element type installs straight away, as before (no quarantine, one question)', async (t) => {
  const root = project(t);
  const forge = await fakeForge(t, { repos: { 'acme/ops': repoWithArchive(packFixture({ components: [{ name: 'deploy-board' }] }), { sha: SHA }) } });
  const term = terminal(t, ['y']);
  await pack(['install', forge.url('acme', 'ops')], { root, promptOpts: term.promptOpts });
  assert.equal(term.asked.length, 1);
  assert.equal(findPack(root, 'acme-ops', 'local').pack.name, 'acme-ops');
  assert.deepEqual(quarantined(root), []);
  assert.deepEqual(readAudit(root).map((e) => e.op), ['install']);
});

// ASYNC, deliberately: the fake forge is an HTTP server in THIS process.
function runCli(args, { home, cwd }) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, WEB_CHAT_NO_GH: '1' };
    delete env.WEB_CHAT_PORT;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'claude-web-chat.js'), ...args], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('with no terminal, --yes and --no-input still refuse an element pack with the reviewed path, and stage nothing', async (t) => {
  const home = tmpDir('wc-pacli-home-');
  const proj = tmpDir('wc-pacli-proj-');
  fs.mkdirSync(path.join(proj, '.web-chat'), { recursive: true });
  const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack(), { sha: SHA }) } });
  const url = forge.url('acme', 'marks');
  for (const extra of [['--yes'], ['--yes', '--no-input']]) {
    const r = await runCli(['pack', 'install', url, ...extra], { home, cwd: proj });
    assert.equal(r.status, 1, `${extra.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /"mark-pack" ships element type \(sticky\)\. An element type's draw\.js runs in the surface page's own realm/);
    assert.ok(r.stderr.includes(`claude-web-chat pack get ${url}, then claude-web-chat pack review mark-pack and claude-web-chat pack approve mark-pack`), r.stderr);
    assert.doesNotMatch(r.stdout, /Install it\?/, 'never asked');
  }
  assert.equal(fs.existsSync(path.join(projectPaths(proj).elementTypesDir, 'sticky')), false);
  assert.equal(fs.existsSync(projectPaths(proj).quarantine), false, 'nothing staged');
  // Without --yes there is no one to say yes to the first question either.
  const r = await runCli(['pack', 'install', url], { home, cwd: proj });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /nothing installed/);
});
