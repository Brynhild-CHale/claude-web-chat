// The record-gated element-type registry, the daemon half (annotation engine
// tranche 2, U324; PLAN.md 2C.3; DECISIONS.md B1; readiness R7 §3 row 6;
// F10 C-7 and C-5): lib/server/element-types.js (ctx.elementTypes) and GET
// /api/elements/types (lib/server/routes/element-types.js).
//
// Pinned here, each through ctx.elementTypes on a withServer daemon:
//   - F10 c7: a committed .web-chat/element-types/sticky/ with no record lists
//     0; a forged packs.json naming it (digests that agree with its files) and
//     no ledger entry lists 0; a pending install lists 0; a tampered
//     element.json (verifyPack drift) lists 0; quarantine → review lists 0;
//     approve lists 1 — with no restart and no invalidate() (the approve
//     route's `packs` event); removal lists 0;
//   - F10 c5's grid, the daemon half: a type installed five times (schema 1
//     reads [1] → schema 2 reads [1,2] → schema 2 reads [2] → schema 2 reads
//     omitted → schema 1 reads [1]) answers readable(type, schema) for the
//     versions written so far exactly as c5's designed grid: 30 readable, 15
//     not;
//   - GET /api/elements/types lists the three built-ins after a boot (U323)
//     with their toolbar fields as stored; a remote basic request is refused
//     by the floor row (the portal's table and the daemon's own gate); the
//     route is mounted before the element routes (U325);
//   - a descriptor that loosens the floor (remote.see basic) is not listed and
//     logs one line; the built-in rows equal element-policy's, and a built-in
//     element.json that differs lists element-policy's row and logs one line.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { withServer, withTempHome } = require('../test-support/helpers');
const { packFixture, tmpDir, fakeForge, repoWithArchive } = require('../test-support/packs');
const { projectPaths, userPaths } = require('../lib/core/paths');
const { BUILTIN_ELEMENT_TYPES, FLOOR } = require('../lib/core/element-policy');
const { BUILTIN_ELEMENT_PACK, BUILTIN_ELEMENT_TYPE_NAMES } = require('../lib/core/names');
const { classify } = require('../lib/core/remote-policy');
const { readStore, writeStore, putPending, clearPending } = require('../lib/packs/store');
const { readJson, writeJsonAtomic } = require('../lib/core/fsjson');
const packs = require('../lib/packs/install');
const { seedBuiltins } = require('../lib/server/builtins');
const { resolvePaths } = require('../lib/server/paths');
const { createElementTypes, ROW_KEYS } = require('../lib/server/element-types');
const client = require('../lib/client');

const SHA = 'a'.repeat(40);
const DRAW = "export default function draw(group, ctx) { group.container.textContent = 'sticky'; }\n";
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function elementJson(type, json = {}) {
  return { type, family: 'page', remote: { see: 'read', send: 'full' }, schema: `${type}@1`, reads: [`${type}@1`], anchors: ['element', 'range'], ...json };
}

function elementPack({ name = 'mark-pack', version = '1.0.0', type = 'sticky', json = {}, draw = DRAW } = {}) {
  return packFixture({
    name, version, components: [], skill: false,
    manifest: { name, version, description: 'Sticky notes on the surface.', elements: [type] },
    extraFiles: {
      [`elements/${type}/element.json`]: JSON.stringify(elementJson(type, json), null, 2) + '\n',
      [`elements/${type}/draw.js`]: draw,
    },
  });
}

const stickyDir = (root) => path.join(projectPaths(root).elementTypesDir, 'sticky');
const listedNames = (et) => et.list().map((r) => r.type);
const refusedFor = (et, name) => et.stats().refused.filter((r) => r.name === name).map((r) => r.why);

// The installed unit's files as a record would name them.
function unitFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out.push({ path: path.relative(dir, abs).split(path.sep).join('/'), sha256: sha256(fs.readFileSync(abs)) });
    }
  })(dir);
  return out;
}

