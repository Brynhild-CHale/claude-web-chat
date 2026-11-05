'use strict';
// The documents' element payload (annotation engine tranche 4, PLAN.md 4B.1;
// DECISIONS.md B3, R1 stage B, K.5 J2, N.1 AD5 = a; U521). THE one builder
// every document reads — the node preview and /preview/pane (U523), the page
// export (U524), the replay player, its download and its renders (U525) — as
// lib/server/preview.js pageItems is the one reader of a node's page. Nothing
// else hands a document an element.
//
//   documentElements(deps, node, {reader, route, item?})
//        → a payload of contract v1 (lib/server/runtime/elements-doc-src.js
//          validatePayload; its fixture test-support/doc-elements-fixture.js),
//          or null when the reader sees no element of the node
//     deps    {elements, sideTable, elementTypes, readTypeFile, typeRecord?}:
//             graph.elements (the element store), ctx.sideTable,
//             ctx.elementTypes, and two closures over the route's ctx —
//             readTypeFile(type, rel), U511's lib/server/element-files
//             readTypeFile(ctx, type, rel) (RULED U521@readTypeFile-deps a),
//             and typeRecord(type) → {draw, assets}: what the type's install
//             record names (draw.js's digest, the files below assets/).
//             documentDeps(ctx) builds exactly these from a route's ctx.
//     reader  {level, seesPrivate}: readerOf(audience, req) for a document a
//             request views in place; fileReader(level) for a FILE (an
//             export, a replay download, a rendered replay).
//     route   the document route's key in remote-policy PRIVATE_RULES.routes
//             ('GET /preview/node/:id', …); a key with no row is a TypeError.
//     item    (optional) one page item id: only the items anchored on it
//             (element-refs anchorItem: anchor.mount | md | item) —
//             /preview/pane's case.
//
//   readerOf(audience, req) → {level, seesPrivate}: level audience.levelOf(req)
//     (a throw: 'basic'), seesPrivate audience.seesPrivate(req) === true (a
//     throw: false); with no audience, one with no mirror opt-in (routes/
//     graph.js's rule: narrower, never wider).
//   fileReader(level) → {level, seesPrivate: false} (RULED
//     U524-U525@file-documents-private a: a file is made to be sent on, so it
//     never carries a private element whoever asks; only a document viewed in
//     place — the node preview, /preview/pane, the /replay player — shows a
//     local browser its private elements).
//
// THE ITEM SET (RULED U521@item-set a): what the node's page carries — its
// element records through anchors-src's field table (fieldEntries: the walk
// kindsOf and carriesElements make; `comments`, the 0.8.5 copies, and
// `elements`, the id@v references), each at the v the node pins: a copy's own
// v or its commit record's, a reference's own v. Never an ancestry walk and
// never element-scope's elementsForNode. The rows are lib/server/domain/
// element-projection leanElements(node, store, {node: true, refs: true}) —
// the lean allowlist, every anchor through the store's read view (maskPins),
// a row served masked keeping state/visible/explain (U415e; drawn el-masked).
// THE LATEST VERSION'S PRIVACY (U525b, PQ-4F-1 provisional, privacy-first):
// an item pinned shared whose element's latest log version is private reads
// `shared: false` (`withdrawnBy: 'latest'` on its raw row beside, never in
// the payload: ITEM_KEYS), so the PRIVATE_RULES drop withdraws it from every
// file document and from an in-place one read without seesPrivate; the local
// browser viewing in place still draws the pinned version.
// The draw fields come from the log's masked view (store.version(id,
// v).payload: text through the redactor now; a comment copy the log cannot
// map, from the copy through maskPins), by elements-doc-src's allowlist
// (BUILTIN_FIELDS; a plug-in type its schema's keys less anchor, shared,
// chain and every FORBIDDEN key). KEPT among the page-anchored records: a
// strokes type's PAGE STROKE (U621; REQ@ink-scope-v2 b+) — its anchor a page
// record lib/core/strokes isPageRecord accepts (the closed shape) and its
// version's payload a stroke (isStrokePayload); the document runtime places
// it by its items (elements-doc-src's page arm). LEFT OUT: an unresolvable
// reference (no type), every other page-anchored record (the box grab's page
// anchor is no page record: its closed shape fails) and every built-in the
// documents do not draw (the box grab, never drawn by the live page host
// either; the chat comment, never on a node: L2), a chat-family element
// (defensive), and always chain, writer, provenance, author, edited, meta and
// grab. A page stroke is an element row like any other: the projection below,
// the latest version's privacy and the file documents' rule hold for it
// unchanged. THE ANSWER is the side
// table's recorded one for that id@v on this node (answersFor), {state, how?,
// why?} only (never gen, surface, qual or source); the live node (no id) has
// none. The minted record (sideTable.recordOf) is never carried.
//
// THE PROJECTION, applied ONCE, here, in this order: (1) the per-type gate:
// an item rides only when the reader's level meets its type's `see` (the
// registry's compiled gate; a built-in the registry does not list,
// remote-policy ELEMENT_POLICY's row; a type nobody lists, 'local': fail
// closed), so a basic reader and a network peer get nothing; (2) below
// `read`, the route's TEXT_RULES row (stripText over {doc_elements}); (3)
// unless the reader sees private records, the route's PRIVATE_RULES row
// (dropPrivate over {doc_elements}: every shared === false item). Then the
// `builtins`, `types`, `removed` and `sources` are computed from the KEPT
// items alone — a type no kept item uses carries no row and its draw.js is
// never read — and an empty result is null.
//
// TYPES (B1, B3): a kept item's type that the registry lists and that is not a
// built-in gets a row: schema and reads from its listing row, place from its
// element.json `place` (lib/packs/elements PLACE_MODES; 'glyph' when absent),
// draw.js and the assets read ONLY through deps.readTypeFile (U511: the media
// allowlist, the per-file cap, the digest check against the install record
// and the ledger). The module is inlined byte-equal and sha256 is its
// recorded digest. A module rides only when lib/packs/elements
// drawModuleProblem passes it (exactly one line opening DRAW_HEAD, RULED
// U512-U522@draw-module-contract a; no static import; the glyph exports
// top-level declarations: review's one predicate, U590) and elements-doc-src
// typeElement does not refuse to splice it;
// else the row's module is '' and skipped names draw.js ('draw-contract',
// 'unsafe-splice', or readTypeFile's refusal), and its items draw the generic
// mark. An asset readTypeFile refuses is in skipped with the refusal, never
// inlined. A type the registry does not list goes to `removed`, its items
// with payload null; an item whose schema the listed type no longer reads is
// parked (payload null; C-5: element.json alone decides).
//
// SOURCES (PLAN.md 1C.3, met through pageItems): for each markdown item a
// KEPT source-anchored item names, its {src, map} exactly as lib/server/
// preview.js pageItems(node, {sourceMap: true}) gives them — the per-item
// form, never the whole page's; no such item, no `sources` key.
//
// LAZY BODIES (4G, F9): this reads the handed node's comments, elements, id
// (and, for `sources`, its page), and the side table reads only that node's
// own body and its ancestry's ids — never another node's body.
//
// No rule here treats a writer or a pane as a boundary (C-15-1..3); writer and
// provenance never reach a document. Nothing here opens a type file, evals or
// loads a pack's code (B1).

