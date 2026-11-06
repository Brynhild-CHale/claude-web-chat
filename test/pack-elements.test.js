// The element unit kind through the one pack pipeline (annotation engine
// tranche 2, U322; PLAN.md 2C.1, DECISIONS.md B2, readiness R7 rows 1, 2, 7
// and 9, F10 X-1).
//
// An element type is `elements/<type>/` in a pack — element.json, draw.js and
// assets/** — and installs into `<tier>/element-types/<type>/`
// (projectPaths().elementTypesDir, userPaths().elementTypesDir; ruling
// 2C@types-dir a), never beside the element log. This file holds:
//
//   * the reserved names (lib/core/names), the anchor vocabulary
//     (lib/core/element-policy ANCHOR_KINDS) and the two path keys;
//   * element.json's validation (lib/packs/elements validateElement);
//   * validateManifest over elements-only, elements + components and
//     elements + skill packs, and a listKey row that cannot throw out of it;
//   * F10 x1's three round trips through the real pipeline (quarantine with
//     the fake forge, approve, verify, remove → nothing left), its four
//     controls (each refused in its own words, 0 files written) and its four
//     forced throws mid-apply (each unwound to 0 files);
//   * the element log's directory, byte-identical across an install and a
//     removal; the --global tier; the collision ladder; listInstalled and the
//     CLI's list / review / info.
//
// The consent half (B1: the direct-install refusal, review, tamper, `via`) is
// test/pack-elements-consent.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { packFixture, tmpDir, write, fakeForge, repoWithArchive } = require('../test-support/packs');
const { withTempHome } = require('../test-support/helpers');
const { projectPaths, userPaths } = require('../lib/core/paths');
const names = require('../lib/core/names');
const { BUILTIN_ELEMENT_TYPES, ANCHOR_KINDS, validateDescriptor } = require('../lib/core/element-policy');
const { validateElement, readElementJson, elementFiles, KNOWN_KEYS } = require('../lib/packs/elements');
const { validateManifest, parseManifest } = require('../lib/packs/manifest');
const { planInstall } = require('../lib/packs/plan');
const { kindOf, UNIT_KINDS } = require('../lib/packs/kinds');
const { unitDir, findPack, readPending } = require('../lib/packs/store');
const { verifyPack } = require('../lib/packs/tree');
const packs = require('../lib/packs/install');

// ── fixtures ────────────────────────────────────────────────────────────────
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>\n';
const DRAW = (type) => `export default function draw(el, ctx) { ctx.box(el).dataset.type = '${type}'; }\n`;
const SOURCE = { via: 'tarball', sha: 'a'.repeat(40), url: 'https://github.com/acme/marks' };
const SHA = 'a'.repeat(40);
// A sound payload declaration (U514: a pack's type that declares none passes
// review with a warning, so a test asserting no warnings declares one).
const PAYLOAD = Object.freeze({ keys: ['anchor', 'shared', 'note'] });

// One element type's files. `json` overrides element.json's fields (a key set
// to undefined is left out); `draw: null` ships no draw.js.
function el(type, { json = {}, draw, assets } = {}) {
  const body = { type, family: 'page', remote: { see: 'read', send: 'full' }, schema: `${type}@1`, anchors: ['element', 'range'], ...json };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return { type, json: body, draw: draw === undefined ? DRAW(type) : draw, assets: assets || { 'icon.svg': SVG, 'img/dot.svg': SVG } };
}

// A pack repository on disk with element types (and, optionally, components
// and a skill), through the shared fixture builder.
function elementPack({ name, version = '1.0.0', elements = [], components = [], skill = false, dir = null }) {
  const extraFiles = {};
  for (const e of elements) {
    extraFiles[`elements/${e.type}/element.json`] = JSON.stringify(e.json, null, 2) + '\n';
    if (e.draw != null) extraFiles[`elements/${e.type}/draw.js`] = e.draw;
    for (const [rel, body] of Object.entries(e.assets)) extraFiles[`elements/${e.type}/assets/${rel}`] = body;
  }
  return packFixture({
    name, version, components, skill, dir,
    manifest: {
      name, version, description: `${name}: annotation tools.`,
      ...(components.length ? { components: components.map((c) => c.name) } : {}),
      elements: elements.map((e) => e.type),
    },
    extraFiles,
  });
}

function project(t) {
  withTempHome(t);
  const root = tmpDir('wc-el-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  return root;
}

// Every FILE under a directory, by relative path → sha256. `skip` paths (and
// everything under them) are left out.
function files(base, skip = []) {
  const out = {};
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      if (skip.includes(abs)) continue;
      if (e.isDirectory()) walk(abs);
      else out[path.relative(base, abs).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  })(base);
  return out;
}

// Files AND directories, for the unwinds: the journal must take back every
// directory it made, the nested assets/img/ included. `.web-chat/packs/` (the
// staging tmp, the snapshots, the pending marker, the audit log) is expected
// to change even on a failure, as test/pack-transaction.test.js says.
function tree(root) {
  const out = {};
  const skip = path.join(root, '.web-chat', 'packs');
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      if (abs === skip) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (e.isDirectory()) { out[`${rel}/`] = 'dir'; walk(abs); } else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  })(root);
  return out;
}

// The project's installable surface and the user tier's, packs bookkeeping
// left out (records, ledger, audit, quarantine).
function surface(root) {
  return {
    project: files(root, [projectPaths(root).packsDir, projectPaths(root).packs]),
    home: files(userPaths().root, [path.join(userPaths().root, 'packs'), path.join(userPaths().root, 'packs.json')]),
  };
}

