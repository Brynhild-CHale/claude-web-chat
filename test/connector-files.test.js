// The connector's files (tranche 6, U714; contract 06 sections 3.1–3.3,
// 06-connector-state.json, 04 C-04.11): userPaths' connector accessors,
// writeJsonAtomic's mode, the one ceiling reading (lib/core/connected-ceiling),
// the record's shared module (lib/setup/connector.js: the hand-written shape
// check, the 0600 write, the read-modify-write under its lock, the hub origin,
// the unit texts, the service manager's argv behind an injected runner, and —
// U714b — the machine key's id and fingerprint over contract 03's test vector)
// and the registry's port-less singleton role.
//
// Every case runs under a throwaway HOME (withTempHome, over npm test's
// sandbox). No service manager, tmux, claude or hub is run: the argv builders
// return arrays, serviceRun is called only with a stub runner, and the default
// runner is asserted to refuse under the test runner without spawning.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { once } = require('events');

const { withTempHome } = require('../test-support/helpers');
const { userPaths, isHubId } = require('../lib/core/paths');
const fsjson = require('../lib/core/fsjson');
const registry = require('../lib/util/registry');
const connectedCeiling = require('../lib/core/connected-ceiling');
const conn = require('../lib/setup/connector');

const CONNECTOR_MODULE = path.join(__dirname, '..', 'lib', 'setup', 'connector.js');
const SCHEMA_ID = 'https://web-chat-contracts/schemas/06-connector-state.json';

const modeOf = (file) => fs.statSync(file).mode & 0o777;
const octal = (m) => `0${m.toString(8)}`;

function tmpDir(t, name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wc-conn-${name}-`)));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// A full paired record in the shape of the contracts folder's own example
// (examples/06-connector-state.json), its paths moved under the sandbox HOME.
function pairedRecord(home) {
  return {
    v: 1,
    hub: { id: 'hub-one', origin: 'https://hub.example.com', name: 'Example hub' },
    machine: { id: 'mch_01jbz3k9q4w8r2t6v0x5m7n8p1', name: 'studio' },
    credential: {
      state: 'paired',
      algorithm: 'ed25519',
      key_file: path.join(home, '.web-chat', 'connector', 'hub-one.key'),
      key_id: 'mky_y4881352x9v335ap1wtpd4q6ef',
      public_key: 'kTCi0MViCOcU8LqIYhIzSR1xC7jW0kmKgaBHqjV2eo4',
      fingerprint: 'SHA256:8RCAjKLqdjGVVg81ZpLmc+7/fOPgiDSG8BRyRVXXMGs',
      paired_at: 1793177460000,
      revoked_at: null,
    },
    workdir: path.join(home, 'web-chat-hub', 'hub-one'),
    ceiling: 'full',
    settings: { agents_at_once: 2, local_cap: null, accept_new_chats: true, let_home_start_agents: false, paused: false, rev: 4 },
    folders: [
      { id: 'f_3a9c1e07b54d2f68', path: path.join(home, 'Dev', 'one'), display: '~/Dev/one', label: 'one', access: 'read-write', offered_at: 1793177520000 },
      { id: 'f_c0d4e19a7b2f5836', path: path.join(home, 'Dev', 'two'), display: '~/Dev/two', access: 'read-write', offered_at: 1793177580000 },
    ],
    chats: [
      {
        chat_id: '01jbz9a1b2c3d4e5f6g7h8j9k0', rev: 3, scope_kind: 'folder', folder_id: 'f_3a9c1e07b54d2f68',
        root: path.join(home, 'Dev', 'one'), instance: '5b1e9c04', owned_root: false, desired: 'running',
        manual_attach_at: 1793177760000, assigned_at: 1793177700000,
      },
      {
        chat_id: '01jbzam3n5p7q9r1s3t5v7w9x1', rev: 1, scope_kind: 'repo',
        root: path.join(home, 'web-chat-hub', 'hub-one', 'repos', '01jbzam3n5p7q9r1s3t5v7w9x1'), instance: 'e07a3d92',
        owned_root: true, desired: 'stopped', manual_attach_at: null, assigned_at: 1793181300000,
      },
    ],
    service: {
      kind: 'launchd',
      label: 'com.claude-web-chat.connector',
      unit_path: path.join(home, 'Library', 'LaunchAgents', 'com.claude-web-chat.connector.plist'),
      path_env: '/opt/homebrew/bin:/usr/bin:/bin',
      installed_at: 1793177465000,
    },
    last_reported: { connector_version: '0.9.0-alpha.7', install_kind: 'managed', claude_code_version: null, at: 1793177470000 },
  };
}

const edit = (record, fn) => { const r = structuredClone(record); fn(r); return r; };

// The refusals, each a single change to a valid record.
function refusals(home) {
  const ok = pairedRecord(home);
  return {
    'a missing required key (workdir)': edit(ok, (r) => { delete r.workdir; }),
    'a missing nested required key (settings.paused)': edit(ok, (r) => { delete r.settings.paused; }),
    'an extra top-level key (secret)': edit(ok, (r) => { r.secret = 'x'; }),
    'an extra top-level key (relay_secret)': edit(ok, (r) => { r.relay_secret = 'x'; }),
    'an extra key in credential (private_key)': edit(ok, (r) => { r.credential.private_key = 'x'; }),
    'an extra key in a folder': edit(ok, (r) => { r.folders[0].extra = 1; }),
    'a bad hub id': edit(ok, (r) => { r.hub.id = 'Hub_One'; }),
    'an http origin that is not loopback': edit(ok, (r) => { r.hub.origin = 'http://hub.example.com'; }),
    'an origin with a path': edit(ok, (r) => { r.hub.origin = 'https://hub.example.com/x'; }),
    'a credential.state outside the enum': edit(ok, (r) => { r.credential.state = 'bound'; }),
    'a folder id not f_<16 hex>': edit(ok, (r) => { r.folders[1].id = 'f_c0d4e19a7b2f583'; }),
    'a chat_id outside the label grammar': edit(ok, (r) => { r.chats[0].chat_id = 'cht_01jbz9a1b2c3d4e5f6g7h8j9k0'; }),
    'a chat_id with a letter Crockford leaves out': edit(ok, (r) => { r.chats[0].chat_id = '01jbz9a1b2c3d4e5f6g7h8j9ki'; }),
    'v 2': edit(ok, (r) => { r.v = 2; }),
    'agents_at_once above 64': edit(ok, (r) => { r.settings.agents_at_once = 65; }),
    'a non-integer rev': edit(ok, (r) => { r.chats[0].rev = 1.5; }),
    'a folder path longer than 4096': edit(ok, (r) => { r.folders[0].path = `/${'a'.repeat(4096)}`; }),
    'a service kind outside the enum': edit(ok, (r) => { r.service.kind = 'cron'; }),
    'ceiling admin': edit(ok, (r) => { r.ceiling = 'admin'; }),
    "ceiling ''": edit(ok, (r) => { r.ceiling = ''; }),
    'ceiling null': edit(ok, (r) => { r.ceiling = null; }),
    'ceiling 3': edit(ok, (r) => { r.ceiling = 3; }),
    'an array': [],
    'a string': 'record',
  };
}

// U734's loader (test-support/contracts-loader.js): an ajv 2020-12 instance
// with every contract schema added by $id. Null until that unit lands.
function schemaValidator() {
  let loader;
  try {
    loader = require('../test-support/contracts-loader');
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /contracts-loader/.test(String(e.message))) return null;
    throw e;
  }
  const v = loader.createValidator();
  const ajv = v && typeof v.getSchema === 'function' ? v : v && v.ajv;
  const fn = ajv && ajv.getSchema(SCHEMA_ID);
  assert.ok(fn, `the contracts loader compiles ${SCHEMA_ID}`);
  return (data) => fn(data) === true;
}

// The one thing checkRecord admits beyond the schema (C-05.4's development
// flag): a loopback http origin. ajv sees it with the scheme mapped to https.
function forSchema(record) {
  if (record && record.hub && typeof record.hub.origin === 'string' && record.hub.origin.startsWith('http://')) {
    return edit(record, (r) => { r.hub.origin = `https://${r.hub.origin.slice('http://'.length)}`; });
  }
  return record;
}

