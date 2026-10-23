// The UNIT_KINDS table (lib/packs/kinds.js; annotation engine tranche 2, U321).
//
// The pack pipeline used to spell each unit kind as its own `if` arm in six
// files — a destination in store.js, a name check, a result label, a remove
// branch and the review lists in tree.js, the record and listing lists in
// install.js, one ladder per kind in plan.js, the "components, or themes only"
// rule in manifest.js and the CLI's themesOf. The table puts each kind in one
// row, so a new kind (the element kind, U322) is a row rather than sixteen
// arms. The move had to change NOTHING anyone can see, so most of this file is
// a byte-for-byte comparison against outputs recorded from the code before the
// move (test/fixtures/pack-kinds-plans.json, recorded once at ae/int 39b52f8):
// every plan, every validateManifest answer, the records and audit lines an
// install, an approve and a remove leave behind, and the text `pack list`,
// `pack info`, `pack review`, `pack approve` and `pack remove` print.
//
// Recording (only ever against the code BEFORE a deliberate output change, and
// then reviewed as a diff): PACK_KINDS_RECORD=<file> runs the same scenarios
// and writes what they produced there instead of comparing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { packFixture, tmpDir, write, fakeForge, repoWithArchive } = require('../test-support/packs');
const { projectPaths, userPaths, claudePaths, userClaudePaths, homeDir } = require('../lib/core/paths');
const { validateManifest, parseManifest } = require('../lib/packs/manifest');
const { planInstall } = require('../lib/packs/plan');
const { unitDir } = require('../lib/packs/store');
const packs = require('../lib/packs/install');

const FIXTURE = path.join(__dirname, 'fixtures', 'pack-kinds-plans.json');
const RECORD = process.env.PACK_KINDS_RECORD || null;
const EXPECTED = RECORD ? null : JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const recorded = {};

// ── normalising what differs between runs ───────────────────────────────────
// Temp directories, the fake forge's port and timestamps. Everything else —
// key order included — is compared as the JSON text it serialises to.
const LABELS = [];
function label(dir, name) { LABELS.push([dir, name]); return dir; }
function norm(value) {
  let s = JSON.stringify(value);
  if (s === undefined) return null;
  const pairs = [...LABELS, [homeDir(), '<home>'], [fs.realpathSync(os.tmpdir()), '<tmp>']]
    .sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of pairs) s = s.split(JSON.stringify(from).slice(1, -1)).join(to);
  s = s.replace(/http:\/\/127\.0\.0\.1:\d+/g, '<forge>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>');
  return JSON.parse(s);
}

function check(key, value) {
  const got = norm(value);
  if (RECORD) { recorded[key] = got; return; }
  assert.ok(Object.prototype.hasOwnProperty.call(EXPECTED, key), `no recorded fixture for ${key}`);
  assert.equal(JSON.stringify(got, null, 1), JSON.stringify(EXPECTED[key], null, 1), `${key} differs from the output recorded before the move`);
}

test.after(() => {
  if (RECORD) fs.writeFileSync(RECORD, JSON.stringify(recorded, null, 2) + '\n');
});

// ── the six packs ───────────────────────────────────────────────────────────
const SERVICE = 'module.exports = { start(ctx) { return () => {}; } };\n';
const SEED = 'module.exports = () => ({ seeded: true });\n';
const THEME = (accent) => ({ tokens: { '--wc-accent': accent, '--wc-bg': '#101010', '--wc-fg': '#f0f0f0' } });

function sixPacks() {
  return {
    'components-only': packFixture({
      name: 'kinds-comp', components: [{ name: 'deploy-board', service: SERVICE }, { name: 'status-tile', seed: SEED }], skill: false,
    }),
    'themes-only': packFixture({
      name: 'kinds-theme', components: [], themes: [{ name: 'harbor', theme: THEME('#c0ffee') }], skill: false,
      manifest: { name: 'kinds-theme', version: '0.1.0', description: 'A theme.', themes: ['harbor'] },
    }),
    'skill-only': packFixture({ name: 'kinds-skill', components: [], skill: true }),
    'all-three': packFixture({
      name: 'kinds-all', components: [{ name: 'ops-board' }], themes: [{ name: 'lagoon', theme: THEME('#00aaee') }], skill: true,
    }),
    'builtin-component': packFixture({ name: 'kinds-builtin', components: [{ name: 'git-dashboard' }, { name: 'fine-tile' }], skill: true }),
    'theme-owned-elsewhere': packFixture({
      name: 'kinds-theme-b', components: [], themes: [{ name: 'harbor', theme: THEME('#bada55') }], skill: false,
      manifest: { name: 'kinds-theme-b', version: '0.2.0', themes: ['harbor'] },
    }),
  };
}

