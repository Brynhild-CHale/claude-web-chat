// The package's public entry points (contracts folder, 12 C-12.7 and C-12.26).
//
// package.json `exports` is exactly the rows of the locked
// examples/12-exports.json: a subpath outside the map is private, and Node
// refuses it with ERR_PACKAGE_PATH_NOT_EXPORTED. There is no root export and no
// `main` (Q-12.5). Within an exported module only the names its row lists are
// public; this ratchet holds that each listed name exists, so a rename on our
// side shows here before the hub's require breaks.
//
// EXPECTED is the example's entries copied from the contracts folder at the
// v1.4 lock (cad3e8e): subpath, target, names and pending_names, in its order.
// When the repo's own copy of the contracts folder lands
// (test-support/contracts/examples/12-exports.json, U734) the held map is also
// checked against it entry for entry, so the two can never drift. A change to
// either is a contracts amendment first, never an edit here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { withServer } = require('../test-support/helpers');
const { CATALOGUE_VERSION, CATALOGUE_SHA256 } = require('../lib/core/versions');

const REPO = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const CONTRACTS_COPY = path.join(REPO, 'test-support', 'contracts', 'examples', '12-exports.json');

const EXPECTED = [
  { subpath: './server', target: './lib/server/index.js', names: ['createServer'] },
  { subpath: './portal', target: './lib/portal/index.js', names: ['createPortal', 'csrfRefusal'] },
  { subpath: './client', target: './lib/client/index.js',
    names: ['NoServerError', 'HttpError', 'request', 'api', 'get', 'post', 'probeHealth', 'probeReachable', 'subscribeSSE'] },
  { subpath: './driver', target: './lib/driver.js', names: ['createDriver', 'guardDriver', 'NoServerError'] },
  { subpath: './core/remote-policy', target: './lib/core/remote-policy.js',
    names: ['RULES', 'classify', 'classifier', 'refusalBody', 'MIRROR_LEVELS', 'rankLevel', 'atLeast', 'FRAME_RULES',
      'projectFrame', 'TEXT_RULES', 'stripText', 'PRIVATE_RULES', 'dropPrivate', 'ANSWER_RULES', 'classifyAnswer',
      'ELEMENT_POLICY'],
    pending_names: ['AUDIT_RULES', 'projectAudit'] },
  { subpath: './core/redact', target: './lib/core/redact.js',
    names: ['createRedactor', 'redactText', 'redactValue', 'redactPatch', 'sensitivePath', 'sensitiveKey',
      'classifyContext', 'MASK', 'WITHHELD', 'NEVER_EMIT'] },
  { subpath: './core/paths', target: './lib/core/paths.js', names: ['redactHostPaths'] },
  { subpath: './core/text', target: './lib/core/text.js', names: ['stripControls'] },
  { subpath: './core/versions', target: './lib/core/versions.js',
    names: ['packageVersion', 'compareVersions', 'isPrerelease', 'isDevVersion', 'PROTOCOL_VERSION',
      'PORTAL_PROTOCOL_VERSION', 'SCHEMA_VERSION', 'NODE_FLOOR', 'INSTALL_SH_URL'],
    pending_names: ['CONNECTOR_PROTOCOL_VERSION', 'CONNECTOR_PROTOCOL_MIN'] },
  { subpath: './tunnel/config', target: './lib/tunnel/config.js', names: ['sessionHost', 'answerHost'] },
  { subpath: './util/registry', target: './lib/util/registry.js',
    names: ['instanceId', 'readInstances', 'sessions', 'enrichSessions', 'versionSkew', 'versionNote', 'daemonFor'] },
  { subpath: './bin/*', target: './bin/*.js', names: [] },
  { subpath: './package.json', target: './package.json', names: [] },
];

// Pending names that have not landed yet, and the unit that lands them. A name
// here may be absent (the test says it skipped it); one that exists while it
// is still listed fails, so the unit that adds it takes it off this list in
// the same change. Every other pending name must exist.
const PENDING_ABSENT = new Map([
  ['AUDIT_RULES', 'U724 (11 C-11.18)'],
  ['projectAudit', 'U724 (11 C-11.18)'],
]);

const isModule = (e) => e.target.endsWith('.js') && !e.subpath.includes('*');

test('package.json exports exactly the locked example map: no root entry, no main', () => {
  assert.ok(PKG.exports && typeof PKG.exports === 'object', 'package.json has an exports map');
  assert.deepStrictEqual(Object.entries(PKG.exports), EXPECTED.map((e) => [e.subpath, e.target]),
    'the exports map is the example\'s 13 rows, subpath → target, in its order');
  assert.equal(EXPECTED.length, 13);
  assert.ok(!('.' in PKG.exports), 'no root export: "." would duplicate ./server (Q-12.5)');
  assert.ok(!('main' in PKG), 'main is dropped with the map (C-12.7)');
  assert.ok(!Object.keys(PKG.exports).includes('./relay'), 'v1 exports no ./relay (C-12.7)');
});

test('the held map equals the repo\'s contracts copy, when that copy is present', (t) => {
  if (!fs.existsSync(CONTRACTS_COPY)) {
    t.diagnostic('test-support/contracts/examples/12-exports.json is not in this tree yet: only the held map is checked');
    return;
  }
  const copy = JSON.parse(fs.readFileSync(CONTRACTS_COPY, 'utf8'));
  assert.equal(copy.package, PKG.name);
  const rows = copy.entries.map((e) => {
    const row = { subpath: e.subpath, target: e.target, names: e.names };
    if (e.pending_names) row.pending_names = e.pending_names;
    return row;
  });
  assert.deepStrictEqual(rows, EXPECTED, 'the held map and the contracts copy agree entry for entry');
});

