// Reading a pack's own description of itself — and the two name policies that
// have no override.
//
// The sharp one is the builtin collision. `seedBuiltins` only repairs a
// component directory whose meta.json says `builtin: true`; a pack's does not,
// so a pack shipping `git-dashboard` would win PERMANENTLY — every later boot
// would leave the shadowing copy alone and the real builtin would never come
// back. That is why it is refused at validation, before a plan exists, in every
// tier and for every actor.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { parseManifest, validateManifest, readSkillFrontmatter, satisfies, reservedComponentNames, reservedSkillNames } = require('../lib/packs/manifest');
const { packFixture, tmpDir, write } = require('../test-support/packs');

const validate = (dir) => validateManifest(parseManifest(dir), { stageDir: dir });

test('a well-formed pack validates, and reports its components and its skill', () => {
  const dir = packFixture({
    components: [
      { name: 'deploy-board', description: 'Live deploys.', service: 'module.exports={async start(){}};' },
      { name: 'incident-timeline', description: 'Incidents.', seed: 'return {};' },
    ],
    themes: [{ name: 'acme-dark' }],
  });
  const v = validate(dir);
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.equal(v.name, 'acme-ops');
  assert.equal(v.version, '1.2.0');
  assert.deepEqual(v.components.map((c) => c.name), ['deploy-board', 'incident-timeline']);
  assert.equal(v.components[0].has_service, true);
  assert.equal(v.components[1].has_seed, true);
  assert.deepEqual(v.themes.map((t) => t.name), ['acme-dark']);
  assert.equal(v.skill.present, true);
  assert.match(v.skill.description, /deploys/);
});

test('a directory with no web-chat-pack.json is not a pack, and says so', () => {
  const dir = tmpDir();
  write(path.join(dir, 'README.md'), '# not a pack\n');
  assert.throws(() => parseManifest(dir), /not a component pack/);
});

test('a manifest that is not JSON fails with the parse error, not a TypeError later', () => {
  const dir = tmpDir();
  write(path.join(dir, 'web-chat-pack.json'), '{ nope');
  assert.throws(() => parseManifest(dir), /not valid JSON/);
});

for (const builtin of reservedComponentNames()) {
  test(`a component named "${builtin}" is REFUSED — it would shadow the built-in permanently`, () => {
    const dir = packFixture({ components: [{ name: builtin }] });
    const v = validate(dir);
    assert.equal(v.ok, false);
    assert.match(v.errors.join('\n'), new RegExp(`"${builtin}" is a built-in name`));
    assert.match(v.errors.join('\n'), /no override/);
    assert.equal(v.components.length, 0, 'the refused component never reaches the plan');
  });
}

for (const reserved of reservedSkillNames()) {
  test(`a pack named "${reserved}" is refused — web-chat's own reconcile would revert its skill`, () => {
    const dir = packFixture({ name: reserved });
    const v = validate(dir);
    assert.equal(v.ok, false);
    assert.match(v.errors.join('\n'), /skill name web-chat manages/);
  });
}

test('a component listed in the manifest but missing from the tree is an error', () => {
  const dir = packFixture({ components: [{ name: 'deploy-board' }] });
  fs.rmSync(path.join(dir, 'components', 'deploy-board'), { recursive: true, force: true });
  const v = validate(dir);
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /components\/deploy-board\/component\.html is missing/);
});

test('a meta.json whose name disagrees with its directory warns — the directory is the identity', () => {
  const dir = packFixture({ components: [{ name: 'deploy-board', meta: { name: 'deployBoard', description: 'x' } }] });
  const v = validate(dir);
  assert.equal(v.ok, true);
  assert.match(v.warnings.join('\n'), /meta\.json says name "deployBoard"/);
  assert.equal(v.components[0].meta_name, 'deployBoard');
});

test('a non-kebab component name is refused rather than installed under a name nothing resolves', () => {
  const dir = packFixture({ components: [{ name: 'Deploy_Board' }] });
  const v = validate(dir);
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /kebab-case/);
});

test('a pack with no SKILL.md installs, but is warned about — that is the whole asymmetry', () => {
  const dir = packFixture({ skill: false });
  const v = validate(dir);
  assert.equal(v.ok, true);
  assert.match(v.warnings.join('\n'), /a directory of components/);
});

test('a SKILL.md with no frontmatter is warned about — Claude Code would not load it', () => {
  const dir = packFixture();
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# just a heading\n');
  const v = validate(dir);
  assert.match(v.warnings.join('\n'), /no --- frontmatter/);
});

