'use strict';

// `claude-web-chat connect <hub-url>` — pair this machine, write the
// start-at-login unit and start it (contract 06 C-06.5 as A-06.1 words it,
// C-06.1, C-06.6, C-06.18; tranche 6, U726). One row of ./cli.js's table
// (`pair`, also taken by match() for a hub address typed as the first word).
//
// THE FIVE STEPS, in C-06.5's order, after the arguments are read (a unix:
// or ws+unix: address, an unknown flag or a missing hub is a usage error, 2:
// the hub is dialled at wss://<host>/connector only, C-05.4) and root is
// refused (C-06.1: the connector runs as the OS user, never as root):
//   (1) describeInstall() must say `managed`: else refuse naming the installer
//       (install.sh, or `claude-web-chat update`), exit 1, writing nothing.
//       --workdir (first pairing only; a later run keeps the record's) is
//       resolved and refused inside ~/.web-chat or inside an offered folder
//       (C-06.18), and a unit that would launch through a missing ~/.local/bin
//       link is refused here too, before anything is written;
//   (2) pair (./pairing pair(), U715) when no record for this hub is paired, or
//       --re-pair is given. The pairing's output in manual mode is ONE stdout
//       line when it starts (swc-25 Q1, hand fold 4 (a)) —
//         pairing code XXXX-XXXX · fingerprint SHA256:… · expires <ISO>
//       or with --json the one line {"event":"pairing", code, fingerprint,
//       pairing_id, expires_at, hub_id} — then, on `bound`, a second line
//       (`bound <machine_id> <machine_name>`, or the json event `bound`).
//       pair() prints its own friendlier lines through deps.print; here they
//       are held, and the start's facts are read off pair()'s request seam,
//       printed when the first poll is made (pair() polls only after it has
//       checked the start's answer and written the pending record). The exit
//       code says how it ended: 3 expired, 4 refused (the hub's word in the
//       line), 2 a usage or record error, 1 anything else. Nothing asks a
//       question: a supervisor with no TTY pairs this machine from stdout.
//   (3) the unit (C-06.6) through lib/setup/connector.js's pure builders: a
//       LaunchAgent on macOS, a systemd user unit on Linux, none elsewhere
//       ("start at login is unavailable here"); launching through the
//       ~/.local/bin link (describeInstall().linkPath), never a version path;
//       carrying the PATH capturePathEnv captures, also kept as the record's
//       service.path_env; written atomically at 0644 (no secret is in it);
//       the connector log pre-created 0600;
//   (4) the service started through serviceRun's injected runner only
//       (LAUNCHD@stubbed): launchd's bootout (its failure ignored: not
//       loaded) then bootstrap; systemd's daemon-reload, enable --now and
//       restart, with the `loginctl enable-linger $USER` hint;
//   (5) up to 15 s for the record's last_reported.at to pass the moment step
//       (4) began — the running connector writes it after each hello.ack
//       (./run.js) — then the status through ./cli.js's status row; past 15 s
//       the status with "not connected yet (the service keeps trying)", exit
//       0. When the captured PATH has no tmux, the step says so and names the
//       install (A-06.1), then carries on.
// Rerunnable: a paired record and no --re-pair rewrites the unit and restarts
// the service, and never pairs.
//
// --insecure-loopback (C-05.4's development flag; form 3 CB1 = b): admits a
// plain-http hub on a loopback literal (127.0.0.1, localhost, ::1) and
// refuses every other host with one sentence. It is per invocation and never
// written anywhere: a record paired over loopback http says so in its origin.
//
// NEVER here: the pairing code, a key or a secret in a log line, an argv, the
// unit or the record (the code goes to stdout once, as C-06.8 asks); a
// service manager run but through serviceRun; a TLS option (Node's default
// trust stays, so NODE_EXTRA_CA_CERTS works).

const fs = require('fs');
const path = require('path');

const { userPaths, isInside, nearestExisting, realpath } = require('../core/paths');
const { writeFileAtomic } = require('../core/fsjson');
const { stripControls } = require('../core/text');
const { LOCAL_HOSTNAMES } = require('../core/cors');
const { findClaude } = require('../core/claude-cli');
const { describeInstall } = require('../update/install-layout');
const outbound = require('../util/outbound');
const setup = require('../setup/connector');

const USAGE = 'connect <hub-url> [--workdir <dir>] [--re-pair] [--json] [--insecure-loopback]';

const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2, EXPIRED: 3, REFUSED: 4 });

