// The connector's files, its unit and its service manager (contract 06
// sections 3.1–3.3). SHARED (test/dependency-direction.test.js): the ONE home
// of the connector record, the start-at-login unit and the service manager's
// argv, required alike by lib/connector (the process) and by the CLI commands
// that act on it from outside — connect, update, uninstall and status. A
// second reader or writer of the record, a second unit text or a service
// manager run anywhere else is the defect this module exists to prevent.
//
// What lives here:
//   * the record (06-connector-state.json, ~/.web-chat/connector/<hub-id>.json,
//     0600 in the 0700 directory; C-06.2, C-06.7): read through lib/core/fsjson
//     readJson's four states with checkRecord — a HAND-WRITTEN mirror of the
//     schema, since no schema library runs at runtime — and written only under
//     the record's own O_EXCL lock (lib/util/registry withLockFile), so the CLI
//     (offer, ceiling, cap, attach, pairing) and the running service (settings,
//     chats, last_reported) never lose each other's write. The record never
//     holds a secret: the private key is its own 0600 file beside it, a relay
//     secret is never on disk, and checkRecord refuses any key the schema does
//     not name, a `secret` among them;
//   * the machine's ceiling: ceilingOf is lib/core/connected-ceiling.js's,
//     re-exported — the one four-case reading, never a copy;
//   * the hub origin as the record stores it (hubOrigin);
//   * the machine key's id and display fingerprint (keyIdOf, fingerprintOf;
//     03 section 2): the one derivation, PURE;
//   * the unit (C-06.6): its label and paths, the platform's kind, and two PURE
//     text builders (a launchd plist, a systemd user unit), each launching
//     through the ~/.local/bin link with a PATH captured at install
//     (capturePathEnv) and its output in the connector's own log;
//   * the service manager's argv (load, unload, restart; C-06.11), PURE
//     arrays, run only through serviceRun's injected runner. The default
//     runner refuses under the Node test runner, so a test that forgot its
//     stub fails instead of touching the user's login session.
//
// This module writes no unit file and runs no program by itself: the connect
// command writes the unit through these builders and runs the argv through
// serviceRun.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const crypto = require('crypto');

const { userPaths, installPaths, homeDir, isHubId } = require('../core/paths');
const { readJson, writeJsonAtomic } = require('../core/fsjson');
const { LOCAL_HOSTNAMES } = require('../core/cors');
const { escapeHtml } = require('../core/html');
const { hasForbidden } = require('../core/text');
const { findClaude: defaultFindClaude } = require('../core/claude-cli');
const { ceilingOf } = require('../core/connected-ceiling');
const { withLockFile } = require('../util/registry');

const RECORD_VERSION = 1;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// ── the record's shape (06-connector-state.json, mirrored by hand) ──────────
// Each node: { type, … }. `nullable` admits null beside the type; an object's
// `props` is the whole of what it may carry (additionalProperties false at
// every level, as the schema says), `required` what it must. Lengths count
// code points, as JSON Schema does.
const CROCKFORD26 = '[0-9a-hjkmnp-tv-z]{26}';
const HUB_ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/;
// The one thing beyond the schema (C-05.4's development flag; the hinge
// U714-U735@insecure-loopback-origin, ruled (a)): a plain http origin whose
// host is a loopback literal, which only hubOrigin's insecureLoopback writes
// and the CLI never passes in alpha.7.
const LOOPBACK_HTTP_RE = /^http:\/\/([a-z0-9.-]+)(:[0-9]{1,5})?$/;

const FOLDER_ID = { type: 'string', pattern: /^f_[0-9a-f]{16}$/ };
const PATH_TEXT = { type: 'string', minLength: 1, maxLength: 4096 };

const FOLDER = {
  type: 'object',
  required: ['id', 'path', 'display', 'access', 'offered_at'],
  props: {
    id: FOLDER_ID,
    path: PATH_TEXT,
    display: PATH_TEXT,
    label: { type: 'string', maxLength: 120 },
    access: { enum: ['read-write'] },
    offered_at: { type: 'number' },
  },
};

