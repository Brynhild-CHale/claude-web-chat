// The toolbar's records over HTTP (annotation engine 2D.2; DECISIONS.md I.6,
// rulings H-6 and U332@project-chrome-rebind). lib/core/toolbar-record is the
// one validator, chord grammar and patcher; this file reads and writes the two
// files through lib/core/fsjson and says who may write which.
//
//   GET   /api/toolbar       → {ok, v, project, user, merged, canWrite,
//                              canWriteUser, corrupt?, ignored?}
//         every level (the tray reads). `canWrite`: the requester may write the
//         project record (local, or a remote viewer at mirror level full);
//         `canWriteUser`: local only. The chrome greys a read-only tray from
//         these two facts, never from a check of its own (W-12).
//   PATCH /api/toolbar       the project record (.web-chat/toolbar.json): pin,
//         hide, order, settings, profiles, project bindings. Local, or a remote
//         viewer at full (H-6); the daemon checks the level the portal enforces
//         again (requireMirror('full')).
//   PATCH /api/toolbar/user  the user record (~/.web-chat/toolbar.json): the
//         key bindings for every project, fingerDraws, per-tool defaults. Local
//         only — a write that reaches every project on the host (the
//         routes/theme.js precedent for a system theme). NOT requireHost():
//         isHost refuses every browser request, and the user's own chrome must
//         write this record. A pane's fetch reaches it too, which costs nothing:
//         neither record grants, installs, trusts or runs anything (C-15-1 — no
//         rule here reads a pane's identity or an author as a boundary).
//
// A record that is absent reads as the defaults; one that is torn or fails the
// validator reads as the defaults AND is named in `corrupt` — never a silent
// empty. The next PATCH of that tier first moves the bad file aside
// (renameAside, tag 'corrupt'), then writes a fresh record. Writes go through
// writeJsonAtomic only.
//
// A previewed node never refuses a toolbar write: toolbar state is not node
// content (W-4) — only levels refuse. The records never touch state.store
// (which folds into nodes) and never browser storage.
//
// Each successful write emits ONE `toolbar` frame through ctx.bus.emit, with no
// event-log entry: toolbar state is not surface content, folds into no node
// and is not Claude's catch-up (notes-D.md D-5). The frame is a SURFACE_FRAMES
// entry (lib/core/remote-policy): it carries no conversation text and no
// private record, and passes whole at every level, as GET does.
//
// THE TYPE-AWARE HALF (U337, PLAN.md 2D.7; DECISIONS.md I.6 addenda 1–2,
// K.2-45/46; ruling 2C@types-dir a):
//
//   GET's `tools`  every type the element-type registry LISTS (ctx.elementTypes,
//         U324's record-gated registry: an unreviewed, quarantined, pending or
//         committed-without-record type never appears — GT-17), the built-in
//         pack's first in its manifest order, then by type: {type, label,
//         pack: {name, version}, builtin, icons: {light, dark} | null (each the
//         URL of the icon route below, never a path), hotkeys, settings (the
//         schemas element.json declares, {small?, large?} | null), profiles,
//         input, installed: true}. The readers' defaults of lib/packs/elements
//         are applied here, once: label → the type name with its first letter
//         upper-cased; profiles false; input 'taps'; a hotkey's chord through
//         validChord. Every string is data the chrome shows as text.
//   `installed`  each tool target in merged.bindings (its value and each value
//         it shadows) gains installed: true | false, whether the registry lists
//         its type. Only the MERGED view is decorated: project and user are the
//         records as written, so a binding read back from them round-trips
//         through PATCH. A user-tier target's `pack` row rides as written; the
//         project tier never carries one (lib/core/toolbar-record refuses it).
//   default `pinned`  a project record with no `pinned` field (absent, torn, or
//         written without one) reads as pinning the built-in pack's listed
//         types in its manifest order, less any it hides (notes-D.md D-6): a
//         default any user changes like any other value, not a privileged slot.
//         A PATCH that does not name `pinned` keeps the field absent on disk,
//         so the default still follows the listing.
//   PATCH validation  after the record's own bounds: each `settings[type]` and
//         each profile's `settings` named by the patch is checked with
//         lib/core/settings-schema checkValue against that listed type's
//         settings.small ∪ settings.large (a key either declares; one both
//         declare must pass both); `profiles[type]` is refused for a listed
//         type whose manifest does not say profiles: true (H-1). A type the
//         registry does not list keeps the record's bounds only.
//   GET /api/toolbar/icon/:type[?mode=dark]  the icon element.json names, at
//         every level (its RULES row is protocol 12's). 404 unless the registry
//         lists the type and it names icons. The file is read through
//         lib/server/element-files readFenced (the one fenced read of a type's
//         file, U511): fenced inside the type's installed directory
//         (lib/core/paths fence, isInside), no
//         segment of its path may be a link, it is opened without following
//         one (O_NOFOLLOW) and must be a regular file within brand-image's
//         size cap; its bytes must equal the digest the pack's record — and,
//         for a project install, this machine's ledger — holds for that file
//         (a file changed on disk since review is refused, never served), pass
//         lib/core/brand-image validate (the one image check) and be the format
//         its name says; then routes/brand.js sendImage sends them (the one
//         locked-down image response, the type from the sniff).
//
// Nothing here installs, approves, trusts or fetches anything: a tool whose
// type is not listed is only `installed: false` data (the not-installed
// prompt's, public/app/tools.js).
'use strict';

