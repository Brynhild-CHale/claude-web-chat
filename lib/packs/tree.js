// Moving files, and the one rule that governs taking them away again.
//
// ── Removal is per UNIT, not per file. ──────────────────────────────────────
// A component is a directory of four files. If the user edited `component.html`
// and `remove` deleted the other three, what is left is a broken half-component
// that the registry still lists and `use_component` still resolves — a worse
// state than either "gone" or "kept". So:
//
//   every recorded file still matches its baseline  → the whole unit is removed
//   ANY recorded file differs (or is missing)       → the whole unit is KEPT and
//                                                     released to the user as
//                                                     their own
//   --force                                         → removed regardless
//
// which is the same edit-preserving instinct the managed-file reconcile has, and
// it prints through the same printResults with the same action vocabulary.

const fs = require('fs');
const path = require('path');
const { printResults } = require('../update/managed-files');
const { unitDir, sha256File, treeHash, upsertQuarantine, findQuarantine } = require('./store');
const { verifyTree, memberEscapes } = require('./fetch');
const { isInside, nearestExisting, homeDir } = require('../core/paths');
const { assertSafeName, NAME_RE } = require('./manifest');

// ── the installed record is UNTRUSTED INPUT ─────────────────────────────────
// It lives in the PROJECT tier (.web-chat/packs.json), and lib/packs/store.js
// says out loud why that matters: a repository can commit a plausible-looking
// .web-chat/ tree, which is the reason quarantine records were moved to the
// user tier. The install record was not given the same treatment — every path
// this file unlinks is built by joining `unit.name` and `f.path` straight out
// of it. A cloned repo carrying a record whose unit names a directory outside
// the project shows up in `pack list` as an installed pack, and the documented
// recovery (`pack remove <name>`) then deletes whatever the record named.
//
// So the record is validated at READ time, in one place, before any path
// derived from it is used. A unit that fails is not repaired and not partially
// applied: it is refused whole, reported, and skipped.
//
// ── what the fence is anchored to, and why it is not the unit directory ─────
// Fencing each recorded file against the unit's OWN directory is not enough,
// because that directory is derived from the record and its existence on disk
// is attacker-controlled too: git commits symlinks, so a hostile repository can
// ship `.web-chat/components/deploy-board -> /outside` (or `.web-chat/themes ->
// /outside`) and then BOTH sides of `isInside(dir, abs)` resolve through the
// same link and agree. The fence has to start at the first point on the path
// the repository cannot forge:
//
//   local tier  → the project root. A clone can commit anything INSIDE it,
//                 including every segment of `.web-chat/...`, but it cannot
//                 place a file above the root it was cloned into.
//   system tier → the user's home. The record itself is user-tier there
//                 (~/.web-chat/packs.json) so a repository cannot write it at
//                 all; the anchor is defence in depth, and the home is the
//                 widest thing that still excludes `/etc` and `/`.
//
// Both checks are realpath-based, so the anchor holds however deep the link is.
// The one cost is honest and stated: a system-tier unit whose `~/.claude` is a
// symlink OUT of the home is refused rather than removed, with the reason
// printed — a refusal, not a deletion, and recoverable by hand.
function recordAnchor(tier, root) {
  return tier === 'system' ? homeDir() : root;
}

// The anchor check has to survive a directory that is not there. `isInside` is
// realpath-based on BOTH sides and falls back to path.resolve for a path that
// cannot be resolved — so when the anchor is itself reached through a symlink
// (macOS $TMPDIR, a checkout or a $HOME that is a link) the two sides disagree
// and a legitimately-absent unit directory reads as an escape. That is the
// sharp edge lib/core/paths states out loud, and here it would turn "already
// gone" into a refusal no --force can clear.
//
// So fence the nearest ancestor that DOES exist (`nearestExisting`, in the path
// authority beside `isInside` — the file-editor service's fence needs the same
// walk, and one answer to "what can I realpath here" is enough). The tail below
// it is safe by construction and not by luck: `unitDir` builds the path by
// joining a NAME_RE-checked name (or, for a theme, a constant) onto the path
// authority, so it contains no `..` to walk back out with — and a directory that
// is absent has nothing under it to unlink anyway. A committed
// `.web-chat/components -> /outside` still exists, so it is still the ancestor
// that gets resolved, and it is still refused.
//
// This is deliberately the FOLLOWING walk (`nearestExisting`'s default), not the
// lstat one `fence` uses: this side only ever UNLINKS, and a dangling link is
// nothing to remove — unlinking it removes the link, and there is no tail under
// it to reach. A fence over a path about to be WRITTEN has to stop at the link
// itself, because the write lands at its target.