test('every target in the map is a file in the package', () => {
  for (const e of EXPECTED) {
    if (e.subpath === './bin/*') {
      for (const bin of Object.values(PKG.bin)) {
        assert.ok(fs.existsSync(path.join(REPO, bin)), `${bin} (under ./bin/*) exists`);
      }
      continue;
    }
    assert.ok(fs.existsSync(path.join(REPO, e.target)), `${e.subpath} → ${e.target} exists`);
  }
});

test('every name a module row lists exists on its module', () => {
  for (const e of EXPECTED.filter(isModule)) {
    const mod = require(path.join(REPO, e.target));
    for (const name of e.names) {
      assert.ok(name in mod && mod[name] !== undefined, `${e.subpath} exports ${name}`);
    }
  }
});

test('pending names: the landed ones exist, the rest are skipped while absent', (t) => {
  for (const e of EXPECTED.filter((x) => x.pending_names)) {
    const mod = require(path.join(REPO, e.target));
    for (const name of e.pending_names) {
      const present = name in mod && mod[name] !== undefined;
      if (PENDING_ABSENT.has(name)) {
        assert.ok(!present, `${e.subpath} now exports ${name}: take it off PENDING_ABSENT in this test`);
        t.diagnostic(`skipped: ${e.subpath} ${name} is pending, lands with ${PENDING_ABSENT.get(name)}`);
        continue;
      }
      assert.ok(present, `${e.subpath} exports its pending name ${name}`);
      t.diagnostic(`landed: ${e.subpath} ${name}`);
    }
  }
});

test('the connector protocol constants are 1 and 1 (C-12.20)', () => {
  const v = require('../lib/core/versions');
  assert.equal(v.CONNECTOR_PROTOCOL_VERSION, 1);
  assert.equal(v.CONNECTOR_PROTOCOL_MIN, 1);
  assert.ok(v.CONNECTOR_PROTOCOL_MIN <= v.CONNECTOR_PROTOCOL_VERSION);
});

// From outside the package, as the hub requires it: a temp dir whose
// node_modules/claude-web-chat is a symlink to this checkout.
test('from outside the package a deep require is refused and the listed subpaths resolve', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-exports-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.symlinkSync(REPO, path.join(dir, 'node_modules', 'claude-web-chat'), 'dir');
  const outside = createRequire(path.join(dir, 'consumer.js'));
  const real = (p) => fs.realpathSync(p);

  for (const deep of ['claude-web-chat/lib/core/cors', 'claude-web-chat/lib/driver', 'claude-web-chat/lib/core/versions.js']) {
    assert.throws(() => outside(deep), (err) => err && err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      `${deep} is private: ERR_PACKAGE_PATH_NOT_EXPORTED`);
  }
  assert.throws(() => outside('claude-web-chat'), (err) => err && err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    'there is no root export');

  for (const e of EXPECTED.filter((x) => !x.subpath.includes('*'))) {
    const spec = `claude-web-chat/${e.subpath.slice(2)}`;
    assert.equal(real(outside.resolve(spec)), real(path.join(REPO, e.target)), `${spec} resolves to ${e.target}`);
  }
  for (const bin of Object.values(PKG.bin)) {
    const spec = `claude-web-chat/bin/${path.basename(bin, '.js')}`;
    assert.equal(real(outside.resolve(spec)), real(path.join(REPO, bin)), `${spec} resolves to ${bin}`);
  }

  const driver = outside('claude-web-chat/driver');
  assert.equal(typeof driver.createDriver, 'function', 'claude-web-chat/driver loads (docs/driving-the-surface.md)');
  const versions = outside('claude-web-chat/core/versions');
  assert.equal(versions.CONNECTOR_PROTOCOL_VERSION, 1);
  assert.equal(outside('claude-web-chat/package.json').name, 'claude-web-chat');
});

test('the driving doc requires the driver by its exported subpath', () => {
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'driving-the-surface.md'), 'utf8');
  assert.match(doc, /require\('claude-web-chat\/driver'\)/);
  assert.doesNotMatch(doc, /require\('claude-web-chat\/lib\//, 'no deep require the map refuses');
});

// 12 C-12.6a: the hub knows a dev build's catalogue only from this report.
test('GET /api/health reports catalogue {version, sha256} from the constants, local and remote', async (t) => {
  const { api } = await withServer(t);
  const local = (await api.get('/api/health')).json;
  assert.deepStrictEqual(local.catalogue, { version: CATALOGUE_VERSION, sha256: CATALOGUE_SHA256 });
  assert.equal(local.catalogue.version, '1.0.0');
  assert.match(local.catalogue.sha256, /^[0-9a-f]{64}$/);
  assert.equal(local.mirror.level, 'local');

  const remote = (await api.get('/api/health', { 'x-wc-remote': '1' })).json;
  assert.notEqual(remote.mirror.level, 'local', 'the labelled request is judged below local');
  assert.deepStrictEqual(remote.catalogue, { version: CATALOGUE_VERSION, sha256: CATALOGUE_SHA256 },
    'a version and a hash carry no text: every level gets them');
});
