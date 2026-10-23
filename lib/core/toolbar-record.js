// The toolbar's two records (annotation engine 2D.2; DECISIONS.md I.6 and its
// addenda): the ONE validator, normaliser and patcher of both, and the one home
// of the chord grammar.
//
//   .web-chat/toolbar.json   (projectPaths(root).toolbar) — the project tier:
//     { v: 1, pinned: [type], hidden: [type], settings: {[type]: payload},
//       profiles: {[type]: [{name, settings}]}, bindings: {[chord]: target|null} }
//   ~/.web-chat/toolbar.json (userPaths().toolbar) — the user tier:
//     { v: 1, bindings: {[chord]: target|null}, fingerDraws: false,
//       settings: {[type]: payload} }
//
// The user tier is the default beneath the project's, key by key (H-4;
// lib/core/tier-merge is the merge, view() below its one caller here). Its
// `settings` are per-tool defaults; its `fingerDraws` is the value an `auto`
// device adopts once a pen has been seen (K.2-15) — the per-device override
// is browser storage, not this record's.
//
// THE PROJECT TIER GRANTS NOTHING AND OFFERS NOTHING. A repository may commit
// its .web-chat/toolbar.json, so a clone's copy is read as written: no field of
// either record installs, approves, trusts, runs or fetches anything, and two
// project-tier targets are refused outright —
//   * a tool target carrying `pack` ({name, source}): only the user tier,
//     written on this machine, may record where a pack comes from, so the
//     not-installed prompt (later) never offers a source a repository planted
//     (notes-D.md D-3);
//   * a `{kind: 'chrome'}` target: the chrome's own actions (Push → Claude, …)
//     are rebound only in the user record; the project binds slots and tools
//     and may unbind (null) any chord (ruling U332@project-chrome-rebind b).
// A type here is an opaque id (isSafeId): whether it is installed is the
// element-type registry's answer, never this file's; a type never names a file.
//
// THE CHORD GRAMMAR (validChord): `[Shift+]<Key>`, at most 32 characters.
// <Key> is one printable character — a letter (stored uppercase), a digit, or
// one of  [ ] / ? , . ; ' - = \ `  — or one of Space, Enter, ArrowUp,
// ArrowDown, ArrowLeft, ArrowRight, F1…F12. NOT bindable: Mod+/Ctrl+/Meta+
// (⌘K is the palette's fixed chrome row; every other ⌘/Ctrl chord is the
// browser's), Alt+, Escape (one owner: shell.js handleEscape) and Tab (focus).
// The chrome's key normaliser produces only strings this accepts, and an
// element type's manifest defaults are checked with it.
//
// A TARGET is one of
//   {kind: 'chrome', action}  action /^[a-z][a-z0-9.-]{0,63}$/ — whether the
//                             chrome knows it is the chrome's answer (an
//                             unknown id is stored and inert); user tier only
//   {kind: 'slot', n}         n an integer 1–9
//   {kind: 'tool', type, profile?, label?, pack?: {name, source}}
//                             label ≤ 60, pack.name ≤ 100, pack.source ≤ 500;
//                             pack at the user tier only
// or null (an explicit unbind, which shadows the tier beneath).
//
// LIMITS. pinned ≤ 64 and hidden ≤ 64, no duplicates, disjoint; a settings
// payload is a plain JSON object, depth ≤ 4, ≤ 16 KB serialised (the spawn
// params cap), every key and string refused when it holds a control, bidi or
// invisible character (lib/core/text hasForbidden — refused, never cleaned);
// profiles ≤ 16 per type, names 1–40 characters and unique; bindings ≤ 128 per
// tier; settings and profiles name at most 128 types each. The keys __proto__,
// constructor and prototype are refused anywhere in a record.
//
//   normalizeProject(raw) / normalizeUser(raw) → {record, ignored}
//       `raw` undefined or null is the empty record. Unknown top-level fields
//       are tolerated on read and listed in `ignored` (field paths); they are
//       not in `record`, so a write never carries them back. Anything else
//       wrong throws a ToolbarRecordError {field, why}.
//   applyPatch(record, patch, tier) → {ok: true, record} | {ok: false, field, why}
//       Never throws. `pinned`, `hidden` and `fingerDraws` replace; `settings`,
//       `profiles` and `bindings` merge per key (a stored null binding is an
//       explicit unbind); `unset: {bindings: [chord], settings: [type],
//       profiles: [type]}` deletes keys. The result must be valid as a whole:
//       pinning a hidden type (or hiding a pinned one) is accepted only when the
//       patch names both lists consistently.
//   view(project, user) → {project, user, merged: {bindings, settings}}
//       merged.bindings is tier-merge's mergeByKey over user ⊕ project;
//       merged.settings[type] the same over that type's fields.
//   validChord(s) → the canonical chord, or null
//   emptyProject() / emptyUser() → the defaults
//
// Pure: lib/core only (paths isSafeId, text hasForbidden, tier-merge).
'use strict';

