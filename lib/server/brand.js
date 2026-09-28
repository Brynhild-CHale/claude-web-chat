const fs = require('fs');
const path = require('path');
const { projectPaths, userPaths, fence } = require('../core/paths');
const { isComponentName } = require('../core/names');
const { resolveDefault, getBuiltin } = require('./theme');
const { FILL_PACKS, LOGOS_README } = require('../setup/theme-logos');

// ---------------------------------------------------------------------------
// Per-project brand images.
//
// Three fixed SLOTS, each one file under .web-chat/brand/: the `logotype` the
// topbar shows beside the wordmark, and the `lockup` and `seal` an exported page
// carries in its header and footer. A theme applies colour and type only; these
// are the project's own artwork, so they live with the project, not the theme.
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
// is looked up in SLOTS, never joined; `fence` then refuses a slot file that is
// a symlink pointing out of .web-chat/.
// ---------------------------------------------------------------------------

// The slots, the size limit, the formats, the sniffer and the one image check
// live in lib/core/brand-image.js — a theme pack's logos are validated with the
// same check at install time, from lib/packs, which may not import this file.
const {
  SLOTS, MAX_BYTES, TYPES, BrandError, sniff, svgRefusal, validate, parseLogoName, validateLogoFile,
} = require('../core/brand-image');
const EXTS = Object.keys(TYPES);

// What a response serving a slot is allowed to do if someone opens it as a
// document: nothing. An SVG's own <style> is the one thing it may keep.
const BRAND_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

function isSlot(slot) {
  return typeof slot === 'string' && Object.prototype.hasOwnProperty.call(SLOTS, slot);
}

// Absolute path of a slot's file in one format, fenced to .web-chat/; null when
// it escapes (a symlink out) or the slot is not one of SLOTS.
function slotFile(root, slot, ext) {
  if (!isSlot(slot) || !EXTS.includes(ext)) return null;
  const p = projectPaths(root);
  return fence(p.dir, path.join(path.relative(p.dir, p.brandDir), `${slot}.${ext}`));
}

