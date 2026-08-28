// Capture profile registry.
//
// A profile distills a captured page's raw DOM into a small, agent-friendly
// payload BEFORE it reaches Claude's context. Each profile module exports:
//   { name, description, match(url, html), extract({ url, html, root }) }
// where `root` is the node-html-parser parse of `html` (shared so each capture
// parses once).
//
// Ordering matters: the FIRST profile whose match() returns true wins, so list
// specific profiles before the catch-all `default`. An explicit `hint` (the
// profile name) overrides matching entirely.

const { parse } = require('node-html-parser');
const fs = require('fs');
const path = require('path');
const { collapse, absolutize, safeHref } = require('./util');
const { escapeHtml } = require('../../core/html');
// The cache-busting require idiom lives once in lib/core/resources (Phase 5) —
// used here so an edited/re-saved bundle file (extract.js / pane.js) is picked up
// on a live reload (loadUserProfiles re-call) instead of serving the stale module.
const { freshRequire } = require('../../core/resources');

// Built-in profiles: specific first; `default` (match: () => true) must be last.
// These ship in the repo and are the LOWEST resolution tier — the always-on
// passive distillation layer beneath any user-defined AND bundled profiles.
// Builtins carry no matchers/panes and resolve() reports them matched:false
// (Contract 7) — so they never offer the extension's consent button.
// Order: tables → article → default. `article` is the content-matched rich
// generic (structured blocks) slotted ABOVE default and BELOW tables; `default` is
// the flat-text catch-all and MUST stay last. Both carry `simplified_pane: true`
// so capture/pane.js renders the reader-lite pane (simplify.js) for them.
const builtins = [
  require('./tables'),
  require('./article'),
  require('./default'),
];

// Bundled profiles: full profile bundles ({profile.json, extract.js, pane.js})
// that SHIP with the package under lib/capture/profiles/bundled/<name>/.
// They load through the SAME machinery as user profiles (loadUserProfiles), so
// they keep matchers[], panes, and matched:true consent-button semantics —
// unlike builtins. The loader SCANS this dir, so adding a bundle is just dropping
// a dir here (no name list to touch). A user re-authoring the same name at
// project/global scope shadows the bundled one entirely.
const BUNDLED_DIR = path.join(__dirname, 'bundled');

// User-defined + bundled profiles, loaded by loadUserProfiles() at boot from the
// project dir (.web-chat/profiles), the global dir (~/.web-chat/profiles), and
// the package's bundled dir — in that precedence order. Project-first; a project
// profile shadows a same-named global one, and either shadows a same-named
// bundled one entirely.
let userProfiles = [];

// Full resolution list: user + bundled profiles ahead of builtins. Per-scope
// precedence (project > global > bundled) is enforced in resolve(), not by this
// array's order.
function all() { return [...userProfiles, ...builtins]; }

// Tiers whose match offers the extension's "Capture with <name>" consent button
// (resolve() → matched:true). Builtins (`tables`/`default`) are excluded — they
// are the always-on passive fallback, not a declared per-site profile (Contract 7).
const MATCHED_TIERS = new Set(['project', 'global', 'bundled']);

function safeParse(html) {
  try {
    return parse(String(html || ''), { blockTextElements: { script: false, style: false } });
  } catch {
    return null;
  }
}

function byName(name) {
  return all().find((p) => p.name === name) || null;
}

function defaultProfile() {
  return builtins.find((p) => p.name === 'default') || builtins[builtins.length - 1];
}