const path = require('path');

const { projectPaths, userPaths, isSafeId } = require('../../core/paths');
const { readJson, writeJsonAtomic, renameAside } = require('../../core/fsjson');
const { classify, hintFor } = require('../../core/remote-policy');
const {
  normalizeProject, normalizeUser, emptyProject, emptyUser, applyPatch, view, validChord, VERSION,
} = require('../../core/toolbar-record');
const { checkValue } = require('../../core/settings-schema');
const { validate: validateImage, MAX_BYTES: IMAGE_MAX_BYTES, TYPES: IMAGE_TYPES } = require('../../core/brand-image');
const { BUILTIN_ELEMENT_PACK, BUILTIN_ELEMENT_TYPE_NAMES } = require('../../core/names');
const { parseManifest } = require('../../packs/manifest');
const { findPack } = require('../../packs/store');
const { ELEMENTS_TEMPLATE_DIR } = require('../builtins');
const { sendImage } = require('./brand');
const { readFenced, TypeFileRefusal } = require('../element-files');

// A PATCH body's cap. The global JSON parser (lib/server/index.js) has already
// read the body at its own, far larger, limit, so the cap is checked here on
// the declared length and on the parsed body.
const TOOLBAR_BODY_MAX = 64 * 1024;

// The user-tier refusal's words: the portal's own for the same refusal (its
// `* /api/toolbar/*` row), read from the table rather than copied.
const USER_HINT = classify('PATCH', '/api/toolbar/user').hint;

const TIERS = Object.freeze({
  project: { file: (ctx) => projectPaths(ctx.root).toolbar, normalize: normalizeProject, empty: emptyProject },
  user: { file: () => userPaths().toolbar, normalize: normalizeUser, empty: emptyUser },
});

// One tier's record as the file holds it: {record, ignored, corrupt, absent,
// pinned} — `pinned`: whether the file itself names the field (the default
// `pinned` applies when it does not).
function readTier(ctx, tier) {
  const t = TIERS[tier];
  const r = readJson(t.file(ctx));
  if (r.absent) return { record: t.empty(), ignored: [], corrupt: false, absent: true, pinned: false };
  if (!r.ok) return { record: t.empty(), ignored: [], corrupt: true, absent: false, pinned: false };
  try {
    const { record, ignored } = t.normalize(r.value);
    const pinned = r.value !== null && typeof r.value === 'object' && Object.hasOwn(r.value, 'pinned');
    return { record, ignored, corrupt: false, absent: false, pinned };
  } catch {
    return { record: t.empty(), ignored: [], corrupt: true, absent: false, pinned: false };
  }
}

