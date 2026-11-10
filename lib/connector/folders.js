// Folders offered (contract 06 C-06.13, C-06.14, C-06.18; 11 C-11.6):
// `connect offer <path> [--label <text>]`, `connect withdraw <path|id>`,
// `connect folders`, and the watch that tells a running connector the offered
// folders changed.
//
//   offer(path, { label, hubId, deps }) → Promise<{ ok: true, folder, existing? } | { ok: false, refused }>
//   withdraw(pathOrId, { hubId })       → { ok: true, folder } | { ok: false, refused }
//   folders({ hubId })                  → { ok: true, hubId, folders: [{ id, display, label? }] } | { ok: false, refused }
//   install(ctx, { hubId, pollMs })     → stop()   (CONNECTOR@install-seam; U790 wires it)
//
// OFFER resolves the REAL path (a missing path, or one that is not a
// directory, is refused) and refuses, in this order:
//   * `home-directory` — the home directory and anything isHomeDir refuses (a
//     folder holding the user tier, whatever HOME says);
//   * `inside-user-tier` / `contains-user-tier` — ~/.web-chat or anything inside
//     it, and a folder that contains it (the second is beyond C-06.13's list: a
//     folder that holds ~/.web-chat holds the connector's key, which a folder
//     chat's `@` index and file editor would then reach — the hand-off names it);
//   * `inside-workdir` / `contains-workdir` — the record's workdir (C-06.13,
//     C-06.18's converse);
//   * `inside-offered` / `contains-offered` — another offered folder (v1); the
//     SAME real path again is not a refusal: it answers the folder already
//     there (`existing: true`), with no second id and no write.
// Containment is asked of the filesystem (lib/core/paths isInside) over each
// side's canonical spelling (lib/core/portfiles canonicalRoot) — the realpath
// of its nearest existing ancestor plus the rest — so a workdir not made yet, under a HOME reached through a
// link (macOS's /var → /private/var), still fences what lies under it.
//
// A folder with no .web-chat/ directory runs `claude-web-chat init <real>`
// INTERACTIVELY, as a child of the managed bin (./init-child; stdio inherited):
// offering is the terminal consent for web-chat's writes into the folder
// (C-06.13). An init that exits non-zero, or leaves no .web-chat/, offers
// nothing (`init-failed`). Nothing inside the folder's .web-chat/ is read: its
// existence is the one question asked of it.
//
// The folder is recorded as 06-connector-state's $defs/folder: a RANDOM id
// `f_<16 hex>` (crypto, never derived from the path, nor a hash of it), the
// real path, `display` — the path with the home directory shown as `~`, by
// lib/core/paths redactHostPaths' home rule and nothing else (C-11.6; the one
// rule the daemon's masking uses, so there is no second spelling of `~`) — an
// optional label, `access: 'read-write'` and `offered_at`. The write is
// lib/setup/connector.js updateRecord (the record's one writer, under its
// lock), which re-runs every check against the record as it then stands, so a
// racing offer cannot slip a nested folder in; withDefaults writes the
// ceiling only where the user has not set one (C-06.23a).
//
// The hub learns the offered folders' ids, display paths and real paths (and
// the label, access and offered_at the same object carries) through the
// running connector's facts (C-06.14): install()'s callbacks hand the record's
// folder objects to the wiring, and nothing else on the disk. No path a hub
// sends is ever accepted here, and no folder is offered from a frame: only the
// three CLI rows below reach offer and withdraw.
//
// WITHDRAW removes the folder by id or by path (the path's real or resolved
// spelling, so a folder deleted since it was offered can still be withdrawn).
// What its chat does — `refused`, reason `folder-withdrawn`, and its hold
// released — is the running connector's, told through install()'s
// onFolderWithdrawn(id).
//
// INSTALL follows the record (lib/core/watch watchFile, which re-arms after the
// atomic replace every record write is) and, when the offered folders differ
// from what it last saw, calls ctx.onFolderWithdrawn(id) for each folder gone
// and then ctx.onFoldersChanged(folders) once (wired to the machine facts'
// resend, 05 C-05.18 "on change"). A record it cannot read (torn, mid-replace,
// removed) changes nothing it has seen. The hub is ctx.hubId, else the one
// record on the machine (setup.soleHub; v1 pairs with at most one hub, C-06.2).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  userPaths, isInside, isHomeDir, redactHostPaths, WEB_CHAT_DIRNAME,
} = require('../core/paths');
const { canonicalRoot } = require('../core/portfiles');
const { hasForbidden, stripControls } = require('../core/text');
const { stableKey } = require('../core/stable-json');
const { watchFile } = require('../core/watch');
const setup = require('../setup/connector');
const { runInit } = require('./init-child');

