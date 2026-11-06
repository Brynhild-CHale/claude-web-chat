// The element types in the chrome, and the reads gate (annotation engine
// tranche 2, PLAN.md 2C.3; readiness R7 §3 row 10; F10 C-5; GT-17).
//
// THE LISTING. The daemon's registry (lib/server/element-types, ctx.
// elementTypes) lists a type only from an approved, intact, ledgered record;
// GET /api/elements/types serves its rows. This module reads them through the
// one HTTP reader (http.js) on every hello and on every `components` frame
// (an install, approve or removal sends one: routes/packs.js changed()), by
// onHello / onFrame — never a branch of ws.js's switch.
//
// THE GATE. A type's draw code is handed to the overlay (overlay.js
// registerType) through registerElementType ONLY — the built-in types
// (comment, highlight, box grab) included, never registerType directly. The
// draw the overlay sees is a wrapper:
//
//   - a record whose schema its type does not read (element.json's `reads`,
//     as listed) is PARKED: the type's draw is never called for it (C-5:
//     readability is decided from element.json alone, before any draw runs);
//   - a draw that throws is caught: its elements are DRAW-FAILED, and nothing
//     is thrown out of the overlay (the liar control: an element.json that
//     claims a schema its draw cannot read);
//   - a record of a type the registry does not list (a removed pack, GT-17)
//     is UNKNOWN-TYPE.
//
// Each such element keeps its state ('parked', 'draw-failed' or
// 'unknown-type'), listed by drawStates() and announced on the chrome bus as
// 'overlay:draw-state' {id, v, type, state, prev, schema, error} — state null
// when it draws again. A group none of whose elements drew gets ONE generic
// stand-in mark in the overlay's own marker (the overlay's generic look,
// classes `el-generic el-standin`): a named stand-in, not a design — its look
// is not this module's. A record of a type nobody registered gets the
// overlay's own generic mark; this module only records its state.
//
// Before the first listing arrives nothing of a registered type is drawn (no
// state either): the gate cannot be decided. A built-in type the listing
// lacks (its boot install failed; the daemon still boots, U323) is named in
// the answer's `reserved` and keeps drawing, caught as any draw is.
//
// A record names its schema as `schema` ('<type>@<n>') on its row. A row
// that names none is read as its type's own current schema (every built-in's
// rows today: the lean projection carries no schema yet — see U324's
// hand-off).
//
// THE LOADER (tranche 4, U512; plan 4A.2; B1 review-approve; DRAW@loader).
// loadPluginTypes() runs after every listing (setListing): for each listed row
// that is not built-in, not of the chat family, and carries the daemon's
// `draw: {sha256}` (U511), it imports that type's draw.js by a dynamic
// import() of the same-origin fenced route
// /api/elements/types/<type>/draw.js?d=<sha256> — never eval, never a
// <script> element, never a blob: or data: URL — once per (type, digest),
// single-flight. Only a listed type's URL is ever built (the listing's own
// type name, URL-encoded). The module contract (U512-U522@draw-module-
// contract a): the default export is the function draw — `export default
// function draw(group, ctx)` — and create, move, glyph, sourceGlyph and
// targets are optional NAMED exports; anything else it exports is ignored.
// The manifest wins over the module: `input`, `place` and `composite` (U624)
// come from the listing row's toolbar fields (what review saw), never from
// the module. The
// spec goes through registerElementType only, so the reads gate, the liar
// control and draw-failed hold for a plug-in type unchanged. A rejected
// import, a module whose evaluation throws, or one with no default draw
// registers a stand-in whose draw throws "the type's draw.js did not load:
// <why>": each of its elements reads draw-failed with the stand-in mark (no
// new draw state); a failed digest is not imported again until the listing
// names another digest or the page reloads. A slow draw is not caught. The
// records a draw reads are the live ones, previewed node or not (the GET
// names no node). A type that leaves the listing is unregistered; its module
// stays in the realm's module map until the page reloads (an ES module cannot
// be unloaded).
//
// THE REALM (B1; K.5 K2 a, J2 a; GT-17: the plan names the draw.js trust
// model), in one sentence:
//
// an approved type's draw() runs in the surface page's own realm live, and in each document's own realm under PREVIEW_CSP (B1); a pack cannot add a layer or a placement mode
//
// K2's documented consequence: a type running in the chrome's realm has the
// chrome's reach, private records included; pack review and approve are the
// boundary. A plug-in type's draw ctx (and its move's) carries two accessors,
// so no pack builds a route URL itself:
//
//   record(id)  the type's record as GET /api/elements?type=<type> answered
//               it for this viewer (masked by the daemon; a private record
//               only for a viewer who sees private), kept current by the
//               type's `element:<type>` frame; null for an id it does not
//               hold. A change in the records re-registers the type, so the
//               overlay redraws. Frozen: a draw cannot edit what it reads.
//   asset(rel)  rel is the path below the type's assets/ directory
//               ('mark.png', 'fonts/hand.woff2'), checked as 'assets/' + rel
//               by lib/core/element-assets mediaOf, the one grammar: live, the
//               same-origin URL /api/elements/types/<type>/assets/<rel> with
//               the listing's draw sha256 as its ?d= cache key (U511's
//               route); in a document, the inlined data: URI (U522). null for
//               a rel mediaOf refuses, one with a leading slash or a '..'
//               segment, or one that starts 'assets/'. The chrome imports
//               mediaOf from /app/element-assets.js (the daemon serves
//               lib/core/element-assets' own source); initElementTypes'
//               `mediaOf` seam replaces it, and with null asset() answers
//               null (fails closed).
//
// THE DETACHABLE GLYPH (U587, H.7; DECISIONS L.1 M4 a, K.2-151). A type
// whose listing row's toolbar carries element.json's `glyph: {detach: true,
// leader?}` — the built-in comment's first — is registered on the overlay
// with `detach: {leader}` (registerElementType's own `detach` option, when
// given, wins): the overlay owns the drag, the stored offset and the leader
// line (overlay.js), so no type ships either. The leader is read per draw:
// the tool's small setting `leader` (toolbar-state settingsOf) when it names
// one of overlay.js GLYPH_LEADERS, else the manifest's, else the first; a
// toolbar change asks the overlay for one draw while a detached type is
// registered. Nothing else here knows the glyph.
//
// TARGETS (K.2-78). A registration may name what its tool's presses land on:
// `targets: 'items'` (the default) — a pane's content and a markdown item —
// or `targets: 'panes'` — a pane's content only, so a press outside every
// pane (a markdown link, the chrome inside #main) passes through to the page
// with the tool still armed, as 0.8.5's pin mode did. It is stored on the
// type (targetsOf) and handed to the overlay, whose pointer dispatch reads it
// after the input-mode policy's decision. Every built-in keeps the default
// (the comment since F.3: a taps tool with 'items' takes a pane's content and
// a markdown block, and the overlay leaves the chrome inside #main to the
// page); 'panes' stays for a pack's type.
//
// THE TRAY ACTION GUARD (TRAY@guard; PLAN-T3 §2.4 note 8; DECISIONS.md L.5).
// Every element tray's write action — a pin's reply, share and delete, the
// highlight popover's Save and Delete, the box grab's Discard and its create
// gesture, Send to Claude, and a plug-in type's tray (tranche 4) — runs
// through trayAction: while a committed node is previewed (mounts.js
// contentReadOnly(), D2) it refuses with READONLY_HINT (topbar.js) and sends
// nothing — one rule, one hint. trayReadOnly() is the same rule for drawing a
// tray's read-only branch. No tray checks the preview itself
// (test/conventions.test.js holds `contentReadOnly(` to its homes).
//
// SEND TO CLAUDE (F.5; RULED REQ@highlight-send-to-claude M2 (a), J2 (a)).
// sendToClaude(id) is the one request for every registered type: POST
// /api/elements/:id/send with the device claim. One tap shares a private
// element and queues it, or queues a shared one that is not queued (an item
// already queued answers `already`); Push still decides when. A tray draws
// its Send to Claude button only when maySend() (canWrite, and no preview).
//
// THE PLUG-IN TRAY HOST (tranche 4, U514; plan 4A.2; TRAY@guard; PRIVATE@
// create a; M2 a). A pack's type writes only through `ctx.tray` — on its
// draw ctx (and its move's: pluginCtx, beside record and asset) bound to its
// own type, and on EVERY type's create ctx through the overlay's
// registerCreateCtx('tray', …) seam (U516; the type there is the armed one,
// as ctx.stroke's) — so no pack builds a route URL or a write of its own:
//
//   add({anchor, payload})       POST /api/elements {type, anchor, payload}
//   edit(id, patch, {base_v}?)   PATCH /api/elements/:id {payload: patch, base_v}
//   remove(id)                   DELETE /api/elements/:id (an eraser's delete)
//   share(id, shared)            PATCH /api/elements/:id {shared}
//   send(id)                     sendToClaude(id) — Send to Claude (M2)
//
// Each is ONE request through http.js with the device claim, run through
// trayAction (a preview answers TRAY_REFUSAL with READONLY_HINT and sends
// nothing: one rule, one hint), and answers a promise of {ok, element?,
// hint?} (a refusal also its `status`). add sends the payload exactly as the
// type made it: the engine never adds or defaults `shared` (PRIVATE@create —
// the type's create sends shared: false; the route's own default is the
// daemon's, not this module's). The built-in trays keep their own code, on
// trayAction already; none of them goes through ctx.tray.
//
// THE PLUG-IN SETTINGS (U512c; the U566 builder's contract). A pack's type
// reads its own element.json settings through `ctx.settings()` — on its draw
// and move ctx (pluginCtx: settingsFor(type)) and on every create ctx (the
// overlay's own key, overlay.js CREATE_CTX_KEYS) — never by importing a
// chrome module. It answers a frozen {small: {...}, large: {...}}: each
// level's declared fields (the toolbar's tools[] settings[level].properties),
// each the value toolbar-state.js settingsOf resolves (the user's ⊕ the
// project's ⊕ the armed profile's) when one is saved, else the schema's
// default; a field with neither is absent (toolbar-state settingsSnapshot).
// On the create ctx: the armed type and profile's values at the gesture's
// start. On the draw ctx: the armed profile's values while this type is
// armed, else element.json's defaults alone (defaultSettings) — the answer a
// document's ctx.settings() gives too (lib/server/runtime/elements-doc-src).
// Nothing writes settings through the seam: the small menu and the large pane
// (tool-settings.js) are the writers.
import * as overlayModule from './overlay.js';
import { request } from './http.js';
import { bus } from './bus.js';
import { onFrame, onHello } from './ws.js';
import { contentReadOnly } from './mounts.js';
import { isPhone } from './viewport.js';
import { READONLY_HINT, showReaimNote } from './topbar.js';
import { toolbarState, settingsOf, onToolbarChange, settingsSnapshot, defaultSettings } from './toolbar-state.js';
import { mediaOf as assetMediaOf } from './element-assets.js';