const crypto = require('crypto');
const { leanElements } = require('./domain/element-projection');
const { anchorItem } = require('./domain/element-refs');
// fieldEntries alone: it splices no resolver (test/anchors-served.test.js
// pins it among the users that take neither source nor scriptElement).
const { fieldEntries } = require('./runtime/anchors-src');
const {
  CONTRACT_VERSION, BUILTIN_TYPES, BUILTIN_FIELDS, FORBIDDEN, typeElement,
} = require('./runtime/elements-doc-src');
const { atLeast, stripText, dropPrivate, PRIVATE_RULES, ELEMENT_POLICY } = require('../core/remote-policy');
const { BUILTIN_ELEMENT_TYPES } = require('../core/element-policy');
const { ASSETS_DIR, DRAW_FILE } = require('../core/element-assets');
const { schemaRow } = require('../core/element-log');
const { isPageRecord, isStrokePayload } = require('../core/strokes');
const { PLACE_MODES, drawModuleProblem } = require('../packs/elements');

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isPosInt = (n) => Number.isSafeInteger(n) && n > 0;
const safe = (fn) => { try { return fn(); } catch { return null; } };
const sorted = (list) => [...new Set(list)].sort();
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// The built-ins' families (element-policy's rows): a built-in the documents do
// not draw is never an item, and neither is a chat element.
const BUILTIN_FAMILY = new Map(BUILTIN_ELEMENT_TYPES.map((d) => [d.type, d.family]));
const CHAT_FAMILY = 'chat';
const DRAWN_BUILTIN = new Set(BUILTIN_TYPES);
// A plug-in payload's keys never carried, beside FORBIDDEN.
const NOT_DRAWN = new Set([...FORBIDDEN, 'anchor', 'shared', 'chain']);
// The draw-module contract (exactly one draw line, no static import, the
// glyph exports top-level declarations) is lib/packs/elements
// drawModuleProblem: the ONE predicate pack review reads too (U590), so a
// module review approved is one a document inlines.

