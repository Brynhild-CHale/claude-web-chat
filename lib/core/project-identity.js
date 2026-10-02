// lib/core/project-identity.js — a project's identity: its display name, its
// images, and whether the name shows beside its logo.
//
// The topbar's co-brand lockup draws the project half of itself from this:
// the project's logo, then its name (the folder's, until one is set). The tab's
// favicon and the phone's mark are the project's square image. The identity is
// set from the host — the `claude-web-chat identity` CLI and the
// `project-identity` skill, through the daemon's /api/project routes when one
// runs and straight through this module when none does — so it lives in
// lib/core, where the daemon and the CLI can both reach it. (The company logo
// left of the lockup's divider is the THEME's, lib/server/brand.js; a theme
// pack can never ship a project image, because these are not brand slots.)
//
// On disk, under .web-chat/ (lib/core/paths):
//
//   project.json             { "name": "Acme Web", "show_name": false } — both
//                            keys optional, 2-space indent, trailing newline;
//                            absent means the defaults
//   project-logo             the lockup's logo, any shape
//   project-logo-dark        its dark variant
//   project-favicon          a square image: the tab's favicon
//   project-favicon-dark     its dark variant
//   project-touch-icon       the home-screen icon: a square PNG on an opaque
//                            tile, the same in both schemes (no dark variant)
//
// Each image is `<name>.svg` or `<name>.png`, one file, kept by
// lib/core/image-file: validated when written, re-checked when read, never a
// symlink and never written through one.
//
// ALL OF IT IS PROJECT-TIER, SO A REPOSITORY CAN SHIP IT — and therefore all of
// it is DISPLAY-ONLY BY CONTRACT. Nothing reads a setting that widens access
// from project.json, ever: the mirror's remote opt-in, service trust, tunnel
// exposure all live in the user tier. This module reads two keys, `name` and
// `show_name`, and hands out only what the lockup draws; a key it does not know
// is kept across a save (a newer build's display setting survives an older
// build's write) and never interpreted. The name is display text only: it is
// never a path, a registry key or a URL segment.
//
// THE RULES, which a write enforces and a read re-applies to whatever is on
// disk (a committed .web-chat/ is whatever the repository says it is):
//
//   name        1–64 code points after NFC, trimming and collapsing whitespace;
//               refused (400) when it holds a control, bidi or invisible
//               character (lib/core/text hasForbidden) — refused, not cleaned;
//               the joiner and variation selectors emoji need are allowed.
//               Empty resets to the folder's name.
//   favicon,    square: width and height within 2 % (422). An SVG must say its
//   touch       size in a viewBox. A touch icon is a PNG (415).
//   dark        optional, one per light image (logo, favicon), and only beside
//   variants    it: none without its light image (409), and of the same shape —
//               aspect ratios within 2 % (422) — so the mark (below) never
//               changes between modes. Removing a light image removes its dark
//               variant; replacing it with different bytes does too, because a
//               dark variant was made for the image it sat beside.
//
// The MARK, what the phone's lockup and the tab's favicon draw, is D11's rule
// for a square image: the favicon when one is set, else the logo when it is
// square, else none. Which variant shows is the reader's choice, never this
// module's: the topbar asks by web-chat's own mode, the favicon by the
// browser's scheme. readImage(…, {dark}) answers with the dark variant when
// there is one and the light image otherwise.
//
// A corrupt or wrong-shaped project.json — unreadable, not a JSON object, a
// symlink, oversized, or a name or show_name a setter would refuse — reads as
// the defaults with `corrupt: true` (`identity show` reports it), and the next
// save replaces it.
//
// Imports only lib/core (paths, fsjson, image-file, brand-image, text) and Node
// built-ins.

const fs = require('fs');
const path = require('path');
const { projectPaths } = require('./paths');
const { readJson, writeJsonAtomic } = require('./fsjson');
const { imageFile, imageSize } = require('./image-file');
const { BrandError, TYPES, validate } = require('./brand-image');
const { hasForbidden, stripControls } = require('./text');

const NAME_MAX = 64;

// project.json holds a name and a flag; a file far bigger than that is not one.
const RECORD_MAX = 64 * 1024;

