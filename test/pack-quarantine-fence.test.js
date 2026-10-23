// Two corrections to the element pack's review path (annotation engine
// tranche 2, U322b; DECISIONS.md K.2-86, from U322a's hand-off).
//
// (1) THE FENCE. lib/packs/tree stageQuarantine checked the directory it was
// about to CREATE with isInside, which realpaths only the side that exists.
// Under a project root reached through a symlink (macOS $TMPDIR, a symlinked
// home) the first pack staged fine, but once .web-chat/packs/quarantine/
// existed the second read as outside it, and `pack get` refused it with
// "resolves outside the quarantine directory". It now makes the quarantine
// directory and checks the new one with `fence` (lib/core/paths).
//
// (2) THE CODE. The install route answered a userFacing refusal with its
// message and no `code`, so the drawer read the element-review refusal by its
// words. The route now carries the error's own code (a string) beside the
// hint — 'element-review' for that one — and a refusal that has none carries
// none.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const packs = require('../lib/packs/install');
const { listQuarantine } = require('../lib/packs/store');
const { projectPaths } = require('../lib/core/paths');
const { packFixture, tmpDir, fakeForge, repoWithArchive } = require('../test-support/packs');
const { withServer, withTempHome } = require('../test-support/helpers');

const SHA = 'a'.repeat(40);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>\n';
const DRAW = "export default function draw(el, ctx) { ctx.box(el).textContent = 'mark'; }\n";

function elementPack(name, type) {
  const body = { type, family: 'page', remote: { see: 'read', send: 'full' }, schema: `${type}@1`, reads: [`${type}@1`], anchors: ['element', 'range'] };
  return packFixture({
    name, version: '1.0.0', components: [], skill: false,
    manifest: { name, version: '1.0.0', description: 'Marks on the surface.', elements: [type] },
    extraFiles: {
      [`elements/${type}/element.json`]: JSON.stringify(body, null, 2) + '\n',
      [`elements/${type}/draw.js`]: DRAW,
      [`elements/${type}/assets/icon.svg`]: SVG,
    },
  });
}

// A project whose root is a SYMLINK: the spelling the caller holds is not its
// realpath, as under macOS's /var → /private/var $TMPDIR.
function symlinkedProject(t) {
  withTempHome(t);
  const real = tmpDir('wc-qf-real-');
  fs.mkdirSync(path.join(real, '.web-chat'), { recursive: true });
  const root = path.join(tmpDir('wc-qf-link-'), 'proj');
  fs.symlinkSync(real, root, 'dir');
  assert.notEqual(fs.realpathSync(root), root, 'the root is reached through a symlink');
  return root;
}

test('`pack get` stages a second element pack in a project whose root is reached through a symlink', async (t) => {
  const root = symlinkedProject(t);
  const forge = await fakeForge(t, {
    repos: {
      'acme/marks': repoWithArchive(elementPack('mark-pack', 'sticky'), { sha: SHA }),
      'acme/flags': repoWithArchive(elementPack('flag-pack', 'flag'), { sha: SHA }),
    },
  });

  // The path `pack get` takes: lib/packs/install quarantinePack over a fetch.
  const first = await packs.quarantinePack({ url: forge.url('acme', 'marks'), root });
  assert.equal(first.record.name, 'mark-pack');
  assert.ok(fs.existsSync(projectPaths(root).quarantine), 'the quarantine directory exists for the second stage');
  const second = await packs.quarantinePack({ url: forge.url('acme', 'flags'), root });
  assert.equal(second.record.name, 'flag-pack');

  assert.deepStrictEqual(listQuarantine().map((q) => q.name).sort(), ['flag-pack', 'mark-pack']);
  for (const [name, type] of [['mark-pack', 'sticky'], ['flag-pack', 'flag']]) {
    const r = packs.reviewQuarantine({ name, root });
    assert.equal(r.manifest.name, name);
    assert.deepStrictEqual(r.record.elements.map((e) => e.name), [type]);
    assert.ok(r.tree.some((f) => f.path === `elements/${type}/draw.js`), `${name}: its draw.js is in the reviewed tree`);
    assert.equal(packs.reviewQuarantine({ name, root, file: `elements/${type}/draw.js` }).text, DRAW);
  }
});

test('a name that resolves outside the quarantine directory is still refused under a symlinked root', async (t) => {
  // The fix does not loosen the fence: it still runs, now over a parent that
  // exists. A name is kebab-case before it gets here, so the way out left to
  // test is an entry in the quarantine directory that is a symlink elsewhere.
  const root = symlinkedProject(t);
  const elsewhere = tmpDir('wc-qf-elsewhere-');
  fs.mkdirSync(path.join(elsewhere, 'mark-pack'));
  fs.mkdirSync(projectPaths(root).quarantine, { recursive: true });
  fs.symlinkSync(path.join(elsewhere, 'mark-pack'), path.join(projectPaths(root).quarantine, 'mark-pack'), 'dir');
  const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack('mark-pack', 'sticky'), { sha: SHA }) } });
  await assert.rejects(packs.quarantinePack({ url: forge.url('acme', 'marks'), root }), /resolves outside the quarantine directory/);
  assert.deepStrictEqual(fs.readdirSync(path.join(elsewhere, 'mark-pack')), [], 'nothing written through the link');
});

test('POST /api/packs/install answers an element pack\'s refusal with code "element-review"; a component pack\'s refusal carries no code', async (t) => {
  await withServer(t, async ({ api }) => {
    const forge = await fakeForge(t, {
      repos: {
        'acme/marks': repoWithArchive(elementPack('mark-pack', 'sticky'), { sha: SHA }),
        'acme/bad': repoWithArchive(packFixture({ name: 'acme-bad', components: [{ name: 'Bad_Board' }] }), { sha: SHA }),
        'acme/badname': repoWithArchive(packFixture({ name: 'Bad_Name', components: [{ name: 'deploy-board' }] }), { sha: SHA }),
      },
    });

    const r = await api.post('/api/packs/install', { url: forge.url('acme', 'marks') });
    assert.equal(r.status, 200, 'a refusal is not a transport failure');
    assert.equal(r.json.ok, false);
    assert.equal(r.json.rejected, true);
    assert.equal(r.json.code, 'element-review');
    assert.match(r.json.hint, /installs only after a review/);

    // A component with a bad name: the manifest's refusal, which has no code.
    const b = await api.post('/api/packs/install', { url: forge.url('acme', 'bad') });
    assert.equal(b.status, 200, b.text);
    assert.equal(b.json.ok, false);
    assert.equal(b.json.rejected, true);
    assert.match(b.json.hint, /Bad_Board/);
    assert.equal('code' in b.json, false, `no code on a refusal that has none: ${b.text}`);

    // A pack with a bad name: lib/core/names' refusal carries a code of its
    // own, and the route passes that one on — never element-review.
    const n = await api.post('/api/packs/install', { url: forge.url('acme', 'badname') });
    assert.equal(n.json.ok, false, n.text);
    assert.equal(n.json.code, 'name-invalid');
  });
});
