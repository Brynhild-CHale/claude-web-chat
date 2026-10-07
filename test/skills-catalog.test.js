// lib/server/skills.js — the composer's `/` catalog (spec §6.2, U58; ruling D1 (c)).
//
// Built on the claude-home fixture with `isolate: true`, so CLAUDE_CONFIG_DIR
// points at a private tier and the pack tier (<home>/.claude) is somewhere
// else: the catalog must read the first and never the second.
//
// What is pinned:
//   * the base set is the listing; disk sources (project and user skills,
//     project and user commands, enabled plugins' skills and commands, synced
//     skills and synced plugins) and their origins, a plugin named
//     `plugin:name`, a disabled plugin absent;
//   * reconcile: an unlisted disk skill or command newer than the
//     conversation's current session start is offered, an older one is not,
//     none is with no start known, a user-only one never is; a listed name with
//     no disk source is kept as 'session'; a listed name whose SKILL.md now
//     says disable-model-invocation is dropped;
//   * BUILTIN_COMMANDS are never offered (commands/help.md, a listed compact);
//   * the synced bucket: the org's; with no org one bucket; with several only
//     listed names;
//   * the org and account ids appear in no answer; the account id is handed to
//     redactor.addKnown once;
//   * a decoy in the pack tier never appears; an installPath outside
//     pluginsDir, a symlinked skill directory, SKILL.md or command, and a
//     plugin's or synced plugin's skills/commands directory symlinked out are
//     not followed;
//   * no listing → disk, partial; descriptions SKILL.md first, capped, redacted;
//     at most ENTRIES_MAX;
//   * createSkillCatalog: the session start read from the snapshot's current
//     session, the primary conversation when none is named, resolve and lookup,
//     the memo's lazy expiry.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { userClaudePaths } = require('../lib/core/paths');
const { catalog, createSkillCatalog, ENTRIES_MAX, DESCRIPTION_MAX } = require('../lib/server/skills');
const { BUILTIN_COMMANDS } = require('../lib/server/composer');

const ORG = 'aaaa1111-org0-4000-8000-000000000001';
const ACCT = 'bbbb2222-acct-4000-8000-000000000002';
const ORG2 = 'cccc3333-org0-4000-8000-000000000003';
const ACCT2 = 'dddd4444-acct-4000-8000-000000000004';
const START = Date.UTC(2026, 9, 7, 12, 0, 0);
const OLD = START - 3600_000;
const NEW = START + 60_000;

function md({ name, description, userOnly = false } = {}) {
  const lines = ['---'];
  if (name) lines.push(`name: ${name}`);
  if (description) lines.push(`description: ${description}`);
  if (userOnly) lines.push('disable-model-invocation: true');
  lines.push('---', '', 'body', '');
  return lines.join('\n');
}

function touch(p, ms) {
  const s = ms / 1000;
  fs.utimesSync(p, s, s);
  return p;
}

function fakeRedactor() {
  const r = {
    known: [],
    texts: [],
    addKnown(value, label) { r.known.push([value, label]); return true; },
    text(s) { r.texts.push(s); return String(s).replace(/hunter2-secret/g, 'MASKED'); },
  };
  return r;
}

