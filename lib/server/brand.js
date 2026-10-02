const fs = require('fs');
const path = require('path');
const { projectPaths, userPaths, fence } = require('../core/paths');
const { isComponentName } = require('../core/names');
const { projectTheme, globalThemeFiles } = require('../core/theme-identity');
const { EXTS, isSlot, slotFile } = require('../core/brand-store');
const { resolveDefault, appliedBuiltin, isBuiltinName, getBuiltin } = require('./theme');
const { FILL_PACKS, LOGOS_README } = require('../setup/theme-logos');

// ---------------------------------------------------------------------------
// Brand images, kept per THEME.
//
// Three fixed SLOTS: the `logotype` the topbar shows beside the wordmark, and
// the `lockup` and `seal` an exported page carries in its header and footer.
// An image belongs to the theme that was the project's GLOBAL theme when it was
// added, and is kept with it: .web-chat/brand/themes/<key>/<slot>.<ext>, the
// <key> being that theme's (lib/core/theme-identity — a builtin's pack id, a
// theme's own kebab-case name, or a fixed or hashed stand-in for a name that
// cannot be a directory; lib/core/brand-store resolves the path). So switching
// the global theme shows THAT theme's images — or, for a slot it has none in,
// its logo fill (below) — and switching back brings the first theme's back.
// Every function here works on the CURRENT global theme's images; themeOf(root)
// says which theme that is. (Before state schema v3 the slots sat directly in
// .web-chat/brand/; the v2→v3 migration moved them into the bucket of the theme
// the project was on.)
//
// SVG or PNG, nothing else, decided by SNIFFING the bytes — never by a filename
// or a Content-Type a caller chose. Two layers keep an SVG inert:
//
//   1. write() refuses one that carries anything active (a <script> or a
//      <foreignObject> under any prefix, an on*= handler, a javascript: url,
//      an entity declaration, a foreign namespace — the full list is in
//      lib/core/brand-image.js). Refusing beats rewriting: a sanitiser that
//      edits markup is a parser we would have to get exactly right, and a
//      logo has no business with any of it.
//   2. Nothing ever inlines the markup into a document. The chrome loads a slot
//      through <img src="/brand/<slot>"> and an export through an <img> data:
//      URI — an image context runs no script and fetches nothing. The one way to
//      open the file AS a document is to navigate to /brand/<slot>, and that
//      response carries BRAND_CSP + nosniff (routes/brand.js).
//
// The slot name is the only thing a caller hands us that becomes a path, and it
// is looked up in SLOTS, never joined; the theme key is derived here, never
// taken from a request, and is one safe path segment by construction. `fence`
// then refuses a slot file reached through a symlink pointing out of .web-chat/.
// ---------------------------------------------------------------------------

// The slots, the size limit, the formats, the sniffer and the one image check
// live in lib/core/brand-image.js — a theme pack's logos are validated with the
// same check at install time, from lib/packs, which may not import this file.
const {
  SLOTS, MAX_BYTES, TYPES, BrandError, sniff, svgRefusal, validate, parseLogoName, validateLogoFile,
} = require('../core/brand-image');

// What a response serving a slot is allowed to do if someone opens it as a
// document: nothing. An SVG's own <style> is the one thing it may keep.
const BRAND_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

// The theme the brand images are kept under right now — the project's global
// theme — as { key, name, title }: `title` is a builtin pack's display name
// (null for any other theme), and `name` is null for a theme with no name (raw
// tokens from set_theme). Settings → Brand says which theme it is showing.
function themeOf(root) {
  const t = projectTheme(root);
  const b = t.builtin ? getBuiltin(t.name) : null;
  return { key: t.key, name: t.name, title: b ? b.title : null };
}

// Just its key: the bucket every read and write below goes to by default.
function themeKey(root) {
  return projectTheme(root).key;
}

// The file a slot currently resolves to in theme `key`'s images: { file, ext,
// type, stat } or null. If a crash left both formats behind, the newer wins.
function locate(root, slot, key = themeKey(root)) {
  let best = null;
  for (const ext of EXTS) {
    const file = slotFile(root, key, slot, ext);
    if (!file) continue;
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    if (!best || stat.mtimeMs > best.stat.mtimeMs) best = { file, ext, type: TYPES[ext], stat };
  }
  return best;
}

// { bytes, type } for a slot, or null when it is unset or unreadable. The bytes
// are re-sniffed: a file that is not what its extension says is not served.
// `key` defaults to the current global theme's, as everywhere below.
function read(root, slot, key = themeKey(root)) {
  const hit = locate(root, slot, key);
  if (!hit) return null;
  let bytes;
  try { bytes = fs.readFileSync(hit.file); } catch { return null; }
  if (sniff(bytes) !== hit.ext) return null;
  return { bytes, type: hit.type };
}

