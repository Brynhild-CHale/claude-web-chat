'use strict';
// The documents' side of the element overlay (annotation engine tranche 4,
// PLAN.md 4B.1; DECISIONS.md B3, R1 stage B, K.2-141; GT-17's generic-mark
// clause). Every node preview, replay frame and page export that draws
// elements carries what this module hands it, and nothing else draws an
// element in a document. It owns three things:
//
// (1) THE PAYLOAD CONTRACT v1 — the shape lib/server/document-elements.js
// (U521) builds and every document reads (U523 preview, U524 export, U525
// replay, U526 the export cap, U564 the picture). validatePayload(p) → null |
// a reason string; the field lists below are frozen and exported, and
// test-support/doc-elements-fixture.js is the fixture other units build
// against.
//
//   payload   {v: 1, builtins, types, items, removed, sources?, stripped?}
//   builtins  the sorted built-in type names the items use (BUILTIN_TYPES:
//             comment, highlight): the runtime's cut key. Never the box grab:
//             a page anchor is never drawn, so its records are never items.
//   types     one row per LISTED plug-in type an item uses, sorted by type:
//             {type, schema, reads, place ('glyph' | 'box': the manifest's
//             field, lib/packs/elements PLACE_MODES), module (draw.js's text
//             exactly as installed), sha256 (its digest as the install record
//             holds it), assets ({'<path below assets/>': 'data:<media
//             type>;base64,…'}, each key a path mediaOf accepts under
//             'assets/', with no 'assets/' prefix of its own), skipped
//             ([{rel, reason}]: an asset left out, by the same rel),
//             settings? ({small?, large?}: each {field: element.json's default}
//             for the fields its settings schema declares with a default — a
//             string, a finite number or a boolean; the defaults a document's
//             ctx.settings() answers, U512c; absent reads as none)}
//   items     sorted by id: {id, v, type, schema, seq, anchor, shared,
//             answer: {state, how?, why?} | null (the side table's recorded
//             answer), payload: object | null, parked?: true, state?,
//             visible?, explain?}. state/visible/explain only on a row the
//             read view served masked (lib/server/domain/element-projection
//             SERVED_STATE). payload is the type's draw fields by allowlist:
//             comment {text, replies: [{text, claude}]} (claude: the reply's
//             author is Claude), highlight {color, note}, a plug-in type its
//             schema's keys less anchor, shared and chain; null for a parked
//             item or one of a removed type. NEVER in a payload (FORBIDDEN):
//             writer, provenance, author, edited, chain, a box grab's meta or
//             grab, a reply's seq, a side-table answer's gen, surface, qual,
//             source or device — attribution and engine bookkeeping, never a
//             draw field (C-15-3).
//   removed   the sorted names of item types the registry does not list.
//   sources   (optional; the markdown source map carried into documents,
//             PLAN.md 1C.3): {'<markdown item id>': {src, map}} for each
//             markdown item a source-anchored item (anchor kind 'source')
//             names, as lib/server/preview.js pageItems(node, {sourceMap:
//             true}) gives them (src the LF-normalised text, map
//             lib/core/markdown sourceMap's). Its bound, per row (RULED
//             U522a@sources-bound-per-character a): src at most
//             lib/server/domain/page.js MARKDOWN_MAX_CHARS (the one cap on a
//             markdown item's text) and map at most src.length + lines
//             entries (its runs and headings): each mapped run covers at
//             least one character of src and each heading is a line, so a
//             map that fits its src always passes and one that does not never
//             does; a row over it, or one no item names, is refused naming
//             its item. Its bytes
//             count in the element payload's export budget (AJ2 a). The
//             runtime installs it itself (its own sources(table)).
//   stripped  (optional; written only by the export cap, U526):
//             [{kind: 'asset' | 'item', type, rel?, id?, bytes, reason}].
//
// (2) THE RUNTIME — a classic script, the factory elementsRuntime below,
// served compacted by lib/server/runtime/anchors-src.js compact (whole-line
// comments, blank lines and leading indentation dropped: the one compaction
// rule, the resolver's), cut to
// the payload's key (keyOf: the built-ins it uses, plus 'box' when a type
// places as a box) and memoised per key, read on first use and never at
// require time. It installs window.__wcMount.elements = {define(type, draw,
// assets, {glyph, sourceGlyph}), draw(payload), sources(table), stats()} and adds no element id to
// any document: one `.wc-el-layer` div and one style element, classes only
// (an id a document adds must be in lib/server/domain/mounts.js RESERVED_IDS).
// It reads the data element (`script[data-wc-elements]`) at its first pass,
// draws after each pane's settle (__wcMount.onSettle) and once at window
// load, and re-places on resize and scroll. Per item: the READS GATE first (a
// parked item, or a schema its type's `reads` does not hold, draws the
// generic mark and its draw never runs: C-5); then DRAW_RULES below (a copy
// of public/app/overlay.js DRAW_RULES, held equal by
// test/elements-doc-runtime.test.js): the served masked state beats every
// other, the recorded answer decides the state when the item carries one,
// the document's own resolve when it does not; the POSITION is always the
// document resolver's (__wcMount.anchor: resolve, resolveRange,
// resolveSource, and pointAt for a point record), and a recorded hit the
// document cannot place draws nothing and is counted unplaced. A glyph type
// draws a glyph-sized marker at its anchor's top-left (its glyph: a plug-in's
// `glyph` export, the highlight's handle HANDLE_GLYPH, else the overlay's
// MARKER_GLYPH — overlay.js glyphOf). THE MARGIN GLYPH (RULED
// U522a@margin-glyph-in-documents a; overlay.js marginItemOf / marginGlyph):
// a range group whose start lies inside a markdown item ([data-md-id]) and
// whose type has a sourceGlyph (the comment's SOURCE_GLYPH, comments.js's,
// held equal by the parity test; a plug-in's `sourceGlyph` export) is drawn
// at the item's left edge, level with the range's first line, with
// sourceGlyph's offsets and the type's glyph size; when the document's .page
// gives no gutter for it the glyph is INSET — clamped so its box stays inside
// the .page box — never clipped and never dropped. A box type (place
// 'box', an element anchor) mirrors U516's box marker: the group's container
// is the target's rect, clipped to its pane's host, never over a displayed
// frame, drawn once at its first drawn placement with ctx.box {w, h} read
// live, so a resize rescales it and never redraws it. The built-ins ship no
// draw.js, so the runtime draws them (the comment's pin, answered when a
// reply is Claude's, with a native title tooltip of its text and reply
// count; the highlight's tinted rectangles over its range). THE GENERIC
// MARK (el-marker el-generic el-standin, an el-generic-name span holding the
// type) stands in for a removed type, a type whose module defined nothing by
// load, a draw that throws and a parked item; nothing is thrown out of the
// runtime. Every marker carries data-type and data-el-ids (its group's ids,
// space-joined), as the live overlay's rebuild sets them. The draw ctx is
// the live drawCtx's fields plus `document: true` and asset(rel): the
// inlined data: URI of the type's rel (a path below assets/, never with a
// leading slash, a '..' segment or an 'assets/' prefix), null when it was
// skipped; a plug-in group's ctx also carries settings() (U512c: a frozen
// {small, large} of its row's element.json defaults — a document has no
// saved settings and no armed tool; the live draw ctx's answer for a type
// that is not armed, public/app/element-types.js settingsFor) and record(id), as the live
// pluginCtx does (public/app/element-types.js): a frozen record in the GET's
// shape, FLAT — {id, v, type, schema, anchor, shared, …the payload's keys},
// never a nested `payload` (RULED U522b, finding U565@ctx-record-shape: one
// shape in both realms) — built from the data element's item of that id,
// null for an id the data element does not hold or an item of another type. A built-in's ctx has no record, as live. A
// document is read-only: no create, input, tray or write.
//
// (3) THE ONE SPELLING of the splice: scripts(payload) → '' for null or a
// payload with no items (so a document whose reader sees no element keeps
// exactly today's bytes), else runtimeElement(keyOf(p)) + typeElement(row)…
// (types order) + dataElement(p), each ending in '\n'. The parts are
// exported so the replay carries the runtime once per key and each type once.
// A plug-in draw.js rides as an inline module of its exact bytes, a newline
// and one engine line naming its default export, `draw` (RULED
// U512-U522@draw-module-contract a), and its glyph and sourceGlyph named
// exports as a fourth argument, each read through `typeof` so a module that
// declares neither still loads (RULED U522a@plugin-glyph-exports a): no eval,
// no dynamic import, no blob:, no network and no change to PREVIEW_CSP. A
// module holding a script end tag or an HTML comment opener is never spliced,
// and a row with no module (module '': a draw.js lib/server/document-elements
// left out, named in its skipped) is not spliced at all: its items draw the
// generic mark. The data element carries the
// payload less each type row's module and assets: they ride the type's own
// element, once.
//
// The documents splice scripts(payload) immediately after the resolver's
// scriptElement, and only where anchors-src carriesElements(node) holds
// (THE one test) and the reader's payload has items.
//
// RESTART: the runtime is memoised per process, so an edit to this file
// reaches previews, replays and exports only after `claude-web-chat restart`
// and a refresh of the document.

