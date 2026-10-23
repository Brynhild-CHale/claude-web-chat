// The built-in element pack and its boot step (annotation engine tranche 2,
// U323; PLAN.md 2C.2, DECISIONS.md B2, readiness R7 §3 rows 3 and 8, F10 X-3).
//
// templates/elements/web-chat-builtins/ is the first pack: the daemon installs
// it at every boot through lib/packs/install installFromStage (via 'builtin'),
// from lib/server/builtins seedElementTypes, which seedBuiltins calls after its
// component loop. This file holds X-3's measurements as tests:
//
//   * three boots of a fresh project: the first installs (record, ledger
//     entry, one audit line op 'builtin', files under element-types/), the
//     second and third write 0 files and change 0 bytes;
//   * a user edit is repaired at the next boot (verifyPack drift), and so is
//     a record whose files are not what this build's pipeline installs;
//   * a shipped-tree change (one type revised, one added, one dropped)
//     reinstalls, the dropped type pruned; a version bump alone reinstalls;
//   * `pack remove web-chat-builtins` (CLI) and DELETE /api/packs/web-chat-
//     builtins are refused with the hint, the record and files kept;
//   * third parties cannot ship a built-in type name (with --replace or not)
//     or take the pack's name, 0 files written;
//   * a failed install logs one line, returns {error}, and the daemon boots;
//   * no network call during any boot.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { seedBuiltins, seedElementTypes, ELEMENTS_TEMPLATE_DIR } = require('../lib/server/builtins');
const { resolvePaths } = require('../lib/server/paths');
const { projectPaths, userPaths } = require('../lib/core/paths');
const { BUILTIN_ELEMENT_PACK, BUILTIN_ELEMENT_TYPE_NAMES } = require('../lib/core/names');
const { findPack, findLedgerEntry, readAudit } = require('../lib/packs/store');
const { verifyPack } = require('../lib/packs/tree');
const packs = require('../lib/packs/install');
const { packFixture, tmpDir } = require('../test-support/packs');
const { withTempHome, withServer } = require('../test-support/helpers');

const HINT = 'the built-in types ship with web-chat; they cannot be removed';

function project(t) {
  withTempHome(t);
  const root = tmpDir('wc-builtin-el-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  return root;
}

// Every file and directory under a directory: rel → sha256 | 'dir'.
function snapshot(dir) {
  const out = {};
  (function walk(d) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      if (e.isDirectory()) { out[`${rel}/`] = 'dir'; walk(abs); } else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  })(dir);
  return out;
}

// Both tiers a boot can touch: the project and the (sandboxed) user tier.
const both = (root) => ({ project: snapshot(root), home: snapshot(userPaths().root) });