// ── names, paths, the vocabulary, the row ───────────────────────────────────
test('the reserved element type names are derived from element-policy, never re-listed', () => {
  assert.deepStrictEqual([...names.BUILTIN_ELEMENT_TYPE_NAMES], BUILTIN_ELEMENT_TYPES.map((d) => d.type));
  assert.ok(Object.isFrozen(names.BUILTIN_ELEMENT_TYPE_NAMES));
  assert.equal(names.BUILTIN_ELEMENT_PACK, 'web-chat-builtins');
  assert.equal(names.isReservedElementType('highlight'), true);
  assert.equal(names.isReservedElementType('comment'), true);
  assert.equal(names.isReservedElementType('box-grab'), true);
  for (const n of ['sticky', 'Comment', '', null, undefined, 'comments']) assert.equal(names.isReservedElementType(n), false, String(n));
  // One declaration of the list: the literal names are not spelled in names.js.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core', 'names.js'), 'utf8');
  assert.doesNotMatch(src, /['"](?:highlight|box-grab)['"]/, 'names.js derives the types, it does not re-list them');
});

test('ANCHOR_KINDS is the engine\'s frozen anchor vocabulary, and element-policy still imports nothing', () => {
  // tranche 3, U415: the four chat kinds appended (element-policy CHAT_ANCHOR_KINDS).
  assert.deepStrictEqual([...ANCHOR_KINDS], ['element', 'range', 'source', 'page', 'point', 'turn', 'item', 'item-range', 'diff-line']);
  assert.ok(Object.isFrozen(ANCHOR_KINDS));
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core', 'element-policy.js'), 'utf8');
  assert.doesNotMatch(src, /\brequire\(/);
});

test('elementTypesDir is a key of both tiers, and never under the element log\'s directory', () => {
  const root = path.join(tmpDir('wc-el-paths-'), 'proj');
  const p = projectPaths(root);
  assert.equal(p.elementTypesDir, path.join(root, '.web-chat', 'element-types'));
  assert.equal(userPaths().elementTypesDir, path.join(userPaths().root, 'element-types'));
  assert.ok(!p.elementTypesDir.startsWith(p.elementsDir + path.sep) && p.elementTypesDir !== p.elementsDir);
});

test('the element row: dest by tier, name check, reserved names, label, listKey', () => {
  const row = kindOf('element');
  assert.equal(row, UNIT_KINDS[UNIT_KINDS.length - 1], 'appended after the three kinds the table was built from');
  assert.equal(row.manifestKey, 'elements');
  assert.equal(row.listKey, 'elements');
  assert.equal(row.checksName, true);
  assert.equal(row.sharedDir, false);
  const root = path.join(tmpDir('wc-el-row-'), 'proj');
  assert.equal(row.dest({ kind: 'element', name: 'sticky' }, 'local', root), path.join(projectPaths(root).elementTypesDir, 'sticky'));
  assert.equal(row.dest({ kind: 'element', name: 'sticky' }, 'system', root), path.join(userPaths().elementTypesDir, 'sticky'));
  assert.equal(unitDir({ kind: 'element', name: 'sticky' }, 'local', root), path.join(projectPaths(root).elementTypesDir, 'sticky'));
  for (const n of names.BUILTIN_ELEMENT_TYPE_NAMES) assert.equal(row.reserved(n), true, n);
  assert.equal(row.reserved('sticky'), false);
  assert.equal(row.label({ kind: 'element', name: 'sticky' }), 'element sticky');
});

// ── element.json ────────────────────────────────────────────────────────────
test('validateElement: a sound element.json, reads defaulting to [schema]', () => {
  const v = validateElement({ type: 'sticky', family: 'page', remote: { see: 'read', send: 'full' }, schema: 'sticky@2', anchors: ['range', 'element', 'range'] }, { name: 'sticky' });
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.deepStrictEqual(v.warnings, []);
  assert.deepStrictEqual(v.descriptor, {
    type: 'sticky', family: 'page', remote: { see: 'read', send: 'full' }, private: false,
    schema: 'sticky@2', reads: ['sticky@2'], anchors: ['range', 'element'],
  });
  const r = validateElement({ type: 'sticky', family: 'page', remote: { see: 'full', send: 'local' }, private: true, schema: 'sticky@2', reads: ['sticky@1', 'sticky@2'], anchors: ['page'] }, { name: 'sticky' });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepStrictEqual(r.descriptor.reads, ['sticky@1', 'sticky@2']);
  assert.equal(r.descriptor.private, true);
});

// U335 (PLAN.md 2D.5) validates the toolbar's fields: a sound set is kept as
// written with no warning, an unsound one is refused naming its field
// (test/element-toolbar-fields.test.js has every case); any OTHER key is still
// kept and warned, never refused.
test('validateElement: sound toolbar fields are kept as written; an unknown key is kept and warned, never refused', () => {
  const toolbar = {
    label: 'Sticky',
    icons: { light: 'assets/icon.svg', dark: 'assets/icon-dark.svg' },
    settings: { small: { type: 'object', properties: { colour: { type: 'string', enum: ['gold', 'green'] } } } },
    hotkeys: [{ action: 'arm', label: 'Arm', default: 'K' }],
    profiles: true,
    input: 'strokes',
    wake: false,
    summary_key: 'note',
    needs: { network: 'api.example.com' },
  };
  const extra = { later: { anything: [1] } };
  const v = validateElement({ type: 'sticky', family: 'page', remote: { see: 'read', send: 'full' }, schema: 'sticky@1', anchors: ['element'], ...toolbar, ...extra }, { name: 'sticky' });
  assert.equal(v.ok, true, v.errors.join('; '));
  for (const k of Object.keys({ ...toolbar, ...extra })) assert.deepStrictEqual(v.descriptor[k], { ...toolbar, ...extra }[k], `${k} kept as written`);
  assert.equal(v.warnings.length, 1);
  assert.match(v.warnings[0], /^element "sticky": element\.json carries later, which this build does not check — kept as written$/);
  assert.deepStrictEqual([...KNOWN_KEYS].sort(), ['anchors', 'family', 'private', 'reads', 'remote', 'schema', 'type']);
  // The shapes this test once kept as written are refused now, each by its field.
  const r = validateElement({ type: 'sticky', family: 'page', remote: { see: 'read', send: 'full' }, schema: 'sticky@1', anchors: ['element'],
    settings: { small: [{ key: 'colour', type: 'token' }] }, input: { pen: true }, needs: ['overlay'] }, { name: 'sticky' });
  assert.equal(r.ok, false);
  assert.deepStrictEqual(r.errors.map((e) => e.match(/^element "sticky": "([^"]+)"/)[1]), ['settings.small', 'input', 'needs']);
});

test('validateElement: a loosening remote gate is refused in validateDescriptor\'s own words', () => {
  const desc = { type: 'sticky', family: 'page', remote: { see: 'basic', send: 'full' } };
  let words = null;
  try { validateDescriptor(desc); } catch (e) { words = e.message; }
  assert.ok(words, 'validateDescriptor refuses it');
  const v = validateElement({ ...desc, schema: 'sticky@1', anchors: ['element'] }, { name: 'sticky' });
  assert.equal(v.ok, false);
  assert.deepStrictEqual(v.errors, [`element "sticky": ${words}`]);
  assert.equal(v.descriptor, null);
  // send below see, a family that is not one, private not a boolean — the same check.
  for (const bad of [
    { remote: { see: 'full', send: 'read' } },
    { family: 'canvas' },
    { private: 'yes' },
    { remote: undefined },
  ]) {
    const raw = { type: 'sticky', family: 'page', remote: { see: 'read', send: 'full' }, schema: 'sticky@1', anchors: ['element'], ...bad };
    if (raw.remote === undefined) delete raw.remote;
    const r = validateElement(raw, { name: 'sticky' });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.errors[0], /^element "sticky": element-policy: element type "sticky": /);
  }
});

test('validateElement: anchors outside ANCHOR_KINDS, a bad schema, bad reads and a type that is not its directory are refused', () => {
  const ok = { type: 'sticky', family: 'page', remote: { see: 'read', send: 'full' }, schema: 'sticky@1', anchors: ['element'] };
  const cases = [
    [{ anchors: ['pin'] }, /"anchors" must be a non-empty list from element, range, source, page, point, turn, item, item-range, diff-line \(got \["pin"\]\)/],
    [{ anchors: [] }, /"anchors" must be a non-empty list/],
    [{ anchors: undefined }, /"anchors" must be a non-empty list .*\(got null\)/],
    [{ schema: 'sticky@0' }, /"schema" must be "sticky@<n>", n a positive integer \(got "sticky@0"\)/],
    [{ schema: 'Sticky@1' }, /"schema" must be "sticky@<n>"/],
    [{ schema: 'sticky' }, /"schema" must be "sticky@<n>"/],
    [{ schema: 'sticky@1.5' }, /"schema" must be/],
    [{ schema: 1 }, /"schema" must be/],
    [{ reads: [] }, /"reads" must be a non-empty list of "sticky@<n>" schemas/],
    [{ reads: ['comment@1'] }, /"reads" must be a non-empty list of "sticky@<n>" schemas/],
    [{ reads: ['sticky@2'] }, /"reads" must include the type's own schema "sticky@1"/],
    [{ type: 'other' }, /element\.json says type "other" — a type's name is its directory's name, "sticky"/],
  ];
  for (const [over, re] of cases) {
    const raw = { ...ok, ...over };
    for (const k of Object.keys(raw)) if (raw[k] === undefined) delete raw[k];
    const v = validateElement(raw, { name: 'sticky' });
    assert.equal(v.ok, false, JSON.stringify(over));
    assert.ok(v.errors.some((e) => re.test(e)), `${JSON.stringify(over)} → ${v.errors.join(' | ')}`);
    assert.ok(v.errors.every((e) => e.startsWith('element "sticky": ')));
  }
  assert.equal(validateElement(null, { name: 'sticky' }).ok, false);
  assert.equal(validateElement(['x'], { name: 'sticky' }).ok, false);
});

test('validateElement: draw.js is required from a stage, except for a built-in type', () => {
  const stage = elementPack({ name: 'nodraw-pack', elements: [el('ghost', { draw: null })] });
  const raw = readElementJson(path.join(stage, 'elements', 'ghost'));
  assert.equal(raw.ok, true);
  const v = validateElement(raw.raw, { stageDir: stage, name: 'ghost' });
  assert.deepStrictEqual(v.errors, ['element "ghost": elements/ghost/draw.js is missing']);
  assert.equal(validateElement(raw.raw, { stageDir: stage, name: 'ghost', builtin: true }).ok, true);
  assert.equal(validateElement(raw.raw, { name: 'ghost' }).ok, true, 'no stage, no file check');
  assert.deepStrictEqual(readElementJson(path.join(stage, 'elements', 'nope')), { ok: false, error: 'element.json is missing' });
});

test('elementFiles: element.json, draw.js, then assets/** depth first; nothing else in the directory installs', () => {
  const stage = elementPack({ name: 'files-pack', elements: [el('sticky', { assets: { 'b.svg': SVG, 'a/z.svg': SVG, 'a/b/c.svg': SVG } })] });
  write(path.join(stage, 'elements', 'sticky', 'README.md'), 'not a unit file\n');
  assert.deepStrictEqual(elementFiles(path.join(stage, 'elements', 'sticky')),
    ['element.json', 'draw.js', 'assets/a/b/c.svg', 'assets/a/z.svg', 'assets/b.svg']);
});

// ── validateManifest ────────────────────────────────────────────────────────
test('validateManifest accepts elements-only, elements + components and elements + skill packs', () => {
  const only = elementPack({ name: 'mark-pack', elements: [el('sticky', { json: { payload: PAYLOAD } })] });
  let m = validateManifest(parseManifest(only), { stageDir: only });
  assert.equal(m.ok, true, m.errors.join('; '));
  assert.deepStrictEqual(m.elements.map((e) => [e.name, e.schema, e.reads, e.anchors]), [['sticky', 'sticky@1', ['sticky@1'], ['element', 'range']]]);
  assert.deepStrictEqual(m.components, []);
  assert.deepStrictEqual(m.warnings, [], 'an elements-only pack needs no skill, and lists something');

  const mixed = elementPack({ name: 'mixed-pack', elements: [el('flag')], components: [{ name: 'flag-board' }] });
  m = validateManifest(parseManifest(mixed), { stageDir: mixed });
  assert.equal(m.ok, true, m.errors.join('; '));
  assert.deepStrictEqual(m.components.map((c) => c.name), ['flag-board']);
  assert.deepStrictEqual(m.elements.map((e) => e.name), ['flag']);

  const withSkill = elementPack({ name: 'skill-pack', elements: [el('callout', { json: { payload: PAYLOAD } })], skill: true });
  m = validateManifest(parseManifest(withSkill), { stageDir: withSkill });
  assert.equal(m.ok, true, m.errors.join('; '));
  assert.equal(m.skill.present, true);
  assert.deepStrictEqual(m.warnings, []);
});

test('validateManifest: element list errors, and the existing strings unchanged', () => {
  const stage = elementPack({ name: 'mark-pack', elements: [el('sticky')] });
  const raw = parseManifest(stage);
  let m = validateManifest({ ...raw, elements: ['sticky', 'sticky', 'Bad_Name', ''] }, { stageDir: stage });
  assert.ok(m.errors.includes('element "sticky" is listed twice'));
  assert.ok(m.errors.includes('element "Bad_Name": names must be kebab-case'));
  assert.ok(m.errors.includes('element "": names must be kebab-case'));
  m = validateManifest({ ...raw, elements: ['missing'] }, { stageDir: stage });
  assert.deepStrictEqual(m.errors, ['element "missing": elements/missing/element.json is missing']);
  m = validateManifest({ ...raw, elements: 'sticky' }, { stageDir: stage });
  assert.ok(m.errors.includes('web-chat-pack.json: "elements" must be an array of element type names (directories under elements/)'));
  // A pack still has to list at least one kind, in the words it always used.
  m = validateManifest({ name: 'empty-pack' }, { stageDir: null });
  assert.deepStrictEqual(m.errors, ['web-chat-pack.json: "components" must be an array of directory names (a pack that ships only themes lists "themes" instead)']);
  m = validateManifest({ name: 'empty-pack', elements: [] }, { stageDir: null });
  assert.deepStrictEqual(m.errors, ['web-chat-pack.json: "components" must be an array of directory names (a pack that ships only themes lists "themes" instead)']);
  m = validateManifest({ name: 'empty-pack', components: [] }, { stageDir: null });
  assert.ok(m.warnings.includes('web-chat-pack.json: lists no components — only the skill would be installed'));
});

// K.2-27: the no-kinds warning looked each row's list up in a hand-written
// {components, themes}, so the element row's listKey threw a TypeError out of
// validateManifest — documented as never throwing for a content problem.
test('validateManifest never throws for a listKey row whose list it does not build', () => {
  // The element row itself: an elements-only manifest with no stage reaches
  // the warning loop with nothing refused.
  const m = validateManifest({ name: 'mark-pack', version: '1.0.0', elements: ['sticky'] }, {});
  assert.equal(m.ok, true, m.errors.join('; '));
  assert.deepStrictEqual(m.elements, [{ name: 'sticky' }]);
  assert.ok(!m.warnings.some((w) => /lists no components/.test(w)));

  // And a row this function has never heard of: load manifest.js over a table
  // with one more listed row, as a later kind would add.
  const kindsPath = require.resolve('../lib/packs/kinds');
  const manifestPath = require.resolve('../lib/packs/manifest');
  const real = require.cache[kindsPath].exports;
  const gizmo = Object.freeze({ ...real.UNIT_KINDS[0], kind: 'gizmo', manifestKey: 'gizmos', listKey: 'gizmos' });
  delete require.cache[manifestPath];
  require.cache[kindsPath].exports = { ...real, UNIT_KINDS: Object.freeze([...real.UNIT_KINDS, gizmo]) };
  let fresh;
  try { fresh = require(manifestPath); } finally {
    require.cache[kindsPath].exports = real;
    delete require.cache[manifestPath];
    require(manifestPath);
  }
  let out;
  assert.doesNotThrow(() => { out = fresh.validateManifest({ name: 'giz-pack', gizmos: ['g'] }, {}); });
  assert.deepStrictEqual(out.errors, []);
  assert.ok(out.warnings.includes('web-chat-pack.json: lists no components — only the skill would be installed'));
  assert.doesNotThrow(() => fresh.validateManifest({ name: 'giz-pack', components: ['a'] }, {}));
});

// ── F10 x1: the three round trips ───────────────────────────────────────────
const VARIANTS = {
  a_elements_only: () => elementPack({ name: 'mark-pack', elements: [el('sticky')] }),
  b_elements_components: () => elementPack({ name: 'mixed-pack', elements: [el('flag')], components: [{ name: 'flag-board' }] }),
  c_elements_skill: () => elementPack({ name: 'skill-pack', elements: [el('callout')], skill: true }),
};

for (const [key, build] of Object.entries(VARIANTS)) {
  test(`x1 round trip ${key}: quarantine → approve → verify intact → remove leaves nothing`, async (t) => {
    const root = project(t);
    const dir = build();
    const raw = parseManifest(dir);
    const m = validateManifest(raw, { stageDir: dir });
    assert.equal(m.ok, true, m.errors.join('; '));
    const plan = planInstall({ stageDir: dir, manifest: m, tier: 'local', root });
    assert.deepStrictEqual(plan.errors, []);
    const type = raw.elements[0];
    const elUnit = plan.units.find((u) => u.kind === 'element');
    assert.deepStrictEqual(elUnit.files.map((f) => f.path), ['element.json', 'draw.js', 'assets/icon.svg', 'assets/img/dot.svg']);
    assert.equal(elUnit.dir, path.join(projectPaths(root).elementTypesDir, type));

    const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(dir, { sha: SHA }) } });
    await packs.quarantinePack({ url: forge.url('acme', 'marks'), root });
    const before = surface(root);
    const out = packs.approvePack({ name: raw.name, root });
    assert.equal(out.ok, true);

    const found = findPack(root, raw.name, 'local');
    assert.ok(found, 'recorded');
    assert.deepStrictEqual(found.pack.elements, [type], 'the record lists its types under the row\'s listKey');
    assert.ok(found.pack.units.some((u) => u.kind === 'element' && u.name === type));
    const typeDir = path.join(projectPaths(root).elementTypesDir, type);
    for (const f of ['element.json', 'draw.js', 'assets/icon.svg', 'assets/img/dot.svg']) {
      assert.ok(fs.existsSync(path.join(typeDir, f)), `${f} installed under element-types/${type}/`);
    }
    const v = verifyPack(found.pack, { root, tier: 'local' });
    assert.equal(v.drift, false);
    assert.ok(v.units.every((u) => u.state === 'intact'));
    assert.deepStrictEqual(readPending(root, 'local'), []);
    const listed = packs.listInstalled({ root }).packs.find((p) => p.name === raw.name);
    assert.deepStrictEqual(listed.elements, [type], 'listInstalled carries elements');

    const removed = packs.removePackByName({ name: raw.name, root });
    assert.equal(removed.removedAll, true);
    assert.equal(findPack(root, raw.name, 'local'), null);
    assert.deepStrictEqual(surface(root), before, 'the project and the user tier are as they were before the install: 0 files left');
    assert.equal(fs.existsSync(typeDir), false, 'the unit directory goes too, its nested assets/img/ first');
  });
}

// ── F10 x1: the four controls ───────────────────────────────────────────────
const CONTROLS = [
  ['a built-in type name', () => elementPack({ name: 'shadow-pack', elements: [el('comment')] }),
    /element "comment" is a built-in element type name \(comment, highlight, box-grab, chat-comment\)\. Refused, in either tier; there is no override — rename the type\./],
  ['a bad schema (comment@0)', () => elementPack({ name: 'bad-pack', elements: [el('wobbly', { json: { schema: 'comment@0' } })] }),
    /element "wobbly": "schema" must be "wobbly@<n>", n a positive integer \(got "comment@0"\)/],
  ['a bad schema (Sticky@1)', () => elementPack({ name: 'bad-pack', elements: [el('sticky', { json: { schema: 'Sticky@1' } })] }),
    /element "sticky": "schema" must be "sticky@<n>", n a positive integer \(got "Sticky@1"\)/],
  ['a bad schema (sticky)', () => elementPack({ name: 'bad-pack', elements: [el('sticky', { json: { schema: 'sticky' } })] }),
    /element "sticky": "schema" must be "sticky@<n>", n a positive integer \(got "sticky"\)/],
  ['a missing draw.js', () => elementPack({ name: 'nodraw-pack', elements: [el('ghost', { draw: null })] }),
    /element "ghost": elements\/ghost\/draw\.js is missing/],
  ['the built-in pack\'s name', () => elementPack({ name: 'web-chat-builtins', elements: [el('extra-type')] }),
    /"web-chat-builtins" is the name of web-chat's own built-in element pack\. Refused; there is no override — rename the pack\./],
];

for (const [what, build, re] of CONTROLS) {
  test(`x1 control: ${what} is refused in its own words, 0 files written (either tier, --replace or not)`, (t) => {
    const root = project(t);
    const stage = build();
    for (const tier of ['local', 'system']) {
      for (const replace of [false, true]) {
        const before = tree(root);
        const homeBefore = files(userPaths().root);
        let err = null;
        try { packs.installFromStage({ stageDir: stage, source: SOURCE, tier, root, replace, via: 'approve' }); } catch (e) { err = e; }
        assert.ok(err, `${what} refused (${tier}${replace ? ', --replace' : ''})`);
        assert.ok(err.userFacing);
        assert.match(err.message, re);
        assert.deepStrictEqual(tree(root), before, '0 files written in the project');
        assert.deepStrictEqual(files(userPaths().root), homeBefore, '0 files written in the user tier');
      }
    }
  });
}

test('x1 control: a built-in type name through quarantine is shown in the review and refused at approve', async (t) => {
  const root = project(t);
  const dir = elementPack({ name: 'shadow-pack', elements: [el('highlight'), el('sticky')] });
  const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(dir, { sha: SHA }) } });
  const { record } = await packs.quarantinePack({ url: forge.url('acme', 'marks'), root });
  assert.ok(record.errors.some((e) => /element "highlight" is a built-in element type name/.test(e)));
  const before = tree(root);
  assert.throws(() => packs.approvePack({ name: 'shadow-pack', root, replace: true }), /element "highlight" is a built-in element type name/);
  const after = tree(root);
  // approve refused before the install; only its staged copy under .web-chat/packs remains.
  assert.deepStrictEqual(after, before);
  assert.equal(fs.existsSync(projectPaths(root).elementTypesDir), false);
});

