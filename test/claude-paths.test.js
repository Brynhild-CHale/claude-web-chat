// Every path the 0.8.5 release reads or writes, from the one path authority
// (lib/core/paths): Claude Code's user tier and its project slug, the chat
// mirror's files, the project identity's (dark variants included), the asks
// audit, and the control layer's (the halt flags among them). The spec names
// them in §2.1 (the paths row), §9.2 (the identity's files), §4.3 and §15; one
// unit mints them all, so no later unit edits lib/core/paths.js.
//
// Three properties beyond "the right string":
//   * an id that names a file is checked, never joined raw: a session, turn or
//     node id outside [A-Za-z0-9_-]{1,100}, and a pid that is not a positive
//     integer, get null, so no outside value can form a path;
//   * userPaths().haltFlag(id) is exactly <home>/.web-chat/halt/<id>, because
//     the POSIX halt script spells that path itself;
//   * every accessor is pure: none touches the filesystem.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { withTempHome } = require('../test-support/helpers');
const {
  projectPaths, userPaths, claudePaths, userClaudePaths,
  claudeConfigDir, claudeProjectSlug, isSafeId,
} = require('../lib/core/paths');

const ROOT = '/srv/acme-web';
const WC = path.join(ROOT, '.web-chat');
const SID = '0b6f7c1e-4c1d-4a8e-9a43-5d2f0e3c9b11'; // a Claude Code session id
const TURN = '7d1e2f3a-5b6c-4d7e-8f90-a1b2c3d4e5f6'; // a transcript promptId

// Set CLAUDE_CONFIG_DIR (or, with undefined, unset it) for one test.
function configDirFor(t, value) {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  if (value === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = value;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  });
}

// Claude Code's own state under a config dir, as userClaudePaths() names it.
function claudeTier(config) {
  return {
    configDir: config,
    claudeSettings: path.join(config, 'settings.json'),
    claudeSkillsDir: path.join(config, 'skills'),
    claudeCommandsDir: path.join(config, 'commands'),
    projectsDir: path.join(config, 'projects'),
    sessionsDir: path.join(config, 'sessions'),
    plansDir: path.join(config, 'plans'),
    fileHistoryDir: path.join(config, 'file-history'),
    skillsSyncedDir: path.join(config, 'skills', 'synced'),
    pluginsDir: path.join(config, 'plugins'),
    installedPlugins: path.join(config, 'plugins', 'installed_plugins.json'),
    pluginsSyncedDir: path.join(config, 'plugins', 'synced'),
  };
}

// ── Claude Code's user tier ─────────────────────────────────────────────────

test('claudeConfigDir is CLAUDE_CONFIG_DIR when set, else <home>/.claude', (t) => {
  const home = withTempHome(t);
  configDirFor(t, undefined);
  assert.equal(claudeConfigDir(), path.join(home, '.claude'));

  process.env.CLAUDE_CONFIG_DIR = '';
  assert.equal(claudeConfigDir(), path.join(home, '.claude'), 'an empty value counts as unset');

  process.env.CLAUDE_CONFIG_DIR = '/opt/claude-work';
  assert.equal(claudeConfigDir(), '/opt/claude-work');
  process.env.CLAUDE_CONFIG_DIR = '/opt/claude-work/';
  assert.equal(claudeConfigDir(), '/opt/claude-work', 'normalised');
  process.env.CLAUDE_CONFIG_DIR = 'claude-rel';
  assert.equal(claudeConfigDir(), path.resolve('claude-rel'), 'a relative value resolves as any fs call would');
});

test('without CLAUDE_CONFIG_DIR the whole Claude tier is <home>/.claude', (t) => {
  const home = withTempHome(t);
  configDirFor(t, undefined);
  const config = path.join(home, '.claude');
  const cp = userClaudePaths();

  for (const [key, want] of Object.entries(claudeTier(config))) assert.equal(cp[key], want, key);
  assert.equal(cp.projectDir('/Users/me/My Project'), path.join(config, 'projects', '-Users-me-My-Project'));
  assert.equal(cp.claudeSessionStateFile(4242), path.join(config, 'sessions', '4242.json'));
  // The --global pack tier is the same directory in the usual case, so the two
  // views of the user's settings, skills and commands name the same paths.
  assert.equal(cp.dir, config);
  assert.equal(cp.skillDir('acme-ops'), path.join(config, 'skills', 'acme-ops'));
  assert.equal(cp.claudeSettings, cp.settings);
  assert.equal(cp.claudeSkillsDir, cp.skillsDir);
  assert.equal(cp.claudeCommandsDir, cp.commandsDir);
});

