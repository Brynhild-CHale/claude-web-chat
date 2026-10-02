// lib/core/theme-identity.js — WHICH theme a project is on, by name.
//
// A theme has a LOOK (tokens, raw css, light/dark modes) and an IDENTITY (what
// it is called, and whether it is an applied builtin pack). The look needs the
// builtin packs' token tables and is lib/server/theme's business. The identity
// needs only the stored record — which file wins, its `name`, its `builtin`
// flag — and it is needed BELOW lib/server: brand images are kept per theme
// (lib/server/brand.js), and the migration that moved a project's existing
// images under the theme they belong to (lib/update/migrations/v2-to-v3.js)
// runs in `install` too, a process that may not import lib/server
// (test/dependency-direction.test.js). So the identity lives here, in the
// leaf, and lib/server/theme asks it as well — resolveDefault normalizes the
// record globalThemeRecord picks, and appliedBuiltin is appliedBuiltinId — so
// there is one resolution order and one applied-builtin rule, not two.
//
// Imports only lib/core (fsjson, names, paths) and Node built-ins.

const crypto = require('crypto');
const { readJson } = require('./fsjson');
const { builtinThemeId, isBuiltinThemeName, isComponentName } = require('./names');
const { projectPaths, userPaths } = require('./paths');

// The theme a project with NO theme set is on: the stylesheet's own var()
// fallbacks are Earthy's, so that is the look on screen.
const STOCK_THEME = 'earthy';

// Pre-pack releases stored the stock look as a flagless copy named 'web-chat',
// so that name counts as an application of the pack with or without the flag.
const RETIRED_STOCK_NAME = 'web-chat';

// The builtin pack a STORED theme (theme.json, a node's or a pane's) is an
// application of — its pack id — or null. Only two things count: `builtin:
// true`, which is what apply writes for a pack, and the retired stock name.
//
// A name alone does NOT: 0.7.6 could save and apply a theme called `paper` or
// `georgetown` before those were builtins, and its apply stored the full token
// copy with no flag. Such a theme paints its own tokens, so reporting it as the
// pack it shadows (get_theme, Settings, the logo fill, the brand images) would
// name a look that is not on screen. Reads a raw record and a normalized one
// alike.
function appliedBuiltinId(t) {
  if (!t || !t.name) return null;
  if (!t.builtin && String(t.name).toLowerCase() !== RETIRED_STOCK_NAME) return null;
  return builtinThemeId(t.name);
}

// The files a project's global theme resolves from, keyed the way lib/server's
// paths adapter (resolvePaths) carries them, so either shape can be passed to
// globalThemeRecord and to lib/server/theme resolveDefault.
function globalThemeFiles(root) {
  const pp = projectPaths(root);
  return { THEME_PATH: pp.theme, SYSTEM_THEME_PATH: userPaths().theme, THEME_DEFAULT_PATH: pp.themeDefault };
}

const isRecord = (v) => v !== null && typeof v === 'object';

// The STORED record that is the global theme, raw, or null when nothing names
// one. The order: the project's theme.json → the user tier's theme.json → the
// project's default pack (theme-default.json, which the migration runner writes
// once for a project born on 0.8 — only a builtin pack name in it counts, and
// it reads as that pack applied). A file that is absent, torn or not an object
// is passed over as if it were not there. lib/server/theme resolveDefault
// normalizes what this returns, so the look and the name on screen can never
// come from two different files.
function globalThemeRecord(files) {
  const { THEME_PATH, SYSTEM_THEME_PATH, THEME_DEFAULT_PATH } = files || {};
  for (const file of [THEME_PATH, SYSTEM_THEME_PATH]) {
    if (!file) continue;
    const r = readJson(file, { validate: isRecord });
    if (r.ok) return r.value;
  }
  if (THEME_DEFAULT_PATH) {
    const r = readJson(THEME_DEFAULT_PATH, { validate: isRecord });
    const id = r.ok ? builtinThemeId(r.value.name) : null;
    if (id) return { name: id, builtin: true };
  }
  return null;
}

// A theme's KEY: the name its own files are kept under — today the brand
// images added while it was the global theme (lib/server/brand.js keeps them
// in projectPaths().brandThemeDir(key)). It becomes a directory, so it is ONE
// path segment, safe by construction; a raw theme name never reaches a path.
//
//   nothing set               → STOCK_THEME ('earthy') — the look on screen
//   an applied builtin pack   → its pack id ('georgetown-blue'), whatever
//                               spelling or retired name the record used
//   a theme with no name      → UNNAMED_THEME_KEY — raw tokens from set_theme
//   any other named theme     → its name, lower-cased, when that is plain
//                               kebab-case (names isComponentName) and not a
//                               builtin's name; else HASHED_PREFIX + 16 hex
//                               digits of the lower-cased name's sha256
//
// The hashed form is why a theme whose name cannot be a directory — save_theme
// takes letters, digits, spaces and dots, so "Ocean Dusk" is an ordinary name —
// still gets a bucket of its own instead of sharing one with every other such
// theme (which is the bug per-theme images exist to fix). It is also what a
// saved copy carrying a builtin's name gets (a 0.7.6 `paper`, see
// appliedBuiltinId), so its images never mix with the pack's. Neither special
// form can collide with a kebab name: both start with `_`, and the grammar
// never does. Lower-casing first matches the case-insensitive file lookup apply
// does on macOS: `Harbor` and `harbor` there name one theme file, and one bucket.
const UNNAMED_THEME_KEY = '_unnamed';
const HASHED_PREFIX = '_n-';
const HASHED_RE = /^_n-[0-9a-f]{16}$/;

// { key, name, builtin } for a stored record (globalThemeRecord's, or null):
// `name` is the pack id for a builtin, the record's own name otherwise, and
// null for an unnamed theme.
function themeIdentity(record) {
  if (!record) return { key: STOCK_THEME, name: STOCK_THEME, builtin: true };
  const id = appliedBuiltinId(record);
  if (id) return { key: id, name: id, builtin: true };
  if (!record.name) return { key: UNNAMED_THEME_KEY, name: null, builtin: false };
  const name = String(record.name);
  const lower = name.toLowerCase();
  const key = isComponentName(lower) && !isBuiltinThemeName(lower)
    ? lower
    : HASHED_PREFIX + crypto.createHash('sha256').update(lower).digest('hex').slice(0, 16);
  return { key, name, builtin: false };
}

function themeKey(record) {
  return themeIdentity(record).key;
}

// Whether `key` has a shape themeKey returns — one safe path segment — checked
// by a caller before it joins a key it was handed into a path.
function isThemeKey(key) {
  return typeof key === 'string' && (key === UNNAMED_THEME_KEY || HASHED_RE.test(key) || isComponentName(key));
}

// The theme a project is on, from its files on disk: { key, name, builtin }.
function projectTheme(root) {
  return themeIdentity(globalThemeRecord(globalThemeFiles(root)));
}

module.exports = {
  STOCK_THEME,
  UNNAMED_THEME_KEY,
  appliedBuiltinId,
  globalThemeFiles,
  globalThemeRecord,
  themeIdentity,
  themeKey,
  isThemeKey,
  projectTheme,
};