// Score how specifically a profile's matchers match a URL. 0 = no match.
// Specificity: regex(3) > domain-glob(2) > bare-domain(1) — higher wins within a
// tier. `matchers` is an OR list of { type:'domain'|'regex', value }.
function matchScore(profile, url) {
  const matchers = (profile && profile.matchers) || [];
  if (!matchers.length) return 0;
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  let best = 0;
  for (const m of matchers) {
    if (!m || !m.value) continue;
    if (m.type === 'regex') {
      try { if (new RegExp(m.value).test(url)) best = Math.max(best, 3); } catch {}
    } else if (m.type === 'domain') {
      const v = String(m.value);
      if (v.includes('*')) {
        try {
          const re = new RegExp('^' + v.replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$');
          if (re.test(host)) best = Math.max(best, 2);
        } catch {}
      } else if (host === v || host.endsWith('.' + v)) {
        best = Math.max(best, 1);
      }
    }
  }
  return best;
}

// ── the one bundle loader ───────────────────────────────────────────────────
//
// There used to be two. The daemon's (loadUserProfiles) validated nothing but
// "extract.js exports a function", so a `{type:'domian'}` matcher or an
// uncompilable regex loaded silently and never matched; the CLI's
// (`profile validate`, which the /capture-profile skill gates every save on)
// had the real checks — and the two disagreed on three points. validate FAILED
// a bundle with no `name` that the daemon accepts by falling back to the
// directory name; validate PASSED a bundle named `default` that the daemon
// silently skips; validate REJECTED an unknown matcher `type` the daemon
// tolerated. A validator that says ✓ for a bundle the server will never load is
// worse than no validator. One loader, one verdict.

const MATCHER_TYPES = new Set(['domain', 'regex']);
const PANE_MODES = new Set(['reduced', 'expanded']);
const DEDUPE_BY = new Set(['url', 'profile']);

// Structural check on a profile.json. Returns a list of human-readable problems
// — empty means the bundle is loadable. Never throws.
function validateMeta(meta) {
  const errors = [];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return ['profile.json: must be a JSON object'];
  }
  if (meta.name != null) {
    if (typeof meta.name !== 'string' || !meta.name.trim()) {
      errors.push('profile.json: "name" must be a non-empty string');
    } else if (meta.name === 'default') {
      // `default` is the catch-all builtin every capture falls back to; a
      // profile that took the name would shadow it for every page.
      errors.push('profile.json: "default" is reserved for the builtin catch-all');
    }
  }
  if (meta.matchers != null) {
    if (!Array.isArray(meta.matchers)) {
      errors.push('profile.json: "matchers" must be an array');
    } else {
      for (const m of meta.matchers) {
        if (!m || typeof m !== 'object' || !MATCHER_TYPES.has(m.type)) {
          errors.push(`matcher: type must be 'domain' or 'regex' (got ${JSON.stringify(m && m.type)})`);
        } else if (!m.value || typeof m.value !== 'string') {
          errors.push(`matcher: missing value for ${m.type} matcher`);
        } else if (m.type === 'regex') {
          try { new RegExp(m.value); } catch (e) { errors.push(`matcher: bad regex /${m.value}/: ${e.message}`); }
        }
      }
    }
  }
  const pane = meta.pane;
  if (pane != null) {
    if (typeof pane !== 'object' || Array.isArray(pane)) {
      errors.push('profile.json: "pane" must be an object');
    } else {
      if (pane.default_mode != null && !PANE_MODES.has(pane.default_mode)) {
        errors.push(`profile.json: pane.default_mode must be 'reduced' or 'expanded' (got ${JSON.stringify(pane.default_mode)})`);
      }
      if (pane.dedupe_by != null && !DEDUPE_BY.has(pane.dedupe_by)) {
        errors.push(`profile.json: pane.dedupe_by must be 'url' or 'profile' (got ${JSON.stringify(pane.dedupe_by)})`);
      }
      if (pane.mount_suffix != null && (typeof pane.mount_suffix !== 'string' || !pane.mount_suffix.trim())) {
        errors.push('profile.json: pane.mount_suffix must be a non-empty string');
      }
    }
  }
  if (meta.interact != null && (typeof meta.interact !== 'object' || Array.isArray(meta.interact))) {
    errors.push('profile.json: "interact" must be an object');
  }
  return errors;
}