const FOLDER_ID_RE = /^f_[0-9a-f]{16}$/;
const LABEL_MAX = 120; // code points, as 06-connector-state's folder.label
const WATCH_POLL_MS = 2000;

// A sentence per refusal, for the CLI. The code is what callers branch on.
const REFUSALS = Object.freeze({
  'not-paired': 'this machine has no connector record; pair it first (claude-web-chat connect <hub-url>)',
  'several-hubs': 'this machine holds more than one hub record (v1 pairs with one hub)',
  'record-unreadable': 'the connector record cannot be read or is not the record\'s shape (see claude-web-chat connect status)',
  missing: 'no such folder',
  'not-a-directory': 'not a folder',
  'bad-label': `a label is at most ${LABEL_MAX} characters, with no control or invisible characters`,
  'home-directory': 'the home directory cannot be offered',
  'inside-user-tier': 'a folder inside ~/.web-chat cannot be offered',
  'contains-user-tier': 'a folder that contains ~/.web-chat cannot be offered',
  'inside-workdir': 'a folder inside the connector\'s workdir cannot be offered',
  'contains-workdir': 'a folder that contains the connector\'s workdir cannot be offered',
  'inside-offered': 'the folder is inside a folder already offered',
  'contains-offered': 'the folder contains a folder already offered',
  'init-failed': 'claude-web-chat init did not set the folder up, so it was not offered',
  'unknown-folder': 'no offered folder has that path or id',
});

const refuse = (code) => ({ ok: false, refused: code });

// ── spelling and containment ───────────────────────────────────────────────