const CHAT = {
  type: 'object',
  required: ['chat_id', 'rev', 'scope_kind', 'root', 'owned_root', 'desired'],
  props: {
    chat_id: { type: 'string', pattern: new RegExp(`^${CROCKFORD26}$`) },
    rev: { type: 'integer', minimum: 0 },
    scope_kind: { enum: ['folder', 'repo', 'space'] },
    folder_id: FOLDER_ID,
    root: PATH_TEXT,
    instance: { type: 'string', nullable: true, pattern: /^[0-9a-f]{8}$/ },
    owned_root: { type: 'boolean' },
    desired: { enum: ['running', 'stopped'] },
    manual_attach_at: { type: 'number', nullable: true },
    assigned_at: { type: 'number' },
  },
};

const RECORD = {
  type: 'object',
  required: ['v', 'hub', 'credential', 'workdir', 'settings', 'folders', 'chats'],
  props: {
    v: { const: RECORD_VERSION },
    hub: {
      type: 'object',
      required: ['id', 'origin'],
      props: {
        id: { type: 'string', pattern: /^[a-z0-9][a-z0-9-]{2,62}$/ },
        origin: { type: 'string', check: (s) => HUB_ORIGIN_RE.test(s) || isLoopbackHttpOrigin(s) },
        name: { type: 'string', maxLength: 120 },
      },
    },
    machine: {
      type: 'object',
      nullable: true,
      required: ['id', 'name'],
      props: {
        id: { type: 'string', pattern: new RegExp(`^mch_${CROCKFORD26}$`) },
        name: { type: 'string', maxLength: 120 },
      },
    },
    credential: {
      type: 'object',
      required: ['state'],
      props: {
        state: { enum: ['unpaired', 'pending', 'paired', 'revoked'] },
        algorithm: { type: 'string', enum: ['ed25519'] },
        key_file: { type: 'string' },
        key_id: { type: 'string', pattern: new RegExp(`^mky_${CROCKFORD26}$`) },
        public_key: { type: 'string', pattern: /^[A-Za-z0-9_-]{43}$/ },
        fingerprint: { type: 'string', pattern: /^SHA256:[A-Za-z0-9+/]{43}$/ },
        paired_at: { type: 'number', nullable: true },
        revoked_at: { type: 'number', nullable: true },
      },
    },
    workdir: { type: 'string' },
    ceiling: { enum: ['read', 'full'] },
    settings: {
      type: 'object',
      required: ['agents_at_once', 'accept_new_chats', 'let_home_start_agents', 'paused'],
      props: {
        agents_at_once: { type: 'integer', minimum: 0, maximum: 64 },
        local_cap: { type: 'integer', nullable: true, minimum: 0, maximum: 64 },
        accept_new_chats: { type: 'boolean' },
        let_home_start_agents: { type: 'boolean' },
        paused: { type: 'boolean' },
        rev: { type: 'integer', minimum: 0 },
      },
    },
    folders: { type: 'array', maxItems: 256, items: FOLDER },
    chats: { type: 'array', maxItems: 1024, items: CHAT },
    service: {
      type: 'object',
      nullable: true,
      required: ['kind', 'unit_path', 'installed_at'],
      props: {
        kind: { enum: ['launchd', 'systemd-user'] },
        label: { type: 'string', maxLength: 128 },
        unit_path: { type: 'string' },
        path_env: { type: 'string', maxLength: 4096 },
        installed_at: { type: 'number' },
      },
    },
    last_reported: {
      type: 'object',
      nullable: true,
      props: {
        connector_version: { type: 'string', maxLength: 64 },
        install_kind: { enum: ['managed', 'dev', 'unmanaged'] },
        claude_code_version: { type: 'string', nullable: true, maxLength: 64 },
        at: { type: 'number' },
      },
    },
  },
};

