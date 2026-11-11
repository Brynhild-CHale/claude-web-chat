'use strict';

// `connect <hub-url>`, `connect run` and `connect rotate` (tranche 6, U726;
// contract 06 C-06.1, C-06.3, C-06.5 as A-06.1 words it, C-06.6, C-06.10,
// C-06.18; 05 C-05.4, C-05.7; swc-25 §4 and form 3 CB1 = b, CB2 = a):
// lib/connector/install.js and lib/connector/run.js through the subcommand
// table (lib/connector/cli.js main).
//
// LAUNCHD@stubbed: every service-manager call goes to an injected recorder
// (deps.run); no test runs launchctl, systemctl, tmux or claude. Every case
// runs under a throwaway HOME (withTempHome, over npm test's sandbox);
// describeInstall is stubbed (managed, its link in the sandbox's
// ~/.local/bin); the platform is injected. A hub is only the fake
// (test-support/fake-hub.js) on 127.0.0.1:0, its port asserted outside the
// band; a pairing code is read from the connector's own stdout and never
// logged or written by this file.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter, once } = require('events');

const { withTempHome, waitUntil } = require('../test-support/helpers');
const { withFakeHub, isReservedPort } = require('../test-support/fake-hub');
const { userPaths } = require('../lib/core/paths');
const { TABLE_VERSION, TABLE_SHA256 } = require('../lib/core/connected-policy');
const registry = require('../lib/util/registry');
const outbound = require('../lib/util/outbound');
const conn = require('../lib/setup/connector');
const cli = require('../lib/connector/cli');
const install = require('../lib/connector/install');
const runMod = require('../lib/connector/run');
const factsMod = require('../lib/connector/facts');
const lifecycleMod = require('../lib/connector/lifecycle');

const HUB = 'hub-test';
const LABEL = 'com.claude-web-chat.connector';
const UID = 501;
const LINE_RE = /^pairing code ([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}) · fingerprint (SHA256:[A-Za-z0-9+/]{43}) · expires (\d{4}-\d\d-\d\dT[\d:.]+Z)$/;

const modeOf = (file) => fs.statSync(file).mode & 0o777;

// Every file under `dir` (the sandbox HOME), relative.
function filesUnder(dir, base = dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, base));
    else out.push(path.relative(base, p));
  }
  return out.sort();
}

// The sandbox: a HOME, the managed install's ~/.local/bin link (to a stub in
// the HOME), a PATH directory, and the deps every row reads.
function sandbox(t, { tmux = false, kind = 'launchd', platform = 'darwin', installKind = 'managed', link = true } = {}) {
  const home = withTempHome(t);
  const binDir = path.join(home, '.local', 'bin');
  const linkPath = path.join(binDir, 'claude-web-chat');
  const target = path.join(home, '.web-chat', 'versions', '0.9.0-alpha.7', 'bin', 'claude-web-chat.js');
  if (link) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(target, linkPath);
  }
  const pathDir = path.join(home, 'path-bin');
  fs.mkdirSync(pathDir, { recursive: true });
  if (tmux) fs.writeFileSync(path.join(pathDir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const out = [];
  const err = [];
  const calls = [];
  const pairs = [];
  const deps = {
    out: (l) => out.push(String(l)),
    err: (l) => err.push(String(l)),
    describeInstall: () => ({ kind: installKind, linkPath }),
    getuid: () => UID,
    platform,
    platformKind: () => kind,
    env: { PATH: pathDir },
    findClaude: () => null,
    run: (argv) => { calls.push(argv); return Buffer.alloc(0); },
    waitMs: 300,
    signals: new EventEmitter(),
    connectorRow: () => null,
  };
  return { home, linkPath, target, pathDir, out, err, calls, pairs, deps };
}

// A paired record for HUB with a key in its file (writeMachineKey, the one
// writer), at `origin`; returns the key pair.
function seedPaired({ origin = 'https://hub.example.com', machineId, publicRaw, privateKey, chats = [], name = 'Studio Mac' } = {}) {
  const pair = privateKey ? { privateKey } : crypto.generateKeyPairSync('ed25519');
  const raw = publicRaw || Buffer.from(pair.privateKey.export({ format: 'jwk' }).x, 'base64url');
  const id = machineId || `mch_${'0'.repeat(26)}`;
  conn.writeMachineKey({
    hubId: HUB,
    pem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    update: () => ({
      ...conn.newRecord({ hubId: HUB, origin }),
      machine: { id, name },
      credential: { state: 'paired', algorithm: 'ed25519', paired_at: Date.now() - 1000 },
      chats,
    }),
  });
  return { privateKey: pair.privateKey, raw };
}

// A pair() stand-in: records its options, writes a paired record like the
// real one does (or answers what `answer` says).
function stubPair(s, { answer, origin = 'https://hub.example.com' } = {}) {
  return async (opts) => {
    s.pairs.push(opts);
    if (answer) return answer;
    seedPaired({ origin });
    if (opts.workdir) conn.updateRecord(HUB, (r) => ({ ...r, workdir: opts.workdir }));
    return { ok: true, state: 'paired', hubId: HUB, machineId: `mch_${'0'.repeat(26)}`, keyId: 'mky_x' };
  };
}

const main = (args, deps) => cli.main(args, deps);

function readRec() {
  const r = conn.readRecord(HUB);
  return r.ok ? r.value : null;
}

// ── step (1): the managed install, root, the link ──────────────────────────

for (const kind of ['dev', 'unmanaged']) {
  test(`a ${kind} install refuses naming the installer, runs nothing and writes nothing`, async (t) => {
    const s = sandbox(t, { installKind: kind });
    const before = filesUnder(s.home);
    const code = await main(['https://hub.example.com'], { ...s.deps, pair: stubPair(s) });
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /install\.sh/);
    assert.match(s.err.join('\n'), /claude-web-chat update/);
    assert.deepEqual(s.calls, [], 'no service manager');
    assert.deepEqual(s.pairs, [], 'no pairing');
    assert.deepEqual(filesUnder(s.home), before, 'nothing written');
  });
}

test('root is refused (C-06.1): nothing paired, run or written', async (t) => {
  const s = sandbox(t);
  const before = filesUnder(s.home);
  const code = await main(['https://hub.example.com'], { ...s.deps, getuid: () => 0, pair: stubPair(s) });
  assert.equal(code, 1);
  assert.match(s.err.join('\n'), /never as root/);
  assert.deepEqual(s.pairs, []);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(filesUnder(s.home), before);
  const run = await runMod.run([], { ...s.deps, getuid: () => 0, createLink: () => assert.fail('no link for root') });
  assert.equal(run, 1);
});

test('a missing ~/.local/bin link refuses before pairing: the unit launches through it', async (t) => {
  const s = sandbox(t, { link: false });
  const code = await main(['https://hub.example.com'], { ...s.deps, pair: stubPair(s) });
  assert.equal(code, 1);
  assert.match(s.err.join('\n'), /~\/\.local\/bin is missing/);
  assert.deepEqual(s.pairs, []);
  assert.deepEqual(s.calls, []);
  assert.equal(fs.existsSync(conn.unitPaths().launchd), false);
});

// ── steps (2)–(5) on macOS ─────────────────────────────────────────────────

