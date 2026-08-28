// The pack pipeline's front door: fetch → validate → plan → apply → record.
//
// Everything below is shared verbatim by the CLI and the HTTP routes, and every
// mutation records `actor` ('cli' | 'http') in the audit log. That is deliberate
// and it is the honest half of a risk the maintainer has accepted knowingly:
//
//   Pane scripts run via `new Function` in the window realm with `fetch`, under
//   no CSP. `POST /api/packs/install` is therefore reachable by any pane, and
//   the endpoint cannot tell a user's click from a pane's `fetch` — the two are
//   byte-identical requests. The warning copy protects a human who reads it; it
//   does not protect against a pane, and nothing delivered to the page can.
//
// What that does NOT weaken, and what the code below keeps closed:
//
//   * a BUILTIN component name is a hard refusal, no override, either tier,
//     either actor;
//   * a user's own same-named component is never silently replaced (`--replace`
//     is terminal-only — the routes do not accept it);
//   * `service.js` still cannot run without `claude-web-chat trust`, and a
//     freshly-installed service is unapproved by construction (consent is keyed
//     to the file's hash);
//   * every install / quarantine / remove appends to .web-chat/packs/audit.log
//     with its actor, so a pane-initiated install is at least discoverable.

const fs = require('fs');
const path = require('path');
const { projectPaths, userPaths } = require('../core/paths');
const { packageVersion } = require('../core/versions');
const { fetchPack } = require('./fetch');
const { parseManifest, validateManifest, assertSafeName } = require('./manifest');
const { planInstall } = require('./plan');
const {
  listPacks, findPack, upsertPack, removePackRecord, appendAudit,
  putPending, readPending, clearPending,
  listQuarantine, findQuarantine, removeQuarantineRecord,
} = require('./store');
const {
  applyPlan, removeUnits, verifyPack, beginJournal, droppedUnits,
  stageQuarantine, promoteQuarantine, discardQuarantineTree,
} = require('./tree');

function refuse(msg, extra = {}) {
  const e = new Error(msg);
  e.userFacing = true;
  Object.assign(e, extra);
  return e;
}

const normTier = (t) => (t === 'system' || t === 'global' || t === true ? 'system' : 'local');

// Read + validate a staged tree. Returns the validated manifest view, or throws
// userFacing when the tree is not a pack at all.
function inspectStage(stageDir) {
  const raw = parseManifest(stageDir);
  return validateManifest(raw, { stageDir, webChatVersion: packageVersion() });
}

