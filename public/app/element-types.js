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
// Tranche 2 draws in the live chrome only (F-DOCS a); no pack's draw module
// is loaded here (third-party draw code waits for 4A/4B, B1).
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
import * as overlayModule from './overlay.js';
import { request } from './http.js';
import { bus } from './bus.js';
import { onFrame, onHello } from './ws.js';

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

// ── the listing ─────────────────────────────────────────────────────────────
// initElementTypes({overlay}) — idempotent. `overlay` is injectable (a test's
// stub): handing another one moves every registration and the answers
// listener onto it.
let answersOff = null;
export function initElementTypes(opts = {}) {
  if (opts && opts.overlay && opts.overlay !== ov) {
    ov = opts.overlay;
    if (answersOff) { try { answersOff(); } catch {} answersOff = null; }
    for (const type of [...registrations.keys()]) reregister(type);
  }
  if (!answersOff && typeof ov.onAnswers === 'function') answersOff = ov.onAnswers(onAnswers) || (() => {});
  if (inited) return;
  inited = true;
  onHello(() => { loadTypes(); });
  onFrame('components', () => { loadTypes(); });
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

function reregister(type) {
  const entry = registrations.get(type);
  if (!entry) return;
  try { entry.unregister(); } catch {}
  const { spec } = entry;
  entry.unregister = ov.registerType(type, {
    ...spec,
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
    spec.draw(view, ctx);
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
    spec.move(items.length === group.items.length ? group : { ...group, items }, ctx);
  } catch (err) {
    console.error(`[web-chat] element type '${group.type}': its move failed`, err);
  }
}