test('darwin, no record: pair once; the plist through the ~/.local/bin link; bootout then bootstrap; the record\'s service; the log 0600', async (t) => {
  const s = sandbox(t);
  const code = await main(['https://hub.example.com'], { ...s.deps, pair: stubPair(s) });
  assert.equal(code, 0, s.err.join('\n'));
  assert.equal(s.pairs.length, 1, 'pair() once');
  assert.equal(s.pairs[0].hubUrl, 'https://hub.example.com');
  assert.equal(s.pairs[0].rePair, false);

  const plist = path.join(s.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  assert.equal(conn.unitPaths().launchd, plist);
  const text = fs.readFileSync(plist, 'utf8');
  assert.ok(text.includes(`<array>\n    <string>${s.linkPath}</string>\n    <string>connect</string>\n    <string>run</string>\n  </array>`), text);
  assert.doesNotMatch(text, /versions\//, 'never a version path');
  assert.equal(modeOf(plist), 0o644);
  assert.doesNotMatch(text, /PRIVATE|mky_|SHA256:/, 'no key material in the unit');

  assert.deepEqual(s.calls, [
    ['launchctl', 'bootout', `gui/${UID}/${LABEL}`],
    ['launchctl', 'bootstrap', `gui/${UID}`, plist],
  ]);

  const rec = readRec();
  assert.equal(rec.service.kind, 'launchd');
  assert.equal(rec.service.label, LABEL);
  assert.equal(rec.service.unit_path, plist);
  assert.equal(rec.service.path_env, conn.capturePathEnv({ env: s.deps.env, findClaude: () => null }).pathEnv);
  assert.ok(rec.service.path_env.startsWith(path.dirname(process.execPath)));
  assert.ok(Number.isFinite(rec.service.installed_at));

  const log = userPaths().connectorLog;
  assert.equal(modeOf(log), 0o600, 'the connector log exists 0600');
  // No file outside the sandbox HOME: every path the install wrote is in it.
  for (const p of [plist, log, conn.unitPaths().launchd, userPaths().connectorRecord(HUB)]) {
    assert.ok(p.startsWith(s.home + path.sep), p);
  }
  assert.match(s.out.join('\n'), /not connected yet \(the service keeps trying\)/);
});

test('a bootout that fails (not loaded) is ignored; a failing bootstrap is tried once more, then reported', async (t) => {
  const s = sandbox(t);
  seedPaired();
  const calls = [];
  let fails = 2;
  const runner = (argv) => {
    calls.push(argv);
    if (argv[1] === 'bootout') throw new Error('Boot-out failed: 3: No such process');
    if (argv[1] === 'bootstrap' && fails-- > 0) throw new Error('Bootstrap failed: 5: Input/output error');
    return Buffer.alloc(0);
  };
  const code = await main(['https://hub.example.com'], { ...s.deps, run: runner, sleep: async () => {} });
  assert.equal(code, 1);
  assert.deepEqual(calls.map((a) => a[1]), ['bootout', 'bootstrap', 'bootstrap']);
  assert.match(s.err.join('\n'), /did not start the connector/);
});

test('linux: the systemd user unit; daemon-reload, enable --now, restart; the enable-linger hint', async (t) => {
  const s = sandbox(t, { kind: 'systemd-user', platform: 'linux' });
  const code = await main(['https://hub.example.com'], { ...s.deps, pair: stubPair(s) });
  assert.equal(code, 0, s.err.join('\n'));
  const unit = path.join(s.home, '.config', 'systemd', 'user', 'claude-web-chat-connector.service');
  const text = fs.readFileSync(unit, 'utf8');
  assert.match(text, /^ExecStart=%h\/\.local\/bin\/claude-web-chat connect run$/m);
  assert.equal(modeOf(unit), 0o644);
  assert.deepEqual(s.calls, [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', 'claude-web-chat-connector'],
    ['systemctl', '--user', 'restart', 'claude-web-chat-connector'],
  ]);
  assert.match(s.out.join('\n'), /loginctl enable-linger \$USER/);
  assert.equal(readRec().service.kind, 'systemd-user');
  assert.match(s.out.join('\n'), /install your distribution's tmux package/);
});

test('another platform writes no unit, runs nothing and prints the foreground sentence', async (t) => {
  const s = sandbox(t, { kind: null, platform: 'freebsd' });
  const code = await main(['https://hub.example.com'], { ...s.deps, pair: stubPair(s) });
  assert.equal(code, 0, s.err.join('\n'));
  assert.deepEqual(s.calls, []);
  assert.match(s.out.join('\n'), /start at login is unavailable here; run `claude-web-chat connect run` in a terminal/);
  assert.equal(fs.existsSync(conn.unitPaths().launchd), false);
  assert.equal(fs.existsSync(conn.unitPaths()['systemd-user']), false);
  assert.equal(readRec().service, undefined);
});

test('rerun with a paired record: no pairing; the unit rewritten and restarted; --re-pair pairs once', async (t) => {
  const s = sandbox(t);
  seedPaired();
  const plist = conn.unitPaths().launchd;
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, 'stale');
  const code = await main(['hub.example.com'], { ...s.deps, pair: stubPair(s) });
  assert.equal(code, 0, s.err.join('\n'));
  assert.deepEqual(s.pairs, [], 'never pairs');
  assert.match(fs.readFileSync(plist, 'utf8'), /<string>connect<\/string>/, 'rewritten');
  assert.deepEqual(s.calls.map((a) => a[1]), ['bootout', 'bootstrap']);

  s.calls.length = 0;
  const again = await main(['https://hub.example.com', '--re-pair'], { ...s.deps, pair: stubPair(s) });
  assert.equal(again, 0, s.err.join('\n'));
  assert.equal(s.pairs.length, 1);
  assert.equal(s.pairs[0].rePair, true);
  assert.deepEqual(s.calls.map((a) => a[1]), ['bootout', 'bootstrap']);
});

test('the wait: last_reported.at written 200 ms after the start ends it and prints the status; none within the (shortened) wait says so and exits 0', async (t) => {
  const s = sandbox(t);
  seedPaired();
  const started = Date.now();
  const timer = setTimeout(() => {
    conn.updateRecord(HUB, (r) => ({ ...r, last_reported: { connector_version: '0.9.0-alpha.7', install_kind: 'managed', claude_code_version: null, at: Date.now() } }));
  }, 200);
  t.after(() => clearTimeout(timer));
  const code = await main(['https://hub.example.com'], { ...s.deps, waitMs: 10000 });
  assert.equal(code, 0, s.err.join('\n'));
  assert.ok(Date.now() - started < 5000, 'the hello ended the wait');
  const text = s.out.join('\n');
  assert.match(text, /Connected: the hub acknowledged/);
  assert.match(text, /^Connector: hub hub-test /m, 'the status row');
  assert.match(text, /last reported: connector 0\.9\.0-alpha\.7/);

  // A last_reported from before this start does not count.
  const s2out = [];
  const code2 = await main(['https://hub.example.com'], { ...s.deps, out: (l) => s2out.push(l), waitMs: 250 });
  assert.equal(code2, 0);
  assert.match(s2out.join('\n'), /not connected yet \(the service keeps trying\)/);
  assert.match(s2out.join('\n'), /^Connector: hub hub-test /m);
});

test('no tmux on the captured PATH: the brew install tmux sentence and the run continues; a stub tmux prints none', async (t) => {
  const s = sandbox(t);
  seedPaired();
  assert.equal(await main(['https://hub.example.com'], s.deps), 0);
  assert.match(s.out.join('\n'), /tmux is not on the PATH the connector runs with: install it with `brew install tmux`/);
  assert.equal(s.calls.length, 2, 'the run went on');

  const s2 = sandbox(t, { tmux: true });
  seedPaired();
  assert.equal(await main(['https://hub.example.com'], s2.deps), 0);
  assert.doesNotMatch(s2.out.join('\n'), /tmux/);
});

// ── the workdir (C-06.18) ──────────────────────────────────────────────────

test('--workdir: refused inside ~/.web-chat or an offered folder; otherwise recorded and made 0700', async (t) => {
  const s = sandbox(t);
  const inside = path.join(s.home, '.web-chat', 'work');
  assert.equal(await main(['https://hub.example.com', '--workdir', inside], { ...s.deps, pair: stubPair(s) }), 2);
  assert.match(s.err.join('\n'), /outside ~\/\.web-chat/);
  assert.deepEqual(s.pairs, []);

  // An offered folder on another hub's record (the only way one exists before a pairing).
  const offered = path.join(s.home, 'proj');
  fs.mkdirSync(offered);
  const other = conn.newRecord({ hubId: 'hub-other', origin: 'https://other.example.com' });
  other.folders = [{ id: 'f_0123456789abcdef', path: offered, display: '~/proj', access: 'read-write', offered_at: 1 }];
  conn.writeRecord(other);
  assert.equal(await main(['https://hub.example.com', '--workdir', path.join(offered, 'w')], { ...s.deps, pair: stubPair(s) }), 2);
  assert.match(s.err.join('\n'), /inside an offered folder/);
  assert.deepEqual(s.pairs, []);
  fs.rmSync(userPaths().connectorRecord('hub-other'));

  const wd = path.join(s.home, 'hub-work');
  assert.equal(await main(['https://hub.example.com', '--workdir', wd], { ...s.deps, pair: stubPair(s) }), 0, s.err.join('\n'));
  assert.equal(s.pairs[0].workdir, wd);
  assert.equal(readRec().workdir, wd);
  assert.equal(modeOf(wd), 0o700);
});

// C-06.5 (2): "pair when the record is absent or not `paired`" — a pending
// record (a pairing that expired) and a revoked one each pair again without
// --re-pair, then write the unit and start it.
for (const state of ['pending', 'revoked']) {
  test(`a ${state} record for this hub pairs again with no --re-pair, then writes the unit and starts it`, async (t) => {
    const s = sandbox(t);
    const r = conn.newRecord({ hubId: HUB, origin: 'https://hub.example.com' });
    r.credential = state === 'pending'
      ? { state, algorithm: 'ed25519', public_key: 'A'.repeat(43), fingerprint: `SHA256:${'A'.repeat(43)}` }
      : { state };
    conn.writeRecord(r);
    const code = await main(['https://hub.example.com'], { ...s.deps, pair: stubPair(s) });
    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(s.pairs.length, 1, 'pair() once');
    assert.equal(s.pairs[0].rePair, false);
    assert.equal(readRec().credential.state, 'paired');
    assert.deepEqual(s.calls.map((a) => a[1]), ['bootout', 'bootstrap']);
  });
}

// ── the arguments ──────────────────────────────────────────────────────────

test('a unix: or ws+unix: address is refused at parsing with the usage line (exit 2); a stray option too', async (t) => {
  for (const url of ['unix:/var/run/hub.sock', 'ws+unix:/var/run/hub.sock:/connector']) {
    const s = sandbox(t);
    const code = await main([url], { ...s.deps, pair: stubPair(s) });
    assert.equal(code, 2, url);
    assert.match(s.err.join('\n'), /unix: socket address is not supported/);
    assert.match(s.err.join('\n'), /usage: claude-web-chat connect <hub-url>/);
    assert.deepEqual(s.pairs, []);
  }
  const s = sandbox(t);
  assert.equal(await main(['https://hub.example.com', '--bogus'], { ...s.deps, pair: stubPair(s) }), 2);
  assert.equal(await main(['pair'], { ...s.deps, pair: stubPair(s) }), 2, 'no hub');
  assert.deepEqual(s.pairs, []);
  // The row's match(): an https URL or a bare host; another scheme is left to the table.
  assert.equal(install.looksLikeHub('https://hub.example.com'), true);
  assert.equal(install.looksLikeHub('hub.example.com:8443'), true);
  assert.equal(install.looksLikeHub('localhost:9'), true);
  assert.equal(install.looksLikeHub('status'), false);
  assert.equal(install.looksLikeHub('probe://hub'), false);
  assert.equal(install.looksLikeHub('--json'), false);
});

test('the help lists the three rows', async (t) => {
  const s = sandbox(t);
  assert.equal(await main(['help'], s.deps), 0);
  const help = s.out.join('\n');
  assert.match(help, /claude-web-chat connect <hub-url> \[--workdir <dir>\] \[--re-pair\] \[--json\] \[--insecure-loopback\]/);
  assert.match(help, /claude-web-chat connect run \[--insecure-loopback\]/);
  assert.match(help, /claude-web-chat connect rotate \[--no-wait\]/);
});

// ── pairing for a supervisor with no TTY (swc-25 Q1, hand fold 4 (a)) ──────

async function fakeHub(t, opts = {}) {
  const fake = await withFakeHub(t, { pollAfterMs: 10, pollHoldMs: 50, ...opts });
  assert.ok(!isReservedPort(fake.port), `the fake's port ${fake.port} is outside the reserved band`);
  assert.ok(fake.port !== 5170 && fake.port !== 5171 && !(fake.port >= 5173 && fake.port <= 5272));
  return fake;
}

test('--insecure-loopback with the fake: ONE stdout line with the code and the fingerprint, then `bound <machine_id> <name>`, exit 0', async (t) => {
  const s = sandbox(t, { kind: null, platform: 'freebsd' });
  const fake = await fakeHub(t);
  const done = main([fake.url, '--insecure-loopback'], s.deps);
  const code = await waitUntil(() => { const m = s.out.length && LINE_RE.exec(s.out[0]); return m && m[1]; }, { timeout: 5000, what: 'the pairing line' });
  assert.equal(s.out.length, 1, 'one line when the pairing starts');
  assert.equal(fake.pairing.confirm(code, { name: 'Studio Mac' }).ok, true);
  assert.equal(await done, 0, s.err.join('\n'));
  const m = LINE_RE.exec(s.out[0]);
  const rec = readRec();
  assert.equal(m[2], rec.credential.fingerprint);
  assert.ok(Number.isFinite(Date.parse(m[3])));
  assert.equal(s.out[1], `bound ${rec.machine.id} Studio Mac`);
  assert.equal(s.out.filter((l) => l.includes(code)).length, 1, 'the code is printed once');
  assert.equal(rec.hub.origin, fake.url, 'a loopback http record says so in its origin');
  assert.ok(!JSON.stringify(rec).includes('insecure'), 'the flag is never written');
  assert.equal(rec.credential.state, 'paired');
});

test('--json: the pairing event line and the bound event line; human prose goes to stderr', async (t) => {
  const s = sandbox(t, { kind: null, platform: 'freebsd' });
  const fake = await fakeHub(t);
  const done = main([fake.url, '--insecure-loopback', '--json'], s.deps);
  const ev = await waitUntil(() => { try { return s.out.length && JSON.parse(s.out[0]); } catch { return null; } }, { timeout: 5000, what: 'the json line' });
  assert.deepEqual(Object.keys(ev).sort(), ['code', 'event', 'expires_at', 'fingerprint', 'hub_id', 'pairing_id']);
  assert.equal(ev.event, 'pairing');
  assert.equal(ev.hub_id, HUB);
  assert.match(ev.pairing_id, /^pr_/);
  assert.ok(Number.isInteger(ev.expires_at));
  fake.pairing.confirm(ev.code, { name: 'Studio Mac' });
  assert.equal(await done, 0, s.err.join('\n'));
  for (const l of s.out) assert.doesNotThrow(() => JSON.parse(l), `stdout holds JSON lines only: ${l}`);
  const bound = JSON.parse(s.out[1]);
  assert.equal(bound.event, 'bound');
  assert.equal(bound.machine_name, 'Studio Mac');
  assert.match(bound.machine_id, /^mch_/);
  assert.match(s.err.join('\n'), /^Connector: hub hub-test /m, 'the status on stderr');
});

// ── --pair-only (A-06.4: C-06.5's steps (1) and (2), then stop) ─────────────

// The closing sentence as A-06.4's C-06.5 words it: it names the foreground
// `connect run` and `connect <hub-url>` without the flag; a plain-http
// loopback record names `connect run --insecure-loopback` only.
const PAIR_ONLY_HTTPS = (origin) => 'Paired; no service installed: run `claude-web-chat connect run` to run the connector in the foreground, '
  + `or \`claude-web-chat connect ${origin}\` to install the start-at-login service later.`;
const PAIR_ONLY_LOOPBACK = 'Paired; no service installed: run `claude-web-chat connect run --insecure-loopback` to run the connector in the foreground.';

// The record's `service` as it was, and every service-manager trace: no
// unit, no log, no call.
function assertNoService(s, serviceBefore) {
  assert.deepEqual(s.calls, [], 'no service manager call');
  assert.equal(fs.existsSync(conn.unitPaths().launchd), false, 'no LaunchAgent');
  assert.equal(fs.existsSync(conn.unitPaths()['systemd-user']), false, 'no systemd unit');
  assert.equal(fs.existsSync(userPaths().connectorLog), false, 'no connector log pre-created');
  assert.deepEqual(readRec().service, serviceBefore, 'the record\'s service as it was');
}

test('--pair-only pairs and installs nothing: no unit, no service-manager call, `service` unchanged, the closing sentence, exit 0', async (t) => {
  for (const [kind, platform] of [['launchd', 'darwin'], ['systemd-user', 'linux'], [null, 'freebsd']]) {
    const s = sandbox(t, { kind, platform });
    let captured = 0;
    const code = await main(['https://hub.example.com', '--pair-only'], {
      ...s.deps, pair: stubPair(s), capturePathEnv: () => { captured += 1; return { pathEnv: '/x', tmux: false }; },
    });
    assert.equal(code, 0, s.err.join('\n'));
    assert.equal(s.pairs.length, 1, 'pair() once');
    assert.equal(captured, 0, 'no PATH captured');
    assertNoService(s, undefined);
    assert.equal(s.out[0], `bound mch_${'0'.repeat(26)} Studio Mac`, 'the bound line as without the flag');
    assert.equal(s.out[s.out.length - 1], PAIR_ONLY_HTTPS('https://hub.example.com'), kind);
    assert.equal(s.out.length, 2, 'the bound line and the sentence, no status');
    assert.doesNotMatch(s.out.join('\n'), /tmux|Start at login|start at login is unavailable/);
  }
});

test('--pair-only --json: the bound event, then exactly ONE closing event, its ids with the bound event\'s names', async (t) => {
  const s = sandbox(t);
  const code = await main(['https://hub.example.com', '--pair-only', '--json'], { ...s.deps, pair: stubPair(s) });
  assert.equal(code, 0, s.err.join('\n'));
  assertNoService(s, undefined);
  assert.equal(s.out.length, 2);
  const bound = JSON.parse(s.out[0]);
  const last = JSON.parse(s.out[1]);
  assert.equal(bound.event, 'bound');
  assert.deepEqual(last, { event: 'service', kind: null, pair_only: true, hub_id: HUB, machine_id: `mch_${'0'.repeat(26)}` });
  assert.deepEqual(Object.keys(last), ['event', 'kind', 'pair_only', 'hub_id', 'machine_id'], 'A-06.4\'s order');
  assert.equal(last.hub_id, bound.hub_id);
  assert.equal(last.machine_id, bound.machine_id);
  assert.equal(last.machine_id, readRec().machine.id);
  assert.equal(last.hub_id, readRec().hub.id);
});

test('--pair-only on a record already paired, no --re-pair: no pairing, only the closing sentence (or event), exit 0; a running unit is left alone', async (t) => {
  const s = sandbox(t);
  seedPaired();
  const service = { kind: 'launchd', label: LABEL, unit_path: conn.unitPaths().launchd, path_env: '/usr/bin:/bin', installed_at: 1 };
  conn.updateRecord(HUB, (r) => ({ ...r, service }));
  const plist = conn.unitPaths().launchd;
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, 'running unit');
  const recBefore = fs.readFileSync(userPaths().connectorRecord(HUB));
  const code = await main(['https://hub.example.com', '--pair-only'], { ...s.deps, pair: stubPair(s) });
  assert.equal(code, 0, s.err.join('\n'));
  assert.deepEqual(s.pairs, [], 'no pairing');
  assert.deepEqual(s.out, [PAIR_ONLY_HTTPS('https://hub.example.com')], 'only the closing sentence');
  assert.deepEqual(s.calls, [], 'no service manager call');
  assert.equal(fs.readFileSync(plist, 'utf8'), 'running unit', 'the unit untouched');
  assert.ok(fs.readFileSync(userPaths().connectorRecord(HUB)).equals(recBefore), 'the record byte-identical');

  const s2 = sandbox(t);
  seedPaired();
  assert.equal(await main(['hub.example.com', '--json', '--pair-only'], { ...s2.deps, pair: stubPair(s2) }), 0);
  assert.equal(s2.out.length, 1, 'the only line');
  assert.deepEqual(JSON.parse(s2.out[0]), { event: 'service', kind: null, pair_only: true, hub_id: HUB, machine_id: `mch_${'0'.repeat(26)}` });
  assert.deepEqual(s2.pairs, []);
});

test('--pair-only on a paired record with no machine: machine_id is null', async (t) => {
  const s = sandbox(t);
  seedPaired();
  conn.updateRecord(HUB, (r) => { const { machine, ...rest } = r; return rest; });
  assert.equal(readRec().machine, undefined);
  assert.equal(await main(['https://hub.example.com', '--pair-only', '--json'], s.deps), 0, s.err.join('\n'));
  assert.deepEqual(JSON.parse(s.out[0]), { event: 'service', kind: null, pair_only: true, hub_id: HUB, machine_id: null });
});

test('--pair-only --re-pair over a record whose unit is running: pairs once, replaces the key on bound, restarts nothing', async (t) => {
  const s = sandbox(t);
  seedPaired();
  const service = { kind: 'launchd', label: LABEL, unit_path: conn.unitPaths().launchd, path_env: '/usr/bin:/bin', installed_at: 1 };
  conn.updateRecord(HUB, (r) => ({ ...r, service }));
  const keyBefore = fs.readFileSync(userPaths().connectorKey(HUB), 'utf8');
  // The stub pairs as pair() does: a new key through the one writer, and the
  // record's service kept (pair() never touches it).
  const rePair = async (opts) => {
    s.pairs.push(opts);
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    conn.writeMachineKey({
      hubId: HUB,
      pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      update: (r) => ({ ...r, credential: { state: 'paired', algorithm: 'ed25519', paired_at: Date.now() } }),
    });
    return { ok: true, state: 'paired', hubId: HUB, machineId: `mch_${'0'.repeat(26)}`, keyId: 'mky_x' };
  };
  const code = await main(['https://hub.example.com', '--pair-only', '--re-pair'], { ...s.deps, pair: rePair });
  assert.equal(code, 0, s.err.join('\n'));
  assert.equal(s.pairs.length, 1);
  assert.equal(s.pairs[0].rePair, true);
  assert.notEqual(fs.readFileSync(userPaths().connectorKey(HUB), 'utf8'), keyBefore, 'the key replaced');
  assert.deepEqual(s.calls, [], 'nothing restarted');
  assert.deepEqual(readRec().service, service, 'the service as it was');
  assert.match(s.out[0], /^bound mch_/);
  assert.equal(s.out[1], PAIR_ONLY_HTTPS('https://hub.example.com'));
});

test('--pair-only --insecure-loopback with the fake: the pairing line, bound, then the sentence naming `connect run --insecure-loopback` only', async (t) => {
  const s = sandbox(t);
  const fake = await fakeHub(t);
  const done = main([fake.url, '--insecure-loopback', '--pair-only'], s.deps);
  const code = await waitUntil(() => { const m = s.out.length && LINE_RE.exec(s.out[0]); return m && m[1]; }, { timeout: 5000, what: 'the pairing line' });
  assert.equal(fake.pairing.confirm(code, { name: 'Studio Mac' }).ok, true);
  assert.equal(await done, 0, s.err.join('\n'));
  assertNoService(s, undefined);
  const rec = readRec();
  assert.equal(rec.credential.state, 'paired');
  assert.equal(rec.hub.origin, fake.url);
  assert.ok(fs.existsSync(userPaths().connectorKey(HUB)), 'the key written');
  assert.equal(s.out.length, 3);
  assert.equal(s.out[1], `bound ${rec.machine.id} Studio Mac`);
  assert.equal(s.out[2], PAIR_ONLY_LOOPBACK);
  assert.doesNotMatch(s.out[2], /connect http/, 'no install advice: a unit runs `connect run` without the flag');
  assert.ok(!JSON.stringify(rec).includes('pair_only') && !JSON.stringify(rec).includes('insecure'), 'neither flag is written');
});

test('--pair-only keeps step (1)\'s refusals: an unmanaged install and a missing ~/.local/bin link refuse before pairing', async (t) => {
  const s = sandbox(t, { installKind: 'dev' });
  assert.equal(await main(['https://hub.example.com', '--pair-only'], { ...s.deps, pair: stubPair(s) }), 1);
  assert.deepEqual(s.pairs, []);
  const s2 = sandbox(t, { link: false });
  assert.equal(await main(['https://hub.example.com', '--pair-only'], { ...s2.deps, pair: stubPair(s2) }), 1);
  assert.match(s2.err.join('\n'), /~\/\.local\/bin is missing/);
  assert.deepEqual(s2.pairs, []);
  // A failed pairing keeps its exit code and prints no closing sentence.
  const s3 = sandbox(t);
  assert.equal(await main(['https://hub.example.com', '--pair-only'], { ...s3.deps, pair: stubPair(s3, { answer: { ok: false, reason: 'refused', message: 'no' } }) }), 4);
  assert.doesNotMatch(s3.out.join('\n'), /Paired; no service/);
});

test('the usage line names --pair-only', async (t) => {
  assert.match(install.USAGE, /\[--pair-only\]/);
  const s = sandbox(t);
  assert.equal(await main(['https://hub.example.com', '--bogus'], s.deps), 2);
  assert.match(s.err.join('\n'), /usage: claude-web-chat connect <hub-url> .*\[--pair-only\]/);
});

test('exit 3 when the code expires, 4 when the hub refuses (the hub\'s word in the line)', async (t) => {
  const s = sandbox(t, { kind: null, platform: 'freebsd' });
  const fake = await fakeHub(t, { codeTtlMs: 300 });
  const expired = await main([fake.url, '--insecure-loopback'], s.deps);
  assert.equal(expired, 3);
  assert.match(s.out[s.out.length - 1], /^expired · /);

  const s2 = sandbox(t, { kind: null, platform: 'freebsd' });
  const fake2 = await fakeHub(t);
  const done = main([fake2.url, '--insecure-loopback'], s2.deps);
  const code = await waitUntil(() => { const m = s2.out.length && LINE_RE.exec(s2.out[0]); return m && m[1]; }, { timeout: 5000, what: 'the pairing line' });
  await fake2.waitFor('pairing.poll_request');
  assert.equal(fake2.pairing.refuse(code).ok, true);
  assert.equal(await done, 4);
  assert.match(s2.out[s2.out.length - 1], /^refused · /);
});

test('the flag admits loopback only: a non-loopback http host refuses before any dial; without it a loopback http host refuses (C-05.4)', async (t) => {
  const s = sandbox(t);
  const dials = [];
  const deps = { ...s.deps, request: async (url) => { dials.push(url); throw new Error('no dial'); } };
  assert.equal(await main(['http://10.0.0.5:8080', '--insecure-loopback'], deps), 2);
  assert.match(s.err.join('\n'), /--insecure-loopback is for a hub on this machine's loopback/);
  assert.equal(await main(['https://hub.example.com', '--insecure-loopback'], deps), 2);
  assert.equal(await main(['http://127.0.0.1:9', '--insecure-loopback'], { ...deps, pair: stubPair(s, { answer: { ok: false, reason: 'unreachable', message: 'no' } }) }), 1);
  assert.equal(s.pairs.length, 1, 'loopback with the flag reaches pairing');
  assert.equal(await main(['http://127.0.0.1:9'], deps), 2);
  assert.match(s.err.join('\n'), /must be reached over https/);
  assert.deepEqual(dials, [], 'nothing dialled');
  assert.equal(fs.existsSync(userPaths().connectorDir), false, 'nothing written');
});

// LOOPBACK@ipv6 (a): the build admits 127.0.0.1 and localhost only (hubOrigin
// never takes a bracketed IPv6 literal), and its words say so.
test('the loopback refusals name 127.0.0.1 or localhost and never ::1; http://[::1]:8477 is still refused, by a sentence that claims nothing for ::1', async (t) => {
  const s = sandbox(t);
  const deps = { ...s.deps, request: async () => { throw new Error('no dial'); }, pair: stubPair(s) };
  assert.equal(await main(['http://10.0.0.5:8080', '--insecure-loopback'], deps), 2);
  const refusal = s.err.find((l) => /--insecure-loopback is for/.test(l));
  assert.equal(refusal, 'connect: --insecure-loopback is for a hub on this machine\'s loopback (127.0.0.1 or localhost) only');
  assert.doesNotMatch(refusal, /::1/);

  s.err.length = 0;
  assert.equal(await main(['http://[::1]:8477', '--insecure-loopback'], deps), 2);
  assert.deepEqual(s.pairs, [], 'never reaches pairing');
  assert.doesNotMatch(s.err.join('\n'), /::1/, 'no sentence names ::1');
  assert.match(s.err.join('\n'), /^connect: /m);

  const s2 = sandbox(t);
  seedPaired();
  assert.equal(await runMod.run(['--insecure-loopback'], runDeps(s2, { createLink: () => assert.fail('no dial') })), 2);
  const runRefusal = s2.err.find((l) => /--insecure-loopback is for/.test(l));
  assert.equal(runRefusal, 'connect run: --insecure-loopback is for a hub on this machine\'s loopback (127.0.0.1 or localhost) only');
});

test('no message or comment of the connector says ::1 is admitted, or that the CLI never passes --insecure-loopback', () => {
  const root = path.join(__dirname, '..', 'lib');
  const files = [
    ...fs.readdirSync(path.join(root, 'connector')).filter((n) => n.endsWith('.js')).map((n) => path.join(root, 'connector', n)),
    path.join(root, 'setup', 'connector.js'),
  ];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/::1/.test(text), `${f} names ::1`);
    assert.ok(!/CLI\s+never\s+(?:\/\/\s*)?(?:passes|does)/.test(text), `${f} says the CLI never passes the flag`);
  }
  // And the build is as it was: hubOrigin refuses a bracketed literal.
  assert.throws(() => conn.hubOrigin('http://[::1]:8477', { insecureLoopback: true }), (e) => e.code === 'EHUBORIGIN');
  assert.equal(conn.hubOrigin('http://LOCALHOST:8477/', { insecureLoopback: true }), 'http://localhost:8477');
});

