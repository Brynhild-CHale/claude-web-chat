// `uninstall --self` does the hub connector's local half of disconnect, and
// `status` prints one connector line (contract 06 C-06.9, C-06.20a, section
// 4's status.js row; tranche 6 U756). Pins:
//
//   * --self with a connector record calls disconnectLocal({hubId, reason:
//     'uninstall'}) right after the portal and before this project's daemon
//     is stopped, the servers swept, the capture hub stopped or the program
//     removed, and says the hub keeps the machine until it is revoked there;
//   * a disconnect that throws, or that could not delete the key or remove the
//     unit file, refuses: nothing is removed (no project unwiring, no daemon
//     stop, no removeProgram) and `claude-web-chat connect disconnect` is
//     named; a record it could not mark revoked does not hold the removal;
//   * no record and no connector role: the step is a no-op; a plain uninstall
//     never calls it; a connector role with no record refuses;
//   * inside the sandbox --self with a connector present and no disconnectLocal
//     seam refuses before anything runs;
//   * status prints exactly one `Connector:` line, after `Server:` —
//     "Connector: not paired" with no record; else the hub host, running or
//     not (the registry's connector role), the ceiling through readCeiling (no
//     ceiling key reads full, 'admin' reads basic) and credential.state, and no
//     key material.
//
// Every case runs in a throwaway HOME (withTempHome under
// test-support/sandbox.js). disconnectLocal is always injected for --self, the
// port scan is empty and the hub stop and program removal are recorded: no
// service manager runs, no port is probed, no daemon is dialled.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { withTempHome, tmpRoot } = require('../test-support/helpers');
const { userPaths } = require('../lib/core/paths');
const registry = require('../lib/util/registry');
const setup = require('../lib/setup/connector');
const uninstall = require('../lib/cli/commands/uninstall');
const status = require('../lib/cli/commands/status');

const HUB = 'hale-hub';
const KEY_ID = 'mky_y4881352x9v335ap1wtpd4q6ef';
const PUBLIC_KEY = 'kTCi0MViCOcU8LqIYhIzSR1xC7jW0kmKgaBHqjV2eo4';
const FINGERPRINT = 'SHA256:8RCAjKLqdjGVVg81ZpLmc+7/fOPgiDSG8BRyRVXXMGs';