const { ANCHOR_STATES } = require('../../core/anchor-states');
const { mediaOf, ASSETS_DIR } = require('../../core/element-assets');
const { MARKDOWN_MAX_CHARS } = require('../domain/page');
// The one compaction rule, the resolver's: compact alone (this module splices
// no resolver; test/anchors-served.test.js pins it among the users that take
// neither source nor scriptElement).
const { compact } = require('./anchors-src');

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

// ── the contract's tables ───────────────────────────────────────────────────
const CONTRACT_VERSION = 1;
// The built-in types a document draws (never the box grab: a page anchor;
// never the chat's comment: L2).
const BUILTIN_TYPES = Object.freeze(['comment', 'highlight']);
const PAYLOAD_KEYS = Object.freeze(['v', 'builtins', 'types', 'items', 'removed', 'sources', 'stripped']);
const TYPE_KEYS = Object.freeze(['type', 'schema', 'reads', 'place', 'module', 'sha256', 'assets', 'skipped', 'settings']);
// A type row's settings levels (U512c), as lib/packs/elements' settings field.
const SETTINGS_LEVELS = Object.freeze(['small', 'large']);
const ITEM_KEYS = Object.freeze(['id', 'v', 'type', 'schema', 'seq', 'anchor', 'shared', 'answer', 'payload',
  'parked', 'state', 'visible', 'explain']);
const ANSWER_KEYS = Object.freeze(['state', 'how', 'why']);
const SKIPPED_KEYS = Object.freeze(['rel', 'reason']);
const STRIPPED_KEYS = Object.freeze(['kind', 'type', 'rel', 'id', 'bytes', 'reason']);
const STRIPPED_KINDS = Object.freeze(['asset', 'item']);
// A sources row's keys (its bound is checkSources': per character of src).
const SOURCE_KEYS = Object.freeze(['src', 'map']);
// A built-in's draw fields, and a comment reply's.
const BUILTIN_FIELDS = Object.freeze({
  comment: Object.freeze(['text', 'replies']),
  highlight: Object.freeze(['color', 'note']),
});
const REPLY_KEYS = Object.freeze(['text', 'claude']);
// Never a key of an item's payload, whatever its type.
const FORBIDDEN = Object.freeze(['writer', 'provenance', 'author', 'edited', 'chain', 'meta', 'grab', 'seq', 'gen',
  'surface', 'qual', 'source', 'device', 'anchor', 'shared']);
// The masked served state: the one value an item's `state` may hold.
const MASKED = stateOf('masked');
// A draw.js's default export, as the one engine line names it (RULED
// U512-U522@draw-module-contract a).
const MODULE_HEAD = 'export default function draw(';
// What may never be spliced into a document's script element.
const UNSAFE_SPLICE = /<\/script|<!--/i;

function stateOf(name) {
  if (!ANCHOR_STATES.includes(name)) throw new Error(`elements-doc-src: the state vocabulary has no ${name}`);
  return name;
}

// ── the draw rules (a copy of public/app/overlay.js DRAW_RULES) ─────────────
// The overlay's rows, first match wins, each as {state, how, guess, draw,
// cls}: held equal to overlay.js's export by test/elements-doc-runtime.test.js
// (the templates/claude-mod WIRE precedent) — never a second set of rules.
const EXACT = stateOf('exact');
const RE_RESOLVED = stateOf('re-resolved');
const ORPHANED = stateOf('orphaned');
const rule = (state, how, guess, draw, cls) => Object.freeze({ state, how, guess, draw, cls });
const DRAW_RULES = Object.freeze([
  rule(EXACT, null, null, 'hit', 'el-hit'),
  rule(RE_RESOLVED, 'section', null, 'section', 'el-section'),
  rule(RE_RESOLVED, null, null, 'hit', 'el-hit'),
  rule(ORPHANED, null, true, 'guess', 'el-guess'),
  rule(ORPHANED, null, false, 'none', null),
  rule(stateOf('hidden'), null, null, 'none', null),
  rule(MASKED, null, null, 'hit', 'el-masked'),
  rule(stateOf('superseded'), null, null, 'hit', 'el-superseded'),
  rule(stateOf('indexing'), null, null, 'hit', 'el-indexing'),
  rule(stateOf('unavailable'), null, null, 'hit', 'el-unavailable'),
]);
// The overlay's generic glyph (overlay.js MARKER_GLYPH) and the highlight's
// handle (highlight.js HANDLE_GLYPH), held equal by the same test.
const MARKER_GLYPH = Object.freeze({ dx: -13, dy: -26, w: 26, h: 26 });
const HANDLE_GLYPH = Object.freeze({ dx: -4, dy: -4, w: 8, h: 8 });
// The comment's margin offsets (comments.js SOURCE_GLYPH), held equal by the
// same test.
const SOURCE_GLYPH = Object.freeze({ dx: -27, dy: -4 });

// ── validatePayload ─────────────────────────────────────────────────────────
const isStr = (s) => typeof s === 'string';
const isSorted = (a, by = (x) => x) => a.every((x, i) => i === 0 || by(a[i - 1]) < by(x));
const unknownKey = (o, keys) => Object.keys(o).find((k) => !keys.includes(k));
const isPosInt = (n) => Number.isSafeInteger(n) && n > 0;

// A rel of a type's assets: a path below assets/, with no prefix of its own;
// mediaOf (the one grammar) decides the rest, and it must name an asset.
function assetRelOk(rel) {
  if (!isStr(rel) || !rel || rel.startsWith('/') || rel.startsWith(`${ASSETS_DIR}/`)) return null;
  const media = mediaOf(`${ASSETS_DIR}/${rel}`);
  return media.refused || media.kind === 'draw' ? null : media;
}

function checkStrList(list, what) {
  if (!Array.isArray(list) || !list.every(isStr)) return `${what} is not a list of names`;
  if (!isSorted(list)) return `${what} is not sorted, or repeats a name`;
  return null;
}