// Read + validate + require one bundle directory. Returns everything both
// callers need and NEVER throws: the daemon logs the errors and skips the
// bundle, the CLI prints them as ✗ lines and exits 1.
//
// Modules always load through freshRequire — an edited bundle must be picked up
// by `profile reload` without a restart, and in the one-shot CLI process
// cache-busting is a no-op, so there is nothing for a second mode to be for.
function loadBundle(dir) {
  const fallbackName = path.basename(dir);
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8'));
  } catch (e) {
    return { meta: null, name: fallbackName, extract: null, pane: null, errors: [`profile.json: ${(e && e.message) || e}`] };
  }

  const errors = validateMeta(meta);
  // The daemon has always fallen back to the directory name, and user bundles
  // rely on it; the CLI used to reject the same bundle outright.
  const name = (typeof meta.name === 'string' && meta.name.trim()) || fallbackName;

  let extract = null;
  try {
    const em = freshRequire(path.resolve(dir, 'extract.js'));
    const fn = typeof em === 'function' ? em : (em && em.extract);
    if (typeof fn !== 'function') throw new Error('must export a function or { extract }');
    extract = fn;
  } catch (e) {
    errors.push(`extract.js: ${(e && e.message) || e}`);
  }

  let pane = null;
  const paneFile = path.resolve(dir, 'pane.js');
  if (fs.existsSync(paneFile)) {
    try {
      const p = freshRequire(paneFile);
      if (!p || typeof p.render !== 'function') throw new Error('must export { render }');
      pane = p;
    } catch (e) {
      errors.push(`pane.js: ${(e && e.message) || e}`);
    }
  }

  return { meta, name, extract, pane, errors };
}

// Normalize a loaded user-profile bundle into the runtime shape. We synthesize a
// match(url) from `matchers` so byName/inspectRaw/pickProfile treat user and
// builtin profiles uniformly (builtins carry their own code match()).
function normalize({ meta, name, scope, dir, extract, pane }) {
  const matchers = Array.isArray(meta.matchers) ? meta.matchers : [];
  const paneMeta = meta.pane || {};
  const prof = {
    name,
    description: meta.description || '',
    scope,
    dir,
    matchers,
    extract,
    pane: pane && typeof pane.render === 'function' ? pane : null,
    interact: meta.interact || null,
    default_mode: paneMeta.default_mode === 'expanded' ? 'expanded' : 'reduced',
    mount_suffix: paneMeta.mount_suffix || name,
    // How the capture pane is keyed (Fix #2). 'url' (default) → one pane per
    // distinct page, so capturing N pages of the same profile yields N coexisting
    // panes; 'profile' → a single pane that every capture of this profile replaces
    // in place (dashboard-style). Builtins carry no dedupe_by and default to 'url'.
    dedupe_by: paneMeta.dedupe_by === 'profile' ? 'profile' : 'url',
  };
  prof.match = (url) => matchScore(prof, url) > 0;
  return prof;
}

