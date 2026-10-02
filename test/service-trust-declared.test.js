// Declared params: `x-trust` in a component's params_schema.
//
// A service's consent identity is (project root, code, params). A component may
// mark a param `display` (never part of it) or `project-path` (left out while the
// value is a path inside the project root, its exact value otherwise). Anything
// else counts as absent. The declaration itself is part of the code hash, and a
// component WITHOUT one keeps the hash and key every approval on disk was
// recorded under — the golden tests below are what holds that.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { withServer, waitUntil: harnessWaitUntil } = require('../test-support/helpers');
const { mintIdentity, trustKey, paramsFingerprint } = require('../lib/server/services');
const {
  readTrustMarks, trustMarkWarnings, describeCovers, describeExact, coversProjectPath, pathReach,
} = require('../lib/core/trust-marks');
const { validateManifest } = require('../lib/packs/manifest');
const { serviceInfo } = require('../lib/server/components-registry');
const { resolvePaths } = require('../lib/server/paths');
const { packFixture } = require('../test-support/packs');
const { gatherState } = require('../lib/cli/init/state');
const { spawn } = require('child_process');

const waitUntil = (fn, opts) => harnessWaitUntil(fn, { timeout: 4000, interval: 40, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// A browser that stays connected: services run only while someone is watching.
// `sock.frames` keeps every frame it was sent, so a test can read the notice.
function openViewer(t, ctx) {
  return new Promise((resolve, reject) => {
    const sock = ctx.ws();
    sock.frames = [];
    t.after(() => { try { sock.close(); } catch {} });
    sock.on('message', (data) => {
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch {}
      if (msg) sock.frames.push(msg);
      if (msg && msg.type === 'hello') resolve(sock);
    });
    sock.on('error', reject);
  });
}

// ── the golden: no x-trust, today's identity ────────────────────────────────
// Computed with the 0.8.0 code (lib/server/services.js before x-trust) for this
// source, root and params. ~30 approvals on the maintainer's machine were
// recorded under keys minted this way; if either constant has to change, every
// one of them asks again.
const GOLDEN_SRC = 'module.exports = { async start(ctx) {}, async stop() {} };\n';
const GOLDEN_ROOT = '/golden/project';
const GOLDEN = {
  hash: 'fae5d216d637df18dec242a6dff89889815f1d124457d2bf788558f2890641f9',
  paramsFp: '59bc9102a8c7136f',
  key: 'f4a51eb51a172f80e606c0ad55b595752c13bdcbc42e85100c6d8996f7340b8f',
  emptyKey: 'f7d43330cc8d65653a4bd7f5d8b53fefb1a75ad583727cfd55fa9a203aa148e8',
};
const GOLDEN_PARAMS = { path: 'src/a.js', title: 'Notes', form_reset: true, unfenced: false };

// The 0.8.0 formula, spelled out with raw crypto rather than the module's own
// helpers, so a change to any of them cannot make this agree with itself.
function legacyKey(source, root, params) {
  const bag = {};
  for (const k of Object.keys(params || {}).sort()) {
    if (!['form_reset', 'routing', 'signals'].includes(k)) bag[k] = params[k];
  }
  const fp = sha256(JSON.stringify(bag)).slice(0, 16);
  return sha256(`${root}\0${sha256(source)}\0${fp}`);
}

test('golden: a component with no x-trust keeps the 0.8.0 hash and key', () => {
  assert.equal(sha256(GOLDEN_SRC), GOLDEN.hash);
  assert.equal(legacyKey(GOLDEN_SRC, GOLDEN_ROOT, GOLDEN_PARAMS), GOLDEN.key, 'the spelled-out formula reproduces the constant');

  const schemas = [
    undefined,
    {},
    { type: 'object', properties: { path: { type: 'string' }, title: { type: 'string' }, unfenced: { type: 'boolean' } } },
    // An unknown mark counts as absent — so it is not in the hash either.
    { type: 'object', properties: { path: { type: 'string', 'x-trust': 'project_path' }, title: { 'x-trust': 'Display' } } },
  ];
  for (const schema of schemas) {
    const id = mintIdentity({ root: GOLDEN_ROOT, sourceHash: GOLDEN.hash, schema, params: GOLDEN_PARAMS });
    assert.equal(id.hash, GOLDEN.hash, `the code hash is the plain sha256 of service.js (${JSON.stringify(schema)})`);
    assert.equal(id.paramsFp, GOLDEN.paramsFp, 'the params fingerprint is unchanged');
    assert.equal(id.key, GOLDEN.key, 'and so is the trust key');
    assert.deepEqual(id.covers, {}, 'it covers nothing');
    assert.equal(id.spawnFp, id.paramsFp, 'every param the child gets is part of its identity');
    assert.deepEqual(id.params, { path: 'src/a.js', title: 'Notes', unfenced: false }, 'the child gets the params minus the shell\'s keys');
  }
  assert.equal(mintIdentity({ root: GOLDEN_ROOT, sourceHash: GOLDEN.hash, schema: {}, params: {} }).key, GOLDEN.emptyKey);
  assert.equal(trustKey(GOLDEN.hash, GOLDEN_ROOT, paramsFingerprint({})), GOLDEN.emptyKey);
});

test('golden, end to end: the daemon mints the 0.8.0 key for a component with no x-trust', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/components', {
    name: 'plain', source: '<p>p</p>', description: 'p', service: GOLDEN_SRC,
    params_schema: { type: 'object', properties: { path: { type: 'string' } } },
  });
  await openViewer(t, ctx);
  await api.post('/api/components/plain/use', { id: 'm1', params: GOLDEN_PARAMS });
  const [req] = await waitUntil(async () => {
    const p = (await api.get('/api/services/pending')).json.pending;
    return p.length ? p : false;
  });
  assert.equal(req.root, ctx.root);
  assert.equal(req.hash, GOLDEN.hash, 'the hash reported is the sha256 of service.js, as before');
  assert.equal(req.key, legacyKey(GOLDEN_SRC, ctx.root, GOLDEN_PARAMS), 'the key is the one 0.8.0 would have recorded');
  assert.deepEqual(req.covers, {});
});