// Every fs call that can write, counted while fn runs, wherever it writes.
const WRITERS = ['writeFileSync', 'appendFileSync', 'copyFileSync', 'renameSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'rmdirSync', 'cpSync', 'symlinkSync', 'truncateSync'];
function countWrites(fn) {
  const real = {};
  const calls = [];
  for (const k of WRITERS) {
    real[k] = fs[k];
    fs[k] = function probe(...args) { calls.push(k); return real[k].apply(fs, args); };
  }
  try { return { value: fn(), calls }; } finally { for (const k of WRITERS) fs[k] = real[k]; }
}

// X-3's sentinel: any outbound connection while fn runs is counted and refused.
function noNetwork(fn) {
  const mods = { http: require('http'), https: require('https'), net: require('net') };
  const names = { http: ['request', 'get'], https: ['request', 'get'], net: ['connect', 'createConnection'] };
  const seen = [];
  const real = [];
  for (const [m, fns] of Object.entries(names)) {
    for (const f of fns) {
      real.push([mods[m], f, mods[m][f]]);
      mods[m][f] = () => { seen.push(`${m}.${f}`); throw new Error(`network refused (${m}.${f})`); };
    }
  }
  try { return { value: fn(), seen }; } finally { for (const [mod, f, orig] of real) mod[f] = orig; }
}

// One boot of the element step, measured.
function boot(root, opts = {}) {
  const before = both(root);
  const said = [];
  const net = noNetwork(() => countWrites(() => seedElementTypes({ root }, { log: (m) => said.push(m), ...opts })));
  return { report: net.value.value, writes: net.value.calls.length, network: net.seen, said, before, after: both(root) };
}

const typeDir = (root, type) => path.join(projectPaths(root).elementTypesDir, type);
const builtinAudit = (root) => readAudit(root, { limit: 1000 }).filter((e) => e.pack === BUILTIN_ELEMENT_PACK);

// A copy of the shipped tree to change, standing in for a later build's.
function stubTemplate() {
  const dir = path.join(tmpDir('wc-builtin-ship-'), BUILTIN_ELEMENT_PACK);
  fs.cpSync(ELEMENTS_TEMPLATE_DIR, dir, { recursive: true });
  return dir;
}
const editJson = (file, fn) => fs.writeFileSync(file, JSON.stringify(fn(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2) + '\n');

// ── three boots ─────────────────────────────────────────────────────────────

test('x3: the first boot installs; the second and third write 0 files and change 0 bytes', (t) => {
  const root = project(t);
  const first = boot(root);
  assert.deepStrictEqual(first.network, []);
  assert.equal(first.report.installed, true);
  assert.equal(first.report.reason, 'absent');
  assert.equal(first.report.version, '1.0.0');
  assert.deepStrictEqual(first.said, []);

  const found = findPack(root, BUILTIN_ELEMENT_PACK, 'local');
  assert.ok(found, 'the record is written');
  assert.equal(found.pack.version, '1.0.0');
  assert.deepStrictEqual(found.pack.source, { via: 'builtin', sha: first.report.sha, version: '1.0.0' });
  assert.deepStrictEqual(found.pack.elements, [...BUILTIN_ELEMENT_TYPE_NAMES]);
  assert.equal(found.pack.actor, 'web-chat');
  const ledger = findLedgerEntry(root, BUILTIN_ELEMENT_PACK);
  assert.ok(ledger, 'the ledger entry the registry\'s record gate reads');
  assert.deepStrictEqual(ledger.source, found.pack.source);
  const audit = builtinAudit(root);
  assert.equal(audit.length, 1, 'one audit line');
  assert.equal(audit[0].op, 'builtin');
  assert.equal(audit[0].via, 'builtin');
  assert.equal(audit[0].actor, 'web-chat');
  for (const type of BUILTIN_ELEMENT_TYPE_NAMES) {
    const installed = path.join(typeDir(root, type), 'element.json');
    assert.ok(fs.existsSync(installed), `element-types/${type}/element.json`);
    assert.equal(fs.readFileSync(installed, 'utf8'), fs.readFileSync(path.join(ELEMENTS_TEMPLATE_DIR, 'elements', type, 'element.json'), 'utf8'));
  }
  assert.equal(projectPaths(root).elementTypesDir, path.join(root, '.web-chat', 'element-types'));
  assert.equal(fs.existsSync(path.join(projectPaths(root).elementsDir, 'comment')), false, 'never beside the element log');

  for (const n of [2, 3]) {
    const b = boot(root);
    assert.deepStrictEqual(b.report, { installed: false, reason: 'intact', version: '1.0.0', sha: first.report.sha }, `boot ${n}`);
    assert.equal(b.writes, 0, `boot ${n}: 0 fs writes`);
    assert.deepStrictEqual(b.after, b.before, `boot ${n}: 0 bytes changed`);
    assert.deepStrictEqual(b.network, [], `boot ${n}: no network`);
    assert.deepStrictEqual(b.said, []);
  }
  assert.equal(builtinAudit(root).length, 1, 'steady boots append no audit line');
});

test('seedBuiltins runs the element step after its component loop and returns its report', (t) => {
  const root = project(t);
  const paths = resolvePaths(root);
  const out = seedBuiltins(paths, { log: null });
  assert.deepStrictEqual(out.shadowed, []);
  assert.equal(out.elements.installed, true);
  const before = snapshot(projectPaths(root).elementTypesDir);
  const again = seedBuiltins(paths, { log: null });
  assert.equal(again.elements.installed, false);
  assert.equal(again.elements.reason, 'intact');
  assert.deepStrictEqual(snapshot(projectPaths(root).elementTypesDir), before);
});

// ── repair ──────────────────────────────────────────────────────────────────

test('x3: a user edit to an installed element.json is repaired at the next boot', (t) => {
  const root = project(t);
  boot(root);
  const file = path.join(typeDir(root, 'highlight'), 'element.json');
  const shipped = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, shipped.replace('"gold"', '"rust"'));
  assert.equal(verifyPack(findPack(root, BUILTIN_ELEMENT_PACK, 'local').pack, { root, tier: 'local' }).drift, true);

  const b = boot(root);
  assert.equal(b.report.installed, true);
  assert.equal(b.report.reason, 'drift');
  assert.equal(fs.readFileSync(file, 'utf8'), shipped);
  assert.equal(verifyPack(findPack(root, BUILTIN_ELEMENT_PACK, 'local').pack, { root, tier: 'local' }).drift, false);
  assert.equal(boot(root).writes, 0, 'and steady again after');
});

test('a deleted type directory, a lost record and a lost ledger entry are each put back at the next boot', (t) => {
  const root = project(t);
  boot(root);
  fs.rmSync(typeDir(root, 'box-grab'), { recursive: true });
  assert.equal(boot(root).report.reason, 'drift');
  assert.ok(fs.existsSync(path.join(typeDir(root, 'box-grab'), 'element.json')));

  // The record gone, the files still there: the reserved names are the pack's
  // own, so it takes them back rather than failing every boot.
  fs.writeFileSync(projectPaths(root).packs, JSON.stringify({ packs: [] }));
  const lost = boot(root);
  assert.equal(lost.report.reason, 'absent');
  assert.equal(lost.report.installed, true);
  assert.ok(findPack(root, BUILTIN_ELEMENT_PACK, 'local'));

  fs.writeFileSync(userPaths().packsLedger, JSON.stringify({ version: 1, installs: [] }));
  const noLedger = boot(root);
  assert.equal(noLedger.report.reason, 'no-ledger-entry');
  assert.ok(findLedgerEntry(root, BUILTIN_ELEMENT_PACK));
  assert.equal(boot(root).writes, 0);
});

test('a record whose files are not what this build\'s pipeline installs from the same tree is reinstalled', (t) => {
  const root = project(t);
  boot(root);
  // An earlier build's record: the same tree, the same version, fewer files
  // per type (as before the pipeline installed the icons element.json names).
  const file = projectPaths(root).packs;
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rec = store.packs.find((p) => p.name === BUILTIN_ELEMENT_PACK);
  rec.units.find((u) => u.name === 'comment').files = [];
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
  assert.equal(verifyPack(rec, { root, tier: 'local' }).drift, false, 'verifyPack alone cannot see it');

  const b = boot(root);
  assert.equal(b.report.installed, true);
  assert.equal(b.report.reason, 'pipeline-change');
  assert.ok(findPack(root, BUILTIN_ELEMENT_PACK, 'local').pack.units.find((u) => u.name === 'comment').files.length > 0);
  assert.equal(boot(root).writes, 0);
});

// ── a later build's shipped tree ────────────────────────────────────────────

test('x3: a shipped-tree change (one revised, one added, one dropped) reinstalls cleanly; the dropped type is pruned', (t) => {
  const root = project(t);
  const ship = stubTemplate();
  const first = boot(root, { templateDir: ship });
  assert.equal(first.report.installed, true);

  editJson(path.join(ship, 'elements', 'highlight', 'element.json'), (j) => ({ ...j, anchors: ['range', 'source', 'element'] }));
  fs.mkdirSync(path.join(ship, 'elements', 'sticky'));
  fs.writeFileSync(path.join(ship, 'elements', 'sticky', 'element.json'), JSON.stringify({
    type: 'sticky', family: 'page', remote: { see: 'read', send: 'full' }, private: true, schema: 'sticky@1', anchors: ['page'],
  }));
  fs.rmSync(path.join(ship, 'elements', 'box-grab'), { recursive: true });
  editJson(path.join(ship, 'web-chat-pack.json'), (m) => ({ ...m, elements: ['comment', 'highlight', 'sticky'] }));

  const b = boot(root, { templateDir: ship });
  assert.deepStrictEqual(b.network, []);
  assert.equal(b.report.installed, true);
  assert.equal(b.report.reason, 'shipped-change', 'the same version, another digest');
  assert.notEqual(b.report.sha, first.report.sha);
  const rec = findPack(root, BUILTIN_ELEMENT_PACK, 'local').pack;
  assert.deepStrictEqual(rec.elements, ['comment', 'highlight', 'sticky']);
  assert.equal(rec.source.sha, b.report.sha);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(typeDir(root, 'highlight'), 'element.json'), 'utf8')).anchors, ['range', 'source', 'element']);
  assert.ok(fs.existsSync(path.join(typeDir(root, 'sticky'), 'element.json')), 'the added type installed');
  assert.equal(fs.existsSync(typeDir(root, 'box-grab')), false, 'the dropped type\'s directory pruned');
  const last = builtinAudit(root).at(-1);
  assert.deepStrictEqual(last.removed, ['element:box-grab']);
  assert.equal(verifyPack(rec, { root, tier: 'local' }).drift, false);
  assert.equal(boot(root, { templateDir: ship }).writes, 0, 'steady after the change');

  editJson(path.join(ship, 'web-chat-pack.json'), (m) => ({ ...m, version: '1.0.1' }));
  const bump = boot(root, { templateDir: ship });
  assert.equal(bump.report.reason, 'version');
  assert.equal(findPack(root, BUILTIN_ELEMENT_PACK, 'local').pack.version, '1.0.1');
  assert.equal(boot(root, { templateDir: ship }).writes, 0);
});