// Rewrite a recorded unit's digests to match the files on disk — in the
// project's packs.json and in the machine's ledger — so a check further down
// the gate than verifyPack is reached.
function rerecord(root, packName, typeName) {
  const files = unitFiles(path.join(projectPaths(root).elementTypesDir, typeName));
  const fix = (units) => units.map((u) => (u.kind === 'element' && u.name === typeName ? { ...u, files } : u));
  const file = projectPaths(root).packs;
  const store = readStore(file);
  store.packs = store.packs.map((p) => (p.name === packName ? { ...p, units: fix(p.units) } : p));
  writeStore(file, store);
  const ledger = readJson(userPaths().packsLedger).value;
  ledger.installs = ledger.installs.map((e) => (e.name === packName ? { ...e, units: fix(e.units) } : e));
  writeJsonAtomic(userPaths().packsLedger, ledger, { newline: true });
}

// An element pack approved in process (B1's path, via 'approve').
function approveInProcess(root, opts) {
  return packs.installFromStage({ stageDir: elementPack(opts), source: { via: 'test' }, tier: 'local', root, via: 'approve' });
}

// ── F10 c7 ──────────────────────────────────────────────────────────────────
test('c7: a committed element-types/sticky/ with no record lists nothing', async (t) => {
  await withServer(t, async ({ srv, root }) => {
    const et = srv.elementTypes;
    assert.deepStrictEqual(listedNames(et), [...BUILTIN_ELEMENT_TYPE_NAMES].sort(), 'the built-ins, after the boot');
    fs.mkdirSync(stickyDir(root), { recursive: true });
    fs.writeFileSync(path.join(stickyDir(root), 'element.json'), JSON.stringify(elementJson('sticky')));
    fs.writeFileSync(path.join(stickyDir(root), 'draw.js'), DRAW);
    et.invalidate();
    assert.equal(et.listed('sticky'), false);
    assert.equal(et.descriptor('sticky'), null);
    assert.equal(et.readable('sticky', 'sticky@1'), false);
    assert.equal(et.gate('sticky'), null);
    assert.deepStrictEqual(refusedFor(et, 'sticky'), ['no-record']);
    assert.equal(listedNames(et).length, 4, 'lists 0 sticky');
  });
});

test('c7: a forged packs.json naming it, digests and all, with no ledger entry lists nothing', async (t) => {
  await withServer(t, async ({ srv, root }) => {
    const et = srv.elementTypes;
    fs.mkdirSync(stickyDir(root), { recursive: true });
    fs.writeFileSync(path.join(stickyDir(root), 'element.json'), JSON.stringify(elementJson('sticky')));
    fs.writeFileSync(path.join(stickyDir(root), 'draw.js'), DRAW);
    const file = projectPaths(root).packs;
    const store = readStore(file);
    store.packs.push({ name: 'mark-pack', version: '1.0.0', source: { url: 'https://github.com/acme/marks' }, units: [{ kind: 'element', name: 'sticky', files: unitFiles(stickyDir(root)) }] });
    writeStore(file, store);
    et.invalidate();
    assert.equal(et.listed('sticky'), false);
    assert.deepStrictEqual(refusedFor(et, 'sticky'), ['no-ledger']);
    // A ledgered pack's name on the forged record does not vouch for a unit
    // the ledger never recorded.
    const forged = readStore(file);
    forged.packs = forged.packs.map((p) => (p.name === BUILTIN_ELEMENT_PACK ? { ...p, units: [...p.units, { kind: 'element', name: 'sticky', files: unitFiles(stickyDir(root)) }] } : p))
      .filter((p) => p.name !== 'mark-pack');
    writeStore(file, forged);
    et.invalidate();
    assert.equal(et.listed('sticky'), false);
    assert.deepStrictEqual(refusedFor(et, 'sticky'), ['no-ledger']);
    assert.equal(listedNames(et).length, 4);
  });
});