test('the plan refuses a built-in type name too, should validation be skipped (belt and braces)', (t) => {
  const root = project(t);
  const stage = elementPack({ name: 'shadow-pack', elements: [el('box-grab')] });
  const plan = planInstall({ stageDir: stage, manifest: { name: 'shadow-pack', elements: [{ name: 'box-grab', schema: 'box-grab@1', reads: ['box-grab@1'], anchors: ['page'] }] }, tier: 'local', root, replace: true });
  assert.deepStrictEqual(plan.errors, ['element "box-grab" is a built-in type name — refused']);
  assert.deepStrictEqual(plan.collisions.map((c) => [c.kind, c.name, c.severity, c.owner]), [['element', 'box-grab', 'refused', 'builtin']]);
  assert.deepStrictEqual(plan.units, []);
  const traversal = planInstall({ stageDir: stage, manifest: { name: 'x-pack', elements: [{ name: '../escape' }] }, tier: 'local', root });
  assert.deepStrictEqual(traversal.errors, ['element "../escape": names must be kebab-case — refused']);
});

// ── F10 x1: four forced throws mid-apply ────────────────────────────────────
// A throwing copyFileSync for the nth file copied INTO the project (the
// journal's own snapshots and the staging tree under .web-chat/packs/ are
// never counted and never throw); disarmed once it fires so the unwind's
// restores get through — the pack-transaction tests' shape. `seen` keeps
// each counted destination, so a case can say where its throw landed.
function throwOnCopy(t, nth) {
  const real = fs.copyFileSync;
  const skip = path.join('.web-chat', 'packs');
  const seen = [];
  let armed = true;
  fs.copyFileSync = function patched(src, dest, ...rest) {
    const d = String(dest);
    if (armed && !d.includes(skip)) {
      seen.push({ dest: d, existed: fs.existsSync(d) });
      if (seen.length === nth) {
        armed = false;
        const e = new Error(`EIO: i/o error, copyfile '${d}'`);
        e.code = 'EIO';
        throw e;
      }
    }
    return real.call(fs, src, dest, ...rest);
  };
  const restore = () => { fs.copyFileSync = real; };
  t.after(restore);
  return { seen, restore };
}