function unitRecordFault(unit, dir, anchor) {
  if (!unit || typeof unit !== 'object') return 'the record entry is not an object';
  // The name builds a directory for a component or a skill. A theme unit's dir
  // is the shared themes directory and ignores the name entirely, so there the
  // file paths are the load-bearing half.
  if (unit.kind !== 'theme' && !NAME_RE.test(String(unit.name == null ? '' : unit.name))) {
    return `unit name ${JSON.stringify(String(unit.name))} is not a plain kebab-case name, and that name builds a directory path`;
  }
  // The unit directory itself, against the unforgeable anchor — resolved at the
  // nearest existing ancestor (see nearestExisting), so this catches a
  // committed symlink anywhere in `.web-chat/...` without refusing a unit whose
  // directory is simply gone.
  if (!anchor || !isInside(anchor, nearestExisting(dir))) {
    return `unit directory ${dir} resolves outside ${anchor || '(no anchor)'}`;
  }
  if (unit.files != null && !Array.isArray(unit.files)) {
    // A non-iterable `files` would throw out of the loop below and take
    // `pack list --verify` and the drawer with it. The record is untrusted
    // input: a wrong shape is a refusal, not an exception.
    return `the record's file list is ${unit.files === null ? 'null' : typeof unit.files}, not an array`;
  }
  for (const f of unit.files || []) {
    const rel = f && f.path;
    if (typeof rel !== 'string' || !rel || memberEscapes(rel)) {
      // Same predicate the pre-extraction archive gate uses: absolute, a drive
      // letter, or any `..` segment. Shape first, because a path that does not
      // exist cannot be realpath'd.
      return `file path ${JSON.stringify(rel === undefined ? null : rel)} escapes the unit directory`;
    }
    const abs = path.join(dir, rel);
    // Then the filesystem, for anything actually there — isInside is
    // realpath-based, so a subdirectory that is a symlink pointing out of the
    // unit is caught even though the relative path looks innocent. A path that
    // is not there is left alone: unlinking it would be a no-op regardless.
    if (fs.existsSync(abs) && !isInside(dir, abs)) {
      return `file path ${JSON.stringify(rel)} resolves outside ${dir}`;
    }
  }
  return null;
}

// Verify an installed pack against its recorded digests. Returns
// { drift, units: [{ kind, name, dest, state, files: [...] }] } where a unit's
// state is 'intact' | 'edited' | 'missing' | 'refused'. A 'refused' unit counts
// as drift: the record disagrees with anything this machine could have written,
// which is precisely when a caller should stop rather than proceed.
function verifyPack(pack, { root, tier } = {}) {
  const units = [];
  let drift = false;
  const effectiveTier = tier || pack.tier || 'local';
  const anchor = recordAnchor(effectiveTier, root);
  for (const unit of pack.units || []) {
    let dir;
    try {
      dir = unitDir(unit, effectiveTier, root);
    } catch (e) {
      // An unknown `kind` — unitDir throws rather than guessing a directory.
      drift = true;
      units.push({ kind: unit && unit.kind, name: unit && unit.name, dest: null, state: 'refused', refused: e.message, files: [] });
      continue;
    }
    const fault = unitRecordFault(unit, dir, anchor);
    if (fault) {
      drift = true;
      units.push({ kind: unit.kind, name: unit.name, dest: dir, state: 'refused', refused: fault, files: [] });
      continue;
    }
    const files = [];
    let missing = 0;
    let edited = 0;
    for (const f of unit.files || []) {
      const abs = path.join(dir, f.path);
      const actual = sha256File(abs);
      const state = actual == null ? 'missing' : (actual === f.sha256 ? 'intact' : 'edited');
      if (state === 'missing') missing++;
      if (state === 'edited') edited++;
      files.push({ path: f.path, state, abs });
    }
    const state = edited ? 'edited' : (missing === files.length && files.length ? 'missing' : (missing ? 'edited' : 'intact'));
    if (state !== 'intact') drift = true;
    units.push({ kind: unit.kind, name: unit.name, dest: dir, state, files });
  }
  return { drift, units };
}

