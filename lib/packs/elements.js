// What an element type is inside a pack — annotation engine tranche 2, U322
// (PLAN.md 2C.1, DECISIONS.md B1/B2, readiness R7 rows 1, 2, 5, 7 and 9).
//
// An element type is one directory of a pack, `elements/<type>/`:
//
//   element.json   the type's descriptor (below)
//   draw.js        the code that draws the type's elements — it runs in the
//                  chrome's own realm, which is why a pack that ships one
//                  installs only through review and approve (B1); required
//                  for every type but a built-in, whose draw code is the
//                  chrome's own
//   assets/**      optional files the type ships beside it
//
// This module is the pipeline's reader for that directory, the sibling of
// lib/packs/themes.js: the manifest asks it whether an element.json is sound,
// the element row of lib/packs/kinds.js asks it which files make up a unit and
// where they land. Pure reads — nothing here writes, which
// test/conventions.test.js holds it to (the pack orchestrator's zero-mutation
// row).
//
// element.json:
//
//   type     the type's name; must equal its directory's name. Checked, with
//            `family`, `remote` {see, send} and `private`, by
//            lib/core/element-policy validateDescriptor — the one descriptor
//            check, so a gate that would loosen the remote floor is refused in
//            that module's own words and no third type grammar is written here
//   schema   '<type>@<n>', n a positive integer: the schema the type writes
//   reads    the schemas its draw.js can draw, each '<type>@<n>'; defaults to
//            [schema] and must include it (C-5: a version whose schema is not
//            listed is parked, never handed to draw.js)
//   anchors  the anchor kinds the type accepts, a non-empty list from the
//            engine's vocabulary (element-policy ANCHOR_KINDS, decision C5).
//            The chat kinds (element-policy CHAT_ANCHOR_KINDS: turn, item,
//            item-range, diff-line) and the chat family go together: a
//            type's anchors are all chat kinds exactly when its family is
//            `chat`, and a mix is refused
//
// THE CHAT FAMILY IS THE BUILT-IN chat-comment's IN THIS BUILD (tranche 3,
// RULED U415@plugin-chat-family R3 = a; CHATFAM@refused a): a pack's type
// that declares family `chat` is refused, with a hint that plug-in chat types
// are not supported in this build. A narrowing, reversible: only the built-in
// pack (`builtin`) may declare it.
//
// The toolbar's fields (U335, PLAN.md 2D.5; DECISIONS.md I.6, K.2 items 1, 6,
// 7, 10, 16, 45, 46) — each optional, each checked by toolbarFields below and
// KEPT IN THE DESCRIPTOR AS WRITTEN (the element-type registry serves them as
// stored; a default below is the reader's to apply):
//
//   label        the toolbar's display name, 1–60 characters; absent, the
//                type name with its first letter upper-cased
//   icons        {light, dark}, both or neither: two relative paths inside the
//                type's directory (fenced, never a link), each a PNG or SVG
//                that lib/core/brand-image validate accepts (≤ 256 KB, an
//                active SVG refused — the one image check), square within
//                lib/core/icon SQUARE_TOLERANCE (lib/core/image-file
//                imageSize), a PNG at least icon TOOL_ICON_SIDE a side; the
//                name's .png / .svg says which. They install with the type
//                (elementFiles). Absent, the toolbar draws a generic glyph
//   settings     {small?, large?}: each a schema in lib/core/settings-schema's
//                subset (the form-renderer's), every string of it free of
//                control, bidi and invisible characters (lib/core/text)
//   hotkeys      at most 8 [{action, label, default?}]: action a kebab name
//                ≤ 40 (`arm` arms the tool), unique; label 1–60 characters;
//                default a chord lib/core/toolbar-record validChord accepts —
//                never ⌘/Ctrl, Alt, Escape or Tab — and no two the same
//   profiles     boolean, default false: named settings profiles (H-1 a)
//   input        'taps' | 'strokes' | 'selection' (INPUT_KINDS), default taps
//   wake         false | true | {coalesce?, respond?}, default false: the
//                type's shared elements raise the queue's element item
//                (K.2-10; U423, PLAN.md 3B.2). The object form declares how:
//                `coalesce` 'count' (the default: one queue item per (type,
//                origin pane) holding every member's id) or 'none' (one item
//                per element); `respond` (default false) marks a thread-
//                bearing type — a user's reply raises or refreshes its item,
//                Claude's raises nothing, and the delivery appends the
//                respond hint. `true` reads as {coalesce: 'count', respond:
//                false}, so a 0.8.x-era manifest keeps working. ONE reader,
//                wakeOf below; nothing else reads the field
//   summary_key  the payload field whose redacted text is that item's summary
//                (K.2-16), a settings-schema key
//   needs        {network?: 1–200 characters, key?: {name: kebab ≤ 40,
//                label: 1–60}} — validated; nothing in this build reads it
//   tool         another type's name (a kebab type name, never the type's
//                own): this type is ARMED BY THAT TYPE'S TOOL — it has no
//                toolbar slot, pin or hotkey of its own (lib/server/routes/
//                toolbar.js leaves it out of tools[] and the default pins
//                while the named type is listed). The built-in chat-comment
//                names `comment`: "the one Comment tool arms both" (RULED
//                CHAT@type a); the registry serves the field as stored, which
//                is how the chrome learns what a press of the armed tool
//                records in a chat host
//   place        'glyph' | 'box' (PLACE_MODES), default glyph (U516, plan
//                4A.2): 'box' sizes the type's marker to its element target's
//                rect (public/app/overlay.js's box placement), so it is
//                refused unless "anchors" includes 'element'
//   payload      {keys: [...], max_bytes?} (U513-U565@payload-decl a; U514):
//                the payload keys a pack's type writes, checked at review by
//                lib/core/element-log payloadDeclProblem (1 to 24 names,
//                `anchor` and `shared` among them, never the reserved `meta`;
//                max_bytes 1 to PLUGIN_PAYLOAD_MAX) — a malformed one fails
//                review naming the field; none passes with a warning (the type
//                draws but never writes). A built-in's element.json is not
//                checked for it (its schema is the log's own). The registry
//                reads it from the listed row's toolbar bag (registerSchema)
//
// THE DRAW MODULE (U512-U522@draw-module-contract a; U514). At review a
// pack's draw.js must carry the line `export default function draw(group,
// ctx)` (DRAW_HEAD, at the start of a line: the line a document's splice
// names, elements-doc-src MODULE_HEAD, held equal by a test), else review
// fails naming the file. Its text is read, never evaluated (B1).
//
// Every string here is DATA: whatever shows it puts it into the DOM as text.
// Any other key is KEPT in the descriptor and reported as a warning, never
// refused.
//
// Where installed types live: <tier>/element-types/<type>/
// (projectPaths().elementTypesDir, userPaths().elementTypesDir — ruling
// 2C@types-dir a). Never under the element log's directory
// (projectPaths().elementsDir holds log.jsonl and the boot reports): nothing a
// pack install plans, writes or removes is ever beside the log.