// Load user + bundled profiles from the project, global, then bundled dirs
// (called once at boot, and again on `profile reload`). Project-first so a
// same-named project profile shadows the global one, and either shadows a
// same-named bundled one entirely (the `seen` guard skips a later same-named
// bundle). The bundled dir is package-static (scanned, not passed in), so
// reload re-reads it from the package too. Resilient: a bad bundle (malformed or
// invalid profile.json, throwing require, no extract, an unrenderable pane) is
// logged and SKIPPED so one broken profile can never wedge server boot — and
// what counts as bad is loadBundle's verdict, the same one `profile validate`
// reports. Returns the count loaded (user + bundled).
// Same-process re-call rebuilds the list fresh.
function loadUserProfiles(paths) {
  userProfiles = [];
  const seen = new Set();
  const usedSuffix = new Map(); // mount_suffix -> profile name, to catch collisions
  const tiers = [
    ['project', paths && paths.PROFILES_DIR],
    ['global', paths && paths.SYSTEM_PROFILES_DIR],
    ['bundled', BUNDLED_DIR],
  ];
  for (const [scope, dir] of tiers) {
    if (!dir || !fs.existsSync(dir)) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const bundle = path.join(dir, ent.name);
      const { meta, name, extract, pane, errors } = loadBundle(bundle);
      if (errors.length) {
        console.error(`[profiles] skipped '${ent.name}' in ${dir}: ${errors.join('; ')}`);
        continue;
      }
      // Project tier (seen first) shadows a same-named global entry entirely.
      if (seen.has(name)) continue;
      const prof = normalize({ meta, name, scope, dir: bundle, extract, pane });
      // Guard explicit mount_suffix collisions across differently-named profiles
      // (defaults are name-derived, so unique). The old fallback was a no-op for
      // the case it logged — profile `a` with mount_suffix 'b' plus a profile
      // actually NAMED 'b' both landed on 'b', and their capture panes clobbered
      // each other silently. Walk to a suffix that is genuinely free.
      if (usedSuffix.has(prof.mount_suffix) && usedSuffix.get(prof.mount_suffix) !== name) {
        const collidesWith = usedSuffix.get(prof.mount_suffix);
        let candidate = name;
        for (let n = 2; usedSuffix.has(candidate) && usedSuffix.get(candidate) !== name; n++) {
          candidate = `${name}-${n}`;
        }
        console.error(`[profiles] mount_suffix '${prof.mount_suffix}' of '${name}' collides with '${collidesWith}' — using '${candidate}'`);
        prof.mount_suffix = candidate;
      }
      usedSuffix.set(prof.mount_suffix, name);
      userProfiles.push(prof);
      seen.add(name);
    }
  }
  return userProfiles.length;
}

// Single source of truth for "which profile handles this capture". Precedence:
//   explicit hint (any tier) > project (most-specific URL match) >
//   global (most-specific) > bundled (most-specific) > builtin code-match
//   (tables) > default.
// Returns { profile, matched, tier }. `matched` is true ONLY when a user-defined
// OR bundled profile (or a hint resolving to one) matched — the built-in
// distillers (`tables`/`default`) are the passive fallback layer and do NOT count
// as a match for offering the extension's profile button (Contract 7: `tables`
// fires on any page with a <table>, which would make the button pure noise).
// Bundled profiles DO count (they carry matchers + panes, so "Capture with
// <name>" is meaningful). `profile` is still always set to the distiller that
// will run, builtin or not.
function resolve({ url = '', html = '', hint } = {}) {
  if (hint) {
    const named = byName(hint);
    if (named) {
      const tier = named.scope || 'builtin';
      return { profile: named, matched: MATCHED_TIERS.has(tier), tier };
    }
  }
  for (const scope of ['project', 'global', 'bundled']) {
    let bestP = null, bestS = 0;
    for (const p of userProfiles) {
      if (p.scope !== scope) continue;
      const s = matchScore(p, url);
      if (s > bestS) { bestS = s; bestP = p; }
    }
    if (bestP) return { profile: bestP, matched: true, tier: scope };
  }
  for (const p of builtins) {
    if (p.name === 'default') continue;
    try { if (p.match && p.match(url, html)) return { profile: p, matched: false, tier: 'builtin' }; } catch {}
  }
  return { profile: defaultProfile(), matched: false, tier: 'default' };
}

// Choose a profile for a capture (the distiller that will run). Delegates to
// resolve() so there is exactly one precedence implementation.
function pickProfile(opts = {}) {
  return resolve(opts).profile;
}

// The helper kit every extractor and pane is handed on its ctx.
//
// This is the ONLY way a profile can reach a shared helper. A user bundle lives
// in .web-chat/profiles/<name>/ or ~/.web-chat/profiles/<name>/ — outside the
// package, with no stable require path back into it — so "import the engine" is
// not available to one, and the bundled profiles are the exemplars users copy.
// Before this existed, `esc` was hand-declared nine times across the bundles
// (four character sets' worth of the same idea), each bundle re-declared
// `collapse` under the name `clean`, and three of them carried their own
// `absolutize` with three different sets of rules — one of which is how
// `javascript:` reached an href.
//
// `esc` is lib/core/html's five-character escaper: & < > " ' — safe in an
// attribute value as well as a text node, which the four-character copies were
// not, and they were used for `href=` too.
const CTX_HELPERS = { esc: escapeHtml, collapse, absolutize, safeHref };