export const TYPES_PATH = '/api/elements/types';
export const DRAW_STATES = Object.freeze(['parked', 'draw-failed', 'unknown-type']);
const [PARKED, DRAW_FAILED, UNKNOWN_TYPE] = DRAW_STATES;
export const STANDIN_CLASS = 'el-standin';
export const TARGETS = Object.freeze(['items', 'panes']);

let ov = overlayModule;
let inited = false;
let loaded = false;
let listing = new Map();          // type → its row
let reserved = new Set();         // the built-in names (the answer's `reserved`)
let loadSeq = 0;
const registrations = new Map();  // type → {spec, unregister}
const states = new Map();         // id → {id, v, type, state, schema, error}
const seen = new Map();           // id → {v, type}: what the overlay delivered
const groupsOk = new WeakMap();   // a drawn group → the ids its draw drew
// The plug-in loader's state (U512, below): type → {sha, token, promise, off,
// frameOff, records, recSeq, recSig}; the spec key that marks a loaded type.
const plugins = new Map();
const PLUGIN = Symbol('element-types.plugin');
// The one dynamic import of a daemon URL (test/conventions.test.js holds it
// here, B1): the URL is drawPath's, built from a listed row alone.
const defaultImport = (url) => import(url);
let importModule = defaultImport;
let mediaOfFn = assetMediaOf;     // lib/core/element-assets mediaOf, served (/app/element-assets.js)