// Everything from a verified staged tree onward — shared by a direct install and
// by approving a quarantined one, so the two cannot diverge.
function installFromStage({ stageDir, files, source, tier, root, replace = false, actor = 'cli', log = () => {}, via = 'install' }) {
  const manifest = inspectStage(stageDir);
  // Belt and braces: validateManifest already refuses a name that is not plain
  // kebab-case (and !manifest.ok throws below), but the name goes on to build
  // the skill's directory path, and "some other check happens to cover it" is
  // exactly the reasoning that fails later.
  assertSafeName(manifest.name);
  if (!manifest.ok) {
    throw refuse(`this pack cannot be installed:\n  - ${manifest.errors.join('\n  - ')}`, { errors: manifest.errors, warnings: manifest.warnings });
  }
  const plan = planInstall({ stageDir, manifest, tier, root, replace });
  if (plan.errors.length) {
    throw refuse(`this pack cannot be installed:\n  - ${plan.errors.join('\n  - ')}`, {
      errors: plan.errors, collisions: plan.collisions, warnings: manifest.warnings,
    });
  }

  // ── the transaction ───────────────────────────────────────────────────────
  // Everything from here to `journal.commit()` is one reversible operation:
  //
  //   1. read the PREVIOUS record before it is replaced, and diff it against the
  //      plan — what this version no longer ships;
  //   2. write the pending marker, which is also the cheapest proof the record
  //      store is writable (an install that could never be recorded stops here,
  //      having written nothing into the tree);
  //   3. apply, journalled — every creation, every overwrite, every directory
  //      created;
  //   4. prune what the new version dropped, AFTER the apply and through the
  //      same journal. After, not before: the two sets are disjoint by
  //      construction, so applying first means a mid-apply failure never has to
  //      restore deletions as well as writes;
  //   5. record, audit, drop the snapshots.
  //
  // Any throw in 3-5 unwinds the whole thing and rethrows, so the caller's
  // contract is today's plus "nothing landed". What this does NOT make safe is
  // two installs at once — there is no lock around an install, and a
  // pane-initiated POST racing a terminal one still interleaves two journals
  // over the same destinations.
  const previous = findPack(root, manifest.name, tier);
  const dropped = previous ? droppedUnits(previous.pack.units, plan.units) : [];
  const journal = beginJournal({
    backupDir: tier === 'system' ? userPaths().packsBackup : projectPaths(root).packsBackup,
  });
  const startedAt = new Date().toISOString();
  const plannedUnits = plan.units.map((u) => `${u.kind}:${u.name}`);
  putPending(root, tier, {
    name: manifest.name, version: manifest.version, status: 'applying', via, actor,
    started_at: startedAt, pid: process.pid, source, units: plannedUnits,
  });

  let results;
  let units;
  let pruned = [];
  let record;
  try {
    ({ results, units } = applyPlan(plan, { journal }));
    if (dropped.length) pruned = prune({ dropped, plan, name: manifest.name, root, tier, journal });
    record = {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      source,
      installed_at: new Date().toISOString(),
      web_chat_version: packageVersion(),
      skill: plan.skill,
      services: plan.services,
      units,
    };
    upsertPack(root, tier, record);
  } catch (e) {
    // Cumulative, deliberately: applyPlan already unwound on its own throw, and
    // the journal remembers what failed then (see beginJournal) — otherwise this
    // second call would report a clean rollback for a half-applied tree.
    const failures = journal.rollback();
    if (failures.length) {
      // ── the double fault ────────────────────────────────────────────────────
      // The unwind itself could not finish. This is not a rare corner: ENOSPC
      // and EACCES on a directory make the RESTORE fail for the same reason the
      // apply did. The tree is now half-applied, and every piece of evidence
      // about it has to be kept rather than tidied away:
      //
      //   * the SNAPSHOTS stay (the journal does not drop them) — they are the
      //     only remaining copy of the bytes that were overwritten;
      //   * the PENDING MARKER stays, rewritten as `rollback-failed`, naming the
      //     snapshot directory, so `pack list` and GET /api/packs report it and
      //     a human can find those bytes;
      //   * the audit line says `rolled_back:false`, because it did not;
      //   * and the failures go into the ERROR MESSAGE, because the CLI's die()
      //     and the route's fail() print `e.message` and nothing else, while
      //     appendAudit is allowed by design to swallow its own write.
      const backupDir = journal.backupDir;
      try {
        putPending(root, tier, {
          name: manifest.name, version: manifest.version, status: 'rollback-failed', via, actor,
          started_at: startedAt, failed_at: new Date().toISOString(), pid: process.pid, source,
          units: plannedUnits, error: e.message, rollback_errors: failures,
          ...(backupDir ? { backup_dir: backupDir } : {}),
        });
      } catch { /* the marker is best-effort here; the message below is not */ }
      appendAudit(root, {
        op: via, actor, pack: manifest.name, tier, ok: false, error: e.message,
        rolled_back: false, rollback_errors: failures, ...(backupDir ? { backup_dir: backupDir } : {}),
      });
      e.rollbackErrors = failures;
      e.backupDir = backupDir || null;
      e.message = `${e.message}\n\n  the rollback could not finish — "${manifest.name}" is half-applied:\n` +
        failures.map((f) => `    - ${f}`).join('\n') +
        (backupDir ? `\n  the previous bytes are still in ${backupDir}` : '') +
        `\n  \`claude-web-chat pack list\` reports this under interrupted installs.`;
      throw e;
    }
    // The ordinary path: the transaction finished by unwinding, so there is no
    // interrupted install to report and nothing left to recover from.
    try { clearPending(root, tier, manifest.name); } catch {}
    appendAudit(root, {
      op: via, actor, pack: manifest.name, tier, ok: false, error: e.message, rolled_back: true,
    });
    throw e;
  }
  journal.commit();
  clearPending(root, tier, manifest.name);
  // `pruned` carries a row per unit the diff looked at, and most of those rows
  // are NOT deletions: 'kept-edited' (the user's own work, deliberately left
  // alone), 'already gone', 'refused'. Logging all of them as `removed` would
  // record a deletion that did not happen in the one case where the record has
  // to be exact — what an update did to work the user did themselves. So the
  // audit line reports the two outcomes separately, by the action each row
  // actually got.
  const label = (r) => `${r.kind}:${r.name}`;
  const removed = pruned.filter((r) => r.action === 'pruned').map(label);
  const keptEdited = pruned.filter((r) => r.action === 'kept-edited').map(label);
  appendAudit(root, {
    op: via, actor, pack: manifest.name, tier, sha: source && source.sha,
    url: source && source.url, via: source && source.via, sums_verified: Boolean(source && source.sums_verified),
    units: units.map((u) => `${u.kind}:${u.name}`),
    ...(removed.length ? { removed } : {}),
    ...(keptEdited.length ? { kept: keptEdited } : {}),
  });

  return { ok: true, pack: record, tier, results: [...results, ...pruned], plan, manifest, warnings: manifest.warnings };
}

