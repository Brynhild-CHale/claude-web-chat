// The toolbar's records in the chrome (annotation engine 2D.2): the ONE reader
// and writer of GET /api/toolbar, PATCH /api/toolbar (this project's record)
// and PATCH /api/toolbar/user (the user's, every project's). No other chrome
// module fetches those routes: the hotkeys, the tools and the toolbar read
// here and write through here.
//
//   initToolbarState({ onFrame, onHello })   wire it (idempotent): a GET now
//                    and after every hello, and the daemon's `toolbar` frame
//   toolbarState()   → { project, user, merged, canWrite, canWriteUser,
//                    corrupt, ignored, tools } — the last view, and what this
//                    viewer may write as the last GET said (the frame never
//                    carries those two: they are the requester's own). `tools`
//                    is GET's tools[] (the listed element types' toolbar
//                    fields, U337), kept until an answer carries it again — the
//                    frame does not; a `components` frame (a pack installed,
//                    approved or removed) reads it again.
//   onToolbarChange(fn) → unsubscribe; fn(state) on each new view
//   refreshToolbar() → the GET, by hand
//   patchToolbar(patch) / patchUserToolbar(patch) → http.js's
//                    { ok, status, body, refused, hint } — never throws. An
//                    accepted write lands at once (the answer carries the new
//                    view) and again as the frame every socket gets.
//   settingsOf(type, profile?) → that type's merged settings: the user's
//                    default ⊕ the project's ⊕ the named profile's, field by
//                    field (lib/core/tier-merge's mergeByKey, served as
//                    /app/tier-merge.js — never a second merge)
//   settingsSnapshot(type, profile?) → Object.freeze({small, large}): the
//                    type's two levels as a plug-in type reads them through
//                    ctx.settings() (U512c): each level's declared fields
//                    (tools[]'s settings[level].properties), each settingsOf's
//                    value when it holds the key, else the schema's default; a
//                    field with neither is absent; an undeclared level is {}.
//                    Frozen, read-only, memoised per view (a new view — a GET,
//                    a frame, a PATCH — answers new values). Never a writer.
//   defaultSettings(type) → the same shape from the schema's defaults alone
//                    (element.json's): what a type that is not armed reads.
//   iconSrc(type)    → the URL of a listed type's icon, /api/toolbar/icon/<type>
//                    with ?mode=dark under web-chat's dark mode: the ONE
//                    spelling of that route in the chrome (the toolbar's slots
//                    and the queue rail's rows read it; neither builds it).
//
// The daemon validates every record (lib/core/toolbar-record); this module only
// reads defensively: anything not shaped like a record reads as an empty one,
// so a daemon that answers a bare {ok: true} (an older build, or a test's quiet
// default) leaves empty records and a writable tray.
//
// Ordering (public/app/project.js's rule): reads are numbered as they go out,
// and an answer lands only when no later read's answer and no frame has landed
// since it went out — either is newer news.
//
// Its wiring is injected, as project.js's is, so it imports nothing from the
// socket's module graph; main.js passes ws.js's seams.
import { request } from './http.js';
import { mergeByKey } from './tier-merge.js';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const objectOr = (v) => (isObject(v) ? v : {});
const listOr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

function cleanProject(p) {
  const r = objectOr(p);
  return {
    v: 1, pinned: listOr(r.pinned), hidden: listOr(r.hidden),
    settings: objectOr(r.settings), profiles: objectOr(r.profiles), bindings: objectOr(r.bindings),
  };
}

function cleanUser(u) {
  const r = objectOr(u);
  return { v: 1, bindings: objectOr(r.bindings), fingerDraws: r.fingerDraws === true, settings: objectOr(r.settings) };
}

const cleanTools = (t) => Object.freeze(Array.isArray(t) ? t.filter((x) => isObject(x) && typeof x.type === 'string') : []);

let view = {
  project: cleanProject(null), user: cleanUser(null), merged: { bindings: {}, settings: {} },
  canWrite: true, canWriteUser: true, corrupt: [], ignored: [], tools: cleanTools(null),
};
const listeners = new Set();
let reads = 0;
let readLanded = 0;
let frames = 0;
let wired = false;

function land(body, { access }) {
  const b = objectOr(body);
  const merged = objectOr(b.merged);
  view = Object.freeze({
    project: cleanProject(b.project),
    user: cleanUser(b.user),
    merged: { bindings: objectOr(merged.bindings), settings: objectOr(merged.settings) },
    canWrite: access ? b.canWrite !== false : view.canWrite,
    canWriteUser: access ? b.canWriteUser !== false : view.canWriteUser,
    corrupt: access ? listOr(b.corrupt) : view.corrupt,
    ignored: access ? listOr(b.ignored) : view.ignored,
    tools: Array.isArray(b.tools) ? cleanTools(b.tools) : view.tools,
  });
  for (const fn of [...listeners]) {
    try { fn(view); } catch (e) { console.error('[toolbar-state] a listener failed', e); }
  }
}

export function toolbarState() { return view; }

