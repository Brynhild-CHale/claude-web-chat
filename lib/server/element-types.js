'use strict';
// The element-type registry (annotation engine tranche 2, PLAN.md 2C.3;
// DECISIONS.md B1 review-approve; readiness R7 §3 row 6; F10 C-7): which
// element types this daemon lists, and what each one reads.
//
//   createElementTypes({root, paths, bus, log}) → ctx.elementTypes
//     listed(type)            whether the type is listed
//     descriptor(type)        its listing row (below), or null
//     list()                  every listed row, sorted by type
//     types()                 the listed type names, sorted
//     dirOf(type)             the listed type's installed directory, or null
//     reads(type)             the schemas its draw reads, or null
//     readable(type, schema)  whether a version written under `schema`
//                             ('<type>@<n>', or n) may be handed to its draw
//                             (C-5: decided from element.json alone)
//     gate(type)              its remote gate {see, send}, compiled by
//                             lib/core/element-policy compileElementPolicy
//                             over the listed descriptors, or null
//     stats()                 {computes, listed, refused: [{name, tier, why}]}
//     invalidate()            drop the cached listing (the next read recomputes)
//     stop()                  stop hearing the bus
//
// THE RECORD GATE. Two tiers over the one tiered registry (lib/core/resources
// resourceRegistry), project first: projectPaths().elementTypesDir and
// userPaths().elementTypesDir (ruling 2C@types-dir a). Its load hook — which
// is also the list filter — returns a row ONLY when every gate holds:
//
//   1. the entry is a real directory (not a link, not a file);
//   2. the tier's packs.json names an element unit of that name, in exactly
//      one pack (lib/packs/store);
//   3. for the project tier, this machine's ledger holds that pack for this
//      root and names the unit: a committed .web-chat/packs.json is a file a
//      repository can forge, with digests that agree with its own files (the
//      user tier's record is out of any repository's reach);
//   4. no pending.json entry of the tier names the pack (an install in
//      flight lists nothing until its record is final);
//   5. verifyPack (lib/packs/tree) reports the unit intact against the
//      tier's record — and, for the project tier, against the digests the
//      ledger recorded, so a forged record cannot vouch for edited bytes;
//   6. element.json reads (lib/packs/elements readElementJson) and validates
//      (validateElement, whose policy half is element-policy
//      validateDescriptor): a descriptor that would loosen the remote floor
//      is refused there, not listed, and logged once;
//   7. a built-in type name (lib/core/names) lists only from the built-in
//      pack's record.
//
// Anything else lists nothing: a committed element-types/ directory with no
// record, a forged record with no ledger entry, a pending install, a tampered
// file, a pack still in quarantine (it has no record), a removed pack.
//
// C-16-1's runtime half: a built-in type listed from the built-in pack's
// record is checked against element-policy's row (BUILTIN_ELEMENT_TYPES); on
// a mismatch the row's policy fields (family, remote, private) are listed
// instead, and one line is logged.
//
// Lazy: the listing is computed on the first read and kept until the bus
// carries a `packs` event (routes/packs.js changed(): every install,
// quarantine, approve, discard, removal and the CLI's announce) or
// invalidate() is called. The daemon builds this after seedBuiltins (whose
// boot step installs the built-in pack, U323), so the first read after boot
// sees it.
//
// THE LISTING ROW: {type, schema, reads, anchors, family, remote, private,
// builtin, tier, pack, toolbar} — `toolbar` is every other key of the
// descriptor as stored (the toolbar's fields, `wake` and `summary_key` among
// them, K.2-16); this module validates none of them. No row carries a path
// beyond dirOf's answer, a record's text, or anything of a pane's.
//
// Nothing here touches lib/core/remote-policy: the portal keeps the floor rows
// (element-policy FLOOR_RULES), and a listed type never changes them. No rule
// here grants anything on a writer or a pane (C-15-1..3): this is a listing.

const fs = require('fs');
const path = require('path');
const { resourceRegistry } = require('../core/resources');
const { projectPaths, userPaths } = require('../core/paths');
const { BUILTIN_ELEMENT_TYPES, compileElementPolicy } = require('../core/element-policy');
const { BUILTIN_ELEMENT_PACK, isReservedElementType } = require('../core/names');
const { parsePin } = require('../core/element-log');
const { readElementJson, validateElement } = require('../packs/elements');
const { readStore, storeFile, findLedgerEntry, readPending } = require('../packs/store');
const { verifyPack } = require('../packs/tree');