function unwind(t, { first = null, second, nth }) {
  const root = project(t);
  if (first) packs.installFromStage({ stageDir: first, source: SOURCE, tier: 'local', root, via: 'approve' });
  const before = tree(root);
  const { seen, restore } = throwOnCopy(t, nth);
  let err = null;
  try { packs.installFromStage({ stageDir: second, source: SOURCE, tier: 'local', root, via: 'approve' }); } catch (e) { err = e; }
  restore();
  assert.ok(err, 'the forced throw surfaced');
  assert.match(err.message, /EIO/);
  assert.equal(err.rollbackErrors, undefined, 'the unwind finished');
  assert.deepStrictEqual(tree(root), before, 'unwound to 0 files: every file, every directory, every overwrite');
  assert.deepStrictEqual(readPending(root, 'local'), []);
  return { root, threwOn: seen[nth - 1], seen };
}

test('x1 unwind: a throw on a nested asset file of a fresh install leaves 0 files', (t) => {
  const { threwOn } = unwind(t, { second: elementPack({ name: 'mark-pack', elements: [el('sticky')] }), nth: 4 });
  assert.match(threwOn.dest, /element-types[\\/]sticky[\\/]assets[\\/]img[\\/]dot\.svg$/);
  assert.equal(threwOn.existed, false);
});