const WAIT_MS = 15000;          // C-06.5 (5)
const WAIT_POLL_MS = 200;
const BOOTSTRAP_RETRY_MS = 1000;
const UNIT_MODE = 0o644;
const LOG_MODE = 0o600;
const WORKDIR_MODE = 0o700;

// Contract 05's pairing paths (C-05.1 to C-05.3): the start's facts are read
// off pair()'s request seam, the start's answer and the first poll.
const PAIR_PATH = '/connector/pair';
const POLL_PATH = '/connector/pair/poll';

const LINGER_HINT = 'To keep the connector running while you are logged out, run: loginctl enable-linger $USER';
const FOREGROUND = 'start at login is unavailable here; run `claude-web-chat connect run` in a terminal';
const LOOPBACK_ONLY = '--insecure-loopback is for a hub on this machine\'s loopback (127.0.0.1, localhost or ::1) only';

const clean = (v) => stripControls(String(v));

// Does the first argument look like a hub address (./cli.js asks this only
// when no row is named by it)? An https URL or a bare host name (with a dot,
// a port, or `localhost`); also an http URL and a unix: or ws+unix: socket
// address, so the row refuses each with its own sentence and the usage line
// instead of the table's "unknown subcommand". Any other scheme is left to
// the rows after this one.
function looksLikeHub(arg) {
  if (typeof arg !== 'string' || !arg || arg.startsWith('-')) return false;
  if (/^(?:ws\+)?unix:/i.test(arg)) return true;
  if (/^https?:\/\//i.test(arg)) return true;
  if (/^localhost(?::\d{1,5})?$/i.test(arg)) return true;
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?$/i.test(arg) || /^[a-z0-9-]+:\d{1,5}$/i.test(arg);
}

// The arguments: the hub first, then the flags in any order.
function parseArgs(args) {
  const out = { hub: null, workdir: null, rePair: false, json: false, insecureLoopback: false };
  const list = Array.isArray(args) ? args.slice() : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--re-pair') out.rePair = true;
    else if (a === '--json') out.json = true;
    else if (a === '--insecure-loopback') out.insecureLoopback = true;
    else if (a === '--workdir') {
      const v = list[++i];
      if (typeof v !== 'string' || !v || v.startsWith('--')) return { error: '--workdir needs a directory' };
      out.workdir = v;
    } else if (typeof a === 'string' && a.startsWith('--workdir=')) {
      const v = a.slice('--workdir='.length);
      if (!v) return { error: '--workdir needs a directory' };
      out.workdir = v;
    } else if (typeof a === 'string' && a.startsWith('-')) {
      return { error: `unknown option ${clean(a).slice(0, 40)}` };
    } else if (out.hub === null) {
      out.hub = a;
    } else {
      return { error: 'one hub address only' };
    }
  }
  if (!out.hub) return { error: 'give the hub\'s address' };
  return out;
}

// The hub's origin as the record keeps it, or { error } for a usage error.
// A unix: socket address is refused by name (the dial is wss://<host>/connector
// only, C-05.4); the flag admits a loopback http hub and nothing else.
function originOf(hub, { insecureLoopback }) {
  if (/^(?:ws\+)?unix:/i.test(hub)) {
    return { error: 'a hub is reached at https://<host> (the connector dials wss://<host>/connector); a unix: socket address is not supported' };
  }
  if (insecureLoopback) {
    let host = null;
    try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(hub) ? hub : `https://${hub}`).hostname; } catch { host = null; }
    if (host !== null && !LOCAL_HOSTNAMES.has(host)) return { error: LOOPBACK_ONLY };
  }
  let origin;
  try {
    origin = setup.hubOrigin(hub, { insecureLoopback });
  } catch (e) {
    return { error: e && e.code === 'EHUBORIGIN' ? e.message : 'that is not a hub address' };
  }
  if (insecureLoopback && !LOCAL_HOSTNAMES.has(new URL(origin).hostname)) return { error: LOOPBACK_ONLY };
  return { origin };
}

function defaults(deps = {}) {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    describeInstall,
    getuid: () => (typeof process.getuid === 'function' ? process.getuid() : null),
    platform: process.platform,
    platformKind: (platform) => setup.platformKind(platform),
    env: process.env,
    findClaude,
    capturePathEnv: setup.capturePathEnv,
    pair: (opts) => require('./pairing').pair(opts),
    request: outbound.request,
    run: undefined,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    waitMs: WAIT_MS,
    cwd: () => process.cwd(),
    signals: process,
    ...deps,
  };
}

// A json event line, or a human line, on stdout.
function emitter(d, json) {
  return {
    event: (obj, human) => d.out(json ? JSON.stringify(obj) : human),
    // Human prose: stdout normally, stderr under --json so stdout stays JSON.
    say: (line) => (json ? d.err(line) : d.out(line)),
  };
}