// The answer keys a document carries (elements-doc-src ANSWER_KEYS).
const ANSWER_FIELDS = ['how', 'why'];

// ── the readers ─────────────────────────────────────────────────────────────
let noOptIn = null;
function fallbackAudience() {
  if (!noOptIn) noOptIn = require('./audience').createAudience({ configFile: null });
  return noOptIn;
}

function readerOf(audience, req) {
  const a = audience || fallbackAudience();
  let level;
  try { level = a.levelOf(req); } catch { level = 'basic'; }
  if (typeof level !== 'string') level = 'basic';
  let seesPrivate;
  try { seesPrivate = typeof a.seesPrivate === 'function' && a.seesPrivate(req) === true; } catch { seesPrivate = false; }
  return { level, seesPrivate };
}

function fileReader(level) {
  return { level: typeof level === 'string' ? level : 'basic', seesPrivate: false };
}

// ── deps from a route's ctx ─────────────────────────────────────────────────
// What a document route hands documentElements: the store, the side table,
// the registry, and the two closures over ctx (U511's reader; the install
// record's names for the type's unit, read as element-files recordedDigests
// reads it — a record, never a type file).
function documentDeps(ctx) {
  const c = ctx || {};
  return {
    elements: c.graph ? c.graph.elements : null,
    sideTable: c.sideTable || null,
    elementTypes: c.elementTypes || null,
    readTypeFile: (type, rel) => require('./element-files').readTypeFile(c, type, rel),
    typeRecord: (type) => typeRecordOf(c, type),
  };
}

// The install record's names for a listed plug-in type's unit: draw.js's
// digest (null unless every record holds the same one: element-files
// drawDigest) and the files below assets/ (sorted, without the prefix).
function typeRecordOf(ctx, type) {
  const reg = ctx.elementTypes;
  const row = reg && typeof reg.descriptor === 'function' ? safe(() => reg.descriptor(type)) : null;
  if (!row || row.builtin) return { draw: null, assets: [] };
  const { drawDigest, typeFiles } = require('./element-files');
  const prefix = `${ASSETS_DIR}/`;
  const assets = (safe(() => typeFiles(ctx, row)) || [])
    .map((f) => (f && typeof f.path === 'string' ? f.path : ''))
    .filter((p) => p.startsWith(prefix) && p.length > prefix.length)
    .map((p) => p.slice(prefix.length));
  return { draw: safe(() => drawDigest(ctx, row)), assets: sorted(assets) };
}

// ── the type questions ──────────────────────────────────────────────────────
function registry(deps) {
  const r = deps && deps.elementTypes;
  return r && typeof r === 'object' ? r : null;
}
const listedRow = (deps, type) => {
  const reg = registry(deps);
  if (!reg || typeof reg.descriptor !== 'function') return null;
  const d = safe(() => reg.descriptor(type));
  return isObj(d) ? d : null;
};
const isBuiltin = (type) => BUILTIN_FAMILY.has(type);

// The level a type's elements need to be seen: the registry's compiled gate
// when it lists the type, else element-policy's row for a built-in, else
// 'local' (a type that cannot say its gate reaches no remote reader).
function seeOf(deps, type) {
  const reg = registry(deps);
  if (listedRow(deps, type) && reg && typeof reg.gate === 'function') {
    const g = safe(() => reg.gate(type));
    if (g && typeof g.see === 'string') return g.see;
  }
  if (hasOwn(ELEMENT_POLICY.typeGates, type)) return ELEMENT_POLICY.typeGates[type].see;
  return 'local';
}