// The keys the listing row names at its top level. Every other descriptor key
// is the toolbar's, served as stored.
const ROW_KEYS = Object.freeze(['type', 'schema', 'reads', 'anchors', 'family', 'remote', 'private']);
const UNIT_KIND = 'element';

const byType = (a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0);
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

// A unit of a record naming this element type.
const elementUnitOf = (record, name) => (Array.isArray(record && record.units) ? record.units : [])
  .find((u) => u && u.kind === UNIT_KIND && u.name === name) || null;

// '<type>@<n>' or n → '<type>@<n>', or null when it is neither.
function schemaName(type, schema) {
  if (Number.isSafeInteger(schema) && schema > 0) return `${type}@${schema}`;
  if (typeof schema !== 'string') return null;
  const p = parsePin(schema);
  return p && p.id === type ? schema : null;
}

function createElementTypes({ root, paths = null, bus = null, log } = {}) {
  const projectRoot = root || (paths && paths.root);
  if (!projectRoot) throw new TypeError('createElementTypes: a project root is required');
  const write = typeof log === 'function' ? log : (line) => { try { process.stderr.write(line + '\n'); } catch {} };
  // One line per distinct problem for the registry's life: a recompute after
  // every packs event would otherwise repeat it.
  const logged = new Set();
  const say = (line) => { if (logged.has(line)) return; logged.add(line); write(line); };

  const tierDirs = {
    local: projectPaths(projectRoot).elementTypesDir,
    system: userPaths().elementTypesDir,
  };

  let refused = [];
  // Per compute: each tier's record, read once.
  let records = null;
  const recordsOf = (tier) => {
    if (!records) records = {};
    if (!records[tier]) records[tier] = readStore(storeFile(tier, projectRoot)).packs;
    return records[tier];
  };
  const pendingOf = (tier) => {
    if (!records) records = {};
    const key = `pending:${tier}`;
    if (!records[key]) records[key] = readPending(projectRoot, tier);
    return records[key];
  };

  // The load hook: an entry → its listing row, or null with the refusal noted.
  function load(entry, { tier, name }) {
    const no = (why, line) => {
      refused.push({ name, tier, why });
      if (line) say(line);
      return null;
    };
    let st;
    try { st = fs.lstatSync(entry); } catch { return null; }
    if (!st.isDirectory()) return no('not-a-directory');
    // 2. the tier's record.
    const owners = recordsOf(tier).filter((p) => p && elementUnitOf(p, name));
    if (!owners.length) return no('no-record');
    if (owners.length > 1) return no('claimed-twice', `web-chat: element type "${name}" is not listed: ${owners.length} packs of the ${tier} record claim it`);
    const pack = owners[0];
    // 7. a built-in name lists only from the built-in pack.
    const builtin = isReservedElementType(name);
    if (builtin && (pack.name !== BUILTIN_ELEMENT_PACK || tier !== 'local')) {
      return no('reserved', `web-chat: element type "${name}" is not listed: the name is a built-in type's, and "${pack.name}" (${tier}) is not ${BUILTIN_ELEMENT_PACK}`);
    }
    // 3. this machine's ledger, for a project install.
    let ledgerUnit = null;
    if (tier === 'local') {
      const entryOf = findLedgerEntry(projectRoot, pack.name);
      ledgerUnit = entryOf && elementUnitOf(entryOf, name);
      if (!ledgerUnit) return no('no-ledger');
    }
    // 4. nothing pending for the pack.
    if (pendingOf(tier).some((p) => p && p.name === pack.name)) return no('pending');
    // 5. the unit's bytes, against the record and against the ledger.
    const intact = (unit) => {
      try {
        const v = verifyPack({ name: pack.name, units: [unit] }, { root: projectRoot, tier });
        return v.units.length === 1 && v.units[0].state === 'intact';
      } catch { return false; }
    };
    if (!intact(elementUnitOf(pack, name))) return no('drift');
    if (ledgerUnit && !intact(ledgerUnit)) return no('drift');
    // 6. element.json.
    const read = readElementJson(entry);
    if (!read.ok) return no('element-json', `web-chat: element type "${name}" is not listed: ${read.error}`);
    const checked = validateElement(read.raw, { stageDir: null, name, builtin });
    if (!checked.ok) return no('descriptor', `web-chat: element type "${name}" is not listed: ${oneLine(checked.errors.join('; '))}`);
    const d = checked.descriptor;
    const toolbar = {};
    for (const k of Object.keys(d)) if (!ROW_KEYS.includes(k)) toolbar[k] = d[k];
    let policy = { family: d.family, remote: { see: d.remote.see, send: d.remote.send }, private: d.private };
    if (builtin) {
      // C-16-1's runtime half.
      const row = BUILTIN_ELEMENT_TYPES.find((r) => r.type === name);
      const want = { family: row.family, remote: { see: row.remote.see, send: row.remote.send }, private: row.private };
      if (JSON.stringify(want) !== JSON.stringify(policy)) {
        say(`web-chat: built-in element type "${name}": element.json's policy ${JSON.stringify(policy)} differs from lib/core/element-policy's row ${JSON.stringify(want)} — the row is listed`);
        policy = want;
      }
    }
    return {
      name,
      type: name,
      schema: d.schema,
      reads: d.reads.slice(),
      anchors: d.anchors.slice(),
      family: policy.family,
      remote: policy.remote,
      private: policy.private,
      builtin,
      tier,
      pack: pack.name,
      toolbar,
    };
  }

  const registry = resourceRegistry({
    name: 'element-types',
    tiers: [
      { tier: 'local', dir: tierDirs.local },
      { tier: 'system', dir: tierDirs.system },
    ],
    load,
  });

  let cache = null;
  let computes = 0;

  function compute() {
    computes++;
    refused = [];
    records = null;
    let rows;
    try { rows = registry.list(); } catch (e) { rows = []; say(`web-chat: the element types could not be listed: ${oneLine(e && e.message)}`); }
    records = null;
    // The gates, compiled over the listed descriptors. Each was validated by
    // its load, so the compile throws only on something new; a type it refuses
    // is dropped (not listed) and logged.
    const listed = [];
    const descriptors = [];
    for (const r of rows.sort(byType)) {
      const { name, shadows, ...row } = r;
      try {
        compileElementPolicy([{ type: row.type, family: row.family, remote: row.remote, private: row.private }]);
      } catch (e) {
        refused.push({ name, tier: row.tier, why: 'descriptor' });
        say(`web-chat: element type "${name}" is not listed: ${oneLine(e && e.message)}`);
        continue;
      }
      if (shadows) row.shadows = shadows.slice();
      listed.push(deepFreeze(row));
      descriptors.push({ type: row.type, family: row.family, remote: row.remote, private: row.private });
    }
    let policy;
    try { policy = compileElementPolicy(descriptors); } catch (e) {
      say(`web-chat: the element types' gates could not be compiled: ${oneLine(e && e.message)}`);
      policy = { typeGates: {} };
    }
    const map = new Map(listed.map((row) => [row.type, row]));
    cache = { map, list: listed, gates: policy.typeGates, refused: refused.slice() };
    return cache;
  }
  const current = () => cache || compute();

  function invalidate() { cache = null; }

  const unsubscribe = bus && typeof bus.subscribe === 'function'
    ? bus.subscribe((ev) => { if (ev && ev.kind === 'packs') invalidate(); })
    : () => {};

  const descriptor = (type) => (typeof type === 'string' && current().map.get(type)) || null;

  return {
    listed: (type) => Boolean(descriptor(type)),
    descriptor,
    list: () => current().list.slice(),
    types: () => current().list.map((r) => r.type),
    dirOf(type) {
      const row = descriptor(type);
      return row ? path.join(tierDirs[row.tier], row.type) : null;
    },
    reads(type) {
      const row = descriptor(type);
      return row ? row.reads.slice() : null;
    },
    readable(type, schema) {
      const row = descriptor(type);
      if (!row) return false;
      const s = schemaName(type, schema);
      return s != null && row.reads.includes(s);
    },
    gate(type) {
      const row = descriptor(type);
      const g = row && current().gates[type];
      return g ? { see: g.see, send: g.send } : null;
    },
    stats() {
      const c = current();
      return { computes, listed: c.list.length, refused: c.refused.map((r) => ({ ...r })) };
    },
    invalidate,
    stop() { try { unsubscribe(); } catch {} },
  };
}

module.exports = { createElementTypes, ROW_KEYS };
