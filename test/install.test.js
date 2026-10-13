const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ensureMcpRegistration, channelEnv, stripChannelEnv, mcpEntryHasChannelEnv, ensureGitignore } = require('../lib/update/managed-files');

// `install` (via ensureMcpRegistration) writes the channels opt-in
// into the PROJECT's .mcp.json. All tests operate on a tmp root so the dogfood
// repo's own tracked .mcp.json is never touched.
function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-install-')));
}

function readMcp(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
}

function writeMcp(root, obj) {
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify(obj, null, 2) + '\n');
}

// Channels is a SESSION property, not a project one: it exists only when Claude
// Code was launched with the capability flag. Pinning WEB_CHAT_CHANNEL=1 into
// .mcp.json made the MCP server start a channel bridge in EVERY session, so a
// Push in a flag-less session was written to stdout, self-acked, reported
// "Delivered to Claude ✓" — and dropped, with the parked fallback never running.
// install must therefore never write it; the launch line supplies it.
test('install does NOT pin WEB_CHAT_CHANNEL into a fresh .mcp.json entry', () => {
  const root = tmpRoot();
  const status = ensureMcpRegistration(root);
  assert.equal(status, 'web-chat server registered');
  const entry = readMcp(root).mcpServers['web-chat'];
  assert.equal(entry.command, 'node');
  assert.ok(path.isAbsolute(entry.args[0]) && /bin\/claude-web-chat-mcp\.js$/.test(entry.args[0]));
  assert.equal(entry.env, undefined, 'no env block at all when there is nothing to put in it');
  assert.ok(!mcpEntryHasChannelEnv(entry));
});

test('install CLEANS a stale WEB_CHAT_CHANNEL written by an older install', () => {
  const root = tmpRoot();
  writeMcp(root, {
    mcpServers: { 'web-chat': { command: 'node', args: ['/old/path.js'], env: { WEB_CHAT_CHANNEL: '1' } } },
  });
  ensureMcpRegistration(root);
  const entry = readMcp(root).mcpServers['web-chat'];
  assert.ok(!mcpEntryHasChannelEnv(entry), 'stale opt-in removed on upgrade');
  assert.equal(entry.env, undefined, 'no empty env block left behind');
});

test('install is idempotent — re-running produces a byte-identical entry', () => {
  const root = tmpRoot();
  ensureMcpRegistration(root);
  const first = readMcp(root);
  const status = ensureMcpRegistration(root);
  assert.equal(status, 'already up to date');
  const second = readMcp(root);
  assert.deepEqual(second, first);
});

test('install preserves unrelated env keys a user added', () => {
  const root = tmpRoot();
  writeMcp(root, {
    mcpServers: {
      'web-chat': { command: 'node', args: ['/old/path.js'], env: { HTTP_PROXY: 'http://proxy:8080', DEBUG: 'wc:*' } },
    },
  });
  ensureMcpRegistration(root);
  const entry = readMcp(root).mcpServers['web-chat'];
  // No channel opt-in written...
  assert.ok(!mcpEntryHasChannelEnv(entry));
  // ...and the user's own keys survive untouched.
  assert.equal(entry.env.HTTP_PROXY, 'http://proxy:8080');
  assert.equal(entry.env.DEBUG, 'wc:*');
  // Command/args are still rewritten to the resolvable absolute bin.
  assert.equal(entry.command, 'node');
  assert.ok(/bin\/claude-web-chat-mcp\.js$/.test(entry.args[0]));
});

test('install preserves other mcpServers entries', () => {
  const root = tmpRoot();
  writeMcp(root, { mcpServers: { other: { command: 'foo' } } });
  ensureMcpRegistration(root);
  const mcp = readMcp(root);
  assert.deepEqual(mcp.mcpServers.other, { command: 'foo' });
  assert.ok(!mcpEntryHasChannelEnv(mcp.mcpServers['web-chat']));
});