// ── the listing ─────────────────────────────────────────────────────────────
// initElementTypes({overlay, importModule, mediaOf}) — idempotent. `overlay`
// is injectable (a test's stub): handing another one moves every
// registration and the answers listener onto it. `importModule(url)` is the
// loader's importer (default: the dynamic import of the URL; jsdom runs no
// module fetched from a URL, so a test hands its own); `mediaOf(rel)` is
// lib/core/element-assets' grammar, which asset(rel) asks (none: null).
let answersOff = null;
let createTrayOff = null;         // the create ctx's tray registration (U514)
export function initElementTypes(opts = {}) {
  if (opts && Object.hasOwn(opts, 'importModule')) {
    importModule = typeof opts.importModule === 'function' ? opts.importModule : defaultImport;
  }
  if (opts && Object.hasOwn(opts, 'mediaOf')) mediaOfFn = typeof opts.mediaOf === 'function' ? opts.mediaOf : null;
  if (opts && opts.overlay && opts.overlay !== ov) {
    ov = opts.overlay;
    if (answersOff) { try { answersOff(); } catch {} answersOff = null; }
    if (createTrayOff) { try { createTrayOff(); } catch {} createTrayOff = null; }
    for (const type of [...registrations.keys()]) reregister(type);
  }
  if (!answersOff && typeof ov.onAnswers === 'function') answersOff = ov.onAnswers(onAnswers) || (() => {});
  if (!createTrayOff) registerCreateTray(ov);
  if (inited) return;
  inited = true;
  // A detached type's leader follows its tool's setting at once (U587).
  onToolbarChange(() => { if (detachedTypes.size && typeof ov.requestDraw === 'function') ov.requestDraw(); });
  onHello(() => { loadTypes(); });
  onFrame('components', () => { loadTypes(); });
  // A reset (a wipe, a new graph) re-reads every plug-in type's records, as
  // the highlight type re-reads its own.
  onFrame('reset', () => { for (const type of plugins.keys()) loadRecords(type); });
  loadTypes();
}

// Read the listing. Never throws; a refused read keeps the listing held.
// Returns {ok, types} — the types as listed now.
export async function loadTypes() {
  const mine = ++loadSeq;
  const r = await request('GET', TYPES_PATH);
  if (mine !== loadSeq) return { ok: r.ok, stale: true, types: listedTypes() };
  if (!r.ok || !r.body || !Array.isArray(r.body.types)) {
    return { ok: false, refused: r.refused, hint: r.hint, types: listedTypes() };
  }
  setListing(r.body.types, r.body.reserved);
  return { ok: true, types: listedTypes() };
}

function setListing(types, names) {
  const next = new Map();
  for (const t of types) {
    if (!t || typeof t.type !== 'string' || !t.type) continue;
    const reads = Array.isArray(t.reads) ? t.reads.filter((s) => typeof s === 'string') : [];
    next.set(t.type, Object.freeze({ ...t, reads: Object.freeze(reads) }));
  }
  listing = next;
  reserved = new Set(Array.isArray(names) ? names.filter((n) => typeof n === 'string') : []);
  loaded = true;
  // The overlay redraws a group only when its signature changes; registering
  // a type again is its one way to rebuild every marker, so a listing change
  // is drawn at once.
  for (const type of [...registrations.keys()]) reregister(type);
  recheckUnregistered();
  loadPluginTypes().catch(() => {});
}

export function listedTypes() { return [...listing.values()]; }
export function typeOf(type) { return listing.get(type) || null; }
export function typesLoaded() { return loaded; }