test('c7: a pending install lists nothing; once its record is final it lists', async (t) => {
  await withServer(t, async ({ srv, root }) => {
    const et = srv.elementTypes;
    approveInProcess(root);
    et.invalidate();
    assert.equal(et.listed('sticky'), true);
    putPending(root, 'local', { name: 'mark-pack', version: '1.1.0', started_at: new Date().toISOString() });
    et.invalidate();
    assert.equal(et.listed('sticky'), false);
    assert.deepStrictEqual(refusedFor(et, 'sticky'), ['pending']);
    clearPending(root, 'local', 'mark-pack');
    et.invalidate();
    assert.equal(et.listed('sticky'), true);
  });
});

test('c7: a tampered element.json (verifyPack drift) lists nothing — in the record or in the ledger', async (t) => {
  await withServer(t, async ({ srv, root }) => {
    const et = srv.elementTypes;
    approveInProcess(root);
    et.invalidate();
    assert.equal(et.listed('sticky'), true);
    const f = path.join(stickyDir(root), 'element.json');
    fs.writeFileSync(f, JSON.stringify(elementJson('sticky', { reads: ['sticky@1', 'sticky@2'] })));
    et.invalidate();
    assert.equal(et.listed('sticky'), false);
    assert.deepStrictEqual(refusedFor(et, 'sticky'), ['drift']);
    // The repository's record re-written to the tampered bytes: the ledger's
    // digests, which this machine wrote, still refuse it.
    const file = projectPaths(root).packs;
    const store = readStore(file);
    store.packs = store.packs.map((p) => (p.name === 'mark-pack'
      ? { ...p, units: p.units.map((u) => ({ ...u, files: unitFiles(stickyDir(root)) })) } : p));
    writeStore(file, store);
    et.invalidate();
    assert.equal(et.listed('sticky'), false);
    assert.deepStrictEqual(refusedFor(et, 'sticky'), ['drift']);
  });
});

test('c7: quarantine → review lists nothing; approve lists it on the next read, no restart; removal lists nothing', async (t) => {
  await withServer(t, async ({ srv, api, root }) => {
    const et = srv.elementTypes;
    const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack(), { sha: SHA }) } });
    assert.equal(et.listed('sticky'), false);
    let r = await api.post('/api/packs/quarantine', { url: forge.url('acme', 'marks') });
    assert.equal(r.json.ok, true, r.text);
    assert.equal(et.listed('sticky'), false, 'quarantined');
    r = await api.get('/api/packs/quarantine/mark-pack/review');
    assert.equal(r.json.ok, true);
    assert.equal(et.listed('sticky'), false, 'reviewed');
    const computes = et.stats().computes;
    // The approve is a person's (U322a, K.4): the route refuses an element
    // pack, and the card's control (the 'pack-approve' row) installs it.
    r = await api.post('/api/packs/quarantine/mark-pack/approve', {});
    assert.equal(r.status, 409, r.text);
    assert.equal(et.listed('sticky'), false, 'refused by the route');
    await srv.controlStarted;
    const a = await srv.control.invoke('pack-approve', { name: 'mark-pack', tier: 'local' }, { remote: false });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(et.listed('sticky'), true, 'approved: listed on the next read, with no invalidate() and no restart');
    assert.equal(et.stats().computes, computes + 1, 'the packs event invalidated the listing once');
    const row = et.descriptor('sticky');
    assert.deepStrictEqual({ tier: row.tier, pack: row.pack, builtin: row.builtin, reads: row.reads }, { tier: 'local', pack: 'mark-pack', builtin: false, reads: ['sticky@1'] });
    assert.deepStrictEqual(et.gate('sticky'), { see: FLOOR.see, send: FLOOR.send });
    assert.equal(et.dirOf('sticky'), stickyDir(root));
    r = await api.get('/api/elements/types');
    assert.ok(r.json.types.some((x) => x.type === 'sticky'));
    r = await api.del('/api/packs/mark-pack');
    assert.equal(r.json.ok, true, r.text);
    assert.equal(et.listed('sticky'), false, 'removed');
    r = await api.get('/api/elements/types');
    assert.ok(!r.json.types.some((x) => x.type === 'sticky'));
  });
});