function isLoopbackHttpOrigin(s) {
  const m = typeof s === 'string' && LOOPBACK_HTTP_RE.exec(s);
  return !!m && LOCAL_HOSTNAMES.has(m[1]);
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const codePoints = (s) => [...s].length;

// The first way `value` breaks `spec`, as a JSON pointer and a rule — never the
// value itself (a path or a name in a record is not for a log line) — or null.
function problemAt(spec, value, at) {
  if (value === null && spec.nullable) return null;
  if ('const' in spec) return value === spec.const ? null : `${at} must be ${JSON.stringify(spec.const)}`;
  if (spec.enum && !spec.type) return spec.enum.includes(value) ? null : `${at} must be one of ${spec.enum.join(', ')}`;
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') return `${at} must be a string`;
      if (spec.enum && !spec.enum.includes(value)) return `${at} must be one of ${spec.enum.join(', ')}`;
      if (spec.minLength != null && codePoints(value) < spec.minLength) return `${at} is shorter than ${spec.minLength}`;
      if (spec.maxLength != null && codePoints(value) > spec.maxLength) return `${at} is longer than ${spec.maxLength}`;
      if (spec.pattern && !spec.pattern.test(value)) return `${at} does not match its pattern`;
      if (spec.check && !spec.check(value)) return `${at} does not match its pattern`;
      return null;
    }
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${at} must be a number`;
    case 'integer': {
      if (!Number.isInteger(value)) return `${at} must be an integer`;
      if (spec.minimum != null && value < spec.minimum) return `${at} is below ${spec.minimum}`;
      if (spec.maximum != null && value > spec.maximum) return `${at} is above ${spec.maximum}`;
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${at} must be a boolean`;
    case 'array': {
      if (!Array.isArray(value)) return `${at} must be an array`;
      if (spec.maxItems != null && value.length > spec.maxItems) return `${at} has more than ${spec.maxItems} items`;
      for (let i = 0; i < value.length; i++) {
        const p = problemAt(spec.items, value[i], `${at}/${i}`);
        if (p) return p;
      }
      return null;
    }
    case 'object': {
      if (!isPlainObject(value)) return `${at} must be an object`;
      for (const k of spec.required || []) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) return `${at}/${k} is required`;
      }
      for (const k of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(spec.props, k)) return `${at} carries a key the record does not name`;
        const p = problemAt(spec.props[k], value[k], `${at}/${k}`);
        if (p) return p;
      }
      return null;
    }
    default:
      return `${at}: no rule`;
  }
}

// The first problem with a record, or null. The pointer starts at '' (the
// record itself, '/hub/id' below it).
function recordProblem(value) {
  return problemAt(RECORD, value, '');
}

// Does `value` have the record's shape? The validator readJson takes.
function checkRecord(value) {
  return recordProblem(value) === null;
}

function recordError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function fileFor(hubId, accessor) {
  const file = isHubId(hubId) ? userPaths()[accessor](hubId) : null;
  if (!file) throw recordError('EHUBID', 'not a hub id (lower-case letters, digits and hyphens, 3 to 63 characters)');
  return file;
}

// ── the directory ──────────────────────────────────────────────────────────

// ~/.web-chat/connector, 0700 (C-06.7): made so, or tightened when it exists
// looser. A symlink or a file in its place is refused, never followed.
function ensureConnectorDir() {
  const dir = userPaths().connectorDir;
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw recordError('ENOTDIR', `${path.basename(dir)} is not a directory`);
  if ((st.mode & 0o777) !== DIR_MODE) fs.chmodSync(dir, DIR_MODE);
  return dir;
}

// ── the record ─────────────────────────────────────────────────────────────

// readJson's four states for <hub-id>.json: ok (the shape holds and its hub.id
// is the file's), absent, corrupt or invalid. Throws only for a hub id that
// may not name a file (EHUBID).
function readRecord(hubId) {
  const file = fileFor(hubId, 'connectorRecord');
  return readJson(file, {
    validate: (value) => {
      const problem = recordProblem(value);
      if (problem) throw recordError('EBADRECORD', `connector record: ${problem}`);
      if (value.hub.id !== hubId) throw recordError('EBADRECORD', `connector record: /hub/id is not ${hubId}, the file's name`);
      return true;
    },
  });
}