function checkType(row, i, removed) {
  const at = `types[${i}]`;
  if (!isObj(row)) return `${at} is not an object`;
  const extra = unknownKey(row, TYPE_KEYS);
  if (extra) return `${at}: unknown key ${extra}`;
  if (!isStr(row.type) || !row.type) return `${at}: no type`;
  if (BUILTIN_TYPES.includes(row.type)) return `${at}: ${row.type} is a built-in, never a plug-in row`;
  if (removed.includes(row.type)) return `${at}: a module on a removed type (${row.type})`;
  if (!isStr(row.schema) || !row.schema) return `${at}: no schema`;
  if (!Array.isArray(row.reads) || !row.reads.every(isStr)) return `${at}: reads is not a list of schemas`;
  const { PLACE_MODES } = require('../../packs/elements');
  if (!PLACE_MODES.includes(row.place)) return `${at}: place is not one of ${PLACE_MODES.join(', ')}`;
  if (!isStr(row.module)) return `${at}: no module`;
  if (!isStr(row.sha256) || !/^[0-9a-f]{64}$/.test(row.sha256)) return `${at}: sha256 is not a hex digest`;
  if (!isObj(row.assets)) return `${at}: assets is not an object`;
  for (const [rel, uri] of Object.entries(row.assets)) {
    const media = assetRelOk(rel);
    if (!media) return `${at}: assets: ${JSON.stringify(rel)} is not a path below ${ASSETS_DIR}/`;
    if (!isStr(uri) || !uri.startsWith(`data:${media.type};base64,`) || !/^[A-Za-z0-9+/]*={0,2}$/.test(uri.slice(uri.indexOf(',') + 1))) {
      return `${at}: assets: ${rel} is not a data: URI of ${media.type}`;
    }
  }
  if (!Array.isArray(row.skipped)) return `${at}: skipped is not a list`;
  for (const s of row.skipped) {
    if (!isObj(s)) return `${at}: skipped holds a non-object`;
    const k = unknownKey(s, SKIPPED_KEYS);
    if (k) return `${at}: skipped: unknown key ${k}`;
    if (!isStr(s.rel) || !isStr(s.reason)) return `${at}: skipped needs {rel, reason}`;
  }
  return row.settings === undefined ? null : checkSettings(row.settings, at);
}