function isChat(deps, type) {
  if (BUILTIN_FAMILY.has(type)) return BUILTIN_FAMILY.get(type) === CHAT_FAMILY;
  const store = deps && deps.elements;
  return !!store && typeof store.familyOf === 'function' && safe(() => store.familyOf(type)) === CHAT_FAMILY;
}

// Does the listed type's draw read `schema`? (C-5: element.json alone.)
function reads(deps, type, schema, desc) {
  if (typeof schema !== 'string') return false;
  const reg = registry(deps);
  if (reg && typeof reg.readable === 'function') return safe(() => reg.readable(type, schema)) === true;
  return Array.isArray(desc.reads) && desc.reads.includes(schema);
}

// ── one item's draw fields ──────────────────────────────────────────────────
function versionOf(store, id, v) {
  if (!store || typeof store.version !== 'function' || !isPosInt(v)) return null;
  return safe(() => store.version(id, v)) || null;
}

// Is the element's LATEST version private? (U525b, PQ-4F-1 read privacy-first:
// a document reads an element's privacy by its newest version in the log,
// whatever v the node pinned — box-grab.js privateMembers' check, U564's, for
// a picture.) An id the log does not hold (a copy it cannot map) answers false.
function latestPrivate(store, id) {
  if (!store || typeof store.latest !== 'function') return false;
  const rec = safe(() => store.latest(id));
  return !!rec && isObj(rec.payload) && rec.payload.shared === false;
}

function builtinFields(type, src) {
  const out = {};
  for (const k of BUILTIN_FIELDS[type]) {
    if (k === 'replies') {
      out.replies = (Array.isArray(src.replies) ? src.replies : []).filter(isObj).map((r) => {
        const o = {};
        if (typeof r.text === 'string') o.text = r.text;
        o.claude = r.author === 'claude';
        return o;
      });
    } else if (typeof src[k] === 'string') out[k] = src[k];
  }
  return out;
}

function pluginFields(schema, src) {
  const row = schemaRow(schema);
  const keys = row ? row.keys : Object.keys(src);
  const out = {};
  // A declared key a version never wrote is null, as GET /api/elements's
  // record() serves it (domain/elements: payload[k] ?? null), so ctx.record(id)
  // answers the same field set in both realms (U522b's finding; contract (n)).
  for (const k of keys) if (!NOT_DRAWN.has(k)) out[k] = hasOwn(src, k) && src[k] !== undefined ? src[k] : null;
  return out;
}

// A comment copy the log cannot map: its words through the store's read view.
function maskedCopy(store, copy) {
  if (!store || typeof store.maskPins !== 'function') return copy;
  const out = safe(() => store.maskPins([copy]));
  return Array.isArray(out) && isObj(out[0]) ? out[0] : null;
}

// The answer the side table recorded for id@v on this node.
function answersOf(deps, node) {
  const st = deps && deps.sideTable;
  if (!st || typeof st.answersFor !== 'function' || typeof node.id !== 'string' || !node.id) return null;
  const m = safe(() => st.answersFor(node.id));
  return m instanceof Map ? m : null;
}
function answerOf(answers, id, v) {
  const a = answers && isPosInt(v) ? answers.get(`${id}@${v}`) : null;
  if (!isObj(a) || typeof a.state !== 'string') return null;
  const out = { state: a.state };
  for (const k of ANSWER_FIELDS) if (typeof a[k] === 'string') out[k] = a[k];
  return out;
}