// ── failure ─────────────────────────────────────────────────────────────────

test('a boot whose install fails logs one line and returns {error}; nothing throws', (t) => {
  const root = project(t);
  fs.writeFileSync(projectPaths(root).elementTypesDir, 'not a directory\n');
  const b = boot(root);
  assert.ok(b.report.error, 'returns {error}');
  assert.equal(b.report.installed, undefined);
  assert.equal(b.said.length, 1, 'one line');
  assert.match(b.said[0], /^web-chat: the built-in element types \(web-chat-builtins\) could not be installed: /);
  assert.doesNotMatch(b.said[0], /\n/);
  assert.equal(findPack(root, BUILTIN_ELEMENT_PACK, 'local'), null);
  assert.deepStrictEqual(b.network, []);
});

test('a missing shipped tree is a logged {error} too, never a throw', (t) => {
  const root = project(t);
  const b = boot(root, { templateDir: path.join(tmpDir('wc-noship-'), BUILTIN_ELEMENT_PACK) });
  assert.ok(b.report.error);
  assert.equal(b.said.length, 1);
});

test('the daemon still boots when the install fails (withServer)', async (t) => {
  const said = [];
  t.mock.method(console, 'warn', (m) => { said.push(String(m)); });
  const { api, root } = await withServer(t, {
    seed: ({ root: r }) => { fs.writeFileSync(projectPaths(r).elementTypesDir, 'not a directory\n'); },
  });
  t.mock.restoreAll();
  const lines = said.filter((m) => m.includes('could not be installed'));
  assert.equal(lines.length, 1, 'one line on stderr');
  const health = await api.get('/api/health');
  assert.equal(health.status, 200);
  assert.equal(findPack(root, BUILTIN_ELEMENT_PACK, 'local'), null);
});