function projectRoot(t, prefix = 'wc-u756-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// A record as a paired machine holds it, in the sandbox HOME. `ceiling`
// undefined leaves the key out (the schema's default, full).
function pairedRecord({ ceiling, state = 'paired', origin = 'https://hub.example.com:8443' } = {}) {
  setup.ensureConnectorDir();
  const keyFile = userPaths().connectorKey(HUB);
  const record = {
    v: 1,
    hub: { id: HUB, origin, name: 'Test hub' },
    machine: { id: 'mch_01jbz3k9q4w8r2t6v0x5m7n8p1', name: 'studio-mbp' },
    credential: {
      state,
      algorithm: 'ed25519',
      key_file: keyFile,
      key_id: KEY_ID,
      public_key: PUBLIC_KEY,
      fingerprint: FINGERPRINT,
      paired_at: 1793177460000,
      revoked_at: null,
    },
    workdir: userPaths().defaultWorkdir(HUB),
    settings: { agents_at_once: 4, local_cap: null, accept_new_chats: true, let_home_start_agents: false, paused: false, rev: 4 },
    folders: [],
    chats: [],
  };
  if (ceiling !== undefined) record.ceiling = ceiling;
  setup.writeRecord(record);
  return { record, keyFile, recordFile: userPaths().connectorRecord(HUB) };
}

async function captured(fn) {
  const lines = [];
  const prev = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  let res;
  let error = null;
  try { res = await fn(); } catch (e) { error = e; } finally { console.log = prev; }
  return { res, error, text: lines.join('\n') };
}

// The seams of every --self call here. Each step the order cares about pushes
// its name: the portal's stop, the disconnect, this project's unwiring (the
// claude runner), this project's daemon (mcpSessionsFor runs at the end of
// stopDaemons), the other servers' sweep (rows), the hub and the removal.
function seams(order, extra = {}) {
  const calls = [];
  return {
    calls,
    opts: {
      knownRoots: [],
      scanPorts: [],
      ackWaitMs: 500,
      signalWaitMs: 200,
      runClaude: () => { order.push('unwire'); return { ok: true }; },
      readPortal: () => ({ pid: 4242, port: null }),
      tunnelDown: async () => { order.push('portal'); return { stopped: true }; },
      mcpSessionsFor: () => { order.push('daemons'); return []; },
      rows: async () => { order.push('others'); return []; },
      hubStop: async () => { order.push('hub'); return { stopped: true }; },
      removeProgram: () => { order.push('remove'); },
      disconnectLocal: async (args) => {
        order.push('disconnect');
        calls.push(args);
        return {
          ok: true,
          reason: args.reason,
          steps: [
            { step: 'daemons', via: 'direct', stopped: [] },
            { step: 'key', removed: true },
            { step: 'record', state: 'revoked' },
            { step: 'unload', ran: true },
            { step: 'unit', removed: true },
            { step: 'socket', removed: false },
          ],
          left: [],
        };
      },
      ...extra,
    },
  };
}

test('uninstall --self with a paired record disconnects locally after the portal and before any daemon stop or removal', async (t) => {
  withTempHome(t);
  pairedRecord();
  const order = [];
  const { opts, calls } = seams(order);
  const { res, error, text } = await captured(() => uninstall(['--self'], { cwd: projectRoot(t), ...opts }));
  assert.equal(error, null, error && error.message);
  assert.deepEqual(calls.map((c) => ({ hubId: c.hubId, reason: c.reason })), [{ hubId: HUB, reason: 'uninstall' }]);
  assert.equal(order[0], 'portal');
  assert.equal(order[1], 'disconnect', `the disconnect right after the portal: ${order.join(', ')}`);
  for (const later of ['daemons', 'others', 'hub', 'remove']) {
    assert.ok(order.indexOf(later) > order.indexOf('disconnect'), `${later} after the disconnect: ${order.join(', ')}`);
  }
  assert.deepEqual(order.slice(-2), ['hub', 'remove'], 'the capture hub keeps its own step, then the removal');
  assert.match(text, /Disconnected the hub connector on this machine:/);
  assert.match(text, /The hub keeps this machine until you revoke it there\./);
  assert.ok(text.indexOf('Disconnected the hub connector') < text.indexOf('web-chat uninstalled from'),
    'the disconnect is said before this project is unwired');
  assert.match(text, /the machine key deleted, the start-at-login unit removed/);
  assert.equal(res.connector.hubs.length, 1);
  assert.equal(res.connector.hubs[0].hubId, HUB);
});

test('the default disconnect runs against the sandboxed record: key gone, record revoked, roots kept', async (t) => {
  withTempHome(t);
  const { keyFile, recordFile } = pairedRecord();
  fs.writeFileSync(keyFile, 'not a real key\n', { mode: 0o600 });
  const order = [];
  const ran = [];
  const { opts } = seams(order, {
    // The real disconnectLocal, with every outside reach stubbed: no daemon
    // answers, the service manager is recorded.
    disconnectLocal: (args) => { order.push('disconnect'); return setup.disconnectLocal(args); },
    connectorDeps: { daemonFor: async () => null, run: (argv) => { ran.push(argv[0]); return ''; }, platform: 'darwin' },
  });
  const { error, text } = await captured(() => uninstall(['--self'], { cwd: projectRoot(t), ...opts }));
  assert.equal(error, null, error && error.message);
  assert.ok(!fs.existsSync(keyFile), 'the key file was deleted');
  const read = setup.readRecord(HUB);
  assert.equal(read.ok, true);
  assert.equal(read.value.credential.state, 'revoked');
  assert.ok(fs.existsSync(recordFile), 'the record stays, marked revoked');
  assert.ok(!text.includes('not a real key'), 'the key text is never printed');
  assert.match(text, /The hub keeps this machine until you revoke it there/);
});

test('a disconnectLocal that throws makes uninstall --self refuse with nothing removed, naming connect disconnect', async (t) => {
  withTempHome(t);
  pairedRecord();
  const root = projectRoot(t);
  const order = [];
  const { opts } = seams(order, {
    disconnectLocal: async () => { order.push('disconnect'); throw Object.assign(new Error('boom'), { code: 'EACCES' }); },
  });
  const { error, text } = await captured(() => uninstall(['--self'], { cwd: root, ...opts }));
  assert.ok(error, 'uninstall --self refused');
  assert.doesNotMatch(text, /web-chat uninstalled from/, 'this project was not unwired');
  assert.equal(error.userFacing, true);
  assert.match(error.message, /could not be disconnected on this machine: EACCES/);
  assert.match(error.message, /Nothing was removed/);
  assert.match(error.message, /`claude-web-chat connect disconnect`/);
  assert.deepEqual(order, ['portal', 'disconnect'], 'no unwiring, no daemon stop, no sweep, no hub stop, no removal');
  assert.ok(fs.existsSync(path.join(root, '.web-chat')));
});

test('a disconnect that could not delete the key or remove the unit file refuses too; an unwritten record does not', async (t) => {
  withTempHome(t);
  pairedRecord();
  for (const failing of ['key', 'unit']) {
    const order = [];
    const { opts } = seams(order, {
      disconnectLocal: async () => {
        order.push('disconnect');
        return {
          ok: false,
          steps: [
            { step: 'daemons', via: 'direct', stopped: [] },
            failing === 'key' ? { step: 'key', removed: false, error: 'EPERM' } : { step: 'key', removed: true },
            { step: 'record', state: 'revoked' },
            failing === 'unit' ? { step: 'unit', removed: false, error: 'EPERM' } : { step: 'unit', removed: true },
          ],
          left: [],
        };
      },
    });
    const { error } = await captured(() => uninstall(['--self'], { cwd: projectRoot(t), ...opts }));
    assert.ok(error && error.userFacing, `${failing}: refused`);
    assert.match(error.message, failing === 'key' ? /machine key could not be deleted \(EPERM\)/ : /unit file could not be removed \(EPERM\)/);
    assert.match(error.message, /connect disconnect/);
    assert.ok(!order.includes('remove') && !order.includes('daemons'), `${failing}: nothing after the refusal (${order.join(', ')})`);
  }

  const order = [];
  const { opts } = seams(order, {
    disconnectLocal: async () => {
      order.push('disconnect');
      return {
        ok: false,
        steps: [
          { step: 'daemons', via: 'direct', stopped: ['c1'] },
          { step: 'key', removed: true },
          { step: 'record', state: 'unwritten', error: 'ERECORD' },
          { step: 'unit', removed: true },
        ],
        left: [{ chat_id: 'c2', scope_kind: 'folder', root: '/tmp/Offered', why: 'other' }],
      };
    },
  });
  const { error, text } = await captured(() => uninstall(['--self'], { cwd: projectRoot(t), ...opts }));
  assert.equal(error, null, error && error.message);
  assert.match(text, /its record could not be marked revoked \(ERECORD\)/);
  assert.match(text, /left running: chat c2's daemon at \/tmp\/Offered \(not started by the connector\)/);
  assert.match(text, /1 daemon on owned roots stopped/);
  assert.deepEqual(order.slice(-2), ['hub', 'remove']);
});

test('with no record and no connector role the step is a no-op, and a plain uninstall never calls it', async (t) => {
  withTempHome(t);
  const order = [];
  const { opts, calls } = seams(order, { disconnectLocal: undefined });
  const none = await captured(() => uninstall(['--self'], { cwd: projectRoot(t), ...opts }));
  assert.equal(none.error, null, none.error && none.error.message);
  assert.ok(!('connector' in none.res), 'no connector result');
  assert.doesNotMatch(none.text, /hub connector/);
  assert.deepEqual(order.slice(-2), ['hub', 'remove']);

  pairedRecord();
  const plainOrder = [];
  const plain = seams(plainOrder);
  const r = await captured(() => uninstall([], { cwd: projectRoot(t), ...plain.opts }));
  assert.equal(r.error, null, r.error && r.error.message);
  assert.deepEqual(plain.calls, [], 'a plain uninstall never disconnects');
  assert.ok(!plainOrder.includes('disconnect') && !plainOrder.includes('portal'));
  assert.equal(calls.length, 0);
});

test('a connector role with no record refuses; a record with no disconnectLocal seam refuses inside the sandbox', async (t) => {
  withTempHome(t);
  const order = [];
  const { opts } = seams(order, { readConnector: () => ({ role: 'connector', pid: 31337, port: null }) });
  const { error } = await captured(() => uninstall(['--self'], { cwd: projectRoot(t), ...opts }));
  assert.ok(error && error.userFacing);
  assert.match(error.message, /pid 31337/);
  assert.match(error.message, /no connector record names its hub/);
  assert.match(error.message, /Nothing was removed/);
  assert.ok(!order.includes('disconnect') && !order.includes('remove'));

  pairedRecord();
  const order2 = [];
  const s2 = seams(order2, { disconnectLocal: undefined });
  const r2 = await captured(() => uninstall(['--self'], { cwd: projectRoot(t), ...s2.opts }));
  assert.ok(r2.error);
  assert.match(r2.error.message, /without disconnectLocal/);
  assert.deepEqual(order2, [], 'refused before the portal or anything else ran');
});

// ── status ─────────────────────────────────────────────────────────────────

async function runStatus(t, seed, opts = {}) {
  withTempHome(t);
  const root = tmpRoot('wc-u756-status-');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '.web-chat', 'graph'), { recursive: true });
  if (seed) seed(root);
  const { error, text } = await captured(() => status([], { cwd: root, ...opts }));
  assert.equal(error, null, error && error.message);
  return text;
}