// Run a profile against a capture. Resilience: a profile that throws falls back
// to the default text extraction so a capture is never lost to a buggy extractor;
// the result records what it fell back from.
function runProfile(profile, { url = '', html = '' }) {
  const root = safeParse(html);
  try {
    const distilled = profile.extract({ url, html, root, ...CTX_HELPERS });
    return { profile: profile.name, distilled };
  } catch (e) {
    const def = defaultProfile();
    const distilled = def.extract({ url, html, root: root || safeParse(html), ...CTX_HELPERS });
    return {
      profile: def.name,
      distilled,
      fell_back_from: profile.name,
      error: String((e && e.message) || e),
    };
  }
}

// Scoped inspection of a capture's RAW DOM — the backing for inspect_capture.
// Returns only the requested slice so drilling into a capture never dumps the
// whole (out-of-context) blob back into context.
//   { selector } → matching elements (tag/text/html, capped)
//   { query }    → text occurrences with surrounding context windows
//   { profile }  → re-run a named profile over the raw
// Returns null when no scoping param is given (caller serves the full raw).
//
// `url` is the captured page's URL and is threaded straight into runProfile. It
// used not to be a parameter at all, so the profile re-run — the authoring
// dry-run inspect_capture sells — ran every extractor with no URL: youtube's
// videoId and thumbnail came back null, reddit fell back to a hardcoded origin,
// and every distillate's own `url` field was ''. Callers hold rec.url; pass it.
function inspectRaw(html, { url = '', selector, query, profile, max = 20, context = 200 } = {}) {
  if (profile) {
    const p = byName(profile);
    if (!p) return { mode: 'profile', error: `unknown profile '${profile}'` };
    return { mode: 'profile', profile: p.name, result: runProfile(p, { url, html }).distilled };
  }
  if (selector) {
    const root = safeParse(html);
    if (!root) return { mode: 'selector', selector, count: 0, matches: [], error: 'parse failed' };
    let els;
    try {
      els = root.querySelectorAll(selector);
    } catch (e) {
      return { mode: 'selector', selector, count: 0, matches: [], error: String((e && e.message) || e) };
    }
    const matches = els.slice(0, max).map((e) => ({
      tag: e.rawTagName,
      text: collapse(e.text).slice(0, 2000),
      html: e.outerHTML.slice(0, 4000),
    }));
    return { mode: 'selector', selector, total: els.length, count: matches.length, matches };
  }
  if (query) {
    const root = safeParse(html);
    const text = collapse(root ? root.text : html);
    const q = String(query);
    const lc = text.toLowerCase();
    const lq = q.toLowerCase();
    const snippets = [];
    let idx = 0;
    while (snippets.length < max) {
      const at = lc.indexOf(lq, idx);
      if (at === -1) break;
      snippets.push(text.slice(Math.max(0, at - context), at + q.length + context));
      idx = at + q.length;
    }
    return { mode: 'query', query: q, count: snippets.length, snippets };
  }
  return null;
}

function listProfiles() {
  return all().map((p) => ({
    name: p.name,
    description: p.description,
    scope: p.scope || 'builtin',
    has_pane: !!p.pane,
    has_interaction: !!(p.interact && Array.isArray(p.interact.steps) && p.interact.steps.length),
    matchers: p.matchers || null,
  }));
}

module.exports = {
  pickProfile, resolve, runProfile, inspectRaw, listProfiles, safeParse,
  loadUserProfiles, loadBundle, validateMeta, matchScore, getProfile: byName,
  CTX_HELPERS,
};