test('`connect https://hub-int.test:8444`: the proof signs the host with its port; the record\'s origin carries :8444', async (t) => {
  const s = sandbox(t);
  const seen = [];
  const request = async (url, opts) => {
    seen.push({ url, body: opts.body });
    if (url.endsWith('/connector/pair')) {
      const raw = Buffer.from(opts.body.public_key, 'base64url');
      return {
        status: 200,
        headers: {},
        json: {
          ok: true, pairing_id: `pr_${'1'.repeat(26)}`, code: 'ABCD-EFGH', expires_at: Date.now() + 300000,
          poll_after_ms: 10, fingerprint: conn.fingerprintOf(raw), hub_id: 'hub-int-test',
        },
      };
    }
    return { status: 200, headers: {}, json: { state: 'expired' } };
  };
  const code = await main(['https://hub-int.test:8444'], { ...s.deps, request });
  assert.equal(code, 3);
  assert.equal(seen[0].url, 'https://hub-int.test:8444/connector/pair');
  const start = seen[0].body;
  const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: start.public_key }, format: 'jwk' });
  assert.ok(crypto.verify(null, Buffer.from(`web-chat-connector-pair/1\nhub-int.test:8444\n${start.client_nonce}`), pub, Buffer.from(start.proof, 'base64url')));
  const poll = seen.find((r) => r.url.endsWith('/connector/pair/poll')).body;
  assert.ok(crypto.verify(null, Buffer.from(`web-chat-connector-pair-poll/1\nhub-int.test:8444\n${poll.pairing_id}\n${poll.ts}`), pub, Buffer.from(poll.proof, 'base64url')));
  const rec = conn.readRecord('hub-int-test');
  assert.equal(rec.value.hub.origin, 'https://hub-int.test:8444');
  assert.equal(new URL(rec.value.hub.origin).host, 'hub-int.test:8444');
  assert.match(s.out[0], /^pairing code ABCD-EFGH · fingerprint SHA256:[A-Za-z0-9+/]{43} · expires /);
  assert.match(s.out[s.out.length - 1], /^expired · /);
});