function connectorLines(out) {
  return out.split('\n').filter((l) => l.startsWith('Connector:'));
}

test('status prints exactly one "Connector: not paired" line, after Server:, with no record', async (t) => {
  const out = await runStatus(t);
  const lines = out.split('\n');
  assert.deepEqual(connectorLines(out), ['Connector: not paired']);
  const at = lines.indexOf('Connector: not paired');
  assert.match(lines[at - 1], /^Server: /, 'right after the Server line');
});

test('status with a record prints the hub host, not running, the ceiling (absent → full) and the credential state, and no key material', async (t) => {
  let paths;
  const out = await runStatus(t, () => { paths = pairedRecord(); });
  assert.deepEqual(connectorLines(out), ['Connector: paired with hub.example.com:8443 — not running — ceiling full — credential paired']);
  for (const secretish of [KEY_ID, PUBLIC_KEY, FINGERPRINT, paths.keyFile, 'mky_', 'SHA256:', '.key']) {
    assert.ok(!out.includes(secretish), `status prints no ${secretish}`);
  }
});

test('status names a running connector by pid, a read ceiling, and a revoked credential without "paired with"', async (t) => {
  const out = await runStatus(t, () => {
    pairedRecord({ ceiling: 'read', state: 'revoked' });
    registry.registerRole('connector', { pid: process.pid });
  });
  assert.deepEqual(connectorLines(out), [`Connector: hub hub.example.com:8443 — running (pid ${process.pid}) — ceiling read — credential revoked`]);
});