test('x1 unwind: a throw on the second type\'s first file, after the first type\'s assets/img/ exists', (t) => {
  const { threwOn, seen } = unwind(t, { second: elementPack({ name: 'two-pack', elements: [el('sticky'), el('second')] }), nth: 5 });
  assert.match(seen[3].dest, /sticky[\\/]assets[\\/]img[\\/]dot\.svg$/, 'the nested directory was made and filled first');
  assert.match(threwOn.dest, /element-types[\\/]second[\\/]element\.json$/);
});

test('x1 unwind: a throw on the very first file leaves 0 files', (t) => {
  const { threwOn } = unwind(t, { second: elementPack({ name: 'mark-pack', elements: [el('sticky')] }), nth: 1 });
  assert.match(threwOn.dest, /element-types[\\/]sticky[\\/]element\.json$/);
});

test('x1 unwind: a throw on an overwrite in a same-pack update restores the previous bytes', (t) => {
  const v1 = elementPack({ name: 'mark-pack', version: '1.0.0', elements: [el('sticky')] });
  const v2 = elementPack({ name: 'mark-pack', version: '2.0.0', elements: [el('sticky', { draw: "export default function draw() { /* v2 */ }\n" }), el('second')] });
  const { threwOn, root } = unwind(t, { first: v1, second: v2, nth: 2 });
  assert.match(threwOn.dest, /element-types[\\/]sticky[\\/]draw\.js$/);
  assert.equal(threwOn.existed, true, 'the throw landed on an overwrite');
  assert.equal(fs.readFileSync(path.join(projectPaths(root).elementTypesDir, 'sticky', 'draw.js'), 'utf8'), DRAW('sticky'));
  assert.equal(findPack(root, 'mark-pack', 'local').pack.version, '1.0.0');
});