// ── the same-pack prune ─────────────────────────────────────────────────────
// Re-installing a pack IS the advertised update (planInstall labels the
// collision 'a straight update'), and until this ran it was a half-reconcile:
// applyPlan copies only what the new plan names, so a v2 that dropped
// `service.js` left v1's file on disk — where `has_service` is read from disk
// presence and service trust is keyed to the file's unchanged bytes.
//
// The deletions go through `removeUnits` so the per-unit edited-file rule
// governs them exactly as it governs `pack remove`: a dropped file the user has
// since edited is KEPT and released to them, not quietly deleted by an update.
// (Which is also why keeping it is safe: an edited leftover no longer matches
// its trust key, so it cannot run.)
function prune({ dropped, plan, name, root, tier, journal }) {
  const { results } = removeUnits({ name, units: dropped }, { root, tier, journal });
  const survives = new Set(plan.units.map((u) => `${u.kind}:${u.name}`));
  return results.map((r) => {
    const partial = survives.has(`${r.kind}:${r.name}`);
    const files = partial
      ? (dropped.find((d) => d.kind === r.kind && d.name === r.name) || { files: [] }).files.map((f) => f.path).join(', ')
      : null;
    return {
      ...r,
      // A unit that SURVIVES minus a file would otherwise print two rows with
      // the same label ("component x overwritten" / "component x removed"),
      // which reads as a contradiction. Name the files instead, and give the
      // action its own word so an update's deletions are never mistaken for a
      // removal the user asked for.
      dest: partial ? `${r.dest} · ${files}` : r.dest,
      action: r.action === 'removed' ? 'pruned' : r.action,
    };
  });
}

// ── install (fetch straight into place) ─────────────────────────────────────
async function installPack({ url, ref = null, asset = null, tier = 'local', root, replace = false, actor = 'cli', log = () => {} } = {}) {
  const t = normTier(tier);
  const fetched = await fetchPack({ url, ref, asset, tmpDir: tmpFor(root), log });
  try {
    return installFromStage({
      stageDir: fetched.stageDir, files: fetched.files, source: fetched.source,
      tier: t, root, replace, actor, log, via: 'install',
    });
  } finally {
    fetched.cleanup();
  }
}

// ── quarantine (fetch + verify + stage only) ────────────────────────────────
// The advised default for anything the user did not write themselves. Nothing
// is installed, nothing is registered, and the staged tree sits somewhere no
// part of web-chat reads.
async function quarantinePack({ url, ref = null, asset = null, tier = 'local', root, actor = 'cli', log = () => {} } = {}) {
  const t = normTier(tier);
  const fetched = await fetchPack({ url, ref, asset, tmpDir: tmpFor(root), log });
  try {
    const manifest = inspectStage(fetched.stageDir);
    // A pack with errors is STILL staged: the whole point of quarantine is to
    // let a human look at something before deciding, and "it would not install"
    // is one of the more useful things for them to be able to see.
    const plan = planInstall({ stageDir: fetched.stageDir, manifest, tier: t, root, replace: false });
    // The name becomes a DIRECTORY. Check it before it is joined to anything —
    // quarantine stages packs that failed validation on purpose, so "validation
    // would have caught it" is not available here.
    const name = assertSafeName(manifest.name || nameFromUrl(url));
    const record = stageQuarantine({
      stageDir: fetched.stageDir,
      files: fetched.files,
      name,
      quarantineRoot: projectPaths(root).quarantine,
      tier: t,
      source: fetched.source,
      plan: { ...plan, skill: plan.skill, errors: [...manifest.errors, ...plan.errors] },
      manifest,
    });
    appendAudit(root, {
      op: 'quarantine', actor, pack: record.name, tier: t, sha: fetched.source.sha,
      url: fetched.source.url, via: fetched.source.via, sums_verified: fetched.source.sums_verified,
    });
    return { ok: true, record, manifest, plan };
  } finally {
    fetched.cleanup();
  }
}