test('status reads a record whose ceiling is "admin" as basic (readCeiling), on one line that points at connect status', async (t) => {
  const out = await runStatus(t, () => {
    const { record, recordFile } = pairedRecord();
    // writeRecord refuses the shape; written by hand as a torn hand-edit would be.
    fs.writeFileSync(recordFile, JSON.stringify({ ...record, ceiling: 'admin' }), { mode: 0o600 });
  });
  const lines = connectorLines(out);
  assert.equal(lines.length, 1, out);
  assert.match(lines[0], /^Connector: hub hub\.example\.com:8443 — not running — ceiling basic — credential paired — ⚠ the record is not the record's shape \(see `claude-web-chat connect status`\)$/);
});

test('status says an unreadable record and two hub records in one line each', async (t) => {
  const torn = await runStatus(t, () => {
    const { recordFile } = pairedRecord();
    fs.writeFileSync(recordFile, '{ "v": 1, ', { mode: 0o600 });
  });
  assert.deepEqual(connectorLines(torn), [`Connector: hub ${HUB} — not running — ceiling basic — credential unknown — ⚠ the record is unreadable (see \`claude-web-chat connect status\`)`]);

  const two = await runStatus(t, null, {
    listConnectorRecords: () => [{ hubId: 'hub-one', read: { absent: true } }, { hubId: 'hub-two', read: { absent: true } }],
  });
  assert.deepEqual(connectorLines(two), ['Connector: more than one hub record (v1 pairs with one hub) — see `claude-web-chat connect status`']);
});
