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
//   * the machine key FILE's one writer (writeMachineKey, U716b): the key
//     written atomically at 0600 and the record's key fields moved in the same
//     critical section under the record's lock — pairing and the link's
//     rotation call it, and no other module opens <hub-id>.key for writing;
//   * `connect rotate`'s one-shot request (requestRotate, readRotateRequest,
//     clearRotateRequest; U726): its own file beside the record, under the
//     record's lock, read and cleared by the running link;
//   * the unit (C-06.6): its label and paths, the platform's kind, and two PURE
//     text builders (a launchd plist, a systemd user unit), each launching
//     through the ~/.local/bin link with a PATH captured at install
//     (capturePathEnv) and its output in the connector's own log;
//   * the service manager's argv (load, unload, restart; C-06.11), PURE
//     arrays, run only through serviceRun's injected runner. The default
//     runner refuses under the Node test runner, so a test that forgot its
//     stub fails instead of touching the user's login session;
//   * the local half of disconnect and revocation (C-06.9, disconnectLocal —
//     one function for `connect disconnect`, a hub revocation inside the
//     service and `uninstall --self`), and the machine's own two settings:
//     the ceiling (setCeiling, the one writer of a value the user chose;
//     C-06.23a) and the local cap (setLocalCap, effectiveCapOf; C-06.23), with
//     the three `connect` rows that drive them (U727).
//
// The connect command writes the unit through these builders and runs the
// argv through serviceRun; disconnectLocal is the one place a unit file is
// removed, and it too runs the unload only through serviceRun.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const crypto = require('crypto');

const { userPaths, installPaths, homeDir, isHubId } = require('../core/paths');
const { readJson, writeJsonAtomic, writeFileAtomic } = require('../core/fsjson');
const { LOCAL_HOSTNAMES, SHUTDOWN_HEADER, SHUTDOWN_HEADER_VALUE } = require('../core/cors');
const { escapeHtml } = require('../core/html');
const { hasForbidden, stripControls } = require('../core/text');
const { findClaude: defaultFindClaude } = require('../core/claude-cli');
const { ceilingOf, readCeiling, CEILINGS } = require('../core/connected-ceiling');
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