// ── the type-aware half (U337) ───────────────────────────────────────────────

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const upperFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// The built-in pack's manifest order of its types: the shipped manifest's
// `elements` (the boot step installs exactly that tree, U323), read once; the
// core declaration's order if it cannot be read.
let builtinOrderMemo = null;
function builtinOrder() {
  if (builtinOrderMemo) return builtinOrderMemo;
  let list = null;
  try {
    const m = parseManifest(ELEMENTS_TEMPLATE_DIR);
    if (Array.isArray(m.elements) && m.elements.every((t) => typeof t === 'string')) list = m.elements.slice();
  } catch { list = null; }
  builtinOrderMemo = Object.freeze(list || [...BUILTIN_ELEMENT_TYPE_NAMES]);
  return builtinOrderMemo;
}

// A row armed by another listed type's tool (element.json `tool`, lib/packs/
// elements.js; the built-in chat-comment names `comment`: "the one Comment
// tool arms both", RULED CHAT@type a) has no slot, pin or hotkey of its own,
// so it is left out of the toolbar's rows; the registry still lists it. A
// `tool` naming a type that is not listed leaves the row in. Exported for
// test-support/chrome-shell.js, whose generated toolbar applies the same rule.
function toolRows(rows) {
  const listed = new Set(rows.map((r) => r.type));
  const armedBy = (r) => (isObject(r.toolbar) && typeof r.toolbar.tool === 'string' ? r.toolbar.tool : null);
  return rows.filter((r) => { const t = armedBy(r); return !(t && t !== r.type && listed.has(t)); });
}

// The registry's listed rows in the toolbar's order: the built-in pack's
// first, in its manifest order, then every other by type (list() is sorted);
// a row another listed type's tool arms is left out (toolRows).
function listedRows(ctx) {
  const et = ctx.elementTypes;
  let rows = [];
  try { rows = et && typeof et.list === 'function' ? et.list() : []; } catch { rows = []; }
  rows = toolRows(rows);
  const order = builtinOrder();
  const rank = (r) => (r.pack === BUILTIN_ELEMENT_PACK ? order.indexOf(r.type) : -1);
  const builtins = rows.filter((r) => rank(r) >= 0).sort((a, b) => rank(a) - rank(b));
  return [...builtins, ...rows.filter((r) => rank(r) < 0)];
}

const iconUrl = (type, mode) => `/api/toolbar/icon/${encodeURIComponent(type)}${mode === 'dark' ? '?mode=dark' : ''}`;

// One listed row ({type, pack, builtin, toolbar}: the registry's) and its
// pack's version → its tools[] entry, the readers' defaults applied. Exported
// for test-support/chrome-shell.js, whose default /api/toolbar answer is
// generated through it from the built-in element.json files.
function toolEntry(row, version) {
  const tb = isObject(row.toolbar) ? row.toolbar : {};
  const hotkeys = (Array.isArray(tb.hotkeys) ? tb.hotkeys : []).filter(isObject).map((h) => {
    const out = { action: h.action, label: h.label };
    const chord = h.default === undefined ? null : validChord(h.default);
    if (chord) out.default = chord;
    return out;
  });
  const settings = {};
  if (isObject(tb.settings)) for (const level of ['small', 'large']) if (isObject(tb.settings[level])) settings[level] = tb.settings[level];
  const icons = isObject(tb.icons) && typeof tb.icons.light === 'string' && typeof tb.icons.dark === 'string'
    ? { light: iconUrl(row.type, 'light'), dark: iconUrl(row.type, 'dark') } : null;
  return {
    type: row.type,
    label: typeof tb.label === 'string' && tb.label ? tb.label : upperFirst(row.type),
    pack: { name: row.pack, version: typeof version === 'string' ? version : null },
    builtin: row.builtin === true,
    icons,
    hotkeys,
    settings: Object.keys(settings).length ? settings : null,
    profiles: tb.profiles === true,
    input: typeof tb.input === 'string' ? tb.input : 'taps',
    installed: true,
  };
}