function newProject(name) {
  const proj = label(tmpDir('wc-kinds-proj-'), `<proj:${name}>`);
  fs.mkdirSync(path.join(proj, '.web-chat'), { recursive: true });
  return proj;
}

const SOURCE = { via: 'tarball', sha: 'a'.repeat(40), url: 'https://github.com/acme/kinds' };

// ── the table itself ────────────────────────────────────────────────────────
test('UNIT_KINDS lists component, theme and skill, in the order planInstall emits units', () => {
  if (RECORD) return;
  const { UNIT_KINDS, kindOf, unitsOf, namesOf } = require('../lib/packs/kinds');
  assert.deepEqual(UNIT_KINDS.map((r) => r.kind), ['component', 'theme', 'skill']);
  assert.ok(Object.isFrozen(UNIT_KINDS));
  for (const r of UNIT_KINDS) {
    assert.ok(Object.isFrozen(r), `${r.kind}'s row is frozen`);
    for (const k of ['kind', 'manifestKey', 'dest', 'checksName', 'reserved', 'plan', 'label', 'listKey']) {
      assert.ok(k in r, `${r.kind}'s row has ${k}`);
    }
  }
  assert.deepEqual(UNIT_KINDS.map((r) => r.listKey), ['components', 'themes', null]);
  assert.deepEqual(UNIT_KINDS.map((r) => r.checksName), [true, false, true]);
  assert.equal(kindOf('theme'), UNIT_KINDS[1]);
  for (const k of ['element', '__proto__', 'constructor', '', null, undefined]) assert.equal(kindOf(k), null, String(k));
  const units = [{ kind: 'theme', name: 'a' }, null, { kind: 'component', name: 'b' }, { kind: 'theme', name: 'c' }];
  assert.deepEqual(unitsOf(units, 'theme'), [units[0], units[3]]);
  assert.deepEqual(namesOf(units, 'theme'), ['a', 'c']);
  assert.deepEqual(namesOf(undefined, 'theme'), []);
  assert.equal(UNIT_KINDS[0].label({ kind: 'component', name: 'x' }), 'component x');
  assert.equal(UNIT_KINDS[1].label({ kind: 'theme', name: 'y' }), 'theme y');
  assert.equal(UNIT_KINDS[2].label({ kind: 'skill', name: 'z' }), 'skill z');
  assert.equal(UNIT_KINDS[0].reserved('git-dashboard'), true);
  assert.equal(UNIT_KINDS[0].reserved('deploy-board'), false);
  assert.equal(UNIT_KINDS[1].reserved('paper'), true);
  assert.equal(UNIT_KINDS[1].reserved('harbor'), false);
  // Read, not re-typed: the reserved skill names are derived from the managed files.
  const { reservedSkillNames } = require('../lib/packs/manifest');
  assert.ok(reservedSkillNames().length);
  for (const n of reservedSkillNames()) assert.equal(UNIT_KINDS[2].reserved(n), true, n);
  assert.equal(UNIT_KINDS[2].reserved('acme-ops'), false);
});

// The paths unitDir answered at 39b52f8, written out.
test('each row\'s dest is what unitDir answered before the table, in both tiers', () => {
  if (RECORD) return;
  const { kindOf } = require('../lib/packs/kinds');
  const root = path.join(os.tmpdir(), 'kinds-dest-root');
  const home = homeDir();
  const want = {
    local: {
      component: path.join(root, '.web-chat', 'components', 'deploy-board'),
      theme: path.join(root, '.web-chat', 'themes'),
      skill: path.join(root, '.claude', 'skills', 'deploy-board'),
    },
    system: {
      component: path.join(home, '.web-chat', 'components', 'deploy-board'),
      theme: path.join(home, '.web-chat', 'themes'),
      skill: path.join(home, '.claude', 'skills', 'deploy-board'),
    },
  };
  for (const tier of ['local', 'system']) {
    for (const kind of ['component', 'theme', 'skill']) {
      const unit = { kind, name: 'deploy-board' };
      assert.equal(kindOf(kind).dest(unit, tier, root), want[tier][kind], `${kind} in ${tier}`);
      assert.equal(unitDir(unit, tier, root), want[tier][kind], `unitDir delegates: ${kind} in ${tier}`);
    }
  }
  // The same answers through the path authority, so the written-out paths
  // above cannot drift from it unnoticed.
  assert.equal(want.local.theme, projectPaths(root).themesDir);
  assert.equal(want.system.theme, userPaths().themesDir);
  assert.equal(want.local.skill, claudePaths(root).skillDir('deploy-board'));
  assert.equal(want.system.skill, userClaudePaths().skillDir('deploy-board'));
  assert.throws(() => unitDir({ kind: 'not-a-kind', name: 'x' }, 'local', root), /^Error: unknown pack unit kind: not-a-kind$/);
  assert.throws(() => unitDir({ kind: '__proto__', name: 'x' }, 'local', root), /unknown pack unit kind: __proto__/);
});