// The managed-install check (C-06.5 (1)).
function installRefusal(info) {
  const kind = info && typeof info.kind === 'string' ? info.kind : 'unknown';
  const what = kind === 'dev' ? 'a git checkout' : kind === 'unmanaged' ? 'an unmanaged copy' : 'not the managed install';
  return `connect: this claude-web-chat is ${what}; the connector runs only from the managed install. `
    + 'Install it with install.sh, or switch with `claude-web-chat update` from a managed install, then run `claude-web-chat connect` again.';
}

// `abs` as the filesystem will see it once made: its nearest existing
// ancestor through its links (macOS's /var is /private/var; a symlinked home),
// then the part still to be created. Asked of both sides of a fence.
function onDisk(abs) {
  const anchor = nearestExisting(abs, { follow: false });
  const real = realpath(anchor) || anchor;
  return path.join(real, path.relative(anchor, abs));
}
const within = (parent, child) => isInside(onDisk(path.resolve(parent)), onDisk(child));

// The workdir a first pairing records (C-06.18): absolute, outside ~/.web-chat,
// outside every offered folder, a directory when it already exists.
function checkWorkdir(dir, d) {
  const abs = path.resolve(d.cwd(), dir);
  if (/[\0\r\n]/.test(abs)) return { error: 'the workdir path holds a control character' };
  if (within(userPaths().root, abs)) return { error: 'the workdir must lie outside ~/.web-chat' };
  for (const { read } of setup.listRecords()) {
    if (!read.ok) continue;
    for (const f of read.value.folders) {
      if (within(f.path, abs)) return { error: `the workdir must not lie inside an offered folder (${clean(f.display)})` };
    }
  }
  let st = null;
  try { st = fs.statSync(abs); } catch { st = null; }
  if (st && !st.isDirectory()) return { error: 'the workdir is a file, not a directory' };
  return { workdir: abs };
}

// The record already standing for this hub's origin, or null.
function recordFor(origin) {
  for (const r of setup.listRecords()) {
    if (r.read.ok && r.read.value.hub.origin === origin) return r;
  }
  return null;
}

// ── step (2): pairing ─────────────────────────────────────────────────────

const pathOf = (url) => { try { return new URL(url).pathname; } catch { return ''; } };

async function pairStep(opts, d, io) {
  const { origin, workdir, rePair, json, insecureLoopback } = opts;
  let start = null;
  let announced = false;
  const announce = () => {
    if (announced || !start) return;
    announced = true;
    const expires = Number.isFinite(start.expires_at) ? new Date(start.expires_at).toISOString() : 'unknown';
    io.event(
      { event: 'pairing', code: start.code, fingerprint: start.fingerprint, pairing_id: start.pairing_id, expires_at: start.expires_at, hub_id: start.hub_id },
      `pairing code ${start.code} · fingerprint ${start.fingerprint} · expires ${expires}`,
    );
  };
  const request = async (url, ropts) => {
    const p = pathOf(url);
    if (p === POLL_PATH) announce();
    const res = await d.request(url, ropts);
    if (p === PAIR_PATH && res && res.status === 200 && res.json && res.json.ok === true) start = res.json;
    return res;
  };
  const ac = new AbortController();
  const onInt = () => ac.abort();
  const sig = d.signals && typeof d.signals.on === 'function' ? d.signals : null;
  if (sig) sig.on('SIGINT', onInt);
  let result;
  try {
    result = await d.pair({
      hubUrl: origin,
      workdir: workdir || undefined,
      rePair,
      deps: {
        request,
        print: () => {},   // pair()'s own lines are held; its failure sentence is returned
        signal: ac.signal,
        insecureLoopback,
      },
    });
  } finally {
    if (sig) {
      if (typeof sig.off === 'function') sig.off('SIGINT', onInt);
      else if (typeof sig.removeListener === 'function') sig.removeListener('SIGINT', onInt);
    }
  }
  if (result && result.ok) {
    let name = '';
    try {
      const r = setup.readRecord(result.hubId);
      if (r.ok && r.value.machine) name = clean(r.value.machine.name);
    } catch { /* the name is for the line only */ }
    io.event(
      { event: 'bound', machine_id: result.machineId, machine_name: name, key_id: result.keyId, hub_id: result.hubId },
      `bound ${result.machineId} ${name}`.trimEnd(),
    );
    return { ok: true, hubId: result.hubId };
  }
  const reason = result && typeof result.reason === 'string' ? result.reason : 'error';
  const message = clean(result && result.message ? result.message : 'pairing failed').slice(0, 800);
  let code = EXIT.FAIL;
  if (reason === 'expired') code = EXIT.EXPIRED;
  else if (reason === 'refused') code = EXIT.REFUSED;
  else if (reason === 'bad_origin' || reason === 'record') code = EXIT.USAGE;
  if (reason === 'expired' || reason === 'refused') {
    io.event({ event: reason, message }, `${reason} · ${message}`);
  } else if (json) {
    d.out(JSON.stringify({ event: 'error', reason, message }));
  }
  if (!(reason === 'expired' || reason === 'refused') || json) d.err(message);
  return { ok: false, code };
}

