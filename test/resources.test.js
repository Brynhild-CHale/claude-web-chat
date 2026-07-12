const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resourceRegistry, freshRequire } = require('../lib/core/resources');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-res-'));
  if (t) t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// A single-file (JSON) resource registry over local + system tiers + builtins.
function jsonRegistry(localDir, systemDir) {
  return resourceRegistry({
    name: 'widgets',
    tiers: [{ tier: 'local', dir: localDir }, { tier: 'system', dir: systemDir }],
    builtins: [{ name: 'stock', v: 0 }],
    file: (n) => `${n}.json`,
    load: (p) => {
      if (!p.endsWith('.json')) return null;
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
    },
    write: (dir, n, payload) => fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify(payload)),
  });
}

test('resources.get: most-specific tier wins, then builtin, then null', (t) => {
  const local = tmp(t), system = tmp(t);
  fs.writeFileSync(path.join(system, 'a.json'), JSON.stringify({ name: 'a', v: 'system' }));
  fs.writeFileSync(path.join(local, 'a.json'), JSON.stringify({ name: 'a', v: 'local' }));
  fs.writeFileSync(path.join(system, 'b.json'), JSON.stringify({ name: 'b', v: 'system' }));
  const r = jsonRegistry(local, system);
  assert.equal(r.get('a').tier, 'local', 'local shadows system');
  assert.equal(r.get('a').record.v, 'local');
  assert.equal(r.get('b').tier, 'system', 'falls through to system');
  assert.equal(r.get('stock').tier, 'builtin', 'falls through to in-code builtin');
  assert.equal(r.get('nope'), null);
});

test('resources.get: skips a tier whose dir is undefined', (t) => {
  const local = tmp(t);
  fs.writeFileSync(path.join(local, 'x.json'), JSON.stringify({ name: 'x' }));
  const r = resourceRegistry({
    name: 'w', tiers: [{ tier: 'local', dir: local }, { tier: 'system', dir: undefined }],
    file: (n) => `${n}.json`, load: (p) => JSON.parse(fs.readFileSync(p, 'utf8')),
  });
  assert.equal(r.get('x').tier, 'local');
  assert.equal(r.get('missing'), null);
});

test('resources.list: unions builtins + tiers, tags tier, skips malformed (load→null)', (t) => {
  const local = tmp(t), system = tmp(t);
  fs.writeFileSync(path.join(local, 'a.json'), JSON.stringify({ name: 'a' }));
  fs.writeFileSync(path.join(system, 'b.json'), JSON.stringify({ name: 'b' }));
  fs.writeFileSync(path.join(local, 'junk.txt'), 'not json');       // load → null (skipped)
  fs.writeFileSync(path.join(local, 'broken.json'), '{bad');         // load → null (skipped)
  const r = jsonRegistry(local, system);
  const names = r.list().map((e) => `${e.name}:${e.tier}`).sort();
  assert.deepEqual(names, ['a:local', 'b:system', 'stock:builtin']);
});

test('resources.list: a missing tier dir is not fatal', (t) => {
  const local = tmp(t);
  const r = jsonRegistry(local, path.join(local, 'does-not-exist'));
  assert.deepEqual(r.list().map((e) => e.name), ['stock']); // only the builtin
});

test('resources.save: mkdir -p + write to the chosen tier; get sees it', (t) => {
  const root = tmp(t);
  const local = path.join(root, 'local'), system = path.join(root, 'system'); // neither exists yet
  const r = jsonRegistry(local, system);
  const res = r.save('new', { name: 'new', v: 1 }, { tier: 'system' });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(res.path), 'save mkdir-ed the tier dir and wrote the file');
  assert.equal(r.get('new').tier, 'system');
  assert.equal(r.get('new').record.v, 1);
  assert.throws(() => r.save('x', {}, { tier: 'nope' }), /unknown tier/);
});

test('resources.dir: returns the absolute tier dir (escape hatch), or undefined', (t) => {
  const local = tmp(t);
  const r = jsonRegistry(local, undefined);
  assert.equal(r.dir('local'), local);
  assert.equal(r.dir('system'), undefined);
  assert.equal(r.dir('nope'), undefined);
});

test('resources: dir-payload type (entry = a directory, load reads a sidecar)', (t) => {
  const local = tmp(t);
  fs.mkdirSync(path.join(local, 'comp-a'));
  fs.writeFileSync(path.join(local, 'comp-a', 'meta.json'), JSON.stringify({ name: 'comp-a', d: 'A' }));
  fs.writeFileSync(path.join(local, 'stray-file'), 'x'); // not a dir with meta → skipped
  const r = resourceRegistry({
    name: 'components', tiers: [{ tier: 'local', dir: local }],
    load: (entryDir, { name }) => {
      const mp = path.join(entryDir, 'meta.json');
      if (!fs.existsSync(mp)) return null;
      return { ...JSON.parse(fs.readFileSync(mp, 'utf8')), name };
    },
  });
  assert.deepEqual(r.list().map((e) => e.name), ['comp-a']);
  assert.equal(r.get('comp-a').record.d, 'A');
  assert.equal(r.get('stray-file'), null);
});

test('paths: the components user tier is wired (SYSTEM_COMPONENTS_DIR = ~/.web-chat/components)', (t) => {
  const { userPaths } = require('../lib/core/paths');
  const { resolvePaths } = require('../lib/server/paths');
  const u = userPaths();
  assert.ok(u.components.endsWith(path.join('.web-chat', 'components')), 'userPaths.components under ~/.web-chat');
  const p = resolvePaths(tmp(t));
  assert.equal(p.SYSTEM_COMPONENTS_DIR, u.components, 'server paths maps SYSTEM_COMPONENTS_DIR to it');
});

test('freshRequire: re-loads a module fresh after its file changes', (t) => {
  const dir = tmp(t);
  const mod = path.join(dir, 'm.js');
  fs.writeFileSync(mod, 'module.exports = { v: 1 };');
  assert.equal(freshRequire(mod).v, 1);
  fs.writeFileSync(mod, 'module.exports = { v: 2 };');
  assert.equal(freshRequire(mod).v, 2, 'require.cache was busted');
});