// ── the same-pack diff ──────────────────────────────────────────────────────
// What a NEW version of a pack no longer ships. `applyPlan` only ever copies
// what the plan names, and `upsertPack` replaces the record wholesale, so
// without this nothing looks at the previous record at all: a v2 that dropped
// `service.js` left v1's file on disk, where `has_service` is computed from disk
// presence and service trust is keyed to the file's (unchanged) bytes — the old,
// already-trusted service kept running under the new pack's record.
//
// PURE, deliberately: `pack install --dry-run` and the drawer must be able to
// show what an update would delete without deleting it.
//
// The diff is per unit AND per file, and it returns synthetic *record* units —
// the same `{ kind, name, files: [{ path, sha256 }] }` shape `verifyPack` and
// `removeUnits` already consume. That is what makes the edited-file rule apply
// file-precisely: a component that survives into v2 minus one file yields a unit
// carrying only that file, so the digest check covers exactly the bytes being
// taken away, and the directory survives because `readdir` is non-empty.
function droppedUnits(previousUnits, planUnits) {
  const out = [];
  const now = new Map();
  for (const u of planUnits || []) now.set(`${u.kind}:${u.name}`, u);
  for (const prev of previousUnits || []) {
    if (!prev || typeof prev !== 'object') continue;
    const kept = now.get(`${prev.kind}:${prev.name}`);
    const files = Array.isArray(prev.files) ? prev.files : [];
    if (!kept) {
      // The whole unit is gone from the new version.
      if (files.length) out.push({ kind: prev.kind, name: prev.name, files: files.slice() });
      continue;
    }
    const survives = new Set((kept.files || []).map((f) => f && f.path));
    const dropped = files.filter((f) => f && !survives.has(f.path));
    if (dropped.length) out.push({ kind: prev.kind, name: prev.name, files: dropped });
  }
  return out;
}