// The file a slot currently resolves to: { file, ext, type, stat } or null. If
// a crash left both formats behind, the newer one wins.
function locate(root, slot) {
  let best = null;
  for (const ext of EXTS) {
    const file = slotFile(root, slot, ext);
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
function read(root, slot) {
  const hit = locate(root, slot);
  if (!hit) return null;
  let bytes;
  try { bytes = fs.readFileSync(hit.file); } catch { return null; }
  if (sniff(bytes) !== hit.ext) return null;
  return { bytes, type: hit.type };
}

// Every slot's metadata — { slot: {type, bytes, version} | null }. `version`
// changes whenever the file does, so the chrome can cache-bust /brand/<slot>.
function list(root) {
  const out = {};
  for (const slot of Object.keys(SLOTS)) {
    const hit = locate(root, slot);
    out[slot] = hit
      ? { type: hit.type, bytes: hit.stat.size, version: `${Math.round(hit.stat.mtimeMs)}-${hit.stat.size}` }
      : null;
  }
  return out;
}

// Validate and store a slot. Throws BrandError(status) on refusal: 404 for an
// unknown slot, else validate()'s.
function write(root, slot, bytes) {
  if (!isSlot(slot)) throw new BrandError(404, `unknown brand slot '${slot}' (one of ${Object.keys(SLOTS).join(', ')})`);
  const ext = validate(bytes);
  const file = slotFile(root, slot, ext);
  if (!file) throw new BrandError(400, 'brand directory is not inside .web-chat');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  // Then drop the other format, so a slot is always exactly one file.
  for (const other of EXTS) {
    if (other === ext) continue;
    const f = slotFile(root, slot, other);
    if (f) { try { fs.unlinkSync(f); } catch {} }
  }
  return { slot, type: TYPES[ext], bytes: bytes.length };
}

// Clear a slot. Returns whether anything was there.
function remove(root, slot) {
  if (!isSlot(slot)) throw new BrandError(404, `unknown brand slot '${slot}'`);
  let removed = false;
  for (const ext of EXTS) {
    const f = slotFile(root, slot, ext);
    if (!f) continue;
    try { fs.unlinkSync(f); removed = true; } catch {}
  }
  return removed;
}

// ---------------------------------------------------------------------------
// The active theme's logos: the fill for an EMPTY project slot.
//
// While the project's GLOBAL theme has logos, a slot the PROJECT left empty is
// filled from them: the topbar logotype, and an export's lockup and seal. A
// project's own upload always wins. There are two places a theme's logos come
// from, and fillSource() below is the one code path that picks between them:
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
// has none to offer. A builtin resolves to its per-user folder (only the packs
// in FILL_PACKS have one); any other NAMED theme resolves to the <name>/logos/
// directory beside its file in the theme library — the tier whose <name>.json
// exists, project first — and that directory need not exist (logoFile then
// finds nothing). A project-tier directory is fenced to .web-chat/, so a
// committed symlink cannot point the fill at files elsewhere on the host.
function fillSource(root) {
  if (!root) return null;
  const pp = projectPaths(root);
  const up = userPaths();
  const t = resolveDefault({ THEME_PATH: pp.theme, SYSTEM_THEME_PATH: up.theme, THEME_DEFAULT_PATH: pp.themeDefault });
  if (!t || !t.name) return null;
  // a stored name that matches a builtin was always an applied builtin (save
  // refuses builtin names) — the same rule resolveScope reports by
  const b = getBuiltin(t.name);
  if (b) {
    if (!FILL_PACKS.includes(b.name)) return null;
    return { name: b.name, dir: up.themeLogosDir(b.name) };
  }
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

// { bytes, type, version } for one logos-folder file (`logotype`,
// `logotype-reversed`, …) in `dir`, svg first, or null when there is no valid one.
function logoFile(dir, base) {
  for (const ext of ['svg', 'png']) {
    const file = path.join(dir, `${base}.${ext}`);
    let stat, bytes;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_BYTES) { warnOnce(file, stat, `it is ${stat.size} bytes; the limit is ${MAX_BYTES}`); continue; }
    try { bytes = fs.readFileSync(file); } catch { continue; }
    try { validateLogoFile(path.basename(file), bytes); } catch (e) { warnOnce(file, stat, e.message); continue; }
    return { bytes, type: TYPES[ext], version: `${Math.round(stat.mtimeMs)}-${stat.size}` };
  }
  return null;
}

// A slot's fill per mode — { light, dark }, each { bytes, type, version } or
// null (dark is the reversed file, else the regular one) — or null when the
// project set the slot itself, the global theme has no logos, or its folder
// has nothing valid for it.
function fillFor(root, slot, src = fillSource(root)) {
  if (!src || !isSlot(slot) || locate(root, slot)) return null;
  const light = logoFile(src.dir, slot);
  const dark = logoFile(src.dir, `${slot}-reversed`) || light;
  return light || dark ? { light, dark } : null;
}

// Every slot's fill as metadata — { slot: { light: {type, bytes, version} |
// null, dark: … } | null } — beside list()'s own slots. Kept apart from them,
// so Settings → Brand shows only what the project set.
function fills(root) {
  const src = fillSource(root);
  const meta = (f) => (f ? { type: f.type, bytes: f.bytes.length, version: f.version } : null);
  const out = {};
  for (const slot of Object.keys(SLOTS)) {
    const f = src ? fillFor(root, slot, src) : null;
    out[slot] = f ? { light: meta(f.light), dark: meta(f.dark) } : null;
  }
  return out;
}

// What a slot shows in `mode`: the project's own image, else the global theme's.
function effective(root, slot, { mode = 'light' } = {}) {
  if (!root) return null;
  const own = read(root, slot);
  if (own) return own;
  const f = fillFor(root, slot);
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

module.exports = {
  SLOTS, MAX_BYTES, TYPES, BRAND_CSP, BrandError,
  isSlot, sniff, svgRefusal, validate, parseLogoName, validateLogoFile, read, list, write, remove, dataUri,
  fills, effective, fillSource, LOGOS_README,
};