test('a folded multi-line frontmatter description is read as one line', () => {
  const dir = packFixture();
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---
name: acme-ops
description: Deploy status, incident timelines and per-service health.
  Use when the user asks about deploys, incidents or service health.
---

body here
`);
  const fm = readSkillFrontmatter(dir);
  assert.equal(fm.name, 'acme-ops');
  assert.equal(fm.description, 'Deploy status, incident timelines and per-service health. Use when the user asks about deploys, incidents or service health.');
  assert.match(fm.body, /body here/);
});

test('requires.web-chat gates the install against THIS build', () => {
  const tooNew = packFixture({ requires: { 'web-chat': '>=99.0.0' } });
  assert.equal(validate(tooNew).ok, false);
  assert.match(validate(tooNew).errors.join(''), /needs web-chat >=99\.0\.0/);
  const fine = packFixture({ requires: { 'web-chat': '>=0.0.1' } });
  assert.equal(validate(fine).ok, true);
});

test('satisfies understands the range shapes a pack author actually writes', () => {
  assert.equal(satisfies('0.5.0', '>=0.5.0').ok, true);
  assert.equal(satisfies('0.4.9', '>=0.5.0').ok, false);
  assert.equal(satisfies('0.5.9', '^0.5.0').ok, true);
  assert.equal(satisfies('0.6.0', '^0.5.0').ok, false, 'pre-1.0, ^ pins the minor');
  assert.equal(satisfies('1.9.0', '^1.2.0').ok, true);
  assert.equal(satisfies('0.5.3', '~0.5.1').ok, true);
  assert.equal(satisfies('0.6.0', '~0.5.1').ok, false);
  assert.equal(satisfies('0.5.0', '>=0.4.0 <1.0.0').ok, true);
  assert.equal(satisfies('0.5.0', '*').ok, true);
  assert.equal(satisfies('0.5.0', 'whatever-this-is').ok, true, 'an unparseable range must not make a pack uninstallable');
});

test('a range written with a SPACE after the operator still means what it says', () => {
  // ">= 1.2.0" is an ordinary way to write this. Splitting on whitespace alone
  // turned it into a bare ">=" (skipped as unknown) plus a bare "1.2.0" (an
  // EXACT pin) — so the pack became uninstallable on every version but that one,
  // the precise inverse of the intent.
  assert.equal(satisfies('1.5.0', '>= 1.2.0').ok, true);
  assert.equal(satisfies('1.0.0', '>= 1.2.0').ok, false);
  assert.equal(satisfies('0.5.0', '>= 0.4.0 < 1.0.0').ok, true);
  assert.equal(satisfies('1.5.0', '>= 0.4.0 < 1.0.0').ok, false);
  assert.equal(satisfies('0.6.0', '^ 0.5.0').ok, false);
  // …and a bare version still means exactly that version.
  assert.equal(satisfies('1.5.0', '1.5.0').ok, true);
  assert.equal(satisfies('1.6.0', '1.5.0').ok, false);
});

test('a pack name that is not a plain kebab-case name is refused — it becomes a directory', () => {
  const { assertSafeName } = require('../lib/packs/manifest');
  assert.equal(assertSafeName('acme-ops'), 'acme-ops');
  for (const bad of ['../../etc', '/etc/passwd', 'a/b', '..', '', 'Acme', 'acme ops', 'acme.ops']) {
    assert.throws(() => assertSafeName(bad), /not a plain kebab-case name/, `refused: ${JSON.stringify(bad)}`);
  }
});

test('a local path is refused with a message about local paths, not about a repo you never typed', () => {
  const { parseSource } = require('../lib/packs/source');
  // `/Users/me/src/acme-pack` used to fall through the host-detect regex, get
  // prefixed to `github.com//Users/me/...`, and lose its empty leading segment —
  // so the user was told "could not resolve 'HEAD' in Users/me" and blamed for a
  // ref or a permission on a repository that does not exist.
  for (const local of ['/Users/me/src/acme-pack', 'file:///Users/me/p', './my-pack', '../my-pack', '~/src/p']) {
    assert.throws(() => parseSource(local), /is a local path/, `refused: ${local}`);
  }
  // …and every real repository shape still parses.
  for (const [input, slug] of [
    ['https://github.com/acme/ops', 'acme/ops'],
    ['github.com/acme/ops', 'acme/ops'],
    ['acme/ops', 'acme/ops'],
    ['git@github.com:acme/ops.git', 'acme/ops'],
  ]) assert.equal(parseSource(input).slug, slug, input);
});