// ── the undo journal ────────────────────────────────────────────────────────
// A pack install writes into directories it does not own wholesale — components/
// live FLAT in the tier directory, a theme is one file in the SHARED themes
// directory, a skill lands under `.claude/skills/` — so the stage-then-rename
// trick the release installer and `symlinkAtomic` use is unavailable here: there
// is no directory to rename over. What is available is an undo list.
//
// Everything the apply is about to do is recorded first: a file that did not
// exist is remembered as a creation, a file that did is COPIED ASIDE before it
// is clobbered, and every directory the apply had to create is remembered as
// having been created here. On any throw, `rollback()` replays that list in
// reverse.
//
// Two rules the snapshot half exists for, both learned from the finding:
//
//   * Unlink-only rollback is a REGRESSION for the case that matters most. A
//     failed same-pack update would delete v1's files (or the user's, under
//     --replace) rather than restoring them. The copy aside is load-bearing.
//   * Rollback rmdirs ONLY directories this apply created, and only while they
//     are empty. A theme unit's directory is the shared themes directory and a
//     skill's sits under `.claude/skills` — removing either because it happened
//     to be empty would be a new bug of exactly the class being fixed here.
//
// The snapshots go to `projectPaths(root).packsBackup` (`~/.web-chat` for a
// system-tier install), which the path authority has always defined; `commit()`
// drops them, and so does `rollback()` once they have been replayed. `rollback()`
// is idempotent — it clears the list — so applyPlan unwinding on its own throw
// and a caller unwinding the whole transaction cannot double-restore.
//
// ── the double fault, and why failures are STICKY ───────────────────────────
// Two callers unwind the same journal: `applyPlan` on its own throw, and
// `installFromStage` on any throw in the whole transaction. Because rollback()
// clears the entry list, the second call has nothing left to replay — so if the
// failures were forgotten with the entries, the owner of the transaction would
// see `[]` and report a clean rollback for a tree that is half-applied. That is
// the case that matters most: ENOSPC and EACCES make the RESTORE fail for the
// same reason the apply did.
//
// So a failure is remembered for the life of the journal and returned by every
// later rollback(), and a rollback that did not finish does NOT drop the
// snapshot directory — those copies are at that point the only remaining copy
// of the bytes that were overwritten, and `backupDir` names the directory so the
// caller can put it in front of a human.
function beginJournal({ backupDir } = {}) {
  const entries = [];
  const failures = [];
  let dir = null;
  let seq = 0;

  function backupRoot() {
    if (!dir) {
      fs.mkdirSync(backupDir, { recursive: true });
      dir = fs.mkdtempSync(path.join(backupDir, 'apply-'));
    }
    return dir;
  }

  // Copy the current bytes aside. The name is sequence-prefixed because two
  // units can legitimately carry the same basename (`meta.json`, `SKILL.md`).
  function snapshot(abs) {
    const to = path.join(backupRoot(), `${String(seq++).padStart(4, '0')}-${path.basename(abs)}`);
    fs.copyFileSync(abs, to);
    let mode = null;
    try { mode = fs.statSync(abs).mode & 0o777; } catch {}
    return { to, mode };
  }

  function drop() {
    if (!dir) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    dir = null;
  }

  return {
    // mkdir -p, recording only the segments that were NOT already there.
    mkdir(target) {
      const missing = [];
      for (let cur = target; !fs.existsSync(cur); cur = path.dirname(cur)) {
        missing.unshift(cur);
        if (path.dirname(cur) === cur) break;
      }
      fs.mkdirSync(target, { recursive: true });
      for (const m of missing) entries.push({ op: 'mkdir', path: m });
    },
    created(dest) { entries.push({ op: 'create', path: dest }); },
    overwriting(dest) { entries.push({ op: 'overwrite', path: dest, ...snapshot(dest) }); },
    removing(dest) { entries.push({ op: 'remove', path: dest, ...snapshot(dest) }); },
    // Replay in reverse. Returns the failures rather than throwing: a rollback
    // that cannot finish must still report the original error, and the caller
    // rides these into the audit line, the pending marker and the error message.
    //
    // The returned list is CUMULATIVE (see the header): every later call reports
    // the same failures, so whichever caller unwinds last still knows the tree
    // was left half-applied.
    rollback() {
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        try {
          if (e.op === 'create') {
            try { fs.unlinkSync(e.path); } catch (err) { if (err.code !== 'ENOENT') throw err; }
          } else if (e.op === 'overwrite' || e.op === 'remove') {
            fs.mkdirSync(path.dirname(e.path), { recursive: true });
            fs.copyFileSync(e.to, e.path);
            if (e.mode != null) fs.chmodSync(e.path, e.mode);
          } else if (e.op === 'mkdir') {
            // Empty-only, by rmdirSync's own contract. A directory something
            // else has since put a file in is left alone.
            try { fs.rmdirSync(e.path); } catch (err) { if (err.code !== 'ENOTEMPTY' && err.code !== 'ENOENT') throw err; }
          }
        } catch (err) {
          failures.push(`${e.op} ${e.path}: ${err.message}`);
        }
      }
      entries.length = 0;
      // Only a finished unwind may delete the snapshots. If a restore failed,
      // the copy aside is the last copy of the previous bytes there is.
      if (!failures.length) drop();
      return failures.slice();
    },
    commit() { entries.length = 0; drop(); },
    get size() { return entries.length; },
    get failures() { return failures.slice(); },
    // null once the snapshots have been dropped — so a caller reading this after
    // a failed rollback always gets a directory that is actually still there.
    get backupDir() { return dir; },
  };
}

// Apply a plan's units. Copies file by file (never a directory move), so the
// only things that land are the ones the plan named and verifyTree already
// cleared. Returns one result row per unit, shaped for printResults.
//
// With a `journal` the whole loop is one transaction: every creation, every
// overwrite and every directory it had to make is recorded first, and any throw
// unwinds them in reverse before rethrowing — so a caller's contract becomes
// today's plus "nothing landed". Existence is tracked PER FILE here (the
// per-unit `existed` below is only the printResults label), because inside one
// unit an overwrite has to be restored where a creation has to be unlinked.
function applyPlan(plan, { dryRun = false, journal = null } = {}) {
  const results = [];
  const recorded = [];
  const mkdir = (d) => { if (journal) journal.mkdir(d); else fs.mkdirSync(d, { recursive: true }); };
  try {
    for (const unit of plan.units) {
      const existed = fs.existsSync(unit.dir) && unit.files.some((f) => fs.existsSync(path.join(unit.dir, f.path)));
      if (!dryRun) mkdir(unit.dir);
      const files = [];
      for (const f of unit.files) {
        const dest = path.join(unit.dir, f.path);
        if (!dryRun) {
          mkdir(path.dirname(dest));
          // Recorded BEFORE the copy, both branches: a copyFileSync that throws
          // can still have truncated the destination, so "we were about to
          // touch this" is the only claim that is true either way.
          if (journal) {
            if (fs.existsSync(dest)) journal.overwriting(dest); else journal.created(dest);
          }
          fs.copyFileSync(f.src, dest);
          fs.chmodSync(dest, 0o644);
        }
        files.push({ path: f.path, sha256: f.sha256 });
      }
      recorded.push({ kind: unit.kind, name: unit.name, files });
      results.push({
        dest: `${unit.kind === 'component' ? 'component' : unit.kind} ${unit.name}`,
        action: existed ? 'overwritten' : 'created',
        kind: unit.kind,
        name: unit.name,
        dir: unit.dir,
      });
    }
  } catch (e) {
    if (journal) journal.rollback();
    throw e;
  }
  return { results, units: recorded };
}

