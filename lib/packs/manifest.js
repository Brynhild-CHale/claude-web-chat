// Reading a pack's own description of itself, and deciding whether it is one.
//
// Everything here is a pure read over a staged tree — no writes, no network. It
// answers three questions:
//
//   1. Is `web-chat-pack.json` well-formed, and does it name components that
//      actually exist in the tree?
//   2. Does this build satisfy the pack's `requires`?
//   3. What does SKILL.md tell Claude? — the frontmatter description is the
//      highest-leverage text in the whole pack (it is what sits in Claude's
//      context from session start), and it is also the thing nobody thinks to
//      read before installing. So it is parsed here and surfaced by the drawer.
//
// Two name policies live here, and neither is negotiable:
//
//   * A BUILTIN component name is a hard refusal, either tier, either actor, no
//     override. lib/server/builtins.seedBuiltins only refreshes a directory
//     whose meta.json says `builtin: true`, so a pack shadowing `git-dashboard`
//     would win permanently — the real builtin would never come back.
//   * A skill name web-chat itself manages is a hard refusal too, for the
//     opposite reason: the next `install`/`update` reconcile would silently
//     revert it, which is worse than saying no. The reserved list is DERIVED
//     from MANAGED_FILES rather than re-typed.

const fs = require('fs');
const path = require('path');
const { compareVersions } = require('../core/versions');
const { packageVersion } = require('../core/versions');
const { BUILTINS } = require('../server/builtins');
const { managedSkillNames } = require('../update/managed-files');

const MANIFEST_FILE = 'web-chat-pack.json';
const SKILL_FILE = 'SKILL.md';
const NAME_RE = /^[a-z][a-z0-9-]*$/;

