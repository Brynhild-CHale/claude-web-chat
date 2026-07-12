// lib/core/resources.js — the tiered resource registry (refactor Phase 5).
//
// A NARROW engine: it owns only the directory-tier list / get / save / resolve
// skeleton that themes' named library and components genuinely share. It knows
// nothing type-specific — no tokens, no URL matching, no mount side-effects. Each
// resource type injects its own `load` (path → record) and `write` (persist a
// payload); the engine walks tiers most-specific-first, unions a `list`, and
// resolves a name to its most-specific tier (falling through to in-code builtins).
//
// Deliberately does NOT try to serve profiles' public API (profiles select by URL
// and run executable bundles — not a name-keyed registry) nor themes' resolveDefault
// cascade / token sanitization / scope materialization. Those stay in their own
// modules — the engine stays "narrow, not universal": it consolidates only the
// shared directory-tier skeleton, never the type-specific behavior.
//
// Dependency direction: imports only Node builtins — nothing from lib/ above core.
// Tripwire-clean: none of the three banned constructs the conventions test
// ratchets. `freshRequire` deletes from require.cache, which is not one of them.

const fs = require('fs');
const path = require('path');

// The single home for the require-cache-busting reload idiom (lifted from
// lib/capture/profiles). Loading a fresh copy of an executable resource bundle.
function freshRequire(file) {
  try { delete require.cache[require.resolve(file)]; } catch {}
  return require(file);
}

// tiers: ordered [{ tier, dir }] MOST-SPECIFIC FIRST (dir may be undefined → the
//   tier is skipped, e.g. a system tier before the user dir exists).
// builtins: in-code read-only records [{ name, ... }], listed but never on disk.
// load(entryPath, { tier, name }) → record | null  (null = not a valid entry;
//   this is also the uniform list() filter, so a stray file/dir is skipped).
// file: optional (name) → basename; when set the entry is a single file
//   (dir/file(name)), else the entry is a directory (dir/name).
// write: optional (dir, name, payload) → void, for save().
function resourceRegistry({ name = 'resource', tiers = [], builtins = [], load, file, write } = {}) {
  if (typeof load !== 'function') throw new Error(`resourceRegistry(${name}): load is required`);

  const dirFor = (tier) => {
    const t = tiers.find((x) => x.tier === tier);
    return t ? t.dir : undefined;
  };
  const entryPath = (dir, n) => path.join(dir, file ? file(n) : n);

  // Resolve by NAME, most-specific tier first, then in-code builtins. Returns
  // { record, tier } (tier tells the caller the provenance) or null.
  function get(n) {
    for (const t of tiers) {
      if (!t.dir) continue;
      const p = entryPath(t.dir, n);
      if (!fs.existsSync(p)) continue;
      const record = load(p, { tier: t.tier, name: n });
      if (record != null) return { record, tier: t.tier };
    }
    const b = builtins.find((x) => x.name === n);
    return b ? { record: b, tier: 'builtin' } : null;
  }

  // Flat union across builtins + every tier dir, each entry tagged with its
  // `tier`. Reads dirs fresh per call. `load` returning null filters non-entries
  // (wrong file type, malformed, missing sidecar) uniformly — a bad entry is
  // skipped, never fatal. No cross-tier dedup by name (a local and a system entry
  // of the same name both appear — matching themes' current behavior).
  function list() {
    const out = builtins.map((b) => ({ ...b, tier: 'builtin' }));
    for (const t of tiers) {
      if (!t.dir) continue;
      let names;
      try { names = fs.readdirSync(t.dir); } catch { continue; }
      for (const entry of names) {
        const record = load(path.join(t.dir, entry), { tier: t.tier, name: entry });
        if (record != null) out.push({ ...record, tier: t.tier });
      }
    }
    return out;
  }

  // Write a payload to a chosen tier's dir (mkdir -p first). The caller owns
  // name validation + reserved-name policy (type-specific messages stay in the
  // route). Returns { ok, path }.
  function save(n, payload, { tier } = {}) {
    const dir = dirFor(tier);
    if (!dir) throw new Error(`resourceRegistry(${name}): unknown tier '${tier}'`);
    fs.mkdirSync(dir, { recursive: true });
    write(dir, n, payload);
    return { ok: true, path: entryPath(dir, n) };
  }

  return { get, list, save, dir: dirFor, tiers };
}

module.exports = { resourceRegistry, freshRequire };