const { isSafeId } = require('./paths');
const { hasForbidden } = require('./text');
const { mergeByKey } = require('./tier-merge');

const VERSION = 1;
const LIST_MAX = 64;              // pinned, and hidden
const BINDINGS_MAX = 128;         // per tier
const TYPES_MAX = 128;            // types named in settings, or in profiles
const PROFILES_MAX = 16;          // per type
const PROFILE_NAME_MAX = 40;      // characters
const SETTINGS_MAX_BYTES = 16 * 1024;
const SETTINGS_DEPTH_MAX = 4;     // the payload object itself is depth 1
const CHORD_MAX = 32;
const ACTION_RE = /^[a-z][a-z0-9.-]{0,63}$/;
const LABEL_MAX = 60;
const PACK_NAME_MAX = 100;
const PACK_SOURCE_MAX = 500;
const REFUSED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TIERS = Object.freeze(['project', 'user']);

const PROJECT_FIELDS = Object.freeze(['v', 'pinned', 'hidden', 'settings', 'profiles', 'bindings']);
const USER_FIELDS = Object.freeze(['v', 'bindings', 'fingerDraws', 'settings']);

const NAMED_KEYS = new Set([
  'Space', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);
const PUNCTUATION = new Set(['[', ']', '/', '?', ',', '.', ';', '\'', '-', '=', '\\', '`']);

class ToolbarRecordError extends Error {
  constructor(field, why) {
    super(`${field || 'record'}: ${why}`);
    this.name = 'ToolbarRecordError';
    this.field = field || '';
    this.why = why;
  }
}

const fail = (field, why) => { throw new ToolbarRecordError(field, why); };
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const join = (base, key) => (base ? `${base}.${key}` : String(key));
const charCount = (s) => [...s].length;

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// The keys of a record-level object, each checked: never a refused key, never
// a forbidden character.
function keysOf(obj, field) {
  const keys = Object.keys(obj);
  for (const k of keys) {
    if (REFUSED_KEYS.has(k)) fail(join(field, k), `the key '${k}' is refused`);
    if (hasForbidden(k)) fail(field, 'a key holds a control, bidi or invisible character');
  }
  return keys;
}

// ── chords ───────────────────────────────────────────────────────────────────

function validKey(k) {
  if (NAMED_KEYS.has(k)) return k;
  if (k.length !== 1) return null;
  if (/^[a-z]$/.test(k)) return k.toUpperCase();
  if (/^[A-Z0-9]$/.test(k)) return k;
  return PUNCTUATION.has(k) ? k : null;
}

function validChord(s) {
  if (typeof s !== 'string' || !s || s.length > CHORD_MAX) return null;
  const shift = s.startsWith('Shift+');
  const key = validKey(shift ? s.slice('Shift+'.length) : s);
  if (!key) return null;
  return shift ? `Shift+${key}` : key;
}

// ── text fields ──────────────────────────────────────────────────────────────

function text(v, field, max, { min = 1 } = {}) {
  if (typeof v !== 'string') fail(field, 'must be a string');
  const n = charCount(v);
  if (n < min) fail(field, 'must not be empty');
  if (n > max) fail(field, `at most ${max} characters`);
  if (hasForbidden(v)) fail(field, 'holds a control, bidi or invisible character');
  return v;
}

function typeId(v, field) {
  if (!isSafeId(v)) fail(field, 'a type is an id of letters, digits, _ and - (at most 100)');
  return v;
}

// ── settings payloads ────────────────────────────────────────────────────────

// A copy of a JSON value, checked as it is copied: plain objects and arrays,
// strings, finite numbers, booleans and null; depth counted from the payload.
function jsonValue(v, field, depth) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(field, 'a number must be finite');
    return v;
  }
  if (typeof v === 'string') {
    if (hasForbidden(v)) fail(field, 'holds a control, bidi or invisible character');
    return v;
  }
  if (depth + 1 > SETTINGS_DEPTH_MAX) fail(field, `a settings payload nests at most ${SETTINGS_DEPTH_MAX} deep`);
  if (Array.isArray(v)) return v.map((x, i) => jsonValue(x, `${field}[${i}]`, depth + 1));
  if (!isPlainObject(v)) fail(field, 'must be plain JSON');
  const out = {};
  for (const k of keysOf(v, field)) out[k] = jsonValue(v[k], join(field, k), depth + 1);
  return out;
}