// How far apart two shapes may be and still count as one: a square's width and
// height, or a dark variant's aspect ratio and its light image's, within 2 %.
const SHAPE_TOLERANCE = 0.02;

class ProjectError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ProjectError';
    this.status = status;
  }
}

// The images, by the kind a caller names: where each lives (a projectPaths
// key), the identity field it reports as, its dark variant or the light image
// it is a variant of, and whether it must be square or a PNG. Lights first:
// a dark variant is judged against its light image.
const IMAGES = Object.freeze({
  logo: Object.freeze({ field: 'logo', base: 'projectLogo', dark: 'logo-dark' }),
  favicon: Object.freeze({ field: 'favicon', base: 'projectFavicon', dark: 'favicon-dark', square: true }),
  touch: Object.freeze({ field: 'touch', base: 'projectTouchIcon', square: true, png: true }),
  'logo-dark': Object.freeze({ field: 'logo_dark', base: 'projectLogoDark', light: 'logo' }),
  'favicon-dark': Object.freeze({ field: 'favicon_dark', base: 'projectFaviconDark', light: 'favicon', square: true }),
});

// The kinds writeImage and removeImage take, each with the identity field (and
// the `project` event's `field`) it changes.
const IMAGE_FIELDS = Object.freeze(Object.fromEntries(Object.entries(IMAGES).map(([k, v]) => [k, v.field])));

// The kinds readImage serves: the three images and the mark.
const READ_KINDS = Object.freeze(['logo', 'favicon', 'touch', 'mark']);

// ── the name ────────────────────────────────────────────────────────────────

// The folder's name, as the identity shows it when none is set: NFC, with any
// control, bidi or invisible character taken out (a folder may be called
// anything; the lockup may not show anything), else 'web-chat'.
function defaultName(root) {
  return stripControls(path.basename(path.resolve(root)).normalize('NFC')) || 'web-chat';
}

// A name as a setter receives it → { name } or { reset: true }. NFC, then the
// refusal, then trimming and collapsing whitespace; nothing left (or null)
// resets to the folder's name. Throws ProjectError(400).
function normalizeName(input) {
  if (input === null || input === undefined) return { reset: true };
  if (typeof input !== 'string') throw new ProjectError(400, 'the name must be a string');
  const nfc = input.normalize('NFC');
  if (hasForbidden(nfc)) {
    throw new ProjectError(400, 'the name may not contain control, bidirectional or invisible characters (a line break or a tab among them)');
  }
  const name = nfc.trim().replace(/\s+/g, ' ');
  if (!name) return { reset: true };
  const length = [...name].length;
  if (length > NAME_MAX) throw new ProjectError(400, `the name is ${length} characters; the limit is ${NAME_MAX}`);
  return { name };
}

// ── project.json ────────────────────────────────────────────────────────────

// The record as { name?, show_name?, raw?, corrupt? }: `raw` is the parsed
// object a save starts from, so the keys it does not know survive the save.
function readRecord(root) {
  const file = projectPaths(root).projectJson;
  let st;
  try { st = fs.lstatSync(file); } catch (e) {
    return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? {} : { corrupt: true };
  }
  // A link is not followed (it could point at any JSON the user can read, and
  // the name is shown remotely); a directory, a device or a huge file is not
  // a record.
  if (!st.isFile() || st.size > RECORD_MAX) return { corrupt: true };
  const r = readJson(file);
  if (r.absent) return {};
  if (!r.ok) return { corrupt: true };
  const v = r.value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { corrupt: true };
  const out = { raw: v };
  if (v.name !== undefined && v.name !== null) {
    let n;
    try { n = normalizeName(v.name); } catch { return { corrupt: true }; }
    if (n.name) out.name = n.name;
  }
  if (v.show_name !== undefined && v.show_name !== null) {
    if (typeof v.show_name !== 'boolean') return { corrupt: true };
    out.show_name = v.show_name;
  }
  return out;
}

