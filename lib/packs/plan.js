// What WOULD happen — computed before anything happens.
//
// planInstall is PURE: it reads the staged tree and the destination tiers and
// returns a description. It writes nothing, so the same function serves three
// callers that must agree with each other:
//
//   * `pack install`, which applies the plan;
//   * `pack review` / the drawer's quarantine card, which shows the plan to a
//     human who has not decided yet;
//   * `pack get`, which stores the plan alongside the quarantined tree so the
//     review a user reads is the install they later approve.
//
// If planning and applying were the same pass, "show me what this would do"
// would be a second implementation of the install — and the two would drift.

const { projectPaths, userPaths, claudePaths, userClaudePaths } = require('../core/paths');
const { componentsRegistry } = require('../server/components-registry');
const { UNIT_KINDS, COMPONENT_FILES } = require('./kinds');

function tierPaths(tier, root) {
  return tier === 'system' ? userPaths() : projectPaths(root);
}
function tierClaude(tier, root) {
  return tier === 'system' ? userClaudePaths() : claudePaths(root);
}

// The plan. Returns { tier, units, collisions, services, errors, warnings, skill }.
//
//   units       — what would be written, with per-file digests
//   collisions  — { kind, name, severity: 'refused'|'replace', ... }
//                 'refused' has NO override and never appears with a control
//                 next to it in any UI; 'replace' is the user's own same-named
//                 component, which only `--replace` (terminal-only) overrides.
//   services    — component names carrying a service.js, so the caller can name
//                 the `claude-web-chat trust` command BEFORE the pane sits empty
//   errors      — hard stops; a non-empty errors means nothing should be applied
//   warnings    — what the plan noticed but does not stop on (a theme file that
//                 will not be installed, a theme with no tokens)
function planInstall({ stageDir, manifest, tier = 'local', root, replace = false } = {}) {
  const p = tierPaths(tier, root);
  const claude = tierClaude(tier, root);
  // The SAME registry the surface resolves components through, so "which copy
  // would use_component actually get?" is answered by the resolver rather than
  // guessed at. It is what catches the quiet case: installing into the system
  // tier when this project already has a component of that name, where the
  // install succeeds and then appears to do nothing.
  //
  // Built from the path authority directly, NOT from lib/server/paths: that
  // adapter calls ensureProjectDirs, so every plan — including the one
  // quarantinePack computes for a tree the user has not approved — created
  // .web-chat/components, services, graph, captures, themes and profiles in the
  // target project. A function whose header says it writes nothing was mkdir'ing
  // six directories, and the quarantine promise "nothing is installed, nothing
  // is registered" was not true.
  let registry = null;
  try {
    registry = componentsRegistry({
      COMPONENTS_DIR: projectPaths(root).components,
      SYSTEM_COMPONENTS_DIR: userPaths().components,
    });
  } catch { registry = null; }
  // One ladder per kind, each its row's plan() in lib/packs/kinds.js, in the
  // table's order (components, themes, the skill). Each appends to the lists
  // below; the skill's sets `skill`.
  const ctx = {
    stageDir, manifest, tier, root, replace, p, claude, registry,
    packName: manifest.name,
    units: [], collisions: [], services: [], errors: [], warnings: [], skill: null,
  };
  for (const row of UNIT_KINDS) row.plan(ctx);
  const { units, collisions, services, errors, warnings, skill } = ctx;

  return { tier, units, collisions, services, errors, warnings, skill, root };
}

module.exports = { planInstall, COMPONENT_FILES };
