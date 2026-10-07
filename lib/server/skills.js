// lib/server/skills.js — the composer's `/` catalog (spec §6.2, U58).
//
// What a `/` in the composer offers: the skills Claude can run with the Skill
// tool in the target conversation, and nothing else. Picking one asks Claude to
// run it; it is not a terminal command.
//
//   catalog({root, listing, sessionStart, redactor, now})
//     → Promise<{skills: [{name, description, origin}], source: 'session'|'disk', partial, as_of}>
//   createSkillCatalog({root, mirror, redactor, ttlMs = 5000, now})
//     → {catalog(conversationId), resolve(name, {conversation_id}), lookup(name, conversationId), clear()}
//
// `listing` is mirror.skillFold(cid)'s answer as it is ({names, descriptions,
// orgUuid}), or null; `sessionStart` is the started_at of the conversation's
// current session, or null.
//
// THE FIVE STEPS (§6.2, validation V8):
//   1. The base set is the listing's names: Claude Code's `skill_listing` is the
//      model-invocable set by construction.
//   2. Disk sources, in this order: the project's .claude/skills/*/SKILL.md, the
//      user's skills/*/SKILL.md (its `synced` directory is a bucket, not a
//      skill), the project's then the user's commands/*.md, each installed and
//      enabled plugin's skills/*/SKILL.md and commands/*.md, then the synced
//      skills and synced plugins of the chosen bucket.
//   3. Reconcile: a listed name is kept (with no disk source it is a built-in
//      skill, origin 'session'), unless its disk source now says
//      `disable-model-invocation`. A disk skill the listing lacks is added only
//      when its file is newer than the conversation's current session start
//      (ruling D1 (c): Claude Code adds such a skill to the listing on its next
//      turn; this covers only that gap) and is not user-only.
//   4. The synced bucket (<org>_<account>) is the one whose org is the
//      listing's; with no org known and one bucket, that one; with several,
//      only synced names the listing already holds.
//   5. Excluded: user-only skills (the Skill tool refuses them) and every
//      BUILTIN_COMMANDS name (lib/server/composer.js, the list's one home).
//   With no listing (no conversation, no names yet, the source unavailable):
//   disk only, source 'disk', partial true.
//
// CLAUDE CODE'S OWN TIER. The user's skills, commands and settings are read
// where Claude Code reads them: userClaudePaths()'s claudeSkillsDir,
// claudeCommandsDir and claudeSettings (CLAUDE_CONFIG_DIR honoured), and its
// skillsSyncedDir, installedPlugins, pluginsDir and pluginsSyncedDir. Never the
// pack-tier keys (skillsDir, commandsDir, settings), which stay under the home
// directory whatever CLAUDE_CONFIG_DIR says (t1 hand-off U01 #2).
//
// READ-ONLY AND BOUNDED. Every read is fs.promises; a skill or command file is
// read to at most its first FILE_READ_MAX bytes; a JSON config to JSON_READ_MAX.
// The user-tier directories and files named by lib/core/paths are taken as
// configured; the project's (.claude/skills, .claude/commands, its settings)
// must stay inside the project by realpath (lib/core/paths fence). Nothing
// FOUND by listing a directory is followed when it is a symlink (a skill
// directory, a SKILL.md, a command file, a bucket, a plugin directory).
// A plugin's installPath, read out of installed_plugins.json, is a path HANDED:
// lib/core/paths fence(pluginsDir, installPath) refuses one outside pluginsDir.
// Nothing is written. A source that cannot be read is skipped, never an error.
//
// THE ORGANISATION AND ACCOUNT IDS never leave this module: no returned field,
// no thrown error and no log line carries them (nothing here logs at all). Each
// distinct account id seen in a bucket name is registered with
// redactor.addKnown (§5.5), once per redactor, so a transcript or a tool
// result that quotes one is masked.

const fs = require('fs');
const path = require('path');
const { claudePaths, userClaudePaths, fence, realpath } = require('../core/paths');
const { stripControls } = require('../core/text');
const { parseFrontmatter, frontmatterFlag } = require('../packs/manifest');
const { BUILTIN_COMMANDS, SKILL_NAME_RE } = require('./composer');

const ENTRIES_MAX = 500;
const DESCRIPTION_MAX = 300;
const FILE_READ_MAX = 16 * 1024;
const JSON_READ_MAX = 1024 * 1024;
// How many entries of one directory are looked at: a bound on the work, far
// beyond any real skills directory.
const DIR_SCAN_MAX = 1000;
const TTL_DEFAULT_MS = 5000;
const MEMO_MAX = 32;