function payload(v, field) {
  if (!isPlainObject(v)) fail(field, 'a settings payload is a JSON object');
  const out = {};
  for (const k of keysOf(v, field)) out[k] = jsonValue(v[k], join(field, k), 1);
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(out), 'utf8'); } catch { bytes = Infinity; }
  if (bytes > SETTINGS_MAX_BYTES) fail(field, `a settings payload is at most ${SETTINGS_MAX_BYTES} bytes serialised`);
  return out;
}

function settingsMap(v, field) {
  if (v === undefined) return {};
  if (!isPlainObject(v)) fail(field, 'must be an object of type → settings');
  const keys = keysOf(v, field);
  if (keys.length > TYPES_MAX) fail(field, `at most ${TYPES_MAX} types`);
  const out = {};
  for (const k of keys) out[typeId(k, join(field, k))] = payload(v[k], join(field, k));
  return out;
}

// ── profiles ─────────────────────────────────────────────────────────────────

function profileList(v, field) {
  if (!Array.isArray(v)) fail(field, 'must be a list of {name, settings}');
  if (v.length > PROFILES_MAX) fail(field, `at most ${PROFILES_MAX} profiles a tool`);
  const names = new Set();
  return v.map((p, i) => {
    const at = `${field}[${i}]`;
    if (!isPlainObject(p)) fail(at, 'a profile is {name, settings}');
    for (const k of keysOf(p, at)) if (k !== 'name' && k !== 'settings') fail(join(at, k), 'not a profile field');
    const name = text(p.name, join(at, 'name'), PROFILE_NAME_MAX);
    if (names.has(name)) fail(join(at, 'name'), `the profile name '${name}' is used twice`);
    names.add(name);
    return { name, settings: payload(p.settings === undefined ? {} : p.settings, join(at, 'settings')) };
  });
}

function profilesMap(v, field) {
  if (v === undefined) return {};
  if (!isPlainObject(v)) fail(field, 'must be an object of type → [{name, settings}]');
  const keys = keysOf(v, field);
  if (keys.length > TYPES_MAX) fail(field, `at most ${TYPES_MAX} types`);
  const out = {};
  for (const k of keys) out[typeId(k, join(field, k))] = profileList(v[k], join(field, k));
  return out;
}

// ── bindings ─────────────────────────────────────────────────────────────────

function onlyFields(v, field, allowed) {
  for (const k of keysOf(v, field)) if (!allowed.includes(k)) fail(join(field, k), 'not a field of this target');
}

function target(v, field, tier) {
  if (v === null) return null;
  if (!isPlainObject(v)) fail(field, 'a target is {kind: chrome | slot | tool, …} or null');
  if (v.kind === 'chrome') {
    if (tier === 'project') fail(field, 'a project record binds slots and tools; the chrome\'s own actions are rebound only in your user record');
    onlyFields(v, field, ['kind', 'action']);
    if (typeof v.action !== 'string' || !ACTION_RE.test(v.action)) fail(join(field, 'action'), 'an action id is lowercase letters, digits, . and - (at most 64)');
    return { kind: 'chrome', action: v.action };
  }
  if (v.kind === 'slot') {
    onlyFields(v, field, ['kind', 'n']);
    if (!Number.isInteger(v.n) || v.n < 1 || v.n > 9) fail(join(field, 'n'), 'a slot is an integer from 1 to 9');
    return { kind: 'slot', n: v.n };
  }
  if (v.kind === 'tool') {
    onlyFields(v, field, ['kind', 'type', 'profile', 'label', 'pack']);
    const out = { kind: 'tool', type: typeId(v.type, join(field, 'type')) };
    if (v.profile !== undefined) out.profile = text(v.profile, join(field, 'profile'), PROFILE_NAME_MAX);
    if (v.label !== undefined) out.label = text(v.label, join(field, 'label'), LABEL_MAX);
    if (v.pack !== undefined) {
      const at = join(field, 'pack');
      if (tier === 'project') fail(at, 'where a pack comes from is recorded only in your user record, never in a project\'s');
      if (!isPlainObject(v.pack)) fail(at, 'a pack is {name, source}');
      onlyFields(v.pack, at, ['name', 'source']);
      out.pack = {
        name: text(v.pack.name, join(at, 'name'), PACK_NAME_MAX),
        source: text(v.pack.source, join(at, 'source'), PACK_SOURCE_MAX),
      };
    }
    return out;
  }
  return fail(join(field, 'kind'), 'a target\'s kind is chrome, slot or tool');
}

