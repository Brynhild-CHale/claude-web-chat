const fs = require('fs');

const TOKEN_RE = /^--wc-[\w-]+$/;

// Built-in themes are always present and read-only (can't be saved over,
// modified, or deleted). They are the theme packs in ./theme-packs — Earthy
// (the stock look, light + dark), Paper and Georgetown (light only) — each
// defining every canonical token. A retired builtin name ('web-chat', the stock
// look before packs) still resolves, to the pack that replaced it.
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
// was the one baking tokens into a preview page. The set here is the union, and
// it takes the newlines with it: `;{}` are gone so a newline cannot start a
// second declaration, but a value that spans lines has no business in one.
function sanitizeTokens(tokens) {
  const out = {};
  if (tokens && typeof tokens === 'object') {
    for (const [k, v] of Object.entries(tokens)) {
      if (!TOKEN_RE.test(k)) continue;
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      // Structural characters are dropped; a line break inside a value becomes a
      // space so `0 1px\n2px` stays two lengths rather than fusing into `1px2px`.
      out[k] = String(v).replace(/[{}<>;]/g, '').replace(/[\r\n]+/g, ' ').trim();
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
    if (b) return { name: b.name, builtin: true, ...normalizeFields(b) };
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
// → builtin (empty tokens; the CSS var() fallbacks then supply the look).
function resolveDefault(paths) {
  return readTheme(paths.THEME_PATH) || readTheme(paths.SYSTEM_THEME_PATH) || { tokens: {} };
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
  TOKEN_RE, BUILTIN_THEMES, CANONICAL_TOKENS, getBuiltin, isBuiltinName,
};