test('install preserves a plugin-portable entry when running under plugin packaging', () => {
  const root = tmpRoot();
  writeMcp(root, {
    mcpServers: {
      'web-chat': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/claude-web-chat-mcp.js'] },
    },
  });
  const prev = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_ROOT = '/plugin/root';
  try {
    const status = ensureMcpRegistration(root);
    assert.equal(status, 'kept plugin registration');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = prev;
  }
  const entry = readMcp(root).mcpServers['web-chat'];
  // Portable args untouched, and no channels opt-in pinned into the committed stub.
  assert.deepEqual(entry.args, ['${CLAUDE_PLUGIN_ROOT}/bin/claude-web-chat-mcp.js']);
  assert.ok(!mcpEntryHasChannelEnv(entry));
});

// FLIPPED, deliberately. This test used to assert that install REWRITES a
// committed ${CLAUDE_PLUGIN_ROOT} stub to this machine's absolute path whenever
// the env var is unset — which is every dogfooding session in this repo, and is
// how a /Users/<someone>/… path got into a tracked .mcp.json once already.
// `doctor`, facing the identical entry, was deliberately taught the opposite:
// leave the committed file alone and register at Claude Code's LOCAL scope,
// which overrides .mcp.json for this project only. Two commands, one file, two
// contradictory policies; doctor's is the one that survives.
//
// The stub is preserved here, and lib/setup/registration.apply() completes the
// fix by running the same `claude mcp add --scope local` doctor runs (asserted
// below) — so the placeholder that cannot resolve still ends up spawning.
test('install PRESERVES a portable entry outside plugin packaging and registers at local scope', async () => {
  const restore = sandboxHome();
  const root = tmpRoot();
  writeMcp(root, {
    mcpServers: {
      'web-chat': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/claude-web-chat-mcp.js'] },
    },
  });
  const prev = process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.CLAUDE_PLUGIN_ROOT;
  const calls = [];
  const cwds = [];
  try {
    const status = ensureMcpRegistration(root);
    assert.equal(status, 'kept plugin registration');
    await captureInstall(root, {
      runClaude: (argv, opts = {}) => { calls.push(argv); cwds.push(opts.cwd); return { ok: true }; },
    });
  } finally {
    if (prev !== undefined) process.env.CLAUDE_PLUGIN_ROOT = prev;
    restore();
  }
  const entry = readMcp(root).mcpServers['web-chat'];
  assert.deepEqual(entry.args, ['${CLAUDE_PLUGIN_ROOT}/bin/claude-web-chat-mcp.js'],
    'the committed portable stub is never rewritten to this machine\'s path');
  assert.ok(!mcpEntryHasChannelEnv(entry));
  // The second run is the mod's read-only probe (ruling C1 (b): install
  // switches the mod on where Claude Code can run it; this fake answers no
  // version, so nothing more runs).
  assert.equal(calls.length, 2, 'and the unresolvable stub is completed at local scope');
  assert.deepEqual(calls[1], ['--version']);
  assert.deepEqual(calls[0].slice(0, 6), ['mcp', 'add', 'web-chat', '--scope', 'local', '--']);
  // `--scope local` keys the registration to the directory `claude` runs in, so
  // the cwd is half the command: shelling out from the shell's cwd would register
  // a project install never examined. Record it, not just the argv.
  assert.equal(cwds[0], root, 'the shell-out runs from the resolved root');
});

test('channelEnv merges without mutating the input and never drops keys', () => {
  const input = { FOO: 'bar' };
  const out = channelEnv(input);
  assert.deepEqual(out, { FOO: 'bar', WEB_CHAT_CHANNEL: '1' });
  assert.deepEqual(input, { FOO: 'bar' }, 'input not mutated');
  // Non-object / array inputs degrade to a clean env with just the opt-in.
  assert.deepEqual(channelEnv(undefined), { WEB_CHAT_CHANNEL: '1' });
  assert.deepEqual(channelEnv([]), { WEB_CHAT_CHANNEL: '1' });
});