// A chord key as written → its canonical form, or a refusal naming it.
function chordKey(k, field) {
  const c = validChord(k);
  if (!c) fail(join(field, k), `'${k}' is not a bindable chord ([Shift+]<key>; never Mod, Alt, Escape or Tab)`);
  return c;
}

function bindingsMap(v, field, tier) {
  if (v === undefined) return {};
  if (!isPlainObject(v)) fail(field, 'must be an object of chord → target');
  const keys = keysOf(v, field);
  if (keys.length > BINDINGS_MAX) fail(field, `at most ${BINDINGS_MAX} bindings`);
  const out = {};
  for (const k of keys) {
    const c = chordKey(k, field);
    if (hasOwn(out, c)) fail(join(field, c), `the chord ${c} is bound twice`);
    out[c] = target(v[k], join(field, c), tier);
  }
  return out;
}

// ── pinned / hidden ──────────────────────────────────────────────────────────

function typeList(v, field) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(field, 'must be a list of types');
  if (v.length > LIST_MAX) fail(field, `at most ${LIST_MAX} types`);
  const seen = new Set();
  return v.map((t, i) => {
    typeId(t, `${field}[${i}]`);
    if (seen.has(t)) fail(`${field}[${i}]`, `the type '${t}' is listed twice`);
    seen.add(t);
    return t;
  });
}

// ── the records ──────────────────────────────────────────────────────────────

function emptyProject() {
  return { v: VERSION, pinned: [], hidden: [], settings: {}, profiles: {}, bindings: {} };
}

function emptyUser() {
  return { v: VERSION, bindings: {}, fingerDraws: false, settings: {} };
}

function top(raw, fields) {
  if (raw === undefined || raw === null) return { src: {}, ignored: [] };
  if (!isPlainObject(raw)) fail('', 'a toolbar record is a JSON object');
  const ignored = [];
  for (const k of keysOf(raw, '')) if (!fields.includes(k)) ignored.push(k);
  if (raw.v !== undefined && raw.v !== VERSION) fail('v', `this build reads version ${VERSION} of the toolbar record`);
  return { src: raw, ignored };
}

function normalizeProject(raw) {
  const { src, ignored } = top(raw, PROJECT_FIELDS);
  const record = {
    v: VERSION,
    pinned: typeList(src.pinned, 'pinned'),
    hidden: typeList(src.hidden, 'hidden'),
    settings: settingsMap(src.settings, 'settings'),
    profiles: profilesMap(src.profiles, 'profiles'),
    bindings: bindingsMap(src.bindings, 'bindings', 'project'),
  };
  const pinned = new Set(record.pinned);
  for (const t of record.hidden) {
    if (pinned.has(t)) fail('hidden', `the type '${t}' is both pinned and hidden`);
  }
  return { record, ignored };
}

function normalizeUser(raw) {
  const { src, ignored } = top(raw, USER_FIELDS);
  if (src.fingerDraws !== undefined && typeof src.fingerDraws !== 'boolean') fail('fingerDraws', 'must be true or false');
  const record = {
    v: VERSION,
    bindings: bindingsMap(src.bindings, 'bindings', 'user'),
    fingerDraws: src.fingerDraws === true,
    settings: settingsMap(src.settings, 'settings'),
  };
  return { record, ignored };
}

const normalizerFor = (tier) => (tier === 'project' ? normalizeProject : normalizeUser);

// ── patches ──────────────────────────────────────────────────────────────────

