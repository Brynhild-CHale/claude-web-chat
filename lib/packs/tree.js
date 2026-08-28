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
const { verifyTree } = require('./fetch');
const { isInside } = require('../core/paths');
const { assertSafeName } = require('./manifest');

// Verify an installed pack against its recorded digests. Returns
// { drift, units: [{ kind, name, dest, state, files: [...] }] } where a unit's
// state is 'intact' | 'edited' | 'missing'.
function verifyPack(pack, { root, tier } = {}) {
  const units = [];
  let drift = false;
  for (const unit of pack.units || []) {
    const dir = unitDir(unit, tier || pack.tier || 'local', root);
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

// Apply a plan's units. Copies file by file (never a directory move), so the
// only things that land are the ones the plan named and verifyTree already
// cleared. Returns one result row per unit, shaped for printResults.
function applyPlan(plan, { dryRun = false } = {}) {
  const results = [];
  const recorded = [];
  for (const unit of plan.units) {
    const existed = fs.existsSync(unit.dir) && unit.files.some((f) => fs.existsSync(path.join(unit.dir, f.path)));
    if (!dryRun) fs.mkdirSync(unit.dir, { recursive: true });
    const files = [];
    for (const f of unit.files) {
      const dest = path.join(unit.dir, f.path);
      if (!dryRun) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
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
  return { results, units: recorded };
}

// Remove a pack's units under the per-unit rule above. Returns
// { results, removedAll } — `removedAll` is false when anything was kept, which
// is what tells the caller to leave the record in place.
function removeUnits(pack, { root, tier, force = false, dryRun = false } = {}) {
  const verified = verifyPack(pack, { root, tier });
  const results = [];
  let keptAny = false;
  for (const unit of verified.units) {
    const recorded = (pack.units || []).find((u) => u.kind === unit.kind && u.name === unit.name);
    const label = `${unit.kind === 'component' ? 'component' : unit.kind} ${unit.name}`;
    if (unit.state === 'missing') {
      results.push({ dest: label, action: 'already gone', kind: unit.kind, name: unit.name });
      continue;
    }
    if (unit.state === 'edited' && !force) {
      keptAny = true;
      results.push({ dest: label, action: 'kept-edited', kind: unit.kind, name: unit.name, dir: unit.dest });
      continue;
    }
    if (!dryRun) {
      if (unit.kind === 'theme') {
        // A theme unit is one file inside a SHARED directory — never remove the
        // directory itself.
        for (const f of recorded.files) { try { fs.unlinkSync(path.join(unit.dest, f.path)); } catch {} }
      } else {
        // A component/skill unit owns its directory. Remove the recorded files,
        // then the directory if nothing else is left — a stray file the user
        // added means the directory stays.
        for (const f of recorded.files) { try { fs.unlinkSync(path.join(unit.dest, f.path)); } catch {} }
        try {
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
  applyPlan,
  removeUnits,
  stageQuarantine,
  promoteQuarantine,
  discardQuarantineTree,
  printResults,
};