// Read-only: everything a human needs to decide. Returns the manifest view, the
// plan, the file tree with sizes, and (on request) the text of one file.
function reviewQuarantine({ name, root, file = null, maxBytes = 512 * 1024 } = {}) {
  assertSafeName(name);
  const record = findQuarantine(name);
  if (!record) throw refuse(`nothing is quarantined under "${name}"`);
  const packDir = record.pack_dir || path.join(record.dir, 'pack');
  if (!fs.existsSync(packDir)) throw refuse(`the quarantined tree for "${name}" is gone — fetch it again`);

  let manifest = null;
  let manifestError = null;
  try { manifest = inspectStage(packDir); } catch (e) { manifestError = e.message; }

  let plan = null;
  try { plan = JSON.parse(fs.readFileSync(path.join(record.dir, 'plan.json'), 'utf8')); } catch {}

  const tree = (record.files || []).map((rel) => {
    let bytes = 0;
    try { bytes = fs.statSync(path.join(packDir, rel)).size; } catch {}
    return { path: rel, bytes };
  });

  let text = null;
  if (file) {
    const rel = String(file).split(path.sep).join('/');
    if (!(record.files || []).includes(rel)) throw refuse(`"${rel}" is not part of the quarantined pack "${name}"`);
    const abs = path.join(packDir, rel);
    // The tree walk above tolerates a file that has gone missing since staging
    // (it reports bytes: 0), so this must too — an unguarded statSync threw a raw
    // ENOENT, which the CLI printed as "pack failed: ENOENT…" and the HTTP route
    // answered with a 500, breaking the 200/ok:false convention everything else
    // in this module keeps.
    let size;
    try { size = fs.statSync(abs).size; } catch {
      throw refuse(`"${rel}" is recorded in the quarantined pack "${name}" but is no longer on disk — discard it and fetch again`);
    }
    text = size > maxBytes
      ? `${fs.readFileSync(abs, 'utf8').slice(0, maxBytes)}\n\n… truncated (${size} bytes)`
      : fs.readFileSync(abs, 'utf8');
  }

  return { ok: true, record, manifest, manifestError, plan, tree, file: file || null, text };
}

// ── approve / discard ───────────────────────────────────────────────────────
function approvePack({ name, root, tier = null, replace = false, actor = 'cli', log = () => {} } = {}) {
  const { record, stageDir, files } = promoteQuarantine(name);
  const out = installFromStage({
    stageDir, files, source: record.source,
    tier: normTier(tier || record.tier), root, replace, actor, log, via: 'approve',
  });
  removeQuarantineRecord(name);
  discardQuarantineTree(record);
  return out;
}

function discardPack({ name, root, actor = 'cli' } = {}) {
  assertSafeName(name);
  const record = findQuarantine(name);
  if (!record) throw refuse(`nothing is quarantined under "${name}"`);
  discardQuarantineTree(record);
  removeQuarantineRecord(name);
  appendAudit(root, { op: 'discard', actor, pack: name, tier: record.tier });
  return { ok: true, name };
}