// ── step (3): the unit and its log ──────────────────────────────────────

// The connector log, 0600 before the service's first byte: an exclusive
// create when it is absent, a chmod when it is there (no append-mode open in
// lib/; the service manager appends).
function preCreateLog(file) {
  setup.ensureConnectorDir();
  try {
    fs.closeSync(fs.openSync(file, 'wx', LOG_MODE));
  } catch (e) {
    if (!e || e.code !== 'EEXIST') throw e;
  }
  fs.chmodSync(file, LOG_MODE);
}

function writeUnit({ kind, binLink, pathEnv, logFile }) {
  const unit = setup.unitFor(kind);
  const text = kind === 'launchd'
    ? setup.plistText({ binLink, pathEnv, logFile })
    : setup.systemdText({ binLink, pathEnv, logFile });
  writeFileAtomic(unit.unit_path, text, { mode: UNIT_MODE, mkdir: true, fsync: true });
  fs.chmodSync(unit.unit_path, UNIT_MODE);
  return unit;
}

// ── step (4): the service manager ───────────────────────────────────────

async function startService(kind, unitPath, d, io) {
  const run = (argv) => setup.serviceRun(argv, { deps: { run: d.run } });
  if (kind === 'launchd') {
    const argv = setup.serviceArgv('launchd', { uid: d.getuid(), plist: unitPath });
    try { run(argv.unload); } catch { /* not loaded: nothing to take down */ }
    try {
      run(argv.load);
    } catch {
      // launchd can still be tearing the old job down a moment after bootout:
      // one more try before giving up.
      await d.sleep(BOOTSTRAP_RETRY_MS);
      run(argv.load);
    }
    return;
  }
  const argv = setup.serviceArgv('systemd-user');
  run(argv.reload);
  run(argv.load);
  run(argv.restart);
  io.say(LINGER_HINT);
}

// ── step (5): the first acknowledged hello ──────────────────────────────

async function waitForHello(hubId, since, d) {
  const until = since + Math.max(0, d.waitMs);
  for (;;) {
    let at = null;
    try {
      const r = setup.readRecord(hubId);
      if (r.ok && r.value.last_reported && Number.isFinite(r.value.last_reported.at)) at = r.value.last_reported.at;
    } catch { at = null; }
    if (at !== null && at >= since) return true;
    if (d.now() >= until) return false;
    await d.sleep(Math.min(WAIT_POLL_MS, Math.max(1, until - d.now())));
  }
}

function tmuxNotice(platform) {
  if (platform === 'darwin') {
    return 'tmux is not on the PATH the connector runs with: install it with `brew install tmux`, then run this command again (manual mode works without it).';
  }
  return 'tmux is not on the PATH the connector runs with: install your distribution\'s tmux package (for example `sudo apt install tmux` or `sudo dnf install tmux`), then run this command again (manual mode works without it).';
}

async function printStatus(d, json) {
  const cli = require('./cli');
  const out = json ? d.err : d.out;
  try {
    await cli.status([], { ...d, out, err: d.err });
  } catch {
    d.err('connect: the status could not be read');
  }
}

// ── the row ────────────────────────────────────────────────────────────

