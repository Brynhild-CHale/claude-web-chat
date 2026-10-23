// What an element type is inside a pack — annotation engine tranche 2, U322
// (PLAN.md 2C.1, DECISIONS.md B1/B2, readiness R7 rows 1, 2, 5, 7 and 9).
//
// An element type is one directory of a pack, `elements/<type>/`:
//
//   element.json   the type's descriptor (below)
//   draw.js        the code that draws the type's elements — it runs in the
//                  chrome's own realm, which is why a pack that ships one
//                  installs only through review and approve (B1); required
//                  for every type but a built-in, whose draw code is the
//                  chrome's own
//   assets/**      optional files the type ships beside it
//
// This module is the pipeline's reader for that directory, the sibling of
// lib/packs/themes.js: the manifest asks it whether an element.json is sound,
// the element row of lib/packs/kinds.js asks it which files make up a unit and
// where they land. Pure reads — nothing here writes, which
// test/conventions.test.js holds it to (the pack orchestrator's zero-mutation
// row).
//
// element.json:
//
//   type     the type's name; must equal its directory's name. Checked, with
//            `family`, `remote` {see, send} and `private`, by
//            lib/core/element-policy validateDescriptor — the one descriptor
//            check, so a gate that would loosen the remote floor is refused in
//            that module's own words and no third type grammar is written here
//   schema   '<type>@<n>', n a positive integer: the schema the type writes
//   reads    the schemas its draw.js can draw, each '<type>@<n>'; defaults to
//            [schema] and must include it (C-5: a version whose schema is not
//            listed is parked, never handed to draw.js)
//   anchors  the anchor kinds the type accepts, a non-empty list from the
//            engine's vocabulary (element-policy ANCHOR_KINDS, decision C5)
//
// Any other key — the toolbar's fields (icons, settings, hotkeys, profiles,
// input, needs) among them — is KEPT in the descriptor and reported as a
// warning, never refused: its validator is a later unit's, and this one must
// not order it.
//
// Where installed types live: <tier>/element-types/<type>/
// (projectPaths().elementTypesDir, userPaths().elementTypesDir — ruling
// 2C@types-dir a). Never under the element log's directory
// (projectPaths().elementsDir holds log.jsonl and the boot reports): nothing a
// pack install plans, writes or removes is ever beside the log.

const fs = require('fs');
const path = require('path');
const { projectPaths, userPaths } = require('../core/paths');
const { readJson } = require('../core/fsjson');
const { validateDescriptor, ANCHOR_KINDS } = require('../core/element-policy');
const { parsePin } = require('../core/element-log');

const ELEMENTS_DIR = 'elements';
const ELEMENT_FILE = 'element.json';
const DRAW_FILE = 'draw.js';
const ASSETS_DIR = 'assets';