// '<type>@<n>' or n → the schema's name, or null. A string is compared with
// the listed `reads` as it stands (the daemon validated each one as this
// type's): nothing here splits an id@v string (element-log parsePin is the
// one parser, and it is not served to the browser).
function schemaName(type, s) {
  if (Number.isSafeInteger(s) && s > 0) return `${type}@${s}`;
  return typeof s === 'string' && s ? s : null;
}

// Whether a version written under `schema` may be handed to the type's draw:
// from the listing alone. An unlisted type reads nothing.
export function readable(type, schema) {
  const row = listing.get(type);
  const s = schemaName(type, schema);
  return Boolean(row && s && row.reads.includes(s));
}

// ── the per-element state ──────────────────────────────────────────────────
function itemSchema(it, row) {
  const r = it && it.row;
  const s = (r && r.schema) || (it && it.schema) || (it && it.answer && it.answer.schema);
  return s == null ? (row ? row.schema : null) : s;
}
function setState(it, type, state, extra = {}) {
  const id = it && it.id != null ? String(it.id) : null;
  if (!id) return;
  const prev = states.get(id) || null;
  if (state == null) {
    if (!prev) return;
    states.delete(id);
    bus.emit('overlay:draw-state', { id, v: it.v == null ? null : it.v, type, state: null, prev: prev.state, schema: null, error: null });
    return;
  }
  const next = { id, v: it.v == null ? null : it.v, type, state, schema: extra.schema == null ? null : extra.schema,
    error: extra.error == null ? null : extra.error };
  if (prev && prev.state === next.state && prev.v === next.v && prev.schema === next.schema && prev.error === next.error) return;
  states.set(id, next);
  bus.emit('overlay:draw-state', { ...next, prev: prev ? prev.state : null });
}