test('stripChannelEnv drops only the opt-in, without mutating the input', () => {
  const input = { FOO: 'bar', WEB_CHAT_CHANNEL: '1' };
  assert.deepEqual(stripChannelEnv(input), { FOO: 'bar' });
  assert.deepEqual(input, { FOO: 'bar', WEB_CHAT_CHANNEL: '1' }, 'input not mutated');
  // Nothing left to keep → undefined, so no empty `env: {}` is written.
  assert.equal(stripChannelEnv({ WEB_CHAT_CHANNEL: '1' }), undefined);
  assert.equal(stripChannelEnv(undefined), undefined);
  assert.equal(stripChannelEnv([]), undefined);
});


// ── .gitignore ───────────────────────────────────────────────────────────────
// CLAUDE.md, docs/export-pages.md and docs/capture-profiles-and-panes.md all
// state that `.web-chat/` is gitignored. Nothing ever wrote the line, so every
// project was one `git add -A` from committing its graph, portfile and drafts.

test('ensureGitignore appends the rule, preserves what is there, and is idempotent', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');

  assert.equal(ensureGitignore(root), 'added');
  const body = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(body, /^node_modules\/$/m, 'existing rules survive');
  assert.match(body, /^\.web-chat\/$/m);

  assert.equal(ensureGitignore(root), 'already-present');
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), body, 'byte-identical on re-run');
});

test('ensureGitignore respects a rule the user already wrote, in any form', () => {
  for (const existing of ['.web-chat', '.web-chat/', '/.web-chat/']) {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), `${existing}\n`);
    assert.equal(ensureGitignore(root), 'already-present', `${existing} already covers it`);
    assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), `${existing}\n`);
  }
});

test('ensureGitignore does not litter a non-git directory', () => {
  const root = tmpRoot();  // no .git, no .gitignore
  assert.equal(ensureGitignore(root), 'no-gitignore');
  assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
});

test('ensureGitignore creates one in a git repo that has none', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  assert.equal(ensureGitignore(root), 'added');
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.web-chat\/$/m);
});