// A type row's settings defaults: {small?, large?}, each {field: a string, a
// finite number or a boolean}.
function checkSettings(st, at) {
  if (!isObj(st)) return `${at}: settings is not {small?, large?}`;
  const extra = unknownKey(st, SETTINGS_LEVELS);
  if (extra) return `${at}: settings: ${extra} is not a settings level (small, large)`;
  for (const level of SETTINGS_LEVELS) {
    if (st[level] === undefined) continue;
    if (!isObj(st[level])) return `${at}: settings.${level} is not an object`;
    for (const [k, v] of Object.entries(st[level])) {
      if (!(isStr(v) || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) {
        return `${at}: settings.${level}.${k} is not a string, a finite number or a boolean`;
      }
    }
  }
  return null;
}

function checkBuiltinPayload(type, p, at) {
  const extra = unknownKey(p, BUILTIN_FIELDS[type]);
  if (extra) return `${at}.payload: unknown key ${extra}`;
  if (type === 'comment') {
    if (p.text !== undefined && !isStr(p.text)) return `${at}.payload: text is not a string`;
    if (p.replies !== undefined) {
      if (!Array.isArray(p.replies)) return `${at}.payload: replies is not a list`;
      for (const r of p.replies) {
        if (!isObj(r)) return `${at}.payload: a reply is not an object`;
        const k = unknownKey(r, REPLY_KEYS);
        if (k) return `${at}.payload: a reply's unknown key ${k}`;
        if ((r.text !== undefined && !isStr(r.text)) || typeof r.claude !== 'boolean') return `${at}.payload: a reply needs {text?, claude}`;
      }
    }
  } else {
    for (const k of ['color', 'note']) if (p[k] !== undefined && p[k] !== null && !isStr(p[k])) return `${at}.payload: ${k} is not a string`;
  }
  return null;
}

function checkItem(it, i, names) {
  const at = `items[${i}]`;
  if (!isObj(it)) return `${at} is not an object`;
  const extra = unknownKey(it, ITEM_KEYS);
  if (extra) return `${at}: unknown key ${extra}`;
  if (!isStr(it.id) || !it.id) return `${at}: no id`;
  if (it.v !== null && !isPosInt(it.v)) return `${at}: v is not a positive integer or null`;
  if (!isStr(it.type) || !names.all.has(it.type)) return `${at}: its type ${JSON.stringify(it.type)} is in none of builtins, types and removed`;
  if (it.schema !== null && !isStr(it.schema)) return `${at}: schema is not a string or null`;
  if (it.seq !== null && !(Number.isSafeInteger(it.seq) && it.seq >= 0)) return `${at}: seq is not a count or null`;
  if (it.anchor !== null && !isObj(it.anchor)) return `${at}: anchor is not an object or null`;
  if (it.anchor && it.anchor.kind === 'page') return `${at}: a page anchor is never drawn, so never an item`;
  if (typeof it.shared !== 'boolean') return `${at}: shared is not a boolean`;
  if (it.answer !== null) {
    if (!isObj(it.answer)) return `${at}: answer is not an object or null`;
    const k = unknownKey(it.answer, ANSWER_KEYS);
    if (k) return `${at}.answer: unknown key ${k}`;
    if (!ANCHOR_STATES.includes(it.answer.state)) return `${at}.answer: no state`;
  }
  if (it.parked !== undefined && it.parked !== true) return `${at}: parked is true or absent`;
  if (it.state !== undefined || it.visible !== undefined || it.explain !== undefined) {
    if (it.state !== MASKED) return `${at}: state, visible and explain ride only a row served masked`;
    for (const k of ['visible', 'explain']) if (it[k] !== undefined && it[k] !== null && !isStr(it[k])) return `${at}: ${k} is not a string`;
  }
  if (it.payload === null) return null;
  if (!isObj(it.payload)) return `${at}: payload is not an object or null`;
  if (it.parked) return `${at}: a payload on a parked item`;
  if (names.removed.has(it.type)) return `${at}: a payload on an item of a removed type`;
  const bad = FORBIDDEN.find((k) => hasOwn(it.payload, k));
  if (bad) return `${at}.payload: ${bad} is never in a payload`;
  return BUILTIN_TYPES.includes(it.type) ? checkBuiltinPayload(it.type, it.payload, at) : null;
}

function checkStripped(list) {
  if (!Array.isArray(list)) return 'stripped is not a list';
  for (const [i, s] of list.entries()) {
    if (!isObj(s)) return `stripped[${i}] is not an object`;
    const k = unknownKey(s, STRIPPED_KEYS);
    if (k) return `stripped[${i}]: unknown key ${k}`;
    if (!STRIPPED_KINDS.includes(s.kind) || !isStr(s.type) || !isStr(s.reason)
      || !(Number.isSafeInteger(s.bytes) && s.bytes >= 0)) return `stripped[${i}] needs {kind, type, bytes, reason}`;
    if ((s.rel !== undefined && !isStr(s.rel)) || (s.id !== undefined && !isStr(s.id))) return `stripped[${i}]: rel and id are strings`;
  }
  return null;
}

// The sources table: one row per markdown item a source-anchored item names,
// each within its bound: src at most MARKDOWN_MAX_CHARS, its map at most
// src.length + lines entries.
function checkSources(table, items) {
  if (!isObj(table)) return 'sources is not an object';
  const named = new Set(items.filter((it) => it.anchor && it.anchor.kind === 'source').map((it) => it.anchor.md));
  for (const [md, row] of Object.entries(table)) {
    const at = `sources[${JSON.stringify(md)}]`;
    if (!named.has(md)) return `${at}: no source-anchored item names the markdown item ${md}`;
    if (!isObj(row)) return `${at} is not an object`;
    const k = unknownKey(row, SOURCE_KEYS);
    if (k) return `${at}: unknown key ${k}`;
    if (!isStr(row.src) || !isObj(row.map)) return `${at} needs {src, map}`;
    if (row.src.length > MARKDOWN_MAX_CHARS) {
      return `${at}: src is over MARKDOWN_MAX_CHARS (${MARKDOWN_MAX_CHARS} characters): the markdown item ${md}`;
    }
    const { runs, headings } = row.map;
    if ((runs !== null && !Array.isArray(runs)) || !Array.isArray(headings)) return `${at}: map needs runs (a list or null) and headings`;
    const lines = row.src.split('\n').length;
    const bound = row.src.length + lines;
    if ((runs ? runs.length : 0) + headings.length > bound) {
      return `${at}: map is over src.length + lines entries (${bound}): the markdown item ${md}`;
    }
  }
  return null;
}

// validatePayload(p) → null when p is a payload of contract v1, else the
// first reason it is not.
function validatePayload(p) {
  if (!isObj(p)) return 'the payload is not an object';
  const extra = unknownKey(p, PAYLOAD_KEYS);
  if (extra) return `unknown key ${extra}`;
  if (p.v !== CONTRACT_VERSION) return `v is not ${CONTRACT_VERSION}`;
  let why = checkStrList(p.builtins, 'builtins') || checkStrList(p.removed, 'removed');
  if (why) return why;
  const notBuiltin = p.builtins.find((t) => !BUILTIN_TYPES.includes(t));
  if (notBuiltin) return `builtins: ${notBuiltin} is not a built-in a document draws`;
  if (!Array.isArray(p.types) || !Array.isArray(p.items)) return 'types and items are lists';
  for (const [i, row] of p.types.entries()) if ((why = checkType(row, i, p.removed))) return why;
  if (!isSorted(p.types, (r) => r.type)) return 'types is not sorted by type, or repeats one';
  const shadowed = p.removed.find((t) => BUILTIN_TYPES.includes(t));
  if (shadowed) return `removed: ${shadowed} is a built-in`;
  const names = {
    all: new Set([...p.builtins, ...p.types.map((r) => r.type), ...p.removed]),
    removed: new Set(p.removed),
  };
  for (const [i, it] of p.items.entries()) if ((why = checkItem(it, i, names))) return why;
  if (!isSorted(p.items, (it) => it.id)) return 'items is not sorted by id, or repeats one';
  const used = new Set(p.items.map((it) => it.type));
  const idle = [...names.all].find((t) => !used.has(t));
  if (idle) return `${idle} is listed but no item uses it`;
  if (p.sources !== undefined && (why = checkSources(p.sources, p.items))) return why;
  if (p.stripped !== undefined && (why = checkStripped(p.stripped))) return why;
  return null;
}

// ── the runtime (a classic script; the factory's own text is served) ────────
// AUTHORING RULES (the text is compacted, spliced into a document's script
// element and evaluated there): ES5 only — var/function, no arrow, let, const,
// class, template literal or spread; comments only on whole lines starting
// with //, never a block comment, never a // inside a string; no multi-line
// string; never a script end tag or an HTML comment opener; no network, no
// eval, no dynamic import, no Function constructor; no element id. Its
// sections sit under one-line banners, so keyOf's cut leaves out a built-in
// no item uses. test/elements-doc-runtime.test.js pins every rule.
function elementsRuntime(K) {
  var M = window.__wcMount;
  if (!M || M.elements) return;
  var doc = document;
  var RULES = K.rules.map(function (r) { return { state: r[0], how: r[1], guess: r[2], draw: r[3], cls: r[4] }; });
  var BUILTIN = {};
  var defs = {};
  var P = null;
  var SRC = null;
  var loaded = doc.readyState === 'complete';
  var queued = false;
  var layer = null;
  var groups = [];
  var sig = null;
  var base = zero();
  var counts = zero();
  var tokens = new WeakMap();
  var nextTok = 1;
  var hasOwn = Object.prototype.hasOwnProperty;
  var CSS = ['.wc-el-layer{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:4}',
    '.wc-el-layer .el-marker{position:absolute;box-sizing:border-box;line-height:0;color:var(--wc-comment,#cc592e)}',
    '.wc-el-layer .el-generic{display:flex;align-items:center;justify-content:center;overflow:hidden;line-height:1;border:1.5px solid currentColor;border-radius:var(--wc-radius-sm,4px);background:var(--wc-panel-bg,#fff);color:var(--wc-accent,#0969da);font:600 8px var(--wc-mono,monospace);text-transform:uppercase}',
    '.wc-el-layer .el-generic-name{overflow:hidden;white-space:nowrap}',
    '.wc-el-layer .el-guess{color:var(--wc-gold,#d4a72c);opacity:.8;border:1.5px dashed var(--wc-gold,#d4a72c)}',
    '.wc-el-layer .el-section{color:var(--wc-muted,#57606a);border:1.5px dotted currentColor;opacity:.85}',
    '.wc-el-layer .el-masked{border:1.5px dashed currentColor;border-radius:var(--wc-radius-sm,4px)}',
    '.wc-el-layer .el-indexing{border:1.5px dotted currentColor;opacity:.8}',
    '.wc-el-layer .el-superseded,.wc-el-layer .el-unavailable{color:var(--wc-muted,#57606a);opacity:.6}'];

  function zero() { return { drawn: 0, generic: 0, parked: 0, unplaced: 0, clipped: 0 }; }
  function has(list, v) { return !!list && list.indexOf(v) >= 0; }
  function warn(what, e) { try { console.error('[web-chat] document elements: ' + what, e); } catch (x) { return; } }
  function data() {
    if (P) return P;
    var el = doc.querySelector('script[data-wc-elements]');
    if (!el) return null;
    try { P = JSON.parse(el.textContent); } catch (e) { warn('the payload is not JSON', e); }
    if (P && P.sources) M.elements.sources(P.sources);
    return P;
  }
  function rowOf(type) {
    var ts = (P && P.types) || [];
    for (var i = 0; i < ts.length; i++) if (ts[i] && ts[i].type === type) return ts[i];
    return null;
  }
  function ruleOf(state, how, guess) {
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      if (r.state !== state) continue;
      if (r.how != null && r.how !== how) continue;
      if (r.guess != null && r.guess !== guess) continue;
      return r;
    }
    return null;
  }
  function tok(o) {
    var t = tokens.get(o);
    if (!t) { t = nextTok++; tokens.set(o, t); }
    return t;
  }
  function rectOf(x) {
    if (!x) return null;
    if (typeof x.getClientRects === 'function' && x.nodeType === undefined) {
      var rs = x.getClientRects();
      if (rs && rs.length) return rs[0];
    }
    return typeof x.getBoundingClientRect === 'function' ? x.getBoundingClientRect() : null;
  }
  function rectsOf(range) {
    var out = [];
    var rs = range && typeof range.getClientRects === 'function' ? range.getClientRects() : [];
    for (var i = 0; i < rs.length; i++) out.push(rs[i]);
    return out;
  }
  function itemOf(id) { return id == null ? null : M.itemEl(doc, id); }
  function assetOf(type, rel) {
    if (typeof rel !== 'string' || !rel || rel.charAt(0) === '/' || rel.indexOf('assets/') === 0) return null;
    if (('/' + rel + '/').indexOf('/../') >= 0) return null;
    var a = defs[type] && defs[type].assets;
    return a && hasOwn.call(a, rel) && typeof a[rel] === 'string' ? a[rel] : null;
  }
  function frozen(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (var k in o) if (hasOwn.call(o, k)) frozen(o[k]);
    }
    return o;
  }
  // record(id) for a plug-in type's draw: its item in the GET's shape, FLAT
  // (the payload's keys beside id, v, type, schema, anchor and shared, never
  // over one of them; no `payload` key), or null.
  function recordOf(type, id) {
    var its = (P && P.items) || [];
    for (var i = 0; i < its.length; i++) {
      var it = its[i];
      if (it && String(id) === it.id && it.type === type) {
        var o = { id: it.id, v: it.v, type: type, schema: it.schema, anchor: it.anchor, shared: it.shared }, pl = it.payload || {};
        for (var k in pl) if (!hasOwn.call(o, k)) o[k] = pl[k];
        return frozen(JSON.parse(JSON.stringify(o)));
      }
    }
    return null;
  }
  function ctxOf(g) {
    var x = { layer: layer, host: 'page', scope: g.scope, glyph: g.glyph, previewing: true, document: true,
      rectOf: rectOf, rectsOf: rectsOf, asset: function (rel) { return assetOf(g.type, rel); } };
    if (!BUILTIN[g.type]) x.record = function (id) { return id == null ? null : recordOf(g.type, id); };
    // settings() (U512c): a frozen {small, large} of the row's element.json
    // defaults, a fresh copy per call; never a writer.
    if (!BUILTIN[g.type]) x.settings = function () { var s = (rowOf(g.type) || {}).settings || {}; return frozen(JSON.parse(JSON.stringify({ small: s.small || {}, large: s.large || {} }))); };
    if (g.place === 'box') x.box = g.box;
    return x;
  }
  // A type's own fields (a built-in's, else a defined plug-in's); its glyph
  // (overlay.js glyphOf: its own, else the overlay's).
  function typeOf(t) { return BUILTIN[t] || defs[t] || {}; }
  function glyphOf(t) { return typeOf(t).glyph || K.glyph; }
  // THE MARGIN GLYPH (overlay.js marginItemOf / marginGlyph): the markdown
  // item a range group's start lies in, when its type has a sourceGlyph; and
  // the glyph it is drawn with there (sourceGlyph's offsets, the type's size).
  function marginItemOf(t, range) {
    var sc = range.startContainer;
    var st = sc && (sc.nodeType === 1 ? sc : sc.parentNode);
    return typeOf(t).sourceGlyph && st && st.closest ? st.closest('[data-md-id]') : null;
  }
  function marginGlyph(t) {
    var gl = glyphOf(t);
    var sg = typeOf(t).sourceGlyph;
    return { dx: sg.dx, dy: sg.dy, w: gl.w, h: gl.h };
  }
  // A define's glyph or sourceGlyph: a copy of its keys `ks`, finite px (w
  // and h above 0); null when absent (a DOM node a window name reaches is
  // none); false when it is not one.
  function glyphArg(g, ks) {
    if (g == null || typeof g.nodeType === 'number') return null;
    var out = {};
    for (var i = 0; i < ks.length; i++) {
      if (typeof g[ks[i]] !== 'number' || !isFinite(g[ks[i]])) return false;
      out[ks[i]] = g[ks[i]];
    }
    return out.w <= 0 || out.h <= 0 ? false : out;
  }

  // The document resolver's answer for an anchor (null when it cannot ask).
  function locate(a, ix) {
    var A = M.anchor;
    if (!A || !a || typeof a !== 'object') return null;
    if (a.kind === 'source') {
      var b = itemOf(a.md);
      var s = SRC && b && b.kind === 'md' && hasOwn.call(SRC, a.md) ? SRC[a.md] : null;
      return s && A.resolveSource ? A.resolveSource(b.el, s.src, s.map, a) : null;
    }
    var it = itemOf(a.mount);
    var root = it && it.kind === 'pane' ? it.el.shadowRoot : null;
    if (!root) return null;
    if (a.kind === 'range') return A.resolveRange ? A.resolveRange(root, a) : null;
    if (!ix[a.mount]) ix[a.mount] = A.index(root);
    return A.resolve(root, a, null, ix[a.mount]);
  }
  // An item's draw: its rule and where it is drawn; null when its rule draws
  // nothing; false when it should draw and the document cannot place it.
  function entryOf(it, ix) {
    var a = it.anchor;
    var d = locate(a, ix) || {};
    var masked = it.state === 'masked';
    var rec = it.answer;
    var state = masked ? it.state : rec ? rec.state : d.state;
    var how = masked ? null : rec ? rec.how : d.how;
    if (how === undefined) how = null;
    var guess = d.guess || d.el || null;
    var r = ruleOf(state, how, !!guess);
    if (!r) return state == null ? false : null;
    if (r.draw === 'none') return null;
    var e = { rule: r, el: null, range: null, own: false, pt: null, ans: d, state: state, how: how };
    if (r.draw === 'guess') { e.el = guess; e.own = true; } else if (d.range) e.range = d.range;
    else if (d.el) { e.el = d.el; e.own = true; e.pt = d.pt ? d : null; } else if (masked && guess) { e.el = guess; e.own = true; } else if (r.draw === 'section' || masked) {
      var b = itemOf(a && (a.kind === 'source' ? a.md : a.mount));
      e.el = b ? b.el : null;
    }
    return e.el || e.range ? e : false;
  }
  function rangeKey(r) {
    return 'r' + tok(r.startContainer) + ':' + r.startOffset + '-' + tok(r.endContainer) + ':' + r.endOffset;
  }

  // One full pass: resolve every item, group, rebuild on a changed signature.
  function build() {
    var p = data();
    if (!p || !p.items || !p.items.length) return;
    ensureLayer();
    var ix = {};
    var by = {};
    var list = [];
    base = zero();
    for (var i = 0; i < p.items.length; i++) {
      var it = p.items[i];
      try {
        var t = it.type;
        var row = rowOf(t);
        var parked = !!it.parked || !!(row && !has(row.reads, it.schema));
        var gen = parked || has(p.removed, t);
        if (!gen && row && !defs[t]) {
          if (!loaded) continue;
          gen = true;
        }
        if (!gen && !row && !BUILTIN[t]) gen = true;
        if (parked) base.parked++;
        var e = entryOf(it, ix);
        if (e === null) continue;
        if (!e) { base.unplaced++; continue; }
        var box = !gen && e.own && !!row && row.place === 'box' && it.anchor.kind === 'element' && typeof boxGroup === 'function';
        var key = t + '|' + e.rule.draw + '|' + (e.el ? 'e' + tok(e.el) : rangeKey(e.range)) + (box ? '|box' : '')
          + (gen ? '|gen' : '') + (e.pt ? '|' + e.pt.pt.x + ',' + e.pt.pt.y : '');
        var g = by[key];
        if (!g) {
          var md = !gen && e.range ? marginItemOf(t, e.range) : null;
          g = { key: key, type: t, kind: e.rule.draw, cls: e.rule.cls, el: e.el, range: e.range, pt: e.pt,
            mount: it.anchor && (it.anchor.mount || it.anchor.md), scope: 'preview', host: 'page', items: [],
            container: null, glyph: md ? marginGlyph(t) : gen ? K.glyph : glyphOf(t), mdItem: md, failed: false, gen: gen };
          if (box) boxGroup(g);
          by[key] = g;
          list.push(g);
        }
        g.items.push({ id: it.id, v: it.v, type: t, row: it, state: e.state, how: e.how, answer: e.ans, payload: it.payload });
      } catch (err) {
        warn('an item could not be read', err);
        base.unplaced++;
      }
    }
    list.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
    var s = list.map(function (g) {
      return g.key + ':' + g.items.map(function (x) { return x.id + '@' + x.v + ':' + x.state; }).join(',');
    }).join('|');
    if (s !== sig) {
      sig = s;
      groups = list;
      rebuild();
    } else {
      for (var k = 0; k < list.length; k++) {
        groups[k].el = list[k].el;
        groups[k].range = list[k].range;
        groups[k].pt = list[k].pt;
        groups[k].mdItem = list[k].mdItem;
        groups[k].items = list[k].items;
      }
    }
  }
  function ensureLayer() {
    if (layer && layer.isConnected) return;
    var st = doc.createElement('style');
    st.textContent = CSS.join('\n');
    (doc.head || doc.documentElement).appendChild(st);
    layer = doc.createElement('div');
    layer.className = 'wc-el-layer';
    doc.body.appendChild(layer);
  }
  function glyphSize(c, gl) {
    c.style.width = gl.w + 'px';
    c.style.height = gl.h + 'px';
    c.style.transform = 'translate(' + gl.dx + 'px, ' + gl.dy + 'px)';
  }
  function rebuild() {
    var old = layer.querySelectorAll('.el-marker');
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
    for (var j = 0; j < groups.length; j++) {
      var g = groups[j];
      var c = doc.createElement('div');
      c.className = 'el-marker' + (g.cls ? ' ' + g.cls : '');
      c.setAttribute('data-type', g.type);
      c.setAttribute('data-el-ids', g.items.map(function (x) { return x.id; }).join(' '));
      c.style.display = 'none';
      g.container = c;
      layer.appendChild(c);
      if (g.place === 'box') {
        c.setAttribute('data-place', 'box');
        c.style.pointerEvents = 'none';
        continue;
      }
      glyphSize(c, g.glyph);
      if (g.gen || !run(g)) standIn(g);
    }
  }
  // A type's draw into its group's container; false when it threw.
  function run(g) {
    var b = BUILTIN[g.type];
    var f = b ? b.draw : defs[g.type] && defs[g.type].draw;
    try {
      f(g, ctxOf(g));
      return true;
    } catch (e) {
      warn('the ' + g.type + ' draw failed', e);
      g.failed = true;
      return false;
    }
  }
  // THE GENERIC MARK: the live stand-in's look, its type named.
  function standIn(g) {
    var c = g.container;
    while (c.firstChild) c.removeChild(c.firstChild);
    c.className = 'el-marker' + (g.cls ? ' ' + g.cls : '') + ' el-generic el-standin';
    c.title = g.type;
    var s = doc.createElement('span');
    s.className = 'el-generic-name';
    s.textContent = g.type;
    c.appendChild(s);
    g.gen = true;
  }

  // ── placement ──
  function boxOf(r) { return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height }; }
  function meets(a, b) { return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom; }
  function shown(r) { return r && r.width > 0 && r.height > 0; }
  // The displayed frames among a root's iframes.
  function frameBoxes(root) {
    var out = [];
    var fs = root && root.querySelectorAll ? root.querySelectorAll('iframe, frame') : [];
    for (var i = 0; i < fs.length; i++) {
      var r = fs[i].getBoundingClientRect();
      if (shown(r)) out.push(boxOf(r));
    }
    return out;
  }
  // The clip of an anchor: its pane's host box (the client box when the
  // browser reports one), or the page around a markdown item; and the frames
  // a mark may not cover.
  function clipOf(start, fr) {
    var n = start.nodeType === 1 ? start : start.parentNode;
    var rt = n && n.getRootNode ? n.getRootNode() : null;
    var host = rt && rt.host ? rt.host : n && n.closest ? n.closest('.page') : null;
    var frames = fr.doc;
    if (rt && rt.host) frames = frames.concat(frameBoxes(rt));
    if (!host) return { clip: null, frames: frames };
    var r = host.getBoundingClientRect();
    var c = boxOf(r);
    if (host.clientWidth > 0 || host.clientHeight > 0) {
      var l = r.left + (host.clientLeft || 0);
      var t = r.top + (host.clientTop || 0);
      c = { left: l, top: t, right: l + host.clientWidth, bottom: t + host.clientHeight };
    }
    return { clip: c, frames: frames };
  }
  function measure(g, fr) {
    var x = g.range || g.el;
    var start = g.range ? g.range.startContainer : g.el;
    if (!g.container || !start || !start.isConnected) return { res: 'unplaced' };
    var r = rectOf(x);
    if (!r || (!r.width && !r.height && !r.left && !r.top)) return { res: 'unplaced' };
    var pt = g.pt && M.anchor && M.anchor.pointAt ? M.anchor.pointAt(g.pt, r) : null;
    if (g.pt && !pt) return { res: 'unplaced' };
    // The margin glyph: the anchor point is the item's left edge at the
    // range's first line.
    var ml = null;
    if (g.mdItem) {
      var ir = g.mdItem.isConnected ? rectOf(g.mdItem) : null;
      if (!ir) return { res: 'unplaced' };
      ml = ir.left;
    }
    var cl = clipOf(start, fr);
    return { res: 'drawn', r: r, pt: pt, ml: ml, clip: cl.clip || { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 }, frames: cl.frames };
  }
  function inset(t, r, b, l) { return t || r || b || l ? 'inset(' + t + 'px ' + r + 'px ' + b + 'px ' + l + 'px)' : ''; }
  function hit(p, frames) {
    for (var i = 0; i < frames.length; i++) if (meets(p, frames[i])) return true;
    return false;
  }
  function apply(g, m, sx, sy) {
    var c = g.container;
    if (m.res !== 'drawn') { if (c) c.style.display = 'none'; return; }
    var r = m.r;
    var cl = m.clip;
    if (g.place === 'box' && (!placeBox(g, m, sx, sy) || g.place === 'box')) return;
    var x = m.pt ? m.pt.x : m.ml != null ? m.ml : r.left;
    var y = m.pt ? m.pt.y : r.top;
    var gl = g.glyph;
    var gx = x + gl.dx;
    var gy = y + gl.dy;
    var inside = x >= cl.left && x < cl.right && y >= cl.top && y < cl.bottom;
    // A margin glyph the page gives no gutter for is INSET: its box clamped
    // inside the page's, its anchor point moved with it.
    if (m.ml != null && inside) {
      gx = Math.max(cl.left, Math.min(gx, cl.right - gl.w));
      gy = Math.max(cl.top, Math.min(gy, cl.bottom - gl.h));
      x = gx - gl.dx;
      y = gy - gl.dy;
    }
    var T = Math.max(0, cl.top - gy);
    var L = Math.max(0, cl.left - gx);
    var R = Math.max(0, gx + gl.w - cl.right);
    var B = Math.max(0, gy + gl.h - cl.bottom);
    var painted = { left: gx + L, top: gy + T, right: gx + gl.w - R, bottom: gy + gl.h - B };
    if (!inside || T + B >= gl.h || L + R >= gl.w || hit(painted, m.frames)) {
      c.style.display = 'none';
      m.res = 'clipped';
      return;
    }
    c.style.left = (x + sx) + 'px';
    c.style.top = (y + sy) + 'px';
    c.style.clipPath = inset(T, R, B, L);
    c.style.display = '';
    var b = BUILTIN[g.type];
    if (!g.gen && b && b.move) {
      try { b.move(g, { x: x, y: y, clip: cl }); } catch (e) { warn('the ' + g.type + ' move failed', e); }
    }
  }
  function place() {
    if (!layer) return;
    var fr = { doc: frameBoxes(doc) };
    var ms = [];
    var i;
    for (i = 0; i < groups.length; i++) ms.push(measure(groups[i], fr));
    var sx = window.pageXOffset || 0;
    var sy = window.pageYOffset || 0;
    counts = zero();
    counts.parked = base.parked;
    counts.unplaced = base.unplaced;
    for (i = 0; i < groups.length; i++) {
      var g = groups[i];
      try { apply(g, ms[i], sx, sy); } catch (e) {
        warn('a mark could not be placed', e);
        ms[i].res = 'unplaced';
      }
      var n = g.items.length;
      var res = ms[i].res;
      if (res === 'drawn') counts[g.gen ? 'generic' : 'drawn'] += n;
      else counts[res === 'clipped' ? 'clipped' : 'unplaced'] += n;
    }
  }
  function pass() {
    queued = false;
    try {
      build();
      place();
    } catch (e) { warn('a draw pass failed', e); }
  }
  function schedule() {
    if (queued) return;
    queued = true;
    setTimeout(pass, 0);
  }
  function replace() {
    try { place(); } catch (e) { warn('a re-place failed', e); }
  }

  // ── comment ──
  // The comment's pin (comments.js's glyph): answered when any reply is
  // Claude's; a native title tooltip of each text and its reply count.
  var PIN = '<svg viewBox="0 0 16 16" width="26" height="26" aria-hidden="true">'
    + '<path d="M8 1.4c-2.5 0-4.4 2-4.4 4.4 0 3.2 4.4 8.8 4.4 8.8s4.4-5.6 4.4-8.8C12.4 3.4 10.5 1.4 8 1.4z" fill="currentColor"/>'
    + '<circle cx="8" cy="5.8" r="1.55" style="fill:var(--wc-panel-bg,#fff)"/></svg>';
  CSS.push('.wc-el-layer .el-marker.replied{color:var(--wc-green,#2da44e)}', '.wc-el-layer .el-marker svg{display:block}',
    '.wc-el-layer .pin-count{position:absolute;right:0;bottom:0;min-width:15px;height:15px;padding:0 3px;border-radius:8px;background:var(--wc-bg,#fff);color:var(--wc-fg,#111);border:1.5px solid currentColor;font:700 9px var(--wc-mono,monospace);display:flex;align-items:center;justify-content:center}');
  BUILTIN.comment = { draw: function (g) {
    var c = g.container;
    var lines = [];
    var answered = false;
    for (var i = 0; i < g.items.length; i++) {
      var p = g.items[i].payload || {};
      var rs = p.replies || [];
      for (var j = 0; j < rs.length; j++) if (rs[j] && rs[j].claude === true) answered = true;
      if (typeof p.text === 'string') lines.push(p.text + ' (' + rs.length + (rs.length === 1 ? ' reply)' : ' replies)'));
    }
    if (answered) c.className += ' replied';
    c.innerHTML = PIN;
    if (g.items.length > 1) {
      var n = doc.createElement('span');
      n.className = 'pin-count';
      n.textContent = String(g.items.length);
      c.appendChild(n);
    }
    if (lines.length) c.title = lines.join('  •  ');
    c.style.pointerEvents = 'auto';
  } };
  // In a markdown item, the margin glyph (comments.js SOURCE_GLYPH).
  BUILTIN.comment.sourceGlyph = K.source;

  // ── highlight ──
  // The highlight's handle at the range's first line, and tinted rectangles
  // over the range, cut to the clip (highlight.js's geometry fallback).
  CSS.push('.wc-el-layer .hl-handle{--hl-c:var(--wc-gold,#d4a72c);border-radius:50%;background:var(--hl-c)}',
    '.wc-el-layer .hl-handle[data-color=accent]{--hl-c:var(--wc-accent,#0969da)}',
    '.wc-el-layer .hl-handle[data-color=green]{--hl-c:var(--wc-green,#2da44e)}',
    '.wc-el-layer .hl-handle[data-color=rust]{--hl-c:var(--wc-rust,#b4532a)}',
    '.wc-el-layer .hl-rect{position:absolute;border-radius:2px;background:color-mix(in srgb,var(--hl-c) 38%,transparent)}');
  BUILTIN.highlight = { glyph: K.handle, draw: function (g) {
    var c = g.container;
    var p = g.items[0].payload || {};
    c.className += ' hl-handle';
    c.setAttribute('data-color', has(['accent', 'green', 'rust'], p.color) ? p.color : 'gold');
    if (typeof p.note === 'string' && p.note) c.title = p.note;
  }, move: function (g, m) {
    var c = g.container;
    var old = c.querySelectorAll('.hl-rect');
    for (var i = 0; i < old.length; i++) c.removeChild(old[i]);
    if (!g.range) return;
    var ox = m.x + g.glyph.dx;
    var oy = m.y + g.glyph.dy;
    var cl = m.clip;
    var rs = rectsOf(g.range);
    for (var k = 0; k < rs.length; k++) {
      var r = rs[k];
      var l = Math.max(r.left, cl.left);
      var t = Math.max(r.top, cl.top);
      var rt = Math.min(r.left + r.width, cl.right);
      var b = Math.min(r.top + r.height, cl.bottom);
      if (!(rt > l && b > t)) continue;
      var d = doc.createElement('div');
      d.className = 'hl-rect';
      d.style.left = (l - ox) + 'px';
      d.style.top = (t - oy) + 'px';
      d.style.width = (rt - l) + 'px';
      d.style.height = (b - t) + 'px';
      c.insertBefore(d, c.firstChild);
    }
    var L = Math.max(cl.left - ox, -1e5);
    var T = Math.max(cl.top - oy, -1e5);
    var R = Math.min(cl.right - ox, 1e5);
    var B = Math.min(cl.bottom - oy, 1e5);
    c.style.clipPath = 'polygon(' + L + 'px ' + T + 'px, ' + R + 'px ' + T + 'px, ' + R + 'px ' + B + 'px, ' + L + 'px ' + B + 'px)';
  } };

  // ── box ──
  // The box placer's own section: present in a cut whose payload places a
  // type as a box (keyOf), so a glyph-only document carries none of it.
  CSS.push('.wc-el-layer .el-marker[data-place=box]{pointer-events:none;overflow:visible}');
  function boxGroup(g) {
    g.place = 'box';
    g.drawn = false;
    g.boxW = 0;
    g.boxH = 0;
    g.box = Object.freeze(Object.defineProperties({}, {
      w: { get: function () { return g.boxW; }, enumerable: true },
      h: { get: function () { return g.boxH; }, enumerable: true }
    }));
  }
  // A box group: the target's rect ∩ its clip, never over a frame; its draw
  // runs at its first drawn placement. False when it is not drawn; a draw
  // that throws turns the group into the generic mark, placed as a glyph.
  function placeBox(g, m, sx, sy) {
    var c = g.container;
    var r = m.r;
    var t = boxOf(r);
    var cl = m.clip;
    var p = { left: Math.max(t.left, cl.left), top: Math.max(t.top, cl.top), right: Math.min(t.right, cl.right), bottom: Math.min(t.bottom, cl.bottom) };
    if (!(p.right > p.left && p.bottom > p.top) || hit(p, m.frames)) {
      c.style.display = 'none';
      m.res = 'clipped';
      return false;
    }
    c.style.left = (r.left + sx) + 'px';
    c.style.top = (r.top + sy) + 'px';
    c.style.width = r.width + 'px';
    c.style.height = r.height + 'px';
    g.boxW = r.width;
    g.boxH = r.height;
    c.style.clipPath = inset(p.top - t.top, t.right - p.right, t.bottom - p.bottom, p.left - t.left);
    if (!g.drawn) {
      if (!run(g)) {
        g.place = null;
        c.removeAttribute('data-place');
        c.style.pointerEvents = '';
        c.style.clipPath = '';
        glyphSize(c, g.glyph);
        standIn(g);
        return true;
      }
      g.drawn = true;
    }
    c.style.display = '';
    return true;
  }

  // ── tail ──
  M.elements = {
    define: function (type, draw, assets, ex) {
      if (typeof type !== 'string' || typeof draw !== 'function') return;
      var gl = glyphArg(ex && ex.glyph, ['dx', 'dy', 'w', 'h']);
      var sg = glyphArg(ex && ex.sourceGlyph, ['dx', 'dy']);
      if (gl === false || sg === false) {
        warn('the ' + type + ' glyph or sourceGlyph export is not one', ex);
        draw = function () { throw new Error('the type\'s glyph or sourceGlyph export is not one'); };
        gl = null;
        sg = null;
      }
      defs[type] = { draw: draw, assets: assets && typeof assets === 'object' ? assets : {}, glyph: gl, sourceGlyph: sg };
      schedule();
    },
    draw: function (p) {
      P = p && typeof p === 'object' ? p : null;
      if (P && P.sources) SRC = P.sources;
      sig = null;
      pass();
    },
    sources: function (t) {
      SRC = t && typeof t === 'object' ? t : null;
      schedule();
    },
    stats: function () {
      return { drawn: counts.drawn, generic: counts.generic, parked: counts.parked, unplaced: counts.unplaced, clipped: counts.clipped };
    }
  };
  if (typeof M.onSettle === 'function') M.onSettle(function () { schedule(); });
  window.addEventListener('load', function () {
    loaded = true;
    schedule();
  });
  window.addEventListener('resize', replace);
  doc.addEventListener('scroll', replace, true);
  if (loaded) schedule();
}