test('a fresh daemon boots with the built-in pack installed, listed by GET /api/packs (K.2-21)', async (t) => {
  const { api, root } = await withServer(t);
  assert.ok(findPack(root, BUILTIN_ELEMENT_PACK, 'local'));
  const r = await api.get('/api/packs');
  assert.equal(r.status, 200);
  const listed = r.json.packs.find((p) => p.name === BUILTIN_ELEMENT_PACK);
  assert.ok(listed, 'listed like any pack');
  assert.equal(listed.source.via, 'builtin', 'marked by its source');
  assert.deepStrictEqual(listed.elements, [...BUILTIN_ELEMENT_TYPE_NAMES]);
});

// ── remove refused ──────────────────────────────────────────────────────────

test('removePackByName refuses the built-in pack, forced or dry-run, and leaves the record and files', (t) => {
  const root = project(t);
  boot(root);
  const before = both(root);
  for (const opts of [{}, { force: true }, { dryRun: true }, { refuseOnDrift: true }, { tier: 'local' }, { tier: 'system' }]) {
    let err = null;
    try { packs.removePackByName({ name: BUILTIN_ELEMENT_PACK, root, ...opts }); } catch (e) { err = e; }
    assert.ok(err, `refused (${JSON.stringify(opts)})`);
    assert.equal(err.userFacing, true);
    assert.equal(err.hint, HINT);
    assert.equal(err.code, 'builtin-pack');
    assert.ok(err.message.includes(HINT));
  }
  assert.deepStrictEqual(both(root), before, 'the record and the files stay; no audit line');
});