// With the git answers registration passes down (U96): inside a work tree, git
// decides whether .web-chat/ is already ignored there, so a subfolder of a
// repository is judged by the repository's rules, not by its own .git.
test('ensureGitignore with git answers: a work-tree subfolder with no coverage gets its own line', () => {
  const sub = tmpRoot();  // no .git here: a subfolder of a repository
  assert.equal(ensureGitignore(sub, { git: { inWorkTree: true, ignored: false } }), 'added');
  assert.equal(fs.readFileSync(path.join(sub, '.gitignore'), 'utf8'),
    '\n# claude-web-chat per-project state (graph, components, portfile, drafts)\n.web-chat/\n');
  // An existing file is appended to, with what it held kept.
  const other = tmpRoot();
  fs.writeFileSync(path.join(other, '.gitignore'), 'dist/');
  assert.equal(ensureGitignore(other, { git: { inWorkTree: true, ignored: false } }), 'added');
  assert.match(fs.readFileSync(path.join(other, '.gitignore'), 'utf8'), /^dist\/\n\n# claude-web-chat[^]*\n\.web-chat\/\n$/);
});

test('ensureGitignore with git answers: already ignored writes nothing; dryRun writes nothing', () => {
  const sub = tmpRoot();
  assert.equal(ensureGitignore(sub, { git: { inWorkTree: true, ignored: true } }), 'already-present');
  assert.equal(fs.existsSync(path.join(sub, '.gitignore')), false);
  assert.equal(ensureGitignore(sub, { dryRun: true, git: { inWorkTree: true, ignored: false } }), 'added');
  assert.equal(fs.existsSync(path.join(sub, '.gitignore')), false, 'dryRun: "would add", nothing written');
});

test('ensureGitignore with git answers: outside a work tree it is today\'s rule, and a bare folder gets nothing', () => {
  const bare = tmpRoot();
  assert.equal(ensureGitignore(bare, { git: { inWorkTree: false, ignored: false } }), 'no-gitignore');
  assert.equal(fs.existsSync(path.join(bare, '.gitignore')), false);
  // Without the answers at all: exactly as before (covered by the tests above).
  assert.equal(ensureGitignore(bare), 'no-gitignore');
});

// Against a real repository: what git itself says, through the registration
// engine that asks it (apply passes the answers down).
test('ensureGitignore through apply, in a real repository: unanchored root rule covers a subfolder, anchored does not', (t) => {
  const restore = sandboxHome();
  t.after(restore);
  const reg = require('../lib/setup/registration');
  const noClaude = () => ({ ok: false, notFound: true });
  for (const [rootRule, expect] of [['.web-chat/\n', 'already-present'], ['/.web-chat/\n', 'added'], [null, 'added']]) {
    const repo = tmpRoot();
    gitInit(repo);
    if (rootRule) fs.writeFileSync(path.join(repo, '.gitignore'), rootRule);
    const sub = path.join(repo, 'pkg');
    fs.mkdirSync(sub);
    const dry = reg.apply(sub, { dryRun: true, runClaude: noClaude });
    assert.equal(dry.gitignore, expect, `dry run, root rule ${JSON.stringify(rootRule)}`);
    assert.equal(fs.existsSync(path.join(sub, '.gitignore')), false, 'the dry run wrote nothing');
    assert.equal(reg.inspect(sub).gitignore, expect === 'added' ? 'absent' : 'covered');
    const applied = reg.apply(sub, { runClaude: noClaude });
    assert.equal(applied.gitignore, expect);
    assert.equal(fs.existsSync(path.join(sub, '.gitignore')), expect === 'added');
    assert.ok(gitIgnored(repo, 'pkg/.web-chat/'), 'either way git ignores it now');
    const rootIgnore = path.join(repo, '.gitignore');
    assert.equal(fs.existsSync(rootIgnore) ? fs.readFileSync(rootIgnore, 'utf8') : null, rootRule,
      'the repository root\'s .gitignore is never edited for a subfolder');
  }
});

// ── `install(args, { nextSteps })` ───────────────────────────────────────────
// `claude-web-chat init` calls install IN-PROCESS and prints its own, fuller
// closing checklist (it knows whether a browser opened and whether a tour is
// waiting). The one behaviour change install grew for that is a gate on the
// trailing next-steps block; everything above it — the result table, the
// conflict/differs warnings, the pre-warm line — must still print verbatim.
//
// The daemon pre-warm is patched out BEFORE install is first required, so this
// test never forks a real background server. install destructures spawnDaemon at
// module load, so the patch has to happen first.
const daemonMod = require('../lib/util/daemon');
const realSpawnDaemon = daemonMod.spawnDaemon;
daemonMod.spawnDaemon = async () => null;
const install = require('../lib/cli/commands/install');
daemonMod.spawnDaemon = realSpawnDaemon;

// The root is PASSED, not chdir'd into: install resolves it through the
// registration engine, so a test no longer has to mutate global process state —
// and `runClaude` is stubbed so no test can shell out to a real `claude`.
async function captureInstall(root, opts) {
  const prevLog = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await install([], { cwd: root, runClaude: () => ({ ok: true }), ...opts });
  } finally {
    console.log = prevLog;
  }
  return lines.join('\n');
}

function sandboxHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-install-home-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  return () => {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  };
}

test('install prints its next-steps checklist by default', async () => {
  const restore = sandboxHome();
  try {
    const out = await captureInstall(tmpRoot(), {});
    assert.match(out, /web-chat installed for/);
    assert.match(out, /Next steps:/);
    assert.match(out, /Optional — Channels/);
  } finally {
    restore();
  }
});

// upgrade-stale-daemons-other-projects: `install` is the step the upgrade
// notes send the user to in every other project, so a daemon still running
// the previous build there is restarted onto this one.
test('install asks restartIfStale about THIS project\'s daemon before the pre-warm', async () => {
  const restore = sandboxHome();
  try {
    const root = tmpRoot();
    const seen = [];
    await captureInstall(root, { restartIfStale: async (r) => { seen.push(r); return { restarted: false }; } });
    assert.deepEqual(seen, [root]);
  } finally {
    restore();
  }
});