// ── userPaths ───────────────────────────────────────────────────────────────

test('userPaths: the connector directory and its per-hub files, none for a bad id', (t) => {
  const home = withTempHome(t);
  const u = userPaths();
  const dir = path.join(home, '.web-chat', 'connector');
  assert.equal(u.connectorDir, dir);
  assert.equal(u.connectorLog, path.join(dir, 'connector.log'));
  assert.equal(u.connectorAuthorityLog, path.join(dir, 'authority.log'));
  assert.equal(u.connectorRecord('hub-one'), path.join(dir, 'hub-one.json'));
  assert.equal(u.connectorKey('hub-one'), path.join(dir, 'hub-one.key'));
  assert.equal(u.connectorSocket('hub-one'), path.join(dir, 'hub-one.sock'));
  assert.equal(u.connectorLedger('hub-one'), path.join(dir, 'hub-one.ledger.json'));
  assert.equal(u.connectorRecordLock('hub-one'), path.join(dir, 'hub-one.json.lock'));
  assert.equal(u.defaultWorkdir('hub-one'), path.join(home, 'web-chat-hub', 'hub-one'));

  const bad = ['../x', 'A', 'ab', '', 'hub one', 'a'.repeat(64), 42, null, undefined, {}, '-hub', 'hub.one', 'hub/one'];
  for (const id of bad) {
    for (const name of ['connectorRecord', 'connectorKey', 'connectorSocket', 'connectorLedger', 'connectorRecordLock', 'defaultWorkdir']) {
      assert.equal(u[name](id), null, `${name}(${JSON.stringify(id)}) names no file`);
    }
    assert.equal(isHubId(id), false);
  }
  assert.equal(u.connectorRecord('a'.repeat(63)), path.join(dir, `${'a'.repeat(63)}.json`), '63 characters is the longest id');
  assert.equal(u.connectorRecord('abc'), path.join(dir, 'abc.json'), '3 characters is the shortest');
});

// ── writeJsonAtomic's mode ──────────────────────────────────────────────────

test('writeJsonAtomic: mode 0o600 leaves the file 0600; without mode a file keeps the process default', (t) => {
  const dir = tmpDir(t, 'mode');
  const secret = path.join(dir, 'secret.json');
  fsjson.writeJsonAtomic(secret, { a: 1 }, { mode: 0o600 });
  assert.equal(modeOf(secret), 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(secret, 'utf8')), { a: 1 });

  // The process default, as a plain create makes it under this umask.
  const reference = path.join(dir, 'reference');
  fs.writeFileSync(reference, 'x');
  const plain = path.join(dir, 'plain.json');
  fsjson.writeJsonAtomic(plain, { b: 2 });
  assert.equal(modeOf(plain), modeOf(reference), `without mode: ${octal(modeOf(plain))}, as before`);

  // Over an existing looser file the mode is set again after the rename.
  fs.chmodSync(plain, 0o644);
  fsjson.writeJsonAtomic(plain, { b: 3 }, { mode: 0o600 });
  assert.equal(modeOf(plain), 0o600);
});

// ── the directory and the record's writes ────────────────────────────────────

test('ensureConnectorDir: creates the directory 0700 and tightens one that exists 0755', (t) => {
  withTempHome(t);
  const dir = userPaths().connectorDir;
  assert.equal(conn.ensureConnectorDir(), dir);
  assert.ok(fs.statSync(dir).isDirectory());
  assert.equal(modeOf(dir), 0o700);

  fs.chmodSync(dir, 0o755);
  conn.ensureConnectorDir();
  assert.equal(modeOf(dir), 0o700, 'a looser directory is tightened');
});