// ── a project to resolve paths in ───────────────────────────────────────────
// Deliberately not realpath'd: on macOS $TMPDIR is reached through a symlink,
// which is the state that tells a fence that resolves both sides apart from one
// that compares strings.
function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-xtrust-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-xtrust-out-'));
  t.after(() => { for (const d of [root, outside]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'a');
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'b');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  fs.mkdirSync(path.join(outside, 'deep'));
  fs.symlinkSync(outside, path.join(root, 'link-out'));                         // a directory link out
  fs.symlinkSync(path.join(outside, 'deep'), path.join(root, 'link-deep'));    // a link out, one level down
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'leaf-out')); // a file link out
  fs.symlinkSync(path.join(outside, 'nothing-yet'), path.join(root, 'dangling')); // points nowhere (yet)
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'link-in'));           // a link that stays inside
  return { root, outside };
}

const SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', 'x-trust': 'project-path' },
    title: { type: 'string', 'x-trust': 'display' },
    unfenced: { type: 'boolean' },
  },
};
const mint = (root, params, schema = SCHEMA) => mintIdentity({ root, sourceHash: GOLDEN.hash, schema, params });

test('a display value never moves the key — the child still gets it', (t) => {
  const { root } = project(t);
  const a = mint(root, { title: 'Notes' });
  const b = mint(root, { title: 'Renamed' });
  assert.equal(a.key, b.key, 'renaming the pane does not ask again');
  assert.equal(a.key, mint(root, {}).key, 'a display param is not part of the identity at all');
  assert.notEqual(a.spawnFp, b.spawnFp, 'but the child is handed the new value (the supervisor restarts it)');
  assert.deepEqual(b.params, { title: 'Renamed' });
  assert.deepEqual(a.covers, { path: 'project-path', title: 'display' }, 'an absent path is covered too');
  assert.deepEqual(a.exact, {});
  assert.deepEqual(a.declared, { path: 'project-path', title: 'display' });
});

test('a path inside the project never moves the key', (t) => {
  const { root } = project(t);
  const base = mint(root, {}).key;
  for (const value of [
    'src/a.js', 'src/b.js', './src/a.js', 'src', '', '.',
    'notes/not-created-yet.md',              // nearest existing ancestor is the root
    'link-in/a.js',                          // through a link that stays inside
    path.join(root, 'src', 'a.js'),          // absolute, inside
    'src/..b/c.js', 'src/b..js',             // dots that are not a `..` segment
    `${'a/'.repeat(511)}bb`,                 // exactly the longest value the proof takes (1024)
  ]) {
    assert.equal(mint(root, { path: value }).key, base, `${JSON.stringify(value)} is inside the project`);
  }
});