// Every <hub-id>.json in the directory, each as { hubId, file, read } with
// readRecord's state; a file whose name is not a hub id (the ledger, a lock, a
// stray) is not a record. An absent directory lists nothing.
function listRecords() {
  let names;
  try {
    names = fs.readdirSync(userPaths().connectorDir);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return [];
    throw e;
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .filter(isHubId)
    .sort()
    .map((hubId) => ({ hubId, file: userPaths().connectorRecord(hubId), read: readRecord(hubId) }));
}

// Write a whole record, 0600 from its first byte (the mode is on the exclusive
// create), under the record's lock. Refuses a record that is not the schema's
// shape — so nothing the schema does not name, a secret included, ever lands.
// A CHANGE to a record is updateRecord, which re-reads inside the lock; this is
// for the write that has nothing to merge with, and what updateRecord calls.
function writeRecord(record) {
  const problem = recordProblem(record);
  if (problem) throw recordError('EBADRECORD', `connector record: ${problem}`);
  const hubId = record.hub.id;
  const file = fileFor(hubId, 'connectorRecord');
  ensureConnectorDir();
  return withLockFile(fileFor(hubId, 'connectorRecordLock'), () =>
    writeJsonAtomic(file, record, { mode: FILE_MODE, newline: true, mkdir: false, fsync: true }));
}

// The one way to change a record: under <hub-id>.json.lock, read it afresh,
// hand `fn` a copy (null when there is none yet) and write what it returns
// (null or undefined: no write). Returns the record as it now stands. A record
// that is there but corrupt or invalid is never overwritten by a change made
// blind to it: that throws (ERECORD, with `state`), for the caller to say so.
// `fn` must be synchronous: the lock is released when it returns.
function updateRecord(hubId, fn) {
  const lock = fileFor(hubId, 'connectorRecordLock');
  ensureConnectorDir();
  return withLockFile(lock, () => {
    const read = readRecord(hubId);
    if (read.corrupt || read.invalid) {
      const e = recordError('ERECORD', `the connector record for ${hubId} is ${read.corrupt ? 'unreadable' : 'not the record\'s shape'}`);
      e.state = read.corrupt ? 'corrupt' : 'invalid';
      throw e;
    }
    const current = read.ok ? read.value : null;
    const next = fn(current == null ? null : structuredClone(current));
    if (next && typeof next.then === 'function') throw new TypeError('updateRecord: fn must be synchronous');
    if (next == null) return current;
    if (!isPlainObject(next) || !isPlainObject(next.hub) || next.hub.id !== hubId) {
      throw recordError('EBADRECORD', `connector record: /hub/id must stay ${hubId}`);
    }
    writeRecord(next);
    return next;
  });
}

// The machine settings before the hub's first machine.settings (Q6, ruled
// conservative): accept nothing new, start nothing, until the hub says so.
const SETTINGS_DEFAULTS = Object.freeze({
  agents_at_once: 0,
  accept_new_chats: false,
  let_home_start_agents: false,
  paused: false,
  rev: 0,
});

// `ceiling` written only where the key is absent (C-06.23a: pairing and
// offering a folder write the default and never change a value the user set).
// Returns a copy; anything else is untouched.
function withDefaults(record) {
  if (!isPlainObject(record)) return record;
  if (Object.prototype.hasOwnProperty.call(record, 'ceiling')) return { ...record };
  return { ...record, ceiling: 'full' };
}

// A fresh record for a first `connect`: unpaired, no machine yet, nothing
// offered or assigned, the conservative settings. `origin` is hubOrigin's.
function newRecord({ hubId, origin, workdir } = {}) {
  if (!isHubId(hubId)) throw recordError('EHUBID', 'not a hub id (lower-case letters, digits and hyphens, 3 to 63 characters)');
  return withDefaults({
    v: RECORD_VERSION,
    hub: { id: hubId, origin },
    machine: null,
    credential: { state: 'unpaired' },
    workdir: workdir || userPaths().defaultWorkdir(hubId),
    settings: { ...SETTINGS_DEFAULTS },
    folders: [],
    chats: [],
  });
}

// ── the hub's origin ───────────────────────────────────────────────────────

// The record's hub.origin from what the user typed: a bare host
// (`hub.example.com`, `hub.example.com:8443`) or an https URL, lower-cased,
// with no path, query or default port — the schema's ^https://host(:port)?$.
// Plain http is refused, but for a loopback host when the caller passes
// insecureLoopback (C-05.4's development flag: the tests and the fake hub; the
// CLI never does in alpha.7). Throws EHUBORIGIN with a sentence for the user.
function hubOrigin(input, { insecureLoopback = false } = {}) {
  const refuse = (why) => recordError('EHUBORIGIN', why);
  if (typeof input !== 'string' || !input.trim() || hasForbidden(input.trim())) {
    throw refuse('give the hub as a host name or an https:// address');
  }
  const typed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
  let url;
  try { url = new URL(withScheme); } catch { throw refuse('that is not a host name or an https:// address'); }
  if (url.username || url.password) throw refuse('a hub address carries no user name or password');
  const host = url.hostname;
  if (!/^[a-z0-9.-]+$/.test(host)) throw refuse('the hub must be named by a host name');
  if (url.protocol === 'http:') {
    if (!(insecureLoopback && LOCAL_HOSTNAMES.has(host))) throw refuse('the hub must be reached over https://');
  } else if (url.protocol !== 'https:') {
    throw refuse('the hub must be reached over https://');
  }
  const origin = `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`;
  if (!HUB_ORIGIN_RE.test(origin) && !isLoopbackHttpOrigin(origin)) throw refuse('that is not a hub address');
  return origin;
}

// ── the machine key's id and fingerprint (03 section 2, C-03.8) ────────────
// The ONE derivation of both, beside the record that stores the key id: the
// pairing (lib/setup/pairing.js) and the link (lib/connector/link.js) import
// these and define none. PURE: `raw` is the raw 32-byte Ed25519 public key (a
// Buffer or any Uint8Array — never its base64url wire form, a DER wrapping or
// a KeyObject). Contract 03's test vector is examples/03-credential-machine.json.

const KEY_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const KEY_ID_CHARS = 26; // 130 bits, 5 per character
const RAW_KEY_BYTES = 32;

function keyDigest(raw, fn) {
  if (!(raw instanceof Uint8Array)) {
    throw new TypeError(`${fn}: the raw public key must be a Buffer or Uint8Array`);
  }
  if (raw.length !== RAW_KEY_BYTES) {
    throw new RangeError(`${fn}: the raw Ed25519 public key is ${RAW_KEY_BYTES} bytes, not ${raw.length}`);
  }
  return crypto.createHash('sha256').update(raw).digest();
}

// `mky_` + 26 lowercase Crockford base32 characters of the digest's first 130
// bits, most significant bit first; no padding, no check symbol.
function keyIdOf(raw) {
  const digest = keyDigest(raw, 'keyIdOf');
  let out = 'mky_';
  let acc = 0;
  let bits = 0;
  let i = 0;
  while (out.length < 4 + KEY_ID_CHARS) {
    if (bits < 5) {
      acc = ((acc << 8) | digest[i++]) & 0xfff; // at most 12 live bits
      bits += 8;
    }
    bits -= 5;
    out += KEY_ID_ALPHABET[(acc >> bits) & 31];
  }
  return out;
}

// `SHA256:` + the standard base64 of the digest without padding (the OpenSSH
// display form both sides show at pairing).
function fingerprintOf(raw) {
  return `SHA256:${keyDigest(raw, 'fingerprintOf').toString('base64').replace(/=+$/, '')}`;
}

// ── the unit (C-06.6) ───────────────────────────────────────────────────────

const UNIT_LABEL = 'com.claude-web-chat.connector';
const SYSTEMD_NAME = 'claude-web-chat-connector';
const SYSTEMD_UNIT = `${SYSTEMD_NAME}.service`;
// The directories every unit's PATH ends with, after the captured ones.
const SYSTEM_PATH_DIRS = Object.freeze(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);

// Where each kind's unit file lives (the service manager looks there).
function unitPaths() {
  const home = homeDir();
  return {
    launchd: path.join(home, 'Library', 'LaunchAgents', `${UNIT_LABEL}.plist`),
    'systemd-user': path.join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT),
  };
}