async function install(args, deps) {
  const d = defaults(deps);
  const parsed = parseArgs(args);
  if (parsed.error) {
    d.err(`connect: ${parsed.error}`);
    d.err(`usage: claude-web-chat ${USAGE}`);
    return EXIT.USAGE;
  }
  const io = emitter(d, parsed.json);
  const where = originOf(parsed.hub, parsed);
  if (where.error) {
    d.err(`connect: ${where.error}`);
    d.err(`usage: claude-web-chat ${USAGE}`);
    return EXIT.USAGE;
  }
  const { origin } = where;

  // C-06.1: the OS user, never root.
  if (d.getuid() === 0) {
    d.err('connect: the connector runs as your own user, never as root; run it without sudo');
    return EXIT.FAIL;
  }

  // (1) the managed install, through its ~/.local/bin link.
  let info = null;
  try { info = d.describeInstall(); } catch { info = null; }
  if (!info || info.kind !== 'managed') {
    d.err(installRefusal(info));
    return EXIT.FAIL;
  }
  const kind = d.platformKind(d.platform);
  const binLink = info.linkPath;
  if (kind) {
    let present = false;
    try { fs.lstatSync(binLink); present = true; } catch { present = false; }
    if (typeof binLink !== 'string' || !path.isAbsolute(binLink) || !present) {
      d.err('connect: the claude-web-chat link in ~/.local/bin is missing, and the service launches through it; '
        + 'run `claude-web-chat update` (or install.sh) to put it back, then run this command again');
      return EXIT.FAIL;
    }
  }

  // The record already here for this hub, and the workdir (C-06.18).
  const existing = recordFor(origin);
  const paired = !!(existing && existing.read.value.credential.state === 'paired');
  const pairing = !paired || parsed.rePair;
  let workdir = null;
  if (parsed.workdir) {
    if (existing) {
      io.say('connect: --workdir is used on the first pairing only; this machine keeps the workdir its record names');
    } else {
      const w = checkWorkdir(parsed.workdir, d);
      if (w.error) {
        d.err(`connect: ${w.error}`);
        return EXIT.USAGE;
      }
      workdir = w.workdir;
    }
  }

  // (2) pair when not paired, or --re-pair.
  let hubId = existing ? existing.hubId : null;
  if (pairing) {
    const p = await pairStep({ origin, workdir, rePair: parsed.rePair, json: parsed.json, insecureLoopback: parsed.insecureLoopback }, d, io);
    if (!p.ok) return p.code;
    hubId = p.hubId;
  }
  const read = setup.readRecord(hubId);
  if (!read.ok || read.value.credential.state !== 'paired') {
    d.err('connect: the connector record is not paired after pairing; run this command again');
    return EXIT.USAGE;
  }
  if (workdir && read.value.workdir === workdir) {
    try {
      fs.mkdirSync(workdir, { recursive: true, mode: WORKDIR_MODE });
    } catch (e) {
      d.err(`connect: the workdir could not be made (${clean(e && e.code ? e.code : 'error')})`);
      return EXIT.FAIL;
    }
  }

  // (3) the unit, the log and the record's service.
  const captured = d.capturePathEnv({ env: d.env, findClaude: d.findClaude });
  if (!kind) {
    io.event({ event: 'service', kind: null }, FOREGROUND);
    await printStatus(d, parsed.json);
    if (!captured.tmux) io.event({ event: 'notice', code: 'no-tmux', message: tmuxNotice(d.platform) }, tmuxNotice(d.platform));
    return EXIT.OK;
  }
  const logFile = userPaths().connectorLog;
  let unit;
  try {
    preCreateLog(logFile);
    unit = writeUnit({ kind, binLink, pathEnv: captured.pathEnv, logFile });
    setup.updateRecord(hubId, (rec) => (rec ? {
      ...rec,
      service: {
        kind, label: unit.label, unit_path: unit.unit_path, path_env: captured.pathEnv, installed_at: d.now(),
      },
    } : null));
  } catch (e) {
    d.err(`connect: the start-at-login unit could not be written (${clean(e && e.code ? e.code : e && e.message ? e.message : 'error').slice(0, 120)})`);
    return EXIT.FAIL;
  }

  // (4) start or restart it.
  const began = d.now();
  try {
    await startService(kind, unit.unit_path, d, io);
  } catch (e) {
    d.err(`connect: the service manager did not start the connector (${clean(e && e.message ? e.message : 'error').split('\n')[0].slice(0, 200)})`);
    return EXIT.FAIL;
  }
  io.event({ event: 'service', kind, unit_path: unit.unit_path }, `Start at login: ${kind} unit written to ${unit.unit_path} and started.`);

  // (5) the first acknowledged hello, then the status.
  const up = await waitForHello(hubId, began, d);
  if (up) io.event({ event: 'connected' }, 'Connected: the hub acknowledged this machine\'s connector.');
  else io.event({ event: 'waiting' }, 'not connected yet (the service keeps trying)');
  await printStatus(d, parsed.json);
  if (!captured.tmux) io.event({ event: 'notice', code: 'no-tmux', message: tmuxNotice(d.platform) }, tmuxNotice(d.platform));
  return EXIT.OK;
}

module.exports = {
  install,
  looksLikeHub,
  parseArgs,
  USAGE,
  EXIT,
  WAIT_MS,
  LINGER_HINT,
};
