// What a theme token's VALUE may not reach for.
//
// sanitizeTokens (lib/server/theme.js) keeps a token to one declaration value —
// it cannot open a rule or a second declaration — but a single value can still
// make the browser fetch: `--wc-depth-radial: url(https://tracker.example/p.png)`
// is one declaration, and the chrome paints that token as a background. The
// chrome has no CSP, and an export inlines the tokens, so every page load (and
// every recipient opening a shared .html) would tell the value's host who looked
// and when. A token value from someone else — an installed theme pack — may not
// carry any of these; a builtin never needs one.
//
// ONE rule, here in core because both the pack planner (lib/packs, which may not
// import lib/server) and the theme engine read it. A backslash is refused with
// them: CSS escapes are resolved inside function names (`\75rl(` is `url(`), so
// without it every pattern below is one escape away from not matching.

const REFUSED = [
  { re: /\burl\s*\(/i, what: 'url(…)' },
  { re: /\bsrc\s*\(/i, what: 'src(…)' },
  { re: /image-set\s*\(/i, what: 'image-set(…)' },
  { re: /\bimage\s*\(/i, what: 'image(…)' },
  { re: /cross-fade\s*\(/i, what: 'cross-fade(…)' },
  { re: /\bexpression\s*\(/i, what: 'expression(…)' },
  { re: /@import/i, what: '@import' },
  { re: /javascript\s*:/i, what: 'javascript:' },
  { re: /\\/, what: 'a backslash escape' },
];

// Why `value` may not be a token value, or null when it may.
function refusedTokenValue(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value);
  const hit = REFUSED.find((r) => r.re.test(s));
  return hit ? hit.what : null;
}

// Every refused entry in a token map, as [{ token, what }] — empty when clean.
function refusedTokens(tokens) {
  const out = [];
  if (!tokens || typeof tokens !== 'object') return out;
  for (const [token, v] of Object.entries(tokens)) {
    const what = refusedTokenValue(v);
    if (what) out.push({ token, what });
  }
  return out;
}

module.exports = { refusedTokenValue, refusedTokens };