test('ensureConnectorDir: a symlink in the directory\'s place is refused, never followed', (t) => {
  withTempHome(t);
  const elsewhere = tmpDir(t, 'elsewhere');
  fs.chmodSync(elsewhere, 0o755);
  fs.mkdirSync(userPaths().root, { recursive: true });
  fs.symlinkSync(elsewhere, userPaths().connectorDir);
  assert.throws(() => conn.ensureConnectorDir(), /not a directory/);
  assert.equal(modeOf(elsewhere), 0o755, 'the link\'s target is not touched');
});

test('writeRecord: the record is 0600 in the 0700 directory, and a umask of 0 does not widen it', (t) => {
  const home = withTempHome(t);
  const record = pairedRecord(home);
  conn.writeRecord(record);
  const file = userPaths().connectorRecord('hub-one');
  assert.equal(modeOf(file), 0o600);
  assert.equal(modeOf(userPaths().connectorDir), 0o700);
  assert.deepEqual(conn.readRecord('hub-one'), { ok: true, value: record });

  fs.rmSync(userPaths().connectorDir, { recursive: true, force: true });
  const prev = process.umask(0);
  try {
    conn.writeRecord(record);
  } finally {
    process.umask(prev);
  }
  assert.equal(modeOf(file), 0o600, 'umask 0: still 0600');
  assert.equal(modeOf(userPaths().connectorDir), 0o700, 'umask 0: the directory is still 0700');
  assert.ok(!fs.existsSync(userPaths().connectorRecordLock('hub-one')), 'the lock is gone once the write is done');
});

test('writeRecord refuses a record the schema does not describe — a secret field above all — and writes nothing', (t) => {
  const home = withTempHome(t);
  for (const [why, bad] of Object.entries(refusals(home))) {
    assert.throws(() => conn.writeRecord(bad), (e) => e.code === 'EBADRECORD' || e.code === 'EHUBID' || e instanceof TypeError, why);
  }
  assert.ok(!fs.existsSync(userPaths().connectorRecord('hub-one')), 'no record was written');
  assert.ok(!fs.existsSync(userPaths().connectorDir) || fs.readdirSync(userPaths().connectorDir).length === 0);
});

// ── checkRecord ─────────────────────────────────────────────────────────────

test('checkRecord accepts a full paired record and newRecord\'s output, and refuses each change the schema refuses', (t) => {
  const home = withTempHome(t);
  const paired = pairedRecord(home);
  const fresh = conn.newRecord({ hubId: 'hub-one', origin: conn.hubOrigin('hub.example.com') });
  const loopback = conn.newRecord({ hubId: 'hub-two', origin: conn.hubOrigin('http://127.0.0.1:4100', { insecureLoopback: true }) });
  const noCeiling = edit(paired, (r) => { delete r.ceiling; });
  const minimal = edit(fresh, (r) => { delete r.machine; delete r.ceiling; delete r.settings.rev; });
  const accepted = { paired, fresh, loopback, 'no ceiling': noCeiling, minimal, 'ceiling read': edit(paired, (r) => { r.ceiling = 'read'; }) };
  for (const [why, record] of Object.entries(accepted)) {
    assert.equal(conn.recordProblem(record), null, `${why}: ${conn.recordProblem(record)}`);
    assert.equal(conn.checkRecord(record), true, why);
  }
  const refused = refusals(home);
  for (const [why, record] of Object.entries(refused)) {
    assert.equal(conn.checkRecord(record), false, why);
    const problem = conn.recordProblem(record);
    assert.equal(typeof problem, 'string', why);
    assert.doesNotMatch(problem, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'a problem names a pointer, never the value');
  }

  const ajv = schemaValidator();
  if (!ajv) {
    t.diagnostic('test-support/contracts-loader is not in this tree yet (U734): the hand-written shape check alone');
    return;
  }
  for (const [why, record] of Object.entries(accepted)) assert.equal(ajv(forSchema(record)), true, `ajv accepts ${why}`);
  for (const [why, record] of Object.entries(refused)) {
    if (why === 'an http origin that is not loopback') continue; // forSchema maps every http origin; checkRecord admits loopback only
    assert.equal(ajv(forSchema(record)), false, `ajv refuses ${why}`);
  }
});

test('newRecord: the conservative defaults, unpaired, the default workdir, ceiling full', (t) => {
  const home = withTempHome(t);
  const r = conn.newRecord({ hubId: 'hub-one', origin: 'https://hub.example.com' });
  assert.deepEqual(r, {
    v: 1,
    hub: { id: 'hub-one', origin: 'https://hub.example.com' },
    machine: null,
    credential: { state: 'unpaired' },
    workdir: path.join(home, 'web-chat-hub', 'hub-one'),
    settings: { agents_at_once: 0, accept_new_chats: false, let_home_start_agents: false, paused: false, rev: 0 },
    folders: [],
    chats: [],
    ceiling: 'full',
  });
  assert.equal(conn.newRecord({ hubId: 'hub-one', origin: 'https://h.example', workdir: '/w' }).workdir, '/w');
  assert.throws(() => conn.newRecord({ hubId: '../x', origin: 'https://h.example' }), (e) => e.code === 'EHUBID');
});

// ── the ceiling ─────────────────────────────────────────────────────────────