test('install({nextSteps:false}) suppresses ONLY the trailing checklist', async () => {
  const restore = sandboxHome();
  try {
    const out = await captureInstall(tmpRoot(), { nextSteps: false });
    assert.match(out, /web-chat installed for/, 'the result header still prints');
    assert.match(out, /\.mcp\.json/, 'the result table still prints');
    assert.match(out, /Server (pre-warmed|will start)/, 'the pre-warm line still prints');
    assert.doesNotMatch(out, /Next steps:/);
    assert.doesNotMatch(out, /Optional — Channels/);
  } finally {
    restore();
  }
});

// One file, one paragraph. A `differs` row can also carry an unmerged `.new`:
// the baseline is lost while a conflict is outstanding, the file still diverges
// from shipped, and the reconcile deliberately keeps the sidecar. Both reporting
// blocks then matched it, so the user was told to merge-and-delete the sidecar
// AND, immediately below, that the file differs "with no recorded baseline" and
// to run `install --force` — two next steps for one file, one of which discards
// the very edits the other is preserving.
test('a differs row with an unmerged .new sidecar is reported once, not twice', async () => {
  const restore = sandboxHome();
  try {
    const mf = require('../lib/update/managed-files');
    const rules = mf.MANAGED_FILES.find((f) => f.dest.endsWith('rules/web-chat.md'));
    const shipped = fs.readFileSync(path.join(mf.templatesDir(), rules.tpl), 'utf8');
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
    // The staged state: locally edited, a sidecar beside it, no baseline.
    const dest = path.join(root, rules.dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, shipped + '\n<!-- my edit -->\n');
    fs.writeFileSync(dest + '.new', shipped);

    const out = await captureInstall(root, { nextSteps: false });
    const results = mf.reconcileManagedFiles(root, { dryRun: true });
    const row = results.find((r) => r.dest === rules.dest);
    assert.equal(row.action, 'differs', 'the case only exists for a differs row that kept its sidecar');
    assert.equal(row.pending, true);

    assert.match(out, /unmerged \.new sidecar/, 'the sidecar reminder — the step that terminates — is kept');
    assert.doesNotMatch(out, /differ from the shipped template with no recorded baseline/,
      'and the file is not ALSO reported as unexplained drift with `--force` as the way out');
  } finally {
    restore();
  }
});

// ── the root install operates on ─────────────────────────────────────────────
// 0.8.0 made install typed in a subdirectory ADOPT the enclosing project root.
// 0.8.5 (U96, the maintainer's call): install sets up the folder it is typed in,
// or the one named, even inside another install; the 0.8.0 rule is kept behind
// --nearest-parent. The chat side is unchanged: a Claude Code session started in
// a child folder still uses the nearest install above it (resolveRoot's other
// modes, which every other command keeps).

async function captureInstallArgs(args, cwd, opts = {}) {
  const prevLog = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await install(args, { cwd, runClaude: () => ({ ok: true }), ...opts });
  } finally {
    console.log = prevLog;
  }
  return lines.join('\n');
}

test('install from a SUBDIRECTORY of an install sets up the subdirectory, and says the parent has its own', async () => {
  const restore = sandboxHome();
  try {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
    const sub = path.join(root, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });

    const out = await captureInstall(sub, {});

    assert.match(out, new RegExp(`web-chat installed for ${sub}`));
    assert.ok(fs.existsSync(path.join(sub, '.web-chat')), 'its own .web-chat/');
    assert.ok(fs.existsSync(path.join(sub, '.claude', 'settings.json')), 'its own hooks');
    const lines = out.split('\n');
    const note = lines.findIndex((l) => l === `(${root} has its own web-chat; this sets up a separate one for ${sub}: `
      + `Claude Code sessions started in ${sub} or below use it. --nearest-parent updates ${root} instead.)`);
    assert.ok(note >= 0, `the enclosing line, in:\n${out}`);
    assert.ok(note < lines.findIndex((l) => l.startsWith('web-chat installed for')), 'printed before the result table');
    assert.deepEqual(fs.readdirSync(root).sort(), ['.web-chat', 'packages'], 'the parent is untouched');
    assert.deepEqual(fs.readdirSync(path.join(root, '.web-chat')), []);
  } finally {
    restore();
  }
});

