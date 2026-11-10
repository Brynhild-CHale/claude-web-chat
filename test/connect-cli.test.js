// `claude-web-chat connect` — the CLI core and its subcommand table (contract
// 06 C-06.1; U722). Pins: the bare command prints its usage to stderr and
// answers 1 without dialing or writing anything (the alpha smoke's line), help
// answers 0, an unknown subcommand answers 1 with the usage, a row appended in
// the table's own shape dispatches by name and by match(), and `connect
// status` reads the records through lib/setup/connector.js — "not paired"
// with none, the record's fields when paired, never the key's content, and a
// torn record named with its path and exit 1. Every case runs in a throwaway
// HOME (withTempHome, under test-support/sandbox.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { withTempHome } = require('../test-support/helpers');
const { cliCommands } = require('../test-support/doc-truth');
const cliMain = require('../lib/cli').main;
const table = require('../lib/connector/cli');
const conn = require('../lib/setup/connector');
const registry = require('../lib/util/registry');
const { userPaths } = require('../lib/core/paths');

const REPO = path.resolve(__dirname, '..');

// Run `claude-web-chat <argv>` in-process through lib/cli's own main, with
// console captured, process.exitCode restored, and every outbound socket
// constructor spied on (none may be called).
async function run(t, argv) {
  const out = [];
  const err = [];
  const dials = [];
  const prev = {
    log: console.log, error: console.error, exitCode: process.exitCode,
    connect: net.connect, createConnection: net.createConnection, tlsConnect: tls.connect,
  };
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  net.connect = (...a) => { dials.push(['net.connect', a[0]]); return prev.connect.apply(net, a); };
  net.createConnection = (...a) => { dials.push(['net.createConnection', a[0]]); return prev.createConnection.apply(net, a); };
  tls.connect = (...a) => { dials.push(['tls.connect', a[0]]); return prev.tlsConnect.apply(tls, a); };
  process.exitCode = undefined;
  let code;
  try {
    await cliMain(argv);
  } finally {
    code = process.exitCode;
    console.log = prev.log;
    console.error = prev.error;
    net.connect = prev.connect;
    net.createConnection = prev.createConnection;
    tls.connect = prev.tlsConnect;
    process.exitCode = prev.exitCode;
  }
  return { code: code == null ? 0 : code, out: out.join('\n'), err: err.join('\n'), dials };
}

// Every path under `dir` (relative), sorted; [] when it is absent.
function tree(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

// A paired record in the contract's example shape (06-connector-state),
// with its key file in the sandbox HOME. `ceiling` absent unless given.
function pairedRecord({ ceiling, service = true } = {}) {
  const hubId = 'hale-hub';
  const record = {
    v: 1,
    hub: { id: hubId, origin: 'https://hub.example.com', name: 'Test hub' },
    machine: { id: 'mch_01jbz3k9q4w8r2t6v0x5m7n8p1', name: 'studio-mbp' },
    credential: {
      state: 'paired',
      algorithm: 'ed25519',
      key_file: userPaths().connectorKey(hubId),
      key_id: 'mky_y4881352x9v335ap1wtpd4q6ef',
      public_key: 'kTCi0MViCOcU8LqIYhIzSR1xC7jW0kmKgaBHqjV2eo4',
      fingerprint: 'SHA256:8RCAjKLqdjGVVg81ZpLmc+7/fOPgiDSG8BRyRVXXMGs',
      paired_at: 1793177460000,
      revoked_at: null,
    },
    workdir: userPaths().defaultWorkdir(hubId),
    settings: { agents_at_once: 2, local_cap: null, accept_new_chats: true, let_home_start_agents: false, paused: false, rev: 4 },
    folders: [{
      id: 'f_3a9c1e07b54d2f68', path: '/srv/ServerWebChat', display: '~/Dev/ServerWebChat',
      label: 'ServerWebChat', access: 'read-write', offered_at: 1793177520000,
    }],
    chats: [{
      chat_id: '01jbz9a1b2c3d4e5f6g7h8j9k0', rev: 3, scope_kind: 'folder', folder_id: 'f_3a9c1e07b54d2f68',
      root: '/srv/ServerWebChat', instance: '5b1e9c04', owned_root: false, desired: 'running',
      manual_attach_at: 1793177760000, assigned_at: 1793177700000,
    }],
    service: service ? {
      kind: 'launchd', label: 'com.claude-web-chat.connector',
      unit_path: '/srv/LaunchAgents/com.claude-web-chat.connector.plist',
      path_env: '/usr/bin:/bin', installed_at: 1793177465000,
    } : null,
    last_reported: { connector_version: '0.9.0-alpha.7', install_kind: 'managed', claude_code_version: '2.1.301', at: 1793181360000 },
  };
  if (ceiling) record.ceiling = ceiling;
  return record;
}

// A stand-in private key in its own 0600 file beside the record; returns the
// PEM body's base64 lines, which no status line may carry.
function writeStandInKey(hubId) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(userPaths().connectorKey(hubId), pem, { mode: 0o600 });
  return pem.split('\n').filter((l) => l && !l.startsWith('-----'));
}

