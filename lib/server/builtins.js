const fs = require('fs');
const path = require('path');

// Seeding the builtin components, and the boot-time repair that gives the
// reserved-name policy its teeth.
//
// The LIST itself lives in lib/core/names.js — lib/packs needs it too, and
// `lib/packs → lib/server` is backwards. `BUILTINS` is re-exported from here so
// the server layer keeps the name it has always used for it.
//
// seedBuiltins below only refreshes a directory whose meta.json says
// `builtin: true`. A component pack that shipped a directory named
// `git-dashboard` would therefore win PERMANENTLY: its meta.json says nothing of
// the sort, so every later boot leaves the shadowing copy in place and the real
// builtin never comes back. That is why a builtin name is a hard refusal at
// every name entry, in either tier, for either actor, with no override —
// asserted through lib/core/names.assertComponentName.
const { BUILTIN_COMPONENTS, BUILTIN_ELEMENT_PACK } = require('../core/names');
const { installFromStage } = require('../packs/install');
const { findPack, findLedgerEntry, treeHash } = require('../packs/store');
const { verifyPack } = require('../packs/tree');
const { elementFiles, elementSrcDir } = require('../packs/elements');
const { unitsOf } = require('../packs/kinds');
const { readJson } = require('../core/fsjson');

const BUILTINS = BUILTIN_COMPONENTS;
const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates', 'components');
// The built-in element types, shipped as a pack (PLAN.md 2C.2, DECISIONS.md B2).
const ELEMENTS_TEMPLATE_DIR = path.join(__dirname, '..', '..', 'templates', 'elements', BUILTIN_ELEMENT_PACK);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// Seed / refresh the builtin components, and REPORT any that are shadowed.
//
// The refusal at every name entry is prospective: it stops a new shadow, it
// cannot undo one a build without that refusal already wrote. A marker-less
// directory under a builtin name is left strictly alone here — overwriting it
// would silently destroy whatever the user has since edited into it — so the
// only remediation is for someone to know it is there. Hence the report: the
// names are returned (for tests and callers) and named on stderr once per boot,
// with the directory to delete to get the real builtin back.
function seedBuiltins(paths, { log = console.warn } = {}) {
  const shadowed = [];
  for (const name of BUILTINS) {
    const src = path.join(TEMPLATES_DIR, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(paths.COMPONENTS_DIR, name);
    const metaPath = path.join(dest, 'meta.json');
    const present = fs.existsSync(metaPath);
    if (!present) {
      copyDir(src, dest);
      continue;
    }
    // refresh builtin files (component.html + meta.json) if marked builtin
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.builtin) copyDir(src, dest);
      else shadowed.push({ name, dir: dest });
    } catch {
      copyDir(src, dest);
    }
  }
  if (shadowed.length && typeof log === 'function') {
    for (const s of shadowed) {
      log(`web-chat: the built-in component "${s.name}" is shadowed by a component of the same name at ${s.dir}. It is not marked builtin, so web-chat leaves it alone and never repairs it — delete that directory to get the built-in back.`);
    }
  }
  const elements = seedElementTypes(paths, { log });
  return { shadowed, elements };
}

// Every regular file under dir, relative and '/'-separated, sorted. Links are
// not followed (the shipped tree has none).
function shippedFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(path.relative(dir, abs).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

// Whether each recorded type's files are the ones the pipeline would install
// from the shipped tree today (lib/packs/elements elementFiles, a pure read).
function sameFiles(pack, templateDir) {
  return unitsOf(pack.units, 'element').every((u) => {
    const want = elementFiles(elementSrcDir(templateDir, u.name)).slice().sort();
    const have = (u.files || []).map((f) => f && f.path).sort();
    return want.length === have.length && want.every((f, i) => f === have[i]);
  });
}

// The boot step for the built-in element types (PLAN.md 2C.2; DECISIONS.md
// B2: "built-ins install through the same path at boot"). The shipped tree,
// templates/elements/web-chat-builtins/, is a pack like any other and goes in
// through lib/packs/install installFromStage — the one install path, with its
// journal, record, ledger entry and audit line — as via 'builtin', which that
// function accepts for BUILTIN_ELEMENT_PACK alone and only from an in-process
// caller. It lands in .web-chat/element-types/ (projectPaths().elementTypesDir,
// ruling 2C@types-dir a), never beside the element log.
//
// It installs only when the project's record is absent, names another version
// or another digest of the shipped tree, when verifyPack reports drift (a user
// edit, a deleted file), when a type's recorded files are not the ones this
// build's pipeline would install from the same tree (the pipeline changed,
// not the tree — a build that starts installing the icons element.json
// names), or when this machine's ledger has no entry for it (a record a
// repository carried in, which the registry's record gate does not trust).
// Otherwise it reads and returns: a steady boot writes nothing and appends no
// audit line.
//
// `replace` is true: the three type names are reserved (lib/core/names), so a
// directory under one of them that no record owns can only be a leftover of
// this pack's own (its record lost) or something nobody may put there — the
// pack takes it back rather than failing every boot.
//
// It never throws: a failure logs one line and returns { error }, and the
// daemon boots on. The element routes still accept the built-in types from
// lib/core/element-policy, so a failed install costs the toolbar's listing of
// them, never comments.
//
// Returns { installed: true, reason, version, sha } after an install,
// { installed: false, reason: 'intact', version, sha } on a steady boot, or
// { error }.
function seedElementTypes(paths, { log = console.warn, templateDir = ELEMENTS_TEMPLATE_DIR } = {}) {
  const root = paths.root;
  try {
    const manifest = readJson(path.join(templateDir, 'web-chat-pack.json'));
    if (!manifest.ok) throw new Error(`the shipped ${path.join(templateDir, 'web-chat-pack.json')} is ${manifest.absent ? 'missing' : 'unreadable'}`);
    const version = String(manifest.value.version);
    const sha = treeHash(templateDir, shippedFiles(templateDir));
    const found = findPack(root, BUILTIN_ELEMENT_PACK, 'local');
    let reason = null;
    if (!found) reason = 'absent';
    else if (found.pack.version !== version) reason = 'version';
    else if (!found.pack.source || found.pack.source.sha !== sha) reason = 'shipped-change';
    else if (verifyPack(found.pack, { root, tier: 'local' }).drift) reason = 'drift';
    else if (!sameFiles(found.pack, templateDir)) reason = 'pipeline-change';
    else if (!findLedgerEntry(root, BUILTIN_ELEMENT_PACK)) reason = 'no-ledger-entry';
    if (!reason) return { installed: false, reason: 'intact', version, sha };
    installFromStage({
      stageDir: templateDir,
      source: { via: 'builtin', sha, version },
      tier: 'local', root, replace: true, actor: 'web-chat', via: 'builtin',
    });
    return { installed: true, reason, version, sha };
  } catch (e) {
    const message = String((e && e.message) || e).replace(/\s+/g, ' ').trim();
    if (typeof log === 'function') {
      log(`web-chat: the built-in element types (${BUILTIN_ELEMENT_PACK}) could not be installed: ${message}`);
    }
    return { error: message };
  }
}

module.exports = { BUILTINS, seedBuiltins, seedElementTypes, ELEMENTS_TEMPLATE_DIR };
