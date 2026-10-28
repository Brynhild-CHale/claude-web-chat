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
import * as overlayModule from './overlay.js';
import { request } from './http.js';
import { bus } from './bus.js';
import { onFrame, onHello } from './ws.js';
import { contentReadOnly } from './mounts.js';
import { READONLY_HINT, showReaimNote } from './topbar.js';
import { toolbarState } from './toolbar-state.js';

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
    const r = await request('POST', sendPath(id), { body: {}, device: true });
    if (!r.ok) return { ok: false, status: r.status, hint: r.hint || SEND_FAILED };
    const b = r.body && typeof r.body === 'object' ? r.body : {};
    const already = b.already === true;
    return {
      ok: true, already, element: b.element || null, item: b.item || null,
      note: already ? ALREADY_NOTE : SENT_NOTE,
    };
  }, { note: typeof note === 'function' ? note : () => {} });
}