test('TLS: the pairing request leaves Node\'s default trust (no ca, no rejectUnauthorized), so NODE_EXTRA_CA_CERTS applies', async (t) => {
  const s = sandbox(t);
  const options = [];
  const real = https.request;
  https.request = (url, opts) => {
    options.push({ url: String(url), ...opts });
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.write = () => true;
    req.end = () => { process.nextTick(() => req.emit('error', Object.assign(new Error('stub'), { code: 'ECONNREFUSED' }))); };
    req.destroy = () => {};
    return req;
  };
  t.after(() => { https.request = real; });
  const code = await main(['https://hub-int.test:8444'], { ...s.deps, request: outbound.request });
  assert.equal(code, 1);
  assert.equal(options.length, 1);
  const o = options[0];
  assert.equal(o.url, 'https://hub-int.test:8444/connector/pair');
  for (const k of ['ca', 'rejectUnauthorized', 'agent', 'checkServerIdentity', 'secureContext']) {
    assert.ok(!(k in o), `no ${k} on the request`);
  }
  // And nothing in the connector, the outbound requester or the link relaxes it.
  const files = [
    path.join(__dirname, '..', 'lib', 'util', 'outbound.js'),
    ...fs.readdirSync(path.join(__dirname, '..', 'lib', 'connector')).map((n) => path.join(__dirname, '..', 'lib', 'connector', n)),
  ];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|\bca\s*:/, f);
  }
});