function readIfPresent(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// Parse web-chat-pack.json out of a staged tree. Throws (userFacing) when the
// file is missing or is not JSON — those are the two "this is not a pack"
// answers, and they deserve to be said plainly rather than surfacing as a
// TypeError three functions later.
function parseManifest(stageDir) {
  const file = path.join(stageDir, MANIFEST_FILE);
  const text = readIfPresent(file);
  if (text == null) {
    const e = new Error(`no ${MANIFEST_FILE} at the root of this repository — it is not a component pack`);
    e.userFacing = true;
    throw e;
  }
  try {
    const json = JSON.parse(text);
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not an object');
    return json;
  } catch (err) {
    const e = new Error(`${MANIFEST_FILE} is not valid JSON: ${err.message}`);
    e.userFacing = true;
    throw e;
  }
}

// A deliberately small subset of the semver range grammar: `>=x.y.z`, `>`, `<=`,
// `<`, `=`/bare, `^`, `~`, and space-separated conjunctions of those. Anything
// it does not understand is treated as SATISFIED rather than as a failure — a
// pack must not become uninstallable because it used a range syntax this
// doesn't parse. Returns { ok, reason }.
function satisfies(version, range) {
  const r = String(range == null ? '' : range).trim();
  if (!r || r === '*') return { ok: true };
  // Split into clauses, but keep an operator attached to the version that
  // follows it. `">= 1.2.0"` is a perfectly ordinary way to write a range, and
  // splitting on whitespace alone turned it into TWO clauses: a bare `>=` that
  // matched nothing and was skipped as unknown, and a bare `1.2.0` that fell
  // through to the exact-match branch — pinning the pack to that one version and
  // making it uninstallable everywhere else. The precise inverse of the intent.
  const clauses = r.match(/(?:>=|<=|>|<|\^|~|=)?\s*v?\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?/g) || [];
  for (const raw of clauses) {
    const clause = raw.replace(/\s+/g, '');
    const m = clause.match(/^(>=|<=|>|<|\^|~|=)?\s*v?(\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?)$/);
    if (!m) continue;                       // not a shape we know — do not block
    const [, op = '=', want] = m;
    const cmp = compareVersions(version, want);
    let ok;
    if (op === '>=') ok = cmp >= 0;
    else if (op === '>') ok = cmp > 0;
    else if (op === '<=') ok = cmp <= 0;
    else if (op === '<') ok = cmp < 0;
    else if (op === '=') ok = cmp === 0;
    else if (op === '^') {
      const major = (v) => parseInt(String(v).replace(/^v/, '').split('.')[0], 10) || 0;
      const minor = (v) => parseInt(String(v).replace(/^v/, '').split('.')[1], 10) || 0;
      // Pre-1.0, ^ pins the minor — the npm rule, and the one pack authors mean.
      ok = cmp >= 0 && (major(want) === 0
        ? major(version) === 0 && minor(version) === minor(want)
        : major(version) === major(want));
    } else if (op === '~') {
      const parts = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
      const [wa, wb] = parts(want);
      const [va, vb] = parts(version);
      ok = cmp >= 0 && va === wa && vb === wb;
    }
    if (!ok) return { ok: false, reason: `needs web-chat ${clause}, this is ${version}` };
  }
  return { ok: true };
}

// The frontmatter of SKILL.md — the text Claude Code loads into context at
// session start. Deliberately a small hand parser rather than a YAML dependency:
// the two fields that matter are `name` and `description`, and a pack's
// frontmatter is a flat block. A multi-line description (the common case, since
// good descriptions are long) is folded the way YAML folds it.
//
// Returns { present, name, description, body, raw, error }.
function readSkillFrontmatter(stageDir) {
  const file = path.join(stageDir, SKILL_FILE);
  const raw = readIfPresent(file);
  if (raw == null) return { present: false, name: null, description: null, body: null, raw: null };

  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) {
    return { present: true, name: null, description: null, body: raw, raw, error: 'SKILL.md has no --- frontmatter block; Claude Code will not load it as a skill' };
  }
  const fields = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/);
    if (kv) { key = kv[1]; fields[key] = kv[2].trim(); continue; }
    if (key && /^\s+\S/.test(line)) fields[key] = `${fields[key]} ${line.trim()}`.trim();
  }
  const unquote = (s) => (s == null ? null : String(s).replace(/^['"]|['"]$/g, '').trim() || null);
  return {
    present: true,
    name: unquote(fields.name),
    description: unquote(fields.description),
    body: m[2],
    raw,
  };
}

// Reserved names, in one place each. BUILTINS comes from lib/server/builtins;
// the skill names are derived from the managed-file list.
function reservedComponentNames() { return BUILTINS.slice(); }
function reservedSkillNames() { return managedSkillNames(); }

// Validate a parsed manifest against the tree it came from. NEVER throws for a
// content problem — it returns { errors, warnings } so a caller (a route, the
// drawer's review card) can show every problem at once instead of the first one.
// Throwing is reserved for "this is not a pack at all", which parseManifest does.
function validateManifest(manifest, { stageDir, webChatVersion = packageVersion() } = {}) {
  const errors = [];
  const warnings = [];
  const m = manifest || {};

  const name = typeof m.name === 'string' ? m.name.trim() : '';
  if (!name) errors.push(`${MANIFEST_FILE}: "name" is required`);
  else if (!NAME_RE.test(name)) errors.push(`${MANIFEST_FILE}: "name" must be kebab-case (got ${JSON.stringify(name)})`);
  else if (reservedSkillNames().includes(name)) {
    errors.push(`"${name}" is a skill name web-chat manages itself — the next \`claude-web-chat install\` would revert it. Rename the pack.`);
  }

  const version = m.version == null ? null : String(m.version);
  if (!version) warnings.push(`${MANIFEST_FILE}: no "version" — \`pack list\` will have nothing to show`);

  const req = (m.requires && m.requires['web-chat']) || null;
  if (req) {
    const sat = satisfies(webChatVersion, req);
    if (!sat.ok) errors.push(`this pack ${sat.reason}`);
  }

  const listed = Array.isArray(m.components) ? m.components : [];
  if (!Array.isArray(m.components)) errors.push(`${MANIFEST_FILE}: "components" must be an array of directory names`);
  const components = [];
  const seen = new Set();
  for (const raw of listed) {
    const c = typeof raw === 'string' ? raw.trim() : '';
    if (!c) { errors.push(`${MANIFEST_FILE}: "components" contains an entry that is not a name`); continue; }
    if (!NAME_RE.test(c)) { errors.push(`component "${c}": names must be kebab-case`); continue; }
    if (seen.has(c)) { errors.push(`component "${c}" is listed twice`); continue; }
    seen.add(c);
    if (reservedComponentNames().includes(c)) {
      // The sharp edge. No override exists for this, deliberately.
      errors.push(`component "${c}" is a built-in name. Installing it would shadow the built-in permanently — web-chat only repairs a component whose meta.json says builtin, and a pack's does not. Refused; there is no override.`);
      continue;
    }
    const dir = stageDir ? path.join(stageDir, 'components', c) : null;
    if (dir && !fs.existsSync(path.join(dir, 'component.html'))) {
      errors.push(`component "${c}": components/${c}/component.html is missing`);
      continue;
    }
    let meta = null;
    if (dir) {
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); }
      catch { warnings.push(`component "${c}": meta.json is missing or unreadable — it will list with no description`); }
    }
    if (meta && meta.name && meta.name !== c) {
      warnings.push(`component "${c}": meta.json says name "${meta.name}". The directory name is the identity; the mismatch is shown in the drawer.`);
    }
    components.push({
      name: c,
      description: (meta && meta.description) || '',
      params_schema: (meta && meta.params_schema) || {},
      meta_name: (meta && meta.name) || null,
      has_seed: Boolean(dir && fs.existsSync(path.join(dir, 'seed.js'))),
      has_service: Boolean(dir && fs.existsSync(path.join(dir, 'service.js'))),
    });
  }
  if (!errors.length && !components.length) {
    warnings.push(`${MANIFEST_FILE}: lists no components — only the skill would be installed`);
  }

  const themeList = Array.isArray(m.themes) ? m.themes : [];
  const themes = [];
  for (const raw of themeList) {
    const th = typeof raw === 'string' ? raw.trim() : '';
    if (!th || !NAME_RE.test(th)) { errors.push(`theme "${raw}": names must be kebab-case`); continue; }
    if (stageDir && !fs.existsSync(path.join(stageDir, 'themes', `${th}.json`))) {
      errors.push(`theme "${th}": themes/${th}.json is missing`);
      continue;
    }
    themes.push({ name: th });
  }

  const skill = stageDir ? readSkillFrontmatter(stageDir) : { present: false };
  if (!skill.present) {
    warnings.push('no SKILL.md — the components install, but Claude only learns they exist by calling list_components. A pack without a skill is a directory of components.');
  } else if (skill.error) {
    warnings.push(skill.error);
  } else if (!skill.description) {
    warnings.push('SKILL.md frontmatter has no `description` — that is the text Claude reads to decide the pack is relevant.');
  }

  return { ok: errors.length === 0, errors, warnings, name, version, description: m.description || '', components, themes, skill, requires: req };
}