// tools[] for this daemon now.
function toolsOf(ctx) {
  const cache = new Map();
  const versions = (row) => {
    const key = `${row.tier}\u0000${row.pack}`;
    if (!cache.has(key)) {
      let v = null;
      try {
        const found = findPack(ctx.root, row.pack, row.tier);
        v = found && typeof found.pack.version === 'string' ? found.pack.version : null;
      } catch { v = null; }
      cache.set(key, v);
    }
    return cache.get(key);
  };
  return listedRows(ctx).map((row) => toolEntry(row, versions(row)));
}

// The default `pinned`: the built-in pack's listed types in manifest order,
// less the hidden ones.
function defaultPinned(ctx, hidden) {
  const off = new Set(hidden || []);
  return listedRows(ctx).filter((r) => r.pack === BUILTIN_ELEMENT_PACK && !off.has(r.type)).map((r) => r.type);
}

// A tool target in the merged view, with `installed`.
function withInstalled(target, listed) {
  if (!isObject(target) || target.kind !== 'tool') return target;
  return { ...target, installed: listed.has(target.type) };
}

// The served view: the default `pinned` applied to the project record when its
// file names none, and merged.bindings' tool targets marked `installed`.
function served(ctx, read) {
  const project = read.project.pinned
    ? read.project.record
    : { ...read.project.record, pinned: defaultPinned(ctx, read.project.record.hidden) };
  const v = view(project, read.user.record);
  const listed = new Set(listedRows(ctx).map((r) => r.type));
  const bindings = {};
  for (const chord of Object.keys(v.merged.bindings)) {
    const e = v.merged.bindings[chord];
    bindings[chord] = {
      ...e,
      value: withInstalled(e.value, listed),
      shadows: (e.shadows || []).map((s) => ({ ...s, value: withInstalled(s.value, listed) })),
    };
  }
  return { project: v.project, user: v.user, merged: { bindings, settings: v.merged.settings } };
}

// A listed type's settings schemas, or null (no row, or none declared).
function schemasOf(ctx, type) {
  const row = ctx.elementTypes && ctx.elementTypes.descriptor(type);
  if (!row) return null;
  const s = isObject(row.toolbar) && isObject(row.toolbar.settings) ? row.toolbar.settings : null;
  if (!s) return { row, levels: [] };
  return { row, levels: ['small', 'large'].map((l) => s[l]).filter(isObject) };
}

// A payload against small ∪ large: each key one of them declares, and valid
// against every one that declares it. → null, or {field, why}.
function payloadProblem(levels, payload, field) {
  for (const key of Object.keys(payload)) {
    const declaring = levels.filter((l) => isObject(l.properties) && Object.hasOwn(l.properties, key));
    if (!declaring.length) return { field: `${field}.${key}`, why: 'is not a setting this tool declares' };
    for (const level of declaring) {
      // That level's schema narrowed to this one key (a payload is partial:
      // the tiers merge it field by field, so `required` is not asked here).
      const { required: _all, ...root } = level;
      const r = checkValue({ ...root, properties: { [key]: level.properties[key] } }, { [key]: payload[key] });
      if (!r.ok) {
        const e = r.errors[0] || { path: key, why: 'is refused' };
        return { field: `${field}.${e.path || key}`, why: e.why };
      }
    }
  }
  return null;
}