test('with CLAUDE_CONFIG_DIR, Claude Code\'s state moves there and the --global pack tier stays in the home directory', (t) => {
  const home = withTempHome(t);
  const config = '/opt/claude-work';
  configDirFor(t, config);
  const cp = userClaudePaths();

  for (const [key, want] of Object.entries(claudeTier(config))) assert.equal(cp[key], want, key);
  assert.equal(cp.projectDir('/srv/acme-web'), path.join(config, 'projects', '-srv-acme-web'));
  assert.equal(cp.claudeSessionStateFile(7), path.join(config, 'sessions', '7.json'));

  // Claude Code reads the user's settings, skills and commands from the
  // variable's directory too, so its view of them (the `/` catalog's user
  // skills and commands, and the `enabledPlugins` that gate the plugins)
  // follows it, beside the plugins it gates.
  assert.equal(cp.claudeSettings, path.join(config, 'settings.json'));
  assert.equal(cp.claudeSkillsDir, path.join(config, 'skills'));
  assert.equal(cp.claudeCommandsDir, path.join(config, 'commands'));
  assert.equal(path.dirname(cp.claudeSettings), path.dirname(cp.pluginsDir), 'the user settings sit beside the plugins they gate');
  assert.equal(path.dirname(cp.skillsSyncedDir), cp.claudeSkillsDir, 'and the synced bucket inside the user skills');

  // lib/packs fences a system-tier unit to the home directory
  // (lib/packs/tree.js recordAnchor), so where a --global pack's skill goes
  // does not follow the variable.
  assert.equal(cp.dir, path.join(home, '.claude'));
  assert.equal(cp.settings, path.join(home, '.claude', 'settings.json'));
  assert.equal(cp.skillsDir, path.join(home, '.claude', 'skills'));
  assert.equal(cp.commandsDir, path.join(home, '.claude', 'commands'));
  assert.equal(cp.skillDir('acme-ops'), path.join(home, '.claude', 'skills', 'acme-ops'));
  assert.equal(cp.skill('acme-ops'), path.join(home, '.claude', 'skills', 'acme-ops', 'SKILL.md'));
  for (const [claudeKey, packKey] of [['claudeSettings', 'settings'], ['claudeSkillsDir', 'skillsDir'], ['claudeCommandsDir', 'commandsDir']]) {
    assert.notEqual(cp[claudeKey], cp[packKey], `${claudeKey} is Claude Code's view, ${packKey} the pack tier's`);
  }
});

test('the user tier has no settings.local.json: personal overrides are per project', (t) => {
  withTempHome(t);
  configDirFor(t, undefined);
  assert.equal(userClaudePaths().settingsLocal, undefined, 'without CLAUDE_CONFIG_DIR');
  process.env.CLAUDE_CONFIG_DIR = '/opt/claude-work';
  assert.equal(userClaudePaths().settingsLocal, undefined, 'with CLAUDE_CONFIG_DIR');
  assert.equal(claudePaths(ROOT).settingsLocal, path.join(ROOT, '.claude', 'settings.local.json'), 'the project keeps its own');
});

test('claudePaths(root) gains settings.local.json beside settings.json', () => {
  const cp = claudePaths(ROOT);
  assert.equal(cp.settings, path.join(ROOT, '.claude', 'settings.json'));
  assert.equal(cp.settingsLocal, path.join(ROOT, '.claude', 'settings.local.json'));
});

// ── the project slug ────────────────────────────────────────────────────────
// Expected values were produced by the validation prototype,
// design/chat-mirror-validation/claude-slug.js, as
// claudeSlug(path, { realpath: false }) (2026-10-02). The two long paths past
// 200 units cover both signs of the Java hash (the second and third are
// negative, the fourth positive), and the 200-unit one sits on the boundary.