// The record's `service` fields a kind implies: { kind, label, unit_path }.
function unitFor(kind) {
  if (kind === 'launchd') return { kind, label: UNIT_LABEL, unit_path: unitPaths().launchd };
  if (kind === 'systemd-user') return { kind, label: SYSTEMD_UNIT, unit_path: unitPaths()['systemd-user'] };
  throw new TypeError(`unitFor: '${kind}' is not a unit kind`);
}

// 'launchd' on macOS, 'systemd-user' on Linux booted with systemd, null
// otherwise (C-06.6's "Neither" row: start at login is unavailable and
// `connect run` works in the foreground). A file check, never a program.
function platformKind(platform = process.platform, { exists = fs.existsSync } = {}) {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') {
    let booted = false;
    try { booted = !!exists('/run/systemd/system'); } catch {}
    return booted ? 'systemd-user' : null;
  }
  return null;
}

function defaultBinLink() {
  return installPaths().binLink('claude-web-chat');
}

function unitInputs({ binLink = defaultBinLink(), pathEnv, logFile = userPaths().connectorLog } = {}) {
  for (const [name, v] of [['binLink', binLink], ['logFile', logFile]]) {
    if (typeof v !== 'string' || !path.isAbsolute(v) || hasForbidden(v)) throw new TypeError(`unit: ${name} must be an absolute path`);
  }
  if (typeof pathEnv !== 'string' || !pathEnv || hasForbidden(pathEnv)) throw new TypeError('unit: pathEnv must be a PATH');
  return { binLink, pathEnv, logFile };
}

