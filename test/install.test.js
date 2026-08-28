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
  try {
    const status = ensureMcpRegistration(root);
    assert.equal(status, 'kept plugin registration');
    await captureInstall(root, { runClaude: (argv) => { calls.push(argv); return { ok: true }; } });
  } finally {
    if (prev !== undefined) process.env.CLAUDE_PLUGIN_ROOT = prev;
    restore();
  }
  const entry = readMcp(root).mcpServers['web-chat'];
  assert.deepEqual(entry.args, ['${CLAUDE_PLUGIN_ROOT}/bin/claude-web-chat-mcp.js'],
    'the committed portable stub is never rewritten to this machine\'s path');
  assert.ok(!mcpEntryHasChannelEnv(entry));
  assert.equal(calls.length, 1, 'and the unresolvable stub is completed at local scope');
  assert.deepEqual(calls[0].slice(0, 6), ['mcp', 'add', 'web-chat', '--scope', 'local', '--']);
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

// ── the root install operates on ─────────────────────────────────────────────
// Typed in a subdirectory, install used to create a SECOND nested install:
// .web-chat/, .claude/settings.json and .mcp.json that Claude Code (which reads
// the project root) never loads — and from then on findProjectRoot resolved the
// nested one for every command run below it. There was no test of it at all.

test('install from a SUBDIRECTORY adopts the enclosing project root', async () => {
  const restore = sandboxHome();
  try {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
    const sub = path.join(root, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });

    const out = await captureInstall(sub, {});

    assert.match(out, new RegExp(`web-chat installed for ${root}`));
    assert.ok(fs.existsSync(path.join(root, '.mcp.json')), 'the parent gets the registration');
    assert.ok(fs.existsSync(path.join(root, '.claude', 'settings.json')));
    assert.equal(fs.existsSync(path.join(sub, '.web-chat')), false, 'and no second nested surface is created');
    assert.equal(fs.existsSync(path.join(sub, '.mcp.json')), false);
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
