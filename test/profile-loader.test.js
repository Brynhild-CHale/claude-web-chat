const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { resolvePaths } = require('../lib/server/paths');
const reg = require('../lib/capture/profiles');

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ploader-'));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  return dir;
}

// Run fn with $HOME redirected to a temp dir so the global profiles tier
// (~/.web-chat/profiles) is isolated. os.homedir() honors $HOME.
function withTempHome(fn) {
  const prev = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-phome-'));
  process.env.HOME = home;
  try { return fn(home); }
  finally { process.env.HOME = prev; }
}

// Write a profile bundle into a profiles dir (project's or home's).
function putProfile(profilesDir, name, opts = {}) {
  const dir = path.join(profilesDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { name, description: opts.description || `${name} desc`, matchers: opts.matchers || [] };
  if (opts.pane) meta.pane = opts.pane;
  if (opts.interact) meta.interact = opts.interact;
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(meta));
  fs.writeFileSync(
    path.join(dir, 'extract.js'),
    opts.extractJs || `module.exports = ({ url }) => ({ kind: ${JSON.stringify(name)}, url });`,
  );
  if (opts.paneJs) fs.writeFileSync(path.join(dir, 'pane.js'), opts.paneJs);
}

test('loader: project profile registers ahead of builtins and wins over tables', () => {
  const root = tmpRoot();
  const paths = resolvePaths(root);
  putProfile(paths.PROFILES_DIR, 'sheets', { matchers: [{ type: 'domain', value: 'sheets.example.com' }] });
  reg.loadUserProfiles(paths);

  const picked = reg.pickProfile({ url: 'https://sheets.example.com/x', html: '<table></table>' });
  assert.equal(picked.name, 'sheets', 'user profile beats builtin tables even with a <table> present');
});

test('loader: same-name project profile shadows global entirely', () => {
  withTempHome((home) => {
    const root = tmpRoot();
    const paths = resolvePaths(root);
    const globalProfiles = path.join(home, '.web-chat', 'profiles');
    fs.mkdirSync(globalProfiles, { recursive: true });
    // global "dup" returns kind:global; project "dup" returns kind:project
    putProfile(globalProfiles, 'dup', {
      matchers: [{ type: 'domain', value: 'dup.com' }],
      extractJs: 'module.exports = () => ({ kind: "global" });',
    });
    putProfile(paths.PROFILES_DIR, 'dup', {
      matchers: [{ type: 'domain', value: 'dup.com' }],
      extractJs: 'module.exports = () => ({ kind: "project" });',
    });
    reg.loadUserProfiles(paths);

    const out = reg.runProfile(reg.pickProfile({ url: 'https://dup.com/a' }), { url: 'https://dup.com/a', html: '' });
    assert.equal(out.distilled.kind, 'project', 'project copy shadows the global one');
    // only one "dup" appears
    const dups = reg.listProfiles().filter((p) => p.name === 'dup');
    assert.equal(dups.length, 1);
    assert.equal(dups[0].scope, 'project');
  });
});

test('loader: specificity within a tier — regex > domain-glob > bare-domain', () => {
  const root = tmpRoot();
  const paths = resolvePaths(root);
  putProfile(paths.PROFILES_DIR, 'p_bare', { matchers: [{ type: 'domain', value: 'example.com' }] });
  putProfile(paths.PROFILES_DIR, 'p_glob', { matchers: [{ type: 'domain', value: '*.example.com' }] });
  putProfile(paths.PROFILES_DIR, 'p_regex', { matchers: [{ type: 'regex', value: 'example\\.com/x' }] });
  reg.loadUserProfiles(paths);

  const picked = reg.pickProfile({ url: 'https://sub.example.com/x' });
  assert.equal(picked.name, 'p_regex', 'highest-specificity matcher wins');
});

test('loader: tier dominance — low-specificity project beats high-specificity global', () => {
  withTempHome((home) => {
    const root = tmpRoot();
    const paths = resolvePaths(root);
    const globalProfiles = path.join(home, '.web-chat', 'profiles');
    fs.mkdirSync(globalProfiles, { recursive: true });
    putProfile(globalProfiles, 'g_regex', { matchers: [{ type: 'regex', value: 'foo\\.com/a' }] });   // score 3, global
    putProfile(paths.PROFILES_DIR, 'p_bare', { matchers: [{ type: 'domain', value: 'foo.com' }] });   // score 1, project
    reg.loadUserProfiles(paths);

    const r = reg.resolve({ url: 'https://foo.com/a' });
    assert.equal(r.profile.name, 'p_bare', 'a project match dominates any global match');
    assert.equal(r.tier, 'project');
    assert.equal(r.matched, true);
  });
});