// ── connect run ────────────────────────────────────────────────────────────

// A stub link: an emitter with the link's surface.
function stubLink() {
  const link = new EventEmitter();
  link.started = 0;
  link.stopped = 0;
  link.start = () => { link.started += 1; return true; };
  link.stop = async () => { link.stopped += 1; };
  link.checkRotateRequest = () => false;
  link.factsChanged = () => {};
  // What the rest of the composition (U790) registers on the link: channels,
  // sends, the stream table and the secrets it must never send.
  link.channels = [];
  link.channel = (ch, spec) => { link.channels.push({ ch, kinds: spec.kinds }); return () => {}; };
  link.send = () => null;
  link.request = async () => { throw Object.assign(new Error('down'), { code: 'ELINKDOWN' }); };
  link.registerSecret = () => () => {};
  link.state = 'connecting';
  link.streams = { open: () => ({ ok: false, reason: 'not_up' }), close() {}, has: () => false, count: () => 0, countFor: () => 0, credit: () => 0, sendCredit: async () => {}, receive: () => false, grant() {} };
  return link;
}

// createFacts with no program run (no claude, no tailscale).
const quietFacts = (opts) => factsMod.createFacts({
  ...opts,
  runClaude: async () => ({ ok: true, stdout: '2.1.300 (Claude Code)\n' }),
  exec: { findProgram: () => null, isExecutable: () => false, run: async () => ({ ok: false }) },
  toolNames: () => ({ mcp_servers: [], skills: [] }),
  platform: 'linux',
});