// The manifest half of a PATCH's validation (after the record's own bounds).
// → null, or {field, why}.
function manifestProblem(ctx, patch) {
  if (!isObject(patch)) return null;
  if (isObject(patch.settings)) {
    for (const type of Object.keys(patch.settings)) {
      const s = schemasOf(ctx, type);
      if (!s || !s.levels.length || !isObject(patch.settings[type])) continue;
      const p = payloadProblem(s.levels, patch.settings[type], `settings.${type}`);
      if (p) return p;
    }
  }
  if (isObject(patch.profiles)) {
    for (const type of Object.keys(patch.profiles)) {
      const s = schemasOf(ctx, type);
      if (!s) continue;
      if (!(isObject(s.row.toolbar) && s.row.toolbar.profiles === true)) {
        return { field: `profiles.${type}`, why: `the tool '${type}' has no profiles (its element.json does not say profiles: true)` };
      }
      if (!s.levels.length || !Array.isArray(patch.profiles[type])) continue;
      for (let i = 0; i < patch.profiles[type].length; i++) {
        const prof = patch.profiles[type][i];
        if (!isObject(prof) || !isObject(prof.settings)) continue;
        const p = payloadProblem(s.levels, prof.settings, `profiles.${type}[${i}].settings`);
        if (p) return p;
      }
    }
  }
  return null;
}

// ── the icon route ───────────────────────────────────────────────────────────

class IconRefusal extends Error {
  constructor(status, why) { super(why); this.status = status; }
}

// The bytes and type of a listed type's icon, or an IconRefusal. The bytes
// come through lib/server/element-files readFenced — the one fenced read of a
// type's file (the fence, the no-link walk, the O_NOFOLLOW open, the cap and
// the recorded digests), worded as the icon's; the icons map, the image check
// and the name's format are this route's own.
function readIcon(ctx, row, mode) {
  const icons = isObject(row.toolbar) && isObject(row.toolbar.icons) ? row.toolbar.icons : null;
  const rel = icons && typeof icons[mode] === 'string' ? icons[mode] : null;
  if (!rel) throw new IconRefusal(404, `the tool '${row.type}' has no icon`);
  let bytes;
  try {
    ({ bytes } = readFenced(ctx, row, rel, IMAGE_MAX_BYTES, { noun: 'the icon', fileNoun: 'the icon file' }));
  } catch (e) {
    if (e instanceof TypeFileRefusal) throw new IconRefusal(e.status, e.why);
    throw e;
  }
  let ext;
  try { ext = validateImage(bytes); } catch (e) { throw new IconRefusal(403, `the icon is refused: ${(e && e.message) || e}`); }
  if (path.extname(rel).toLowerCase() !== `.${ext}`) throw new IconRefusal(403, `the icon is not the format its name says`);
  return { bytes, type: IMAGE_TYPES[ext] };
}

function bytesOf(v) {
  try { return Buffer.byteLength(JSON.stringify(v) || '', 'utf8'); } catch { return Infinity; }
}

function tooLarge(req) {
  const raw = req.headers['content-length'];
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw) && Number(raw) > TOOLBAR_BODY_MAX) return true;
  return bytesOf(req.body) > TOOLBAR_BODY_MAX;
}

