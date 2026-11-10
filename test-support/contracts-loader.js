'use strict';

// The contracts copy and its validator (contract 12 C-12.21, PLAN-T6 6A.8).
//
// test-support/contracts/ is the web-chat-contracts folder's LOCK.md, schemas/,
// examples/ and the locked amendment folders, taken at the tag MANIFEST.json
// names, with nothing of a later, unlocked round. It was made with
//
//   git -C <web-chat-contracts> archive <commit> LOCK.md schemas examples amendments \
//     | tar -x -C test-support/contracts
//
// and is never edited here: a later lock is a re-copy at the new tag (and a new
// MANIFEST.json), checked again by test/contracts.test.js. The copy is test
// support only — nothing under lib/ reads a schema at runtime, and the package's
// `files` allowlist does not carry test-support/.
//
// THE OVERLAY. The hub and web-chat load each amendment folder's files over the
// base; where two folders replace one path the later lock wins (LOCK.md v1.1:
// "a loader takes the later file where both replace one path"). The order is
// the order of LOCK.md's own `amendment <id>:` validation lines, parsed from the
// copied LOCK.md, never written here — so 03-activity-entry resolves
// 03-1 < 03-2 < 10-1 < 03-5, whatever order a caller names the folders in.
//
// THE RULE. validateExample is the contracts folder's own tools/validate.js at
// the lock (the rule LOCK.md's counts were computed with): an example goes to
// the schema whose name equals its own or prefixes it followed by '-' or '.',
// the longest such; when the schema's root refuses it, each $defs entry compiled
// standalone gets a try. That try is kept for the rule's sake, but at the lock
// it admits nothing: the standalone def's `$id` is the schema's `$id` plus
// `#def-<key>`, and ajv's draft 2020-12 meta-schema refuses an `$id` with a
// fragment, so every such compile throws (254 of 254 defs over the combined
// overlay, measured with ajv 8.20.0), in the tool and here alike; every example
// passes at its schema's root. A def's compile result (a validator or null) is
// cached here, where the tool compiled it again per example.
//
// validateFrame maps a contract-05 link frame to the one 05 schema $def whose
// properties.ch.const and properties.kind.const are the frame's; validatePairing
// takes a 05-pairing.json HTTP body by its $def name. Contract 08's schemas are
// v2 drafts (MANIFEST.json's unlocked_present) and are never a frame.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const CONTRACTS_DIR = path.join(__dirname, 'contracts');

const BASE_LINE = /^Validation at the lock: `node tools\/validate\.js` `examples ok=(\d+) fail=(\d+); schemas=(\d+)`/;
const AMENDMENT_LINE = /^`amendment ([0-9]{2}-[0-9]+): examples ok=(\d+) fail=(\d+); schemas=(\d+)`$/;
const ROW = /^\| `([^`]+)` \| ([0-9a-f]{64}) \|/;

function readLock(dir = CONTRACTS_DIR) {
  return fs.readFileSync(path.join(dir, 'LOCK.md'), 'utf8');
}

// LOCK.md's validation lines: every base line (`node tools/validate.js`, one per
// round from v1.1) and every `amendment <id>:` line, in file order.
function lockValidation(dir = CONTRACTS_DIR) {
  const base = [];
  const amendments = [];
  for (const line of readLock(dir).split('\n')) {
    let m = line.match(BASE_LINE);
    if (m) { base.push({ ok: Number(m[1]), fail: Number(m[2]), schemas: Number(m[3]) }); continue; }
    m = line.match(AMENDMENT_LINE);
    if (m) amendments.push({ id: m[1], ok: Number(m[2]), fail: Number(m[3]), schemas: Number(m[4]) });
  }
  return { base, amendments };
}

// The locked folders, in lock order (the first line naming each).
function lockOrder(dir = CONTRACTS_DIR) {
  const ids = [];
  for (const { id } of lockValidation(dir).amendments) if (!ids.includes(id)) ids.push(id);
  return ids;
}

// Every `| \`<path>\` | <sha256> |` row of every section, as path → Set of sha256.
function lockRows(dir = CONTRACTS_DIR) {
  const rows = new Map();
  for (const line of readLock(dir).split('\n')) {
    const m = line.match(ROW);
    if (!m) continue;
    if (!rows.has(m[1])) rows.set(m[1], new Set());
    rows.get(m[1]).add(m[2]);
  }
  return rows;
}

function jsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
}

function resolveFolders(folders, dir) {
  const order = lockOrder(dir);
  if (folders === 'all') return order;
  if (folders == null) return [];
  if (!Array.isArray(folders)) throw new TypeError("folders must be 'all' or an array of amendment ids");
  for (const id of folders) {
    if (!order.includes(id)) throw new Error(`amendment folder ${id} is not one LOCK.md's validation lines name`);
  }
  return order.filter((id) => folders.includes(id));
}

// The base with each named folder's files replacing same-named ones, applied in
// lock order. Each entry is { name, file (relative to the copy), data }.
function loadContracts({ folders = [], dir = CONTRACTS_DIR } = {}) {
  const applied = resolveFolders(folders, dir);
  const view = { folders: applied, schemas: new Map(), examples: new Map() };
  const load = (map, rel) => {
    for (const f of jsonFiles(path.join(dir, rel))) {
      const file = `${rel}/${f}`;
      map.set(f.replace(/\.json$/, ''), { name: f.replace(/\.json$/, ''), file, data: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) });
    }
  };
  load(view.schemas, 'schemas');
  load(view.examples, 'examples');
  for (const id of applied) {
    load(view.schemas, `amendments/${id}/schemas`);
    load(view.examples, `amendments/${id}/examples`);
  }
  for (const [name, s] of view.schemas) {
    if (typeof s.data.$id !== 'string' || !s.data.$id.endsWith(`/${name}.json`)) {
      throw new Error(`${s.file}: $id ${s.data.$id} does not name the file`);
    }
  }
  return view;
}

// The longest schema name equal to the example's or prefixing it before '-' or '.'.
function schemaFor(view, exampleName) {
  const base = String(exampleName).replace(/\.json$/, '');
  let best = null;
  for (const sb of view.schemas.keys()) {
    if (base === sb || base.startsWith(`${sb}-`) || base.startsWith(`${sb}.`)) {
      if (!best || sb.length > best.length) best = sb;
    }
  }
  return best;
}