// ── planInstall and validateManifest, byte for byte ─────────────────────────
test('planInstall and validateManifest answer exactly what they answered before the table', () => {
  const fixtures = sixPacks();
  for (const [k, dir] of Object.entries(fixtures)) label(dir, `<stage:${k}>`);
  const proj = newProject('plans');
  // The project the plans run against: the user's own `status-tile` (the
  // "your own" ladder rung) and `harbor` installed by another pack.
  write(path.join(projectPaths(proj).components, 'status-tile', 'component.html'), '<div>mine</div>\n');
  packs.installFromStage({ stageDir: fixtures['themes-only'], source: SOURCE, tier: 'local', root: proj });

  for (const [k, dir] of Object.entries(fixtures)) {
    const manifest = validateManifest(parseManifest(dir), { stageDir: dir, webChatVersion: '0.8.5' });
    check(`validate:${k}`, manifest);
    check(`plan:${k}:local`, planInstall({ stageDir: dir, manifest, tier: 'local', root: proj }));
    check(`plan:${k}:local:replace`, planInstall({ stageDir: dir, manifest, tier: 'local', root: proj, replace: true }));
    check(`plan:${k}:system`, planInstall({ stageDir: dir, manifest, tier: 'system', root: proj }));
  }

  // Manifests the six packs do not cover: empty, themes-only with no tree, a
  // components that is not an array, an empty themes list, a themes that is
  // not an array.
  const empty = label(tmpDir('wc-kinds-empty-'), '<stage:empty>');
  const odd = {
    empty: {},
    'themes-only-no-tree': { name: 'kinds-t', version: '1.0.0', themes: ['harbor'] },
    'components-not-array': { name: 'kinds-x', version: '1.0.0', components: 'deploy-board' },
    'components-null-themes-empty': { name: 'kinds-y', components: null, themes: [] },
    'themes-not-array': { name: 'kinds-z', components: [], themes: 'harbor' },
    'components-object-themes-listed': { name: 'kinds-w', components: {}, themes: ['harbor'] },
  };
  for (const [k, m] of Object.entries(odd)) {
    check(`validate:${k}`, validateManifest(m, { stageDir: empty, webChatVersion: '0.8.5' }));
    check(`validate:${k}:no-stage`, validateManifest(m, { webChatVersion: '0.8.5' }));
  }
  check('validate:undefined', validateManifest(undefined, { webChatVersion: '0.8.5' }));
});

// ── the CLI, the records and the audit, byte for byte ───────────────────────
async function runPack(args, cwd) {
  const pack = require('../lib/cli/commands/pack');
  const lines = [];
  const was = { log: console.log, error: console.error, exit: process.exit, cwd: process.cwd() };
  const EXIT = Symbol('exit');
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(`[err] ${a.join(' ')}`);
  // `die` exits the process; here an exit is a line of output like any other.
  process.exit = (code) => { lines.push(`[exit ${code}]`); throw EXIT; };
  process.chdir(cwd);
  try { await pack(args); } catch (e) { if (e !== EXIT) throw e; } finally {
    console.log = was.log; console.error = was.error; process.exit = was.exit; process.chdir(was.cwd);
  }
  return lines.join('\n');
}

// Every file the pipeline leaves behind in a project's .web-chat/ and .claude/
// and in the user tier's .web-chat/, by relative path. Records, the ledger,
// the audit log, the quarantine plan.json and the installed bytes.
function snapshot(proj) {
  const out = {};
  const walk = (base, tag) => {
    const go = (dir) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) go(abs);
        else if (e.isFile()) out[`${tag}/${path.relative(base, abs).split(path.sep).join('/')}`] = fs.readFileSync(abs, 'utf8');
      }
    };
    go(base);
  };
  walk(path.join(proj, '.web-chat'), 'proj/.web-chat');
  walk(path.join(proj, '.claude'), 'proj/.claude');
  walk(userPaths().root, 'home/.web-chat');
  return out;
}