test('a `..` is never proven inside: the kernel follows a link before it applies one', (t) => {
  const { root, outside } = project(t);
  // `link-deep -> <outside>/deep`. As text, `link-deep/../secret.txt` is
  // `<root>/secret.txt`, which is inside; opened, it is `<outside>/secret.txt`.
  const value = 'link-deep/../secret.txt';
  assert.equal(path.resolve(root, value), path.join(root, 'secret.txt'), 'the lexical reading stays inside');
  // Joined by hand: path.join would collapse the `..` as text, which is the
  // very reading the kernel does not share.
  const opened = `${root}/${value}`;
  assert.equal(fs.readFileSync(opened, 'utf8'), 's', 'the kernel reads the file outside');
  assert.equal(fs.realpathSync.native(opened), fs.realpathSync.native(path.join(outside, 'secret.txt')));
  assert.equal(fs.existsSync(path.join(root, 'secret.txt')), false, 'there is no such file inside');
  const id = mint(root, { path: value });
  assert.notEqual(id.key, mint(root, {}).key, 'so it must not ride the in-project approval');
  assert.equal(id.paramsFp, paramsFingerprint({ path: value }), 'it counts by its exact value');
  assert.deepEqual(id.exact, { path: 'project-path' }, 'and the request says so');
});

test('the proof is bounded: an oversized value is exact, and costs no walk', (t) => {
  const { root } = project(t);
  const justOver = `${'a/'.repeat(511)}bbb`; // 1025 characters, every segment "inside"
  assert.equal(mint(root, { path: justOver }).paramsFp, paramsFingerprint({ path: justOver }),
    'a value longer than any path macOS opens counts by its exact value');
  // 1 MiB of segments used to hold the daemon's thread for ~37 s (the fence
  // walks up one segment at a time, re-resolving the rest at each step).
  const huge = 'a/'.repeat(512 * 1024);
  const started = process.hrtime.bigint();
  const id = mint(root, { path: huge, title: huge });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(id.paramsFp, paramsFingerprint({ path: huge }), 'exact, and the display param still left out');
  assert.ok(ms < 1000, `minting an identity for a 1 MiB value took ${ms.toFixed(0)} ms`);
});

test('each value that cannot be proven inside is its own exact key', (t) => {
  const { root, outside } = project(t);
  const inside = mint(root, { path: 'src/a.js' }).key;
  const exact = [
    path.join(outside, 'secret.txt'),        // absolute, outside
    '/etc/passwd',
    '../escape.txt',                         // a `..` that leaves the root
    'src/../../escape.txt',
    'src/../src/b.js',                       // any `..`, even one that stays inside as text
    'link-deep/../secret.txt',               // ... because a link is followed before the `..`
    'src\\..\\b.js',                         // either separator
    'link-out/secret.txt',                   // through a directory link that leads out
    'link-out',
    'leaf-out',                              // a file link that leads out
    'dangling',                              // a link to nowhere (a write would create the target)
    'dangling/below',
    42, true, null, ['src/a.js'], { path: 'src/a.js' }, // not a string
    '-rf', '--output=x.txt',                 // option-shaped
    '~/notes.txt', '~',                      // a home directory to a shell
    'file:///etc/passwd', 'http://example.test/x', // a URL to anything that takes one
    'FILE:///etc/passwd', 'Https://example.test/x', // in any case: schemes are case-insensitive
    'src/a\0.js', 'src/a\n.js',              // control characters
    'src/a\u007f.js', 'src/a\u009b.js',      // DEL, and a C1 control (a one-byte CSI)
  ];
  const keys = new Set();
  for (const value of exact) {
    const id = mint(root, { path: value });
    assert.notEqual(id.key, inside, `${JSON.stringify(value)} must not ride the in-project approval`);
    keys.add(id.key);
    // Exact means exact: its own value is its identity, as for an unmarked param.
    assert.equal(id.paramsFp, paramsFingerprint({ path: value }), `${JSON.stringify(value)} counts by its exact value`);
    // And what this request's approval covers says so: not "any path inside
    // this project" for a value that is not one (the declaration still says
    // project-path, and the code hash still folds it in).
    assert.deepEqual(id.covers, { title: 'display' }, `${JSON.stringify(value)}: path is not covered`);
    assert.deepEqual(id.exact, { path: 'project-path' }, `${JSON.stringify(value)}: path is held to its value`);
    assert.deepEqual(id.declared, { path: 'project-path', title: 'display' });
  }
  assert.equal(keys.size, exact.length, 'and no two of them share a key');
  // `unfenced` carries no mark: the builtin's escape hatch is always exact.
  assert.notEqual(mint(root, { path: 'src/a.js', unfenced: true }).key, inside);
});