function createValidator({ folders = 'all', dir = CONTRACTS_DIR } = {}) {
  const view = loadContracts({ folders, dir });
  const ajv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  for (const name of [...view.schemas.keys()].sort()) ajv.addSchema(view.schemas.get(name).data);

  const defCache = new Map();
  const standaloneDef = (schema, key) => {
    const id = `${schema.$id}#def-${key}`;
    if (!defCache.has(id)) {
      let v = null;
      try { v = ajv.compile({ $schema: schema.$schema, $id: id, ...schema.$defs[key] }); } catch { v = null; }
      defCache.set(id, v);
    }
    return defCache.get(id);
  };

  function validateExample(name, data) {
    const exampleName = String(name).replace(/\.json$/, '');
    if (data === undefined) {
      const ex = view.examples.get(exampleName);
      if (!ex) return { ok: false, schema: null, errors: [{ message: `no example ${exampleName} in this view` }] };
      data = ex.data;
    }
    const best = schemaFor(view, exampleName);
    if (!best) return { ok: false, schema: null, errors: [{ message: `no schema for ${exampleName}` }] };
    const schema = view.schemas.get(best).data;
    let validate;
    try { validate = ajv.getSchema(schema.$id) || ajv.compile(schema); } catch (e) {
      return { ok: false, schema: best, errors: [{ message: `compile failed: ${e.message}` }] };
    }
    if (validate(data)) return { ok: true, schema: best, def: null, errors: null };
    const errors = validate.errors;
    for (const key of Object.keys(schema.$defs || {})) {
      const v = standaloneDef(schema, key);
      if (v && v(data)) return { ok: true, schema: best, def: key, errors: null };
    }
    return { ok: false, schema: best, errors };
  }

  // (ch, kind) → { schema, def, ref } over the view's 05 schemas; each pair names
  // exactly one def, or building the index throws.
  const frameIndex = new Map();
  for (const [name, s] of view.schemas) {
    if (!name.startsWith('05-')) continue;
    for (const [key, def] of Object.entries(s.data.$defs || {})) {
      const p = (def && def.properties) || {};
      if (!p.ch || p.ch.const === undefined || !p.kind || p.kind.const === undefined) continue;
      const pair = `${p.ch.const}\u0000${p.kind.const}`;
      if (frameIndex.has(pair)) {
        const was = frameIndex.get(pair);
        throw new Error(`frame (${p.ch.const}, ${p.kind.const}) maps to both ${was.schema}#${was.def} and ${name}#${key}`);
      }
      frameIndex.set(pair, { ch: p.ch.const, kind: p.kind.const, schema: name, def: key, ref: `${s.data.$id}#/$defs/${key}` });
    }
  }

  const byRef = (ref) => {
    const v = ajv.getSchema(ref);
    if (!v) throw new Error(`no schema at ${ref}`);
    return v;
  };

  function validateFrame(frame) {
    const ok = frame && typeof frame === 'object' && !Array.isArray(frame);
    const entry = ok ? frameIndex.get(`${frame.ch}\u0000${frame.kind}`) : null;
    if (!entry) {
      return { ok: false, schema: null, def: null, errors: [{ message: `no contract-05 frame def for (${ok ? frame.ch : '?'}, ${ok ? frame.kind : '?'})` }] };
    }
    const v = byRef(entry.ref);
    const valid = v(frame);
    return { ok: valid, schema: entry.schema, def: entry.def, errors: valid ? null : v.errors };
  }

  function validatePairing(def, body) {
    const s = view.schemas.get('05-pairing');
    if (!s || !s.data.$defs || !Object.hasOwn(s.data.$defs, def)) {
      return { ok: false, def, errors: [{ message: `05-pairing.json has no $def ${def}` }] };
    }
    const v = byRef(`${s.data.$id}#/$defs/${def}`);
    const valid = v(body);
    return { ok: valid, def, errors: valid ? null : v.errors };
  }

  return { ajv, view, frameIndex, validateExample, validateFrame, validatePairing };
}

// THE SHA CHECK over a copy at `dir`: every file under schemas/, examples/ and
// amendments/ has a LOCK.md row (any section's) whose sha256 is the file's, or
// is one of MANIFEST.json's unlocked_present entries with an equal sha256; and
// LOCK.md is the one MANIFEST.json names. Returns { ok, checked, failures:
// [{ path, why }] }, each failure naming its path relative to the copy.
function checkCopy(dir = CONTRACTS_DIR) {
  const failures = [];
  const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'));
  if (sha('LOCK.md') !== manifest.lock_md_sha256) {
    failures.push({ path: 'LOCK.md', why: 'sha256 is not MANIFEST.json lock_md_sha256' });
  }
  const rows = lockRows(dir);
  const unlocked = new Map((manifest.unlocked_present || []).map((e) => [e.path, e.sha256]));
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((e) => (
      e.isDirectory() ? walk(`${rel}/${e.name}`) : [`${rel}/${e.name}`]
    ));
  };
  const files = ['schemas', 'examples', 'amendments'].flatMap(walk);
  for (const file of files) {
    const h = sha(file);
    const row = rows.get(file);
    if (row && row.has(h)) continue;
    if (unlocked.has(file) && unlocked.get(file) === h) continue;
    failures.push({
      path: file,
      why: row ? 'sha256 differs from its LOCK.md row'
        : unlocked.has(file) ? 'sha256 differs from its MANIFEST.json unlocked_present entry'
          : 'no LOCK.md row and no MANIFEST.json unlocked_present entry',
    });
  }
  for (const p of unlocked.keys()) {
    if (!files.includes(p)) failures.push({ path: p, why: 'MANIFEST.json unlocked_present names a file the copy lacks' });
  }
  return { ok: failures.length === 0, checked: files.length, failures };
}

module.exports = {
  CONTRACTS_DIR, loadContracts, createValidator, checkCopy, lockValidation, lockOrder, lockRows, schemaFor,
};