// Is this string safe to use as a DIRECTORY NAME?
//
// A pack's `name` comes out of its own web-chat-pack.json — a file written by
// whoever published the repository — and it is used to build paths: the
// quarantine staging directory, the skill directory under .claude/skills/. It
// therefore has to be checked before it is joined to anything, and checked
// separately from validateManifest, because quarantine deliberately stages packs
// that FAILED validation (seeing why is the point of review) and so cannot rely
// on validation having refused a bad one.
//
// Without this, `{"name": "../../../../Users/me/Documents"}` made
// `pack get <url>` — or POST /api/packs/quarantine, which any pane script can
// call — recursively delete that directory and write the pack into it.
function assertSafeName(name, what = 'pack name') {
  const n = String(name == null ? '' : name);
  if (!NAME_RE.test(n)) {
    const e = new Error(`refusing this pack: its ${what} ${JSON.stringify(n)} is not a plain kebab-case name, and that name is used to build a directory path.`);
    e.userFacing = true;
    throw e;
  }
  return n;
}

module.exports = {
  MANIFEST_FILE,
  assertSafeName,
  SKILL_FILE,
  NAME_RE,
  parseManifest,
  validateManifest,
  readSkillFrontmatter,
  satisfies,
  reservedComponentNames,
  reservedSkillNames,
};