test('install --nearest-parent from a SUBDIRECTORY adopts the enclosing project root (0.8.0\'s rule)', async () => {
  const restore = sandboxHome();
  try {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
    const sub = path.join(root, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });

    const out = await captureInstallArgs(['--nearest-parent'], sub);

    assert.match(out, new RegExp(`web-chat installed for ${root}`));
    assert.match(out, new RegExp(`\\(typed in ${sub} — installing into the enclosing project root\\)`));
    assert.doesNotMatch(out, /has its own web-chat/);
    assert.ok(fs.existsSync(path.join(root, '.mcp.json')), 'the parent gets the registration');
    assert.ok(fs.existsSync(path.join(root, '.claude', 'settings.json')));
    assert.equal(fs.existsSync(path.join(sub, '.web-chat')), false, 'and no second nested surface is created');
    assert.equal(fs.existsSync(path.join(sub, '.mcp.json')), false);

    // With nothing installed above, --nearest-parent sets up the folder itself.
    const bare = tmpRoot();
    await captureInstallArgs(['--nearest-parent'], bare);
    assert.ok(fs.existsSync(path.join(bare, '.web-chat')));
  } finally {
    restore();
  }
});

test('install <folder> sets up that folder, relative or absolute, and never the cwd', async () => {
  const restore = sandboxHome();
  try {
    const cwd = tmpRoot();
    fs.mkdirSync(path.join(cwd, 'rel'));
    const out = await captureInstallArgs(['rel'], cwd);
    assert.match(out, new RegExp(`web-chat installed for ${path.join(cwd, 'rel')}`));
    assert.ok(fs.existsSync(path.join(cwd, 'rel', '.web-chat')));
    assert.ok(fs.existsSync(path.join(cwd, 'rel', '.claude', 'settings.json')));

    const abs = tmpRoot();
    const seen = [];
    await captureInstallArgs([abs], cwd, { restartIfStale: async (r) => { seen.push(r); return { restarted: false }; } });
    assert.ok(fs.existsSync(path.join(abs, '.web-chat')));
    assert.deepEqual(seen, [abs], 'the daemon asked about is the folder\'s');
    assert.deepEqual(fs.readdirSync(cwd), ['rel'], 'nothing written in the cwd');
  } finally {
    restore();
  }
});

test('install refuses a missing folder, a file and two folders, writing nothing', async () => {
  const restore = sandboxHome();
  try {
    const cwd = tmpRoot();
    fs.writeFileSync(path.join(cwd, 'notes.txt'), 'x');
    fs.mkdirSync(path.join(cwd, 'a'));
    fs.mkdirSync(path.join(cwd, 'b'));
    const cases = [
      [['missing'], new RegExp(`${path.join(cwd, 'missing')} does not exist`)],
      [['notes.txt'], new RegExp(`${path.join(cwd, 'notes.txt')} is not a folder`)],
      [['a', 'b'], /takes one folder, not 2: a b/],
      [['a', 'b', '--nearest-parent'], /takes one folder, not 2: a b/],
    ];
    for (const [args, re] of cases) {
      let out = '';
      await assert.rejects(
        async () => { out = await captureInstallArgs(args, cwd); },
        (e) => e.userFacing === true && re.test(e.message)
          && /Usage: claude-web-chat install \[folder\] \[--nearest-parent\]/.test(e.message),
      );
      assert.equal(out, '');
    }
    assert.deepEqual(fs.readdirSync(cwd).sort(), ['a', 'b', 'notes.txt'], 'nothing created, the missing folder included');
    assert.deepEqual(fs.readdirSync(path.join(cwd, 'a')), []);
    assert.deepEqual(fs.readdirSync(path.join(cwd, 'b')), []);
  } finally {
    restore();
  }
});