// The LaunchAgent (macOS). Every value XML-escaped.
function plistText(opts) {
  const { binLink, pathEnv, logFile } = unitInputs(opts);
  const s = (v) => `<string>${escapeHtml(v)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${s(UNIT_LABEL)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    ${s(binLink)}`,
    `    ${s('connect')}`,
    `    ${s('run')}`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>10</integer>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    ${s(pathEnv)}`,
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  ${s(logFile)}`,
    '  <key>StandardErrorPath</key>',
    `  ${s(logFile)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// A value in a systemd unit: `%` is a specifier, so it is doubled.
const unitValue = (v) => v.replace(/%/g, '%%');

// The systemd user unit (Linux). ExecStart names the link through %h, the
// user's home, as C-06.6 writes it; the log is appended to on both streams, so
// the application log is C-06.7's one file on both platforms.
function systemdText(opts) {
  const { binLink, pathEnv, logFile } = unitInputs(opts);
  const rel = path.relative(homeDir(), binLink);
  const inHome = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const exe = inHome ? `%h/${unitValue(rel.split(path.sep).join('/'))}` : unitValue(binLink);
  if (/[\s"'\\]/.test(exe)) throw new TypeError('unit: the link path cannot carry a space, a quote or a backslash');
  const pathAssign = `PATH=${unitValue(pathEnv)}`;
  const env = /[\s"\\]/.test(pathAssign) ? `"${pathAssign.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : pathAssign;
  return [
    '[Unit]',
    'Description=claude-web-chat connector',
    '',
    '[Service]',
    `ExecStart=${exe} connect run`,
    'Restart=on-failure',
    'RestartSec=5',
    `Environment=${env}`,
    `StandardOutput=append:${unitValue(logFile)}`,
    `StandardError=append:${unitValue(logFile)}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function executableIn(dir, name) {
  try {
    const p = path.join(dir, name);
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The PATH a unit carries (C-06.6, recorded as service.path_env), captured at
// install because launchd's default PATH has none of what the connector runs:
// node's own directory (execPath, then the node on env.PATH), then the
// directories where git, tmux and findClaude's claude are found on env.PATH,
// then the system directories —
// deduped, in that order. `tmux` says whether one was found (A-06.1's notice);
// `git` and `claude` likewise. A directory walk; no program runs.
function capturePathEnv({ env = process.env, findClaude = defaultFindClaude, execPath = process.execPath } = {}) {
  const dirs = String((env && env.PATH) || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  const where = (name) => dirs.find((d) => executableIn(d, name)) || null;
  const gitDir = where('git');
  const tmuxDir = where('tmux');
  let claudeBin = null;
  try { claudeBin = findClaude({ env }); } catch {}
  const claudeDir = claudeBin ? path.dirname(claudeBin) : null;
  // node's own directory first; then the `node` env.PATH finds, when that is
  // another directory (execPath is a resolved path — a Homebrew Cellar one
  // vanishes at the next upgrade, the PATH link does not).
  const ordered = [execPath ? path.dirname(execPath) : null, where('node'), gitDir, tmuxDir, claudeDir, ...SYSTEM_PATH_DIRS];
  const out = [];
  for (const d of ordered) {
    if (!d || d.includes(path.delimiter) || hasForbidden(d) || out.includes(d)) continue;
    out.push(d);
  }
  return { pathEnv: out.join(path.delimiter), tmux: !!tmuxDir, git: !!gitDir, claude: !!claudeDir };
}

// ── the service manager ────────────────────────────────────────────────────
// The two programs, named once each (the conventions ratchet holds their
// literals to this file); every argv below is built from them.
const LAUNCHCTL = 'launchctl';
const SYSTEMCTL = 'systemctl';
const SERVICE_MANAGERS = Object.freeze([LAUNCHCTL, SYSTEMCTL]);

// The argv for each step, by unit kind — PURE arrays (C-06.11 names the
// launchd ones; the bounce after an update uses `restart`). launchd: { load,
// unload, restart } in the gui/<uid> domain; systemd-user: { reload, load,
// restart, unload } (load is enable --now, unload disable --now; reload
// re-reads a rewritten unit).
function serviceArgv(kind, { uid = typeof process.getuid === 'function' ? process.getuid() : null, plist = unitPaths().launchd } = {}) {
  if (kind === 'launchd') {
    if (!Number.isInteger(uid) || uid < 0) throw new TypeError('serviceArgv: launchd needs the user id');
    const domain = `gui/${uid}`;
    const target = `${domain}/${UNIT_LABEL}`;
    return {
      load: [LAUNCHCTL, 'bootstrap', domain, plist],
      unload: [LAUNCHCTL, 'bootout', target],
      restart: [LAUNCHCTL, 'kickstart', '-k', target],
    };
  }
  if (kind === 'systemd-user') {
    return {
      reload: [SYSTEMCTL, '--user', 'daemon-reload'],
      load: [SYSTEMCTL, '--user', 'enable', '--now', SYSTEMD_NAME],
      restart: [SYSTEMCTL, '--user', 'restart', SYSTEMD_NAME],
      unload: [SYSTEMCTL, '--user', 'disable', '--now', SYSTEMD_NAME],
    };
  }
  throw new TypeError(`serviceArgv: '${kind}' is not a unit kind`);
}

const SERVICE_TIMEOUT_MS = 15000;

// The default runner: the program itself, no shell, a timeout, its output
// piped (thrown with the error on a non-zero exit). It refuses — running
// nothing — under the Node test runner (NODE_TEST_CONTEXT, set in every test
// file's process), so a test that forgot to inject deps.run fails loudly
// instead of loading a unit into the user's login session.
function runServiceManager(argv) {
  if (process.env.NODE_TEST_CONTEXT) {
    throw new Error('the service manager is never run under the test runner: inject deps.run');
  }
  return childProcess.execFileSync(argv[0], argv.slice(1), { stdio: 'pipe', timeout: SERVICE_TIMEOUT_MS, shell: false });
}

// Every service-manager call goes through here, and through deps.run when one
// is given (LAUNCHD@stubbed: every test passes one). Only a service manager's
// argv is accepted.
function serviceRun(argv, { deps } = {}) {
  if (!Array.isArray(argv) || argv.length < 2 || !argv.every((a) => typeof a === 'string')
    || !SERVICE_MANAGERS.includes(argv[0])) {
    throw new TypeError('serviceRun: not a service-manager argv');
  }
  const run = deps && typeof deps.run === 'function' ? deps.run : runServiceManager;
  return run(argv.slice());
}

module.exports = {
  RECORD_VERSION,
  DIR_MODE,
  FILE_MODE,
  SETTINGS_DEFAULTS,
  ensureConnectorDir,
  listRecords,
  readRecord,
  checkRecord,
  recordProblem,
  writeRecord,
  updateRecord,
  newRecord,
  withDefaults,
  ceilingOf,
  hubOrigin,
  keyIdOf,
  fingerprintOf,
  UNIT_LABEL,
  SYSTEMD_NAME,
  SYSTEMD_UNIT,
  SYSTEM_PATH_DIRS,
  unitPaths,
  unitFor,
  platformKind,
  plistText,
  systemdText,
  capturePathEnv,
  serviceArgv,
  serviceRun,
  runServiceManager,
  SERVICE_TIMEOUT_MS,
};
