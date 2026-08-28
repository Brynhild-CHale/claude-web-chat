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

// ---------------------------------------------------------------------------
// loadBundle / validateMeta — one loader, one verdict
// ---------------------------------------------------------------------------
//
// The daemon's loader used to validate nothing but "extract.js exports a
// function", so a typo'd matcher type or an uncompilable regex loaded cleanly
// and was silently inert; the real checks lived in a SECOND loader inside
// `claude-web-chat profile validate`, and the two disagreed on three points.
// These pin the shared verdict.

// Write a bundle with a raw profile.json (putProfile above always writes a valid
// one), so the invalid shapes can be exercised.
function putRawProfile(profilesDir, dirName, metaJson, extractJs) {
  const dir = path.join(profilesDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.json'), metaJson);
  fs.writeFileSync(path.join(dir, 'extract.js'), extractJs || 'module.exports = () => ({ kind: "x" });');
  return dir;
}

test('loadBundle: an unknown matcher type or an uncompilable regex is an error, not silence', () => {
  const errs = reg.validateMeta({
    name: 'typo',
    matchers: [{ type: 'domian', value: 'example.com' }, { type: 'regex', value: '(' }],
  });
  assert.equal(errs.length, 2, 'both matchers reported');
  assert.ok(errs.some((e) => /type must be 'domain' or 'regex'/.test(e)));
  assert.ok(errs.some((e) => /bad regex/.test(e)));
});

test('loadBundle: the name `default` is refused — the CLI used to pass it', () => {
  assert.ok(reg.validateMeta({ name: 'default' }).some((e) => /reserved/.test(e)));
  // A missing name is NOT an error: the daemon has always fallen back to the
  // directory name, so the validator must accept what the daemon loads.
  assert.deepEqual(reg.validateMeta({ description: 'd' }), []);
});

test('loadBundle: a DIRECTORY named `default` is refused too, name or no name', () => {
  withTempHome(() => {
    const root = tmpRoot();
    const paths = resolvePaths(root);
    // The reservation used to sit on meta.name alone, so a bundle whose
    // profile.json declared no name and whose directory was `default` resolved
    // to the name `default` and registered — shadowing the builtin catch-all in
    // getProfile/resolve/listProfiles for every page.
    const dir = putRawProfile(paths.PROFILES_DIR, 'default', JSON.stringify({ description: 'no name' }));
    const b = reg.loadBundle(dir);
    assert.equal(b.name, 'default');
    assert.ok(b.errors.some((e) => /reserved/.test(e)), 'the resolved name is checked, not just the declared one');

    reg.loadUserProfiles(paths);
    assert.equal(reg.listProfiles().filter((p) => p.name === 'default').length, 1,
      'only the builtin catch-all is listed under that name');
    assert.equal(reg.getProfile('default').scope, undefined,
      'getProfile(\'default\') still returns the builtin, not a project bundle');
  });
});

test('loadBundle: a missing name falls back to the directory name', () => {
  withTempHome(() => {
    const root = tmpRoot();
    const paths = resolvePaths(root);
    const dir = putRawProfile(paths.PROFILES_DIR, 'anonymous', JSON.stringify({ description: 'no name' }));
    const b = reg.loadBundle(dir);
    assert.deepEqual(b.errors, []);
    assert.equal(b.name, 'anonymous');
  });
});

test('loader: a bundle with an invalid profile.json is logged and skipped, not loaded inert', () => {
  withTempHome(() => {
    const root = tmpRoot();
    const paths = resolvePaths(root);
    putProfile(paths.PROFILES_DIR, 'fine', { matchers: [{ type: 'domain', value: 'fine.test' }] });
    putRawProfile(paths.PROFILES_DIR, 'typo', JSON.stringify({
      name: 'typo', matchers: [{ type: 'domian', value: 'typo.test' }],
    }));
    putRawProfile(paths.PROFILES_DIR, 'reserved', JSON.stringify({ name: 'default', matchers: [] }));

    reg.loadUserProfiles(paths);
    const names = reg.listProfiles().filter((p) => p.scope === 'project').map((p) => p.name);
    assert.deepEqual(names, ['fine'], 'only the valid bundle registers');
    assert.equal(reg.listProfiles().some((p) => p.name === 'typo'), false,
      'the typo\'d matcher no longer loads as an inert profile');
  });
});

test('loader: a mount_suffix collision moves the later profile to a suffix that is FREE', () => {
  withTempHome(() => {
    const root = tmpRoot();
    const paths = resolvePaths(root);
    // `a` claims suffix 'b'; `b`'s own default suffix is 'b' too. The old
    // fallback re-used the profile's name — which was 'b' — so both panes
    // mounted at the same id and clobbered each other.
    putProfile(paths.PROFILES_DIR, 'a', {
      matchers: [{ type: 'domain', value: 'a.test' }], pane: { mount_suffix: 'b' },
    });
    putProfile(paths.PROFILES_DIR, 'b', { matchers: [{ type: 'domain', value: 'b.test' }] });
    reg.loadUserProfiles(paths);

    const suffixes = ['a', 'b'].map((n) => reg.getProfile(n).mount_suffix);
    assert.equal(new Set(suffixes).size, 2, `distinct mount suffixes (got ${JSON.stringify(suffixes)})`);
  });
});