function runDeps(s, extra = {}) {
  return { ...s.deps, createFacts: quietFacts, ...extra };
}

for (const state of ['unpaired', 'pending', 'revoked']) {
  test(`connect run: a ${state} record exits 0 with a sentence and never dials`, async (t) => {
    const s = sandbox(t);
    const r = conn.newRecord({ hubId: HUB, origin: 'https://hub.example.com' });
    r.credential = state === 'pending'
      ? { state, algorithm: 'ed25519', public_key: 'A'.repeat(43), fingerprint: `SHA256:${'A'.repeat(43)}` }
      : { state };
    conn.writeRecord(r);
    const code = await runMod.run([], runDeps(s, { createLink: () => assert.fail('no dial') }));
    assert.equal(code, 0);
    assert.match(s.out.join('\n'), state === 'revoked' ? /was revoked/ : /not paired yet/);
    assert.equal(registry.readAllEntries().some((e) => e.role === 'connector'), false);
  });
}

test('connect run: no record exits 0; a record a newer build wrote refuses naming that build, exit 0', async (t) => {
  const s = sandbox(t);
  assert.equal(await runMod.run([], runDeps(s, { createLink: () => assert.fail('no dial') })), 0);
  assert.match(s.out.join('\n'), /not paired/);
  conn.ensureConnectorDir();
  const r = conn.newRecord({ hubId: HUB, origin: 'https://hub.example.com' });
  fs.writeFileSync(userPaths().connectorRecord(HUB), JSON.stringify({ ...r, v: 2, last_reported: { connector_version: '1.2.0', at: 1 } }));
  assert.equal(await runMod.run([], runDeps(s, { createLink: () => assert.fail('no dial') })), 0);
  assert.match(s.out.join('\n'), /record is version 2, written by claude-web-chat 1\.2\.0; this build reads version 1/);
});

test('connect run: a plain-http loopback record runs only with --insecure-loopback; the flag with an https record refuses', async (t) => {
  const s = sandbox(t);
  seedPaired({ origin: 'http://127.0.0.1:9' });
  assert.equal(await runMod.run([], runDeps(s, { createLink: () => assert.fail('no dial') })), 0);
  assert.match(s.out.join('\n'), /only with --insecure-loopback/);
  const s2 = sandbox(t);
  seedPaired();
  assert.equal(await runMod.run(['--insecure-loopback'], runDeps(s2, { createLink: () => assert.fail('no dial') })), 2);
  assert.equal(await runMod.run(['--bogus'], runDeps(s2, { createLink: () => assert.fail('no dial') })), 2);
});

test('connect run\'s advice for a plain-http loopback record names --insecure-loopback: revoked, not paired yet, the key missing', async (t) => {
  const origin = 'http://127.0.0.1:9';
  for (const state of ['revoked', 'pending']) {
    const s = sandbox(t);
    const r = conn.newRecord({ hubId: HUB, origin });
    r.credential = state === 'pending'
      ? { state, algorithm: 'ed25519', public_key: 'A'.repeat(43), fingerprint: `SHA256:${'A'.repeat(43)}` }
      : { state };
    conn.writeRecord(r);
    assert.equal(await runMod.run([], runDeps(s, { createLink: () => assert.fail('no dial') })), 0);
    assert.match(s.out.join('\n'), new RegExp(`\`claude-web-chat connect ${origin.replace(/\./g, '\\.')} --insecure-loopback\``), state);
  }
  const s = sandbox(t);
  seedPaired({ origin });
  fs.rmSync(userPaths().connectorKey(HUB));
  assert.equal(await runMod.run(['--insecure-loopback'], runDeps(s, { createLink: () => assert.fail('no dial') })), 0);
  assert.match(s.out.join('\n'), /`claude-web-chat connect http:\/\/127\.0\.0\.1:9 --re-pair --insecure-loopback`/);
  // An https record's advice is as it was.
  const s2 = sandbox(t);
  const r = conn.newRecord({ hubId: HUB, origin: 'https://hub.example.com' });
  r.credential = { state: 'revoked' };
  conn.writeRecord(r);
  assert.equal(await runMod.run([], runDeps(s2, { createLink: () => assert.fail('no dial') })), 0);
  assert.match(s2.out.join('\n'), /run `claude-web-chat connect https:\/\/hub\.example\.com` to pair again/);
});

