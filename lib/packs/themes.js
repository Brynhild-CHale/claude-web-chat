// A theme inside a pack — what it may carry, and what it becomes on disk.
//
// A pack ships a theme as a directory:
//
//   themes/<name>/theme.json          tokens, optional `modes`, optional `fonts`
//   themes/<name>/logos/<slot>[-reversed].svg|png     optional; slot is one of
//                                                     logotype · lockup · seal
//   themes/<name>/fonts/<file>.woff2  optional, only files `fonts` names, plus
//   themes/<name>/fonts/OFL.txt       the licence they ship under (required
//                                     whenever a font file is shipped)
//
// (A bare `themes/<name>.json` — the layout before theme packs had logos — is
// still read, as a theme with nothing beside it.)
//
// It installs into the theme LIBRARY of the pack's tier, where save_theme puts
// a theme and apply_theme finds one: `<themes dir>/<name>.json`, with its logos
// and fonts beside it under `<themes dir>/<name>/` (the library's loader skips
// directories, so they never list as themes). lib/server/brand.js reads that
// logos directory to fill a project's empty brand slots while the theme is the
// global one. Nothing reads the fonts/ beside it yet — no @font-face serves an
// installed font — so the plan warns for every theme that ships one.
//
// Everything here is PURE — a read over a staged tree, no writes — so the plan
// the review card shows is exactly what the install would apply, and every
// problem is collected rather than thrown: a theme that would not install is
// still staged for review, and seeing WHY is the point of review.
//
// What an installed theme may NOT carry is raw CSS. A theme's `css` reaches the
// unsandboxed chrome (and a pane's, that pane), which is a different order of
// trust from a token value — a token is sanitised down to one declaration value
// (lib/core/theme-values sanitizeTokenValue, which lib/server/theme.js
// sanitizeTokens runs on every token), a stylesheet is not sanitised at all.
// Whether a stranger's stylesheet may ride in with a theme was put to the
// maintainer for 0.8.0 (refuse / warn / allow), and the answer was REFUSE: the
// pack endpoint cannot tell a user's click from a pane's fetch (read the risk
// paragraph at the head of lib/server/routes/packs.js), so a stylesheet
// accepted there would be CSS any pane could put into the chrome. No builtin
// needs one — the topbar rule that once did is the --wc-topbar-rule-width
// token. A theme carrying `css` or `modes.*.css` is refused at plan time and
// shown in the review. The policy is still ONE constant, so revisiting the
// decision is one edit: set THEME_CSS_POLICY to 'allow' and nothing else
// changes.

const fs = require('fs');
const path = require('path');
const { isComponentName } = require('../core/names');
const { SLOTS, parseLogoName, validateLogoFile } = require('../core/brand-image');
const { bundledFamilies } = require('../core/fonts');
const { refusedTokens, alteredTokens } = require('../core/theme-values');

// 'refuse' | 'allow' — whether an installed theme's `css` and `modes.*.css` may
// install. The ONE switch; see the header.
const THEME_CSS_POLICY = 'refuse';

const THEME_FILE = 'theme.json';
// A theme file is tokens; anything past this is not a theme.
const THEME_MAX_BYTES = 256 * 1024;

// Fonts a pack may ship: WOFF2 only (the format every supported browser reads
// and the one the bundled faces use), under an OFL licence shipped beside them.
const WOFF2_MAGIC = Buffer.from('wOF2', 'latin1');
const FONT_MAX_BYTES = 1024 * 1024;
const FONT_MAX_FILES = 12;
const FONT_FILE_RE = /^[A-Za-z0-9][\w.-]{0,127}\.woff2$/;
// OFL.txt, OFL-Inter.txt, LICENSE, LICENCE.md, …
const LICENCE_RE = /^(?:OFL|LICEN[CS]E)(?:[-_.][\w.-]*)?$/i;
const OFL_TEXT_RE = /SIL\s+OPEN\s+FONT\s+LICEN[CS]E/i;
// A family name goes into a font stack and an @font-face rule: letters, digits,
// spaces, dot, dash, underscore — nothing that could close a quote or a rule.
const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const WEIGHT_RE = /^(?:normal|bold|[1-9]00(?:\s+[1-9]00)?)$/;
const STYLE_RE = /^(?:normal|italic|oblique)$/;