test('install refuses $HOME named as the folder, in both modes, before writing anything', async () => {
  const restore = sandboxHome();
  try {
    const home = process.env.HOME;
    fs.mkdirSync(path.join(home, '.web-chat', 'versions'), { recursive: true });
    const cwd = tmpRoot();
    for (const args of [[home], [home, '--nearest-parent'], [fs.realpathSync(home), '--nearest-parent']]) {
      await assert.rejects(
        () => captureInstallArgs(args, cwd),
        (e) => e.userFacing === true && /is your home directory — web-chat does not install here/.test(e.message),
      );
    }
    assert.deepEqual(fs.readdirSync(home), ['.web-chat']);
    assert.deepEqual(fs.readdirSync(path.join(home, '.web-chat')), ['versions']);
    assert.deepEqual(fs.readdirSync(cwd), []);
  } finally {
    restore();
  }
});

// A subfolder install inside a repository has to end up ignored by git. The
// line goes in the folder's own .gitignore, unless the repository already
// ignores it there.
function gitInit(dir) {
  require('child_process').execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}
function gitIgnored(cwd, rel) {
  try {
    require('child_process').execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

test('a default install in a subfolder of a git repository leaves its .web-chat/ ignored by git', async () => {
  const restore = sandboxHome();
  try {
    const repo = tmpRoot();
    gitInit(repo);
    const sub = path.join(repo, 'apps', 'web');
    fs.mkdirSync(sub, { recursive: true });
    assert.equal(gitIgnored(repo, 'apps/web/.web-chat/'), false);

    const out = await captureInstall(sub, {});

    assert.ok(gitIgnored(repo, 'apps/web/.web-chat/'), `git check-ignore says ignored:\n${out}`);
    assert.match(fs.readFileSync(path.join(sub, '.gitignore'), 'utf8'), /^\.web-chat\/$/m, 'the line is in the folder\'s own .gitignore');
    assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false, 'the repository root\'s is left alone');
    assert.match(out, /\.gitignore +\.web-chat\/ added/);
  } finally {
    restore();
  }
});

// R2-4. Since 0.8 no daemon can be rooted at $HOME, but `install` there still
// wrote machine-wide hooks into ~/.claude/settings.json and a ~/.mcp.json,
// first-touched the user tier, and promised "Server will start on your first
// open" — which `start` then refused. It now refuses before writing a byte.
test('install in $HOME throws userFacing and writes nothing', async () => {
  const restore = sandboxHome();
  try {
    const home = process.env.HOME;
    // The user tier every machine has (install.sh makes it).
    fs.mkdirSync(path.join(home, '.web-chat', 'versions'), { recursive: true });
    const stale = [];
    for (const cwd of [home, fs.realpathSync(home)]) {
      let out = '';
      await assert.rejects(
        async () => { out = await captureInstall(cwd, { restartIfStale: async (r) => { stale.push(r); return { restarted: false }; } }); },
        (e) => e.userFacing === true
          && /is your home directory — web-chat does not install here/.test(e.message)
          && /no surface can be rooted at \$HOME/.test(e.message)
          && /claude-web-chat uninstall/.test(e.message),
      );
      assert.equal(out, '', 'nothing is reported as installed');
    }
    assert.deepEqual(fs.readdirSync(home), ['.web-chat'], 'no .claude/, no .mcp.json, no .gitignore');
    assert.deepEqual(fs.readdirSync(path.join(home, '.web-chat')), ['versions'], 'and the user tier is not first-touched');
    assert.deepEqual(stale, [], 'no daemon is asked about, let alone started');
  } finally {
    restore();
  }
});

test('install THROWS userFacing on a malformed settings.json instead of exiting', async () => {
  const restore = sandboxHome();
  try {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{ not json');
    await assert.rejects(
      () => captureInstall(root, {}),
      // process.exit(1) here killed `init` mid-sequence: before the onboarding
      // stamp, before the restart instructions, and before prompt.close().
      (e) => e.userFacing === true && /error parsing/.test(e.message),
    );
  } finally {
    restore();
  }
});