test('ceilingOf: one function, re-exported; the four cases of 04 C-04.11', (t) => {
  const home = withTempHome(t);
  assert.strictEqual(conn.ceilingOf, connectedCeiling.ceilingOf, 'lib/setup/connector re-exports the one reading');

  const paired = pairedRecord(home);
  const noCeiling = edit(paired, (r) => { delete r.ceiling; });
  assert.equal(conn.checkRecord(noCeiling), true);
  conn.writeRecord(noCeiling);
  assert.equal(conn.ceilingOf(conn.readRecord('hub-one')), 'full', 'no ceiling reads full');

  for (const c of ['read', 'full']) {
    conn.writeRecord(edit(paired, (r) => { r.ceiling = c; }));
    assert.equal(conn.ceilingOf(conn.readRecord('hub-one')), c, `${c} reads as itself`);
  }

  const file = userPaths().connectorRecord('hub-one');
  for (const c of ['admin', '', null, 3]) {
    const bad = edit(paired, (r) => { r.ceiling = c; });
    assert.equal(conn.checkRecord(bad), false, `${JSON.stringify(c)} fails checkRecord`);
    fsjson.writeJsonAtomic(file, bad);
    const read = conn.readRecord('hub-one');
    assert.ok(read.invalid, 'the record reader calls it invalid');
    assert.equal(conn.ceilingOf(read), 'basic', `${JSON.stringify(c)} through the record reader reads basic`);
    assert.equal(conn.ceilingOf(fsjson.readJson(file)), 'basic', `${JSON.stringify(c)} read raw reads basic`);
  }

  fs.rmSync(file);
  assert.equal(conn.ceilingOf(fsjson.readJson(file)), 'basic', 'an absent file');
  fs.writeFileSync(file, '{"ceiling": "full"');
  assert.equal(conn.ceilingOf(fsjson.readJson(file)), 'basic', 'an unparsable file');
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(conn.ceilingOf(fsjson.readJson(file)), 'basic', 'a directory in its place');
  fs.rmdirSync(file);
  fs.writeFileSync(file, '["full"]');
  assert.equal(conn.ceilingOf(fsjson.readJson(file)), 'basic', 'a parsable array');
  fs.writeFileSync(file, '"full"');
  assert.equal(conn.ceilingOf(fsjson.readJson(file)), 'basic', 'a parsable string');
  fs.writeFileSync(file, '{}');
  assert.equal(conn.ceilingOf(fsjson.readJson(file)), 'full', 'an object with no ceiling, read raw');
  assert.equal(conn.ceilingOf(null), 'basic');
  assert.equal(conn.ceilingOf({ invalid: true, value: { ceiling: 'full' } }), 'basic', 'invalid is never read through');
});

test('withDefaults: adds full to a record without a ceiling and never changes one the user set', (t) => {
  const home = withTempHome(t);
  const paired = pairedRecord(home);
  const without = edit(paired, (r) => { delete r.ceiling; });
  assert.equal(conn.withDefaults(without).ceiling, 'full');
  assert.ok(!('ceiling' in without), 'the input is not changed');
  assert.equal(conn.withDefaults(edit(paired, (r) => { r.ceiling = 'read'; })).ceiling, 'read');
  assert.equal(conn.withDefaults(edit(paired, (r) => { r.ceiling = 'admin'; })).ceiling, 'admin', 'a value the user set stays, even a bad one');
});

// ── reading and listing ─────────────────────────────────────────────────────