// The elements that are not drawn by their type, and why — those still in
// the overlay's drawn set when it can say.
export function drawStates() {
  let present = null;
  try {
    if (typeof ov.elementsOf === 'function' && typeof ov.drawnScopeOf === 'function') {
      present = new Set(ov.elementsOf(ov.drawnScopeOf()).map((r) => String(r.id)));
    }
  } catch { present = null; }
  if (present) {
    for (const id of [...states.keys()]) if (!present.has(id)) states.delete(id);
    for (const id of [...seen.keys()]) if (!present.has(id)) seen.delete(id);
  }
  return [...states.values()].map((s) => ({ ...s })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// A record of a type nobody registered: the overlay draws its own generic
// mark; its state is recorded here once the listing is known.
function onAnswers(msg) {
  for (const it of (msg && msg.items) || []) {
    if (!it || it.id == null || typeof it.type !== 'string') continue;
    seen.set(String(it.id), { id: String(it.id), v: it.v, type: it.type });
    if (!registrations.has(it.type)) unregisteredState(seen.get(String(it.id)));
  }
}
function unregisteredState(it) {
  if (!loaded) return;
  if (listing.has(it.type) || reserved.has(it.type)) {
    const s = states.get(it.id);
    if (s && s.state === UNKNOWN_TYPE) setState(it, it.type, null);
    return;
  }
  setState(it, it.type, UNKNOWN_TYPE);
}
function recheckUnregistered() {
  for (const it of seen.values()) if (!registrations.has(it.type)) unregisteredState(it);
}

// ── the stand-in mark ──────────────────────────────────────────────────────
// The overlay's generic look (its `el-generic` marker), drawn into the
// group's own marker: the overlay positions and clips it as any marker.
function standIn(group, type) {
  const c = group && group.container;
  if (!c) return;
  while (c.firstChild) c.removeChild(c.firstChild);
  c.classList.add('el-generic', STANDIN_CLASS);
  c.title = type;
  const s = document.createElement('span');
  s.className = 'el-generic-name';
  s.textContent = type;
  c.appendChild(s);
}

// ── registration ───────────────────────────────────────────────────────────
// registerElementType(type, {draw, create?, input?, glyph?, sourceGlyph?, move?,
// targets?}) → unregister. The spec is the overlay's (registerType); its draw
// and move run behind the gate. `targets` is 'items' (the default) or 'panes'
// (TARGETS above); `sourceGlyph` {dx, dy} puts the glyph in a markdown item's
// margin (overlay.js). A later registration of the same type replaces the
// earlier one.
export function registerElementType(type, spec) {
  if (typeof type !== 'string' || !type) throw new TypeError('registerElementType: a type name is required');
  if (!spec || typeof spec.draw !== 'function') throw new TypeError('registerElementType: {draw(group, ctx)} is required');
  if (spec.targets != null && !TARGETS.includes(spec.targets)) {
    throw new TypeError(`registerElementType: targets must be one of ${TARGETS.join(', ')}`);
  }
  if (!inited) initElementTypes();
  const prev = registrations.get(type);
  if (prev) { try { prev.unregister(); } catch {} }
  const entry = { spec: { ...spec, targets: spec.targets || TARGETS[0] }, unregister: () => {} };
  registrations.set(type, entry);
  try {
    reregister(type);
  } catch (e) {
    registrations.delete(type);
    throw e;
  }
  return () => {
    if (registrations.get(type) !== entry) return;
    registrations.delete(type);
    try { entry.unregister(); } catch {}
  };
}

// The registered type's targets ('items' or 'panes'), or null when none is.
export function targetsOf(type) {
  const entry = registrations.get(type);
  return entry ? entry.spec.targets : null;
}

// The detachable glyph's carriage (U587): the overlay's `detach` option for
// a type, from its registration or its listing row's toolbar `glyph`, or null.
const detachedTypes = new Set();
function detachOf(type, spec) {
  if (spec && spec.detach != null) return spec.detach;
  const row = listing.get(type);
  const g = row && row.toolbar && typeof row.toolbar === 'object' ? row.toolbar.glyph : null;
  if (!g || typeof g !== 'object' || g.detach !== true) return null;
  const leaders = Array.isArray(overlayModule.GLYPH_LEADERS) ? overlayModule.GLYPH_LEADERS : [];
  const fallback = leaders.includes(g.leader) ? g.leader : leaders[0];
  return {
    leader: () => {
      let s = null;
      try { s = settingsOf(type); } catch { s = null; }
      return s && leaders.includes(s.leader) ? s.leader : fallback;
    },
  };
}

function reregister(type) {
  const entry = registrations.get(type);
  if (!entry) return;
  try { entry.unregister(); } catch {}
  const { spec } = entry;
  const detach = detachOf(type, spec);
  if (detach) detachedTypes.add(type); else detachedTypes.delete(type);
  entry.unregister = ov.registerType(type, {
    ...spec,
    ...(detach ? { detach } : {}),
    draw: (group, ctx) => gatedDraw(type, spec, group, ctx),
    ...(typeof spec.move === 'function' ? { move: (group, ctx) => gatedMove(spec, group, ctx) } : {}),
  }) || (() => {});
}

function gatedDraw(type, spec, group, ctx) {
  const items = (group && Array.isArray(group.items)) ? group.items : [];
  if (!loaded) return;
  const row = listing.get(type) || null;
  if (!row && !reserved.has(type)) {
    for (const it of items) setState(it, type, UNKNOWN_TYPE);
    standIn(group, type);
    return;
  }
  const drawable = [];
  for (const it of items) {
    if (!row) { drawable.push(it); continue; } // an unlisted built-in: drawn, caught
    const schema = itemSchema(it, row);
    if (readable(type, schema)) drawable.push(it);
    else setState(it, type, PARKED, { schema: schema == null ? null : String(schema) });
  }
  if (!drawable.length) { standIn(group, type); return; }
  const view = drawable.length === items.length ? group : { ...group, items: drawable };
  try {
    spec.draw(view, pluginCtx(spec, ctx));
  } catch (err) {
    console.error(`[web-chat] element type '${type}': its draw failed`, err);
    const error = String((err && err.message) || err);
    for (const it of drawable) setState(it, type, DRAW_FAILED, { schema: row ? String(itemSchema(it, row)) : null, error });
    standIn(group, type);
    return;
  }
  groupsOk.set(group, new Set(drawable.map((it) => String(it.id))));
  for (const it of drawable) setState(it, type, null);
}

function gatedMove(spec, group, ctx) {
  const ids = groupsOk.get(group);
  if (!ids) return;
  const items = (group.items || []).filter((it) => ids.has(String(it.id)));
  if (!items.length) return;
  try {
    spec.move(items.length === group.items.length ? group : { ...group, items }, pluginCtx(spec, ctx));
  } catch (err) {
    console.error(`[web-chat] element type '${group.type}': its move failed`, err);
  }
}

// ── the plug-in loader (U512; plan 4A.2; B1; DRAW@loader) ──────────────────
// The header's THE LOADER and THE REALM paragraphs say what this is and is
// not. A loaded type's spec carries PLUGIN (its type), so gatedDraw hands its
// draw (and its move) the plug-in ctx; nothing outside this module can set it.
export const ELEMENTS_PATH = '/api/elements';
export const DID_NOT_LOAD = 'the type\'s draw.js did not load';
export const MODULE_EXPORTS = Object.freeze(['create', 'move', 'glyph', 'sourceGlyph', 'targets']);
const ASSETS_PREFIX = 'assets/';

// The route's URL for a listed type's draw.js at a digest.
export function drawPath(type, sha) {
  return `${TYPES_PATH}/${encodeURIComponent(type)}/draw.js?d=${encodeURIComponent(sha)}`;
}

// Whether a listing row names a draw module this loader may import: a pack's
// type (never a built-in or a reserved name), not of the chat family, with
// the daemon's digest for its draw.js.
function loadableSha(row) {
  if (!row || row.builtin !== false || row.family === 'chat' || reserved.has(row.type)) return null;
  const sha = row.draw && typeof row.draw === 'object' ? row.draw.sha256 : null;
  return typeof sha === 'string' && sha ? sha : null;
}

// loadPluginTypes() → a promise of the types whose module is loaded (or
// failed) once every import it started has settled. Run after every listing;
// never throws, never imports anything the listing does not name.
export function loadPluginTypes() {
  const wanted = new Map();
  for (const row of listing.values()) {
    const sha = loadableSha(row);
    if (sha) wanted.set(row.type, sha);
  }
  for (const type of [...plugins.keys()]) if (!wanted.has(type)) dropPlugin(type);
  const waits = [];
  for (const [type, sha] of wanted) {
    let p = plugins.get(type);
    if (!p) {
      p = { sha: null, token: null, promise: null, off: null, frameOff: null, records: new Map(), recSeq: 0, recSig: '' };
      plugins.set(type, p);
      p.frameOff = onFrame(`element:${type}`, (msg) => onRecordsFrame(type, p, msg));
    }
    if (p.sha !== sha) startImport(type, p, sha);
    if (p.promise) waits.push(p.promise);
    waits.push(loadRecords(type));
  }
  return Promise.all(waits).then(() => [...plugins.keys()]);
}

function dropPlugin(type) {
  const p = plugins.get(type);
  if (!p) return;
  plugins.delete(type);
  p.token = null;
  if (p.frameOff) { try { p.frameOff(); } catch {} }
  if (p.off) { try { p.off(); } catch {} }
}

// Single-flight per (type, digest): a newer digest supersedes an import still
// on its way, whose answer is then dropped. The type keeps its earlier module
// (if any) until the new one settles.
function startImport(type, p, sha) {
  const token = {};
  p.sha = sha;
  p.token = token;
  const url = drawPath(type, sha);
  const done = (mod, err) => {
    if (plugins.get(type) !== p || p.token !== token) return;
    p.promise = null;
    let spec = null;
    let why = err ? String((err && err.message) || err) : null;
    if (!why) {
      const built = specOf(mod, listing.get(type));
      if (built.error) why = built.error; else spec = built.spec;
    }
    if (spec) {
      try {
        install(type, p, spec);
        return;
      } catch (e) {
        why = String((e && e.message) || e);
      }
    }
    console.error(`[web-chat] element type '${type}': ${DID_NOT_LOAD}: ${why}`);
    install(type, p, failedSpec(why));
  };
  p.promise = Promise.resolve()
    .then(() => importModule(url))
    .then((mod) => done(mod, null), (err) => done(null, err || new Error('the import was refused')));
}

// The registration spec from a module: mod.default (the function draw) plus
// the named exports MODULE_EXPORTS lists; `input`, `place` and `composite`
// from the listing row's toolbar fields (the manifest wins over the module).
function specOf(mod, row) {
  let draw;
  try { draw = mod ? mod.default : undefined; } catch (e) { return { error: String((e && e.message) || e) }; }
  if (typeof draw !== 'function') return { error: 'its default export is not the function draw' };
  const spec = { draw };
  for (const k of MODULE_EXPORTS) {
    let v;
    try { v = mod[k]; } catch (e) { return { error: String((e && e.message) || e) }; }
    if (v == null) continue;
    if ((k === 'create' || k === 'move') && typeof v !== 'function') return { error: `its export ${k} is not a function` };
    spec[k] = v;
  }
  const tb = row && row.toolbar && typeof row.toolbar === 'object' ? row.toolbar : {};
  if (overlayModule.INPUT_KINDS.includes(tb.input)) spec.input = tb.input;
  if (overlayModule.PLACE_MODES.includes(tb.place)) spec.place = tb.place;
  if (spec.place === 'box' && overlayModule.COMPOSITE_MODES.includes(tb.composite)) spec.composite = tb.composite;
  return { spec };
}

// What a type whose module did not load registers: a draw that throws, so
// the gate marks each element draw-failed with the stand-in; nothing creates.
function failedSpec(why) {
  const error = `${DID_NOT_LOAD}: ${why}`;
  return { draw() { throw new Error(error); } };
}

// registerElementType replaces the type's earlier registration (its
// unregister turns into a no-op), so only the newest is kept.
function install(type, p, spec) {
  p.off = registerElementType(type, { ...spec, [PLUGIN]: type });
}

// ── the record seam ────────────────────────────────────────────────────────
function loadRecords(type) {
  const p = plugins.get(type);
  if (!p) return Promise.resolve();
  const mine = ++p.recSeq;
  return request('GET', `${ELEMENTS_PATH}?type=${encodeURIComponent(type)}`).then((r) => {
    if (plugins.get(type) !== p || mine !== p.recSeq) return;
    if (!r || !r.ok || !r.body || !Array.isArray(r.body.elements)) return;
    setRecords(type, p, r.body.elements);
  }, () => {});
}
function onRecordsFrame(type, p, msg) {
  if (plugins.get(type) !== p) return;
  p.recSeq++;
  setRecords(type, p, msg && Array.isArray(msg.elements) ? msg.elements : []);
}
function deepFreeze(x) {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const k of Object.keys(x)) deepFreeze(x[k]);
  }
  return x;
}
function setRecords(type, p, list) {
  let sig;
  try { sig = JSON.stringify(list); } catch { sig = null; }
  if (sig != null && sig === p.recSig) return;
  p.recSig = sig == null ? '' : sig;
  const next = new Map();
  for (const rec of list) {
    if (!rec || typeof rec !== 'object' || rec.id == null) continue;
    if (rec.type != null && rec.type !== type) continue;
    next.set(String(rec.id), deepFreeze(structuredClone(rec)));
  }
  p.records = next;
  relayRows(type, [...next.values()]);
  const entry = registrations.get(type);
  if (entry && entry.spec[PLUGIN] === type) reregister(type);
}