// The keys this module reads. Everything else is kept and warned about.
const KNOWN_KEYS = Object.freeze(['type', 'family', 'remote', 'private', 'schema', 'reads', 'anchors']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A staged pack's element unit directory.
function elementSrcDir(stageDir, name) {
  return path.join(stageDir, ELEMENTS_DIR, name);
}

// The installed directory of a type, in a tier.
function elementDest(unit, tier, root) {
  const p = tier === 'system' ? userPaths() : projectPaths(root);
  return path.join(p.elementTypesDir, unit.name);
}

// A unit directory's element.json, read. Returns { ok: true, raw } or
// { ok: false, error } — absent, not JSON, or not an object, said plainly.
function readElementJson(dir) {
  const r = readJson(path.join(dir, ELEMENT_FILE));
  if (r.absent) return { ok: false, error: `${ELEMENT_FILE} is missing` };
  if (!r.ok) return { ok: false, error: `${ELEMENT_FILE} is not valid JSON` };
  if (!isObject(r.value)) return { ok: false, error: `${ELEMENT_FILE} is not a JSON object` };
  return { ok: true, raw: r.value };
}

// '<type>@<n>' → n, or null when the string is not that type's schema with a
// positive integer version. A schema name has the id@v shape, so it is read by
// the one id@v parser (element-log's parsePin: split at the last '@', a v that
// is not a positive safe integer written as its own decimal refused).
function schemaVersion(s, type) {
  if (typeof s !== 'string' || typeof type !== 'string') return null;
  const p = parsePin(s);
  return p && p.id === type ? p.v : null;
}

// Validate one element.json. NEVER throws for a content problem: returns
// { ok, errors, warnings, descriptor } with every problem at once, each
// message headed `element "<name>":`, the way validateManifest words a
// component's.
//
//   stageDir  the staged pack's root, or null (then draw.js is not looked for)
//   name      the unit's directory name — the identity the type must equal
//   builtin   the built-in pack's own types: no draw.js is required
//
// The descriptor is { ...every unknown key, type, family, remote, private,
// schema, reads, anchors }, or null when the element.json is refused.
function validateElement(raw, { stageDir = null, name, builtin = false } = {}) {
  const errors = [];
  const warnings = [];
  const head = `element "${name}"`;
  if (!isObject(raw)) {
    return { ok: false, errors: [`${head}: ${ELEMENT_FILE} is not a JSON object`], warnings, descriptor: null };
  }

  if (raw.type !== name) {
    errors.push(`${head}: ${ELEMENT_FILE} says type ${JSON.stringify(raw.type === undefined ? null : raw.type)} — a type's name is its directory's name, "${name}"`);
  }
  let policy = null;
  try {
    policy = validateDescriptor({
      type: raw.type, family: raw.family, remote: raw.remote,
      ...('private' in raw ? { private: raw.private } : {}),
    });
  } catch (e) {
    errors.push(`${head}: ${e.message}`);
  }

  const type = typeof raw.type === 'string' ? raw.type : name;
  const schemaOk = schemaVersion(raw.schema, type) != null;
  if (!schemaOk) {
    errors.push(`${head}: "schema" must be "${type}@<n>", n a positive integer (got ${JSON.stringify(raw.schema === undefined ? null : raw.schema)})`);
  }

  let reads = raw.reads === undefined ? (schemaOk ? [raw.schema] : []) : raw.reads;
  if (!Array.isArray(reads) || !reads.length || !reads.every((r) => schemaVersion(r, type) != null)) {
    errors.push(`${head}: "reads" must be a non-empty list of "${type}@<n>" schemas (got ${JSON.stringify(raw.reads)})`);
    reads = [];
  } else {
    reads = [...new Set(reads)];
    if (schemaOk && !reads.includes(raw.schema)) {
      errors.push(`${head}: "reads" must include the type's own schema "${raw.schema}"`);
    }
  }

  let anchors = raw.anchors;
  if (!Array.isArray(anchors) || !anchors.length || !anchors.every((a) => ANCHOR_KINDS.includes(a))) {
    errors.push(`${head}: "anchors" must be a non-empty list from ${ANCHOR_KINDS.join(', ')} (got ${JSON.stringify(anchors === undefined ? null : anchors)})`);
    anchors = [];
  } else {
    anchors = [...new Set(anchors)];
  }

  if (stageDir && !builtin) {
    let isFile = false;
    try { isFile = fs.lstatSync(path.join(elementSrcDir(stageDir, name), DRAW_FILE)).isFile(); } catch {}
    if (!isFile) errors.push(`${head}: ${ELEMENTS_DIR}/${name}/${DRAW_FILE} is missing`);
  }

  const unknown = Object.keys(raw).filter((k) => !KNOWN_KEYS.includes(k));
  if (unknown.length) {
    warnings.push(`${head}: ${ELEMENT_FILE} carries ${unknown.join(', ')}, which this build does not check — kept as written`);
  }

  if (errors.length) return { ok: false, errors, warnings, descriptor: null };
  const extra = {};
  for (const k of unknown) extra[k] = raw[k];
  return {
    ok: true, errors, warnings,
    descriptor: {
      ...extra,
      type: policy.type, family: policy.family,
      remote: { see: policy.remote.see, send: policy.remote.send },
      private: policy.private,
      schema: raw.schema, reads, anchors,
    },
  };
}

// The relative paths of one staged element unit's files, in a stable order:
// element.json, draw.js, then every regular file under assets/ (sorted, depth
// first). Anything else in the directory is not part of the unit and does not
// install. Symlinks are never followed (the fetch gate refused them already).
function elementFiles(srcDir) {
  const out = [];
  for (const f of [ELEMENT_FILE, DRAW_FILE]) {
    try { if (fs.lstatSync(path.join(srcDir, f)).isFile()) out.push(f); } catch {}
  }
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(path.relative(srcDir, abs).split(path.sep).join('/'));
    }
  };
  walk(path.join(srcDir, ASSETS_DIR));
  return out;
}

module.exports = {
  ELEMENTS_DIR,
  ELEMENT_FILE,
  DRAW_FILE,
  ASSETS_DIR,
  KNOWN_KEYS,
  elementSrcDir,
  elementDest,
  readElementJson,
  validateElement,
  elementFiles,
};