// The NATIVE realpath (null when there is none): it also returns the on-disk
// case, which the JS one does not, so /Users/me/Proj and /Users/me/proj on a
// case-insensitive volume are one folder here, as isHomeDir already holds.
function realOf(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

// Is `child` `parent` or inside it, each side canonical? A root's spelling is
// lib/core/portfiles' `canonicalRoot` (the one `instanceId` hashes, and the one
// ./chats.js fences with): the realpath of its nearest existing ancestor with
// the part that does not exist yet appended.
function within(parent, child) {
  if (!parent || !child) return false;
  return isInside(canonicalRoot(parent), canonicalRoot(child));
}

const hasWebChatDir = (dir) => {
  try { return fs.statSync(path.join(dir, WEB_CHAT_DIRNAME)).isDirectory(); } catch { return false; }
};

// The display path: the home rule of redactHostPaths alone (no project root).
function displayOf(real) {
  return redactHostPaths(real, { root: null });
}

function newFolderId(randomBytes = crypto.randomBytes) {
  return `f_${randomBytes(8).toString('hex')}`;
}

// ── the record ─────────────────────────────────────────────────────────────

// The hub whose record holds the folders: the one given, else the one record
// on the machine (lib/setup/connector.js soleHub, the one rule). → { hubId } |
// refusal.
function pickHub(hubId) {
  if (hubId != null) return { hubId };
  const sole = setup.soleHub();
  return sole.ok ? { hubId: sole.hubId } : refuse(sole.refused);
}

function readFor(hubId) {
  let read;
  try { read = setup.readRecord(hubId); } catch { return refuse('not-paired'); }
  if (read.ok) return { record: read.value };
  if (read.absent) return refuse('not-paired');
  return refuse('record-unreadable');
}

// Every C-06.13 check of `real` against `record`. → refusal | { existing } | null.
function judge(real, record) {
  if (isHomeDir(real)) return refuse('home-directory');
  const tier = userPaths().root;
  if (within(tier, real)) return refuse('inside-user-tier');
  if (within(real, tier)) return refuse('contains-user-tier');
  const workdir = record.workdir;
  if (typeof workdir === 'string' && workdir) {
    if (within(workdir, real)) return refuse('inside-workdir');
    if (within(real, workdir)) return refuse('contains-workdir');
  }
  const folders = Array.isArray(record.folders) ? record.folders : [];
  const same = folders.find((f) => f.path === real);
  if (same) return { existing: same };
  for (const f of folders) {
    if (within(f.path, real)) return refuse('inside-offered');
    if (within(real, f.path)) return refuse('contains-offered');
  }
  return null;
}

function checkLabel(label) {
  if (label == null || label === '') return { label: undefined };
  if (typeof label !== 'string' || hasForbidden(label) || [...label].length > LABEL_MAX) return refuse('bad-label');
  return { label };
}

// updateRecord, with its ERECORD (a torn or misshapen record it will not
// overwrite) answered as a refusal.
function change(hubId, fn) {
  try {
    setup.updateRecord(hubId, fn);
    return null;
  } catch (e) {
    if (e && (e.code === 'ERECORD' || e.code === 'EBADRECORD')) return refuse('record-unreadable');
    if (e && e.code === 'EHUBID') return refuse('not-paired');
    throw e;
  }
}

// ── offer, withdraw, folders ───────────────────────────────────────────────

async function offer(input, { label, hubId, deps = {} } = {}) {
  const checked = checkLabel(label);
  if (checked.refused) return checked;
  if (typeof input !== 'string' || !input) return refuse('missing');
  const hub = pickHub(hubId);
  if (hub.refused) return hub;
  const real = realOf(path.resolve(input));
  if (!real) return refuse('missing');
  let st;
  try { st = fs.statSync(real); } catch { return refuse('missing'); }
  if (!st.isDirectory()) return refuse('not-a-directory');

  const before = readFor(hub.hubId);
  if (before.refused) return before;
  const first = judge(real, before.record);
  if (first && first.refused) return first;
  if (first && first.existing) return { ok: true, folder: { ...first.existing }, existing: true };

  // The terminal consent: init runs interactively, there and then.
  if (!hasWebChatDir(real)) {
    const run = deps.runInit || runInit;
    const code = await run(real, [], { stdio: 'inherit', deps });
    if (code !== 0 || !hasWebChatDir(real)) return refuse('init-failed');
  }

  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  let outcome = null;
  const failed = change(hub.hubId, (record) => {
    if (!record) { outcome = refuse('not-paired'); return null; }
    const verdict = judge(real, record);
    if (verdict && verdict.refused) { outcome = verdict; return null; }
    if (verdict && verdict.existing) { outcome = { ok: true, folder: { ...verdict.existing }, existing: true }; return null; }
    const taken = new Set(record.folders.map((f) => f.id));
    let id;
    do { id = newFolderId(deps.randomBytes); } while (taken.has(id));
    const folder = {
      id,
      path: real,
      display: displayOf(real),
      ...(checked.label !== undefined ? { label: checked.label } : {}),
      access: 'read-write',
      offered_at: now(),
    };
    record.folders.push(folder);
    outcome = { ok: true, folder: { ...folder } };
    return setup.withDefaults(record);
  });
  return failed || outcome;
}

function withdraw(pathOrId, { hubId } = {}) {
  if (typeof pathOrId !== 'string' || !pathOrId) return refuse('unknown-folder');
  const hub = pickHub(hubId);
  if (hub.refused) return hub;
  const byId = FOLDER_ID_RE.test(pathOrId);
  const spellings = byId ? [] : [...new Set([realOf(pathOrId), canonicalRoot(pathOrId), path.resolve(pathOrId)].filter(Boolean))];
  let outcome = null;
  const failed = change(hub.hubId, (record) => {
    if (!record) { outcome = refuse('not-paired'); return null; }
    const at = record.folders.findIndex((f) => (byId ? f.id === pathOrId : spellings.includes(f.path)));
    if (at < 0) { outcome = refuse('unknown-folder'); return null; }
    const [gone] = record.folders.splice(at, 1);
    outcome = { ok: true, folder: { ...gone } };
    return record;
  });
  return failed || outcome;
}

function folders({ hubId } = {}) {
  const hub = pickHub(hubId);
  if (hub.refused) return hub;
  const read = readFor(hub.hubId);
  if (read.refused) return read;
  return {
    ok: true,
    hubId: hub.hubId,
    folders: read.record.folders.map((f) => ({ id: f.id, display: f.display, ...(f.label !== undefined ? { label: f.label } : {}) })),
  };
}

// ── the running connector's watch (CONNECTOR@install-seam) ─────────────────

function install(ctx, { hubId, pollMs = WATCH_POLL_MS, watch = watchFile } = {}) {
  if (!ctx || typeof ctx !== 'object') throw new TypeError('install: a context object is required');
  const chosen = hubId != null ? hubId : ctx.hubId;
  const hub = pickHub(chosen);
  if (hub.refused) throw Object.assign(new Error(`install: ${REFUSALS[hub.refused]}`), { code: hub.refused });
  const file = userPaths().connectorRecord(hub.hubId);
  if (!file) throw Object.assign(new Error('install: not a hub id'), { code: 'not-paired' });

  const snapshot = () => {
    const read = readFor(hub.hubId);
    return read.refused ? null : read.record.folders;
  };
  let seen = snapshot() || [];
  let seenKey = stableKey(seen);

  const call = (fn, ...args) => {
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch { /* the wiring's own failure; the watch carries on */ }
  };

  const w = watch(file, () => {
    const now = snapshot();
    if (!now) return;
    const key = stableKey(now);
    if (key === seenKey) return;
    const ids = new Set(now.map((f) => f.id));
    const gone = seen.filter((f) => !ids.has(f.id)).map((f) => f.id);
    seen = now;
    seenKey = key;
    for (const id of gone) call(ctx.onFolderWithdrawn, id);
    call(ctx.onFoldersChanged, now.map((f) => ({ ...f })));
  }, { pollMs });

  const stop = () => w.stop();
  stop.trigger = (src = 'trigger') => w.trigger(src);
  return stop;
}

// ── the CLI rows (lib/connector/cli.js requires these lazily) ──────────────

const clean = (v) => stripControls(String(v));

function say(deps, result) {
  deps.err(`connect: ${REFUSALS[result.refused] || result.refused}`);
  return 1;
}

function folderLine(f) {
  return `${clean(f.display)}${f.label ? ` "${clean(f.label)}"` : ''} (${f.id})`;
}

// connect offer <path> [--label <text>]
async function offerCommand(args, deps) {
  let target = null;
  let label;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--label') {
      if (i + 1 >= args.length) { deps.err('connect offer: --label needs a value'); return 1; }
      label = args[++i];
    } else if (a.startsWith('--label=')) {
      label = a.slice('--label='.length);
    } else if (a.startsWith('-') && a !== '-') {
      deps.err(`connect offer: unknown option ${clean(a)}`);
      return 1;
    } else if (target === null) {
      target = a;
    } else {
      deps.err('connect offer: one folder at a time');
      return 1;
    }
  }
  if (target === null) { deps.err('usage: claude-web-chat connect offer <path> [--label <text>]'); return 1; }
  const result = await offer(target, { label, deps: deps.folderDeps || {} });
  if (!result.ok) return say(deps, result);
  deps.out(`${result.existing ? 'Already offered' : 'Offered'}: ${folderLine(result.folder)}`);
  return 0;
}

// connect withdraw <path|id>
async function withdrawCommand(args, deps) {
  if (args.length !== 1) { deps.err('usage: claude-web-chat connect withdraw <path|id>'); return 1; }
  const result = withdraw(args[0]);
  if (!result.ok) return say(deps, result);
  deps.out(`Withdrawn: ${folderLine(result.folder)}`);
  return 0;
}

// connect folders
async function foldersCommand(args, deps) {
  if (args.length) { deps.err('usage: claude-web-chat connect folders'); return 1; }
  const result = folders();
  if (!result.ok) {
    if (result.refused === 'not-paired') { deps.out('Connector: not paired'); return 0; }
    return say(deps, result);
  }
  if (!result.folders.length) { deps.out('No folders offered'); return 0; }
  for (const f of result.folders) deps.out(folderLine(f));
  return 0;
}

module.exports = {
  offer,
  withdraw,
  folders,
  install,
  offerCommand,
  withdrawCommand,
  foldersCommand,
  REFUSALS,
  FOLDER_ID_RE,
};