// The overlay's live rows of a plug-in type follow its records (the GET and
// the element:<type> frame), as highlight.js's applyLive does for its own,
// through the overlay's own row path (removeElements / upsertElements, whose
// normRow keeps only what it draws by; no second row store): a row that left
// is removed, a new or changed one upserted, an unchanged one left alone (so
// a stroke's frame does not re-place every earlier stroke). Without it a
// stroke drawn live has a record but no row until the next hello or reset
// (U512b; the hello and the reset still fill the rows through takeLive).
function relayRows(type, recs) {
  if (typeof ov.elementsOf !== 'function' || typeof ov.upsertElements !== 'function' || typeof ov.removeElements !== 'function') return;
  const have = new Map(ov.elementsOf('live').filter((r) => r.type === type).map((r) => [r.id, r]));
  const ids = new Set(recs.map((r) => String(r.id)));
  const gone = [...have.keys()].filter((id) => !ids.has(id));
  const same = typeof ov.sameRow === 'function' ? ov.sameRow : () => false;
  const fresh = recs.map((r) => ({ ...r, type })).filter((r) => !same(have.get(String(r.id)), r));
  if (gone.length) ov.removeElements('live', gone);
  if (fresh.length) ov.upsertElements('live', fresh);
}
// record(id) for a plug-in type's draw: the record, or null. A page stroke's
// (U614, MAP@engine) is the overlay's pageRecordView of it: the flat record
// with points, width and aspect mapped into its group's current box (null
// while unplaced), so a draw stays frame-agnostic; every other record as it
// is. {raw: true}: the record as stored (the overlay's own read).
export function recordOf(type, id, opts) {
  const p = plugins.get(type);
  if (!p || id == null) return null;
  const rec = p.records.get(String(id)) || null;
  if (!rec || (opts && opts.raw) || typeof ov.pageRecordView !== 'function') return rec;
  return ov.pageRecordView(type, rec);
}