test('connect run on a revocation prints the hub\'s hint ONCE as "connect run: the hub says: <hint>"; no hint, no line', async (t) => {
  for (const hint of ['Disconnected in Settings > Machines.', null]) {
    const s = sandbox(t);
    seedPaired();
    const link = stubLink();
    const done = runMod.run([], runDeps(s, {
      createLink: () => link,
      disconnectLocal: async () => ({ ok: true }),
    }));
    await waitUntil(() => link.started === 1, { what: 'the link started' });
    link.emit('revoked', { afterNotice: true, hint });
    link.emit('revoked', { afterNotice: true, hint });
    assert.equal(await done, 0);
    const says = s.out.filter((l) => l.startsWith('connect run: the hub says: '));
    assert.deepEqual(says, hint ? [`connect run: the hub says: ${hint}`] : [], String(hint));
  }
});

test('connect run reads the machine key only from the connector\'s own directory (C-06.7): a key_file elsewhere exits 0 and never dials', async (t) => {
  const s = sandbox(t);
  seedPaired();
  const elsewhere = path.join(s.home, 'elsewhere.pem');
  fs.copyFileSync(userPaths().connectorKey(HUB), elsewhere);
  fs.chmodSync(elsewhere, 0o600);
  conn.updateRecord(HUB, (r) => ({ ...r, credential: { ...r.credential, key_file: elsewhere } }));
  assert.equal(readRec().credential.key_file, elsewhere);
  const code = await runMod.run([], runDeps(s, { createLink: () => assert.fail('no dial with a key outside the connector directory') }));
  assert.equal(code, 0);
  assert.match(s.out.join('\n'), /machine key is missing or unreadable/);
  assert.equal(registry.readAllEntries().some((e) => e.role === 'connector'), false);
});

test('connect run composes the link: versions and facts from lib/connector/facts.js, the route table, onSettings = lifecycle.applySettings, heartbeatBody from the signals rows (U790)', async (t) => {
  const s = sandbox(t);
  seedPaired();
  let holder = null;
  let lifecycle = null;
  let opts = null;
  const link = stubLink();
  const done = runMod.run([], runDeps(s, {
    createFacts: (o) => { holder = quietFacts(o); return holder; },
    createLifecycle: (o) => { lifecycle = lifecycleMod.createLifecycle(o); return lifecycle; },
    createLink: (o) => { opts = o; return link; },
  }));
  await waitUntil(() => link.started === 1, { what: 'the link started' });
  assert.strictEqual(opts.versions, holder.versions, 'versions from the facts holder');
  assert.strictEqual(opts.facts, holder.facts, 'facts from the facts holder');
  assert.equal(opts.versions().kind, 'versions');
  assert.equal(opts.versions().claude_code_version, '2.1.300');
  assert.deepEqual(opts.routeTable(), { table_version: TABLE_VERSION, sha256: TABLE_SHA256 });
  assert.strictEqual(opts.onSettings, lifecycle.applySettings);
  // U790 (U726-U716@link-composition-inputs (a)): U729's heartbeatBody — the
  // minimal body plus the signals' chat rows (none tracked here).
  const beat = opts.heartbeatBody({ machine_id: 'mch_x', beat: 1, interval_ms: 15000, connector_now: 1 });
  assert.equal(beat.type, 'heartbeat');
  assert.deepEqual(beat.chats, []);
  assert.deepEqual(link.channels.map((c) => c.ch).sort(), ['control', 'events', 'queue', 'relay'], 'the relay, ring, delivery and chats channels');
  assert.equal(opts.record.hub.id, HUB);
  assert.equal(opts.key.type, 'private');
  assert.equal(opts.key.asymmetricKeyType, 'ed25519');
  s.deps.signals.emit('SIGTERM');
  assert.equal(await done, 0);
});

test('connect run: the port-less connector role, last_reported after hello.ack, and SIGTERM releases holds, deregisters and exits 0', async (t) => {
  const s = sandbox(t);
  const root = path.join(s.home, 'chat-root');
  fs.mkdirSync(root);
  seedPaired({ chats: [{ chat_id: '0'.repeat(26), rev: 1, scope_kind: 'space', root, owned_root: true, desired: 'running' }] });
  const link = stubLink();
  const stops = [];
  const done = runMod.run([], runDeps(s, {
    createLink: () => link,
    createLifecycle: (o) => {
      const real = lifecycleMod.createLifecycle(o);
      return { ...real, install: real.install, stop: async (chat, mode) => { stops.push({ id: chat.id, mode }); return real.stop(chat, mode); } };
    },
  }));
  await waitUntil(() => link.started === 1, { what: 'the link started' });
  const row = registry.readAllEntries().find((e) => e.role === 'connector');
  assert.ok(row, 'the connector role is registered');
  assert.equal(row.port, null);
  assert.equal(row.url, null);
  assert.equal(row.pid, process.pid);

  assert.equal(readRec().last_reported, undefined);
  const before = Date.now();
  link.emit('ready', {});
  const lr = readRec().last_reported;
  assert.ok(lr.at >= before);
  assert.equal(lr.install_kind, factsMod.installOf().kind);
  assert.equal(lr.claude_code_version, '2.1.300');
  assert.equal(typeof lr.connector_version, 'string');

  s.deps.signals.emit('SIGTERM');
  assert.equal(await done, 0);
  assert.deepEqual(stops, [{ id: '0'.repeat(26), mode: 'release' }], 'every hold released, never now');
  assert.equal(link.stopped, 1, 'the link closed');
  assert.equal(registry.readAllEntries().some((e) => e.role === 'connector'), false, 'deregistered');
  assert.ok(s.out.every((l) => !/PRIVATE|BEGIN/.test(l)), 'no key in a log line');
});

// ── against the fake hub: the dial, last_reported, `connect rotate` ────────

// A loopback TCP proxy in front of the fake that keeps each upgrade's request
// head, so the test can read the headers the connector sent.
async function headProxy(t, port) {
  const heads = [];
  const server = net.createServer((sock) => {
    const up = net.connect(port, '127.0.0.1');
    let head = '';
    let done = false;
    sock.on('data', (chunk) => {
      if (!done) {
        head += chunk.toString('latin1');
        const end = head.indexOf('\r\n\r\n');
        if (end >= 0) { done = true; heads.push(head.slice(0, end)); }
      }
    });
    sock.pipe(up);
    up.pipe(sock);
    sock.on('error', () => up.destroy());
    up.on('error', () => sock.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(() => resolve()); }));
  const p = server.address().port;
  assert.ok(!isReservedPort(p));
  return { url: `http://127.0.0.1:${p}`, heads };
}

function fakeMachine(fake, origin) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(privateKey.export({ format: 'jwk' }).x, 'base64url');
  const m = fake.addMachine({ publicKey: raw, name: 'Studio Mac' });
  seedPaired({ origin, machineId: m.id, privateKey });
  return m;
}

function startRun(t, s, extra = {}) {
  const signals = new EventEmitter();
  const done = runMod.run(['--insecure-loopback'], runDeps(s, { signals, ...extra }));
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; signals.emit('SIGTERM'); } return done; };
  t.after(stop);
  return { done, stop };
}

