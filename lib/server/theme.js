const fs = require('fs');
const { sanitizeTokenValue } = require('../core/theme-values');

const TOKEN_RE = /^--wc-[\w-]+$/;

// Built-in themes are always present and read-only (can't be saved over,
// modified, or deleted). They are the theme packs in ./theme-packs — Earthy
// (the stock look), Paper and Georgetown Blue, each a light/dark pair — each
// defining every canonical token. A retired builtin name ('web-chat', the stock
// look before packs; 'georgetown', Georgetown Blue's id before the rename) still
// resolves, to the pack that replaced it. A pack's `name` is its id; `title` is
// what a person is shown (the Settings picker, the ◑ tooltip).
const { PACKS, ALIASES, CANONICAL_TOKENS } = require('./theme-packs');
const BUILTIN_THEMES = PACKS.map((p) => ({ ...p, builtin: true }));
function getBuiltin(name) {
  let n = String(name || '').toLowerCase();
  if (Object.hasOwn(ALIASES, n)) n = ALIASES[n];
  return BUILTIN_THEMES.find(t => t.name.toLowerCase() === n) || null;
}
function isBuiltinName(name) {
  return !!getBuiltin(name);
}

// The builtin pack a STORED theme (theme.json, a node's or a pane's) is an
// application of, or null. Only two things count: `builtin: true`, which is
// what apply writes for a pack, and the retired stock name 'web-chat', which
// pre-pack releases stored as a flagless copy of the one builtin they had.
//
// A name alone does NOT: 0.7.6 could save and apply a theme called `paper` or
// `georgetown` before those were builtins, and its apply stored the full token
// copy with no flag. Such a theme paints its own tokens, so reporting it as the
// pack it shadows (get_theme, Settings, the logo fill) would name a look that
// is not on screen. isBuiltinName still says whether its name is one.
const RETIRED_STOCK_NAME = 'web-chat';
function appliedBuiltin(t) {
  if (!t || !t.name) return null;
  if (!t.builtin && String(t.name).toLowerCase() !== RETIRED_STOCK_NAME) return null;
  return getBuiltin(t.name);
}

// --- modes -----------------------------------------------------------------
// A theme may carry `modes: { light: {tokens, css}, dark: {tokens, css} }` on
// top of its mode-free `tokens`/`css`. Declaring only one mode makes the theme
// single-mode (the ◑ toggle is disabled under it). A theme with no `modes` is
// mode-agnostic — every theme saved before modes existed — and applies as-is
// in either mode (under it the stylesheet's own light/dark fallbacks show).
//
// The viewer's light/dark preference lives in their browser; the server has
// none, so what it resolves (get_theme, exports, glance previews) is in
// DEFAULT_MODE unless a caller names one. public/app/theme.js mirrors these
// rules for the live chrome.
const MODES = ['light', 'dark'];
const DEFAULT_MODE = 'light';
function themeModes(t) {
  return (t && t.modes && typeof t.modes === 'object') ? MODES.filter(m => t.modes[m]) : [];
}
// The mode a theme renders in when `want` is asked for: `want` if it declares
// it (or declares no modes at all), else the first mode it does declare.
function pickMode(t, want) {
  const ms = themeModes(t);
  if (!ms.length) return want;
  return ms.includes(want) ? want : ms[0];
}
// One theme at one mode, as the flat {tokens, css} every consumer bakes.
function flattenTheme(t, mode = DEFAULT_MODE) {
  if (!t) return { tokens: {}, css: '' };
  const layer = t.modes && t.modes[pickMode(t, mode)];
  return {
    tokens: { ...(t.tokens || {}), ...((layer && layer.tokens) || {}) },
    css: [t.css, layer && layer.css].filter(c => typeof c === 'string' && c.trim()).join('\n'),
  };
}
// The mode a whole cascade renders in: the least-specific layer (global)
// decides, exactly as the ◑ toggle follows the global pack.
function cascadeMode(layers, want) {
  const base = layers.find(Boolean);
  return pickMode(base, want || DEFAULT_MODE);
}

// A token value is a single CSS declaration value — strip the chars that could
// break out of `name: value;` so a token can't smuggle extra rules.
//
// This is the only sanitiser. There used to be three: lib/server/export.js and
// lib/server/routes/graph.js each re-declared TOKEN_RE and stripped their own
// character set (`[\n;{}<>]` and `[{}<]`), so the same token could come back
// different depending on which of the three cleared it — and the narrowest set
// was the one baking tokens into a preview page. The set is the union, and it
// takes the newlines with it: `;{}` are gone so a newline cannot start a second
// declaration, but a value that spans lines has no business in one.
//
// The per-value strip is lib/core/theme-values sanitizeTokenValue, so the pack
// planner's refusal beside it (refusedTokenValue) judges exactly the value this
// paints: a strip that deletes characters can assemble `url(` out of a value
// that never spelled it (`ur;l(`).
function sanitizeTokens(tokens) {
  const out = {};
  if (tokens && typeof tokens === 'object') {
    for (const [k, v] of Object.entries(tokens)) {
      if (!TOKEN_RE.test(k)) continue;
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      out[k] = sanitizeTokenValue(v);
    }
  }
  return out;
}