const SLUGS = [
  ['/Users/me/web-chat-dev', '-Users-me-web-chat-dev'],
  ['/Users/me/My Project', '-Users-me-My-Project'],
  ['/private/tmp/v8.proj_a b', '-private-tmp-v8-proj-a-b'],
  ['/Users/me/.config/app.v2', '-Users-me--config-app-v2'],
  ['/Users/me/café', '-Users-me-caf-'],                 // é precomposed: one unit
  ['/Users/me/café', '-Users-me-cafe-'],               // e + combining acute
  ['/Users/me/项目', '-Users-me---'],                // CJK
  ['/Users/me/notes \u{1F4C1}', '-Users-me-notes---'],       // an emoji is two units
  ['/', '-'],
  ['/' + 'a'.repeat(199), '-' + 'a'.repeat(199)],            // 200 units: no hash
  ['/' + 'a'.repeat(200), '-' + 'a'.repeat(199) + '-b6ymvl'], // 201: hashed
  ['/Users/me/' + 'deep/'.repeat(40) + 'proj-0', '-Users-me-' + 'deep-'.repeat(38) + '-qp1cyn'],
  ['/Users/me/' + 'deep/'.repeat(40) + 'proj-10', '-Users-me-' + 'deep-'.repeat(38) + '-ot6hxq'],
];

test('claudeProjectSlug matches the validation prototype: spaces, dots, unicode, and past 200 units', () => {
  for (const [dir, want] of SLUGS) {
    assert.equal(claudeProjectSlug(dir), want, JSON.stringify(dir));
    assert.match(want, /^[A-Za-z0-9-]+$/, 'a slug is one safe path segment');
  }
});

test('claudeProjectSlug takes an absolute path only, normalised, and never touches the disk', (t) => {
  configDirFor(t, '/opt/claude-work');
  assert.equal(claudeProjectSlug('/Users/me/web-chat-dev/'), '-Users-me-web-chat-dev', 'a trailing slash');
  assert.equal(claudeProjectSlug('/Users/me/./x/../web-chat-dev'), '-Users-me-web-chat-dev', 'dot segments');
  for (const bad of ['web-chat-dev', './web-chat-dev', '', null, undefined, 42, {}]) {
    assert.equal(claudeProjectSlug(bad), null, JSON.stringify(bad));
    assert.equal(userClaudePaths().projectDir(bad), null, JSON.stringify(bad));
  }
  // The physical path is the caller's to supply: a path that crosses a link is
  // slugged as written, not as it resolves.
  assert.equal(claudeProjectSlug('/tmp/proj'), '-tmp-proj');
});

// ── the project tier ────────────────────────────────────────────────────────

test('projectPaths(root): the chat mirror\'s files', () => {
  const p = projectPaths(ROOT);
  const mirror = path.join(WC, 'mirror');
  assert.equal(p.mirrorDir, mirror);
  assert.equal(p.mirrorConversations, path.join(mirror, 'conversations.json'));
  assert.equal(p.mirrorIndexDir, path.join(mirror, 'index'));
  assert.equal(p.mirrorIndex(SID), path.join(mirror, 'index', `${SID}.json`));
  assert.equal(p.mirrorDiffsDir, path.join(mirror, 'diffs'));
  assert.equal(p.mirrorDiff(TURN), path.join(mirror, 'diffs', `${TURN}.json`));
  assert.equal(p.mirrorNodeDiff('n12'), path.join(mirror, 'diffs', 'node-n12.json'));
  assert.equal(p.mirrorGit, path.join(mirror, 'git'));
  assert.equal(p.mirrorTmp, path.join(mirror, 'tmp'));
});

test('projectPaths(root): the identity\'s files, dark variants included, as extension-less bases', () => {
  const p = projectPaths(ROOT);
  assert.equal(p.projectJson, path.join(WC, 'project.json'));
  const bases = {
    projectLogo: 'project-logo',
    projectLogoDark: 'project-logo-dark',
    projectFavicon: 'project-favicon',
    projectFaviconDark: 'project-favicon-dark',
    projectTouchIcon: 'project-touch-icon',
  };
  for (const [key, name] of Object.entries(bases)) {
    assert.equal(p[key], path.join(WC, name), key);
    assert.equal(path.extname(p[key]), '', `${key}: lib/core/image-file adds .svg or .png`);
  }
  // Outside .web-chat/brand/, which U00's v2→v3 migration owns.
  for (const key of Object.keys(bases)) assert.ok(!p[key].startsWith(p.brandDir + path.sep), key);
});