// Read, change, and save only if something changed. A corrupt record is
// replaced. A record left with no keys is no file at all — absent means the
// defaults — and unlink removes a link there, never its target.
function updateRecord(root, change) {
  const rec = readRecord(root);
  const before = rec.corrupt ? null : (rec.raw || {});
  const next = { ...(before || {}) };
  change(next);
  if (before && JSON.stringify(next) === JSON.stringify(before)) return rec;
  const pp = projectPaths(root);
  if (!Object.keys(next).length) {
    let st;
    try { st = fs.lstatSync(pp.projectJson); } catch { return rec; }
    if (!st.isDirectory()) fs.unlinkSync(pp.projectJson);
    return rec;
  }
  requireProject(root);
  writeJsonAtomic(pp.projectJson, next, { pretty: 2, newline: true, mkdir: false });
  return rec;
}

// A write never makes .web-chat/ itself: a folder without one is not a
// project, and writing the identity into it would make it look like one.
function requireProject(root) {
  const { dir } = projectPaths(root);
  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch {}
  if (!isDir) throw new ProjectError(404, `${path.resolve(root)} is not a web-chat project (it has no .web-chat/)`);
}

// ── images ──────────────────────────────────────────────────────────────────

function store(root, kind) {
  const abs = path.resolve(root);
  return imageFile(abs, projectPaths(abs)[IMAGES[kind].base]);
}

const sameShape = (a, b) => Math.abs(a - b) <= SHAPE_TOLERANCE * Math.max(a, b);
const sized = (s) => Boolean(s) && s.width > 0 && s.height > 0;
const isSquare = (s) => sized(s) && sameShape(s.width, s.height);
const sameAspect = (a, b) => sized(a) && sized(b) && sameShape(a.width / a.height, b.width / b.height);
const dims = (s) => `${s.width}x${s.height}`;

// Every image's metadata as the identity reports it — { kind: ImageMeta |
// null } — with the write rules applied to what is on disk: a favicon or a
// touch icon that is not square, a touch icon that is not a PNG, and a dark
// variant with no light image or not of its shape all read as unset.
function metas(root) {
  const out = {};
  for (const [kind, spec] of Object.entries(IMAGES)) {
    let m = store(root, kind).meta();
    if (m && spec.png && m.type !== TYPES.png) m = null;
    if (m && spec.square && !isSquare(m)) m = null;
    if (m && spec.light && !sameAspect(m, out[spec.light])) m = null;
    out[kind] = m;
  }
  return out;
}

// The mark: the favicon when one is set, else the logo when it is square.
function markOf(m) {
  if (m.favicon) return 'favicon';
  if (m.logo && isSquare(m.logo)) return 'logo';
  return null;
}

// A BrandError from validate() or the image store, as a ProjectError.
function asProjectError(fn) {
  try { return fn(); } catch (e) {
    if (e instanceof BrandError) throw new ProjectError(e.status, e.message);
    throw e;
  }
}

function kindOf(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(IMAGES, kind)) {
    throw new ProjectError(400, `unknown project image '${kind}' (one of ${Object.keys(IMAGES).join(', ')})`);
  }
  return IMAGES[kind];
}

// ── the identity ────────────────────────────────────────────────────────────

// { name, default_name, custom, show_name, logo, logo_dark, favicon,
//   favicon_dark, touch, mark, mark_dark, corrupt? }. Each image is
// { type, bytes, version, width, height } or null; `custom` says a name is set;
// `mark` is 'favicon', 'logo' or null, and `mark_dark` whether the mark's
// image has a dark variant.
function identity(root) {
  const rec = readRecord(root);
  const m = metas(root);
  const mark = markOf(m);
  const defaultTitle = defaultName(root);
  const out = {
    name: rec.name || defaultTitle,
    default_name: defaultTitle,
    custom: Boolean(rec.name),
    show_name: rec.show_name !== false,
    logo: m.logo,
    logo_dark: m['logo-dark'],
    favicon: m.favicon,
    favicon_dark: m['favicon-dark'],
    touch: m.touch,
    mark,
    mark_dark: Boolean(mark && m[IMAGES[mark].dark]),
  };
  if (rec.corrupt) out.corrupt = true;
  return out;
}

// Set the display name; an empty one (or null) resets it. Keeps every other
// key of project.json. → identity. Throws ProjectError(400).
function setName(root, input) {
  const n = normalizeName(input);
  if (n.reset) return resetName(root).identity;
  updateRecord(root, (rec) => { rec.name = n.name; });
  return identity(root);
}