// The cache-buster for an image served at the one url /brand/<slot>: it changes
// whenever the file does AND whenever the theme does. The theme matters because
// two themes' images can share a size and a millisecond (a pack's themes are
// written together; two marks that differ only in a colour are the same
// length), and an <img> whose src does not change is never fetched again — so
// a switch of theme would keep showing the previous theme's mark.
const versionOf = (stat, key) => `${Math.round(stat.mtimeMs)}-${stat.size}-${key}`;

// Every slot's metadata — { slot: {type, bytes, version} | null }. `version`
// is versionOf above, so the chrome can cache-bust /brand/<slot>.
function list(root, key = themeKey(root)) {
  const out = {};
  for (const slot of Object.keys(SLOTS)) {
    const hit = locate(root, slot, key);
    out[slot] = hit ? { type: hit.type, bytes: hit.stat.size, version: versionOf(hit.stat, key) } : null;
  }
  return out;
}

// Validate and store a slot under the CURRENT global theme. Throws
// BrandError(status) on refusal: 404 for an unknown slot, else validate()'s.
function write(root, slot, bytes) {
  if (!isSlot(slot)) throw new BrandError(404, `unknown brand slot '${slot}' (one of ${Object.keys(SLOTS).join(', ')})`);
  const ext = validate(bytes);
  const key = themeKey(root);
  const file = slotFile(root, key, slot, ext);
  if (!file) throw new BrandError(400, 'brand directory is not inside .web-chat');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  // Then drop the other format, so a slot is always exactly one file.
  for (const other of EXTS) {
    if (other === ext) continue;
    const f = slotFile(root, key, slot, other);
    if (f) { try { fs.unlinkSync(f); } catch {} }
  }
  return { slot, type: TYPES[ext], bytes: bytes.length, theme: key };
}

// Clear a slot of the CURRENT global theme; other themes' images stay. Returns
// whether anything was there.
function remove(root, slot) {
  if (!isSlot(slot)) throw new BrandError(404, `unknown brand slot '${slot}'`);
  const key = themeKey(root);
  let removed = false;
  for (const ext of EXTS) {
    const f = slotFile(root, key, slot, ext);
    if (!f) continue;
    try { fs.unlinkSync(f); removed = true; } catch {}
  }
  return removed;
}

// ---------------------------------------------------------------------------
// The active theme's logos: the fill for a slot the theme has no image in.
//
// While the project's GLOBAL theme has logos, a slot with no image of its own
// (none added under this theme) is filled from them: the topbar logotype, and
// an export's lockup and seal. An image added in Settings → Brand always wins.
// There are two places a theme's logos come from, and fillSource() below is the
// one code path that picks between them:
//
//   * A theme installed from a THEME PACK carries its logos beside it in the
//     theme library it was installed into — <themes dir>/<name>/logos/, project
//     tier (.web-chat/themes/) before system tier (~/.web-chat/themes/), the
//     order apply resolves a named theme in. lib/packs validated every one of
//     them at install; they are re-validated here on every read anyway, because
//     a file on disk can change after the check that let it in.
//   * Some BUILTIN packs are an institution's look (Georgetown Blue), and that
//     look wants its marks — which are trademarks, so none ship. Instead the
//     user may drop them into a per-user folder, userPaths().themeLogosDir(<pack>)
//     (~/.web-chat/themes/georgetown-blue/logos/). Deliberately quiet: nothing
//     in the UI, the docs, the CHANGELOG, the rules file or --help mentions that
//     folder. The only description of it is the README.txt written into it,
//     once, by `install` or `update` (lib/setup/theme-logos.js) — never here,
//     on first use: reading a fill writes nothing.
//
// Files are named <slot>.svg|png, plus an optional <slot>-reversed.svg|png (a
// white mark) that dark mode uses instead. Each goes through validate() — the
// SAME check as an upload — and one that fails is ignored with one log line.
// ---------------------------------------------------------------------------

const FILL_MODES = Object.freeze(['light', 'dark']);

// Where a project's global theme keeps its logos: { name, dir } or null when it
// has none to offer. An applied builtin resolves to its per-user folder (only
// the packs in FILL_PACKS have one); any other NAMED theme resolves to the <name>/logos/
// directory beside its file in the theme library — the tier whose <name>.json
// exists, project first — and that directory need not exist (logoFile then
// finds nothing). A project-tier directory is fenced to .web-chat/, so a
// committed symlink cannot point the fill at files elsewhere on the host — and
// logoFile reads only a regular file, never a link, so neither can a
// committed symlink in place of one logo.
function fillSource(root) {
  if (!root) return null;
  const pp = projectPaths(root);
  const up = userPaths();
  const t = resolveDefault(globalThemeFiles(root));
  if (!t || !t.name) return null;
  // An APPLIED builtin (appliedBuiltin — the rule resolveScope reports by)
  // fills from its per-user folder.
  const b = appliedBuiltin(t);
  if (b) {
    if (!FILL_PACKS.includes(b.name)) return null;
    return { name: b.name, dir: up.themeLogosDir(b.name) };
  }
  // A user's saved theme that only carries a builtin's name (a 0.7.6 `paper`
  // or `georgetown`) is not the pack, so it gets none of the pack's marks —
  // and no library logos either: no theme pack may install under that name.
  if (isBuiltinName(t.name)) return null;
  // The name becomes a directory: only a plain kebab-case one may.
  if (!isComponentName(t.name)) return null;
  if (fs.existsSync(path.join(pp.themesDir, `${t.name}.json`))) {
    const dir = fence(pp.dir, path.relative(pp.dir, pp.themeLogosDir(t.name)));
    return dir ? { name: t.name, dir } : null;
  }
  if (fs.existsSync(path.join(up.themesDir, `${t.name}.json`))) return { name: t.name, dir: up.themeLogosDir(t.name) };
  return null;
}