// web-chat's own mode, as theme.js leaves it on <html>: data-theme="light", or
// anything else (no attribute) for dark — cobrand.js's reading. Read per call.
const darkMode = () => document.documentElement.dataset.theme !== 'light';
export const iconSrc = (type) => `/api/toolbar/icon/${encodeURIComponent(type)}${darkMode() ? '?mode=dark' : ''}`;

export function onToolbarChange(fn) {
  if (typeof fn !== 'function') throw new TypeError('onToolbarChange: fn must be a function');
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// GET /api/toolbar. A failure keeps what is known.
export async function refreshToolbar() {
  const read = ++reads;
  const at = frames;
  const r = await request('GET', '/api/toolbar');
  if (!r.ok || read < readLanded || frames !== at) return r;
  readLanded = read;
  land(r.body, { access: true });
  return r;
}

// The daemon's `toolbar` frame: the whole view, to every socket.
export function applyToolbarFrame(frame) {
  if (!isObject(frame)) return false;
  frames++;
  land(frame, { access: false });
  return true;
}

async function patch(path, body) {
  const r = await request('PATCH', path, { body: isObject(body) ? body : {} });
  if (r.ok && isObject(r.body)) {
    frames++;
    land(r.body, { access: true });
  }
  return r;
}

export function patchToolbar(body) { return patch('/api/toolbar', body); }
export function patchUserToolbar(body) { return patch('/api/toolbar/user', body); }

export function settingsOf(type, profile) {
  const s = view;
  const user = objectOr(s.user.settings[type]);
  const project = objectOr(s.project.settings[type]);
  let named = null;
  if (typeof profile === 'string') {
    const list = Array.isArray(s.project.profiles[type]) ? s.project.profiles[type] : [];
    const hit = list.find((p) => isObject(p) && p.name === profile);
    named = hit ? objectOr(hit.settings) : null;
  }
  let merged;
  try {
    merged = mergeByKey([
      { tier: 'user', record: user }, { tier: 'project', record: project }, { tier: 'profile', record: named },
    ]);
  } catch {
    return {};
  }
  const out = {};
  for (const k of Object.keys(merged)) out[k] = merged[k].value;
  return out;
}

// ── the plug-in settings seam (U512c) ──────────────────────────────────────
const NO_SETTINGS = Object.freeze({ small: Object.freeze({}), large: Object.freeze({}) });
const SETTINGS_LEVELS = Object.freeze(['small', 'large']);
const snapshots = new WeakMap();   // a view → Map('<saved?>|<type>|<profile>' → snapshot)

// `fallback`: a declaration to read when the toolbar view has no tools[] row
// for the type (GET /api/toolbar not landed yet, or failed) — the element-types
// listing row's toolbar.settings, element.json's own (U590, contract (r)).
const hasToolRow = (type) => view.tools.some((t) => t.type === type);
function snapshotOf(type, values, fallback = null) {
  const row = view.tools.find((t) => t.type === type);
  const decl = row ? (isObject(row.settings) ? row.settings : null) : (isObject(fallback) ? fallback : null);
  if (!decl) return NO_SETTINGS;
  const out = {};
  for (const level of SETTINGS_LEVELS) {
    const schema = decl[level];
    const props = isObject(schema) && isObject(schema.properties) ? schema.properties : {};
    const lv = {};
    for (const k of Object.keys(props)) {
      if (values && Object.hasOwn(values, k)) lv[k] = values[k];
      else if (isObject(props[k]) && Object.hasOwn(props[k], 'default')) lv[k] = props[k].default;
    }
    out[level] = Object.freeze(lv);
  }
  return Object.freeze(out);
}

function memo(key, make) {
  let m = snapshots.get(view);
  if (!m) { m = new Map(); snapshots.set(view, m); }
  if (!m.has(key)) m.set(key, make());
  return m.get(key);
}

export function settingsSnapshot(type, profile, fallback = null) {
  if (typeof type !== 'string' || !type) return NO_SETTINGS;
  const p = typeof profile === 'string' ? profile : null;
  const values = () => settingsOf(type, p == null ? undefined : p);
  if (!hasToolRow(type)) return snapshotOf(type, values(), fallback);   // not memoised: the fallback may change
  return memo(`s|${type}|${p == null ? '' : p}`, () => snapshotOf(type, values()));
}

export function defaultSettings(type, fallback = null) {
  if (typeof type !== 'string' || !type) return NO_SETTINGS;
  if (!hasToolRow(type)) return snapshotOf(type, null, fallback);
  return memo(`d|${type}`, () => snapshotOf(type, null));
}

export function initToolbarState({ onFrame, onHello } = {}) {
  if (wired) return;
  wired = true;
  if (typeof onFrame === 'function') onFrame('toolbar', (msg) => { applyToolbarFrame(msg); });
  if (typeof onHello === 'function') onHello(() => { refreshToolbar(); });
  if (typeof onFrame === 'function') onFrame('components', () => { refreshToolbar(); });
  refreshToolbar();
}