// Render a token map into CSS declarations, sanitised on the way through. The
// export shell and the graph preview both bake tokens into a <style>; both
// carried their own filter-and-strip before doing it. They format, and this is
// where the formatting lives.
function tokenDecls(tokens, indent = '  ') {
  return Object.entries(sanitizeTokens(tokens))
    .map(([k, v]) => `${indent}${k}: ${v};`)
    .join('\n');
}

function normalizeModes(modes) {
  if (!modes || typeof modes !== 'object') return null;
  const out = {};
  for (const m of MODES) {
    const l = modes[m];
    if (!l || typeof l !== 'object') continue;
    out[m] = { tokens: sanitizeTokens(l.tokens) };
    if (typeof l.css === 'string') out[m].css = l.css;
  }
  return Object.keys(out).length ? out : null;
}

// A theme that says it is a builtin (what apply_theme stores for one) is
// re-read from the pack by name, so a project that applied Paper picks up the
// pack's current values rather than freezing the copy it applied.
function normalizeTheme(t) {
  if (t && t.builtin) {
    const b = getBuiltin(t.name);
    if (b) return { name: b.name, title: b.title, builtin: true, ...normalizeFields(b) };
  }
  const out = {};
  if (t && t.name) out.name = String(t.name);
  return Object.assign(out, normalizeFields(t));
}
function normalizeFields(t) {
  const out = { tokens: sanitizeTokens(t && t.tokens) };
  if (t && typeof t.css === 'string') out.css = t.css;
  const modes = normalizeModes(t && t.modes);
  if (modes) out.modes = modes;
  return out;
}

function readTheme(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const t = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!t || typeof t !== 'object') return null;
    return normalizeTheme(t);
  } catch {
    return null;
  }
}

// The web-chat-wide default: project theme.json → system ~/.web-chat/theme.json
// → the project's default pack → empty tokens (the CSS var() fallbacks then
// supply the look, which is Earthy).
//
// The default pack is how a NEW project starts on Georgetown Blue while an
// existing one keeps its look: the migration runner writes
// .web-chat/theme-default.json ({name:'georgetown-blue'}) only on a project's
// first touch — no _version.json yet — and never into a project that has one.
// So a project that pre-dates this build has no marker and resolves exactly as
// before, and a project born on it resolves to the pack (lib/update/migrations
// NEW_PROJECT_PACK). It is the LAST step on
// purpose: a user-tier theme.json still beats it, and clearing the project's
// theme falls back to it rather than to Earthy. Only a builtin pack name counts;
// anything else in the file is ignored.
function readDefaultPack(p) {
  if (!p) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  const b = raw && typeof raw === 'object' ? getBuiltin(raw.name) : null;
  return b ? normalizeTheme({ name: b.name, builtin: true }) : null;
}
function resolveDefault(paths) {
  return readTheme(paths.THEME_PATH) || readTheme(paths.SYSTEM_THEME_PATH)
    || readDefaultPack(paths.THEME_DEFAULT_PATH) || { tokens: {} };
}

// Cascade is pane → node → global, most-specific wins, unset tokens fall
// through. Pass layers least-specific-first; later layers override earlier.
// Each layer is flattened at the cascade's mode first (see cascadeMode), so a
// pack with modes merges as the mode it renders in. `mode` defaults to
// DEFAULT_MODE; mergeTokensAt names one.
function mergeTokensAt(mode, layers) {
  const m = cascadeMode(layers, mode);
  const tokens = {};
  for (const l of layers) if (l) Object.assign(tokens, flattenTheme(l, m).tokens);
  return tokens;
}
function mergeTokens(...layers) { return mergeTokensAt(null, layers); }

// Concatenate the raw-CSS escape hatches that apply to chrome (global + node),
// least-specific first so node rules can override global ones by source order.
function mergeCssAt(mode, layers) {
  const m = cascadeMode(layers, mode);
  const parts = [];
  for (const l of layers) {
    const css = l ? flattenTheme(l, m).css : '';
    if (css.trim()) parts.push(css);
  }
  return parts.join('\n');
}
function mergeCss(...layers) { return mergeCssAt(null, layers); }

module.exports = {
  sanitizeTokens, tokenDecls, normalizeTheme, readTheme, resolveDefault,
  mergeTokens, mergeCss, mergeTokensAt, mergeCssAt,
  MODES, DEFAULT_MODE, themeModes, pickMode, flattenTheme, cascadeMode,
  TOKEN_RE, BUILTIN_THEMES, CANONICAL_TOKENS, getBuiltin, isBuiltinName, appliedBuiltin,
};