// asset(rel) for a plug-in type's draw: the same-origin URL, or null.
export function assetOf(type, rel) {
  if (typeof rel !== 'string' || !rel || rel.startsWith(ASSETS_PREFIX) || typeof mediaOfFn !== 'function') return null;
  const sha = loadableSha(listing.get(type));
  if (!sha) return null;
  let media;
  try { media = mediaOfFn(ASSETS_PREFIX + rel); } catch { return null; }
  if (!media || typeof media !== 'object' || media.refused || media.kind === 'draw') return null;
  const path = rel.split('/').map(encodeURIComponent).join('/');
  return `${TYPES_PATH}/${encodeURIComponent(type)}/assets/${path}?d=${encodeURIComponent(sha)}`;
}

// The ctx a plug-in type's draw and move see: the overlay's, plus record,
// asset, its tray (U514, bound to its type) and settings (U512c). A
// built-in's ctx is the overlay's, untouched.
function pluginCtx(spec, ctx) {
  const type = spec && spec[PLUGIN];
  if (!type) return ctx;
  return {
    ...(ctx || {}), record: (id) => recordOf(type, id), asset: (rel) => assetOf(type, rel), tray: trayOf(type),
    settings: () => settingsFor(type),
  };
}

// settings() for a plug-in type's draw and move (U512c; THE PLUG-IN SETTINGS
// in the header): read per call, so a toolbar change is read at the next one.
// Before GET /api/toolbar lands (or after it failed) the toolbar view has no
// tools[] row for the type: the listing row's toolbar.settings (element.json's
// declaration, defaults included) answers instead of {small: {}, large: {}}
// (U590, contract (r)).
function settingsFor(type) {
  let a = null;
  try { a = overlayModule.armed(); } catch { a = null; }
  const row = listing.get(type);
  const fallback = row && row.toolbar && typeof row.toolbar === 'object' ? row.toolbar.settings || null : null;
  return a && a.type === type ? settingsSnapshot(type, a.profile, fallback) : defaultSettings(type, fallback);
}

// ── the tray action guard (TRAY@guard) ─────────────────────────────────────
// trayReadOnly() — whether a tray draws its read-only branch now.
export function trayReadOnly() { return contentReadOnly(); }

// The guard's refusal: what trayAction answers in place of the action's own.
export const TRAY_REFUSAL = Object.freeze({ ok: false, refused: 'read-only', hint: READONLY_HINT });

function showNote(text) {
  try { showReaimNote(text); } catch { /* the note is a courtesy */ }
}

// trayAction(run, {note}) — run a tray's write action, or, while a preview is
// up, refuse it: `note` (the tray's own, else the topbar's) shows READONLY_HINT
// and TRAY_REFUSAL is answered; run is never called, so nothing is sent.
export function trayAction(run, { note } = {}) {
  if (contentReadOnly()) {
    (typeof note === 'function' ? note : showNote)(READONLY_HINT);
    return TRAY_REFUSAL;
  }
  return run();
}

// ── Send to Claude (F.5) ───────────────────────────────────────────────────
export const SEND_LABEL = 'Send to Claude';
export const SENT_NOTE = 'Queued for Claude — Push sends it';
export const ALREADY_NOTE = 'Already queued';
const SEND_FAILED = 'It was not sent to Claude: try again.';
const sendPath = (id) => `/api/elements/${encodeURIComponent(String(id))}/send`;

// Whether a tray draws its Send to Claude button: tools may write (full
// access, toolbarState().canWrite) and no preview is up.
export function maySend() {
  return toolbarState().canWrite === true && !contentReadOnly();
}

