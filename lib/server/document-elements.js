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
// The draw fields come from the log's masked view (store.version(id,
// v).payload: text through the redactor now; a comment copy the log cannot
// map, from the copy through maskPins), by elements-doc-src's allowlist
// (BUILTIN_FIELDS; a plug-in type its schema's keys less anchor, shared,
// chain and every FORBIDDEN key). LEFT OUT: an unresolvable reference (no
// type), a page-anchored record and every built-in the documents do not draw
// (the box grab, never drawn by the live page host either; the chat comment,
// never on a node: L2), a chat-family element (defensive), and always chain,
// writer, provenance, author, edited, meta and grab. THE ANSWER is the side
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
// recorded digest. A module rides only when it holds exactly one line opening
// elements-doc-src MODULE_HEAD (RULED U512-U522@draw-module-contract a), no
// static import, and nothing elements-doc-src typeElement refuses to splice;
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
// Required by its file name: test/anchors-served.test.js counts every file
// that requires the module by its bare name as a user of the resolver's
// document copy (each splices it), and this module splices nothing.
const { fieldEntries } = require('./runtime/anchors-src.js');
const {
  CONTRACT_VERSION, BUILTIN_TYPES, BUILTIN_FIELDS, FORBIDDEN, MODULE_HEAD, typeElement,
} = require('./runtime/elements-doc-src');
const { atLeast, stripText, dropPrivate, PRIVATE_RULES, ELEMENT_POLICY } = require('../core/remote-policy');
const { BUILTIN_ELEMENT_TYPES } = require('../core/element-policy');
const { ASSETS_DIR, DRAW_FILE } = require('../core/element-assets');
const { schemaRow } = require('../core/element-log');
const { PLACE_MODES } = require('../packs/elements');

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
// A static import or re-export anywhere in a module (a dynamic import is not
// one: it has its own home, U512's loader, and is refused by B1's realm rule).
// Its boundary is a line start, a statement's end or a brace, or a block
// comment's end. moduleProblem tests it against the raw text AND the text with
// its comments blanked (blankComments), so a comment inside or before one
// (`import/**/x from …`, `export {a /* } */} from …`) cannot hide it, and a
// comment opener inside a string (`"//"; import x …`) is caught by the raw test.
const STATIC_IMPORT = /(?:^|[;{}]|\*\/)\s*import\s*(?:[\w$]+\s*(?:,|\bfrom\b)|[{*'"`])|(?:^|[;{}]|\*\/)\s*export\s*(?:\*|\{[^}]*\})\s*from\b/m;

// The text with each `/*…*/` and `//…` OUTSIDE a '…', "…" or `…` literal
// replaced by one space (a line comment keeps its newline). One scan; a '…' or
// "…" literal ends at its quote or the line's end, as in JavaScript.
function blankComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== c && (c === '`' || text[j] !== '\n')) j += text[j] === '\\' ? 2 : 1;
      j = Math.min(n, j + 1);
      out += text.slice(i, j);
      i = j;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      out += ' ';
      i = end < 0 ? n : end + 2;
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i + 2);
      out += ' ';
      i = end < 0 ? n : end;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

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
  const { drawDigest } = require('./element-files');
  const { findPack } = require('../packs/store');
  const { unitsOf } = require('../packs/kinds');
  const found = safe(() => findPack(ctx.root, row.pack, row.tier));
  const unit = found && found.pack ? unitsOf(found.pack.units, 'element').find((u) => u.name === row.type) : null;
  const prefix = `${ASSETS_DIR}/`;
  const assets = (unit && Array.isArray(unit.files) ? unit.files : [])
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
  for (const k of keys) if (!NOT_DRAWN.has(k) && hasOwn(src, k)) out[k] = src[k] === undefined ? null : src[k];
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
    if (isObj(row.anchor) && row.anchor.kind === 'page') continue;
    if (isBuiltin(type) && !DRAWN_BUILTIN.has(type)) continue;
    if (isChat(deps, type)) continue;
    const rec = versionOf(store, row.id, row.v);
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
    if (row.state === 'masked') {
      it.state = row.state;
      for (const k of ['visible', 'explain']) if (row[k] !== undefined) it[k] = row[k];
    }
    const desc = listedRow(deps, type);
    if (desc && !reads(deps, type, it.schema, desc)) it.parked = true;
    else if (src && DRAWN_BUILTIN.has(type)) it.payload = builtinFields(type, src);
    else if (src && desc && !desc.builtin) it.payload = pluginFields(it.schema, src);
    out.push({ item: it, see: seeOf(deps, type) });
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
  const heads = text.split(/\r?\n/).filter((l) => l.startsWith(MODULE_HEAD)).length;
  if (heads !== 1 || STATIC_IMPORT.test(text) || STATIC_IMPORT.test(blankComments(text))) return 'draw-contract';
  return '';
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
