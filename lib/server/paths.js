// Compat adapter over lib/core/paths.js. The path-building moved to core; this
// maps core's projectPaths()/userPaths() onto the frozen UPPERCASE keys the
// lib/server/* code consumes, and preserves resolvePaths's mkdir-on-call via
// ensureProjectDirs. Its consumers are unchanged.
const { projectPaths, userPaths, ensureProjectDirs } = require('../core/paths');

function resolvePaths(root) {
  const p = projectPaths(root);
  const u = userPaths();
  ensureProjectDirs(p);
  return {
    WEB_CHAT_DIR: p.dir,
    COMPONENTS_DIR: p.components,
    SERVICES_DIR: p.services,
    TRUSTED_SERVICES_PATH: p.trustedServices,
    GRAPH_DIR: p.graphDir,
    META_PATH: p.meta,
    CAPTURES_DIR: p.captures,
    PUBLIC_DIR: p.PUBLIC_DIR,
    EXTENSIONS_DIR: p.EXTENSIONS_DIR,
    THEMES_DIR: p.themesDir,
    THEME_PATH: p.theme,
    PROFILES_DIR: p.profiles,
    EXPORTS_DIR: p.exports,
    SYSTEM_WEB_CHAT_DIR: u.root,
    SYSTEM_THEMES_DIR: u.themesDir,
    SYSTEM_THEME_PATH: u.theme,
    SYSTEM_PROFILES_DIR: u.profiles,
    SYSTEM_COMPONENTS_DIR: u.components,
    root,
  };
}

module.exports = { resolvePaths };