const MODES = ['light', 'dark'];
// The swatches a review card draws, per mode.
const PALETTE = [['bg', '--wc-bg'], ['panel', '--wc-panel-bg'], ['fg', '--wc-fg'], ['accent', '--wc-accent'], ['green', '--wc-green'], ['gold', '--wc-gold']];

// Where a staged theme's definition is: { dir, file, layout } — `dir` null for
// the bare-file layout — or null when neither is there.
function themeSource(stageDir, name) {
  const dir = path.join(stageDir, 'themes', name);
  const inDir = path.join(dir, THEME_FILE);
  if (isFile(inDir)) return { dir, file: inDir, layout: 'dir' };
  const flat = path.join(stageDir, 'themes', `${name}.json`);
  if (isFile(flat)) return { dir: null, file: flat, layout: 'flat' };
  return null;
}

function isFile(p) {
  try { return fs.lstatSync(p).isFile(); } catch { return false; }
}

// Every regular file under `dir`, relative, `/`-separated. Symlinks and other
// non-regular entries are skipped (the fetch gate already refused them; this
// is the second look, at the site that reads).
function walk(dir, rel = '', out = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(dir, r, out);
    else if (e.isFile()) out.push(r);
  }
  return out;
}

const cssOf = (v) => typeof v === 'string' && v.trim().length > 0;

