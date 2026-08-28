const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { MANAGED_FILES, templatesDir } = require('../lib/update/managed-files');
// The commands map has ONE source-parser, in test-support/doc-truth.js — the
// doc-truth suite asserts everything else about it (which commands the docs may
// cite, which the README must list).
const { cliCommands } = require('../test-support/doc-truth');

const repoRoot = path.join(__dirname, '..');

// Parity ratchet: this repo dogfoods its own install, but consumers only ever
// receive templates/. An edit to a live managed file that isn't backported to
// its template ships stale (or wrong) guidance to every consumer — the exact
// drift that let the rules template fall a whole feature-set behind.
test('every managed template exists and matches this repo\'s live install', () => {
  for (const { tpl, dest } of MANAGED_FILES) {
    const tplPath = path.join(templatesDir(), tpl);
    const destPath = path.join(repoRoot, dest);
    assert.ok(fs.existsSync(tplPath), `template missing: templates/${tpl}`);
    assert.ok(fs.existsSync(destPath), `live managed file missing: ${dest} (this repo dogfoods the install)`);
    assert.equal(
      fs.readFileSync(destPath, 'utf8'),
      fs.readFileSync(tplPath, 'utf8'),
      `${dest} diverged from templates/${tpl} — backport the edit; consumers only receive the template`
    );
  }
});

// ---------------------------------------------------------------------------
// The `/web-chat` slash command.
//
// It used to be `!claude-web-chat $ARGUMENTS` and nothing else, so a bare
// `/web-chat` ran the CLI with an empty argv and dumped `help` into the chat —
// the product's one in-Claude entry point spent itself printing a command list.
// It now runs a read-only subcommand with no arguments (grounding for the guided
// first render) and still passes any subcommand straight through.

const { execFileSync } = require('child_process');
const os = require('os');

const commandTemplate = fs.readFileSync(path.join(templatesDir(), 'commands', 'web-chat.md'), 'utf8');

// The `!`-prefixed line is what Claude Code executes before the prompt body is
// read. Locate it once; every execution test below drives it for real.
function bashLine() {
  const line = commandTemplate.split('\n').find((l) => l.startsWith('!'));
  assert.ok(line, 'templates/commands/web-chat.md must still execute the CLI via a `!` line');
  return line.slice(1);
}

// Run the template's shell line with a stub `claude-web-chat` on PATH that
// reports the argv it was handed. Proves what the command DOES, not how it reads.
function runTemplate(argumentsValue) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cmd-')));
  const bin = path.join(dir, 'claude-web-chat');
  fs.writeFileSync(bin, '#!/bin/sh\nprintf "ARGV:%s\\n" "$*"\n');
  fs.chmodSync(bin, 0o755);
  const line = bashLine().split('$ARGUMENTS').join(argumentsValue);
  return execFileSync('/bin/sh', ['-c', line], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
  }).trim();
}

test('/web-chat with no arguments runs a real subcommand, not bare `help`', () => {
  const out = runTemplate('');
  assert.match(out, /^ARGV:\S/, 'a bare `/web-chat` must not invoke the CLI with an empty argv — that prints help');
  const sub = out.replace(/^ARGV:/, '').split(/\s+/)[0];
  assert.ok(cliCommands().includes(sub), `no-argument fallback \`${sub}\` is not a registered CLI command`);
  assert.notEqual(sub, 'help', 'the guided path must not be a help dump');
});

test('/web-chat <subcommand> still passes straight through to the CLI', () => {
  assert.equal(runTemplate('status'), 'ARGV:status');
  assert.equal(runTemplate('restart'), 'ARGV:restart');
  assert.equal(runTemplate('trust git-dashboard --deny'), 'ARGV:trust git-dashboard --deny');
});

test('/web-chat with no arguments guides Claude to actually render something', () => {
  for (const needle of ['list_components', 'render', 'signals', 'claude-web-chat open']) {
    assert.ok(
      commandTemplate.includes(needle),
      `the guided start must mention \`${needle}\` — without it the command orients but never puts a pane on screen`
    );
  }
});

// ---------------------------------------------------------------------------
// Service consent moved to the terminal (`claude-web-chat trust`). The rules file
// ships into every user project, so a stale "the surface prompts you" makes Claude
// tell users to click an approve button that does not exist — while the pane sits
// there empty forever.
test('the rules template describes service consent as a terminal command', () => {
  const rules = fs.readFileSync(path.join(templatesDir(), 'rules', 'web-chat.md'), 'utf8');
  assert.ok(
    /claude-web-chat trust/.test(rules),
    'the rules must name `claude-web-chat trust` — it is the only thing that can approve a service'
  );
  assert.ok(
    !/\*\*First run prompts the user\*\*/.test(rules),
    'the surface no longer prompts for service approval; the decision is a terminal command'
  );
});