test('the declaration is part of the code hash', () => {
  const plain = mint(GOLDEN_ROOT, {}, {}).hash;
  const display = mint(GOLDEN_ROOT, {}, { properties: { title: { 'x-trust': 'display' } } }).hash;
  const projectPath = mint(GOLDEN_ROOT, {}, { properties: { title: { 'x-trust': 'project-path' } } }).hash;
  const two = mint(GOLDEN_ROOT, {}, { properties: { title: { 'x-trust': 'display' }, path: { 'x-trust': 'project-path' } } }).hash;
  const twoReordered = mint(GOLDEN_ROOT, {}, { properties: { path: { 'x-trust': 'project-path', type: 'string' }, title: { 'x-trust': 'display' } } }).hash;
  assert.equal(plain, GOLDEN.hash);
  assert.equal(new Set([plain, display, projectPath, two]).size, 4, 'adding, changing or extending a mark is a new code identity');
  assert.equal(two, twoReordered, 'property order and unrelated schema keys are not');
  // The documented composition: sha256 of `<sha256 of service.js>\0<sorted JSON>`.
  assert.equal(two, sha256(`${GOLDEN.hash}\0${JSON.stringify({ path: 'project-path', title: 'display' })}`));
});

test('an unknown x-trust value counts as absent — the param stays exact', (t) => {
  const { root } = project(t);
  for (const mark of ['Display', 'project_path', 'displayonly', true, 1, null, { kind: 'display' }]) {
    const schema = { properties: { path: { type: 'string', 'x-trust': mark } } };
    assert.notEqual(mint(root, { path: 'src/a.js' }, schema).key, mint(root, { path: 'src/b.js' }, schema).key,
      `x-trust ${JSON.stringify(mark)} does not cover the param`);
    assert.equal(mint(root, { path: 'src/a.js' }, schema).hash, GOLDEN.hash, 'and does not enter the hash');
    assert.deepEqual(readTrustMarks(schema).unknown, [{ param: 'path', value: mark }]);
  }
  // A mark that names a prototype member is not a mark.
  assert.deepEqual(readTrustMarks({ properties: { p: { 'x-trust': 'toString' } } }).marks, {});
});

test('the words: what an approval covers, and the warning for an unknown mark', () => {
  assert.equal(describeCovers({ path: 'project-path', root: 'project-path', title: 'display' }),
    'path, root: any path inside this project · title: display only');
  assert.equal(describeCovers({}), '');
  assert.equal(describeCovers(null), '');
  const [w] = trustMarkWarnings({ properties: { title: { 'x-trust': 'dispaly' } } });
  assert.match(w, /"title" has x-trust "dispaly"/);
  assert.match(w, /counts as absent/);
  assert.match(w, /display, project-path|project-path, display/);
  assert.deepEqual(trustMarkWarnings({ properties: { title: { 'x-trust': 'display' } } }), []);
  assert.equal(describeExact({ path: 'project-path' }), 'path (not a path inside this project: only the value shown)');
  assert.equal(describeExact({}), '');
  assert.equal(coversProjectPath({ title: 'display' }), false);
  assert.equal(coversProjectPath({ path: 'project-path' }), true);
  assert.match(pathReach('file-editor'), /^An approval lets any pane point file-editor at any file inside this project, \.env files included/);
});

test('save_component warns about an unknown mark, and saves anyway', async (t) => {
  const { api } = await withServer(t);
  const bad = await api.post('/api/components', {
    name: 'typo', source: '<p>t</p>', description: 't', service: GOLDEN_SRC,
    params_schema: { type: 'object', properties: { title: { type: 'string', 'x-trust': 'dispaly' } } },
  });
  assert.equal(bad.json.ok, true, 'failing closed costs a re-ask, not a refusal');
  assert.equal(bad.json.warnings.length, 1);
  assert.match(bad.json.warnings[0], /"title" has x-trust "dispaly"/);
  assert.ok((await api.get('/api/components/typo')).json.params_schema, 'it was saved');

  const good = await api.post('/api/components', {
    name: 'tidy', source: '<p>t</p>', description: 't', service: GOLDEN_SRC,
    params_schema: { type: 'object', properties: { title: { type: 'string', 'x-trust': 'display' } } },
  });
  assert.equal(good.json.ok, true);
  assert.equal(good.json.warnings, undefined, 'a known mark says nothing');
});