// One log line per bad file (per version of it), not one per request.
const warned = new Set();
function warnOnce(file, stat, why) {
  const key = `${file}|${stat.mtimeMs}|${stat.size}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.error(`web-chat: ignoring logo ${file}: ${why}`);
}

// { bytes, type, stat } for one logos-folder file (`logotype`,
// `logotype-reversed`, …) in `dir`, svg first, or null when there is no valid one.
//
// Only a REGULAR file counts: lstat, not stat, so a symlink is skipped rather
// than followed. The directory fence in fillSource cannot see a link one level
// down, and a followed link would pull any PNG or SVG the user can read into
// the topbar, /brand/<slot> (which the portal serves remotely) and every
// export's data: URI. A theme's own images are fenced per file too
// (lib/core/brand-store slotFile), and a theme pack never installs a link (its
// walk skips them).
function logoFile(dir, base) {
  for (const ext of ['svg', 'png']) {
    const file = path.join(dir, `${base}.${ext}`);
    let stat, bytes;
    try { stat = fs.lstatSync(file); } catch { continue; }
    if (stat.isSymbolicLink()) { warnOnce(file, stat, 'it is a symlink — a logo must be the file itself, not a link to one'); continue; }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_BYTES) { warnOnce(file, stat, `it is ${stat.size} bytes; the limit is ${MAX_BYTES}`); continue; }
    try { bytes = fs.readFileSync(file); } catch { continue; }
    try { validateLogoFile(path.basename(file), bytes); } catch (e) { warnOnce(file, stat, e.message); continue; }
    return { bytes, type: TYPES[ext], stat };
  }
  return null;
}

// A slot's fill per mode — { light, dark }, each { bytes, type, stat } or
// null (dark is the reversed file, else the regular one) — or null when the
// theme has its own image in the slot, the global theme has no logos, or its
// folder has nothing valid for it.
function fillFor(root, slot, src, key) {
  if (!src || !isSlot(slot) || locate(root, slot, key)) return null;
  const light = logoFile(src.dir, slot);
  const dark = logoFile(src.dir, `${slot}-reversed`) || light;
  return light || dark ? { light, dark } : null;
}

// Every slot's fill as metadata — { slot: { light: {type, bytes, version} |
// null, dark: … } | null } — beside list()'s own slots. Kept apart from them,
// so Settings → Brand shows only the images added under the theme.
function fills(root, key = themeKey(root)) {
  const src = fillSource(root);
  const meta = (f) => (f ? { type: f.type, bytes: f.bytes.length, version: versionOf(f.stat, key) } : null);
  const out = {};
  for (const slot of Object.keys(SLOTS)) {
    const f = src ? fillFor(root, slot, src, key) : null;
    out[slot] = f ? { light: meta(f.light), dark: meta(f.dark) } : null;
  }
  return out;
}

// What a slot shows in `mode`: the theme's own image, else its logo fill.
function effective(root, slot, { mode = 'light' } = {}) {
  if (!root) return null;
  const key = themeKey(root);
  const own = read(root, slot, key);
  if (own) return own;
  const f = fillFor(root, slot, fillSource(root), key);
  const hit = f && f[FILL_MODES.includes(mode) ? mode : 'light'];
  return hit ? { bytes: hit.bytes, type: hit.type } : null;
}

// A slot as a data: URI (base64 — only [A-Za-z0-9+/=] after the fixed prefix,
// so it is attribute-safe), or null when unset. For documents that cannot
// fetch /brand/, i.e. an export — light unless a mode is named.
function dataUri(root, slot, opts) {
  const r = effective(root, slot, opts);
  return r ? `data:${r.type};base64,${r.bytes.toString('base64')}` : null;
}

// Everything the chrome is told about the brand, with the theme read once:
// which theme the images belong to, its slots, and the fill for the empty ones.
// GET /api/brand, the upload/remove replies and the `brand` frame all carry it.
function snapshot(root) {
  const theme = themeOf(root);
  return { theme, slots: list(root, theme.key), fill: fills(root, theme.key) };
}

module.exports = {
  SLOTS, MAX_BYTES, TYPES, BRAND_CSP, BrandError,
  isSlot, sniff, svgRefusal, validate, parseLogoName, validateLogoFile, read, list, write, remove, dataUri,
  fills, effective, fillSource, LOGOS_README, themeOf, themeKey, snapshot,
};
