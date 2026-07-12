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
const { collapse } = require('./util');
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
// so routes/capture.js renders the reader-lite pane (simplify.js) for them.
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

function optionalFreshRequire(file) {
  try { return freshRequire(file); } catch { return null; }
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
// reload re-reads it from the package too. Resilient: a bad bundle (malformed
// profile.json, throwing require, no extract) is logged and SKIPPED so one broken
// profile can never wedge server boot. Returns the count loaded (user + bundled).
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
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(bundle, 'profile.json'), 'utf8'));
        const name = meta.name || ent.name;
        // Never let a user profile shadow the `default` catch-all; project tier
        // (seen first) shadows a same-named global entry entirely.
        if (name === 'default' || seen.has(name)) continue;
        const em = freshRequire(path.join(bundle, 'extract.js'));
        const extract = typeof em === 'function' ? em : (em && em.extract);
        if (typeof extract !== 'function') throw new Error('extract.js must export a function or { extract }');
        const pane = optionalFreshRequire(path.join(bundle, 'pane.js'));
        const prof = normalize({ meta, name, scope, dir: bundle, extract, pane });
        // Guard explicit mount_suffix collisions across differently-named profiles
        // (defaults are name-derived, so unique). On collision, fall back to name.
        if (usedSuffix.has(prof.mount_suffix) && usedSuffix.get(prof.mount_suffix) !== name) {
          console.error(`[profiles] mount_suffix '${prof.mount_suffix}' of '${name}' collides with '${usedSuffix.get(prof.mount_suffix)}' — using '${name}'`);
          prof.mount_suffix = name;
        }
        usedSuffix.set(prof.mount_suffix, name);
        userProfiles.push(prof);
        seen.add(name);
      } catch (e) {
        console.error(`[profiles] skipped '${ent.name}' in ${dir}: ${(e && e.message) || e}`);
      }
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

// Run a profile against a capture. Resilience: a profile that throws falls back
// to the default text extraction so a capture is never lost to a buggy extractor;
// the result records what it fell back from.
function runProfile(profile, { url = '', html = '' }) {
  const root = safeParse(html);
  try {
    const distilled = profile.extract({ url, html, root });
    return { profile: profile.name, distilled };
  } catch (e) {
    const def = defaultProfile();
    const distilled = def.extract({ url, html, root: root || safeParse(html) });
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
function inspectRaw(html, { selector, query, profile, max = 20, context = 200 } = {}) {
  if (profile) {
    const p = byName(profile);
    if (!p) return { mode: 'profile', error: `unknown profile '${profile}'` };
    return { mode: 'profile', profile: p.name, result: runProfile(p, { html }).distilled };
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
  loadUserProfiles, matchScore, getProfile: byName,
};