// A project root and an isolated Claude tier. Every file is written OLD
// unless the caller dates it.
function setup(t) {
  const root = fs.mkdtempSync(path.join(SANDBOX, 'wc-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ch = claudeHome(t, { root, isolate: true });
  const proj = (rel, data, ms = OLD) => {
    const p = path.join(root, '.claude', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    return touch(p, ms);
  };
  const user = (rel, data, ms = OLD) => touch(ch.write(rel, data), ms);
  return { root, ch, proj, user };
}

// The standard tree: one source of every kind.
function standardTree(h, { org = ORG, acct = ACCT } = {}) {
  h.proj('skills/proj-skill/SKILL.md', md({ name: 'proj-skill', description: 'A project skill.' }));
  h.user('skills/user-skill/SKILL.md', md({ name: 'user-skill', description: 'A user skill.' }));
  h.proj('commands/proj-cmd.md', md({ description: 'A project command.' }));
  h.user('commands/user-cmd.md', 'No frontmatter: a command still runs.\n');
  const cache = path.join(h.ch.dir, 'plugins', 'cache', 'market');
  h.user('plugins/cache/market/acme/1.0.0/skills/deploy/SKILL.md', md({ name: 'deploy', description: 'Deploy things.' }));
  h.user('plugins/cache/market/acme/1.0.0/commands/ship.md', md({ description: 'Ship it.' }));
  h.user('plugins/cache/market/off/1.0.0/skills/hidden/SKILL.md', md({ name: 'hidden', description: 'From a disabled plugin.' }));
  h.user('plugins/installed_plugins.json', JSON.stringify({
    version: 2,
    plugins: {
      'acme@market': [{ scope: 'user', installPath: path.join(cache, 'acme', '1.0.0'), version: '1.0.0' }],
      'off@market': [{ scope: 'user', installPath: path.join(cache, 'off', '1.0.0'), version: '1.0.0' }],
    },
  }));
  h.user('settings.json', JSON.stringify({ enabledPlugins: { 'acme@market': true, 'off@market': true } }));
  h.proj('settings.local.json', JSON.stringify({ enabledPlugins: { 'off@market': false } }));
  h.user(`skills/synced/${org}_${acct}/docx/SKILL.md`, md({ name: 'docx', description: 'Word documents.' }));
  h.user(`skills/synced/${org}_${acct}/manifest.json`, JSON.stringify({ skills: [] }));
  h.user(`plugins/synced/${org}_${acct}/anthropic-skills/skills/pdf/SKILL.md`, md({ name: 'pdf', description: 'PDF files.' }));
}

const LISTING = Object.freeze({
  names: ['proj-skill', 'user-skill', 'proj-cmd', 'user-cmd', 'acme:deploy', 'acme:ship', 'anthropic-skills:docx',
    'anthropic-skills:pdf', 'simplify', 'compact'],
  descriptions: { simplify: 'Review the changed code.', 'proj-skill': 'The listing\'s own words.' },
  orgUuid: ORG,
});

const byName = (r) => Object.fromEntries(r.skills.map((s) => [s.name, s]));

test('with a listing: the base set is the listing, with each disk source\'s origin', async (t) => {
  const h = setup(t);
  standardTree(h);
  const r = await catalog({ root: h.root, listing: LISTING, sessionStart: START, redactor: fakeRedactor() });
  assert.equal(r.source, 'session');
  assert.equal(r.partial, false);
  assert.ok(Number.isFinite(r.as_of));
  assert.deepStrictEqual(Object.keys(r).sort(), ['as_of', 'partial', 'skills', 'source']);
  assert.deepStrictEqual(r.skills.map((s) => [s.name, s.origin]), [
    ['proj-skill', 'project'],
    ['user-skill', 'user'],
    ['proj-cmd', 'command'],
    ['user-cmd', 'command'],
    ['acme:deploy', 'plugin'],
    ['acme:ship', 'plugin'],
    ['anthropic-skills:docx', 'synced'],
    ['anthropic-skills:pdf', 'synced'],
    ['simplify', 'session'],
  ]);
  for (const s of r.skills) assert.deepStrictEqual(Object.keys(s), ['name', 'description', 'origin']);
  assert.ok(!r.skills.some((s) => /hidden/.test(s.name)), 'a disabled plugin\'s skill is absent');
});

test('reconcile: an unlisted disk skill or command is offered only when newer than the session start', async (t) => {
  const h = setup(t);
  standardTree(h);
  h.proj('skills/new-skill/SKILL.md', md({ name: 'new-skill', description: 'Added mid-session.' }), NEW);
  h.proj('commands/new-cmd.md', md({ description: 'Added mid-session too.' }), NEW);
  h.proj('skills/new-but-user-only/SKILL.md', md({ name: 'new-but-user-only', userOnly: true }), NEW);
  h.user('skills/old-skill/SKILL.md', md({ name: 'old-skill' }), OLD);
  h.user('plugins/cache/market/acme/1.0.0/skills/fresh/SKILL.md', md({ name: 'fresh' }), NEW);

  const r = await catalog({ root: h.root, listing: LISTING, sessionStart: START });
  const got = byName(r);
  assert.equal(got['new-skill'] && got['new-skill'].origin, 'project');
  assert.equal(got['new-cmd'] && got['new-cmd'].origin, 'command');
  assert.equal(got['acme:fresh'] && got['acme:fresh'].origin, 'plugin');
  assert.equal(got['old-skill'], undefined, 'older than the session start: the listing would hold it');
  assert.equal(got['new-but-user-only'], undefined, 'a user-only skill is never offered, however new');
  // Listing order first, then the additions in disk order.
  assert.deepStrictEqual(r.skills.slice(-3).map((s) => s.name), ['new-skill', 'new-cmd', 'acme:fresh']);

  const none = await catalog({ root: h.root, listing: LISTING, sessionStart: null });
  for (const n of ['new-skill', 'new-cmd', 'acme:fresh']) assert.equal(byName(none)[n], undefined, `${n}: no start known`);
  assert.equal(none.skills.length, LISTING.names.length - 1);
});

test('reconcile: a listed name with no disk source is kept as session; one now user-only is dropped', async (t) => {
  const h = setup(t);
  standardTree(h);
  h.proj('skills/proj-skill/SKILL.md', md({ name: 'proj-skill', description: 'Now user-only.', userOnly: true }));
  h.user('skills/verify/SKILL.md', md({ name: 'verify', userOnly: true }), NEW);
  const r = await catalog({ root: h.root, listing: { ...LISTING, names: [...LISTING.names, 'ghost'] }, sessionStart: START });
  const got = byName(r);
  assert.equal(got['proj-skill'], undefined);
  assert.equal(got.verify, undefined);
  assert.deepStrictEqual(got.ghost, { name: 'ghost', description: '', origin: 'session' });
  assert.equal(got.simplify.origin, 'session');
  const disk = await catalog({ root: h.root, listing: null });
  assert.equal(byName(disk).verify, undefined, 'a user-only skill never appears from disk either');
  assert.equal(byName(disk)['proj-skill'], undefined);
});

test('BUILTIN_COMMANDS are never offered: commands/help.md and a listed compact', async (t) => {
  const h = setup(t);
  standardTree(h);
  h.proj('commands/help.md', md({ description: 'Shadowing a built-in.' }), NEW);
  h.user('skills/Clear/SKILL.md', md({ name: 'Clear' }), NEW);
  for (const listing of [LISTING, { ...LISTING, names: [...LISTING.names, 'help', 'model'] }, null]) {
    const r = await catalog({ root: h.root, listing, sessionStart: START });
    const names = r.skills.map((s) => s.name.toLowerCase());
    for (const b of BUILTIN_COMMANDS) assert.ok(!names.includes(b), `${b} offered (listing ${listing ? 'set' : 'null'})`);
  }
});

test('the synced bucket: the org\'s is read; another org\'s is not', async (t) => {
  const h = setup(t);
  standardTree(h);
  h.user(`skills/synced/${ORG}_${ACCT}/pptx/SKILL.md`, md({ name: 'pptx', description: 'Slides.' }), NEW);
  h.user(`skills/synced/${ORG2}_${ACCT2}/xlsx/SKILL.md`, md({ name: 'xlsx', description: 'Sheets.' }), NEW);
  const r = await catalog({ root: h.root, listing: LISTING, sessionStart: START });
  const got = byName(r);
  assert.equal(got['anthropic-skills:pptx'] && got['anthropic-skills:pptx'].origin, 'synced',
    'an unlisted new synced skill is spelled anthropic-skills:<name>');
  assert.ok(!r.skills.some((s) => /xlsx/.test(s.name)), 'another organisation\'s bucket is not read');
  assert.equal(got['anthropic-skills:docx'].description, 'Word documents.');
});

test('the synced bucket: no org and one bucket → that one; several → only listed names', async (t) => {
  const h = setup(t);
  standardTree(h);
  const one = await catalog({ root: h.root, listing: null });
  assert.equal(byName(one)['anthropic-skills:docx'] && byName(one)['anthropic-skills:docx'].origin, 'synced',
    'one bucket, disk only: anthropic-skills:<name> (U58b), never bare');
  assert.equal(byName(one).docx, undefined);
  assert.equal(byName(one)['anthropic-skills:pdf'].origin, 'synced');

  h.user(`skills/synced/${ORG2}_${ACCT2}/xlsx/SKILL.md`, md({ name: 'xlsx', description: 'Sheets.' }), NEW);
  h.user(`skills/synced/${ORG}_${ACCT}/pptx/SKILL.md`, md({ name: 'pptx' }), NEW);
  const noOrg = { ...LISTING, orgUuid: null };
  const several = await catalog({ root: h.root, listing: noOrg, sessionStart: START });
  const got = byName(several);
  assert.equal(got['anthropic-skills:docx'].origin, 'synced', 'a listed synced name is matched');
  assert.equal(got['anthropic-skills:docx'].description, 'Word documents.');
  assert.ok(!several.skills.some((s) => /xlsx|pptx/.test(s.name)), 'several buckets: nothing unlisted is added');
  const severalDisk = await catalog({ root: h.root, listing: null });
  assert.ok(!severalDisk.skills.some((s) => s.origin === 'synced'), 'several buckets, nothing listed: no synced skill');
});

// U58b: Claude Code (2.1.292) names every synced skill (loadedFrom
// 'syncedSkills') `anthropic-skills:<name>`; its bare name is only an alias it
// drops whenever another command holds that name. So the catalog spells it
// that way whatever the listing holds, and never borrows a plugin's namespace.
test('U58b: a synced skill is never offered under a plugin\'s namespace that also holds its name', async (t) => {
  const h = setup(t);
  const cache = path.join(h.ch.dir, 'plugins', 'cache', 'market');
  h.user('plugins/cache/market/document-skills/1.0.0/skills/docx/SKILL.md', md({ name: 'docx', description: 'Plugin docx.' }));
  h.user('plugins/installed_plugins.json', JSON.stringify({
    version: 2,
    plugins: { 'document-skills@market': [{ scope: 'user', installPath: path.join(cache, 'document-skills', '1.0.0') }] },
  }));
  h.user('settings.json', JSON.stringify({ enabledPlugins: { 'document-skills@market': true } }));
  h.user(`skills/synced/${ORG}_${ACCT}/docx/SKILL.md`, md({ name: 'docx', description: 'Synced docx.' }));
  h.user(`skills/synced/${ORG}_${ACCT}/pptx/SKILL.md`, md({ name: 'pptx', description: 'Synced pptx.' }), NEW);
  const listing = { names: ['document-skills:docx', 'anthropic-skills:docx'], descriptions: {}, orgUuid: ORG };
  const r = await catalog({ root: h.root, listing, sessionStart: START });
  assert.deepStrictEqual(r.skills.map((s) => [s.name, s.origin, s.description]), [
    ['document-skills:docx', 'plugin', 'Plugin docx.'],
    ['anthropic-skills:docx', 'synced', 'Synced docx.'],
    ['anthropic-skills:pptx', 'synced', 'Synced pptx.'],
  ]);
  assert.ok(!r.skills.some((s) => s.name === 'document-skills:pptx'), 'a plugin namespace is never borrowed');

  // Several buckets ('listed' mode): a synced skill matches only its own
  // spelling, never a plugin's entry ending in the same name.
  h.user(`skills/synced/${ORG2}_${ACCT2}/xlsx/SKILL.md`, md({ name: 'xlsx' }));
  const several = await catalog({ root: h.root, listing: { names: ['document-skills:docx'], descriptions: {}, orgUuid: null }, sessionStart: START });
  assert.deepStrictEqual(several.skills.map((s) => [s.name, s.origin]), [['document-skills:docx', 'plugin']]);
});

test('U58b: with no listing, a synced skill is offered as anthropic-skills:<name>, never bare', async (t) => {
  const h = setup(t);
  standardTree(h);
  h.user(`skills/synced/${ORG}_${ACCT}/pptx/SKILL.md`, md({ name: 'pptx', description: 'Slides.' }));
  const r = await catalog({ root: h.root, listing: null });
  const synced = r.skills.filter((s) => s.origin === 'synced').map((s) => s.name);
  assert.deepStrictEqual(synced, ['anthropic-skills:docx', 'anthropic-skills:pptx', 'anthropic-skills:pdf']);
  for (const bare of ['docx', 'pptx']) assert.ok(!r.skills.some((s) => s.name === bare), `${bare} offered bare`);

  // A listing naming no synced skill: still the namespace, never bare.
  const fresh = await catalog({ root: h.root, listing: { names: ['proj-skill'], descriptions: {}, orgUuid: ORG }, sessionStart: OLD - 1 });
  assert.ok(byName(fresh)['anthropic-skills:docx'], 'an unlisted synced skill takes its own namespace');
  assert.ok(!fresh.skills.some((s) => s.name === 'docx' || s.name === 'pptx'), 'never bare');

  // resolve answers 'skill' only for the catalog's own spelling.
  const inst = createSkillCatalog({ root: h.root });
  assert.equal(await inst.resolve('anthropic-skills:docx'), 'skill');
  assert.equal(await inst.resolve('docx'), null);
});

test('the organisation and account ids never leave; the account id is registered once', async (t) => {
  const h = setup(t);
  standardTree(h);
  h.user(`skills/synced/${ORG2}_${ACCT2}/xlsx/SKILL.md`, md({ name: 'xlsx' }));
  const redactor = fakeRedactor();
  const answers = [];
  answers.push(await catalog({ root: h.root, listing: LISTING, sessionStart: START, redactor }));
  answers.push(await catalog({ root: h.root, listing: null, redactor }));
  const inst = createSkillCatalog({ root: h.root, redactor, mirror: { skillFold: () => LISTING, snapshot: () => ({ primary: 'c1', conversations: [] }) } });
  answers.push(await inst.catalog('c1'));
  answers.push(await inst.lookup('anthropic-skills:docx', 'c1'));
  const all = JSON.stringify(answers);
  for (const id of [ORG, ACCT, ORG2, ACCT2]) assert.ok(!all.includes(id), 'an id leaked');
  assert.deepStrictEqual(redactor.known.filter(([v]) => v === ACCT), [[ACCT, 'account']]);
  assert.deepStrictEqual(redactor.known.filter(([v]) => v === ACCT2), [[ACCT2, 'account']]);
  assert.ok(!redactor.known.some(([v]) => v === ORG || v === ORG2), 'only account ids are registered here');
});

test('CLAUDE_CONFIG_DIR: user skills come from the config dir; the pack tier is never read', async (t) => {
  const h = setup(t);
  standardTree(h);
  const tier = userClaudePaths();
  assert.notEqual(tier.skillsDir, tier.claudeSkillsDir, 'the fixture isolates the Claude tier');
  const decoy = path.join(tier.skillsDir, 'decoy-skill');
  const decoyCmd = path.join(tier.commandsDir, 'decoy-cmd.md');
  fs.mkdirSync(decoy, { recursive: true });
  fs.mkdirSync(path.dirname(decoyCmd), { recursive: true });
  t.after(() => { fs.rmSync(decoy, { recursive: true, force: true }); fs.rmSync(decoyCmd, { force: true }); });
  fs.writeFileSync(path.join(decoy, 'SKILL.md'), md({ name: 'decoy-skill' }));
  fs.writeFileSync(decoyCmd, md({ description: 'decoy' }));
  fs.writeFileSync(tier.settings, JSON.stringify({ enabledPlugins: { 'off@market': true } }));
  t.after(() => fs.rmSync(tier.settings, { force: true }));

  for (const listing of [null, LISTING]) {
    const r = await catalog({ root: h.root, listing, sessionStart: 0 });
    assert.equal(byName(r)['user-skill'].origin, 'user');
    assert.ok(!r.skills.some((s) => /decoy|hidden/.test(s.name)), 'the pack tier is not Claude Code\'s');
  }
});

test('a path handed by installed_plugins.json outside pluginsDir is ignored; symlinks are not followed', async (t) => {
  const h = setup(t);
  standardTree(h);
  const outside = fs.mkdtempSync(path.join(SANDBOX, 'wc-skills-out-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outside, 'skills', 'escaped'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'skills', 'escaped', 'SKILL.md'), md({ name: 'escaped' }));
  fs.writeFileSync(path.join(outside, 'linked.md'), md({ description: 'through a link' }));
  const plugins = JSON.parse(fs.readFileSync(path.join(h.ch.dir, 'plugins', 'installed_plugins.json'), 'utf8'));
  plugins.plugins['evil@market'] = [{ scope: 'user', installPath: outside }];
  // Inside pluginsDir by name, out by a symlink.
  fs.symlinkSync(outside, path.join(h.ch.dir, 'plugins', 'cache', 'sneaky'));
  plugins.plugins['sneaky@market'] = [{ scope: 'user', installPath: path.join(h.ch.dir, 'plugins', 'cache', 'sneaky') }];
  plugins.plugins['dotdot@market'] = [{ scope: 'user', installPath: path.join(h.ch.dir, 'plugins', '..', '..', path.basename(outside)) }];
  h.user('plugins/installed_plugins.json', JSON.stringify(plugins));
  h.user('settings.json', JSON.stringify({ enabledPlugins: { 'acme@market': true, 'evil@market': true, 'sneaky@market': true, 'dotdot@market': true } }));
  // A symlinked skill directory, a symlinked SKILL.md and a symlinked command.
  fs.symlinkSync(path.join(outside, 'skills', 'escaped'), path.join(h.root, '.claude', 'skills', 'linked-dir'));
  fs.mkdirSync(path.join(h.root, '.claude', 'skills', 'linked-file'));
  fs.symlinkSync(path.join(outside, 'skills', 'escaped', 'SKILL.md'), path.join(h.root, '.claude', 'skills', 'linked-file', 'SKILL.md'));
  fs.symlinkSync(path.join(outside, 'linked.md'), path.join(h.root, '.claude', 'commands', 'linked-cmd.md'));
  fs.symlinkSync(path.join(outside, 'skills', 'escaped'), path.join(h.ch.dir, 'skills', 'user-linked'));

  const r = await catalog({ root: h.root, listing: null });
  const names = r.skills.map((s) => s.name);
  for (const bad of ['evil:escaped', 'sneaky:escaped', 'dotdot:escaped', 'linked-dir', 'linked-file', 'linked-cmd', 'user-linked', 'escaped']) {
    assert.ok(!names.includes(bad), `${bad} offered`);
  }
  assert.ok(names.includes('acme:deploy'), 'a fenced plugin is still read');
  const listed = await catalog({ root: h.root, listing: { names: ['linked-dir'], descriptions: {}, orgUuid: ORG }, sessionStart: START });
  assert.deepStrictEqual(listed.skills, [{ name: 'linked-dir', description: '', origin: 'session' }],
    'a listed name is kept, but nothing is read through the link');
});

test('a plugin\'s skills or commands directory, or a synced plugin\'s skills, symlinked out is not followed', async (t) => {
  const h = setup(t);
  standardTree(h);
  const outside = fs.mkdtempSync(path.join(SANDBOX, 'wc-skills-out-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outside, 'skills', 'leak'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'skills', 'leak', 'SKILL.md'), md({ name: 'leak', description: 'SECRET-OUTSIDE' }));
  fs.mkdirSync(path.join(outside, 'commands'));
  fs.writeFileSync(path.join(outside, 'commands', 'leakcmd.md'), md({ description: 'SECRET-OUTSIDE' }));
  // An install directory that is real and inside pluginsDir, whose skills and
  // commands directories are symlinks out of it.
  const install = path.join(h.ch.dir, 'plugins', 'cache', 'market', 'lnk', '1.0.0');
  fs.mkdirSync(install, { recursive: true });
  fs.symlinkSync(path.join(outside, 'skills'), path.join(install, 'skills'));
  fs.symlinkSync(path.join(outside, 'commands'), path.join(install, 'commands'));
  const plugins = JSON.parse(fs.readFileSync(path.join(h.ch.dir, 'plugins', 'installed_plugins.json'), 'utf8'));
  plugins.plugins['lnk@market'] = [{ scope: 'user', installPath: install }];
  h.user('plugins/installed_plugins.json', JSON.stringify(plugins));
  h.user('settings.json', JSON.stringify({ enabledPlugins: { 'acme@market': true, 'lnk@market': true } }));
  // A synced plugin, in the one bucket, whose skills directory is a symlink out.
  const synced = path.join(h.ch.dir, 'plugins', 'synced', `${ORG}_${ACCT}`, 'lnksync');
  fs.mkdirSync(synced, { recursive: true });
  fs.symlinkSync(path.join(outside, 'skills'), path.join(synced, 'skills'));

  for (const listing of [null, { ...LISTING, names: [...LISTING.names, 'lnk:leak', 'lnk:leakcmd', 'lnksync:leak'] }]) {
    const r = await catalog({ root: h.root, listing, sessionStart: 0 });
    const all = JSON.stringify(r.skills);
    assert.ok(!all.includes('SECRET-OUTSIDE'), 'a SKILL.md or command outside the install was read');
    const names = r.skills.map((s) => s.name);
    if (!listing) for (const bad of ['lnk:leak', 'lnk:leakcmd', 'lnksync:leak']) assert.ok(!names.includes(bad), `${bad} offered`);
    assert.ok(names.includes('acme:deploy'), 'a real plugin directory is still read');
    assert.ok(names.includes('anthropic-skills:pdf'), 'a real synced plugin directory is still read');
  }
});

test('a plugin installed for another project is not read; one installed for this project is', async (t) => {
  const h = setup(t);
  standardTree(h);
  const cache = path.join(h.ch.dir, 'plugins', 'cache', 'market');
  h.user('plugins/cache/market/elsewhere/1.0.0/skills/theirs/SKILL.md', md({ name: 'theirs' }));
  h.user('plugins/cache/market/here/1.0.0/skills/ours/SKILL.md', md({ name: 'ours' }));
  const other = fs.mkdtempSync(path.join(SANDBOX, 'wc-skills-other-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const plugins = JSON.parse(fs.readFileSync(path.join(h.ch.dir, 'plugins', 'installed_plugins.json'), 'utf8'));
  plugins.plugins['elsewhere@market'] = [{ scope: 'project', projectPath: other, installPath: path.join(cache, 'elsewhere', '1.0.0') }];
  plugins.plugins['here@market'] = [{ scope: 'project', projectPath: h.root, installPath: path.join(cache, 'here', '1.0.0') }];
  h.user('plugins/installed_plugins.json', JSON.stringify(plugins));
  h.user('settings.json', JSON.stringify({ enabledPlugins: { 'acme@market': true, 'elsewhere@market': true, 'here@market': true } }));
  const names = (await catalog({ root: h.root, listing: null })).skills.map((s) => s.name);
  assert.ok(names.includes('here:ours'), 'installed for this project');
  assert.ok(!names.includes('elsewhere:theirs'), 'installed for another project');
});

test('no listing: disk only, partial — no conversation, and skillFold unavailable', async (t) => {
  const h = setup(t);
  standardTree(h);
  for (const listing of [null, { unavailable: true }, { names: [], descriptions: {}, orgUuid: ORG }]) {
    const r = await catalog({ root: h.root, listing, sessionStart: START });
    assert.equal(r.source, 'disk');
    assert.equal(r.partial, true);
    assert.deepStrictEqual(r.skills.map((s) => [s.name, s.origin]), [
      ['proj-skill', 'project'], ['user-skill', 'user'], ['proj-cmd', 'command'], ['user-cmd', 'command'],
      ['acme:deploy', 'plugin'], ['acme:ship', 'plugin'], ['anthropic-skills:docx', 'synced'], ['anthropic-skills:pdf', 'synced'],
    ]);
  }
  const inst = createSkillCatalog({ root: h.root, mirror: { skillFold: () => ({ unavailable: true }), snapshot: () => ({ primary: 'c1', conversations: [] }) } });
  const viaInst = await inst.catalog('c1');
  assert.equal(viaInst.source, 'disk');
  assert.equal(viaInst.partial, true);
  const noConv = createSkillCatalog({ root: h.root, mirror: { skillFold: () => LISTING, snapshot: () => ({ primary: null, conversations: [] }) } });
  const r2 = await noConv.catalog(null);
  assert.equal(r2.source, 'disk');
  assert.equal(r2.conversation, null);
  const noMirror = await createSkillCatalog({ root: h.root }).catalog(null);
  assert.equal(noMirror.source, 'disk');
});

test('descriptions: SKILL.md first, else the listing\'s, capped and redacted', async (t) => {
  const h = setup(t);
  standardTree(h);
  h.proj('skills/long/SKILL.md', md({ name: 'long', description: `${'word '.repeat(100)}end` }));
  h.proj('skills/secret/SKILL.md', md({ name: 'secret', description: 'Uses password hunter2-secret here.' }));
  const redactor = fakeRedactor();
  const listing = {
    names: ['proj-skill', 'simplify', 'long', 'secret', 'listed-secret'],
    descriptions: { 'proj-skill': 'Not this one.', simplify: 'Line one.\n  Line two.', 'listed-secret': 'Has hunter2-secret too.' },
    orgUuid: ORG,
  };
  const got = byName(await catalog({ root: h.root, listing, sessionStart: START, redactor }));
  assert.equal(got['proj-skill'].description, 'A project skill.', 'SKILL.md first');
  assert.equal(got.simplify.description, 'Line one. Line two.', 'else the listing\'s, on one line');
  assert.ok(got.long.description.length <= DESCRIPTION_MAX);
  assert.ok(got.long.description.length >= DESCRIPTION_MAX - 1);
  assert.equal(got.secret.description, 'Uses password MASKED here.');
  assert.equal(got['listed-secret'].description, 'Has MASKED too.');
  assert.ok(redactor.texts.length >= 5, 'every description goes through redactor.text');
});

test('at most ENTRIES_MAX entries, listing order first', async (t) => {
  const h = setup(t);
  const names = Array.from({ length: ENTRIES_MAX + 100 }, (_, i) => `skill-${i}`);
  const r = await catalog({ root: h.root, listing: { names, descriptions: {}, orgUuid: null }, sessionStart: START });
  assert.equal(r.skills.length, ENTRIES_MAX);
  assert.equal(r.skills[0].name, 'skill-0');
  assert.equal(r.skills[ENTRIES_MAX - 1].name, `skill-${ENTRIES_MAX - 1}`);
  assert.equal(r.partial, true, 'a cut catalog says so');
});

// ── createSkillCatalog ───────────────────────────────────────────────────────

function fakeMirror(listing = LISTING, { primary = 'conv-1', current = 'sess-2' } = {}) {
  const m = {
    folds: [],
    snaps: 0,
    skillFold(cid) { m.folds.push(cid); return cid === 'conv-1' ? listing : { names: [], descriptions: {}, orgUuid: null }; },
    snapshot(opts) {
      m.snaps += 1;
      assert.deepStrictEqual(opts, { level: 'local' });
      return {
        primary,
        conversations: [{ id: 'conv-1', current_session_id: current, sessions: [
          { session_id: 'sess-1', started_at: OLD - 3600_000 },
          { session_id: 'sess-2', started_at: START },
        ] }],
      };
    },
  };
  return m;
}

test('the session start is the current session\'s, from the snapshot; none → nothing unlisted is added', async (t) => {
  const h = setup(t);
  standardTree(h);
  // Newer than the first session's start, older than the current one's.
  h.proj('skills/between/SKILL.md', md({ name: 'between' }), OLD);
  h.proj('skills/after/SKILL.md', md({ name: 'after' }), NEW);
  const inst = createSkillCatalog({ root: h.root, mirror: fakeMirror() });
  const r = await inst.catalog('conv-1');
  assert.equal(r.conversation, 'conv-1');
  assert.equal(r.source, 'session');
  assert.equal(byName(r).after && byName(r).after.origin, 'project');
  assert.equal(byName(r).between, undefined);

  const unknownSession = createSkillCatalog({ root: h.root, mirror: fakeMirror(LISTING, { current: 'sess-9' }) });
  assert.equal(byName(await unknownSession.catalog('conv-1')).after, undefined, 'no start known');
});

test('no conversation named: the primary one', async (t) => {
  const h = setup(t);
  standardTree(h);
  const mirror = fakeMirror();
  const inst = createSkillCatalog({ root: h.root, mirror });
  const r = await inst.catalog(null);
  assert.equal(r.conversation, 'conv-1');
  assert.equal(r.source, 'session');
  assert.deepStrictEqual(mirror.folds, ['conv-1']);
});

test('resolve answers U60\'s adapter; lookup answers builtin, skill, user_only, unknown', async (t) => {
  const h = setup(t);
  standardTree(h);
  h.proj('skills/verify/SKILL.md', md({ name: 'verify', userOnly: true }));
  h.user('plugins/cache/market/acme/1.0.0/skills/batch/SKILL.md', md({ name: 'batch', userOnly: true }));
  h.proj('commands/help.md', md({ userOnly: true }));
  const inst = createSkillCatalog({ root: h.root, mirror: fakeMirror() });
  const opts = { conversation_id: 'conv-1' };
  assert.equal(await inst.resolve('proj-skill', opts), 'skill');
  assert.equal(await inst.resolve('simplify', opts), 'skill');
  assert.equal(await inst.resolve('acme:deploy', opts), 'skill');
  assert.equal(await inst.resolve('verify', opts), 'user_only');
  assert.equal(await inst.resolve('acme:batch', opts), 'user_only');
  assert.equal(await inst.resolve('nope', opts), null);
  for (const b of ['compact', 'help', 'HELP', 'model']) assert.equal(await inst.resolve(b, opts), null, b);
  assert.equal(await inst.resolve('../etc', opts), null);
  assert.equal(await inst.resolve('proj-skill', { conversation_id: null }), 'skill', 'null: the primary conversation');
  assert.equal(await inst.resolve('proj-skill'), 'skill');

  assert.deepStrictEqual(await inst.lookup('compact', 'conv-1'), { kind: 'builtin' });
  assert.deepStrictEqual(await inst.lookup('proj-skill', 'conv-1'),
    { kind: 'skill', skill: { name: 'proj-skill', description: 'A project skill.', origin: 'project' } });
  assert.deepStrictEqual(await inst.lookup('verify', 'conv-1'), { kind: 'user_only' });
  assert.deepStrictEqual(await inst.lookup('nope', 'conv-1'), { kind: 'unknown' });
});

test('the memo: two calls within ttlMs read the disk once; after it, again', async (t) => {
  const h = setup(t);
  standardTree(h);
  let clock = 1_000_000;
  const mirror = fakeMirror();
  const inst = createSkillCatalog({ root: h.root, mirror, ttlMs: 5000, now: () => clock });
  const first = await inst.catalog('conv-1');
  h.proj('skills/later/SKILL.md', md({ name: 'later' }), NEW);
  clock += 4000;
  const second = await inst.catalog('conv-1');
  assert.deepStrictEqual(second, first, 'within ttlMs: the memo');
  assert.equal(await inst.resolve('later', { conversation_id: 'conv-1' }), null);
  assert.equal(mirror.snaps, 1);
  assert.deepStrictEqual(mirror.folds, ['conv-1']);
  clock += 1000;
  const third = await inst.catalog('conv-1');
  assert.equal(byName(third).later && byName(third).later.origin, 'project', 'after ttlMs: read again');
  assert.equal(mirror.snaps, 2);
  // A different conversation is its own entry; clear() drops them all.
  await inst.catalog('conv-2');
  assert.equal(mirror.snaps, 3);
  inst.clear();
  await inst.catalog('conv-1');
  assert.equal(mirror.snaps, 4);
  // Concurrent calls share one read.
  inst.clear();
  await Promise.all([inst.catalog('conv-1'), inst.catalog('conv-1'), inst.resolve('x', { conversation_id: 'conv-1' })]);
  assert.equal(mirror.snaps, 5);
});

test('createSkillCatalog needs a root', () => {
  assert.throws(() => createSkillCatalog({}), /root/);
});