test('connect run against the fake: no Origin header and the web-chat-connector subprotocol on the dial; last_reported after hello.ack', async (t) => {
  const s = sandbox(t);
  const fake = await fakeHub(t);
  const proxy = await headProxy(t, fake.port);
  fakeMachine(fake, proxy.url);
  const r = startRun(t, s);
  await waitUntil(() => { const lr = readRec().last_reported; return lr && lr.at; }, { timeout: 10000, what: 'last_reported' });
  assert.ok(fake.links.length >= 1);
  assert.equal(fake.links[0].ws.protocol, 'web-chat-connector', 'the fake accepted the subprotocol');
  const head = proxy.heads.find((h) => /^GET \/connector HTTP\/1\.1/.test(h));
  assert.ok(head, 'the upgrade went through the proxy');
  assert.match(head, /^sec-websocket-protocol: web-chat-connector$/im);
  assert.doesNotMatch(head, /^origin:/im, 'no Origin header (the hub answers 403 to one)');
  assert.equal(await r.stop(), 0);
});

test('connect rotate with the connector running: exactly one key.rotate; the record\'s key id changes; the old and new ids printed', async (t) => {
  const s = sandbox(t);
  const fake = await fakeHub(t);
  const m = fakeMachine(fake, fake.url);
  const keyFile = userPaths().connectorKey(HUB);
  const before = readRec().credential;
  const pemBefore = fs.readFileSync(keyFile, 'utf8');
  const r = startRun(t, s);
  await waitUntil(() => readRec().last_reported, { timeout: 10000, what: 'the link up' });
  const out = [];
  const code = await cli.main(['rotate'], { out: (l) => out.push(l), err: (l) => out.push(l) });
  assert.equal(code, 0, out.join('\n'));
  const after = readRec().credential;
  assert.notEqual(after.key_id, before.key_id);
  assert.equal(fake.find('key.rotate', { dir: 'in' }).length, 1, 'exactly one key.rotate');
  assert.equal(fake.machine(m.id).key_id, after.key_id, 'the hub holds the new key');
  assert.deepEqual(out, [
    `old key: ${before.key_id} · fingerprint ${before.fingerprint}`,
    `new key: ${after.key_id} · fingerprint ${after.fingerprint}`,
  ]);
  assert.notEqual(fs.readFileSync(keyFile, 'utf8'), pemBefore, 'the key file holds the new key');
  assert.equal(modeOf(keyFile), 0o600);
  assert.equal(conn.readRotateRequest(HUB), null, 'the request cleared');
  assert.equal(await r.stop(), 0);
});

test('connect rotate with no connector running leaves the request; the next `connect run` honours it on its connection', async (t) => {
  const s = sandbox(t);
  const fake = await fakeHub(t);
  fakeMachine(fake, fake.url);
  const before = readRec().credential.key_id;
  const out = [];
  assert.equal(await cli.main(['rotate'], { out: (l) => out.push(l), err: (l) => out.push(l) }), 0);
  assert.deepEqual(out, ['the connector is not running; the rotation happens when `connect run` next connects']);
  assert.ok(conn.readRotateRequest(HUB), 'the request is left');
  assert.equal(readRec().credential.key_id, before);

  const r = startRun(t, s);
  await waitUntil(() => readRec().credential.key_id !== before, { timeout: 10000, what: 'the rotation on connect' });
  assert.equal(fake.find('key.rotate', { dir: 'in' }).length, 1);
  await waitUntil(() => conn.readRotateRequest(HUB) === null, { what: 'the request cleared' });
  assert.equal(await r.stop(), 0);

  // --no-wait with a connector "running": writes and returns at once.
  const out2 = [];
  assert.equal(await runMod.rotate(['--no-wait'], { out: (l) => out2.push(l), connectorRow: () => ({ pid: 1 }) }), 0);
  assert.match(out2[0], /Rotation requested/);
  assert.ok(conn.readRotateRequest(HUB));
});

test('connect rotate: not paired exits 1 and writes no request', async (t) => {
  sandbox(t);
  const out = [];
  assert.equal(await runMod.rotate([], { out: (l) => out.push(l), err: (l) => out.push(l) }), 1);
  assert.deepEqual(out, ['Connector: not paired']);
  assert.equal(fs.existsSync(userPaths().connectorDir), false);
});

test('every file the install writes is under the sandbox HOME', async (t) => {
  const s = sandbox(t);
  const tmpBefore = new Set(fs.readdirSync(os.tmpdir()));
  const code = await main(['https://hub.example.com'], { ...s.deps, pair: stubPair(s) });
  assert.equal(code, 0);
  const written = filesUnder(s.home);
  for (const f of ['Library/LaunchAgents/com.claude-web-chat.connector.plist', '.web-chat/connector/connector.log', `.web-chat/connector/${HUB}.json`]) {
    assert.ok(written.includes(f), f);
  }
  const fresh = fs.readdirSync(os.tmpdir()).filter((n) => !tmpBefore.has(n) && !s.home.endsWith(n));
  assert.deepEqual(fresh.filter((n) => /claude-web-chat|connector|LaunchAgents/.test(n)), [], 'nothing beside the HOME');
});

// ── the relay secrets a connector keeps registered (hand fold 9 C3) ────────

test('connect run keeps at most the last 8 relay secrets of a chat registered on the link and the redactor; a forgotten chat keeps none', async (t) => {
  const s = sandbox(t);
  seedPaired();
  const CHAT = '1'.repeat(26);
  const link = stubLink();
  const onLink = new Set();
  link.registerSecret = (secret) => { onLink.add(secret); return () => { onLink.delete(secret); }; };
  const known = new Set();
  let supervised = null;
  let spawns = 0;
  const current = new Map();
  const done = runMod.run([], runDeps(s, {
    createLink: () => link,
    createRedactor: () => {
      const r = require('../lib/core/redact').createRedactor();
      const add = r.addKnown;
      const remove = r.removeKnown;
      return { ...r, addKnown: (v, l) => { known.add(v); return add(v, l); }, removeKnown: (v) => { known.delete(v); return remove(v); } };
    },
    // A stub chat: every ensureRunning is a respawn with a new secret.
    createSupervisor: (o) => {
      const real = require('../lib/connector/supervisor').createSupervisor(o);
      return {
        ...real,
        ensureRunning: async (chat) => {
          spawns += 1;
          current.set(chat.id, `relay-secret-${String(spawns).padStart(4, '0')}-${'x'.repeat(40)}`);
          return { state: 'running', port: 41000 + spawns, pid: 61000 + spawns };
        },
        relayCredential: (id) => current.get(id) || null,
        forget: (id) => { current.delete(id); },
      };
    },
    createLifecycle: (o) => { supervised = o.supervisor; return lifecycleMod.createLifecycle(o); },
  }));
  // A failed assertion still ends the run (its handles would hold the file open).
  let ended = false;
  t.after(async () => { if (!ended) { s.deps.signals.emit('SIGTERM'); await done; } });
  await waitUntil(() => link.started === 1, { what: 'the link started' });
  for (let i = 0; i < 10; i++) await supervised.ensureRunning({ id: CHAT, root: s.home });
  const last8 = Array.from({ length: 8 }, (_, i) => `relay-secret-${String(i + 3).padStart(4, '0')}-${'x'.repeat(40)}`);
  assert.deepEqual([...onLink].sort(), last8, 'the link holds the last 8, the two oldest unregistered');
  assert.deepEqual([...known].sort(), last8, 'the redactor holds the same 8');
  supervised.forget(CHAT);
  assert.equal(onLink.size, 0, 'a forgotten chat keeps no secret on the link');
  assert.equal(known.size, 0, 'nor on the redactor');
  ended = true;
  s.deps.signals.emit('SIGTERM');
  assert.equal(await done, 0);
});
