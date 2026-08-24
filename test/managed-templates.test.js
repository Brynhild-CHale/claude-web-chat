const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { MANAGED_FILES, templatesDir } = require('../lib/update/managed-files');

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

// The rules file points at bundled docs via `claude-web-chat docs <name>` —
// every name it cites must actually ship in docs/.
test('docs referenced by the rules resolve to bundled docs', () => {
  const rules = fs.readFileSync(path.join(templatesDir(), 'rules', 'web-chat.md'), 'utf8');
  const cited = [...rules.matchAll(/claude-web-chat docs ([a-z0-9-]+)/g)].map(m => m[1]);
  assert.ok(cited.length >= 3, 'rules should cite the contract docs via `claude-web-chat docs <name>`');
  for (const name of cited) {
    assert.ok(
      fs.existsSync(path.join(repoRoot, 'docs', `${name}.md`)),
      `rules cite \`claude-web-chat docs ${name}\` but docs/${name}.md does not exist`
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

// The subcommand names the CLI actually registers.
function cliCommands() {
  const src = fs.readFileSync(path.join(repoRoot, 'lib', 'cli', 'index.js'), 'utf8');
  const block = src.match(/const commands = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'could not locate the commands map in lib/cli/index.js');
  const names = [...block[1].matchAll(/^\s{2}([a-z][a-z-]*):/gm)].map((m) => m[1]);
  assert.ok(names.length > 5, 'commands map parse looks wrong');
  return names;
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
// CLI-reference truth, both directions.

// Prose may discuss a command that no longer exists, but not as a live
// backticked instruction — that is how `claude-web-chat watch` outlived the
// feature it named. A cited command must be one the user can actually run.
// A command that is DESIGNED but not yet built may be cited — the pack format is
// specified ahead of its tooling on purpose — but only in a doc that says so out
// loud, so a reader never mistakes a spec for something they can run. Adding an
// entry here is deliberate; shipping the command should remove it.
const PLANNED = new Map([
  ['pack', { doc: 'docs/component-packs.md', marker: /not built yet/i }],
]);

test('every `claude-web-chat <sub>` cited in the docs is a real CLI command', () => {
  const known = new Set([...cliCommands(), 'help']);
  const files = [
    'README.md',
    'templates/rules/web-chat.md',
    'templates/commands/web-chat.md',
    ...fs.readdirSync(path.join(repoRoot, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`),
  ];
  for (const rel of files) {
    const body = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    for (const m of body.matchAll(/`claude-web-chat ([a-z][a-z-]*)/g)) {
      if (known.has(m[1])) continue;
      const planned = PLANNED.get(m[1]);
      assert.ok(planned, `${rel} cites \`claude-web-chat ${m[1]}\`, which is not a registered command`);
      assert.equal(planned.doc, rel, `only ${planned.doc} may cite the unbuilt \`${m[1]}\` command`);
      assert.match(body, planned.marker,
        `${rel} cites the unbuilt \`claude-web-chat ${m[1]}\` without saying it is unbuilt`);
    }
  }
});

// And the other direction: a command the user is expected to reach for has to be
// discoverable somewhere other than `--help`. `trust` — the ONLY way to approve a
// component's service — and `ls` both shipped documented nowhere at all.
test('README documents every user-facing CLI command', () => {
  // Deliberately absent from the README: `start` is the foreground dev entry
  // point, `hub` is extension plumbing, `profile` is driven by the
  // capture-profile skill. A new user-facing command means a README line or an
  // explicit exemption here.
  const notInReadme = new Set(['start', 'hub', 'profile']);
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  for (const name of cliCommands()) {
    if (notInReadme.has(name)) continue;
    assert.ok(
      new RegExp(`(^|[\`\\s])${name}([\`\\s]|$)`, 'm').test(readme),
      `\`claude-web-chat ${name}\` is not mentioned anywhere in the README`
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