test('a same-pack update prunes a dropped asset and its emptied directory', (t) => {
  const root = project(t);
  packs.installFromStage({ stageDir: elementPack({ name: 'mark-pack', version: '1.0.0', elements: [el('sticky')] }), source: SOURCE, tier: 'local', root, via: 'approve' });
  const out = packs.installFromStage({
    stageDir: elementPack({ name: 'mark-pack', version: '1.1.0', elements: [el('sticky', { assets: { 'icon.svg': SVG } }), el('pin-two')] }),
    source: SOURCE, tier: 'local', root, via: 'approve',
  });
  assert.ok(out.results.some((r) => r.kind === 'element' && r.name === 'sticky' && r.action === 'pruned'));
  const dir = path.join(projectPaths(root).elementTypesDir, 'sticky');
  assert.equal(fs.existsSync(path.join(dir, 'assets', 'img')), false);
  assert.ok(fs.existsSync(path.join(dir, 'assets', 'icon.svg')));
  assert.ok(fs.existsSync(path.join(projectPaths(root).elementTypesDir, 'pin-two', 'draw.js')));
  assert.deepStrictEqual(out.pack.elements, ['sticky', 'pin-two']);
  assert.equal(verifyPack(out.pack, { root, tier: 'local' }).drift, false);
});

// ── the element log is never touched ────────────────────────────────────────
test('the element log\'s directory is byte-identical across an element pack\'s install and removal', (t) => {
  const root = project(t);
  const p = projectPaths(root);
  write(p.elementsLog, '{"t":"ver","id":"c1","v":1}\n{"t":"commit","node":"n1"}\n');
  write(p.elementsBootReport, '{"ok":true}\n');
  const logDir = () => ({ files: files(p.elementsDir), entries: fs.readdirSync(p.elementsDir).sort() });
  const before = logDir();

  const stage = elementPack({ name: 'mark-pack', elements: [el('sticky'), el('elements')] });
  const m = validateManifest(parseManifest(stage), { stageDir: stage });
  const plan = planInstall({ stageDir: stage, manifest: m, tier: 'local', root });
  for (const u of plan.units) {
    assert.ok(!(u.dir === p.elementsDir || u.dir.startsWith(p.elementsDir + path.sep)), `${u.kind} ${u.name} plans nothing under the log's directory`);
  }
  packs.installFromStage({ stageDir: stage, source: SOURCE, tier: 'local', root, via: 'approve' });
  assert.deepStrictEqual(logDir(), before, 'after the install');
  assert.ok(fs.existsSync(path.join(p.elementTypesDir, 'elements', 'draw.js')), 'a type named "elements" lands in element-types/, not on the log');
  packs.removePackByName({ name: 'mark-pack', root, force: true });
  assert.deepStrictEqual(logDir(), before, 'after the removal');
});

// ── tiers and the ladder ────────────────────────────────────────────────────
test('--global installs under ~/.web-chat/element-types/<type>/ and removes from there', async (t) => {
  const root = project(t);
  const dir = elementPack({ name: 'mark-pack', elements: [el('sticky')] });
  const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(dir, { sha: SHA }) } });
  await packs.quarantinePack({ url: forge.url('acme', 'marks'), root, tier: 'system' });
  const out = packs.approvePack({ name: 'mark-pack', root });
  assert.equal(out.tier, 'system');
  const typeDir = path.join(userPaths().elementTypesDir, 'sticky');
  for (const f of ['element.json', 'draw.js', 'assets/img/dot.svg']) assert.ok(fs.existsSync(path.join(typeDir, f)), f);
  assert.equal(fs.existsSync(projectPaths(root).elementTypesDir), false, 'nothing in the project');
  packs.removePackByName({ name: 'mark-pack', root, tier: 'system' });
  assert.equal(fs.existsSync(typeDir), false);
});

test('the collision ladder: update for this pack\'s own copy, replace for another\'s or the user\'s, shadowed across tiers', (t) => {
  const root = project(t);
  const a = elementPack({ name: 'mark-pack', elements: [el('sticky')] });
  const b = elementPack({ name: 'other-pack', elements: [el('sticky')] });
  const plan = (stage, opts = {}) => planInstall({ stageDir: stage, manifest: validateManifest(parseManifest(stage), { stageDir: stage }), tier: 'local', root, ...opts });
  packs.installFromStage({ stageDir: a, source: SOURCE, tier: 'local', root, via: 'approve' });

  let p = plan(a);
  assert.deepStrictEqual(p.errors, []);
  assert.deepStrictEqual(p.collisions.map((c) => [c.severity, c.owner]), [['update', 'mark-pack']]);

  p = plan(b);
  assert.deepStrictEqual(p.errors, ['element type "sticky" belongs to the pack "mark-pack" — remove that pack, or re-run in a terminal with --replace']);
  assert.deepStrictEqual(plan(b, { replace: true }).errors, []);

  // The user's own copy, no pack's.
  write(path.join(projectPaths(root).elementTypesDir, 'mine', 'element.json'), '{}\n');
  const c = elementPack({ name: 'mine-pack', elements: [el('mine')] });
  p = plan(c);
  assert.deepStrictEqual(p.errors, ['element type "mine" already exists and was not installed by a pack — re-run in a terminal with --replace to overwrite it']);
  assert.equal(p.collisions[0].owner, 'you');

  // Across tiers: the project's copy keeps winning.
  p = planInstall({ stageDir: a, manifest: validateManifest(parseManifest(a), { stageDir: a }), tier: 'system', root });
  assert.deepStrictEqual(p.errors, []);
  assert.deepStrictEqual(p.collisions.map((x) => [x.kind, x.severity, x.owner]), [['element', 'shadowed', 'this project']]);
  write(path.join(userPaths().elementTypesDir, 'flag', 'element.json'), '{}\n');
  const d = elementPack({ name: 'flag-pack', elements: [el('flag')] });
  p = plan(d);
  assert.deepStrictEqual(p.collisions.map((x) => [x.severity, x.owner]), [['shadowed', 'all projects']]);
});

