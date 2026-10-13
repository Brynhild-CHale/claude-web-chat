// One identity check for "is this daemon the one this record names, and this
// root's?" (U107b): lib/util/registry answersFor. daemonFor and daemonsFor accept
// a record under it, tolerant (a build before 0.8.5 names no instance, and the
// record is the evidence it lacks); the instance guard's rule (d) asks it strict
// (it ends its own process on a yes, so only an answer naming this root's
// instance counts). The stale-build bounce and stop act only on a daemon it
// accepted. Nothing here opens a port: the probe is injected, and the only pid
// treated as alive is this process's own.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const registry = require('../lib/util/registry');
const { answersFor } = registry;

const ID = 'aaaabbbbccccdddd';
const REC = { pid: process.pid, port: 45100 };

// A probe that answers `h` (or throws it, when it is an Error) and records
// every call.
function probeOf(h) {
  const calls = [];
  const probe = async (port, ms) => {
    calls.push([port, ms]);
    if (h instanceof Error) throw h;
    return h;
  };
  probe.calls = calls;
  return probe;
}

async function both(h, rec = REC) {
  return [
    await answersFor(rec, ID, { probe: probeOf(h) }),
    await answersFor(rec, ID, { strictInstance: true, probe: probeOf(h) }),
  ];
}

const good = (extra = {}) => ({ ok: true, role: 'instance', pid: process.pid, instance: ID, ...extra });

test('answersFor: a record with no integer pid or port, or a dead pid, is a no without a probe', async () => {
  for (const rec of [null, {}, { pid: process.pid }, { pid: process.pid, port: 0 }, { pid: '1', port: 45100 }, { pid: process.pid, port: 1.5 }]) {
    const probe = probeOf(good());
    assert.equal(await answersFor(rec, ID, { probe }), false, JSON.stringify(rec));
    assert.deepEqual(probe.calls, [], JSON.stringify(rec));
  }
  // A pid no process holds: the highest a pid can be on the platforms we run.
  const probe = probeOf(good({ pid: 4194303 }));
  assert.equal(await answersFor({ pid: 4194303, port: 45100 }, ID, { probe }), false);
  assert.deepEqual(probe.calls, []);
});

test('answersFor: the probe is asked of the record\'s port, with the timeout given', async () => {
  const probe = probeOf(good());
  assert.equal(await answersFor(REC, ID, { probe, timeoutMs: 123 }), true);
  assert.deepEqual(probe.calls, [[45100, 123]]);
});

test('answersFor: no answer, a throw, or ok:false is a no, tolerant and strict', async () => {
  for (const h of [null, undefined, new Error('ECONNREFUSED'), good({ ok: false })]) {
    assert.deepEqual(await both(h), [false, false], String(h && (h.message || JSON.stringify(h))));
  }
});

test('answersFor — pid: only an answer naming the record\'s pid, tolerant and strict', async () => {
  assert.deepEqual(await both(good()), [true, true]);
  assert.deepEqual(await both(good({ pid: process.pid + 1 })), [false, false], 'a port now held by another process');
  assert.deepEqual(await both(good({ pid: String(process.pid) })), [false, false]);
  assert.deepEqual(await both(good({ pid: undefined })), [false, false]);
});

test('answersFor — role: an instance, or no role named; never the hub or the portal', async () => {
  assert.deepEqual(await both(good({ role: undefined })), [true, true]);
  assert.deepEqual(await both(good({ role: null })), [true, true]);
  assert.deepEqual(await both(good({ role: 'hub' })), [false, false]);
  assert.deepEqual(await both(good({ role: 'portal' })), [false, false]);
});

test('answersFor — instance: this id passes both; another fails both; none passes only tolerant', async () => {
  assert.deepEqual(await both(good()), [true, true]);
  assert.deepEqual(await both(good({ instance: 'deadbeefdeadbeef' })), [false, false], "another project's daemon");
  assert.deepEqual(await both(good({ instance: undefined })), [true, false], 'a build before 0.8.5 names none');
  assert.deepEqual(await both(good({ instance: null })), [true, false]);
});

test('daemonFor takes the same seam: a record is accepted under answersFor, tolerant', async (t) => {
  const { withTempHome } = require('../test-support/helpers');
  withTempHome(t);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'wc-identity-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  registry.registerInstance({ root, port: 45101, pid: process.pid });
  const id = registry.instanceId(root);
  const seen = [];
  const answer = (h) => async (port) => { seen.push(port); return h; };

  assert.deepEqual(await registry.daemonFor(root, { probe: answer({ ok: true, role: 'instance', pid: process.pid }) }),
    { pid: process.pid, port: 45101, url: 'http://localhost:45101', source: 'registry' }, 'no instance named: tolerated');
  assert.equal(await registry.daemonFor(root, { probe: answer({ ok: true, role: 'instance', pid: process.pid, instance: 'deadbeefdeadbeef' }) }), null);
  assert.deepEqual(await registry.daemonFor(root, { probe: answer({ ok: true, role: 'instance', pid: process.pid, instance: id }) }),
    { pid: process.pid, port: 45101, url: 'http://localhost:45101', source: 'registry' });
  assert.deepEqual(seen, [45101, 45101, 45101], 'one probe per lookup, of the record\'s port');
});

// The predicate lives once. A second copy is how the guard's rule (d) and
// daemonFor came to be two hand-written checks with two tolerances.
test('no second copy of the identity predicate in lib/', () => {
  const LIB = path.join(__dirname, '..', 'lib');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(LIB);
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(LIB, f);
    // a health answer's pid compared with a record's, or its instance with an id
    for (const re of [/\.pid\s*!==?\s*rec\.pid/g, /\.instance\s*[!=]==?\s*id\b/g]) {
      for (const m of src.matchAll(re)) hits.push(`${rel}: ${m[0]}`);
    }
  }
  // answersFor itself (one pid check, and one instance check spelt for its
  // strict and tolerant arms), and the port scan's
  // own question in daemonsFor — a daemon in NO record naming this instance —
  // which has no record to compare against.
  assert.deepEqual(hits.sort(), [
    'util/registry.js: .instance !== id',
    'util/registry.js: .instance !== id',
    'util/registry.js: .instance === id',
    'util/registry.js: .pid !== rec.pid',
  ].sort(), hits.join('\n'));
  const guard = fs.readFileSync(path.join(LIB, 'server', 'instance-guard.js'), 'utf8');
  assert.match(guard, /registry\.answersFor\(rec, id, \{ strictInstance: true/);
});