// ── the machine key file (C-06.7, C-05.7; K.2-312) ─────────────────────────
// writeMachineKey({hubId, pem, keyId, publicKey, fingerprint, update}) → the
// record as it now stands.
//
// THE ONE WRITER of <hub-id>.key: pairing (lib/connector/pairing.js, the first
// key at `bound`) and the link (lib/connector/link.js, the rotated key at
// key.rotated) call this and write no key file of their own. In ONE critical
// section under the record's lock (<hub-id>.json.lock, updateRecord's):
//   1. the record is read afresh (a torn one throws ERECORD, nothing written);
//   2. the next record is built — `update(copy | null)` when given (pairing's
//      machine and state; synchronous), else the record as it is — and its
//      credential's key_file, key_id, public_key and fingerprint set; it must
//      be the record's shape (EBADRECORD) and exist (ENOTPAIRED) before a byte
//      is written;
//   3. the key file is written atomically (lib/core/fsjson writeFileAtomic:
//      an exclusive 0600 create, fsync, rename), the previous key kept in
//      memory;
//   4. the record is written; when that fails the previous key is put back
//      (or the new file removed when there was none) and the error rethrown,
//      so a failed write leaves the old key and the old record as they were.
// key_id, public_key and fingerprint are derived here from the PEM (keyIdOf,
// fingerprintOf: the one derivation) and a caller's value that differs is
// refused (EKEYMISMATCH) before anything is written. A thrown error carries
// `step` ('record' | 'key') for the caller's message; never the key's text.
// (rotated_at is 03-credential.json's, the hub's record: 06-connector-state's
// credential does not name it, so the connector record cannot hold it.)
function writeMachineKey({ hubId, pem, keyId, publicKey, fingerprint, update } = {}) {
  const keyFile = fileFor(hubId, 'connectorKey');
  const lock = fileFor(hubId, 'connectorRecordLock');
  if (typeof pem !== 'string' || !pem) throw recordError('EKEY', 'writeMachineKey: the key is a PKCS#8 PEM');
  if (update != null && typeof update !== 'function') throw new TypeError('writeMachineKey: update is a function');
  let raw;
  try {
    const priv = crypto.createPrivateKey(pem);
    if (priv.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
    raw = Buffer.from(priv.export({ format: 'jwk' }).x, 'base64url');
  } catch {
    throw recordError('EKEY', 'writeMachineKey: the key is not an Ed25519 PKCS#8 PEM');
  }
  const derived = { key_id: keyIdOf(raw), public_key: raw.toString('base64url'), fingerprint: fingerprintOf(raw) };
  for (const [given, name] of [[keyId, 'key_id'], [publicKey, 'public_key'], [fingerprint, 'fingerprint']]) {
    if (given != null && given !== derived[name]) throw recordError('EKEYMISMATCH', `writeMachineKey: ${name} is not the key's`);
  }
  const stepError = (step, e) => { if (e && typeof e === 'object' && !e.step) e.step = step; return e; };
  try { ensureConnectorDir(); } catch (e) { throw stepError('key', e); }
  return withLockFile(lock, () => {
    const read = readRecord(hubId);
    if (read.corrupt || read.invalid) {
      const e = recordError('ERECORD', `the connector record for ${hubId} is ${read.corrupt ? 'unreadable' : 'not the record\'s shape'}`);
      e.state = read.corrupt ? 'corrupt' : 'invalid';
      throw stepError('record', e);
    }
    const current = read.ok ? structuredClone(read.value) : null;
    const base = update ? update(current) : current;
    if (base && typeof base.then === 'function') throw new TypeError('writeMachineKey: update must be synchronous');
    if (!isPlainObject(base)) throw stepError('record', recordError('ENOTPAIRED', 'this machine has no connector record'));
    if (!isPlainObject(base.hub) || base.hub.id !== hubId) {
      throw stepError('record', recordError('EBADRECORD', `connector record: /hub/id must stay ${hubId}`));
    }
    const next = { ...base, credential: { ...(isPlainObject(base.credential) ? base.credential : {}), key_file: keyFile, ...derived } };
    const problem = recordProblem(next);
    if (problem) throw stepError('record', recordError('EBADRECORD', `connector record: ${problem}`));

    let previous = null;
    try { previous = fs.readFileSync(keyFile); } catch { previous = null; }
    try {
      writeFileAtomic(keyFile, pem, { mode: FILE_MODE, mkdir: false, fsync: true });
    } catch (e) {
      throw stepError('key', e);
    }
    try {
      writeRecord(next);
    } catch (e) {
      try {
        if (previous) writeFileAtomic(keyFile, previous, { mode: FILE_MODE, mkdir: false, fsync: true });
        else fs.unlinkSync(keyFile);
      } catch { /* the record's error is the one reported */ }
      throw stepError('record', e);
    }
    return next;
  });
}

// ── the on-demand rotation request (form 3 CB2 = a; swc-25 Q3; U726) ───────
// `connect rotate` asks the running link for a key.rotate (05 C-05.7) through
// a one-shot request it writes here; the link reads it at its next loop,
// rotates through its built path (writeMachineKey above is still the one key
// writer) and clears it. The request is { rotate_requested_at: <epoch ms> }
// in its OWN 0600 file beside the record — <hub-id>.rotate.json, written and
// cleared under the record's lock (<hub-id>.json.lock) — and not a field of
// the record: 06-connector-state.json is locked with additionalProperties
// false at every level, so a record carrying it would no longer be the
// schema's (the reason U716b kept rotated_at out of it too). A request older
// than the record's credential.paired_at is a leftover from an earlier pairing
// and the link drops it unperformed. A file name with a dot is never a hub id,
// so listRecords never takes it for a record.

function rotateRequestFile(hubId) {
  fileFor(hubId, 'connectorRecord'); // EHUBID for a name that may not be a file
  return path.join(userPaths().connectorDir, `${hubId}.rotate.json`);
}

const isRequestTime = (v) => Number.isInteger(v) && v > 0;

// The pending request's time (epoch ms), or null: none, or a file that is not
// a request (unreadable or the wrong shape reads as none; the next request
// replaces it).
function readRotateRequest(hubId) {
  const r = readJson(rotateRequestFile(hubId), {
    validate: (v) => isPlainObject(v) && Object.keys(v).length === 1 && isRequestTime(v.rotate_requested_at),
  });
  return r.ok ? r.value.rotate_requested_at : null;
}

// Write the request (`at`, default now) under the record's lock; returns the
// time written. ENOTPAIRED unless the record is there and paired; ERECORD for
// a torn record. A request already pending is replaced (one rotation either way).
function requestRotate(hubId, { at = Date.now() } = {}) {
  if (!isRequestTime(at)) throw new TypeError('requestRotate: at is an epoch time in ms');
  const file = rotateRequestFile(hubId);
  ensureConnectorDir();
  return withLockFile(fileFor(hubId, 'connectorRecordLock'), () => {
    const read = readRecord(hubId);
    if (read.corrupt || read.invalid) {
      const e = recordError('ERECORD', `the connector record for ${hubId} is ${read.corrupt ? 'unreadable' : 'not the record\'s shape'}`);
      e.state = read.corrupt ? 'corrupt' : 'invalid';
      throw e;
    }
    if (!read.ok || read.value.credential.state !== 'paired') {
      throw recordError('ENOTPAIRED', 'this machine is not paired with that hub');
    }
    writeJsonAtomic(file, { rotate_requested_at: at }, { mode: FILE_MODE, newline: true, mkdir: false, fsync: true });
    return at;
  });
}

// Clear the request under the record's lock. With `at`, only a request made at
// that time is cleared (a newer one written meanwhile stays for the next
// loop). True when a file was removed.
function clearRotateRequest(hubId, { at } = {}) {
  const file = rotateRequestFile(hubId);
  ensureConnectorDir();
  return withLockFile(fileFor(hubId, 'connectorRecordLock'), () => {
    if (at != null && readRotateRequest(hubId) !== at) return false;
    try {
      fs.unlinkSync(file);
      return true;
    } catch (e) {
      if (e && e.code === 'ENOENT') return false;
      throw e;
    }
  });
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

// ── the one hub on the machine ─────────────────────────────────────────────
// v1 pairs with at most one hub (C-06.2): the hub id of the one record there
// is, or a refusal — 'not-paired' (none) or 'several-hubs'. A torn record still
// names its hub (the file name), so a disconnect can still clean up after it.
function soleHub({ listRecords: list = listRecords } = {}) {
  const records = list();
  if (!records.length) return { ok: false, refused: 'not-paired' };
  if (records.length > 1) return { ok: false, refused: 'several-hubs' };
  return { ok: true, hubId: records[0].hubId, read: records[0].read };
}

// ── the cap (C-06.23) ──────────────────────────────────────────────────────
// The effective cap from the record's settings: the hub's agents_at_once,
// lowered by the machine's local_cap when one is set — a local cap lowers the
// hub's, never raises it. PURE.
const CAP_MAX = 64;

function effectiveCapOf(settings) {
  const s = isPlainObject(settings) ? settings : {};
  const hub = Number.isInteger(s.agents_at_once) ? s.agents_at_once : 0;
  return Number.isInteger(s.local_cap) ? Math.min(hub, s.local_cap) : hub;
}

// `connect cap <n>`'s write: settings.local_cap = n, an integer 0–64 (the
// schema's bounds). Throws EBADCAP for anything else (the record untouched),
// ENOTPAIRED when there is no record; updateRecord's ERECORD for a torn one.
// Returns the record as it now stands.
function setLocalCap(hubId, n) {
  if (!Number.isInteger(n) || n < 0 || n > CAP_MAX) throw recordError('EBADCAP', `the cap is a whole number from 0 to ${CAP_MAX}`);
  let paired = true;
  const out = updateRecord(hubId, (record) => {
    if (!record) { paired = false; return null; }
    record.settings = { ...record.settings, local_cap: n };
    return record;
  });
  if (!paired) throw recordError('ENOTPAIRED', 'this machine has no connector record');
  return out;
}

// ── the ceiling (C-06.23a) ─────────────────────────────────────────────────
// `connect ceiling <read|full>`'s write, and the ONLY writer of a value the
// user chose: no hub frame calls this, and pairing and offering only fill an
// absent key (withDefaults). Exactly 'read' or 'full'; anything else throws
// EBADCEILING before the record is touched. The daemon follows the file
// (lib/core/watch, U742), so a running daemon applies it without a restart.
function setCeiling(hubId, value) {
  if (!CEILINGS.includes(value)) throw recordError('EBADCEILING', `the ceiling is ${CEILINGS.join(' or ')}`);
  let paired = true;
  const out = updateRecord(hubId, (record) => {
    if (!record) { paired = false; return null; }
    record.ceiling = value;
    return record;
  });
  if (!paired) throw recordError('ENOTPAIRED', 'this machine has no connector record');
  return out;
}

// The ceiling as the daemon reads it: lib/core/connected-ceiling.js
// readCeiling over the record's path, fenced to the connector directory —
// the same function, never a second reading.
function ceilingFor(hubId) {
  return readCeiling(fileFor(hubId, 'connectorRecord'), { connectorDir: userPaths().connectorDir });
}

// ── disconnect and revocation (C-06.9) ─────────────────────────────────────
// disconnectLocal({hubId, reason, deps}) → Promise<{ ok, steps, left }>
//
// The local half of C-06.9, ONE function for `connect disconnect`, a hub
// revocation (from inside the service) and `uninstall --self` (U756):
//
//   daemons  the running connector, when deps.viaConnector answers, releases
//            every hold and now-stops every started_by: connector daemon and
//            every daemon on an owned root (only it knows started_by). Else,
//            directly: every chat with owned_root true → daemonFor(root) (the
//            identity-verified record) → POST /api/shutdown with
//            X-WC-Shutdown, its port explicit, noSpawn. A folder chat's daemon
//            that answers is left running and named in `left` (C-06.22: an
//            `other` daemon is only released; U727@offline-disconnect-scope).
//   key      the key file deleted (ENOENT is fine).
//   record   credential.state 'revoked', revoked_at now, key_file dropped;
//            every other field — chats, folders, workdir, the ceiling — kept.
//   unload   the service manager's unload argv through deps.run (a failure is
//            tolerated: the unit was not loaded).
//   unit     the unit file removed; once it is gone (removed, or not there)
//            the record's `service` is set null, so `connect status` names no
//            vanished unit (U716b).
//   socket   the local socket's file removed when present (stale once the
//            service is gone).
//
// The order is the list's, but for reason 'revoked' the unload comes last of
// all: inside the service it ends this very process. Roots, folders and the
// workdir stay on disk; connector-launched tmux sessions are connector mode's
// (alpha.8, REQ@connector-mode) and not touched here.
//
// `ok` is false when a local step could not be done (the key or the unit file
// could not be removed, or the record could not be written); every step runs
// regardless, so a torn record still loses its key and its unit. Step objects
// and `left` carry ids, codes, counts and the chats' roots — never a key, a
// secret or a token.
//
// `hub` says what the hub was told: 'left' when the running connector sent
// machine.leave (viaConnector's answer carries `leave: {sent: true}`; 05 C-05.9:
// the hub revokes the machine and closes 1000), 'revoked' for a revocation
// (the hub's own act: nothing is sent), else 'kept' — the hub keeps this
// machine until it is revoked there (HUB_KEEPS, the sentence `connect
// disconnect` and `uninstall --self` print).
const DISCONNECT_REASONS = Object.freeze(['disconnect', 'revoked', 'uninstall']);
const SHUTDOWN_TIMEOUT_MS = 5000;
const HUB_KEEPS = 'The hub keeps this machine until you revoke it there.';

// The running connector over its local socket, as disconnectLocal's
// viaConnector (U716b; U727-U731@via-connector-socket-op (a)): `ask(request)`
// is the CLI's askConnector bound to the socket path. connector.leave first —
// the link's machine.leave; a connector that cannot send it (its link down)
// still releases — then connector.release-all. → { ok, left, leave: {sent} };
// throws (no connector answering) or answers ok:false when the release was not
// done, which sends disconnectLocal down its direct path. The leave is carried
// out either way (hand fold 7 (i)): a release that fails or throws after the
// hub was told answers `{ok: false, leave}` or throws an error carrying
// `leave`, so disconnectLocal still says the hub was told (the connector
// usually exits on the hub's 1000 close before the second ask is answered).
function viaConnectorSocket(ask) {
  if (typeof ask !== 'function') throw new TypeError('viaConnectorSocket: ask(request) is required');
  return async () => {
    let leave = null;
    try { leave = await ask({ type: 'connector.leave', params: {} }); } catch (e) {
      if (e && e.code === 'ENOCONNECTOR') throw e; // nothing is answering: the direct path
      leave = null;
    }
    const sent = { sent: Boolean(leave && leave.ok === true && leave.result && leave.result.sent) };
    let release;
    try {
      release = await ask({ type: 'connector.release-all', params: {} });
    } catch (e) {
      if (e && typeof e === 'object') e.leave = sent;
      throw e;
    }
    if (!release || release.ok !== true) return { ok: false, leave: sent };
    const result = isPlainObject(release.result) ? release.result : {};
    return {
      ok: true,
      left: Array.isArray(result.left) ? result.left : [],
      leave: sent,
    };
  };
}

function removeFile(file) {
  try {
    const st = fs.lstatSync(file);
    if (st.isDirectory()) return { removed: false, error: 'EISDIR' };
    fs.unlinkSync(file);
    return { removed: true };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { removed: false, absent: true };
    return { removed: false, error: (e && e.code) || 'error' };
  }
}

function disconnectDeps(deps = {}) {
  return {
    viaConnector: typeof deps.viaConnector === 'function' ? deps.viaConnector : null,
    client: deps.client || require('../client'),
    daemonFor: typeof deps.daemonFor === 'function' ? deps.daemonFor : require('../util/registry').daemonFor,
    run: typeof deps.run === 'function' ? deps.run : undefined,
    now: typeof deps.now === 'function' ? deps.now : Date.now,
    uid: deps.uid,
    platform: deps.platform,
  };
}

async function stopDaemonsDirectly(chats, d) {
  const stopped = [];
  const left = [];
  for (const c of chats) {
    let rec = null;
    try { rec = await d.daemonFor(c.root); } catch { rec = null; }
    if (!rec || !Number.isInteger(rec.port)) continue; // no daemon answers for that root
    if (!c.owned_root) {
      left.push({ chat_id: c.chat_id, scope_kind: c.scope_kind, root: c.root, why: 'other' });
      continue;
    }
    let acked = false;
    let error = null;
    try {
      const body = await d.client.post('/api/shutdown', { reason: 'connect disconnect' }, {
        port: rec.port,
        noSpawn: true,
        timeout: SHUTDOWN_TIMEOUT_MS,
        headers: { [SHUTDOWN_HEADER]: SHUTDOWN_HEADER_VALUE },
      });
      acked = Boolean(body && body.ok);
    } catch (e) {
      error = (e && (e.code || e.status)) || 'error';
    }
    if (acked) stopped.push(c.chat_id);
    else left.push({ chat_id: c.chat_id, scope_kind: c.scope_kind, root: c.root, why: 'not-stopped', ...(error ? { error: String(error) } : {}) });
  }
  return { stopped, left };
}

async function disconnectLocal({ hubId, reason = 'disconnect', deps } = {}) {
  if (!DISCONNECT_REASONS.includes(reason)) throw new TypeError(`disconnectLocal: reason is one of ${DISCONNECT_REASONS.join(', ')}`);
  const keyFile = fileFor(hubId, 'connectorKey');
  const socketFile = fileFor(hubId, 'connectorSocket');
  const d = disconnectDeps(deps);
  const steps = [];
  let left = [];
  let ok = true;

  const read = readRecord(hubId);
  const record = read.ok ? read.value : null;
  const chats = record ? record.chats : [];

  // (a) the holds and the now stops (and, through the connector, the leave).
  let answered = false;
  let hub = reason === 'revoked' ? 'revoked' : 'kept';
  if (d.viaConnector) {
    let answer = null;
    let leave = null;
    try {
      answer = await d.viaConnector();
      leave = answer && answer.leave;
    } catch (e) {
      answer = null;
      leave = e && e.leave;
    }
    answered = Boolean(answer) && answer.ok !== false;
    // The leave stands whether or not the release was done (hand fold 7 (i)).
    if (reason !== 'revoked' && isPlainObject(leave) && leave.sent === true) hub = 'left';
    if (answered) {
      left = Array.isArray(answer.left) ? answer.left.slice() : [];
      steps.push({ step: 'daemons', via: 'connector' });
    }
  }
  if (!answered) {
    const direct = await stopDaemonsDirectly(chats, d);
    left = direct.left;
    steps.push({ step: 'daemons', via: 'direct', stopped: direct.stopped, ...(record ? {} : { record: read.absent ? 'absent' : 'unreadable' }) });
  }

  // (b) the key.
  const key = removeFile(keyFile);
  if (key.error) ok = false;
  steps.push({ step: 'key', removed: key.removed, ...(key.error ? { error: key.error } : {}) });

  // (c) the record: revoked, the key file no longer named.
  let recordStep;
  try {
    let present = true;
    updateRecord(hubId, (r) => {
      if (!r) { present = false; return null; }
      const credential = { ...r.credential, state: 'revoked', revoked_at: d.now() };
      delete credential.key_file;
      return { ...r, credential };
    });
    recordStep = { step: 'record', state: present ? 'revoked' : 'absent' };
  } catch (e) {
    ok = false;
    recordStep = { step: 'record', state: 'unwritten', error: (e && (e.state || e.code)) || 'error' };
  }
  steps.push(recordStep);

  // (d) the unit, and (e) the stale socket. The kind is the record's, else
  // the platform's; the file is the kind's contracted path (unitFor), never a
  // path read out of a record.
  const kind = (record && record.service && record.service.kind) || platformKind(d.platform || process.platform);
  const unitFile = kind ? unitFor(kind).unit_path : null;
  const installed = Boolean(record && record.service) || Boolean(unitFile && fs.existsSync(unitFile));
  const unload = () => {
    if (!kind || !installed) { steps.push({ step: 'unload', ran: false }); return; }
    try {
      const argv = serviceArgv(kind, { ...(d.uid != null ? { uid: d.uid } : {}), plist: unitFile }).unload;
      serviceRun(argv, { deps: { run: d.run } });
      steps.push({ step: 'unload', ran: true });
    } catch (e) {
      // Not loaded (or not loadable): tolerated, the unit file still goes.
      steps.push({ step: 'unload', ran: true, tolerated: (e && (e.code || e.status)) ? String(e.code || e.status) : 'error' });
    }
  };
  // Once the unit file is gone the record names no service (U716b): a
  // record already without one, or none at all, is left as it is.
  const forgetService = () => {
    try {
      updateRecord(hubId, (r) => (r && r.service != null ? { ...r, service: null } : null));
      return null;
    } catch (e) {
      ok = false;
      return (e && (e.state || e.code)) || 'error';
    }
  };
  const unitRemove = () => {
    const u = unitFile ? removeFile(unitFile) : { removed: false, absent: true };
    if (u.error) ok = false;
    const serviceError = u.error ? null : forgetService();
    steps.push({
      step: 'unit', removed: u.removed,
      ...(u.error ? { error: u.error } : {}),
      ...(serviceError ? { record_error: String(serviceError) } : {}),
    });
  };
  const socketRemove = () => {
    const s = removeFile(socketFile);
    steps.push({ step: 'socket', removed: s.removed, ...(s.error ? { error: s.error } : {}) });
  };

  if (reason === 'revoked') {
    unitRemove();
    socketRemove();
    unload();
  } else {
    unload();
    unitRemove();
    socketRemove();
  }
  return { ok, reason, steps, left, hub };
}

// ── the CLI rows (lib/connector/cli.js's table calls these) ───────────────
// disconnect, ceiling and cap. Each answers the exit code and prints through
// deps.out / deps.err; nothing printed is a key, a secret or a token.

const cleanText = (v) => stripControls(String(v));
const NOT_PAIRED = 'Connector: not paired';
const HUB_REFUSALS = Object.freeze({
  'several-hubs': 'connect: this machine holds more than one hub record (v1 pairs with one hub)',
});

function pickFor(deps) {
  return soleHub({ listRecords: typeof deps.listRecords === 'function' ? deps.listRecords : listRecords });
}

async function disconnectCommand(args, deps) {
  if (args.length) { deps.err('usage: claude-web-chat connect disconnect'); return 1; }
  const hub = pickFor(deps);
  if (!hub.ok) {
    if (hub.refused === 'not-paired') { deps.out(`${NOT_PAIRED}; nothing to disconnect`); return 0; }
    deps.err(HUB_REFUSALS[hub.refused] || `connect: ${hub.refused}`);
    return 1;
  }
  // The running connector: deps.viaConnector as given, else built over
  // deps.ask (askConnector bound to the socket; U790 binds it) — leave, then
  // release-all.
  const via = deps.viaConnector || (typeof deps.ask === 'function' ? viaConnectorSocket(deps.ask) : null);
  const r = await disconnectLocal({
    hubId: hub.hubId,
    reason: 'disconnect',
    deps: { ...(deps.disconnectDeps || {}), ...(via ? { viaConnector: via } : {}), ...(deps.run ? { run: deps.run } : {}) },
  });
  deps.out(`Disconnected this machine from hub ${hub.hubId}:`);
  for (const s of r.steps) {
    if (s.step === 'daemons') {
      deps.out(s.via === 'connector'
        ? '  the running connector released every hold and stopped its daemons'
        : `  stopped ${s.stopped.length} daemon${s.stopped.length === 1 ? '' : 's'} on owned roots (the connector was not running)`);
    } else if (s.step === 'key') {
      deps.out(s.error ? `  the machine key could not be deleted (${s.error})` : `  the machine key ${s.removed ? 'deleted' : 'was already gone'}`);
    } else if (s.step === 'record') {
      deps.out(s.state === 'revoked' ? '  the record marked revoked'
        : s.state === 'absent' ? '  no record to mark' : `  the record could not be marked revoked (${s.error})`);
    } else if (s.step === 'unload') {
      deps.out(!s.ran ? '  no start-at-login unit to unload' : s.tolerated ? '  the unit was not loaded' : '  the unit unloaded');
    } else if (s.step === 'unit') {
      deps.out(s.error ? `  the unit file could not be removed (${s.error})` : `  the unit file ${s.removed ? 'removed' : 'was not there'}`);
    } else if (s.step === 'socket') {
      if (s.removed) deps.out('  the stale local socket removed');
    }
  }
  for (const l of r.left) {
    const where = l.root ? ` at ${cleanText(l.root)}` : '';
    deps.out(l.why === 'other'
      ? `  left running: chat ${cleanText(l.chat_id)}'s daemon${where} (not started by the connector; stop it with claude-web-chat stop there)`
      : `  left running: chat ${cleanText(l.chat_id)}'s daemon${where} did not stop`);
  }
  deps.out(r.hub === 'left'
    ? '  the hub was told this machine is leaving (it revokes the machine there)'
    : `  ${HUB_KEEPS}`);
  deps.out('Chat roots, offered folders and the workdir stay on disk.');
  return r.ok ? 0 : 1;
}

async function ceilingCommand(args, deps) {
  if (args.length > 1) { deps.err('usage: claude-web-chat connect ceiling [read|full]'); return 1; }
  if (args.length === 1 && !CEILINGS.includes(args[0])) {
    deps.err(`connect ceiling: the ceiling is ${CEILINGS.join(' or ')}`);
    return 1;
  }
  const hub = pickFor(deps);
  if (!hub.ok) {
    if (hub.refused === 'not-paired') {
      if (!args.length) { deps.out(NOT_PAIRED); return 0; }
      deps.err(`${NOT_PAIRED}; pair it first (claude-web-chat connect <hub-url>)`);
      return 1;
    }
    deps.err(HUB_REFUSALS[hub.refused] || `connect: ${hub.refused}`);
    return 1;
  }
  if (args.length === 1) {
    try {
      setCeiling(hub.hubId, args[0]);
    } catch (e) {
      if (e && (e.code === 'ERECORD' || e.code === 'EBADRECORD' || e.code === 'ENOTPAIRED')) {
        deps.err('connect: the connector record cannot be read or is not the record\'s shape (see claude-web-chat connect status)');
        return 1;
      }
      throw e;
    }
  }
  deps.out(`Ceiling: ${ceilingFor(hub.hubId)}`);
  if (args.length === 1) {
    deps.out('Running daemons apply it at once (they follow the record); no hub frame changes it.');
  }
  return 0;
}

async function capCommand(args, deps) {
  const usage = 'usage: claude-web-chat connect cap <n>   (a whole number from 0 to 64)';
  if (args.length !== 1 || !/^(0|[1-9][0-9]{0,1})$/.test(args[0]) || Number(args[0]) > CAP_MAX) {
    deps.err(usage);
    return 1;
  }
  const n = Number(args[0]);
  const hub = pickFor(deps);
  if (!hub.ok) {
    deps.err(hub.refused === 'not-paired' ? `${NOT_PAIRED}; pair it first (claude-web-chat connect <hub-url>)` : (HUB_REFUSALS[hub.refused] || `connect: ${hub.refused}`));
    return 1;
  }
  let record;
  try {
    record = setLocalCap(hub.hubId, n);
  } catch (e) {
    if (e && (e.code === 'ERECORD' || e.code === 'EBADRECORD' || e.code === 'ENOTPAIRED')) {
      deps.err('connect: the connector record cannot be read or is not the record\'s shape (see claude-web-chat connect status)');
      return 1;
    }
    throw e;
  }
  const s = record.settings;
  deps.out(`Local cap: ${n}`);
  deps.out(`Effective cap: ${effectiveCapOf(s)} (the lesser of the hub's ${s.agents_at_once} and the local ${n}; a local cap never raises the hub's)`);
  return 0;
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
  writeMachineKey,
  rotateRequestFile,
  readRotateRequest,
  requestRotate,
  clearRotateRequest,
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
  soleHub,
  CAP_MAX,
  effectiveCapOf,
  setLocalCap,
  setCeiling,
  ceilingFor,
  DISCONNECT_REASONS,
  HUB_KEEPS,
  viaConnectorSocket,
  disconnectLocal,
  disconnectCommand,
  ceilingCommand,
  capCommand,
};