// ── the bare command, help and unknown ─────────────────────────────────────

test('`connect` with no arguments prints the usage to stderr, answers 1, dials nothing and writes nothing', async (t) => {
  const home = withTempHome(t);
  const r = await run(t, ['connect']);
  assert.equal(r.code, 1);
  assert.match(r.err, /^usage: claude-web-chat connect <subcommand>/m);
  assert.match(r.err, /claude-web-chat connect status/);
  assert.equal(r.out, '', 'nothing on stdout');
  assert.deepEqual(r.dials, [], 'no socket opened');
  assert.equal(fs.existsSync(path.join(home, '.web-chat', 'connector')), false, 'no connector directory');
  assert.deepEqual(tree(home), [], 'nothing at all written under HOME');
});

test('the installed shape: `node bin/claude-web-chat.js connect` exits non-zero with the usage and leaves HOME empty', (t) => {
  const home = withTempHome(t);
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'claude-web-chat.js'), 'connect'], {
    cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /usage: claude-web-chat connect <subcommand>/);
  assert.deepEqual(tree(home), []);
});

test('`connect help` prints the usage to stdout and answers 0', async (t) => {
  withTempHome(t);
  for (const word of ['help', '--help', '-h']) {
    const r = await run(t, ['connect', word]);
    assert.equal(r.code, 0, word);
    assert.match(r.out, /usage: claude-web-chat connect <subcommand>/, word);
    assert.match(r.out, /claude-web-chat connect help/, word);
  }
});

test('an unknown subcommand answers 1 with the usage', async (t) => {
  const home = withTempHome(t);
  const r = await run(t, ['connect', 'frobnicate']);
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown subcommand: frobnicate/);
  assert.match(r.err, /usage: claude-web-chat connect <subcommand>/);
  assert.deepEqual(tree(home), []);
});

// ── the table ──────────────────────────────────────────────────────────────

test('every row of the table has the row shape', () => {
  assert.ok(table.ROWS.length >= 1);
  const names = new Set();
  for (const row of table.ROWS) {
    assert.equal(typeof row.name, 'string');
    assert.ok(row.name && !names.has(row.name), `one row per name (${row.name})`);
    names.add(row.name);
    assert.match(row.usage, /^connect /, `${row.name}'s usage starts with "connect "`);
    assert.equal(typeof row.summary, 'string');
    assert.equal(typeof row.run, 'function');
    if ('match' in row) assert.equal(typeof row.match, 'function');
  }
  assert.ok(!names.has('help'), 'help is the dispatcher\'s, not a row');
});

test('a row appended in the table\'s own shape dispatches by name and by match()', async (t) => {
  withTempHome(t);
  const calls = [];
  const row = {
    name: 'probe',
    usage: 'connect probe <x> | <probe-url>',
    summary: 'A test row',
    match: (arg) => /^probe:\/\//.test(arg),
    run: async (args) => { calls.push(args); return 7; },
  };
  table.ROWS.push(row);
  t.after(() => { table.ROWS.splice(table.ROWS.indexOf(row), 1); });

  const byName = await run(t, ['connect', 'probe', 'a', 'b']);
  assert.equal(byName.code, 7);
  assert.deepEqual(calls.shift(), ['a', 'b'], 'by name: the arguments after the name');

  const byMatch = await run(t, ['connect', 'probe://hub', '--flag']);
  assert.equal(byMatch.code, 7);
  assert.deepEqual(calls.shift(), ['probe://hub', '--flag'], 'by match: every argument');

  const help = await run(t, ['connect', 'help']);
  assert.match(help.out, /claude-web-chat connect probe <x> \| <probe-url>/, 'the row\'s usage is in the usage block');

  const miss = await run(t, ['connect', 'nope://hub']);
  assert.equal(miss.code, 1);
  assert.equal(calls.length, 0);
});

// ── status ─────────────────────────────────────────────────────────────────

test('`connect status` with no record prints "Connector: not paired", answers 0 and writes nothing', async (t) => {
  const home = withTempHome(t);
  const r = await run(t, ['connect', 'status']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Connector: not paired$/m);
  assert.deepEqual(r.dials, []);
  assert.deepEqual(tree(home), [], 'nothing written, not the connector directory');
});