test('pack review warns about an unknown mark', () => {
  const dir = packFixture({
    components: [{
      name: 'deploy-board', service: GOLDEN_SRC,
      params_schema: { type: 'object', properties: { env: { type: 'string', 'x-trust': 'project_path' } } },
    }],
  });
  const v = validateManifest(JSON.parse(fs.readFileSync(path.join(dir, 'web-chat-pack.json'), 'utf8')), { stageDir: dir });
  assert.equal(v.ok, true, 'it is a warning, not an error');
  assert.ok(v.warnings.some((w) => /^component "deploy-board": params_schema: "env" has x-trust "project_path"/.test(w)),
    v.warnings.join('\n'));
});

// ── a name that is not a component name ─────────────────────────────────────
// A mount restored from a draft (or a graph node) is never checked by a route,
// and `.web-chat/draft.json` is a file a repository can commit. Its `component`
// is turned into the service.js the supervisor forks, so a relative name must
// resolve to nothing rather than to a directory outside the components dir.

test('a restored mount whose component is not a component name never asks to run', async (t) => {
  const ctx = await withServer(t, {
    seed: ({ root, webChatDir }) => {
      const evil = path.join(root, 'evil');
      fs.mkdirSync(evil);
      fs.writeFileSync(path.join(evil, 'component.html'), '<p>e</p>');
      fs.writeFileSync(path.join(evil, 'meta.json'), '{"name":"evil"}');
      fs.writeFileSync(path.join(evil, 'service.js'), GOLDEN_SRC);
      fs.writeFileSync(path.join(webChatDir, 'draft.json'), JSON.stringify({
        schema_version: 1, base_active: null, store: {},
        mounts: [{ id: 'restored', html: '<p>e</p>', component: '../../evil', params: {} }],
      }));
    },
  });
  assert.ok((await ctx.api.get('/api/mounts')).json.mounts.some((m) => m.id === 'restored'), 'the draft was restored');
  assert.equal(serviceInfo(resolvePaths(ctx.root), '../../evil'), null, 'the name resolves to nothing');
  assert.ok(serviceInfo(resolvePaths(ctx.root), 'file-editor'), 'while a component name still resolves');
  await openViewer(t, ctx);
  await sleep(500);
  assert.deepEqual((await ctx.api.get('/api/services/pending')).json.pending, [],
    'nothing outside the components directory asks to run');
  assert.equal(ctx.srv.services._children.size, 0, 'or runs');
});

// ── the builtin, end to end ─────────────────────────────────────────────────

test('file-editor declares path and root as project paths, and unfenced not at all', () => {
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'components', 'file-editor', 'meta.json'), 'utf8'));
  assert.deepEqual(readTrustMarks(meta.params_schema), { marks: { path: 'project-path', root: 'project-path' }, unknown: [] });
});

