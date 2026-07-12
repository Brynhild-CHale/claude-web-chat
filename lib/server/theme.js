const fs = require('fs');

const TOKEN_RE = /^--wc-[\w-]+$/;

// Built-in themes are always present and read-only (can't be saved over,
// modified, or deleted). "web-chat" is the original look: empty tokens, so every
// value comes from the CSS var() fallbacks baked into styles.css. Applying it
// is how you reset the surface to stock.
const BUILTIN_THEMES = [
  { name: 'web-chat', builtin: true, tokens: {}, css: '' },
];
function getBuiltin(name) {
  const n = String(name || '').toLowerCase();
  return BUILTIN_THEMES.find(t => t.name.toLowerCase() === n) || null;
}
function isBuiltinName(name) {
  return !!getBuiltin(name);
}

// A token value is a single CSS declaration value — strip the chars that could
// break out of `name: value;` so a token can't smuggle extra rules.
function sanitizeTokens(tokens) {
  const out = {};
  if (tokens && typeof tokens === 'object') {
    for (const [k, v] of Object.entries(tokens)) {
      if (!TOKEN_RE.test(k)) continue;
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      out[k] = String(v).replace(/[{}<>;]/g, '').trim();
    }
  }
  return out;
}

function normalizeTheme(t) {
  const out = { tokens: sanitizeTokens(t && t.tokens) };
  if (t && t.name) out.name = String(t.name);
  if (t && typeof t.css === 'string') out.css = t.css;
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
function mergeTokens(...layers) {
  const tokens = {};
  for (const l of layers) if (l && l.tokens) Object.assign(tokens, l.tokens);
  return tokens;
}

// Concatenate the raw-CSS escape hatches that apply to chrome (global + node),
// least-specific first so node rules can override global ones by source order.
function mergeCss(...layers) {
  const parts = [];
  for (const l of layers) if (l && typeof l.css === 'string' && l.css.trim()) parts.push(l.css);
  return parts.join('\n');
}

module.exports = { sanitizeTokens, normalizeTheme, readTheme, resolveDefault, mergeTokens, mergeCss, TOKEN_RE, BUILTIN_THEMES, getBuiltin, isBuiltinName };