function mountToolbarRoutes(app, ctx) {
  const levelOf = (req) => {
    try { return ctx.audience.levelOf(req); } catch { return 'basic'; }
  };
  const canWrite = (req) => {
    const level = levelOf(req);
    return level === 'local' || level === 'full';
  };
  // The daemon's own check behind the portal's PATCH row. Without an audience
  // (a server built without one) nothing remote is let through: narrower,
  // never wider.
  // Its words come from the one chooser: a viewer the hub relays is told in
  // the hub's (06 C-06.34a), anyone else in the tunnel's.
  const relayed = (req) => {
    try { return !!ctx.audience && typeof ctx.audience.peerOf === 'function' && ctx.audience.peerOf(req) === 'relayed'; } catch { return false; }
  };
  const fullOnly = ctx.audience && typeof ctx.audience.requireMirror === 'function'
    ? ctx.audience.requireMirror('full')
    : (req, res, next) => (levelOf(req) === 'local' ? next()
      : res.status(403).json({ ok: false, hint: hintFor('full', { connected: relayed(req) }) }));

  function current() {
    return { project: readTier(ctx, 'project'), user: readTier(ctx, 'user') };
  }

  // The view and what this requester may do with it.
  function answer(req, read) {
    const body = { ok: true, v: VERSION, ...served(ctx, read), tools: toolsOf(ctx) };
    body.canWrite = canWrite(req);
    body.canWriteUser = levelOf(req) === 'local';
    const corrupt = ['project', 'user'].filter((t) => read[t].corrupt);
    if (corrupt.length) body.corrupt = corrupt;
    const ignored = [
      ...read.project.ignored.map((f) => `project.${f}`),
      ...read.user.ignored.map((f) => `user.${f}`),
    ];
    if (ignored.length) body.ignored = ignored;
    return body;
  }

  function write(req, res, tier) {
    if (tooLarge(req)) {
      return res.status(413).json({ ok: false, error: `a toolbar patch is at most ${TOOLBAR_BODY_MAX} bytes`, field: '' });
    }
    const read = current();
    const now = read[tier];
    const patched = applyPatch(now.record, req.body, tier);
    if (!patched.ok) {
      return res.status(400).json({ ok: false, error: patched.why, field: patched.field });
    }
    const problem = manifestProblem(ctx, req.body);
    if (problem) return res.status(400).json({ ok: false, error: problem.why, field: problem.field });
    // The project's `pinned` stays absent on disk until a patch names it, so
    // the default keeps following the listing.
    const pinned = tier === 'project' ? (now.pinned || (isObject(req.body) && req.body.pinned !== undefined)) : false;
    let record = patched.record;
    if (tier === 'project' && !pinned) {
      const { pinned: _drop, ...rest } = record;
      record = rest;
    }
    const file = TIERS[tier].file(ctx);
    try {
      if (now.corrupt) renameAside(file, { tag: 'corrupt' });
      writeJsonAtomic(file, record);
    } catch (e) {
      return res.status(500).json({ ok: false, error: `the toolbar record could not be written: ${(e && e.message) || e}` });
    }
    const next = { ...read, [tier]: { record: patched.record, ignored: [], corrupt: false, absent: false, pinned } };
    ctx.bus.emit({ ws: { type: 'toolbar', v: VERSION, ...served(ctx, next) } });
    return res.json(answer(req, next));
  }

  app.get('/api/toolbar', (req, res) => {
    res.json(answer(req, current()));
  });

  app.patch('/api/toolbar', fullOnly, (req, res) => write(req, res, 'project'));

  // A listed type's icon, at every level (the toolbar draws it as an <img>).
  app.get('/api/toolbar/icon/:type', (req, res) => {
    const { type } = req.params;
    const mode = req.query.mode === undefined || req.query.mode === 'light' ? 'light'
      : req.query.mode === 'dark' ? 'dark' : null;
    if (!mode) return res.status(400).json({ ok: false, error: 'mode is light or dark' });
    const row = isSafeId(type) && ctx.elementTypes ? ctx.elementTypes.descriptor(type) : null;
    if (!row) return res.status(404).json({ ok: false, error: 'no listed tool by that name' });
    let icon;
    try {
      icon = readIcon(ctx, row, mode);
    } catch (e) {
      if (e instanceof IconRefusal) return res.status(e.status).json({ ok: false, error: e.message });
      return res.status(500).json({ ok: false, error: 'the icon could not be read' });
    }
    return sendImage(res, icon);
  });

  app.patch('/api/toolbar/user', (req, res) => {
    if (levelOf(req) !== 'local') return res.status(403).json({ ok: false, remote: true, hint: USER_HINT });
    return write(req, res, 'user');
  });
}

module.exports = { mountToolbarRoutes, toolEntry, toolRows, TOOLBAR_BODY_MAX };