// ── F10 c5, the daemon half ─────────────────────────────────────────────────
// The type is installed five times; after each install every version written
// so far (5 under schema 1, then 5 more under schema 2) is asked of
// readable(type, schema) — from element.json alone.
const C5_PHASES = [
  { version: '1.0.0', json: { schema: 'sticky@1', reads: ['sticky@1'] }, write: 1 },
  { version: '2.0.0', json: { schema: 'sticky@2', reads: ['sticky@1', 'sticky@2'] }, write: 2 },
  { version: '2.1.0', json: { schema: 'sticky@2', reads: ['sticky@2'] } },
  { version: '2.2.0', json: { schema: 'sticky@2', reads: undefined } },
  { version: '1.1.0', json: { schema: 'sticky@1', reads: ['sticky@1'] } },
];
const C5_WANT = [
  { readable: 5, not: 0 },
  { readable: 10, not: 0 },
  { readable: 5, not: 5 },
  { readable: 5, not: 5 },
  { readable: 5, not: 5 },
];

test('c5: a type installed five times answers readable() for every version exactly as c5\'s grid (30 readable, 15 not)', async (t) => {
  await withServer(t, async ({ srv, root }) => {
    const et = srv.elementTypes;
    const log = [];
    const got = [];
    for (const phase of C5_PHASES) {
      approveInProcess(root, { name: 'notes-pack', version: phase.version, json: phase.json });
      // The approve route's event, as the daemon's bus carries it.
      srv.bus.emit({ event: { kind: 'packs', op: 'approve', pack: 'notes-pack', tier: 'local' } });
      if (phase.write) for (let i = 0; i < 5; i++) log.push({ v: log.length + 1, schema: phase.write });
      assert.equal(et.listed('sticky'), true, phase.version);
      assert.equal(et.descriptor('sticky').schema, phase.json.schema);
      let readable = 0;
      let not = 0;
      for (const ver of log) {
        const a = et.readable('sticky', `sticky@${ver.schema}`);
        assert.equal(et.readable('sticky', ver.schema), a, 'a bare version number answers the same');
        if (a) readable++; else not++;
      }
      got.push({ readable, not });
    }
    assert.deepStrictEqual(got, C5_WANT);
    assert.equal(got.reduce((s, p) => s + p.readable, 0), 30);
    assert.equal(got.reduce((s, p) => s + p.not, 0), 15);
    assert.deepStrictEqual(et.reads('sticky'), ['sticky@1']);
    // Never a schema of another type, nor a malformed one.
    for (const s of ['comment@1', 'sticky@0', 'sticky@1.5', 'sticky', '', null, 0, -1, 1.5]) {
      assert.equal(et.readable('sticky', s), false, JSON.stringify(s));
    }
    assert.equal(et.readable('nope', 'nope@1'), false);
  });
});

// ── the route ───────────────────────────────────────────────────────────────
const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});