// ── remove ──────────────────────────────────────────────────────────────────
// The per-unit rule (see lib/packs/tree.removeUnits) does the work: a unit whose
// recorded files all still match is removed; a unit with ANY edited file is kept
// and released to the user as their own. `force` removes regardless.
//
// `refuseOnDrift` is what the HTTP route passes, and only the route. From a
// terminal, "remove this pack" can safely mean "remove what I did not touch and
// tell me what you kept" — the user sees the report and the edited units are
// still there. Over HTTP the endpoint cannot tell a user's click from a pane's
// fetch, so it declines to act on a pack the user has edited at all and hands
// back the terminal command instead.
function removePackByName({ name, root, tier = null, force = false, refuseOnDrift = false, actor = 'cli', dryRun = false } = {}) {
  const found = findPack(root, name, tier ? normTier(tier) : null);
  if (!found) throw refuse(`no pack called "${name}" is installed here`);
  const { pack } = found;
  const verified = verifyPack(pack, { root, tier: found.tier });
  // A dry run REPORTS the drift rather than refusing on it: "what would this do"
  // is exactly the question a user asks when they suspect they have edits.
  if (verified.drift && !force && refuseOnDrift && !dryRun) {
    const listing = verified.units.filter((u) => u.state !== 'intact')
      .map((u) => `  ${u.kind} ${u.name}: ${u.state}${u.refused ? ` — ${u.refused}` : ''}`).join('\n');
    // A refused unit is NOT "local edits", and the terminal will not remove it
    // either — the refusal is deliberate and survives --force. Handing back the
    // terminal command here would be two wrong statements in one sentence, and
    // the drawer prints this text verbatim.
    if (verified.units.some((u) => u.state === 'refused')) {
      throw refuse(
        `"${name}" has an installed record that did not validate — nothing was removed.\n` +
        listing +
        `\nThe record lives in .web-chat/packs.json and wants a human: no removal, forced or not, acts on a refused unit.`,
        { drift: true, refused: true, units: verified.units },
      );
    }
    throw refuse(
      `"${name}" has local edits — not removing it from here.\n` +
      listing +
      `\nRun \`claude-web-chat pack remove ${name}\` in a terminal: it removes what you have not touched and keeps what you have.`,
      { drift: true, units: verified.units, command: `claude-web-chat pack remove ${name}` },
    );
  }
  const { results, removedAll } = removeUnits(pack, { root, tier: found.tier, force, dryRun });
  if (!dryRun) {
    if (removedAll) removePackRecord(root, found.tier, name);
    else {
      // Something was kept. The record stays, minus what actually went, so a
      // later `remove --force` still knows what it is looking at.
      // 'refused' rides along with 'kept-edited': a unit whose record failed
      // validation was not touched, and dropping it from the record would erase
      // the only evidence that something wrote a hostile entry.
      const keptNames = new Set(results.filter((r) => r.action === 'kept-edited' || r.action === 'refused').map((r) => `${r.kind}:${r.name}`));
      const units = (pack.units || []).filter((u) => keptNames.has(`${u.kind}:${u.name}`));
      // Trim the summary fields to match. `skill` and `services` are convenience
      // copies of what the units say; leaving them behind made `pack list`
      // advertise `skill: .claude/skills/<pack>/SKILL.md` for a file the same
      // removal had just deleted.
      const keptComponents = new Set(units.filter((u) => u.kind === 'component').map((u) => u.name));
      upsertPack(root, found.tier, {
        ...pack,
        units,
        skill: keptNames.has(`skill:${pack.name}`) ? pack.skill : null,
        services: (pack.services || []).filter((n) => keptComponents.has(n)),
      });
    }
    appendAudit(root, { op: 'remove', actor, pack: name, tier: found.tier, force: Boolean(force), removed_all: removedAll });
  }
  return { ok: true, name, tier: found.tier, results, removedAll, drift: verified.drift };
}

// ── listing ─────────────────────────────────────────────────────────────────
function listInstalled({ root, verify = false } = {}) {
  const packs = listPacks(root).map((p) => {
    const base = {
      name: p.name, version: p.version, description: p.description, tier: p.tier,
      source: p.source, installed_at: p.installed_at, skill: p.skill || null,
      services: p.services || [],
      units: (p.units || []).map((u) => ({ kind: u.kind, name: u.name, files: (u.files || []).length })),
      components: (p.units || []).filter((u) => u.kind === 'component').map((u) => u.name),
    };
    if (!verify) return base;
    const v = verifyPack(p, { root, tier: p.tier });
    return { ...base, drift: v.drift, unit_states: v.units.map((u) => ({ kind: u.kind, name: u.name, state: u.state })) };
  });
  const quarantined = listQuarantine().map((q) => ({
    name: q.name, tier: q.tier, staged_at: q.staged_at, source: q.source, version: q.version,
    description: q.description, components: q.components || [], services: q.services || [], skill: q.skill || null,
    files: (q.files || []).length, errors: q.errors || [], collisions: q.collisions || [],
    present: fs.existsSync(q.pack_dir || path.join(q.dir || '', 'pack')),
  }));
  // Reported ALONGSIDE the installed packs, never among them: a pending record
  // means an install started here and never finished, which is a thing to tell
  // a human about and never a thing to treat as installed.
  const pending = readPending(root).map((p) => ({
    name: p.name, version: p.version || null, tier: p.tier, status: p.status || 'applying',
    started_at: p.started_at || null, via: p.via || null, actor: p.actor || null,
    source: p.source || null, units: p.units || [],
    // Only a 'rollback-failed' marker carries these, and they are the whole
    // recovery: what could not be undone, and where the previous bytes are.
    error: p.error || null,
    rollback_errors: p.rollback_errors || [],
    backup_dir: p.backup_dir || null,
  }));
  return { packs, quarantined, pending };
}

function tmpFor(root) {
  // Stage inside the project's own .web-chat so the eventual move is a rename on
  // the same filesystem, not a cross-device copy.
  const dir = path.join(projectPaths(root).packsDir, 'tmp');
  try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch { return undefined; }
}

function nameFromUrl(url) {
  const m = String(url || '').replace(/\.git$/, '').match(/([^/]+)\/?$/);
  return (m ? m[1] : 'pack').toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

module.exports = {
  installPack,
  quarantinePack,
  reviewQuarantine,
  approvePack,
  discardPack,
  removePackByName,
  listInstalled,
  installFromStage,
  inspectStage,
  normTier,
};
