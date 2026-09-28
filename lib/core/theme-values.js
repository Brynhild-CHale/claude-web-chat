// What a theme token's VALUE becomes on the way to the page, and what it may
// not reach for once it gets there.
//
// sanitizeTokenValue keeps a token to one declaration value — it cannot open a
// rule or a second declaration — but a single value can still make the browser
// fetch: `--wc-depth-radial: url(https://tracker.example/p.png)` is one
// declaration, and the chrome paints that token as a background. The chrome has
// no CSP, and an export inlines the tokens, so every page load (and every
// recipient opening a shared .html) would tell the value's host who looked and
// when. A token value from someone else — an installed theme pack — may not
// carry any of these; a builtin never needs one.
//
// Two functions, one module, here in core because lib/packs may not import
// lib/server. The STRIP (sanitizeTokenValue) runs on every token, through
// lib/server/theme.js sanitizeTokens. The REFUSAL (refusedTokenValue and the two
// map walkers) runs only in the pack planner (lib/packs/themes.js), at plan
// time: the engine does not re-check it, so a local set_theme / save_theme /
// POST /api/theme(s) value carrying url() is stored and painted — local writers
// are trusted, and remote ones are refused by lib/core/remote-policy. The strip
// and the refusal live side by side on purpose: the strip DELETES characters,
// and deleting characters can assemble a function name the shipped value never
// spelled (`ur;l(` is painted as `url(`), so a refusal that judged only the
// shipped value would pass what the page then fetches. The refusal judges the
// painted value as well as the shipped one.
//
// A backslash is refused with the rest: CSS escapes are resolved inside function
// names (`\75rl(` is `url(`), so without it every pattern below is one escape
// away from not matching.

// A token is one CSS declaration value. `{ } < > ;` could close it, open a rule
// or a second declaration, or close the <style> it is baked into, so they are
// dropped; a line break becomes a space so `0 1px\n2px` stays two lengths rather
// than fusing into `1px2px`. Every token that reaches a page goes through this.
function sanitizeTokenValue(value) {
  return String(value).replace(/[{}<>;]/g, '').replace(/[\r\n]+/g, ' ').trim();
}

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

// Why `value` may not be a token value, or null when it may. Both forms are
// judged: the value as shipped, and the value sanitizeTokenValue paints.
function refusedTokenValue(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const shipped = String(value);
  const painted = sanitizeTokenValue(shipped);
  const hit = REFUSED.find((r) => r.re.test(shipped) || r.re.test(painted));
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

// Every entry in a token map whose value the strip would CHANGE — a `{ } < > ;`
// dropped or a line break folded (surrounding whitespace aside) — as
// [{ token, painted }]. No colour, length, font stack or gradient needs one, and
// a value that changes on its way to the page is not the value a reviewer was
// shown: the pack planner refuses these outright.
function alteredTokens(tokens) {
  const out = [];
  if (!tokens || typeof tokens !== 'object') return out;
  for (const [token, v] of Object.entries(tokens)) {
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const painted = sanitizeTokenValue(v);
    if (painted !== String(v).trim()) out.push({ token, painted });
  }
  return out;
}

module.exports = { sanitizeTokenValue, refusedTokenValue, refusedTokens, alteredTokens };