test('loader: explicit hint resolves by name across any tier, even with no matcher hit', () => {
  const root = tmpRoot();
  const paths = resolvePaths(root);
  putProfile(paths.PROFILES_DIR, 'special', { matchers: [{ type: 'domain', value: 'never.test' }] });
  reg.loadUserProfiles(paths);

  const picked = reg.pickProfile({ url: 'https://unrelated.example/', hint: 'special' });
  assert.equal(picked.name, 'special');
});

test('loader: Contract 7 — builtin tables distills but does NOT count as a match', () => {
  const root = tmpRoot();
  const paths = resolvePaths(root);
  reg.loadUserProfiles(paths); // no user profiles

  const r = reg.resolve({ url: 'https://anything/', html: '<table></table>' });
  assert.equal(r.profile.name, 'tables', 'tables still selected as the distiller');
  assert.equal(r.matched, false, 'but matched=false so the profile button is not offered');
});

test('loader: a throwing extractor loads but runProfile falls back to default', () => {
  const root = tmpRoot();
  const paths = resolvePaths(root);
  putProfile(paths.PROFILES_DIR, 'boomx', {
    matchers: [{ type: 'domain', value: 'boom.test' }],
    extractJs: 'module.exports = () => { throw new Error("kaboom"); };',
  });
  reg.loadUserProfiles(paths);

  const picked = reg.pickProfile({ url: 'https://boom.test/' });
  assert.equal(picked.name, 'boomx');
  const out = reg.runProfile(picked, { url: 'https://boom.test/', html: '<p>hi</p>' });
  assert.equal(out.profile, 'default');
  assert.equal(out.fell_back_from, 'boomx');
});

test('loader: a bundle that throws at require is skipped; others still load; boot survives', () => {
  // Isolate $HOME so the user's real global profiles (the dogfood ~/.web-chat/
  // profiles) don't leak into this count-based assertion.
  withTempHome(() => {
    const root = tmpRoot();
    const paths = resolvePaths(root);
    putProfile(paths.PROFILES_DIR, 'good', { matchers: [{ type: 'domain', value: 'good.test' }] });
    putProfile(paths.PROFILES_DIR, 'bad', {
      matchers: [{ type: 'domain', value: 'bad.test' }],
      extractJs: 'throw new Error("require-time boom");',
    });
    const count = reg.loadUserProfiles(paths); // must not throw
    // count now also includes the package's bundled profiles, so scope the
    // "only the good bundle loaded" assertion to the project tier (where good/bad
    // live) rather than the total — robust to however many profiles ship bundled.
    assert.ok(count >= 1, 'loader returns a count and does not throw');
    const projectLoaded = reg.listProfiles().filter((p) => p.scope === 'project');
    assert.equal(projectLoaded.length, 1, 'only the good project bundle loaded; the throwing one was skipped');
    assert.ok(reg.listProfiles().some((p) => p.name === 'good'));
    assert.ok(!reg.listProfiles().some((p) => p.name === 'bad'));
  });
});

test('loader: inspectRaw and listProfiles see a loaded user profile (scope/has_pane/has_interaction)', () => {
  const root = tmpRoot();
  const paths = resolvePaths(root);
  putProfile(paths.PROFILES_DIR, 'rich', {
    matchers: [{ type: 'domain', value: 'rich.test' }],
    extractJs: 'module.exports = () => ({ kind: "rich", n: 42 });',
    paneJs: 'module.exports = { render: () => "<div>x</div>" };',
    interact: { steps: [{ name: 's1', action: 'click', selector: 'a' }] },
  });
  reg.loadUserProfiles(paths);

  const listed = reg.listProfiles().find((p) => p.name === 'rich');
  assert.ok(listed);
  assert.equal(listed.scope, 'project');
  assert.equal(listed.has_pane, true);
  assert.equal(listed.has_interaction, true);

  const scoped = reg.inspectRaw('<html></html>', { profile: 'rich' });
  assert.equal(scoped.mode, 'profile');
  assert.equal(scoped.result.kind, 'rich');
  assert.equal(scoped.result.n, 42);
});