// Approve the way the CLI does: write the user-tier trust file under the key the
// daemon reported, then nudge.
async function approve(ctx, req) {
  const file = path.join(ctx.userWebChat, 'services', 'trusted.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  data[req.key] = { name: req.name, hash: req.hash, root: req.root, params: req.params, approved: true, approved_at: 1 };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  await ctx.api.post('/api/services/refresh-trust', {});
}

test('a file-editor pane re-mounted on a second file does not ask again; unfenced:true does', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  fs.writeFileSync(path.join(ctx.root, 'a.txt'), 'first\n');
  fs.writeFileSync(path.join(ctx.root, 'b.txt'), 'second\n');
  const viewer = await openViewer(t, ctx);
  const pending = async () => (await api.get('/api/services/pending')).json.pending;

  await api.post('/api/components/file-editor/use', { id: 'ed', params: { path: 'a.txt' } });
  const req = await waitUntil(async () => (await pending())[0] || false);
  assert.ok(req, 'the first mount asks');
  assert.deepEqual(req.covers, { path: 'project-path', root: 'project-path' }, 'and says what an approval covers');
  assert.deepEqual(req.exact, {});
  // The surface's notice carries it too, in the words the CLI prints: the card
  // is where the user reads the command, before running it.
  const frame = await waitUntil(() => viewer.frames.find((f) => f.type === 'service:trust' && f.key === req.key) || false);
  assert.ok(frame, 'the notice was sent');
  assert.deepEqual(frame.covers, req.covers);
  assert.equal(frame.covers_text, 'path, root: any path inside this project');
  assert.equal(frame.exact_text, '');
  assert.match(frame.reach_text, /any pane point it at any file inside this project, \.env files included/);
  assert.notEqual(req.hash, req.source_hash, 'the declaration is folded into the code hash');
  assert.equal(req.source_hash, sha256(fs.readFileSync(path.join(ctx.root, '.web-chat', 'components', 'file-editor', 'service.js'))));
  await approve(ctx, req);

  // The child runs IN the project: `a.txt` resolves against the root, where the
  // identity proved it was, wherever the daemon itself was started from.
  const opened = await waitUntil(async () => {
    const ed = (await api.get('/api/store')).json.editor;
    return ed && ed.path === 'a.txt' ? ed : false;
  });
  assert.ok(opened, 'the approved service opened the file');
  assert.equal(opened.exists, true);
  assert.equal(opened.content, 'first\n');

  // The same pane on another file: the same consent, so nothing is asked — but
  // the child is restarted, because it is handed the new path.
  await api.post('/api/components/file-editor/use', { id: 'ed', params: { path: 'b.txt' } });
  const reopened = await waitUntil(async () => {
    const ed = (await api.get('/api/store')).json.editor;
    return ed && ed.path === 'b.txt' ? ed : false;
  });
  assert.ok(reopened, 'the restarted child opened the second file');
  assert.equal(reopened.content, 'second\n');
  assert.equal(ctx.srv.services._children.get('ed').params.path, 'b.txt');
  assert.deepEqual(await pending(), [], 'and nothing was asked');

  // A second pane on a third value inside the project rides the same approval.
  await api.post('/api/components/file-editor/use', { id: 'ed2', params: { path: 'src/new.txt', root: '.' } });
  await sleep(500);
  assert.deepEqual(await pending(), [], 'a second pane inside the project is not asked about either');

  // unfenced:true is exact: a new request, and the running panes are untouched.
  await api.post('/api/components/file-editor/use', { id: 'ed3', params: { path: 'a.txt', unfenced: true } });
  const wide = await waitUntil(async () => {
    const p = await pending();
    return p.length ? p : false;
  });
  assert.equal(wide.length, 1);
  assert.equal(wide[0].params.unfenced, true);
  assert.notEqual(wide[0].key, req.key, 'the unfenced form never inherits the fenced approval');

  // So is a path outside the project.
  await api.post('/api/components/file-editor/use', { id: 'ed4', params: { path: '../outside.txt' } });
  const both = await waitUntil(async () => {
    const p = await pending();
    return p.length === 2 ? p : false;
  });
  assert.ok(both, 'a path outside the project asks too');
  assert.equal(new Set([...both.map((p) => p.key), req.key]).size, 3);
});

// ── what the user is shown ──────────────────────────────────────────────────
// `covers` is what an approval of ONE request spans beyond the values it shows.
// It used to be the component's whole declaration, so a request for
// `/etc/hosts` — which is in the key by its exact value — was listed as
// covering "any path inside this project". And the listing, the grant and the
// notice are the only places a user reads the range before (or as) it is
// granted: `trust <name>` writes at once.