// Back to the folder's name. project.json goes when nothing else is left in it.
// → { removed: whether a name was set, identity }.
function resetName(root) {
  const rec = updateRecord(root, (r) => { delete r.name; });
  return { removed: Boolean(rec.name), identity: identity(root) };
}

// Whether the name shows beside the logo (off for a wordmark that already spells
// it). On is the default, so it is stored only when off. → identity.
function setShowName(root, show) {
  if (typeof show !== 'boolean') throw new ProjectError(400, 'show_name is true or false');
  updateRecord(root, (rec) => {
    if (show) delete rec.show_name;
    else rec.show_name = false;
  });
  return identity(root);
}

// Store one image. → { type, bytes, dark_removed, identity }; `dark_removed`
// says a light image's replacement took its old dark variant with it. Throws
// ProjectError: 400 empty or an unknown kind, 413 too big, 415 not PNG or SVG
// (a touch icon: not PNG), 422 an active SVG, a favicon or touch icon that is
// not square, or a dark variant not of its light image's shape, 409 a dark
// variant with no light image, 404 a folder with no .web-chat/.
function writeImage(root, kind, bytes) {
  const spec = kindOf(kind);
  const ext = asProjectError(() => validate(bytes));
  if (spec.png && ext !== 'png') throw new ProjectError(415, 'a touch icon must be a PNG: it sits on an opaque tile on the home screen');
  const size = imageSize(bytes);
  const what = spec.light ? `a dark ${spec.light}` : kind === 'touch' ? 'a touch icon' : `a ${kind}`;
  if (spec.square && !isSquare(size)) {
    throw new ProjectError(422, sized(size)
      ? `${what} must be square (width and height within 2%): this image is ${dims(size)}`
      : `${what} must be square, and this SVG has no viewBox to tell its shape by`);
  }
  if (spec.light) {
    const light = metas(root)[spec.light];
    if (!light) throw new ProjectError(409, `there is no ${spec.light} to be the dark variant of: set the ${spec.light} first`);
    if (!sameAspect(size, light)) {
      throw new ProjectError(422, sized(size) && sized(light)
        ? `${what} must have the ${spec.light}'s shape (aspect within 2%): the ${spec.light} is ${dims(light)}, this image is ${dims(size)}`
        : `${what} must have the ${spec.light}'s shape, and an SVG without a viewBox has none to compare`);
    }
  }
  requireProject(root);
  const img = store(root, kind);
  // A dark variant was made for the light image it sat beside: replacing that
  // image with different bytes takes the variant with it.
  const before = spec.dark ? img.read() : null;
  const r = asProjectError(() => img.write(bytes));
  const darkRemoved = spec.dark && !(before && before.bytes.equals(bytes)) ? store(root, spec.dark).remove() : false;
  return { type: r.type, bytes: r.bytes, dark_removed: darkRemoved, identity: identity(root) };
}

// Remove one image; a light image's dark variant goes with it.
// → { removed, identity }.
function removeImage(root, kind) {
  const spec = kindOf(kind);
  let removed = store(root, kind).remove();
  if (spec.dark && store(root, spec.dark).remove()) removed = true;
  return { removed, identity: identity(root) };
}

// The bytes to serve for 'logo', 'favicon', 'touch' or 'mark' (the favicon or
// the square logo, by the mark rule) → { bytes, type } or null. With `dark`,
// that image's dark variant when one is set, else the light image: which mode
// to ask for is the caller's (the topbar's mode, the browser's scheme).
function readImage(root, kind, { dark = false } = {}) {
  if (!READ_KINDS.includes(kind)) return null;
  const m = metas(root);
  const light = kind === 'mark' ? markOf(m) : kind;
  if (!light || !m[light]) return null;
  const variant = dark ? IMAGES[light].dark : null;
  if (variant && m[variant]) {
    const r = store(root, variant).read();
    if (r) return r;
  }
  return store(root, light).read();
}

// The `project` frame every viewer is sent when the identity changes.
function frame(root) {
  return { type: 'project', identity: identity(root) };
}

module.exports = {
  NAME_MAX, ProjectError, IMAGE_FIELDS, READ_KINDS,
  defaultName, normalizeName, identity, setName, resetName, setShowName,
  writeImage, removeImage, readImage, frame,
};