// Every item the node carries, before the projection: {item, see}.
function rawItems(deps, node) {
  const store = deps && deps.elements ? deps.elements : null;
  const carried = {};
  for (const { field, entry } of fieldEntries(node)) (carried[field] || (carried[field] = [])).push(entry);
  if (typeof node.id === 'string') carried.id = node.id;
  const copies = new Map((carried.comments || []).filter((c) => isObj(c) && typeof c.id === 'string').map((c) => [c.id, c]));
  const rows = leanElements(carried, store, { node: true, refs: true });
  const answers = answersOf(deps, node);
  const out = [];
  for (const row of rows) {
    const type = row.type;
    if (typeof type !== 'string' || !type) continue;
    // A page anchor rides only as a stroke's page record (the version's
    // payload a stroke, checked below); every other page anchor is left out.
    const page = isObj(row.anchor) && row.anchor.kind === 'page';
    if (page && !isPageRecord(row.anchor)) continue;
    if (isBuiltin(type) && !DRAWN_BUILTIN.has(type)) continue;
    if (isChat(deps, type)) continue;
    const rec = versionOf(store, row.id, row.v);
    if (page && !(rec && isStrokePayload(rec.payload))) continue;
    const copy = copies.get(row.id) || null;
    const src = rec && isObj(rec.payload) ? rec.payload : (copy && DRAWN_BUILTIN.has(type) ? maskedCopy(store, copy) : null);
    const seq = rec && Number.isSafeInteger(rec.seq) && rec.seq >= 0 ? rec.seq
      : copy && Number.isSafeInteger(copy.seq) && copy.seq >= 0 ? copy.seq : null;
    const it = {
      id: row.id,
      v: isPosInt(row.v) ? row.v : null,
      type,
      schema: typeof row.schema === 'string' ? row.schema : null,
      seq,
      anchor: isObj(row.anchor) ? row.anchor : null,
      shared: row.shared !== false,
      answer: answerOf(answers, row.id, row.v),
      payload: null,
    };
    // A node is never rewritten: the item keeps the pinned v and its draw
    // fields, and only reads private, so (3) below drops it for every reader
    // without seesPrivate (every file document); made shared again, the
    // latest reads shared and the pinned v draws everywhere.
    let withdrawnBy = null;
    if (it.shared && latestPrivate(store, row.id)) { it.shared = false; withdrawnBy = 'latest'; }
    if (row.state === 'masked') {
      it.state = row.state;
      for (const k of ['visible', 'explain']) if (row[k] !== undefined) it[k] = row[k];
    }
    const desc = listedRow(deps, type);
    if (desc && !reads(deps, type, it.schema, desc)) it.parked = true;
    else if (src && DRAWN_BUILTIN.has(type)) it.payload = builtinFields(type, src);
    else if (src && desc && !desc.builtin) it.payload = pluginFields(it.schema, src);
    out.push({ item: it, see: seeOf(deps, type), ...(withdrawnBy ? { withdrawnBy } : {}) });
  }
  return out;
}

// ── a type's row ────────────────────────────────────────────────────────────
const reasonOf = (e) => (e && (e.why || e.message)) || 'refused';

// '' when the module may ride, else the reason it may not.
function moduleProblem(type, text) {
  try { typeElement({ type, module: text, assets: {} }); } catch (e) {
    return /unsafe-splice/.test(String(e && e.message)) ? 'unsafe-splice' : 'draw-contract';
  }
  return drawModuleProblem(text) ? 'draw-contract' : '';
}

// A type's element.json settings defaults for its row (U512c; the document
// ctx's settings()): {small?, large?}, each {field: its schema default}, the
// levels with no default left out; null when no level has one.
function settingsDefaults(st) {
  if (!isObj(st)) return null;
  const out = {};
  for (const level of ['small', 'large']) {
    const props = isObj(st[level]) && isObj(st[level].properties) ? st[level].properties : null;
    if (!props) continue;
    const lv = {};
    for (const [k, p] of Object.entries(props)) if (isObj(p) && Object.hasOwn(p, 'default')) lv[k] = p.default;
    if (Object.keys(lv).length) out[level] = lv;
  }
  return Object.keys(out).length ? out : null;
}