// ── listings and the CLI ────────────────────────────────────────────────────
async function runPack(args, cwd) {
  const pack = require('../lib/cli/commands/pack');
  const lines = [];
  const was = { log: console.log, error: console.error, exit: process.exit, cwd: process.cwd() };
  const EXIT = Symbol('exit');
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(`[err] ${a.join(' ')}`);
  process.exit = (code) => { lines.push(`[exit ${code}]`); throw EXIT; };
  process.chdir(cwd);
  try { await pack(args); } catch (e) { if (e !== EXIT) throw e; } finally {
    console.log = was.log; console.error = was.error; process.exit = was.exit; process.chdir(was.cwd);
  }
  return lines.join('\n');
}

test('pack review / approve / list / info print an element pack\'s types', async (t) => {
  const root = project(t);
  const dir = elementPack({ name: 'mark-pack', elements: [el('sticky', { json: { reads: ['sticky@1'], anchors: ['range', 'page'] } })] });
  const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(dir, { sha: SHA }) } });
  await packs.quarantinePack({ url: forge.url('acme', 'marks'), root });

  const review = await runPack(['review', 'mark-pack'], root);
  assert.match(review, /\n {2}element types\n {4}sticky {2}\[schema sticky@1 · reads sticky@1 · anchors range, page · draw\.js — RUNS IN THE SURFACE PAGE\]/);
  assert.doesNotMatch(review, /\n {2}components\n/, 'no empty components heading for an elements-only pack');
  assert.match(review, /no SKILL\.md — none needed: an element type is an annotation tool on the surface\./);
  assert.match(review, /elements\/sticky\/draw\.js/, 'draw.js is in the file list');

  const listQ = packs.listInstalled({ root }).quarantined.find((q) => q.name === 'mark-pack');
  assert.deepStrictEqual(listQ.elements.map((e) => [e.name, e.schema, e.reads, e.anchors, e.draw]), [['sticky', 'sticky@1', ['sticky@1'], ['range', 'page'], 'draw.js']]);

  const approve = await runPack(['approve', 'mark-pack'], root);
  assert.match(approve, /element sticky\s+created/);
  assert.match(approve, /\n {2}element type {2}sticky\n/);

  const list = await runPack(['list'], root);
  assert.match(list, /\n {4}elements: {3}sticky\n/);
  assert.doesNotMatch(list, /components: —/, 'no empty components line for an elements-only pack with no skill');

  const info = await runPack(['info', 'mark-pack'], root);
  assert.match(info, /\n {4}element {3}sticky {19}intact\n/);
});

// ── the detachable glyph (U587, H.7; DECISIONS L.1 M4 a, K.2-151) ─────────────
// element.json's `glyph: {detach, leader?}` — the engine's detachable glyph,
// adopted by a type through its manifest: accepted and kept as written (the
// registry's toolbar bag carries it); an unknown key, a non-boolean detach and
// another leader are refused, each hint naming the three leaders; absent is
// attached, as before.
const GLYPH_DESC = (glyph) => ({ type: 'sticky', family: 'page', remote: { see: 'read', send: 'full' }, schema: 'sticky@1',
  anchors: ['element'], ...(glyph === undefined ? {} : { glyph }) });
test('glyph {detach: true, leader: \'dotted\'} is accepted and kept as written; absent is attached (no field, no warning)', () => {
  const { GLYPH_LEADERS, TOOLBAR_KEYS } = require('../lib/packs/elements');
  assert.deepStrictEqual(GLYPH_LEADERS, ['dotted', 'faint', 'hover']);
  assert.ok(TOOLBAR_KEYS.includes('glyph'), 'a toolbar field, kept in the descriptor as written');
  for (const glyph of [{ detach: true, leader: 'dotted' }, { detach: true, leader: 'faint' }, { detach: true, leader: 'hover' },
    { detach: true }, { detach: false }]) {
    const v = validateElement(GLYPH_DESC(glyph), { name: 'sticky' });
    assert.deepStrictEqual([v.ok, v.errors], [true, []], JSON.stringify(glyph));
    assert.ok(!v.warnings.some((w) => /glyph/.test(w)), `${JSON.stringify(glyph)}: no warning`);
    assert.deepStrictEqual(v.descriptor.glyph, glyph, 'kept as written');
  }
  const absent = validateElement(GLYPH_DESC(undefined), { name: 'sticky' });
  assert.equal(absent.ok, true);
  assert.equal('glyph' in absent.descriptor, false, 'absent: attached, today\'s behaviour');
});

test('glyph: an unknown leader, a non-boolean detach and an extra key are refused, the hint naming the three leaders', () => {
  const cases = [
    [{ detach: true, leader: 'wavy' }, /"glyph\.leader" must be one of dotted, faint, hover \(got "wavy"\)/],
    [{ detach: 'yes', leader: 'dotted' }, /"glyph\.detach" must be true or false \(got "yes"\).*dotted \| faint \| hover/],
    [{ leader: 'dotted' }, /"glyph\.detach" must be true or false \(got null\)/],
    [{ detach: true, leader: 'dotted', offset: 4 }, /"glyph\.offset" is not a glyph field \(detach, leader\).*dotted \| faint \| hover/],
    ['dotted', /"glyph" must be \{detach: true, leader\?: dotted \| faint \| hover\}/],
    [true, /"glyph" must be \{detach: true, leader\?: dotted \| faint \| hover\}/],
  ];
  for (const [glyph, re] of cases) {
    const v = validateElement(GLYPH_DESC(glyph), { name: 'sticky' });
    assert.equal(v.ok, false, JSON.stringify(glyph));
    assert.equal(v.descriptor, null);
    assert.ok(v.errors.some((e) => re.test(e)), `${JSON.stringify(glyph)}: ${v.errors.join(' | ')}`);
  }
});