// Remove a pack's units under the per-unit rule above. Returns
// { results, removedAll } — `removedAll` is false when anything was kept, which
// is what tells the caller to leave the record in place.
//
// `journal` is optional and changes nothing about the rule, the results
// vocabulary or what gets unlinked. It exists so the deletions an *install*
// performs (the previous-minus-new prune) are reversible along with that
// install's writes: a `pack remove` from a terminal passes none and behaves
// exactly as before.
function removeUnits(pack, { root, tier, force = false, dryRun = false, journal = null } = {}) {
  const verified = verifyPack(pack, { root, tier });
  const results = [];
  let keptAny = false;
  for (const unit of verified.units) {
    const recorded = (pack.units || []).find((u) => u.kind === unit.kind && u.name === unit.name);
    const label = `${unit.kind === 'component' ? 'component' : unit.kind} ${unit.name}`;
    if (unit.state === 'refused') {
      // Nothing is unlinked for this unit, and `removedAll` goes false so the
      // caller keeps the record — deleting it would hide the evidence of a
      // record that should be looked at by a human.
      keptAny = true;
      results.push({ dest: label, action: 'refused', reason: unit.refused, kind: unit.kind, name: unit.name, dir: unit.dest });
      continue;
    }
    if (unit.state === 'missing') {
      results.push({ dest: label, action: 'already gone', kind: unit.kind, name: unit.name });
      continue;
    }
    if (unit.state === 'edited' && !force) {
      keptAny = true;
      results.push({ dest: label, action: 'kept-edited', kind: unit.kind, name: unit.name, dir: unit.dest });
      continue;
    }
    // One unlink, journalled when the caller asked for one: the bytes are copied
    // aside first, so a rollback restores the file rather than leaving a hole.
    const unlink = (abs) => {
      try {
        if (journal && fs.existsSync(abs)) journal.removing(abs);
        fs.unlinkSync(abs);
      } catch {}
    };
    if (!dryRun) {
      if (unit.kind === 'theme') {
        // A theme unit is one file inside a SHARED directory — never remove the
        // directory itself.
        for (const f of recorded.files) unlink(path.join(unit.dest, f.path));
      } else {
        // A component/skill unit owns its directory. Remove the recorded files,
        // then the directory if nothing else is left — a stray file the user
        // added means the directory stays.
        for (const f of recorded.files) unlink(path.join(unit.dest, f.path));
        try {
          // Not journalled, and it does not need to be: the journal's restore
          // re-creates each file's parent directory before copying the bytes
          // back, so an emptied-then-removed unit directory comes back with it.
          if (!fs.readdirSync(unit.dest).length) fs.rmdirSync(unit.dest);
        } catch {}
      }
    }
    results.push({
      dest: label,
      // Always 'removed' — the files were unlinked. It used to say 'overwritten'
      // for an edited unit, which is the one case where the report has to be
      // exact: the user is being told what happened to work they did themselves,
      // and "overwritten" and "deleted" are not the same news.
      action: 'removed',
      kind: unit.kind,
      name: unit.name,
      dir: unit.dest,
    });
  }
  return { results, removedAll: !keptAny, drift: verified.drift };
}

// ── quarantine ──────────────────────────────────────────────────────────────
// Inert BY LOCATION: the staged tree goes to .web-chat/packs/quarantine/<name>/
// and NOTHING reads .web-chat/packs/. No registry tier points there, no route
// serves from there, the service supervisor never sees it. That is a stronger
// guarantee than a flag someone has to remember to check.
//
// DELIBERATELY NOT JOURNALLED, and it is that same location that earns the
// exemption. stageQuarantine has applyPlan's shape — an unconditional rmSync of
// the previous staging directory, then a copy loop with no undo — but almost
// none of its stakes: the tree lands where nothing reads, treeHash and
// upsertQuarantine happen LAST, and promoteQuarantine re-hashes and refuses a
// mismatch. A torn stage therefore cannot be installed. It can only orphan an
// inert directory and invalidate the previous record's tree, which `pack get`
// repairs by re-staging. Wrapping it in the journal would add a rollback path
// whose failure mode is the one it is protecting against.