// The real CLI, with no terminal. ASYNC spawn: the daemon it talks to is in
// THIS process.
function runCli(args, ctx) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'claude-web-chat.js'), ...args], {
      cwd: ctx.root,
      env: { ...process.env, HOME: ctx.home, USERPROFILE: ctx.home, CI: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('the listing, the notice and the grant say what each request covers, and hold to', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  const { api } = ctx;
  const viewer = await openViewer(t, ctx);
  const trustFile = path.join(ctx.userWebChat, 'services', 'trusted.json');
  const outsidePath = path.join(os.tmpdir(), 'wc-not-this-project', 'hosts');

  await api.post('/api/components/file-editor/use', { id: 'in', params: { path: 'notes.md' } });
  await api.post('/api/components/file-editor/use', { id: 'out', params: { path: outsidePath } });
  const two = await waitUntil(async () => {
    const p = (await api.get('/api/services/pending')).json.pending;
    return p.length === 2 ? p : false;
  });
  assert.ok(two, 'two requests are waiting');
  const inside = two.find((p) => p.params.path === 'notes.md');
  const outside = two.find((p) => p.params.path === outsidePath);
  assert.deepEqual(inside.covers, { path: 'project-path', root: 'project-path' });
  assert.deepEqual(inside.exact, {});
  assert.deepEqual(outside.covers, { root: 'project-path' }, 'a path outside the project is not covered');
  assert.deepEqual(outside.exact, { path: 'project-path' }, 'it is held to its value');

  const outFrame = await waitUntil(() => viewer.frames.find((f) => f.type === 'service:trust' && f.key === outside.key) || false);
  assert.equal(outFrame.covers_text, 'root: any path inside this project');
  assert.equal(outFrame.exact_text, 'path (not a path inside this project: only the value shown)');

  // `init --json`'s state names the file's sha256, not the code hash (which
  // folds the declaration in and is no file's digest).
  const state = await gatherState({ root: ctx.root, mode: 'test', deps: { collectRows: async () => [] } });
  const fileSha = sha256(fs.readFileSync(path.join(ctx.root, '.web-chat', 'components', 'file-editor', 'service.js')));
  assert.notEqual(inside.hash, fileSha);
  assert.deepEqual(state.pending_services.map((s) => s.sha256), [fileSha, fileSha]);

  // The plain listing: the file's sha256, this request's covers, and what is
  // held to one value — and the footer that says what `covers` means.
  const listing = await runCli(['trust'], ctx);
  assert.equal(listing.status, 0, listing.stderr);
  assert.ok(listing.stdout.includes(`service.js sha256: ${fileSha.slice(0, 16)}…`), listing.stdout);
  assert.ok(!listing.stdout.includes(inside.hash.slice(0, 16)), 'never the code hash under the file\'s name');
  const block = (fp) => {
    const lines = listing.stdout.split('\n');
    const at = lines.findIndex((l) => l.includes(`params fingerprint: ${fp}`));
    return lines.slice(Math.max(0, at - 5), at + 1).join('\n');
  };
  assert.match(block(inside.params_fp), /covers: +path, root: any path inside this project/);
  assert.doesNotMatch(block(inside.params_fp), /exact:/);
  assert.match(block(outside.params_fp), /covers: +root: any path inside this project\n/);
  assert.match(block(outside.params_fp), /exact: +path \(not a path inside this project: only the value shown\)/);
  assert.match(listing.stdout, /`covers` names what an approval spans beyond the values shown/);
  assert.match(listing.stdout, /a project-path param while its value stays inside this\nproject/);

  // --all prints the same lines before it asks (and, with no terminal, answers No).
  const all = await runCli(['trust', 'file-editor', '--all'], ctx);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /covers: +path, root: any path inside this project/);
  assert.match(all.stdout, /exact: +path \(not a path inside this project/);
  assert.match(all.stdout, /Nothing was changed/);
  assert.equal(fs.existsSync(trustFile), false);

  // The grant names what it covers, and what an approval of a path lets a pane do.
  const granted = await runCli(['trust', 'file-editor', '--params-fp', inside.params_fp], ctx);
  assert.equal(granted.status, 0, granted.stderr);
  assert.match(granted.stdout, /file-editor — path="notes\.md"; covers path, root: any path inside this project\n/);
  assert.match(granted.stdout, /An approval lets any pane point file-editor at any file inside this project, \.env files included, without asking again\./);
  const exactGrant = await runCli(['trust', 'file-editor', '--params-fp', outside.params_fp], ctx);
  assert.equal(exactGrant.status, 0, exactGrant.stderr);
  assert.match(exactGrant.stdout, /; covers root: any path inside this project; exact path \(not a path inside this project: only the value shown\)/);
  const recorded = JSON.parse(fs.readFileSync(trustFile, 'utf8'));
  assert.deepEqual(recorded[inside.key].covers, { path: 'project-path', root: 'project-path' });
  assert.equal(recorded[inside.key].exact, undefined);
  assert.deepEqual(recorded[outside.key].covers, { root: 'project-path' }, 'the record notes this request\'s range');
  assert.deepEqual(recorded[outside.key].exact, { path: 'project-path' });
});