test('GET /api/elements/types lists the three built-ins after a boot, with their toolbar fields as stored', async (t) => {
  await withServer(t, async ({ api }) => {
    const r = await api.get('/api/elements/types');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.deepStrictEqual(r.json.reserved, [...BUILTIN_ELEMENT_TYPE_NAMES]);
    assert.deepStrictEqual(r.json.types.map((x) => x.type), [...BUILTIN_ELEMENT_TYPE_NAMES].sort());
    const shipped = path.join(__dirname, '..', 'templates', 'elements', BUILTIN_ELEMENT_PACK, 'elements');
    for (const row of r.json.types) {
      const raw = JSON.parse(fs.readFileSync(path.join(shipped, row.type, 'element.json'), 'utf8'));
      const toolbar = {};
      for (const k of Object.keys(raw)) if (!ROW_KEYS.includes(k)) toolbar[k] = raw[k];
      assert.deepStrictEqual(row.toolbar, toolbar, `${row.type}: the toolbar fields as stored (wake, summary_key included)`);
      assert.deepStrictEqual(Object.keys(row).sort(), ['anchors', 'builtin', 'family', 'pack', 'private', 'reads', 'remote', 'schema', 'tier', 'toolbar', 'type']);
      assert.equal(row.builtin, true);
      assert.equal(row.pack, BUILTIN_ELEMENT_PACK);
      assert.equal(row.tier, 'local');
      assert.deepStrictEqual(row.reads, raw.reads);
      assert.deepStrictEqual(row.anchors, raw.anchors);
    }
    assert.equal(r.json.types.find((x) => x.type === 'comment').toolbar.summary_key, 'text');
    assert.equal(r.json.types.find((x) => x.type === 'box-grab').toolbar.wake, true);
    assert.doesNotMatch(r.text, /\/(Users|home|tmp|private|var)\//, 'no host path');
  });
});

test('the built-in rows equal element-policy\'s', async (t) => {
  await withServer(t, async ({ srv }) => {
    const et = srv.elementTypes;
    for (const row of BUILTIN_ELEMENT_TYPES) {
      const d = et.descriptor(row.type);
      assert.ok(d, row.type);
      assert.deepStrictEqual({ type: d.type, family: d.family, remote: { ...d.remote }, private: d.private },
        { type: row.type, family: row.family, remote: { ...row.remote }, private: row.private });
      assert.deepStrictEqual(et.gate(row.type), { ...row.remote });
    }
  });
});

test('a remote basic request is refused by the floor row; a remote read viewer gets the listing', async (t) => {
  // The portal's table: the existing GET /api/elements/* floor row, at read.
  const basicV = classify('GET', '/api/elements/types', { mirror: 'basic' });
  assert.equal(basicV.allow, false);
  assert.equal(basicV.key, 'GET /api/elements/*', 'the existing floor row, no row of its own');
  assert.equal(basicV.need, FLOOR.see);
  assert.equal(classify('GET', '/api/elements/types', { mirror: 'read' }).allow, true);
  const readRoot = tmpDir('wc-et-read-');
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(readRoot)]: 'read' } } });
  const basic = await withServer(t, { seed });
  const read = await withServer(t, { root: readRoot });
  // The daemon's own gate (requireMirror('read')), for a viewer below it.
  let r = await client.request(basic.port, 'GET', '/api/elements/types', undefined, { headers: REMOTE, timeout: 10000 });
  assert.equal(r.status, 403);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.mirror, 'basic');
  assert.equal(r.body.types, undefined);
  r = await client.request(read.port, 'GET', '/api/elements/types', undefined, { headers: REMOTE, timeout: 10000 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.types.map((x) => x.type), [...BUILTIN_ELEMENT_TYPE_NAMES].sort());
});

test('the types route is mounted before the element routes (U325)', async (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'index.js'), 'utf8');
  const mine = src.indexOf('mountElementTypeRoutes(app, ctx)');
  assert.ok(mine > 0, 'mounted');
  const others = [...src.matchAll(/mount(?!ElementType)Element\w*Routes\(app, ctx\)/g)].map((m) => m.index);
  for (const at of others) assert.ok(mine < at, 'before every other element route mount');
  // And the path answers as the types route, whatever is mounted after it.
  await withServer(t, async ({ api }) => {
    const r = await api.get('/api/elements/types');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.types));
  });
});