const fs = require('fs');
const path = require('path');
const { projectPaths, userPaths, fence } = require('../core/paths');
const { readJson } = require('../core/fsjson');
const { validateDescriptor, ANCHOR_KINDS, CHAT_ANCHOR_KINDS } = require('../core/element-policy');
const { parsePin, payloadDeclProblem } = require('../core/element-log');
const { validate: validateImage } = require('../core/brand-image');
const { imageSize } = require('../core/image-file');
const { SQUARE_TOLERANCE, TOOL_ICON_SIDE } = require('../core/icon');
const { validChord, LABEL_MAX } = require('../core/toolbar-record');
const { validateSchema, isKey } = require('../core/settings-schema');
const { hasForbidden } = require('../core/text');
const { isComponentName } = require('../core/names');

const ELEMENTS_DIR = 'elements';
const ELEMENT_FILE = 'element.json';
const DRAW_FILE = 'draw.js';
const ASSETS_DIR = 'assets';

// The keys this module reads. Everything else is kept and warned about.
const KNOWN_KEYS = Object.freeze(['type', 'family', 'remote', 'private', 'schema', 'reads', 'anchors']);
// The toolbar's fields (toolbarFields), kept as written — `payload` among
// them, so the registry's toolbar bag carries it; it is checked at review in
// validateElement (payloadDeclProblem), never by toolbarFields.
const TOOLBAR_KEYS = Object.freeze(['label', 'icons', 'settings', 'hotkeys', 'profiles', 'input', 'wake', 'summary_key', 'needs', 'tool', 'place', 'payload']);
// The chat family's name (element-policy ELEMENT_FAMILIES) and why a pack's
// type may not declare it in this build (R3 = a).
const CHAT_FAMILY = 'chat';
const CHAT_FAMILY_HINT = 'plug-in chat types are not supported in this build; only the built-in chat-comment is a chat type';
// A pack's payload declaration absent (U514): the review's warning.
const NO_PAYLOAD_WARNING = 'declares no payload: its type will draw but never write';
// The draw module's one line (U512-U522@draw-module-contract a): its default
// export is the function draw. A line of draw.js must start with DRAW_HEAD
// (leading blanks allowed); DRAW_LINE is the whole line the hint names.
const DRAW_HEAD = 'export default function draw(';
const DRAW_LINE = 'export default function draw(group, ctx)';
const DRAW_HEAD_RE = new RegExp(`^[ \\t]*${DRAW_HEAD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
// The one input-kind grammar (K.2-6): what a tool takes from a pointer.
const INPUT_KINDS = Object.freeze(['taps', 'strokes', 'selection']);
// The one placement grammar (U516, plan 4A.2): 'glyph' (the default, a marker
// at the anchor's top-left) or 'box' (the marker sized to an element target's
// rect, so only a type whose anchors include 'element' may ask for it). The
// overlay's registerType keeps its own copy (public/app/overlay.js
// PLACE_MODES), held equal by test/overlay-box-mode.test.js.
const PLACE_MODES = Object.freeze(['glyph', 'box']);
const HOTKEYS_MAX = 8;
const ACTION_MAX = 40;
const NETWORK_MAX = 200;
const KEY_NAME_MAX = 40;
// A type name's length (element-policy's TYPE_MAX; the grammar is the kebab one).
const TYPE_NAME_MAX = 40;
const ICON_PATH_MAX = 200;
const ICON_EXTS = Object.freeze(['png', 'svg']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A staged pack's element unit directory.
function elementSrcDir(stageDir, name) {
  return path.join(stageDir, ELEMENTS_DIR, name);
}

// The installed directory of a type, in a tier.
function elementDest(unit, tier, root) {
  const p = tier === 'system' ? userPaths() : projectPaths(root);
  return path.join(p.elementTypesDir, unit.name);
}

// A unit directory's element.json, read. Returns { ok: true, raw } or
// { ok: false, error } — absent, not JSON, or not an object, said plainly.
function readElementJson(dir) {
  const r = readJson(path.join(dir, ELEMENT_FILE));
  if (r.absent) return { ok: false, error: `${ELEMENT_FILE} is missing` };
  if (!r.ok) return { ok: false, error: `${ELEMENT_FILE} is not valid JSON` };
  if (!isObject(r.value)) return { ok: false, error: `${ELEMENT_FILE} is not a JSON object` };
  return { ok: true, raw: r.value };
}

// '<type>@<n>' → n, or null when the string is not that type's schema with a
// positive integer version. A schema name has the id@v shape, so it is read by
// the one id@v parser (element-log's parsePin: split at the last '@', a v that
// is not a positive safe integer written as its own decimal refused).
function schemaVersion(s, type) {
  if (typeof s !== 'string' || typeof type !== 'string') return null;
  const p = parsePin(s);
  return p && p.id === type ? p.v : null;
}

// Validate one element.json. NEVER throws for a content problem: returns
// { ok, errors, warnings, descriptor } with every problem at once, each
// message headed `element "<name>":`, the way validateManifest words a
// component's.
//
//   stageDir  the staged pack's root, or null (then draw.js is not looked for)
//   name      the unit's directory name — the identity the type must equal
//   builtin   the built-in pack's own types: no draw.js is required
//
// The descriptor is { ...every toolbar field and unknown key as written, type,
// family, remote, private, schema, reads, anchors }, or null when the
// element.json is refused. The icon files are looked at only from a stage
// (stageDir); without one, only their paths' shape is checked.
function validateElement(raw, { stageDir = null, name, builtin = false } = {}) {
  const errors = [];
  const warnings = [];
  const head = `element "${name}"`;
  if (!isObject(raw)) {
    return { ok: false, errors: [`${head}: ${ELEMENT_FILE} is not a JSON object`], warnings, descriptor: null };
  }

  if (raw.type !== name) {
    errors.push(`${head}: ${ELEMENT_FILE} says type ${JSON.stringify(raw.type === undefined ? null : raw.type)} — a type's name is its directory's name, "${name}"`);
  }
  let policy = null;
  try {
    policy = validateDescriptor({
      type: raw.type, family: raw.family, remote: raw.remote,
      ...('private' in raw ? { private: raw.private } : {}),
    });
  } catch (e) {
    errors.push(`${head}: ${e.message}`);
  }

  const type = typeof raw.type === 'string' ? raw.type : name;
  const schemaOk = schemaVersion(raw.schema, type) != null;
  if (!schemaOk) {
    errors.push(`${head}: "schema" must be "${type}@<n>", n a positive integer (got ${JSON.stringify(raw.schema === undefined ? null : raw.schema)})`);
  }

  let reads = raw.reads === undefined ? (schemaOk ? [raw.schema] : []) : raw.reads;
  if (!Array.isArray(reads) || !reads.length || !reads.every((r) => schemaVersion(r, type) != null)) {
    errors.push(`${head}: "reads" must be a non-empty list of "${type}@<n>" schemas (got ${JSON.stringify(raw.reads)})`);
    reads = [];
  } else {
    reads = [...new Set(reads)];
    if (schemaOk && !reads.includes(raw.schema)) {
      errors.push(`${head}: "reads" must include the type's own schema "${raw.schema}"`);
    }
  }

  let anchors = raw.anchors;
  if (!Array.isArray(anchors) || !anchors.length || !anchors.every((a) => ANCHOR_KINDS.includes(a))) {
    errors.push(`${head}: "anchors" must be a non-empty list from ${ANCHOR_KINDS.join(', ')} (got ${JSON.stringify(anchors === undefined ? null : anchors)})`);
    anchors = [];
  } else {
    anchors = [...new Set(anchors)];
    // The family and the anchors go together: all chat kinds iff family chat.
    const chatKinds = anchors.filter((a) => CHAT_ANCHOR_KINDS.includes(a));
    if (raw.family === CHAT_FAMILY && chatKinds.length !== anchors.length) {
      errors.push(`${head}: a chat-family type's "anchors" are chat kinds only (${CHAT_ANCHOR_KINDS.join(', ')}); got ${JSON.stringify(anchors)}`);
    } else if (raw.family !== CHAT_FAMILY && chatKinds.length) {
      errors.push(`${head}: "anchors" ${JSON.stringify(chatKinds)} are chat kinds, which only a chat-family type accepts (family is ${JSON.stringify(raw.family === undefined ? null : raw.family)})`);
    }
  }
  if (raw.family === CHAT_FAMILY && !builtin) {
    errors.push(`${head}: family "chat" is refused: ${CHAT_FAMILY_HINT}`);
  }

  if (stageDir && !builtin) {
    const drawAbs = path.join(elementSrcDir(stageDir, name), DRAW_FILE);
    const drawRel = `${ELEMENTS_DIR}/${name}/${DRAW_FILE}`;
    let isFile = false;
    try { isFile = fs.lstatSync(drawAbs).isFile(); } catch {}
    if (!isFile) errors.push(`${head}: ${drawRel} is missing`);
    else {
      // Its text, read and never evaluated (B1): the default export is the
      // function draw, on a line of its own (DRAW_HEAD).
      let text = null;
      try { text = fs.readFileSync(drawAbs, 'utf8'); } catch {}
      if (text == null) errors.push(`${head}: ${drawRel} cannot be read`);
      else if (!DRAW_HEAD_RE.test(text)) {
        errors.push(`${head}: ${drawRel}'s default export is not a function named draw — it needs the line \`${DRAW_LINE}\` (the function draw, as the default export)`);
      }
    }
    // The payload declaration, at review (a built-in's is never checked).
    if (Object.hasOwn(raw, 'payload') && raw.payload !== undefined) {
      const why = payloadDeclProblem(raw.payload, type);
      if (why) errors.push(`${head}: "payload" ${why}`);
    } else {
      warnings.push(`${head}: ${ELEMENT_FILE} ${NO_PAYLOAD_WARNING}`);
    }
  }

  const toolbar = toolbarFields(raw, stageDir ? elementSrcDir(stageDir, name) : null);
  for (const e of toolbar.errors) errors.push(`${head}: "${e.field}" ${e.why}`);

  const unknown = Object.keys(raw).filter((k) => !KNOWN_KEYS.includes(k) && !TOOLBAR_KEYS.includes(k));
  if (unknown.length) {
    warnings.push(`${head}: ${ELEMENT_FILE} carries ${unknown.join(', ')}, which this build does not check — kept as written`);
  }

  if (errors.length) return { ok: false, errors, warnings, descriptor: null };
  const extra = {};
  for (const k of Object.keys(raw)) if (!KNOWN_KEYS.includes(k)) extra[k] = raw[k];
  return {
    ok: true, errors, warnings,
    descriptor: {
      ...extra,
      type: policy.type, family: policy.family,
      remote: { see: policy.remote.see, send: policy.remote.send },
      private: policy.private,
      schema: raw.schema, reads, anchors,
    },
  };
}