// The factory's sections, in file order, under their banners; head and tail
// are in every cut.
const SECTIONS = Object.freeze(['comment', 'highlight', 'box']);
const SECTION_BANNER = (name) => `  // ── ${name} ──\n`;

// The factory's text cut to `sections` (a subset of SECTIONS). Called only by
// runtimeSource, through this module's exports (so a test can count calls).
function runtimeText(sections) {
  const src = elementsRuntime.toString();
  const at = [...SECTIONS, 'tail'].map((n) => {
    const banner = SECTION_BANNER(n);
    const i = src.indexOf(banner);
    if (i < 0 || src.indexOf(banner, i + 1) >= 0) throw new Error(`elements-doc-src: the ${n} banner is not there once`);
    return i;
  });
  let out = src.slice(0, at[0]);
  SECTIONS.forEach((n, k) => { if (sections.includes(n)) out += src.slice(at[k], at[k + 1]); });
  out += src.slice(at[at.length - 1]);
  const args = { rules: DRAW_RULES.map((r) => [r.state, r.how, r.guess, r.draw, r.cls]),
    glyph: MARKER_GLYPH, handle: HANDLE_GLYPH, source: SOURCE_GLYPH };
  return `(${out})(${JSON.stringify(args)});\n`;
}

// ── the cut key ─────────────────────────────────────────────────────────────
// keyOf(payload) → the runtime cut a payload needs: the built-ins its items
// use, then 'box' when a type places as a box, joined by '+' ('' for none:
// the core alone, for a payload of glyph plug-in types and removed ones).
function keyOf(payload) {
  const p = isObj(payload) ? payload : {};
  const builtins = Array.isArray(p.builtins) ? BUILTIN_TYPES.filter((t) => p.builtins.includes(t)) : [];
  const box = Array.isArray(p.types) && p.types.some((r) => isObj(r) && r.place === 'box');
  return [...builtins, ...(box ? ['box'] : [])].join('+');
}
function sectionsOf(key) {
  const parts = key === '' ? [] : String(key).split('+');
  for (const s of parts) if (!SECTIONS.includes(s)) throw new TypeError(`elements-doc-src: no runtime section ${s}`);
  return parts;
}