// ── the policy gates (direct, with the log seen) ───────────────────────────
function project(t) {
  withTempHome(t);
  const root = tmpDir('wc-et-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  seedBuiltins(resolvePaths(root));
  return root;
}

test('a descriptor that loosens the floor (remote.see basic) is not listed and logs one line', (t) => {
  const root = project(t);
  approveInProcess(root);
  const f = path.join(stickyDir(root), 'element.json');
  fs.writeFileSync(f, JSON.stringify(elementJson('sticky', { remote: { see: 'basic', send: 'full' } })));
  rerecord(root, 'mark-pack', 'sticky');
  const lines = [];
  const et = createElementTypes({ root, log: (l) => lines.push(l) });
  assert.equal(et.listed('sticky'), false);
  assert.deepStrictEqual(refusedFor(et, 'sticky'), ['descriptor']);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /element type "sticky" is not listed: .*loosens the floor/);
  // A recompute does not repeat it.
  et.invalidate();
  assert.equal(et.listed('sticky'), false);
  assert.equal(lines.length, 1);
  assert.deepStrictEqual(listedNames(et), [...BUILTIN_ELEMENT_TYPE_NAMES].sort());
});

test('a built-in element.json whose policy differs from element-policy\'s row lists the row and logs one line', (t) => {
  const root = project(t);
  const f = path.join(projectPaths(root).elementTypesDir, 'comment', 'element.json');
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...raw, private: false, remote: { see: 'full', send: 'full' } }, null, 2) + '\n');
  rerecord(root, BUILTIN_ELEMENT_PACK, 'comment');
  const lines = [];
  const et = createElementTypes({ root, log: (l) => lines.push(l) });
  const d = et.descriptor('comment');
  assert.ok(d, 'still listed');
  const row = BUILTIN_ELEMENT_TYPES.find((x) => x.type === 'comment');
  assert.equal(d.private, row.private);
  assert.deepStrictEqual({ ...d.remote }, { ...row.remote });
  assert.deepStrictEqual(et.gate('comment'), { ...row.remote });
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /built-in element type "comment": .*the row is listed/);
});

test('a built-in name lists only from the built-in pack; a system-tier pack lists with no ledger', (t) => {
  const root = project(t);
  // A user-tier install: its record lives in ~/.web-chat, out of a
  // repository's reach, so no ledger entry is asked of it.
  packs.installFromStage({ stageDir: elementPack({ name: 'wide-pack', type: 'note' }), source: { via: 'test' }, tier: 'system', root, via: 'approve' });
  const lines = [];
  let et = createElementTypes({ root, log: (l) => lines.push(l) });
  assert.equal(et.listed('note'), true);
  assert.equal(et.descriptor('note').tier, 'system');
  assert.equal(et.dirOf('note'), path.join(userPaths().elementTypesDir, 'note'));
  // A forged record that claims a built-in name for another pack.
  const dir = path.join(userPaths().elementTypesDir, 'highlight');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'element.json'), JSON.stringify(elementJson('highlight')));
  const file = userPaths().packs;
  const store = readStore(file);
  store.packs.push({ name: 'evil-pack', version: '1.0.0', units: [{ kind: 'element', name: 'highlight', files: unitFiles(dir) }] });
  writeStore(file, store);
  et = createElementTypes({ root, log: (l) => lines.push(l) });
  // The project's own built-in copy shadows it; the user-tier claim is
  // refused on its own terms.
  assert.equal(et.descriptor('highlight').pack, BUILTIN_ELEMENT_PACK);
  assert.ok(et.stats().refused.some((x) => x.name === 'highlight' && x.tier === 'system' && x.why === 'reserved'));
});