// ── the toolbar's fields ────────────────────────────────────────────────────

const chars = (s) => [...s].length;

// A display string's problem, or null: a non-empty string of at most `max`
// characters with no control, bidi or invisible character (refused, never
// cleaned — the string is shown as written).
function textProblem(v, max) {
  if (typeof v !== 'string' || !v.trim()) return 'must be a non-empty string';
  if (chars(v) > max) return `at most ${max} characters`;
  if (hasForbidden(v)) return 'holds a control, bidi or invisible character';
  return null;
}

// An icon path's '/'-separated relative form, or null when its SHAPE is not a
// plain relative path inside a directory: a string of at most ICON_PATH_MAX
// characters, no backslash, not absolute, no empty, '.' or '..' segment, no
// forbidden character, ending in .png or .svg. Where it points is fence's.
function iconPath(p) {
  if (typeof p !== 'string' || !p || p.length > ICON_PATH_MAX || hasForbidden(p)) return null;
  if (p.includes('\\') || p.startsWith('/') || path.isAbsolute(p)) return null;
  const segs = p.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..')) return null;
  const ext = /\.([a-z]+)$/.exec(p);
  return ext && ICON_EXTS.includes(ext[1]) ? p : null;
}

// One icon's problem, or null. Without a type directory only the shape is
// checked (the registry reads an installed type its record already verified).
function iconProblem(p, typeDir) {
  const rel = iconPath(p);
  if (!rel) return `must be a relative path inside the type's directory, ending in ${ICON_EXTS.map((e) => `.${e}`).join(' or ')} (got ${JSON.stringify(p === undefined ? null : p)})`;
  if (!typeDir) return null;
  const abs = fence(typeDir, rel);
  if (!abs) return `${JSON.stringify(rel)} is outside the type's directory`;
  let st;
  try { st = fs.lstatSync(abs); } catch { return `${JSON.stringify(rel)} is missing`; }
  if (st.isSymbolicLink()) return `${JSON.stringify(rel)} is a link — an icon is a file in the type's directory`;
  if (!st.isFile()) return `${JSON.stringify(rel)} is not a file`;
  let bytes;
  try { bytes = fs.readFileSync(abs); } catch { return `${JSON.stringify(rel)} cannot be read`; }
  let ext;
  try { ext = validateImage(bytes); } catch (e) { return `${JSON.stringify(rel)}: ${e.message}`; }
  if (!rel.endsWith(`.${ext}`)) return `${JSON.stringify(rel)} is not ${ext === 'svg' ? 'a PNG' : 'an SVG'} (the bytes are ${ext === 'svg' ? 'an SVG' : 'a PNG'})`;
  const size = imageSize(bytes);
  if (!size) return `${JSON.stringify(rel)}: its size cannot be read (an SVG needs a viewBox)`;
  const { width, height } = size;
  if (Math.abs(width - height) > SQUARE_TOLERANCE * Math.max(width, height)) {
    return `${JSON.stringify(rel)} is ${width}×${height}: a tool's icon is square`;
  }
  if (ext === 'png' && Math.min(width, height) < TOOL_ICON_SIDE) {
    return `${JSON.stringify(rel)} is ${width}×${height}: a PNG icon is at least ${TOOL_ICON_SIDE} px a side`;
  }
  return null;
}

