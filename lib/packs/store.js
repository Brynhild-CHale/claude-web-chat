// The provenance record — what a pack installed, and where it came from.
//
// One record per tier: `.web-chat/packs.json` for a project install,
// `~/.web-chat/packs.json` for `--global`. Components land FLAT in the existing
// tier directories (nesting them under packs/<name>/components/ would need a
// third registry tier, and `use_component` could not resolve it), so this file
// is the only thing that knows a given component belongs to a pack. That makes
// it load-bearing: without it, remove is a guess.
//
// A unit records its files' sha256 at install time. That baseline is what lets
// `remove` tell "we wrote this and nobody touched it" from "the user has been
// editing it", and what lets `list --verify` report drift without diffing
// against a network fetch.
//
// A unit does NOT record an absolute destination. It records kind + name, and
// the directory is resolved from lib/core/paths at read time — so a project that
// gets moved or renamed still reconciles instead of pointing at a path that no
// longer exists.
//
// QUARANTINE records live in the USER tier regardless of the pack's destination
// tier, for the reason codified in lib/core/paths.js for service trust: a
// repository can commit a plausible-looking .web-chat/packs/quarantine/ tree, so
// `approve` re-hashes the staged files and refuses unless a record THIS MACHINE
// wrote matches. A consent record must never be writable by the thing asking for
// consent.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { projectPaths, userPaths, claudePaths, userClaudePaths } = require('../core/paths');
const { writeJsonAtomic, readJsonOr } = require('../core/fsjson');

const STORE_VERSION = 1;
const EMPTY = () => ({ version: STORE_VERSION, packs: [], quarantine: [] });

// Missing or malformed reads as "nothing installed" (readJsonOr collapses absent,
// corrupt and wrong-shape onto EMPTY): a pack record that cannot be parsed must
// not make the daemon unbootable. A record that IS an object is then coerced
// field by field, so one bad key does not discard the rest.
function readStore(file) {
  const data = readJsonOr(file, null, { validate: (d) => d && typeof d === 'object' && !Array.isArray(d) });
  if (!data) return EMPTY();
  return {
    version: data.version || STORE_VERSION,
    packs: Array.isArray(data.packs) ? data.packs : [],
    quarantine: Array.isArray(data.quarantine) ? data.quarantine : [],
  };
}

function writeStore(file, data) {
  // The writer stamps the schema version; callers pass only content.
  return writeJsonAtomic(file, { version: STORE_VERSION, ...data }, { newline: true });
}

// The record file for each tier. 'local' = this project, 'system' = all
// projects — the same two words the components/themes registries already use.
function storeFile(tier, root) {
  return tier === 'system' ? userPaths().packs : projectPaths(root).packs;
}

// Where a unit's files live, resolved fresh from the path authority.
//   component — <tier components dir>/<name>/
//   theme     — <tier themes dir>/            (the unit is one <name>.json file)
//   skill     — <tier .claude>/skills/<name>/ ; the skill FOLLOWS its components'
//               tier, so a skill can never be discoverable somewhere its
//               components are not.
function unitDir(unit, tier, root) {
  const p = tier === 'system' ? userPaths() : projectPaths(root);
  const claude = tier === 'system' ? userClaudePaths() : claudePaths(root);
  if (unit.kind === 'component') return path.join(p.components, unit.name);
  if (unit.kind === 'theme') return p.themesDir;
  if (unit.kind === 'skill') return claude.skillDir(unit.name);
  throw new Error(`unknown pack unit kind: ${unit.kind}`);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(file) {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
}

// A deterministic fingerprint of a whole tree: every relative path plus its
// digest, sorted, hashed. Two trees with the same fingerprint contain the same
// files with the same bytes. This is what quarantine's approve step re-computes
// and compares against the machine-written record.
function treeHash(dir, files) {
  const list = (files || []).slice().sort();
  const h = crypto.createHash('sha256');
  for (const rel of list) {
    h.update(rel);
    h.update('\0');
    h.update(sha256File(path.join(dir, rel)) || '');
    h.update('\n');
  }
  return h.digest('hex');
}

// ── installed packs ─────────────────────────────────────────────────────────

function listPacks(root) {
  const out = [];
  for (const tier of ['local', 'system']) {
    for (const p of readStore(storeFile(tier, root)).packs) out.push({ ...p, tier });
  }
  return out;
}

function findPack(root, name, tier = null) {
  for (const t of tier ? [tier] : ['local', 'system']) {
    const store = readStore(storeFile(t, root));
    const pack = store.packs.find((p) => p.name === name);
    if (pack) return { pack, tier: t, file: storeFile(t, root) };
  }
  return null;
}

// Which installed pack owns a unit of this kind and name, in this tier? Used by
// the planner to tell "another pack already ships a component with this name"
// from "the user wrote one themselves" — two collisions with different answers.
function ownerOf(root, tier, kind, name) {
  for (const p of readStore(storeFile(tier, root)).packs) {
    if ((p.units || []).some((u) => u.kind === kind && u.name === name)) return p.name;
  }
  return null;
}

function upsertPack(root, tier, record) {
  const file = storeFile(tier, root);
  const store = readStore(file);
  store.packs = store.packs.filter((p) => p.name !== record.name);
  store.packs.push(record);
  writeStore(file, store);
  return file;
}

function removePackRecord(root, tier, name) {
  const file = storeFile(tier, root);
  const store = readStore(file);
  const before = store.packs.length;
  store.packs = store.packs.filter((p) => p.name !== name);
  if (store.packs.length !== before) writeStore(file, store);
  return before !== store.packs.length;
}

// ── the pending record (an install in flight) ───────────────────────────────
// Written BEFORE the first byte lands and cleared after the provenance record
// is in place, so an install that was killed between the two is discoverable
// rather than invisible. The audit log cannot serve that purpose on its own:
// `appendAudit` swallows every error by design, so "we logged the failure" is
// not a guarantee anything was logged.
//
// It lives in its OWN file (paths.packsPending), never in packs.json's `packs`
// array, and that separation is the point rather than tidiness: `ownerOf`
// classifies a collision by reading that array, `verifyPack` would report every
// not-yet-written file as missing (⇒ drift ⇒ the drawer chips "locally edited"),
// and `pack list` / GET /api/packs would show a half-install as installed. A
// pending record is a marker, not a pack.
//
// Writing it is also the cheapest possible proof that the record store is
// writable at all — an install that could never have been recorded fails before
// it writes anything into the tree.
function pendingFile(tier, root) {
  return tier === 'system' ? userPaths().packsPending : projectPaths(root).packsPending;
}

function readPendingFile(file) {
  const data = readJsonOr(file, null, { validate: (d) => d && typeof d === 'object' && !Array.isArray(d) });
  return Array.isArray(data && data.pending) ? data.pending : [];
}

function putPending(root, tier, record) {
  const file = pendingFile(tier, root);
  const pending = readPendingFile(file).filter((p) => p && p.name !== record.name);
  pending.push(record);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, { version: STORE_VERSION, pending }, { newline: true });
  return file;
}