// The route's see filter (U302c, from U324's review): a listed type whose
// gate.see is above the viewer's level is left out of that viewer's listing.
test('a listed type with remote.see full is absent from a remote read viewer\'s types[], present locally', async (t) => {
  const root = tmpDir('wc-et-see-');
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(root)]: 'read' } } });
  const d = await withServer(t, { root, seed });
  approveInProcess(d.root, { json: { remote: { see: 'full', send: 'full' } } });
  d.srv.elementTypes.invalidate();
  assert.equal(d.srv.elementTypes.listed('sticky'), true, 'listed: see full does not loosen the floor');
  assert.equal(d.srv.elementTypes.gate('sticky').see, 'full');
  const local = await client.request(d.port, 'GET', '/api/elements/types', undefined, { timeout: 10000 });
  assert.equal(local.status, 200);
  assert.ok(local.body.types.some((x) => x.type === 'sticky'), 'a local viewer lists it');
  const remote = await client.request(d.port, 'GET', '/api/elements/types', undefined, { headers: REMOTE, timeout: 10000 });
  assert.equal(remote.status, 200, JSON.stringify(remote.body));
  assert.ok(!remote.body.types.some((x) => x.type === 'sticky'), 'a remote read viewer does not');
  assert.deepStrictEqual(remote.body.types.map((x) => x.type), [...BUILTIN_ELEMENT_TYPE_NAMES].sort(), 'the built-ins still listed');
});

// ── the schema row (annotation engine tranche 4, 4A.2; U513) ───────────────
// A listed plug-in type's element.json `payload` declaration registers its
// schema row in the element log (lib/core/element-log registerSchema); none
// leaves the type listed and drawing but not writable. A malformed one fails
// review since U514 (lib/packs/elements validateElement), so approve refuses
// it and it never lists.
test('a listed plug-in type with a payload declaration is registered and writable; one with none lists, is unwritable and logs one line; a malformed one is refused at approve', (t) => {
  const { schemaRow, isPluginType, createElementLog } = require('../lib/core/element-log');
  const { createRedactor } = require('../lib/core/redact');
  const root = project(t);
  approveInProcess(root, { name: 'decl-pack', type: 'tq-decl', json: { payload: { keys: ['anchor', 'shared', 'note'], max_bytes: 2048 } } });
  approveInProcess(root, { name: 'bare-pack', type: 'tq-bare' });
  assert.throws(() => approveInProcess(root, { name: 'bad-pack', type: 'tq-bad', json: { payload: { keys: ['shared', 'note'] } } }),
    (e) => Array.isArray(e.errors) && e.errors.some((x) => /"payload" keys names anchor and shared \(missing anchor\)/.test(x)),
    'a malformed declaration fails review (U514)');
  const lines = [];
  const et = createElementTypes({ root, log: (l) => lines.push(l) });
  assert.equal(et.listed('tq-bad'), false, 'refused at approve: never listed');
  for (const type of ['tq-decl', 'tq-bare']) {
    assert.equal(et.listed(type), true, `${type} lists`);
    assert.equal(et.readable(type, `${type}@1`), true, `${type} draws its schema`);
  }
  const row = schemaRow('tq-decl@1');
  assert.ok(row && row.plugin, 'the declared type\'s row is registered');
  assert.deepStrictEqual([...row.keys], ['anchor', 'shared', 'note', 'meta']);
  assert.equal(row.maxBytes, 2048);
  assert.equal(isPluginType('tq-decl'), true);
  assert.equal(schemaRow('tq-bare@1'), null);
  assert.equal(schemaRow('tq-bad@1'), null);
  assert.equal(isPluginType('tq-bare'), false);
  const un = et.stats().unwritable;
  assert.deepStrictEqual(un.map((x) => x.type), ['tq-bare']);
  assert.match(un[0].why, /declares no payload/);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /element type "tq-bare" is listed but not writable: element\.json declares no payload/);
  // A recompute registers again (idempotent) and logs nothing new.
  et.invalidate();
  assert.equal(et.listed('tq-decl'), true);
  assert.strictEqual(schemaRow('tq-decl@1'), row);
  assert.equal(lines.length, 1);
  assert.deepStrictEqual(et.stats().unwritable.map((x) => x.type), ['tq-bare']);
  // Built-ins register nothing and are never unwritable.
  for (const type of BUILTIN_ELEMENT_TYPE_NAMES) assert.ok(!un.some((x) => x.type === type), type);
  // The registered type writes through the element log: a p id.
  const log = createElementLog({ file: path.join(tmpDir('wc-et-log-'), 'log.jsonl'), redactor: createRedactor() });
  t.after(() => log.close());
  log.load();
  const id = log.mintId('tq-decl');
  assert.equal(id, 'p1');
  log.ensureElement({ id, kind: 'tq-decl', created_at: 1 });
  assert.equal(log.appendVersion({ id, schema: 'tq-decl@1', payload: { anchor: null, shared: false, note: 'n' }, at: 1 }).v, 1);
  assert.throws(() => log.mintId('tq-bare'), /registered plug-in type/, 'an undeclared type mints nothing');
});