test('projectPaths(root): the asks audit and the control layer', () => {
  const p = projectPaths(ROOT);
  assert.equal(p.asksDir, path.join(WC, 'asks'));
  assert.equal(p.asksAudit, path.join(WC, 'asks', 'audit.log'));
  assert.equal(p.controlDir, path.join(WC, 'control'));
  assert.equal(p.controlAudit, path.join(WC, 'control', 'audit.log'));
  assert.equal(p.controlRestores, path.join(WC, 'control', 'restores.json'));
  assert.equal(p.modDir, path.join(WC, 'mod'));
  assert.equal(p.attachmentsDir, path.join(WC, 'attachments'));
  assert.equal(p.haltDir, undefined, 'the halt flags are user-tier, not the project\'s');
});

// ── the halt flags ──────────────────────────────────────────────────────────

test('userPaths().haltFlag(id) is exactly <home>/.web-chat/halt/<id>, as the halt script spells it', (t) => {
  const home = withTempHome(t);
  const up = userPaths();
  assert.equal(up.haltDir, path.join(home, '.web-chat', 'halt'));
  assert.equal(up.haltFlag(SID), `${home}/.web-chat/halt/${SID}`);

  // The script (lib/hooks/claude-web-chat-hook-halt.sh) is POSIX sh and builds
  // the path itself from $HOME and $CLAUDE_CODE_SESSION_ID. The same
  // expansion, in sh, gives the same string.
  const sh = spawnSync('sh', ['-c', 'printf %s "$HOME/.web-chat/halt/$CLAUDE_CODE_SESSION_ID"'], {
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_CODE_SESSION_ID: SID },
    encoding: 'utf8',
  });
  assert.equal(sh.status, 0, sh.stderr);
  assert.equal(up.haltFlag(SID), sh.stdout);
});

// ── ids that name a file ────────────────────────────────────────────────────

const GOOD_IDS = [SID, TURN, 'n12', 'a', 'A_b-9', 'x'.repeat(100)];
const BAD_IDS = [
  '..', '.', '/', 'a/b', '../x', 'x/..', '/etc/passwd', 'a\\b',
  'a\0b', '\0', '',                         // NUL and empty
  'x'.repeat(101),                          // over-long
  'a.b', '.hidden', 'a b', '%2e%2e', 'café', 'a\nb', 'a\n',
  null, undefined, 42, {}, [], ['a'], true,
];

test('haltFlag, mirrorIndex, mirrorDiff and mirrorNodeDiff refuse an id that could form a path', (t) => {
  const home = withTempHome(t);
  const p = projectPaths(ROOT);
  const up = userPaths();
  const named = {
    haltFlag: [up.haltFlag, path.join(home, '.web-chat', 'halt'), ''],
    mirrorIndex: [p.mirrorIndex, p.mirrorIndexDir, '.json'],
    mirrorDiff: [p.mirrorDiff, p.mirrorDiffsDir, '.json'],
    mirrorNodeDiff: [p.mirrorNodeDiff, p.mirrorDiffsDir, '.json'],
  };
  for (const [name, [fn, dir, ext]] of Object.entries(named)) {
    for (const id of GOOD_IDS) {
      const got = fn(id);
      assert.equal(path.dirname(got), dir, `${name}(${JSON.stringify(id)})`);
      assert.ok(path.basename(got).endsWith(`${id}${ext}`), `${name}(${JSON.stringify(id)})`);
    }
    for (const id of BAD_IDS) assert.equal(fn(id), null, `${name}(${JSON.stringify(id)})`);
  }
  for (const id of GOOD_IDS) assert.equal(isSafeId(id), true, JSON.stringify(id));
  for (const id of BAD_IDS) assert.equal(isSafeId(id), false, JSON.stringify(id));
});

test('a node\'s diff cache and the turns\' diffs never share a name', () => {
  const p = projectPaths(ROOT);
  assert.equal(p.mirrorDiff('node-n12'), null, 'a turn id spelled like a node cache is refused');
  assert.equal(p.mirrorNodeDiff('n12'), path.join(p.mirrorDiffsDir, 'node-n12.json'));
});