// Every string a settings schema shows (titles, descriptions, enum and default
// strings), with its field — settings-schema imports nothing, so the
// forbidden-character half of its check is the caller's, here.
function schemaStrings(schema, field) {
  const out = [];
  if (!isObject(schema) || !isObject(schema.properties)) return out;
  for (const [k, spec] of Object.entries(schema.properties)) {
    if (!isObject(spec)) continue;
    const at = `${field}.properties.${k}`;
    for (const f of ['title', 'description', 'default']) if (typeof spec[f] === 'string') out.push([`${at}.${f}`, spec[f]]);
    if (Array.isArray(spec.enum)) spec.enum.forEach((v, i) => { if (typeof v === 'string') out.push([`${at}.enum.${i}`, v]); });
  }
  return out;
}

// Validate an element.json's toolbar fields (above). Returns { ok, errors:
// [{field, why}] }, every problem at once, each naming its field. `typeDir` is
// the type's own directory (a stage's), where the icon files are looked at;
// null checks their paths' shape only. Never throws for a content problem.
function toolbarFields(json, typeDir) {
  const errors = [];
  const bad = (field, why) => errors.push({ field, why });
  const raw = isObject(json) ? json : {};
  const has = (k) => Object.hasOwn(raw, k) && raw[k] !== undefined;

  if (has('label')) {
    const why = textProblem(raw.label, LABEL_MAX);
    if (why) bad('label', why);
  }

  if (has('icons')) {
    const icons = raw.icons;
    if (!isObject(icons)) bad('icons', 'must be {light, dark}');
    else {
      for (const k of Object.keys(icons)) if (k !== 'light' && k !== 'dark') bad(`icons.${k}`, 'is not an icon mode (light, dark)');
      for (const mode of ['light', 'dark']) {
        if (icons[mode] === undefined) { bad(`icons.${mode}`, 'is missing: a type ships both icons or neither'); continue; }
        const why = iconProblem(icons[mode], typeDir);
        if (why) bad(`icons.${mode}`, why);
      }
    }
  }

  if (has('settings')) {
    const settings = raw.settings;
    if (!isObject(settings)) bad('settings', 'must be {small?, large?}');
    else {
      for (const k of Object.keys(settings)) if (k !== 'small' && k !== 'large') bad(`settings.${k}`, 'is not a settings level (small, large)');
      for (const level of ['small', 'large']) {
        if (settings[level] === undefined) continue;
        const v = validateSchema(settings[level]);
        for (const e of v.errors) bad(e.path ? `settings.${level}.${e.path}` : `settings.${level}`, e.why);
        for (const [field, s] of schemaStrings(settings[level], `settings.${level}`)) {
          if (hasForbidden(s)) bad(field, 'holds a control, bidi or invisible character');
        }
      }
    }
  }

  if (has('hotkeys')) {
    const hotkeys = raw.hotkeys;
    if (!Array.isArray(hotkeys)) bad('hotkeys', 'must be a list of {action, label, default?}');
    else {
      if (hotkeys.length > HOTKEYS_MAX) bad('hotkeys', `at most ${HOTKEYS_MAX} (got ${hotkeys.length})`);
      const actions = new Set();
      const chords = new Set();
      hotkeys.forEach((h, i) => {
        const at = `hotkeys.${i}`;
        if (!isObject(h)) { bad(at, 'must be {action, label, default?}'); return; }
        for (const k of Object.keys(h)) if (!['action', 'label', 'default'].includes(k)) bad(`${at}.${k}`, 'is not a hotkey field (action, label, default)');
        if (!isComponentName(h.action) || h.action.length > ACTION_MAX) {
          bad(`${at}.action`, `must be a kebab-case name of at most ${ACTION_MAX} characters (got ${JSON.stringify(h.action === undefined ? null : h.action)})`);
        } else if (actions.has(h.action)) bad(`${at}.action`, `"${h.action}" is listed twice`);
        else actions.add(h.action);
        const why = textProblem(h.label, LABEL_MAX);
        if (why) bad(`${at}.label`, why);
        if (h.default !== undefined) {
          const chord = validChord(h.default);
          if (!chord) bad(`${at}.default`, `${JSON.stringify(h.default)} is not a chord a tool may default to: [Shift+]<key>, never ⌘/Ctrl, Alt, Escape or Tab`);
          else if (chords.has(chord)) bad(`${at}.default`, `${chord} is already another action's default`);
          else chords.add(chord);
        }
      });
    }
  }

  if (has('profiles') && typeof raw.profiles !== 'boolean') bad('profiles', `must be true or false (got ${JSON.stringify(raw.profiles)})`);
  if (has('wake')) for (const e of wakeProblems(raw.wake)) bad(e.field, e.why);

  if (has('input') && !INPUT_KINDS.includes(raw.input)) {
    bad('input', `must be one of ${INPUT_KINDS.join(', ')} (got ${JSON.stringify(raw.input)})`);
  }

  if (has('place')) {
    if (!PLACE_MODES.includes(raw.place)) {
      bad('place', `must be one of ${PLACE_MODES.join(', ')} (got ${JSON.stringify(raw.place)})`);
    } else if (raw.place === 'box' && !(Array.isArray(raw.anchors) && raw.anchors.includes('element'))) {
      bad('place', `"box" sizes the marker to an element target, so the type's "anchors" must include "element" (got ${JSON.stringify(raw.anchors === undefined ? null : raw.anchors)})`);
    }
  }

  if (has('summary_key') && !isKey(raw.summary_key)) {
    bad('summary_key', `must name a payload field: a letter then up to 39 letters, digits or _ (got ${JSON.stringify(raw.summary_key)})`);
  }

  if (has('tool')) {
    if (typeof raw.tool !== 'string' || !isComponentName(raw.tool) || raw.tool.length > TYPE_NAME_MAX) {
      bad('tool', `must name another element type: a kebab-case name of at most ${TYPE_NAME_MAX} characters (got ${JSON.stringify(raw.tool)})`);
    } else if (raw.tool === raw.type) {
      bad('tool', `names the type itself ("${raw.tool}"): a type with a tool of its own leaves "tool" out`);
    }
  }

  if (has('needs')) {
    const needs = raw.needs;
    if (!isObject(needs)) bad('needs', 'must be {network?, key?}');
    else {
      for (const k of Object.keys(needs)) if (k !== 'network' && k !== 'key') bad(`needs.${k}`, 'is not a need (network, key)');
      if (needs.network !== undefined) {
        const why = textProblem(needs.network, NETWORK_MAX);
        if (why) bad('needs.network', why);
      }
      if (needs.key !== undefined) {
        const key = needs.key;
        if (!isObject(key)) bad('needs.key', 'must be {name, label}');
        else {
          for (const k of Object.keys(key)) if (k !== 'name' && k !== 'label') bad(`needs.key.${k}`, 'is not a key field (name, label)');
          if (!isComponentName(key.name) || key.name.length > KEY_NAME_MAX) {
            bad('needs.key.name', `must be a kebab-case name of at most ${KEY_NAME_MAX} characters`);
          }
          const why = textProblem(key.label, LABEL_MAX);
          if (why) bad('needs.key.label', why);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// The wake declaration's grammar (above): its problems, each naming its
// field ('wake' or 'wake.<key>'); [] when it is sound.
const WAKE_KEYS = Object.freeze(['coalesce', 'respond']);
const WAKE_COALESCE = Object.freeze(['count', 'none']);
function wakeProblems(w) {
  if (typeof w === 'boolean') return [];
  if (!isObject(w)) return [{ field: 'wake', why: `must be true, false or {coalesce?, respond?} (got ${JSON.stringify(w)})` }];
  const out = [];
  for (const k of Object.keys(w)) if (!WAKE_KEYS.includes(k)) out.push({ field: `wake.${k}`, why: `is not a wake field (${WAKE_KEYS.join(', ')})` });
  if (w.coalesce !== undefined && !WAKE_COALESCE.includes(w.coalesce)) {
    out.push({ field: 'wake.coalesce', why: `must be one of ${WAKE_COALESCE.join(', ')} (got ${JSON.stringify(w.coalesce)})` });
  }
  if (w.respond !== undefined && typeof w.respond !== 'boolean') {
    out.push({ field: 'wake.respond', why: `must be true or false (got ${JSON.stringify(w.respond)})` });
  }
  return out;
}

// THE ONE READER of a type's `wake` (U423): a descriptor ({toolbar: {wake}}),
// its toolbar ({wake}) or element.json's raw object → null when the type
// raises no queue item (absent, false, or a declaration the grammar refuses),
// else {coalesce: 'count' | 'none', respond: boolean}, with the defaults
// applied (`true` → {coalesce: 'count', respond: false}). Pure; never throws.
function wakeOf(source) {
  if (!isObject(source)) return null;
  const tb = isObject(source.toolbar) ? source.toolbar : source;
  const w = tb.wake;
  if (w === true) return { coalesce: 'count', respond: false };
  if (!isObject(w) || wakeProblems(w).length) return null;
  return { coalesce: w.coalesce === 'none' ? 'none' : 'count', respond: w.respond === true };
}

// The relative paths of one staged element unit's files, in a stable order:
// element.json, draw.js, the icon files element.json names (light, then dark;
// K.2-45), then every regular file under assets/ (sorted, depth first).
// Anything else in the directory is not part of the unit and does not install.
// An icon path is taken only when its shape is sound (iconPath), it is fenced
// inside the directory and lstat says it is a regular file; whether it is a
// sound icon — and a refusal when it is missing or outside — is
// toolbarFields'. Symlinks are never followed (the fetch gate refused them
// already).
function elementFiles(srcDir) {
  const out = [];
  for (const f of [ELEMENT_FILE, DRAW_FILE]) {
    try { if (fs.lstatSync(path.join(srcDir, f)).isFile()) out.push(f); } catch {}
  }
  const read = readElementJson(srcDir);
  const icons = read.ok && isObject(read.raw.icons) ? read.raw.icons : {};
  for (const p of [icons.light, icons.dark]) {
    const rel = iconPath(p);
    if (!rel || out.includes(rel) || rel.startsWith(`${ASSETS_DIR}/`)) continue;
    const abs = fence(srcDir, rel);
    try { if (abs && fs.lstatSync(abs).isFile()) out.push(rel); } catch {}
  }
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(path.relative(srcDir, abs).split(path.sep).join('/'));
    }
  };
  walk(path.join(srcDir, ASSETS_DIR));
  return out;
}

module.exports = {
  ELEMENTS_DIR,
  ELEMENT_FILE,
  DRAW_FILE,
  ASSETS_DIR,
  KNOWN_KEYS,
  TOOLBAR_KEYS,
  INPUT_KINDS,
  PLACE_MODES,
  HOTKEYS_MAX,
  CHAT_FAMILY_HINT,
  NO_PAYLOAD_WARNING,
  DRAW_HEAD,
  DRAW_LINE,
  elementSrcDir,
  elementDest,
  readElementJson,
  validateElement,
  toolbarFields,
  elementFiles,
  wakeOf,
  WAKE_KEYS,
  WAKE_COALESCE,
};