const BUILTIN_SET = new Set(BUILTIN_COMMANDS);
const isBuiltin = (name) => typeof name === 'string' && BUILTIN_SET.has(name.toLowerCase());
const isName = (name) => typeof name === 'string' && SKILL_NAME_RE.test(name);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

// ── reading ──────────────────────────────────────────────────────────────────

// A directory's entries as Dirents, or [] when it cannot be listed.
async function entriesOf(dir) {
  try {
    const list = await fs.promises.readdir(dir, { withFileTypes: true });
    return list.slice(0, DIR_SCAN_MAX);
  } catch {
    return [];
  }
}

// The first `max` bytes of a regular file and its mtime, or null. `follow`
// false opens with O_NOFOLLOW (a symlink is refused by the kernel) and checks
// with lstat first where O_NOFOLLOW is not defined.
async function readHead(file, { max, follow = false }) {
  let fh = null;
  try {
    if (!follow) {
      const st = await fs.promises.lstat(file);
      if (!st.isFile()) return null;
    }
    fh = await fs.promises.open(file, fs.constants.O_RDONLY | (follow ? 0 : O_NOFOLLOW));
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const want = Math.min(st.size, max);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await fh.read(buf, got, want - got, got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return { text: buf.subarray(0, got).toString('utf8'), mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// A JSON config file named by lib/core/paths: an object, or null (absent,
// unreadable, over JSON_READ_MAX, not JSON, not an object).
async function readConfig(file) {
  const got = await readHead(file, { max: JSON_READ_MAX + 1, follow: true });
  if (!got || got.size > JSON_READ_MAX) return null;
  try {
    const v = JSON.parse(got.text);
    return isPlain(v) ? v : null;
  } catch {
    return null;
  }
}

// One skill or command file: {description, userOnly, mtimeMs}, or null when
// Claude Code would not load it (a SKILL.md with no frontmatter block).
async function readSource(file, { needsFrontmatter }) {
  const got = await readHead(file, { max: FILE_READ_MAX });
  if (!got) return null;
  const fm = parseFrontmatter(got.text.replace(/^﻿/, ''));
  if (needsFrontmatter && fm.error) return null;
  return {
    description: fm.error ? null : fm.description,
    userOnly: fm.error ? false : frontmatterFlag(fm.fields, 'disable-model-invocation'),
    mtimeMs: got.mtimeMs,
  };
}

// <dir>/<name>/SKILL.md for every real (non-symlink) directory in `dir`.
async function skillsIn(dir, { skip = null } = {}) {
  const out = [];
  for (const d of await entriesOf(dir)) {
    if (!d.isDirectory() || d.isSymbolicLink() || d.name === skip) continue;
    const src = await readSource(path.join(dir, d.name, 'SKILL.md'), { needsFrontmatter: true });
    if (src) out.push({ base: d.name, ...src });
  }
  return out;
}

// <dir>/<name>.md for every real (non-symlink) file in `dir`.
async function commandsIn(dir) {
  const out = [];
  for (const d of await entriesOf(dir)) {
    if (!d.isFile() || d.isSymbolicLink() || !d.name.endsWith('.md')) continue;
    const src = await readSource(path.join(dir, d.name), { needsFrontmatter: false });
    if (src) out.push({ base: d.name.slice(0, -3), ...src });
  }
  return out;
}

// The real subdirectories of `dir`, by name.
async function dirsIn(dir) {
  return (await entriesOf(dir)).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => d.name);
}

// ── plugins ──────────────────────────────────────────────────────────────────

// enabledPlugins from the user's settings, then the project's settings.json
// and settings.local.json: a later layer overrides an earlier one.
async function enabledPlugins(root, tier) {
  const project = claudePaths(root);
  const enabled = new Map();
  // The project's two files count only inside the project, by realpath.
  for (const file of [tier.claudeSettings, fence(root, project.settings), fence(root, project.settingsLocal)]) {
    const s = file ? await readConfig(file) : null;
    const ep = s && isPlain(s.enabledPlugins) ? s.enabledPlugins : null;
    if (!ep) continue;
    for (const [key, on] of Object.entries(ep)) enabled.set(key, on === true);
  }
  return enabled;
}

// The install of one plugin that applies to this project: a user-scope one, or
// one recorded for this very project. installed_plugins.json v2 holds a list
// per 'name@marketplace' key; v1 held one object.
function installFor(value, rootReal) {
  const installs = Array.isArray(value) ? value : isPlain(value) ? [value] : [];
  for (const inst of installs) {
    if (!isPlain(inst) || typeof inst.installPath !== 'string' || !inst.installPath) continue;
    if (typeof inst.projectPath === 'string' && inst.projectPath) {
      const p = realpath(inst.projectPath) || path.resolve(inst.projectPath);
      if (p !== rootReal) continue;
    }
    return inst.installPath;
  }
  return null;
}

async function pluginSources(root, tier) {
  const installed = await readConfig(tier.installedPlugins);
  const plugins = installed && isPlain(installed.plugins) ? installed.plugins : null;
  if (!plugins) return [];
  const enabled = await enabledPlugins(root, tier);
  const rootReal = realpath(root) || path.resolve(root);
  const out = [];
  for (const [key, value] of Object.entries(plugins)) {
    if (enabled.get(key) !== true) continue;
    const plugin = key.split('@')[0];
    if (!isName(plugin) || plugin.includes(':')) continue;
    const handed = installFor(value, rootReal);
    // A path read out of a file is a path HANDED: fenced to pluginsDir, and
    // the install directory itself never a symlink.
    const dir = handed ? fence(tier.pluginsDir, handed) : null;
    if (!dir) continue;
    try {
      const st = await fs.promises.lstat(dir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    for (const s of await skillsIn(path.join(dir, 'skills'))) out.push({ ...s, name: `${plugin}:${s.base}`, origin: 'plugin' });
    for (const c of await commandsIn(path.join(dir, 'commands'))) out.push({ ...c, name: `${plugin}:${c.base}`, origin: 'plugin' });
  }
  return out;
}

// ── synced buckets ───────────────────────────────────────────────────────────

const BUCKET_RE = /^([^_]+)_(.+)$/;

// Each distinct account id, registered once per redactor.
const registered = new WeakMap();
function registerAccount(redactor, account) {
  if (!redactor || typeof redactor.addKnown !== 'function') return;
  let seen = registered.get(redactor);
  if (!seen) { seen = new Set(); registered.set(redactor, seen); }
  if (seen.has(account)) return;
  seen.add(account);
  try { redactor.addKnown(account, 'account'); } catch { /* a redactor's failure is not the catalog's */ }
}

// The synced skills and synced plugins of the chosen bucket(s), and whether
// they may only match names the listing already holds ('listed') or may also
// be added ('all'). The bucket names stay in this function.
async function syncedSources(tier, orgUuid, redactor) {
  const buckets = new Map(); // bucket dir name → {org}
  const skillBuckets = new Set(await dirsIn(tier.skillsSyncedDir));
  const pluginBuckets = new Set(await dirsIn(tier.pluginsSyncedDir));
  for (const b of [...skillBuckets, ...pluginBuckets]) {
    const m = b.match(BUCKET_RE);
    if (!m) continue;
    registerAccount(redactor, m[2]);
    buckets.set(b, m[1]);
  }
  let chosen;
  let mode = 'all';
  if (typeof orgUuid === 'string' && orgUuid) chosen = [...buckets.keys()].filter((b) => buckets.get(b) === orgUuid);
  else if (buckets.size === 1) chosen = [...buckets.keys()];
  else { chosen = [...buckets.keys()]; mode = 'listed'; }

  const out = [];
  for (const b of chosen) {
    if (skillBuckets.has(b)) {
      for (const s of await skillsIn(path.join(tier.skillsSyncedDir, b))) {
        out.push({ ...s, name: null, bare: s.base, origin: 'synced' });
      }
    }
    if (pluginBuckets.has(b)) {
      for (const plugin of await dirsIn(path.join(tier.pluginsSyncedDir, b))) {
        if (!isName(plugin) || plugin.includes(':')) continue;
        for (const s of await skillsIn(path.join(tier.pluginsSyncedDir, b, plugin, 'skills'))) {
          out.push({ ...s, name: `${plugin}:${s.base}`, origin: 'synced' });
        }
      }
    }
  }
  return { synced: out, mode };
}

// Every disk source, in §6.2's order: project, user, command, plugin, synced.
async function scanDisk({ root, orgUuid, redactor }) {
  const project = claudePaths(root);
  const tier = userClaudePaths();
  const named = (list, origin) => list.map((s) => ({ ...s, name: s.base, origin }));
  // The project's own directories stay inside the project, by realpath: a
  // checked-in .claude/skills symlinked elsewhere is not read.
  const inProject = (dir) => fence(root, dir);
  const sources = [
    ...named(inProject(project.skillsDir) ? await skillsIn(project.skillsDir) : [], 'project'),
    ...named(await skillsIn(tier.claudeSkillsDir, { skip: 'synced' }), 'user'),
    ...named(inProject(project.commandsDir) ? await commandsIn(project.commandsDir) : [], 'command'),
    ...named(await commandsIn(tier.claudeCommandsDir), 'command'),
    ...await pluginSources(root, tier),
  ];
  const { synced, mode } = await syncedSources(tier, orgUuid, redactor);
  return { sources, synced, syncedMode: mode };
}

// ── the catalog ──────────────────────────────────────────────────────────────

function cleanDescription(text, redactor) {
  if (typeof text !== 'string') return '';
  let s = stripControls(text.replace(/\s+/g, ' ')).trim();
  if (!s) return '';
  if (redactor && typeof redactor.text === 'function') {
    try { s = String(redactor.text(s)); } catch { return ''; }
  }
  return s.length > DESCRIPTION_MAX ? `${s.slice(0, DESCRIPTION_MAX - 1)}…` : s;
}

// The listing as skillFold answers it, or null when it holds no usable names.
function listingOf(listing) {
  if (!isPlain(listing) || listing.unavailable === true || !Array.isArray(listing.names)) return null;
  const names = [];
  const seen = new Set();
  for (const n of listing.names) {
    if (!isName(n) || seen.has(n)) continue;
    seen.add(n);
    names.push(n);
  }
  return {
    names,
    descriptions: isPlain(listing.descriptions) ? listing.descriptions : {},
    orgUuid: typeof listing.orgUuid === 'string' && listing.orgUuid ? listing.orgUuid : null,
  };
}

// The catalog and, beside it, the user-only names (for resolve), which never
// appear in the catalog itself.
async function build({ root, listing, sessionStart = null, redactor = null, now = Date.now }) {
  const L = listingOf(listing);
  const { sources, synced, syncedMode } = await scanDisk({ root, orgUuid: L ? L.orgUuid : null, redactor });
  const listed = L && L.names.length ? L.names : null;
  const listedSet = new Set(listed || []);

  // A synced skill's spelling: as the listing spells it (its bare name, or
  // `<namespace>:<name>`); one the listing lacks takes the namespace the
  // listing gives the other synced skills, else its bare name.
  let syncedPrefix = null;
  const syncedMatch = (s) => {
    if (s.name) return listedSet.has(s.name) ? s.name : null;
    if (listedSet.has(s.bare)) return s.bare;
    for (const n of listed || []) {
      const i = n.lastIndexOf(':');
      if (i > 0 && n.slice(i + 1) === s.bare) return n;
    }
    return null;
  };
  for (const s of synced) {
    const n = !s.name ? syncedMatch(s) : null;
    if (n && n !== s.bare) { syncedPrefix = n.slice(0, n.lastIndexOf(':')); break; }
  }
  const syncedEntries = [];
  for (const s of synced) {
    const match = syncedMatch(s);
    if (syncedMode === 'listed' && !match) continue;
    const name = match || s.name || (syncedPrefix ? `${syncedPrefix}:${s.bare}` : s.bare);
    if (isName(name)) syncedEntries.push({ ...s, name });
  }

  // Every disk entry by name, the first source of a name winning.
  const all = [...sources.filter((s) => isName(s.name)), ...syncedEntries];
  const byName = new Map();
  for (const s of all) if (!byName.has(s.name)) byName.set(s.name, s);

  const userOnly = new Set();
  for (const s of byName.values()) if (s.userOnly && !isBuiltin(s.name)) userOnly.add(s.name);

  const skills = [];
  const taken = new Set();
  let truncated = false;
  const add = (name, description, origin) => {
    if (taken.has(name)) return;
    if (skills.length >= ENTRIES_MAX) { truncated = true; return; }
    taken.add(name);
    skills.push({ name, description: cleanDescription(description, redactor), origin });
  };

  if (listed) {
    for (const n of listed) {
      if (isBuiltin(n)) continue;
      const src = byName.get(n);
      if (src && src.userOnly) continue; // now says disable-model-invocation
      const fromListing = typeof L.descriptions[n] === 'string' ? L.descriptions[n] : null;
      add(n, (src && src.description) || fromListing, src ? src.origin : 'session');
    }
    const start = finite(sessionStart) ? sessionStart : null;
    if (start !== null) {
      for (const s of byName.values()) {
        if (listedSet.has(s.name) || s.userOnly || isBuiltin(s.name)) continue;
        if (!(s.mtimeMs > start)) continue;
        add(s.name, s.description, s.origin);
      }
    }
  } else {
    for (const s of byName.values()) {
      if (s.userOnly || isBuiltin(s.name)) continue;
      add(s.name, s.description, s.origin);
    }
  }

  let asOf;
  try { asOf = now(); } catch { asOf = Date.now(); }
  return {
    skills,
    source: listed ? 'session' : 'disk',
    partial: !listed || truncated,
    as_of: asOf,
    userOnly,
  };
}

async function catalog(opts = {}) {
  const { skills, source, partial, as_of: asOf } = await build(opts);
  return { skills, source, partial, as_of: asOf };
}

// ── the daemon's instance ────────────────────────────────────────────────────

// The conversation a catalog is for (null: the primary one) and its current
// session's start, both from the mirror's snapshot. Never a mirror file.
async function targetOf(mirror, conversationId) {
  let snap = null;
  try {
    snap = mirror && typeof mirror.snapshot === 'function' ? await mirror.snapshot({ level: 'local' }) : null;
  } catch {
    snap = null;
  }
  const cid = typeof conversationId === 'string' && conversationId
    ? conversationId
    : (isPlain(snap) && typeof snap.primary === 'string' ? snap.primary : null);
  let sessionStart = null;
  const convs = isPlain(snap) && Array.isArray(snap.conversations) ? snap.conversations : [];
  const conv = cid ? convs.find((c) => isPlain(c) && c.id === cid) : null;
  if (conv && Array.isArray(conv.sessions)) {
    const cur = conv.sessions.find((s) => isPlain(s) && s.session_id === conv.current_session_id);
    if (cur && finite(cur.started_at)) sessionStart = cur.started_at;
  }
  return { cid, sessionStart };
}

async function listingFor(mirror, cid) {
  if (!cid || !mirror || typeof mirror.skillFold !== 'function') return null;
  try {
    return await mirror.skillFold(cid);
  } catch {
    return null;
  }
}

function createSkillCatalog({ root, mirror = null, redactor = null, ttlMs = TTL_DEFAULT_MS, now = Date.now } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('createSkillCatalog needs { root }');
  const memo = new Map(); // requested conversation ('' = the primary) → {at, value}
  const clock = () => {
    try { const t = now(); return finite(t) ? t : Date.now(); } catch { return Date.now(); }
  };

  function entry(conversationId) {
    const key = typeof conversationId === 'string' ? conversationId : '';
    const t = clock();
    const hit = memo.get(key);
    if (hit && t >= hit.at && t - hit.at < ttlMs) return hit.value;
    const value = (async () => {
      const { cid, sessionStart } = await targetOf(mirror, key || null);
      const listing = await listingFor(mirror, cid);
      const built = await build({ root, listing, sessionStart, redactor, now: clock });
      return { ...built, conversation: cid };
    })();
    memo.delete(key);
    memo.set(key, { at: t, value });
    while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
    value.catch(() => { if (memo.get(key) && memo.get(key).value === value) memo.delete(key); });
    return value;
  }

  // {conversation, skills, source, partial, as_of}: the route's answer. The
  // conversation is the one asked for, or the primary one when none was.
  async function catalogOf(conversationId) {
    const e = await entry(conversationId);
    return { conversation: e.conversation, skills: e.skills, source: e.source, partial: e.partial, as_of: e.as_of };
  }

  // U60's adapter (lib/server/composer.js classifySkill): 'skill' for a
  // catalog entry, 'user_only' for a disk skill marked disable-model-
  // invocation, else null — a built-in command included, which the composer
  // checks itself.
  async function resolve(name, { conversation_id: conversationId = null } = {}) {
    if (!isName(name) || isBuiltin(name)) return null;
    const e = await entry(conversationId);
    if (e.skills.some((s) => s.name === name)) return 'skill';
    if (e.userOnly.has(name)) return 'user_only';
    return null;
  }

  async function lookup(name, conversationId = null) {
    if (isBuiltin(name)) return { kind: 'builtin' };
    if (!isName(name)) return { kind: 'unknown' };
    const e = await entry(conversationId);
    const skill = e.skills.find((s) => s.name === name);
    if (skill) return { kind: 'skill', skill: { ...skill } };
    if (e.userOnly.has(name)) return { kind: 'user_only' };
    return { kind: 'unknown' };
  }

  return { catalog: catalogOf, resolve, lookup, clear: () => memo.clear() };
}

module.exports = {
  catalog,
  createSkillCatalog,
  ENTRIES_MAX,
  DESCRIPTION_MAX,
  FILE_READ_MAX,
  TTL_DEFAULT_MS,
};