test('readRecord and listRecords: the four states, a hub id that is not the file\'s, and files that are not records', (t) => {
  const home = withTempHome(t);
  assert.deepEqual(conn.readRecord('hub-one'), { absent: true });
  assert.deepEqual(conn.listRecords(), [], 'no directory lists nothing');
  assert.throws(() => conn.readRecord('../x'), (e) => e.code === 'EHUBID');

  conn.writeRecord(pairedRecord(home));
  const dir = userPaths().connectorDir;
  fs.writeFileSync(path.join(dir, 'hub-one.ledger.json'), '{}');
  fs.writeFileSync(path.join(dir, 'Bad_Name.json'), '{}');
  fs.writeFileSync(path.join(dir, 'README.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'hub-two.json'), '{"v": 1');
  // A record copied to another hub's name: its hub.id is not the file's.
  fsjson.writeJsonAtomic(path.join(dir, 'hub-three.json'), pairedRecord(home));

  const listed = conn.listRecords();
  assert.deepEqual(listed.map((r) => r.hubId), ['hub-one', 'hub-three', 'hub-two']);
  assert.equal(listed[0].file, userPaths().connectorRecord('hub-one'));
  assert.equal(listed[0].read.ok, true);
  assert.equal(listed[1].read.invalid, true, 'hub.id must be the file\'s name');
  assert.equal(listed[2].read.corrupt, true);
});

// ── updateRecord ────────────────────────────────────────────────────────────

const folderId = (prefix, i) => `f_${prefix}${i.toString(16).padStart(15, '0')}`;

test('updateRecord: a read-modify-write — null for no record yet, nothing written for a null answer, a torn record never overwritten', (t) => {
  const home = withTempHome(t);
  let seen = 'unset';
  const created = conn.updateRecord('hub-one', (cur) => { seen = cur; return conn.newRecord({ hubId: 'hub-one', origin: 'https://hub.example.com' }); });
  assert.equal(seen, null, 'no record yet: fn is handed null');
  assert.equal(created.credential.state, 'unpaired');
  assert.equal(modeOf(userPaths().connectorRecord('hub-one')), 0o600);

  const before = fs.readFileSync(userPaths().connectorRecord('hub-one'), 'utf8');
  assert.deepEqual(conn.updateRecord('hub-one', () => null), created, 'a null answer returns the record as it stands');
  assert.equal(fs.readFileSync(userPaths().connectorRecord('hub-one'), 'utf8'), before, 'and writes nothing');

  assert.throws(() => conn.updateRecord('hub-one', (r) => { r.hub.id = 'hub-two'; return r; }), (e) => e.code === 'EBADRECORD');
  assert.throws(() => conn.updateRecord('hub-one', (r) => { r.secret = 'x'; return r; }), (e) => e.code === 'EBADRECORD');
  assert.throws(() => conn.updateRecord('hub-one', async (r) => r), TypeError);
  assert.equal(fs.readFileSync(userPaths().connectorRecord('hub-one'), 'utf8'), before, 'a refused change writes nothing');

  fs.writeFileSync(userPaths().connectorRecord('hub-one'), '{"v": 1');
  assert.throws(() => conn.updateRecord('hub-one', () => pairedRecord(home)), (e) => e.code === 'ERECORD' && e.state === 'corrupt');
  assert.equal(fs.readFileSync(userPaths().connectorRecord('hub-one'), 'utf8'), '{"v": 1', 'the torn record is left for the caller to say so');
  assert.ok(!fs.existsSync(userPaths().connectorRecordLock('hub-one')), 'the lock is released after a throw');
});

// The child: waits for the agreed instant, then adds its folders one update at
// a time, holding each update for a moment inside the lock so the parent's
// updates must interleave with its own.
const WRITER = `
const conn = require(${JSON.stringify(CONNECTOR_MODULE)});
const [startAt, prefix, count] = [Number(process.argv[2]), process.argv[3], Number(process.argv[4])];
const sleeper = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(sleeper, 0, 0, Math.max(0, startAt - Date.now()));
for (let i = 0; i < count; i++) {
  conn.updateRecord('hub-one', (r) => {
    r.folders.push({ id: 'f_' + prefix + i.toString(16).padStart(15, '0'), path: '/p/' + prefix + i, display: '/p/' + prefix + i, access: 'read-write', offered_at: Date.now() });
    Atomics.wait(sleeper, 0, 0, 2);
    return r;
  });
}
`;

test('updateRecord: a forked child and the parent each add 20 folders at once; all 40 are there afterwards', async (t) => {
  const home = withTempHome(t);
  conn.writeRecord(conn.newRecord({ hubId: 'hub-one', origin: 'https://hub.example.com' }));
  const scratch = tmpDir(t, 'writer');
  const script = path.join(scratch, 'writer.js');
  fs.writeFileSync(script, WRITER);

  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.NODE_TEST_CONTEXT;
  const startAt = Date.now() + 800;
  const child = childProcess.spawn(process.execPath, [script, String(startAt), 'c', '20'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errs = '';
  child.stderr.on('data', (d) => { errs += d; });
  const exited = once(child, 'exit');

  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleeper, 0, 0, Math.max(0, startAt - Date.now()));
  for (let i = 0; i < 20; i++) {
    conn.updateRecord('hub-one', (r) => {
      r.folders.push({ id: folderId('a', i), path: `/p/a${i}`, display: `/p/a${i}`, access: 'read-write', offered_at: Date.now() });
      Atomics.wait(sleeper, 0, 0, 2);
      return r;
    });
  }
  const [code] = await exited;
  assert.equal(code, 0, `the child writer exited cleanly: ${errs}`);
  assert.doesNotMatch(errs, /web-chat registry/, 'no writer broke the lock or wrote without it');

  const read = conn.readRecord('hub-one');
  assert.ok(read.ok, 'the record is whole');
  const ids = new Set(read.value.folders.map((f) => f.id));
  assert.equal(read.value.folders.length, 40, 'no lost update');
  for (let i = 0; i < 20; i++) {
    assert.ok(ids.has(folderId('a', i)), `the parent's ${i}`);
    assert.ok(ids.has(folderId('c', i)), `the child's ${i}`);
  }
});

test('updateRecord: a stale lock older than the registry\'s stale bound is broken as instances.json\'s is', (t) => {
  withTempHome(t);
  conn.writeRecord(conn.newRecord({ hubId: 'hub-one', origin: 'https://hub.example.com' }));
  const lock = userPaths().connectorRecordLock('hub-one');
  fs.writeFileSync(lock, `${process.pid}\n`);
  const then = (Date.now() - registry.LOCK_STALE_MS - 5000) / 1000;
  fs.utimesSync(lock, then, then);

  const lines = [];
  t.mock.method(process.stderr, 'write', (chunk) => { lines.push(String(chunk)); return true; });
  const started = Date.now();
  conn.updateRecord('hub-one', (r) => { r.settings.paused = true; return r; });
  t.mock.restoreAll();
  assert.ok(Date.now() - started < registry.LOCK_WAIT_MS / 2, 'no wait for a stale lock');
  assert.match(lines.join(''), /broke a stale hub-one\.json\.lock/);
  assert.equal(conn.readRecord('hub-one').value.settings.paused, true);
  assert.ok(!fs.existsSync(lock));
});

test('withLockFile: reentrant per file, and the registry\'s own lock is the same engine', (t) => {
  withTempHome(t);
  const dir = tmpDir(t, 'lock');
  const a = path.join(dir, 'a.lock');
  const b = path.join(dir, 'b.lock');
  const out = registry.withLockFile(a, () => {
    assert.ok(fs.existsSync(a));
    return registry.withLockFile(a, () => registry.withLockFile(b, () => {
      assert.ok(fs.existsSync(b));
      return 'inner';
    }));
  });
  assert.equal(out, 'inner');
  assert.ok(!fs.existsSync(a) && !fs.existsSync(b), 'both released');
  assert.throws(() => registry.withLockFile('', () => {}), TypeError);
});

// ── hubOrigin ───────────────────────────────────────────────────────────────

test('hubOrigin: normalises to the schema\'s https origin; plain http only for a loopback host, and only when asked', () => {
  assert.equal(conn.hubOrigin('hub.example.com'), 'https://hub.example.com');
  assert.equal(conn.hubOrigin('https://hub.example.com/'), 'https://hub.example.com');
  assert.equal(conn.hubOrigin('HTTPS://Hub.Example.com:8443/x'), 'https://hub.example.com:8443');
  assert.equal(conn.hubOrigin('  https://hub.example.com:443/path?q#h '), 'https://hub.example.com', 'the default port goes');
  assert.equal(conn.hubOrigin('hub.example.com:8443'), 'https://hub.example.com:8443');

  const refused = (input, opts) => assert.throws(() => conn.hubOrigin(input, opts), (e) => e.code === 'EHUBORIGIN', JSON.stringify(input));
  refused('http://hub.example.com');
  refused('http://hub.example.com', { insecureLoopback: true });
  refused('http://127.0.0.1:4100');
  assert.equal(conn.hubOrigin('http://127.0.0.1:4100', { insecureLoopback: true }), 'http://127.0.0.1:4100');
  assert.equal(conn.hubOrigin('http://localhost:4100', { insecureLoopback: true }), 'http://localhost:4100');
  refused('ftp://hub.example.com');
  refused('https://user:pass@hub.example.com');
  refused('https://[::1]:4100');
  refused('');
  refused('   ');
  refused(null);
  refused('hub.exa\nmple.com');
  refused('hub\u202eexample.com');

  for (const o of ['https://hub.example.com', 'https://hub.example.com:8443']) {
    assert.equal(conn.checkRecord({ ...conn.newRecord({ hubId: 'hub-one', origin: o }) }), true, o);
  }
});

// ── the machine key's id and fingerprint (U714b; 03 section 2) ────────────

const CONTRACT_EXAMPLES = path.join(__dirname, '..', 'test-support', 'contracts', 'examples');
const readExample = (name) => JSON.parse(fs.readFileSync(path.join(CONTRACT_EXAMPLES, name), 'utf8'));

test('keyIdOf and fingerprintOf: contract 03\'s test vector, byte for byte', () => {
  const machine = readExample('03-credential-machine.json');
  assert.equal(machine.public_key.alg, 'ed25519');
  const raw = Buffer.from(machine.public_key.value, 'base64url');
  assert.equal(raw.length, 32, 'the wire form is the raw 32-byte key');
  // 03 section 2's own lines, beside the example that carries them.
  assert.equal(machine.key_id, 'mky_v6men077h4s9p7hvxfv5etvn01');
  assert.equal(machine.fingerprint, 'SHA256:2ajqgOeJMpseO+v2V2t1AFIewl46CYiSZ6HzUasBleQ');
  assert.strictEqual(conn.keyIdOf(raw), machine.key_id);
  assert.strictEqual(conn.fingerprintOf(raw), machine.fingerprint);

  // The 06 record example carries a key of its own: the same derivation.
  const state = readExample('06-connector-state.json');
  const stateRaw = Buffer.from(state.credential.public_key, 'base64url');
  assert.strictEqual(conn.keyIdOf(stateRaw), state.credential.key_id);
  assert.strictEqual(conn.fingerprintOf(stateRaw), state.credential.fingerprint);
});

test('keyIdOf and fingerprintOf: a Buffer and a Uint8Array agree; a fresh key fits the record\'s grammar', () => {
  const raw = Buffer.from(readExample('03-credential-machine.json').public_key.value, 'base64url');
  const plain = new Uint8Array(raw);
  assert.ok(!Buffer.isBuffer(plain));
  assert.strictEqual(conn.keyIdOf(plain), conn.keyIdOf(raw));
  assert.strictEqual(conn.fingerprintOf(plain), conn.fingerprintOf(raw));
  // A view into a larger buffer hashes only its own bytes.
  const padded = new Uint8Array(40);
  padded.set(raw, 4);
  assert.strictEqual(conn.keyIdOf(padded.subarray(4, 36)), conn.keyIdOf(raw));

  const { publicKey } = require('crypto').generateKeyPairSync('ed25519');
  const fresh = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  assert.match(conn.keyIdOf(fresh), /^mky_[0-9a-hjkmnp-tv-z]{26}$/);
  assert.match(conn.fingerprintOf(fresh), /^SHA256:[A-Za-z0-9+/]{43}$/);
});

test('keyIdOf and fingerprintOf: anything but raw key bytes throws', () => {
  const wire = readExample('03-credential-machine.json').public_key.value;
  for (const fn of [conn.keyIdOf, conn.fingerprintOf]) {
    for (const bad of [wire, { value: wire }, null, undefined, 42, [1, 2, 3], new ArrayBuffer(32)]) {
      assert.throws(() => fn(bad), TypeError, `${fn.name}(${Object.prototype.toString.call(bad)})`);
    }
    for (const n of [0, 31, 33, 44]) {
      assert.throws(() => fn(new Uint8Array(n)), RangeError, `${fn.name} over ${n} bytes`);
    }
  }
});

// ── the unit texts ──────────────────────────────────────────────────────────

test('plistText: C-06.6\'s keys through the ~/.local/bin link, the log on both streams, PATH as given, every value escaped', (t) => {
  const home = withTempHome(t);
  const binLink = path.join(home, '.local', 'bin', 'claude-web-chat');
  const logFile = userPaths().connectorLog;
  const text = conn.plistText({ binLink, pathEnv: '/opt/node/bin:/usr/bin:/bin', logFile });
  const has = (s) => assert.ok(text.includes(s), `the plist carries:\n${s}\n---\n${text}`);
  has('<key>Label</key>\n  <string>com.claude-web-chat.connector</string>');
  has(`<key>ProgramArguments</key>\n  <array>\n    <string>${binLink}</string>\n    <string>connect</string>\n    <string>run</string>\n  </array>`);
  has('<key>RunAtLoad</key>\n  <true/>');
  has('<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>');
  has('<key>ThrottleInterval</key>\n  <integer>10</integer>');
  has('<key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>/opt/node/bin:/usr/bin:/bin</string>\n  </dict>');
  has(`<key>StandardOutPath</key>\n  <string>${logFile}</string>`);
  has(`<key>StandardErrorPath</key>\n  <string>${logFile}</string>`);
  assert.ok(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'));

  // The defaults: the install tier's link and the connector log.
  assert.equal(conn.plistText({ pathEnv: '/usr/bin' }), conn.plistText({ binLink, pathEnv: '/usr/bin', logFile }));

  const odd = conn.plistText({ binLink: '/tmp/a&b<c>/claude-web-chat', pathEnv: '/x&y:/usr/bin', logFile: '/tmp/l"o\'g.log' });
  assert.ok(odd.includes('<string>/tmp/a&amp;b&lt;c&gt;/claude-web-chat</string>'));
  assert.ok(odd.includes('<string>/x&amp;y:/usr/bin</string>'));
  assert.ok(odd.includes('<string>/tmp/l&quot;o&#39;g.log</string>'));
  assert.doesNotMatch(odd, /&(?!amp;|lt;|gt;|quot;|#39;)/, 'no raw ampersand');

  assert.throws(() => conn.plistText({ binLink, pathEnv: '/usr/bin\n<key>x</key>', logFile }), TypeError);
  assert.throws(() => conn.plistText({ binLink: 'relative/bin', pathEnv: '/usr/bin', logFile }), TypeError);
});

test('systemdText: C-06.6\'s keys, ExecStart through %h/.local/bin, the log appended on both streams, PATH as given', (t) => {
  const home = withTempHome(t);
  const binLink = path.join(home, '.local', 'bin', 'claude-web-chat');
  const logFile = userPaths().connectorLog;
  const text = conn.systemdText({ binLink, pathEnv: '/opt/node/bin:/usr/bin:/bin', logFile });
  const lines = text.split('\n');
  for (const line of [
    '[Service]',
    'ExecStart=%h/.local/bin/claude-web-chat connect run',
    'Restart=on-failure',
    'RestartSec=5',
    'Environment=PATH=/opt/node/bin:/usr/bin:/bin',
    `StandardOutput=append:${logFile}`,
    `StandardError=append:${logFile}`,
    '[Install]',
    'WantedBy=default.target',
  ]) assert.ok(lines.includes(line), `the unit carries ${line}\n---\n${text}`);
  assert.ok(lines.indexOf('WantedBy=default.target') > lines.indexOf('[Install]'));
  assert.ok(lines.indexOf('ExecStart=%h/.local/bin/claude-web-chat connect run') > lines.indexOf('[Service]'));
  assert.equal(conn.systemdText({ pathEnv: '/usr/bin' }), conn.systemdText({ binLink, pathEnv: '/usr/bin', logFile }), 'the defaults');

  // A specifier character is doubled; a space in PATH is quoted.
  const odd = conn.systemdText({ binLink, pathEnv: '/a%b:/my dir', logFile: '/tmp/50%.log' }).split('\n');
  assert.ok(odd.includes('Environment="PATH=/a%%b:/my dir"'));
  assert.ok(odd.includes('StandardOutput=append:/tmp/50%%.log'));
  assert.throws(() => conn.systemdText({ binLink, pathEnv: '/usr/bin\nExecStartPre=/bin/sh', logFile }), TypeError);
});

test('the unit\'s paths, kind and record fields', (t) => {
  const home = withTempHome(t);
  assert.deepEqual(conn.unitPaths(), {
    launchd: path.join(home, 'Library', 'LaunchAgents', 'com.claude-web-chat.connector.plist'),
    'systemd-user': path.join(home, '.config', 'systemd', 'user', 'claude-web-chat-connector.service'),
  });
  assert.equal(conn.UNIT_LABEL, 'com.claude-web-chat.connector');
  assert.equal(conn.SYSTEMD_UNIT, 'claude-web-chat-connector.service');
  assert.deepEqual(conn.unitFor('launchd'), { kind: 'launchd', label: conn.UNIT_LABEL, unit_path: conn.unitPaths().launchd });
  assert.deepEqual(conn.unitFor('systemd-user'), { kind: 'systemd-user', label: conn.SYSTEMD_UNIT, unit_path: conn.unitPaths()['systemd-user'] });
  assert.equal(conn.platformKind('darwin'), 'launchd');
  assert.equal(conn.platformKind('linux', { exists: (p) => p === '/run/systemd/system' }), 'systemd-user');
  assert.equal(conn.platformKind('linux', { exists: () => false }), null, 'Linux without systemd: neither');
  assert.equal(conn.platformKind('win32'), null);
  assert.equal(conn.platformKind('freebsd'), null);
});

// ── the service manager ────────────────────────────────────────────────────

test('serviceArgv: exactly the launchd and systemd-user argv for uid 501', (t) => {
  withTempHome(t);
  const plist = conn.unitPaths().launchd;
  assert.deepEqual(conn.serviceArgv('launchd', { uid: 501 }), {
    load: ['launchctl', 'bootstrap', 'gui/501', plist],
    unload: ['launchctl', 'bootout', 'gui/501/com.claude-web-chat.connector'],
    restart: ['launchctl', 'kickstart', '-k', 'gui/501/com.claude-web-chat.connector'],
  });
  assert.deepEqual(conn.serviceArgv('systemd-user', { uid: 501 }), {
    reload: ['systemctl', '--user', 'daemon-reload'],
    load: ['systemctl', '--user', 'enable', '--now', 'claude-web-chat-connector'],
    restart: ['systemctl', '--user', 'restart', 'claude-web-chat-connector'],
    unload: ['systemctl', '--user', 'disable', '--now', 'claude-web-chat-connector'],
  });
  assert.throws(() => conn.serviceArgv('cron'), TypeError);
  assert.throws(() => conn.serviceArgv('launchd', { uid: -1 }), TypeError);
});

test('serviceRun: the injected runner gets that argv and nothing else; anything but a service manager is refused', (t) => {
  withTempHome(t);
  const argv = conn.serviceArgv('launchd', { uid: 501 }).restart;
  const calls = [];
  const out = conn.serviceRun(argv, { deps: { run: (...args) => { calls.push(args); return 'ran'; } } });
  assert.equal(out, 'ran');
  assert.deepEqual(calls, [[argv]]);
  for (const bad of [[], ['sh', '-c', 'x'], ['launchctl'], 'launchctl list', [/x/, 'y']]) {
    assert.throws(() => conn.serviceRun(bad, { deps: { run: () => assert.fail('never run') } }), TypeError);
  }
});

test('the default runner throws under the Node test runner without spawning', (t) => {
  withTempHome(t);
  assert.ok(process.env.NODE_TEST_CONTEXT, 'the test runner sets NODE_TEST_CONTEXT in this process');
  const spy = t.mock.method(childProcess, 'execFileSync', () => assert.fail('execFileSync was called'));
  const argv = conn.serviceArgv('launchd', { uid: 501 }).load;
  assert.throws(() => conn.serviceRun(argv), /never run under the test runner/);
  assert.throws(() => conn.serviceRun(argv, { deps: {} }), /never run under the test runner/);
  assert.throws(() => conn.runServiceManager(conn.serviceArgv('systemd-user').reload), /never run under the test runner/);
  assert.equal(spy.mock.callCount(), 0, 'nothing was spawned');
});

// ── capturePathEnv ─────────────────────────────────────────────────────────

function stub(dir, name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
  return file;
}

test('capturePathEnv: node, git, tmux and claude\'s directories first, in that order, then the system directories, no duplicates', (t) => {
  withTempHome(t);
  const dNode = tmpDir(t, 'node');
  const dGit = tmpDir(t, 'git');
  const dClaude = tmpDir(t, 'claude');
  const dTmux = tmpDir(t, 'tmux');
  const dEmpty = tmpDir(t, 'empty');
  const execPath = stub(dNode, 'node');
  stub(dGit, 'git');
  stub(dClaude, 'claude');
  stub(dTmux, 'tmux');
  // A file that is there but not executable is not found.
  fs.writeFileSync(path.join(dEmpty, 'git'), 'x');
  fs.chmodSync(path.join(dEmpty, 'git'), 0o644);

  const PATH = [dEmpty, dNode, dGit, dClaude, dGit, 'relative/bin'].join(path.delimiter);
  const got = conn.capturePathEnv({ env: { PATH }, execPath });
  assert.deepEqual(got.pathEnv.split(path.delimiter), [dNode, dGit, dClaude, '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  assert.equal(got.tmux, false);
  assert.equal(got.git, true);
  assert.equal(got.claude, true);

  const withTmux = conn.capturePathEnv({ env: { PATH: [dTmux, PATH].join(path.delimiter) }, execPath });
  assert.deepEqual(withTmux.pathEnv.split(path.delimiter), [dNode, dGit, dTmux, dClaude, '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  assert.equal(withTmux.tmux, true);

  // node found on PATH in another directory than execPath's comes next; an
  // injected findClaude is the one asked.
  const dOtherNode = tmpDir(t, 'node2');
  stub(dOtherNode, 'node');
  const other = conn.capturePathEnv({
    env: { PATH: dOtherNode },
    execPath,
    findClaude: () => path.join(dClaude, 'claude'),
  });
  const list = other.pathEnv.split(path.delimiter);
  assert.deepEqual(list.slice(0, 3), [dNode, dOtherNode, dClaude]);
  assert.equal(new Set(list).size, list.length, 'no duplicates');
});

// ── the registry's port-less role ───────────────────────────────────────────

test('registerRole without a port: port null and url null, read back, listed unprobed, never a session', async (t) => {
  withTempHome(t);
  const entry = registry.registerRole('connector', { pid: process.pid });
  assert.equal(entry.port, null);
  assert.equal(entry.url, null);
  assert.equal(entry.root, null);
  assert.equal(entry.id, 'connector');

  const read = registry.readRoleEntry('connector');
  assert.equal(read.port, null);
  assert.equal(read.url, null);
  assert.equal(read.pid, process.pid);

  // The probe is an http.request (lib/core/portfiles); a port-less row must
  // never reach one — a probe of port null would ask 127.0.0.1:80.
  const http = require('http');
  const probes = t.mock.method(http, 'request', () => { throw new Error('a port-less row was probed'); });
  const rows = await registry.rows({ role: 'connector', timeoutMs: 50 });
  assert.equal(probes.mock.callCount(), 0, 'a port-less row is never probed');
  probes.mock.restore();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].port, null);
  assert.equal(rows[0].pid_alive, true);
  assert.equal(rows[0].reachable, false);
  assert.deepEqual(await registry.rows(), [], 'it is not an instance');
  assert.deepEqual(registry.sessions({ inactive: false }), [], 'a singleton is never a session');
  assert.deepEqual(registry.readInstances(), []);

  assert.equal(registry.registerRole('connector', { port: null, pid: process.pid }).url, null, 'port null is no port');
  assert.equal(registry.readAllEntries().filter((e) => e.role === 'connector').length, 1, 'one row per role');

  const portal = registry.registerRole('portal', { port: 5171, pid: process.pid });
  assert.equal(portal.port, 5171);
  assert.equal(portal.url, 'http://localhost:5171', 'a role with a port is as it always was');
  assert.deepEqual(Object.keys(portal), ['id', 'role', 'version', 'root', 'port', 'pid', 'url', 'started_at']);
  assert.deepEqual(Object.keys(entry), Object.keys(portal), 'the same row shape');

  assert.equal(registry.deregisterRole('connector', { pid: process.pid }), true);
  assert.equal(registry.readRoleEntry('connector'), null);
  assert.ok(registry.readRoleEntry('portal'), 'the portal row is untouched');
});