// Every in-flight install visible from this project — both tiers, tagged, the
// way listPacks reports installed ones.
function readPending(root, tier = null) {
  const out = [];
  for (const t of tier ? [tier] : ['local', 'system']) {
    for (const p of readPendingFile(pendingFile(t, root))) out.push({ ...p, tier: t });
  }
  return out;
}

function clearPending(root, tier, name) {
  const file = pendingFile(tier, root);
  const pending = readPendingFile(file);
  const kept = pending.filter((p) => p && p.name !== name);
  if (kept.length === pending.length) return false;
  if (kept.length) writeJsonAtomic(file, { version: STORE_VERSION, pending: kept }, { newline: true });
  else { try { fs.unlinkSync(file); } catch {} }
  return true;
}

// ── quarantine (record always user-tier, tree always per-project) ───────────
// The record has to be user-tier — a repository must not be able to forge the
// consent record for its own staged tree — but the TREE it describes lives in
// one project's `.web-chat/packs/quarantine/`. Keying the record on the name
// alone made those two disagree, and every consequence followed from that single
// mismatch: quarantining `acme-ops` in project B dropped project A's record and
// orphaned A's staged tree with no way to discard it (discarding needs the
// record); `pack list` in A reported B's staged packs as `present`, because the
// record carries an absolute `pack_dir`; `pack review acme-ops` in A read B's
// tree; and `pack approve acme-ops` in A installed B's tree into A and then
// deleted it out from under B.
//
// So the key is the PAIR. `root` goes on the record when it is staged, and every
// lookup filters on both halves.
//
// A record staged before this carries no `root`. It is matched from any project
// — refusing to find it would strand a staged tree with no way to discard it —
// and the first rooted record for that name replaces it.
function sameProject(record, root) {
  if (!record) return false;
  if (record.root == null) return true;
  return path.resolve(record.root) === path.resolve(root || '');
}

// `root` omitted means EVERY project: what a caller wants when it is inspecting
// the store itself rather than acting on behalf of one project.
function listQuarantine(root = null) {
  const all = readStore(userPaths().packs).quarantine;
  return root == null ? all : all.filter((q) => sameProject(q, root));
}

function findQuarantine(root, name) {
  return listQuarantine(root).find((q) => q.name === name) || null;
}

function upsertQuarantine(record) {
  const file = userPaths().packs;
  const store = readStore(file);
  store.quarantine = store.quarantine.filter((q) => !(q.name === record.name && sameProject(q, record.root)));
  store.quarantine.push(record);
  writeStore(file, store);
  return file;
}

function removeQuarantineRecord(root, name) {
  const file = userPaths().packs;
  const store = readStore(file);
  const before = store.quarantine.length;
  store.quarantine = store.quarantine.filter((q) => !(q.name === name && sameProject(q, root)));
  if (store.quarantine.length !== before) writeStore(file, store);
  return before !== store.quarantine.length;
}

// ── the audit log ───────────────────────────────────────────────────────────
// Append-only, one JSON object per line, recording `actor` for every mutation.
//
// This is the ONE thing that makes a pane-initiated install discoverable. The
// install endpoint cannot tell a user's click from a pane's fetch — the two are
// byte-identical requests — so it does not try. It records who asked (`http` vs
// `cli`) and what happened, and leaves a trail that can be read afterwards.
//
// DELIBERATELY NOT lib/core/fsjson: this is an append, not a durable record.
// Rewriting the whole log atomically on every entry would make the trail as
// losable as the last write, and a torn LINE is recoverable (readAudit skips it)
// where a torn rewrite is not.
function appendAudit(root, entry) {
  const file = projectPaths(root).packsAudit;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* an unwritable audit log must not fail the operation it records */ }
  return file;
}

function readAudit(root, { limit = 50 } = {}) {
  let text;
  try { text = fs.readFileSync(projectPaths(root).packsAudit, 'utf8'); } catch { return []; }
  const lines = text.split('\n').filter(Boolean);
  const out = [];
  for (const line of lines.slice(-limit)) {
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return out;
}

module.exports = {
  STORE_VERSION,
  readStore,
  writeStore,
  storeFile,
  unitDir,
  sha256,
  sha256File,
  treeHash,
  listPacks,
  findPack,
  ownerOf,
  upsertPack,
  removePackRecord,
  putPending,
  readPending,
  clearPending,
  listQuarantine,
  findQuarantine,
  upsertQuarantine,
  removeQuarantineRecord,
  appendAudit,
  readAudit,
};