// runtimeSource(key) → the runtime cut to the key, compacted by anchors-src's
// compact (the one rule; the factory's authoring rules make it safe);
// memoised per key, computed on first use.
const cached = new Map();
function runtimeSource(key = 'comment+highlight+box') {
  const sections = sectionsOf(key);
  const k = SECTIONS.filter((s) => sections.includes(s)).join('+');
  if (!cached.has(k)) cached.set(k, compact(module.exports.runtimeText(sections)));
  return cached.get(k);
}

// ── the splice ──────────────────────────────────────────────────────────────
// export.js's escaper, required lazily: export.js requires this module (U524),
// so a top-level require back would be a load-time cycle.
const jsonForScript = (v) => require('../export').jsonForScript(v);

// The runtime as a document splices it: its own script element.
function runtimeElement(key) {
  return `<script>${runtimeSource(key)}</script>\n`;
}

// The define line's fourth argument: the module's glyph and sourceGlyph named
// exports, each null when the module declares no such binding (a `typeof` of
// an undeclared name never throws).
const DEFINE_EXPORTS = '{glyph: typeof glyph === \'undefined\' ? null : glyph, '
  + 'sourceGlyph: typeof sourceGlyph === \'undefined\' ? null : sourceGlyph}';

// One plug-in type as a document splices it: an inline module of draw.js's
// bytes exactly as installed, a newline, and the one engine line naming its
// default export and its glyph exports. Refused (a TypeError) for a module that could end the
// element early or whose default export is not `function draw(`.
function typeElement(row) {
  if (!isObj(row) || !isStr(row.type) || !isStr(row.module)) throw new TypeError('elements-doc-src: typeElement needs {type, module}');
  if (UNSAFE_SPLICE.test(row.module)) throw new TypeError(`elements-doc-src: ${row.type}'s module holds a script end tag or a comment opener (unsafe-splice)`);
  if (!row.module.includes(MODULE_HEAD)) throw new TypeError(`elements-doc-src: ${row.type}'s module has no ${MODULE_HEAD}`);
  const assets = isObj(row.assets) ? row.assets : {};
  return `<script type="module">${row.module}\nwindow.__wcMount.elements.define(${jsonForScript(row.type)}, draw, ${jsonForScript(assets)}, ${DEFINE_EXPORTS});</script>\n`;
}