test('`connect status` on a paired record prints its fields, ceiling full with no key, never the key', async (t) => {
  withTempHome(t);
  conn.writeRecord(pairedRecord());
  const keyLines = writeStandInKey('hale-hub');
  const before = tree(userPaths().connectorDir);

  const r = await run(t, ['connect', 'status']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /hub hale-hub "Test hub" at https:\/\/hub\.example\.com/);
  assert.match(r.out, /credential: paired · fingerprint SHA256:8RCAjKLqdjGVVg81ZpLmc\+7\/fOPgiDSG8BRyRVXXMGs/);
  assert.match(r.out, /machine: studio-mbp \(mch_01jbz3k9q4w8r2t6v0x5m7n8p1\)/);
  assert.match(r.out, /ceiling: full$/m, 'no ceiling key reads full');
  assert.match(r.out, /settings: paused no · agents at once 2 · local cap none · accept new chats yes/);
  assert.match(r.out, /~\/Dev\/ServerWebChat "ServerWebChat" \(f_3a9c1e07b54d2f68\)/);
  assert.match(r.out, /01jbz9a1b2c3d4e5f6g7h8j9k0 · folder · running/);
  assert.match(r.out, /last reported: connector 0\.9\.0-alpha\.7 · install managed · Claude Code 2\.1\.301/);
  assert.match(r.out, /service: launchd \/srv\/LaunchAgents\/com\.claude-web-chat\.connector\.plist/);
  assert.match(r.out, /Connector process: not running/);
  assert.ok(!/not paired/.test(r.out));
  for (const line of keyLines) {
    assert.ok(!r.out.includes(line) && !r.err.includes(line), 'no status line carries the key\'s PEM body');
  }
  assert.ok(!r.out.includes('/srv/ServerWebChat'), 'a chat root or folder path is not printed');
  assert.deepEqual(tree(userPaths().connectorDir), before, 'status writes nothing');
  assert.deepEqual(r.dials, []);
});

test('`connect status` reads ceiling read, a foreground-only service, and the live connector row with no port', async (t) => {
  withTempHome(t);
  conn.writeRecord(pairedRecord({ ceiling: 'read', service: false }));
  registry.registerRole('connector', { pid: process.pid });

  const r = await run(t, ['connect', 'status']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ceiling: read$/m);
  assert.match(r.out, /service: foreground only/);
  assert.match(r.out, new RegExp(`Connector process: running \\(pid ${process.pid}\\)$`, 'm'), 'a null port prints as nothing');
});

test('`connect status` on a corrupt record answers 1 naming the file', async (t) => {
  withTempHome(t);
  conn.ensureConnectorDir();
  const file = userPaths().connectorRecord('hale-hub');
  fs.writeFileSync(file, '{ "v": 1, "hub": ', { mode: 0o600 });
  const r = await run(t, ['connect', 'status']);
  assert.equal(r.code, 1);
  assert.ok(r.err.includes(file), `the error names ${file}: ${r.err}`);
  assert.match(r.err, /unreadable/);
});

test('`connect status` on a record of the wrong shape answers 1 naming the file and the pointer, never the value', async (t) => {
  withTempHome(t);
  conn.ensureConnectorDir();
  const file = userPaths().connectorRecord('hale-hub');
  const bad = { ...pairedRecord(), secret: 'do-not-print-this-value' };
  fs.writeFileSync(file, JSON.stringify(bad), { mode: 0o600 });
  const r = await run(t, ['connect', 'status']);
  assert.equal(r.code, 1);
  assert.ok(r.err.includes(file));
  assert.match(r.err, /not a connector record/);
  assert.ok(!r.out.includes('do-not-print-this-value') && !r.err.includes('do-not-print-this-value'));
});

// ── registration ───────────────────────────────────────────────────────────

test('the commands map registers connect, and the help names it', async (t) => {
  withTempHome(t);
  assert.ok(cliCommands().includes('connect'));
  const r = await run(t, ['help']);
  assert.match(r.out, /^ {2}connect <hub-url> \| status \| …$/m);
  assert.match(r.out, /claude-web-chat connect help/);
});

test('lib/connector is required from one CLI file, connect.js', () => {
  const dir = path.join(REPO, 'lib', 'cli');
  const hits = [];
  for (const rel of fs.readdirSync(dir, { recursive: true }).map(String)) {
    if (!rel.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, rel), 'utf8');
    if (/require\(['"][./]*connector(?:\/[a-z-]+)?['"]\)/.test(src)) hits.push(rel);
  }
  assert.deepEqual(hits, [path.join('commands', 'connect.js')]);
});