function stageQuarantine({ stageDir, files, name, quarantineRoot, tier, source, plan, manifest }) {
  // `name` came out of the pack's own manifest. install.js refuses a name that
  // is not plain kebab-case before it gets here; this is the second check, at
  // the site that actually does the destructive part — the rm below. A traversal
  // reaching this line would delete a directory of the user's choosing and then
  // write a stranger's files into it.
  assertSafeName(name);
  const dir = path.join(quarantineRoot, name);
  if (!isInside(quarantineRoot, dir)) {
    const e = new Error(`refusing to stage "${name}": it resolves outside the quarantine directory`);
    e.userFacing = true;
    throw e;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  const packDir = path.join(dir, 'pack');
  fs.mkdirSync(packDir, { recursive: true });
  for (const rel of files) {
    const dest = path.join(packDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(stageDir, rel), dest);
    fs.chmodSync(dest, 0o644);
  }
  const tree_sha256 = treeHash(packDir, files);
  const record = {
    name,
    tier,
    dir,
    pack_dir: packDir,
    staged_at: new Date().toISOString(),
    source,
    tree_sha256,
    files,
    version: manifest && manifest.version,
    description: manifest && manifest.description,
    // Every component the pack would install, not just the ones carrying a
    // service.js — the review card lists these, and "what would this add?" is
    // the first question a reviewer asks.
    components: (plan && plan.units || []).filter((u) => u.kind === 'component').map((u) => ({
      name: u.name, description: u.description || '', has_service: Boolean(u.has_service), has_seed: Boolean(u.has_seed),
    })),
    services: (plan && plan.services) || [],
    skill: (plan && plan.skill) || null,
    collisions: (plan && plan.collisions) || [],
    errors: (plan && plan.errors) || [],
  };
  // plan.json sits beside the tree so `review` reads the SAME plan the install
  // would apply, rather than recomputing one that could differ.
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({
    ...record,
    units: (plan && plan.units || []).map((u) => ({
      kind: u.kind, name: u.name, dir: u.dir, files: u.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })),
    })),
  }, null, 2) + '\n');
  // The integrity record is USER-tier — see the note in lib/packs/store.js.
  upsertQuarantine(record);
  return record;
}

// Re-hash a staged tree and refuse unless a record THIS MACHINE wrote matches.
// A repository can commit a plausible-looking quarantine directory; it cannot
// forge the user-tier record, and it cannot make the bytes hash to something
// they do not.
function promoteQuarantine(name) {
  assertSafeName(name);
  const record = findQuarantine(name);
  if (!record) {
    const e = new Error(`nothing is quarantined under "${name}" on this machine. If you see a .web-chat/packs/quarantine/${name} directory, it was not staged here — refusing it.`);
    e.userFacing = true;
    throw e;
  }
  const packDir = record.pack_dir || path.join(record.dir, 'pack');
  if (!fs.existsSync(packDir)) {
    const e = new Error(`the quarantined tree for "${name}" is gone (${packDir}) — re-download it with \`claude-web-chat pack get\``);
    e.userFacing = true;
    throw e;
  }
  // Same structural gate the fetch applied, re-run on what is actually on disk
  // now: a symlink or a non-regular file appearing between staging and approval
  // is refused exactly as it would have been at download time.
  const files = verifyTree(packDir);
  const actual = treeHash(packDir, files);
  if (actual !== record.tree_sha256) {
    const e = new Error(`the quarantined tree for "${name}" no longer matches what was downloaded (${actual.slice(0, 12)}… vs ${String(record.tree_sha256).slice(0, 12)}…) — refusing to install it. Discard it and fetch again.`);
    e.userFacing = true;
    throw e;
  }
  return { record, stageDir: packDir, files };
}

function discardQuarantineTree(record) {
  try { fs.rmSync(record.dir, { recursive: true, force: true }); } catch {}
}

module.exports = {
  verifyPack,
  beginJournal,
  droppedUnits,
  applyPlan,
  removeUnits,
  stageQuarantine,
  promoteQuarantine,
  discardQuarantineTree,
  printResults,
};