// ── the fixture strokes pack declares the page (tranche 5, U625) ────────────
// DECISIONS.md C5: a type declares the anchor kinds it accepts. The checked-in
// test-support/element-packs/strokes-fixture validates through the one
// manifest path with anchors ['element', 'page'] (no error, no warning); a
// box-placed type cannot drop 'element' for 'page' alone — place 'box' sizes
// the marker to an element target (lib/packs/elements.js's place rule).
test('U625: the strokes fixture\'s manifest validates with anchors [element, page]; place box with anchors [page] alone is refused, naming the rule', () => {
  const stage = path.join(__dirname, '..', 'test-support', 'element-packs', 'strokes-fixture');
  const m = validateManifest(parseManifest(stage), { stageDir: stage });
  assert.equal(m.ok, true, m.errors.join('; '));
  assert.deepStrictEqual(m.warnings, []);
  assert.deepStrictEqual(m.elements.map((e) => [e.name, e.schema, e.reads, e.anchors]), [['scribble', 'scribble@1', ['scribble@1'], ['element', 'page']]]);
  const d = m.elements[0].descriptor;
  assert.deepStrictEqual([d.input, d.place, d.private], ['strokes', 'box', true]);

  const read = readElementJson(path.join(stage, 'elements', 'scribble'));
  assert.equal(read.ok, true);
  const pageOnly = validateElement({ ...read.raw, anchors: ['page'] }, { stageDir: stage, name: 'scribble' });
  assert.equal(pageOnly.ok, false);
  assert.equal(pageOnly.descriptor, null);
  assert.ok(pageOnly.errors.some((e) => /^element "scribble": "place"/.test(e) && /"box" sizes the marker to an element target, so the type's "anchors" must include "element" \(got \["page"\]\)/.test(e)),
    pageOnly.errors.join(' | '));
  // The same place with 'page' AND 'element' is the fixture as shipped.
  const both = validateElement({ ...read.raw, anchors: ['page', 'element'] }, { stageDir: stage, name: 'scribble' });
  assert.equal(both.ok, true, both.errors.join('; '));
  assert.deepStrictEqual(both.descriptor.anchors, ['page', 'element'], 'kept in the order written');
});

// ── the blend seam's manifest field (U624; HIGHLIGHTER@blend-seam, H4 = b) ─────
// element.json's `composite: 'multiply'` (lib/packs/elements COMPOSITE_MODES):
// a box type's group gets a second container, group.blend, on the overlay's
// blend layer. Validated here (any other value refused naming the field; a
// type not placed 'box' refused, since only a box marker has the part);
// absent is none, as before. Accepted, it is kept as written in the
// descriptor and so rides the listing row's toolbar bag (every key that is
// not a ROW_KEYS key), which is what the chrome reads beside input and place.
const BLEND_DESC = (extra) => ({ type: 'marker-pen', family: 'page', remote: { see: 'read', send: 'full' }, schema: 'marker-pen@1',
  anchors: ['element'], input: 'strokes', place: 'box', ...extra });
test('composite \'multiply\' validates on a box type and is kept as written; it rides the listing row\'s toolbar bag; absent passes with no field', () => {
  const { COMPOSITE_MODES, TOOLBAR_KEYS } = require('../lib/packs/elements');
  const { ROW_KEYS } = require('../lib/server/element-types');
  assert.deepStrictEqual(COMPOSITE_MODES, ['multiply']);
  assert.ok(Object.isFrozen(COMPOSITE_MODES));
  assert.ok(TOOLBAR_KEYS.includes('composite'), 'a toolbar field, kept as written');
  assert.ok(!ROW_KEYS.includes('composite'), 'not a row key: the listing carries it in toolbar, beside input and place');
  const v = validateElement(BLEND_DESC({ composite: 'multiply' }), { name: 'marker-pen' });
  assert.deepStrictEqual([v.ok, v.errors], [true, []]);
  assert.ok(!v.warnings.some((w) => /composite/.test(w)), 'checked, so no "this build does not check" warning');
  assert.equal(v.descriptor.composite, 'multiply', 'kept as written');
  const absent = validateElement(BLEND_DESC({}), { name: 'marker-pen' });
  assert.deepStrictEqual([absent.ok, absent.errors], [true, []]);
  assert.equal('composite' in absent.descriptor, false, 'absent: no blend, today\'s behaviour');
});

test('composite: \'screen\', \'overlay\' and any other value are refused naming the field; on a type not placed \'box\' it is refused', () => {
  for (const composite of ['screen', 'overlay', 'normal', 'MULTIPLY', true, 1, null, { mode: 'multiply' }]) {
    const v = validateElement(BLEND_DESC({ composite }), { name: 'marker-pen' });
    assert.equal(v.ok, false, JSON.stringify(composite));
    assert.equal(v.descriptor, null);
    assert.ok(v.errors.some((e) => /"composite" must be multiply, or left out for none/.test(e)),
      `${JSON.stringify(composite)}: ${v.errors.join(' | ')}`);
  }
  for (const place of [undefined, 'glyph']) {
    const desc = BLEND_DESC({ composite: 'multiply' });
    if (place === undefined) delete desc.place; else desc.place = place;
    const v = validateElement(desc, { name: 'marker-pen' });
    assert.equal(v.ok, false, `place ${place}`);
    assert.ok(v.errors.some((e) => /"composite" "multiply" blends a box marker's second container, so the type's "place" must be "box"/.test(e)),
      `place ${place}: ${v.errors.join(' | ')}`);
  }
});

test('composite through validateManifest: the staged element\'s descriptor carries it, so what review saw is what the listing serves', () => {
  const dir = elementPack({ name: 'blend-pack', elements: [el('marker-pen', { json: { anchors: ['element'], input: 'strokes', place: 'box',
    composite: 'multiply', payload: PAYLOAD } })] });
  const m = validateManifest(parseManifest(dir), { stageDir: dir });
  assert.equal(m.ok, true, m.errors.join(' | '));
  assert.deepStrictEqual(m.warnings, []);
  const staged = m.elements.find((e) => e.name === 'marker-pen');
  assert.ok(staged, 'the element is staged');
  assert.equal(staged.descriptor.composite, 'multiply');
});