test('the same schema name declared again with other keys in this process is refused: listed, unwritable, one line; the first row stays', (t) => {
  const { schemaRow } = require('../lib/core/element-log');
  const root = project(t);
  approveInProcess(root, { name: 'redecl-pack', type: 'tq-redecl', json: { payload: { keys: ['anchor', 'shared', 'a'] } } });
  const lines = [];
  const et = createElementTypes({ root, log: (l) => lines.push(l) });
  assert.equal(et.listed('tq-redecl'), true);
  const row = schemaRow('tq-redecl@1');
  assert.ok(row);
  // A second registry (another daemon in this process) lists an edited copy:
  // the same schema name with other keys.
  const f = path.join(projectPaths(root).elementTypesDir, 'tq-redecl', 'element.json');
  fs.writeFileSync(f, JSON.stringify(elementJson('tq-redecl', { payload: { keys: ['anchor', 'shared', 'a', 'b'] } })));
  rerecord(root, 'redecl-pack', 'tq-redecl');
  const et2 = createElementTypes({ root, log: (l) => lines.push(l) });
  assert.equal(et2.listed('tq-redecl'), true);
  assert.deepStrictEqual(et2.stats().unwritable.map((x) => x.type), ['tq-redecl']);
  assert.match(et2.stats().unwritable[0].why, /registered with other keys/);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.strictEqual(schemaRow('tq-redecl@1'), row, 'schemas are additive: the first row stays');
});

// U590 (engineering contract (f)): U514 refuses a malformed payload
// declaration at review, so no approve reaches the registry's own refusal. An
// installed type written by an older build can still carry one: seeded here
// directly (the element.json rewritten and re-recorded in packs.json and the
// ledger, bypassing approve), it lists, is unwritable, and logs one line.
test('an installed, ledgered type whose element.json payload is malformed (no approve) lists, is unwritable and logs one line', (t) => {
  const { schemaRow, isPluginType } = require('../lib/core/element-log');
  const root = project(t);
  approveInProcess(root, { name: 'old-pack', type: 'tq-malformed', json: { payload: { keys: ['anchor', 'shared', 'note'] } } });
  const f = path.join(projectPaths(root).elementTypesDir, 'tq-malformed', 'element.json');
  fs.writeFileSync(f, JSON.stringify(elementJson('tq-malformed', { payload: { keys: ['shared', 'note'] } }), null, 2) + '\n');
  rerecord(root, 'old-pack', 'tq-malformed');
  const lines = [];
  const et = createElementTypes({ root, log: (l) => lines.push(l) });
  assert.equal(et.listed('tq-malformed'), true, 'listed: the record and the ledger hold its bytes');
  assert.equal(et.readable('tq-malformed', 'tq-malformed@1'), true, 'it still draws');
  assert.deepStrictEqual(et.stats().unwritable.map((x) => x.type), ['tq-malformed']);
  assert.match(et.stats().unwritable[0].why, /missing anchor/);
  assert.equal(schemaRow('tq-malformed@1'), null, 'no schema row: never writable');
  assert.equal(isPluginType('tq-malformed'), false);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /element type "tq-malformed" is listed but not writable/);
  et.invalidate();
  assert.equal(et.listed('tq-malformed'), true);
  assert.equal(lines.length, 1, 'a recompute logs nothing new');
});