// The payload as a document carries it: the data element the runtime reads,
// each type row less its module and assets (they ride typeElement, once).
function dataElement(payload) {
  const p = { ...payload };
  if (Array.isArray(p.types)) p.types = p.types.map((r) => { const { module: _m, assets: _a, ...rest } = r || {}; return rest; });
  return `<script type="application/json" data-wc-elements>${jsonForScript(p)}</script>\n`;
}

// THE splice: '' when there is nothing to draw, else the runtime, each
// type's module (types order; a row with no module is not spliced, so its
// items draw the generic mark) and the data, in that order.
function scripts(payload) {
  if (!isObj(payload) || !Array.isArray(payload.items) || !payload.items.length) return '';
  const types = Array.isArray(payload.types) ? payload.types : [];
  return runtimeElement(keyOf(payload)) + types.filter((r) => isObj(r) && r.module !== '').map(typeElement).join('')
    + dataElement(payload);
}

module.exports = {
  // the contract
  CONTRACT_VERSION, BUILTIN_TYPES, PAYLOAD_KEYS, TYPE_KEYS, ITEM_KEYS, ANSWER_KEYS, SKIPPED_KEYS, STRIPPED_KEYS,
  STRIPPED_KINDS, SOURCE_KEYS, BUILTIN_FIELDS, REPLY_KEYS, FORBIDDEN, MODULE_HEAD, validatePayload,
  // the runtime
  DRAW_RULES, MARKER_GLYPH, HANDLE_GLYPH, SOURCE_GLYPH, SECTIONS, runtimeText, runtimeSource, keyOf,
  // the splice
  scripts, runtimeElement, typeElement, dataElement,
};