// sendToClaude(id) → {ok: true, already, element, item, note} |
// {ok: false, status?, hint}. One request, through the guard (a preview
// refuses it with READONLY_HINT as `hint` and sends nothing); the caller
// shows `note` or `hint` through its own note and applies `element`.
export async function sendToClaude(id, { note } = {}) {
  return trayAction(async () => {
    if (id == null || id === '') return { ok: false, hint: SEND_FAILED };
    // The viewer's viewport rides beside the device claim (U618,
    // PICTURE@viewer-viewport): a stroke's picture renders at it.
    const viewport = { w: Math.round(window.innerWidth || 0), h: Math.round(window.innerHeight || 0), mobile: isPhone() };
    const r = await request('POST', sendPath(id), { body: { viewport }, device: true });
    if (!r.ok) return { ok: false, status: r.status, hint: r.hint || SEND_FAILED };
    const b = r.body && typeof r.body === 'object' ? r.body : {};
    const already = b.already === true;
    return {
      ok: true, already, element: b.element || null, item: b.item || null,
      note: already ? ALREADY_NOTE : SENT_NOTE,
    };
  }, { note: typeof note === 'function' ? note : () => {} });
}

// ── the plug-in tray host (U514; plan 4A.2; TRAY@guard; PRIVATE@create a) ──
// The header's THE PLUG-IN TRAY HOST says what each member sends.
export const TRAY_MEMBERS = Object.freeze(['add', 'edit', 'remove', 'share', 'send']);
export const CREATE_TRAY_NAME = 'tray';
const TRAY_FAILED = 'It was not saved: try again.';
const TRAY_NO_TYPE = 'No element tool is armed: arm the tool, then try again.';
const TRAY_NO_ID = 'No element was named.';
const TRAY_NO_PAYLOAD = 'A payload is an object of the type\'s declared keys.';
const TRAY_NO_PATCH = 'An edit is an object of the payload keys it changes.';
const TRAY_NO_SHARED = 'Share takes true or false.';
const elementUrl = (id) => `${ELEMENTS_PATH}/${encodeURIComponent(String(id))}`;
const plainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const idOk = (id) => (typeof id === 'string' && id !== '') || Number.isSafeInteger(id);

// One write: one request with the device claim, answered {ok, element?, hint?}.
async function trayWrite(method, url, body) {
  const r = await request(method, url, { body, device: true });
  if (!r.ok) return { ok: false, status: r.status, hint: r.hint || TRAY_FAILED };
  const b = r.body && typeof r.body === 'object' ? r.body : {};
  const out = { ok: true, element: b.element || null };
  if (b.unchanged === true) out.unchanged = true;
  return out;
}

// Through the guard, always a promise: a preview answers TRAY_REFUSAL (the
// topbar's note shows READONLY_HINT) and run is never called.
const trayRun = (run) => Promise.resolve(trayAction(run));

// A tray whose add writes the type typeName() answers at the call.
function makeTray(typeName) {
  return Object.freeze({
    add({ anchor, payload } = {}) {
      return trayRun(async () => {
        const type = typeName();
        if (typeof type !== 'string' || !type) return { ok: false, hint: TRAY_NO_TYPE };
        if (!plainObject(payload)) return { ok: false, hint: TRAY_NO_PAYLOAD };
        // The payload as the type made it: no `shared` the type did not set.
        return trayWrite('POST', ELEMENTS_PATH, { type, ...(anchor !== undefined ? { anchor } : {}), payload });
      });
    },
    edit(id, patch, { base_v } = {}) {
      return trayRun(async () => {
        if (!idOk(id)) return { ok: false, hint: TRAY_NO_ID };
        if (!plainObject(patch)) return { ok: false, hint: TRAY_NO_PATCH };
        return trayWrite('PATCH', elementUrl(id), { payload: patch, ...(base_v != null ? { base_v } : {}) });
      });
    },
    remove(id) {
      return trayRun(async () => {
        if (!idOk(id)) return { ok: false, hint: TRAY_NO_ID };
        return trayWrite('DELETE', elementUrl(id), {});
      });
    },
    share(id, shared) {
      return trayRun(async () => {
        if (!idOk(id)) return { ok: false, hint: TRAY_NO_ID };
        if (typeof shared !== 'boolean') return { ok: false, hint: TRAY_NO_SHARED };
        return trayWrite('PATCH', elementUrl(id), { shared });
      });
    },
    // sendToClaude is the one Send request and runs the guard itself.
    send(id) { return Promise.resolve(sendToClaude(id, { note: showNote })); },
  });
}

// A plug-in type's draw (and move) ctx tray, bound to its type; one frozen
// object per type, so a draw allocates nothing for it.
const traysByType = new Map();
function trayOf(type) {
  let t = traysByType.get(type);
  if (!t) { t = makeTray(() => type); traysByType.set(type, t); }
  return t;
}

// The create ctx's tray (every type's create): the type is the armed one at
// the call, read from the overlay it was registered on (as ctx.stroke's);
// registered by initElementTypes, moved with the overlay (createTrayOff).
function registerCreateTray(target) {
  if (!target || typeof target.registerCreateCtx !== 'function') return;
  const armedType = () => {
    let a = null;
    try { a = typeof target.armed === 'function' ? target.armed() : null; } catch {}
    return a && typeof a.type === 'string' ? a.type : null;
  };
  try {
    createTrayOff = target.registerCreateCtx(CREATE_TRAY_NAME, makeTray(armedType)) || (() => {});
  } catch (err) {
    console.error('[web-chat] element types: the create ctx\'s tray did not register', err);
  }
}