test('pack install, approve, list, info, review and remove print, record and audit exactly as before', async (t) => {
  const fixtures = sixPacks();
  for (const [k, dir] of Object.entries(fixtures)) label(dir, `<stage:${k}>`);
  const proj = newProject('cli');

  for (const k of ['components-only', 'themes-only', 'skill-only']) {
    const out = packs.installFromStage({ stageDir: fixtures[k], source: SOURCE, tier: 'local', root: proj });
    check(`install:${k}:results`, { results: out.results, pack: out.pack, warnings: out.warnings });
  }
  // An all-projects install, then the same pack again: the update path.
  check('install:all-three:system', packs.installFromStage({ stageDir: fixtures['all-three'], source: SOURCE, tier: 'system', root: proj }).results);
  check('install:all-three:system:again', packs.installFromStage({ stageDir: fixtures['all-three'], source: SOURCE, tier: 'system', root: proj }).results);

  // A refused install keeps its error text.
  for (const k of ['builtin-component', 'theme-owned-elsewhere']) {
    let err = null;
    try { packs.installFromStage({ stageDir: fixtures[k], source: SOURCE, tier: 'local', root: proj }); } catch (e) { err = e; }
    assert.ok(err, `${k} is refused`);
    check(`install:${k}:refused`, { message: err.message, errors: err.errors, collisions: err.collisions, warnings: err.warnings });
  }

  // Quarantine through the real fetch path, so plan.json and the review card
  // are the pipeline's own.
  const forge = await fakeForge(t, {
    repos: {
      'acme/all': repoWithArchive(fixtures['all-three'], { sha: 'b'.repeat(40) }),
      'acme/theme': repoWithArchive(fixtures['theme-owned-elsewhere'], { sha: 'c'.repeat(40) }),
      'acme/builtin': repoWithArchive(fixtures['builtin-component'], { sha: 'd'.repeat(40) }),
    },
  });
  const q = {};
  for (const [repo, name] of [['all', 'kinds-all'], ['theme', 'kinds-theme-b'], ['builtin', 'kinds-builtin']]) {
    const { record } = await packs.quarantinePack({ url: forge.url('acme', repo), root: proj });
    q[name] = record;
    label(record.dir, `<quarantine:${name}>`);
    if (record.pack_dir) label(record.pack_dir, `<quarantine-pack:${name}>`);
  }
  check('quarantine:records', q);

  check('cli:list', await runPack(['list'], proj));
  check('cli:list:verify', await runPack(['list', '--verify'], proj));
  for (const name of ['kinds-comp', 'kinds-theme', 'kinds-skill', 'kinds-all']) check(`cli:info:${name}`, await runPack(['info', name], proj));
  for (const name of ['kinds-all', 'kinds-theme-b', 'kinds-builtin']) check(`cli:review:${name}`, await runPack(['review', name], proj));
  check('cli:approve:kinds-all', await runPack(['approve', 'kinds-all'], proj));
  check('cli:list:after-approve', await runPack(['list', '--verify'], proj));
  check('records:after-install', snapshot(proj));

  // Remove: one edited unit kept, then forced; a theme pack; the dry run first.
  fs.appendFileSync(path.join(projectPaths(proj).components, 'deploy-board', 'component.html'), '<!-- edited -->\n');
  check('cli:remove:kinds-comp', await runPack(['remove', 'kinds-comp'], proj));
  check('cli:info:kinds-comp:kept', await runPack(['info', 'kinds-comp'], proj));
  check('cli:remove:kinds-comp:force', await runPack(['remove', 'kinds-comp', '--force'], proj));
  check('cli:remove:kinds-theme:dry', await runPack(['remove', 'kinds-theme', '--dry-run'], proj));
  check('cli:remove:kinds-theme', await runPack(['remove', 'kinds-theme'], proj));
  check('cli:remove:kinds-all', await runPack(['remove', 'kinds-all'], proj));
  check('cli:remove:kinds-all:global', await runPack(['remove', 'kinds-all', '--global'], proj));
  check('cli:remove:kinds-skill', await runPack(['remove', 'kinds-skill'], proj));
  check('cli:list:after-remove', await runPack(['list'], proj));
  check('records:after-remove', snapshot(proj));
});