// Inspect one staged theme. Returns
//   { name, errors, warnings, files: [{ src, path, bytes }], summary }
// where `files` is what would install, each `path` relative to the tier's
// themes directory (`<name>.json`, `<name>/logos/seal.svg`, …), and `summary`
// is what a review card shows: token count, modes, logos, fonts, the palette.
function inspectPackTheme(stageDir, name) {
  const errors = [];
  const warnings = [];
  const files = [];
  const summary = { tokens: 0, modes: [], logos: [], fonts: [], css: false, palette: {} };
  const out = { name, errors, warnings, files, summary };
  const say = (msg) => `theme "${name}": ${msg}`;

  if (!isComponentName(name)) {
    errors.push(`theme ${JSON.stringify(String(name == null ? '' : name))}: names must be kebab-case — refused`);
    return out;
  }
  const src = themeSource(stageDir, name);
  if (!src) {
    errors.push(say(`themes/${name}/${THEME_FILE} is missing`));
    return out;
  }
  if (src.layout === 'dir' && isFile(path.join(stageDir, 'themes', `${name}.json`))) {
    warnings.push(say(`both themes/${name}/${THEME_FILE} and themes/${name}.json exist — the directory wins, the bare file is not installed`));
  }

  // ── theme.json ────────────────────────────────────────────────────────────
  const size = fs.statSync(src.file).size;
  if (size > THEME_MAX_BYTES) {
    errors.push(say(`${THEME_FILE} is ${size} bytes; the limit is ${THEME_MAX_BYTES}`));
    return out;
  }
  let theme;
  try {
    theme = JSON.parse(fs.readFileSync(src.file, 'utf8'));
    if (!theme || typeof theme !== 'object' || Array.isArray(theme)) throw new Error('not an object');
  } catch (e) {
    errors.push(say(`${THEME_FILE} is not valid JSON: ${e.message}`));
    return out;
  }
  files.push({ src: src.file, path: `${name}.json`, bytes: size });

  if (theme.name != null && theme.name !== name) {
    errors.push(say(`${THEME_FILE} says name ${JSON.stringify(theme.name)}; the directory name is the theme's name — make them match or drop "name"`));
  }
  if (theme.builtin) errors.push(say(`${THEME_FILE} says "builtin" — an installed theme is not a built-in one`));
  if (theme.tokens != null && (typeof theme.tokens !== 'object' || Array.isArray(theme.tokens))) {
    errors.push(say('"tokens" must be an object of --wc-* tokens'));
  }
  const keys = new Set(Object.keys((theme.tokens && typeof theme.tokens === 'object') ? theme.tokens : {}));
  const cssAt = [];
  if (theme.css != null && typeof theme.css !== 'string') errors.push(say('"css" must be a string'));
  if (cssOf(theme.css)) cssAt.push('css');
  if (theme.modes != null) {
    if (typeof theme.modes !== 'object' || Array.isArray(theme.modes)) {
      errors.push(say('"modes" must be an object with "light" and/or "dark"'));
    } else {
      for (const [m, layer] of Object.entries(theme.modes)) {
        if (!MODES.includes(m)) { warnings.push(say(`mode "${m}" is not light or dark — ignored`)); continue; }
        if (!layer || typeof layer !== 'object' || Array.isArray(layer)) { errors.push(say(`modes.${m} must be an object`)); continue; }
        if (layer.tokens != null && (typeof layer.tokens !== 'object' || Array.isArray(layer.tokens))) {
          errors.push(say(`modes.${m}.tokens must be an object`));
        } else {
          for (const k of Object.keys(layer.tokens || {})) keys.add(k);
        }
        if (layer.css != null && typeof layer.css !== 'string') errors.push(say(`modes.${m}.css must be a string`));
        if (cssOf(layer.css)) cssAt.push(`modes.${m}.css`);
        summary.modes.push(m);
      }
    }
  }
  // A token value that would make the browser fetch (url(…) and its kin) is
  // refused like raw CSS is: the chrome paints tokens with no CSP, and an export
  // inlines them, so it would report every viewer to the value's host. It is
  // judged as shipped AND as painted (refusedTokenValue), since the strip every
  // token goes through deletes characters and `ur;l(` is painted as `url(`.
  //
  // A value the strip would change at all — a `{ } < > ;` or a line break — is
  // refused too. No colour, length, font stack or gradient carries one, the
  // deletion is exactly what assembled that url(, and a value that changes on
  // its way to the page is not the one the review card showed. Refused outright,
  // the value reviewed IS the value painted.
  //
  // One line per token: a value that is both (`ur;l(x)` — the strip assembles
  // the url() it is refused for) reports the url(), the reason that matters,
  // and not the stripped characters as well.
  const tokenMaps = [['tokens', theme.tokens]];
  if (theme.modes && typeof theme.modes === 'object') {
    for (const m of MODES) if (theme.modes[m] && typeof theme.modes[m] === 'object') tokenMaps.push([`modes.${m}.tokens`, theme.modes[m].tokens]);
  }
  for (const [where, map] of tokenMaps) {
    const refused = refusedTokens(map);
    for (const { token, what } of refused) {
      errors.push(say(`${where} ${token} carries ${what} — a token value may not load anything (no url(), image-set(), @import, javascript: or escapes). Use a plain colour, length or gradient, or ship an image as a logo.`));
    }
    const named = new Set(refused.map((r) => r.token));
    for (const { token } of alteredTokens(map)) {
      if (named.has(token)) continue;
      errors.push(say(`${where} ${token} carries { } < > ; or a line break — a token value is one CSS value on one line, and those characters are stripped before it is painted, so the value reviewed would not be the value shown. Remove them.`));
    }
  }
  summary.tokens = [...keys].filter((k) => k.startsWith('--wc-')).length;
  if (!summary.tokens) warnings.push(say('defines no --wc-* tokens — applying it would change nothing'));
  summary.css = cssAt.length > 0;
  if (cssAt.length && THEME_CSS_POLICY !== 'allow') {
    errors.push(say(`carries raw CSS (${cssAt.join(', ')}). An installed theme may not ship CSS yet — tokens, light/dark modes, fonts and logos are all allowed. Remove the CSS and publish again.`));
  }
  summary.palette = palette(theme);

  // ── the directory beside it: logos and fonts ──────────────────────────────
  const shipped = src.dir ? walk(src.dir) : [];
  const claimed = new Set([THEME_FILE]);

  for (const rel of shipped.filter((r) => r.startsWith('logos/'))) {
    claimed.add(rel);
    const base = rel.slice('logos/'.length);
    const parsed = base.includes('/') ? null : parseLogoName(base);
    if (!parsed) {
      warnings.push(say(`${rel} is not installed — a logo is named ${Object.keys(SLOTS).join('|')}[-reversed].svg|png`));
      continue;
    }
    const abs = path.join(src.dir, rel);
    let bytes;
    try { bytes = fs.readFileSync(abs); } catch (e) { errors.push(say(`${rel}: ${e.message}`)); continue; }
    try { validateLogoFile(base, bytes); } catch (e) {
      errors.push(say(`logo ${rel} refused: ${e.message}`));
      continue;
    }
    files.push({ src: abs, path: `${name}/${rel}`, bytes: bytes.length });
    summary.logos.push(base.replace(/\.(svg|png)$/, ''));
  }
  const logoBases = summary.logos;
  if (new Set(logoBases).size !== logoBases.length) {
    warnings.push(say('ships both an .svg and a .png for one logo — the .svg is the one shown'));
  }

  // fonts
  const listed = theme.fonts == null ? [] : theme.fonts;
  if (!Array.isArray(listed)) errors.push(say('"fonts" must be a list'));
  const bundled = bundledFamilies();
  const fontFiles = [];
  for (const entry of Array.isArray(listed) ? listed : []) {
    if (typeof entry === 'string') {
      const hit = bundled.find((f) => f.toLowerCase() === entry.trim().toLowerCase());
      if (!hit) {
        errors.push(say(`font "${entry}" is not one web-chat bundles (${bundled.join(', ')}) — ship it as a WOFF2 under themes/${name}/fonts/ with its OFL licence, or name a bundled one`));
        continue;
      }
      summary.fonts.push({ family: hit, bundled: true });
      continue;
    }
    if (!entry || typeof entry !== 'object') { errors.push(say('a "fonts" entry must be a bundled family name or { family, file }')); continue; }
    const family = typeof entry.family === 'string' ? entry.family.trim() : '';
    const file = typeof entry.file === 'string' ? entry.file : '';
    if (!FAMILY_RE.test(family)) { errors.push(say(`font family ${JSON.stringify(entry.family)} is not a plain family name`)); continue; }
    if (!FONT_FILE_RE.test(file)) { errors.push(say(`font "${family}": "file" must be a .woff2 file name in themes/${name}/fonts/ (got ${JSON.stringify(entry.file)})`)); continue; }
    if (entry.weight != null && !WEIGHT_RE.test(String(entry.weight))) errors.push(say(`font "${family}": weight ${JSON.stringify(entry.weight)} is not a CSS font-weight (400, bold, or a range like "100 900")`));
    if (entry.style != null && !STYLE_RE.test(String(entry.style))) errors.push(say(`font "${family}": style ${JSON.stringify(entry.style)} is not normal, italic or oblique`));
    const rel = `fonts/${file}`;
    const abs = src.dir ? path.join(src.dir, rel) : null;
    if (!abs || !isFile(abs)) { errors.push(say(`font "${family}": ${rel} is missing`)); continue; }
    const fsize = fs.statSync(abs).size;
    if (fsize > FONT_MAX_BYTES) { errors.push(say(`font ${rel} is ${fsize} bytes; the limit is ${FONT_MAX_BYTES}`)); continue; }
    const head = Buffer.alloc(4);
    try { const fd = fs.openSync(abs, 'r'); try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); } } catch {}
    if (!head.equals(WOFF2_MAGIC)) { errors.push(say(`font ${rel} is not a WOFF2 file`)); continue; }
    if (!claimed.has(rel)) {
      claimed.add(rel);
      fontFiles.push({ src: abs, path: `${name}/${rel}`, bytes: fsize });
    }
    summary.fonts.push({ family, file, ...(entry.weight != null ? { weight: String(entry.weight) } : {}), ...(entry.style != null ? { style: String(entry.style) } : {}) });
  }
  if (fontFiles.length > FONT_MAX_FILES) {
    errors.push(say(`ships ${fontFiles.length} font files; the limit is ${FONT_MAX_FILES}`));
  }
  if (fontFiles.length) {
    // A shipped font must come with its licence, and the licence must be the
    // OFL — the one licence that lets a font be redistributed inside a pack
    // without asking anybody.
    const licences = shipped.filter((r) => r.startsWith('fonts/') && !r.slice(6).includes('/') && LICENCE_RE.test(r.slice(6)));
    const ofl = licences.find((r) => {
      try { return OFL_TEXT_RE.test(fs.readFileSync(path.join(src.dir, r), 'utf8').slice(0, 64 * 1024)); } catch { return false; }
    });
    if (!ofl) {
      errors.push(say(`ships font files but no OFL licence beside them — put the SIL Open Font License text in themes/${name}/fonts/OFL.txt`));
    } else {
      claimed.add(ofl);
      files.push(...fontFiles, { src: path.join(src.dir, ofl), path: `${name}/${ofl}`, bytes: fs.statSync(path.join(src.dir, ofl)).size });
      // Said at plan time, so the review card, `pack review` and the install
      // report all carry it: nothing serves an installed theme's fonts/ yet —
      // no @font-face for it in the chrome, a preview or an export — so the
      // family only renders where the viewer happens to have it, and the
      // token's next family is what everyone else sees.
      const families = [...new Set(summary.fonts.filter((f) => f.file).map((f) => f.family))];
      const eg = bundled.length ? `, e.g. "'${families[0]}', ${bundled[0]}, sans-serif"` : '';
      warnings.push(say(`${families.map((f) => `"${f}"`).join(', ')} (fonts/) ${families.length === 1 ? 'is' : 'are'} installed with the theme but not yet loaded by the surface or exports — name a bundled fallback after it in the token${eg}`));
    }
  }

  for (const rel of shipped) {
    if (claimed.has(rel)) continue;
    if (rel.startsWith('fonts/') && LICENCE_RE.test(rel.slice(6)) && fontFiles.length) continue;
    warnings.push(say(`${rel} is not installed — a theme installs its ${THEME_FILE}, its logos/ and the fonts/ files "fonts" names`));
  }
  return out;
}

// { light: {bg, panel, fg, accent, green, gold}, dark: … } from the theme's own
// tokens — each mode's layer over the mode-free tokens, only string values, and
// only the modes it declares (or one `default` row when it declares none).
// Values are UNTRUSTED text for a reviewer to look at; a UI must set them as a
// style property, never interpolate them into markup.
function palette(theme) {
  const base = (theme.tokens && typeof theme.tokens === 'object') ? theme.tokens : {};
  const modes = (theme.modes && typeof theme.modes === 'object') ? MODES.filter((m) => theme.modes[m]) : [];
  const out = {};
  for (const m of modes.length ? modes : ['default']) {
    const layer = m === 'default' ? {} : ((theme.modes[m] && theme.modes[m].tokens) || {});
    const row = {};
    for (const [k, tok] of PALETTE) {
      const v = layer[tok] != null ? layer[tok] : base[tok];
      if (typeof v === 'string' && v.length <= 64) row[k] = v;
    }
    out[m] = row;
  }
  return out;
}

module.exports = {
  THEME_CSS_POLICY, THEME_FILE, FONT_MAX_BYTES, FONT_MAX_FILES,
  themeSource, inspectPackTheme,
};