function runCli(args, { home, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'claude-web-chat.js'), ...args], {
      cwd, env: { ...process.env, HOME: home, USERPROFILE: home, WEB_CHAT_NO_GH: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('`pack remove web-chat-builtins` (CLI) is refused with the hint; `pack list` shows the pack', async (t) => {
  const root = project(t);
  boot(root);
  const before = both(root);
  const home = process.env.HOME;
  for (const extra of [[], ['--force']]) {
    const r = await runCli(['pack', 'remove', BUILTIN_ELEMENT_PACK, ...extra], { home, cwd: root });
    assert.equal(r.status, 1, r.stdout);
    assert.ok(r.stderr.includes(HINT), r.stderr);
  }
  assert.deepStrictEqual(both(root), before);
  const list = await runCli(['pack', 'list'], { home, cwd: root });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /web-chat-builtins/);
});

test('DELETE /api/packs/web-chat-builtins is refused with the hint (withServer); the record and files stay', async (t) => {
  const { api, root } = await withServer(t);
  const before = snapshot(projectPaths(root).elementTypesDir);
  const r = await api.del(`/api/packs/${BUILTIN_ELEMENT_PACK}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.rejected, true);
  assert.ok(r.json.hint.includes(HINT), r.json.hint);
  assert.ok(findPack(root, BUILTIN_ELEMENT_PACK, 'local'));
  assert.deepStrictEqual(snapshot(projectPaths(root).elementTypesDir), before);
});

// ── third parties ───────────────────────────────────────────────────────────

const DRAW = 'export default function draw() {}\n';
function thirdParty({ name, types }) {
  const extraFiles = {};
  for (const type of types) {
    extraFiles[`elements/${type}/element.json`] = JSON.stringify({ type, family: 'page', remote: { see: 'read', send: 'full' }, schema: `${type}@1`, anchors: ['page'] });
    extraFiles[`elements/${type}/draw.js`] = DRAW;
  }
  return packFixture({ name, components: [], skill: false, manifest: { name, version: '9.9.9', description: 'not ours', elements: types }, extraFiles });
}

test('x3: third parties cannot ship a built-in type (with --replace or not) or take the pack\'s name; 0 files written', (t) => {
  const root = project(t);
  boot(root);
  const attempts = [
    ['a pack shipping comment', thirdParty({ name: 'shadow-pack', types: ['comment'] }), /element "comment" is a built-in element type name/],
    ['a pack shipping highlight beside its own type', thirdParty({ name: 'shadow-pack', types: ['sticky', 'highlight'] }), /element "highlight" is a built-in element type name/],
    ['a pack named web-chat-builtins', thirdParty({ name: BUILTIN_ELEMENT_PACK, types: ['sticky'] }), /"web-chat-builtins" is the name of web-chat's own built-in element pack/],
  ];
  const source = { via: 'tarball', sha: 'b'.repeat(40), url: 'https://github.com/acme/shadow' };
  for (const [what, stage, re] of attempts) {
    for (const via of ['approve', 'install']) {
      for (const replace of [false, true]) {
        for (const tier of ['local', 'system']) {
          const before = both(root);
          let err = null;
          try { packs.installFromStage({ stageDir: stage, source, tier, root, replace, via }); } catch (e) { err = e; }
          assert.ok(err, `${what} refused (${via}, ${tier}${replace ? ', --replace' : ''})`);
          assert.match(err.message, re);
          assert.deepStrictEqual(both(root), before, `${what}: 0 files written`);
        }
      }
    }
  }
  // 'builtin' is for web-chat's own pack alone.
  const other = thirdParty({ name: 'shadow-pack', types: ['comment'] });
  assert.throws(() => packs.installFromStage({ stageDir: other, source, tier: 'local', root, via: 'builtin' }),
    /only web-chat's own built-in element pack \("web-chat-builtins"\) installs as built-in — "shadow-pack" refused/);
  assert.deepStrictEqual(findPack(root, BUILTIN_ELEMENT_PACK, 'local').pack.source.via, 'builtin');
  assert.equal(boot(root).writes, 0, 'the built-in pack is untouched: the next boot is steady');
});