test('claudeSessionStateFile takes a positive integer pid, and nothing else', (t) => {
  configDirFor(t, '/opt/claude-work');
  const cp = userClaudePaths();
  for (const pid of [1, 4242, process.pid, Number.MAX_SAFE_INTEGER]) {
    assert.equal(cp.claudeSessionStateFile(pid), path.join('/opt/claude-work', 'sessions', `${pid}.json`), String(pid));
  }
  for (const pid of [0, -1, 1.5, NaN, Infinity, -Infinity, 2 ** 53, 4242n, '4242', '12a', '../4242', null, undefined, {}, [], [4242], true]) {
    assert.equal(cp.claudeSessionStateFile(pid), null, typeof pid === 'bigint' ? `${pid}n` : JSON.stringify(pid));
  }
});

// ── purity ──────────────────────────────────────────────────────────────────

// Every *Sync function on `fs` (realpathSync.native too), counting calls while
// `fn` runs. Synchronous on purpose: nothing else can run in the window, so a
// call counted is one the accessors made.
function fsCallsDuring(fn) {
  const calls = [];
  const restore = [];
  const wrap = (owner, key, label) => {
    const orig = owner[key];
    const counted = Object.assign(function (...args) { calls.push(label); return orig.apply(this, args); }, orig);
    owner[key] = counted;
    restore.push(() => { owner[key] = orig; });
    return counted;
  };
  try {
    for (const key of Object.keys(fs)) {
      if (typeof fs[key] !== 'function' || !key.endsWith('Sync')) continue;
      const counted = wrap(fs, key, key);
      if (typeof counted.native === 'function') wrap(counted, 'native', `${key}.native`);
    }
    fn();
  } finally {
    for (const undo of restore.reverse()) undo();
  }
  return calls;
}

function touchEveryAccessor() {
  const call = (obj, arg) => { for (const v of Object.values(obj)) if (typeof v === 'function') v(arg); };
  call(projectPaths(ROOT), SID);
  call(userPaths(), SID);
  call(claudePaths(ROOT), 'acme-ops');
  const cp = userClaudePaths();
  call(cp, 'acme-ops');
  cp.projectDir('/Users/me/notes \u{1F4C1}');
  cp.claudeSessionStateFile(4242);
  claudeConfigDir();
  for (const [dir] of SLUGS) claudeProjectSlug(dir);
  isSafeId(SID);
}

test('every accessor is pure: none touches the filesystem, with or without CLAUDE_CONFIG_DIR', (t) => {
  withTempHome(t);
  configDirFor(t, '/opt/claude-work');
  assert.deepEqual(fsCallsDuring(touchEveryAccessor), []);
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.deepEqual(fsCallsDuring(touchEveryAccessor), []);
  // And the counter does count: an fs-backed helper in the same module shows up.
  assert.ok(fsCallsDuring(() => require('../lib/core/paths').realpath(ROOT)).includes('realpathSync'));
});

test('the new project paths all sit inside the project\'s .web-chat/, and the Claude tier inside the config dir', (t) => {
  configDirFor(t, '/opt/claude-work');
  const p = projectPaths(ROOT);
  const keys = [
    'mirrorDir', 'mirrorConversations', 'mirrorIndexDir', 'mirrorDiffsDir', 'mirrorGit', 'mirrorTmp',
    'projectJson', 'projectLogo', 'projectLogoDark', 'projectFavicon', 'projectFaviconDark', 'projectTouchIcon',
    'asksDir', 'asksAudit', 'controlDir', 'controlAudit', 'controlRestores', 'modDir', 'attachmentsDir',
  ];
  for (const key of keys) assert.ok(p[key].startsWith(p.dir + path.sep), key);
  for (const fn of ['mirrorIndex', 'mirrorDiff', 'mirrorNodeDiff']) assert.ok(p[fn](SID).startsWith(p.dir + path.sep), fn);

  const cp = userClaudePaths();
  for (const key of Object.keys(claudeTier('/opt/claude-work')).filter((k) => k !== 'configDir')) {
    assert.ok(cp[key].startsWith(cp.configDir + path.sep), key);
  }
  assert.ok(cp.projectDir('/srv/acme-web').startsWith(cp.projectsDir + path.sep));
  assert.ok(cp.claudeSessionStateFile(1).startsWith(cp.sessionsDir + path.sep));
});