const PATCH_FIELDS = Object.freeze({
  project: ['pinned', 'hidden', 'settings', 'profiles', 'bindings', 'unset'],
  user: ['bindings', 'fingerDraws', 'settings', 'unset'],
});
const UNSET_FIELDS = Object.freeze({
  project: ['bindings', 'settings', 'profiles'],
  user: ['bindings', 'settings'],
});

function patchInto(record, patch, tier) {
  if (!TIERS.includes(tier)) fail('', `tier must be 'project' or 'user'`);
  if (!isPlainObject(patch)) fail('', 'a patch is a JSON object');
  for (const k of keysOf(patch, '')) {
    if (k === 'v' && patch.v === VERSION) continue;
    if (!PATCH_FIELDS[tier].includes(k)) fail(k, tier === 'user' ? 'not a field of your user record' : 'not a field of the project record');
  }
  // The current record, checked again (a caller's own object is never trusted
  // to be normalised) and copied.
  const base = normalizerFor(tier)(record).record;
  const next = { ...base };
  for (const k of ['pinned', 'hidden', 'fingerDraws']) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  for (const k of ['settings', 'profiles', 'bindings']) {
    if (patch[k] === undefined) continue;
    if (!isPlainObject(patch[k])) fail(k, 'merges per key: an object');
    keysOf(patch[k], k);
    // Chords are merged by their canonical form, so 'c' replaces 'C'.
    const merged = { ...base[k] };
    const named = new Set();
    for (const key of Object.keys(patch[k])) {
      const at = k === 'bindings' ? chordKey(key, k) : key;
      if (named.has(at)) fail(join(k, at), `the chord ${at} is named twice by this patch`);
      named.add(at);
      merged[at] = patch[k][key];
    }
    next[k] = merged;
  }
  if (patch.unset !== undefined) {
    const u = patch.unset;
    if (!isPlainObject(u)) fail('unset', 'is {bindings?: [chord], settings?: [type], profiles?: [type]}');
    for (const k of keysOf(u, 'unset')) {
      if (!UNSET_FIELDS[tier].includes(k)) fail(join('unset', k), 'not a field that can be unset here');
      if (!Array.isArray(u[k])) fail(join('unset', k), 'a list of keys');
      const map = { ...next[k] };
      u[k].forEach((key, i) => {
        if (typeof key !== 'string') fail(`unset.${k}[${i}]`, 'a key is a string');
        const at = k === 'bindings' ? chordKey(key, `unset.${k}`) : key;
        const set = patch[k] && Object.keys(patch[k]).some((p) => (k === 'bindings' ? validChord(p) : p) === at);
        if (set) fail(`unset.${k}[${i}]`, `'${at}' is both set and unset by this patch`);
        delete map[at];
      });
      next[k] = map;
    }
  }
  // The whole result through the one normaliser: every limit, and the rule that
  // a type is never both pinned and hidden.
  return normalizerFor(tier)(next).record;
}

function applyPatch(record, patch, tier) {
  try {
    return { ok: true, record: patchInto(record, patch, tier) };
  } catch (e) {
    if (e instanceof ToolbarRecordError) return { ok: false, field: e.field, why: e.why };
    return { ok: false, field: '', why: (e && e.message) || String(e) };
  }
}

// ── the merged view ──────────────────────────────────────────────────────────

function view(project, user) {
  const p = project || emptyProject();
  const u = user || emptyUser();
  const types = new Set([...Object.keys(u.settings || {}), ...Object.keys(p.settings || {})]);
  const settings = {};
  for (const t of [...types].sort()) {
    settings[t] = mergeByKey([
      { tier: 'user', record: (u.settings || {})[t] },
      { tier: 'project', record: (p.settings || {})[t] },
    ]);
  }
  return {
    project: p,
    user: u,
    merged: {
      bindings: mergeByKey([{ tier: 'user', record: u.bindings }, { tier: 'project', record: p.bindings }]),
      settings,
    },
  };
}

module.exports = {
  VERSION, LIST_MAX, BINDINGS_MAX, TYPES_MAX, PROFILES_MAX, PROFILE_NAME_MAX, SETTINGS_MAX_BYTES, SETTINGS_DEPTH_MAX,
  CHORD_MAX, LABEL_MAX, PACK_NAME_MAX, PACK_SOURCE_MAX,
  ToolbarRecordError, validChord, emptyProject, emptyUser, normalizeProject, normalizeUser, applyPatch, view,
};