function typeRow(deps, type, desc) {
  const place = desc.toolbar && PLACE_MODES.includes(desc.toolbar.place) ? desc.toolbar.place : PLACE_MODES[0];
  const record = deps && typeof deps.typeRecord === 'function' ? safe(() => deps.typeRecord(type)) : null;
  const row = {
    type,
    schema: desc.schema,
    reads: Array.isArray(desc.reads) ? desc.reads.slice() : [],
    place,
    module: '',
    sha256: record && typeof record.draw === 'string' && /^[0-9a-f]{64}$/.test(record.draw) ? record.draw : sha256(''),
    assets: {},
    skipped: [],
  };
  const defaults = settingsDefaults(desc.toolbar && desc.toolbar.settings);
  if (defaults) row.settings = defaults;
  const read = (rel) => {
    if (!deps || typeof deps.readTypeFile !== 'function') throw new TypeError('no type-file reader');
    return deps.readTypeFile(type, rel);
  };
  try {
    const f = read(DRAW_FILE);
    const text = Buffer.isBuffer(f.bytes) ? f.bytes.toString('utf8') : String(f.bytes);
    if (typeof f.sha256 === 'string') row.sha256 = f.sha256;
    const why = moduleProblem(type, text);
    if (why) row.skipped.push({ rel: DRAW_FILE, reason: why });
    else row.module = text;
  } catch (e) {
    row.skipped.push({ rel: DRAW_FILE, reason: reasonOf(e) });
  }
  for (const rel of record && Array.isArray(record.assets) ? record.assets : []) {
    if (typeof rel !== 'string' || !rel) continue;
    try {
      const f = read(`${ASSETS_DIR}/${rel}`);
      row.assets[rel] = `data:${f.type};base64,${Buffer.from(f.bytes).toString('base64')}`;
    } catch (e) {
      row.skipped.push({ rel, reason: reasonOf(e) });
    }
  }
  return row;
}

// ── sources ─────────────────────────────────────────────────────────────────
function sourcesOf(node, items) {
  const named = new Set(items.filter((it) => isObj(it.anchor) && it.anchor.kind === 'source' && typeof it.anchor.md === 'string')
    .map((it) => it.anchor.md));
  if (!named.size) return null;
  // Lazily: preview.js will require this module (U523).
  const { pageItems } = require('./preview');
  const out = {};
  for (const p of pageItems(node, { sourceMap: true })) {
    if (p && typeof p.md === 'string' && named.has(p.md) && !hasOwn(out, p.md)) out[p.md] = { src: p.src, map: p.map };
  }
  return Object.keys(out).length ? out : null;
}

// ── THE builder ─────────────────────────────────────────────────────────────
function documentElements(deps, node, { reader, route, item } = {}) {
  if (typeof route !== 'string' || !hasOwn(PRIVATE_RULES.routes, route)) {
    throw new TypeError(`documentElements: ${JSON.stringify(route)} has no PRIVATE_RULES.routes row (lib/core/remote-policy): a document route must be rowed`);
  }
  if (!isObj(reader)) throw new TypeError('documentElements: a reader is required (readerOf or fileReader)');
  const level = typeof reader.level === 'string' ? reader.level : 'basic';
  if (!isObj(node)) return null;

  // (1) the per-type gate, then the item cut.
  let items = rawItems(deps, node).filter((r) => atLeast(level, r.see)).map((r) => r.item);
  if (item != null) items = items.filter((it) => anchorItem({ anchor: it.anchor }) === item);
  if (!items.length) return null;

  let p = { v: CONTRACT_VERSION, builtins: [], types: [], items, removed: [] };
  // (2) below read, the route's TEXT_RULES row.
  if (!atLeast(level, 'read')) {
    p = stripText('routes', route, { doc_elements: p }).doc_elements;
    if (!isObj(p) || !Array.isArray(p.items)) return null;
  }
  // (3) unless the reader sees private records, the route's PRIVATE_RULES row.
  if (reader.seesPrivate !== true) p = dropPrivate('routes', route, { doc_elements: p }).doc_elements;
  const kept = isObj(p) && Array.isArray(p.items) ? p.items : [];
  if (!kept.length) return null;

  // What the kept items use, and nothing else.
  const builtins = [];
  const types = [];
  const removed = [];
  for (const type of sorted(kept.map((it) => it.type))) {
    if (DRAWN_BUILTIN.has(type)) { builtins.push(type); continue; }
    const desc = listedRow(deps, type);
    if (desc && !desc.builtin) types.push(typeRow(deps, type, desc));
    else removed.push(type);
  }
  const gone = new Set(removed);
  const out = {
    v: CONTRACT_VERSION,
    builtins,
    types,
    items: kept.map((it) => (gone.has(it.type) && it.payload !== null ? { ...it, payload: null } : it)),
    removed,
  };
  const sources = sourcesOf(node, out.items);
  if (sources) out.sources = sources;
  return out;
}

module.exports = { documentElements, readerOf, fileReader, documentDeps, typeRecordOf };
