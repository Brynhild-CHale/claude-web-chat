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

const fs = require('fs');
const path = require('path');
const { projectPaths, userPaths, claudePaths, userClaudePaths } = require('../core/paths');
const { componentsRegistry } = require('../server/components-registry');
const { resolvePaths } = require('../server/paths');
const { reservedComponentNames, reservedSkillNames } = require('./manifest');
const { ownerOf, sha256File } = require('./store');

// Files that make up each kind of unit inside a staged pack tree.
const COMPONENT_FILES = ['component.html', 'meta.json', 'seed.js', 'service.js'];

function tierPaths(tier, root) {
  return tier === 'system' ? userPaths() : projectPaths(root);
}
function tierClaude(tier, root) {
  return tier === 'system' ? userClaudePaths() : claudePaths(root);
}

function fileUnit(kind, name, destDir, srcDir, rels) {
  const files = [];
  for (const rel of rels) {
    const abs = path.join(srcDir, rel);
    if (!fs.existsSync(abs)) continue;
    files.push({ path: rel, src: abs, sha256: sha256File(abs), bytes: fs.statSync(abs).size });
  }
  return { kind, name, dir: destDir, files };
}

// The plan. Returns { tier, units, collisions, services, errors, skill }.
//
//   units       — what would be written, with per-file digests
//   collisions  — { kind, name, severity: 'refused'|'replace', ... }
//                 'refused' has NO override and never appears with a control
//                 next to it in any UI; 'replace' is the user's own same-named
//                 component, which only `--replace` (terminal-only) overrides.
//   services    — component names carrying a service.js, so the caller can name
//                 the `claude-web-chat trust` command BEFORE the pane sits empty
//   errors      — hard stops; a non-empty errors means nothing should be applied
function planInstall({ stageDir, manifest, tier = 'local', root, replace = false } = {}) {
  const p = tierPaths(tier, root);
  const claude = tierClaude(tier, root);
  // The SAME registry the surface resolves components through, so "which copy
  // would use_component actually get?" is answered by the resolver rather than
  // guessed at. It is what catches the quiet case: installing into the system
  // tier when this project already has a component of that name, where the
  // install succeeds and then appears to do nothing.
  let registry = null;
  try { registry = componentsRegistry(resolvePaths(root)); } catch { registry = null; }
  const units = [];
  const collisions = [];
  const services = [];
  const errors = [];

  const packName = manifest.name;
  const builtinNames = reservedComponentNames();

  for (const c of manifest.components || []) {
    const srcDir = path.join(stageDir, 'components', c.name);
    const destDir = path.join(p.components, c.name);

    if (builtinNames.includes(c.name)) {
      // Belt and braces — validateManifest already refused this. Repeated here
      // because plan() is what the route and the CLI both gate on, and a
      // reserved name must be impossible to reach through any path.
      collisions.push({
        kind: 'component', name: c.name, severity: 'refused', owner: 'builtin',
        detail: `"${c.name}" is a built-in component. A pack copy would shadow it permanently — web-chat only repairs a component whose meta.json says builtin. There is no override.`,
      });
      errors.push(`component "${c.name}" is a built-in name — refused`);
      continue;
    }

    if (fs.existsSync(path.join(destDir, 'meta.json')) || fs.existsSync(path.join(destDir, 'component.html'))) {
      let builtinOnDisk = false;
      try { builtinOnDisk = Boolean(JSON.parse(fs.readFileSync(path.join(destDir, 'meta.json'), 'utf8')).builtin); } catch {}
      if (builtinOnDisk) {
        collisions.push({
          kind: 'component', name: c.name, severity: 'refused', owner: 'builtin',
          detail: `a built-in component already occupies "${c.name}". There is no override.`,
        });
        errors.push(`component "${c.name}" would shadow a built-in — refused`);
        continue;
      }
      const owner = ownerOf(root, tier, 'component', c.name);
      if (owner && owner === packName) {
        // Our own previous install of the same pack: a straight update.
        collisions.push({ kind: 'component', name: c.name, severity: 'update', owner, detail: `replacing this pack's own earlier copy` });
      } else if (owner) {
        collisions.push({
          kind: 'component', name: c.name, severity: 'replace', owner,
          detail: `component "${c.name}" already belongs to the pack "${owner}"`,
        });
        if (!replace) errors.push(`component "${c.name}" belongs to the pack "${owner}" — remove that pack, or re-run in a terminal with --replace`);
      } else {
        collisions.push({
          kind: 'component', name: c.name, severity: 'replace', owner: 'you',
          detail: `you already have a component called "${c.name}" that no pack installed`,
        });
        if (!replace) errors.push(`component "${c.name}" already exists and was not installed by a pack — re-run in a terminal with --replace to overwrite it`);
      }
    }

    if (tier === 'system' && registry) {
      const found = registry.get(c.name);
      if (found && found.tier === 'local') {
        collisions.push({
          kind: 'component', name: c.name, severity: 'shadowed', owner: 'this project',
          detail: `installing "${c.name}" for all projects, but this project already has its own "${c.name}" — the project copy keeps winning here`,
        });
      }
    }

    const unit = fileUnit('component', c.name, destDir, srcDir, COMPONENT_FILES);
    if (!unit.files.some((f) => f.path === 'component.html')) {
      errors.push(`component "${c.name}": components/${c.name}/component.html is missing`);
      continue;
    }
    if (c.has_service) services.push(c.name);
    units.push({ ...unit, has_service: Boolean(c.has_service), has_seed: Boolean(c.has_seed), description: c.description, meta_name: c.meta_name });
  }

  for (const th of manifest.themes || []) {
    const src = path.join(stageDir, 'themes', `${th.name}.json`);
    const destFile = path.join(p.themesDir, `${th.name}.json`);
    if (fs.existsSync(destFile)) {
      const owner = ownerOf(root, tier, 'theme', th.name);
      if (owner !== packName) {
        collisions.push({
          kind: 'theme', name: th.name, severity: 'replace', owner: owner || 'you',
          detail: `a theme called "${th.name}" already exists here`,
        });
        if (!replace) errors.push(`theme "${th.name}" already exists — re-run in a terminal with --replace to overwrite it`);
      }
    }
    units.push(fileUnit('theme', th.name, p.themesDir, path.join(stageDir, 'themes'), [`${th.name}.json`]));
  }

  // The skill. It follows the components' tier by construction (tierClaude), so
  // a skill can never be discoverable somewhere its components are not.
  let skill = null;
  if (manifest.skill && manifest.skill.present) {
    if (reservedSkillNames().includes(packName)) {
      collisions.push({
        kind: 'skill', name: packName, severity: 'refused', owner: 'web-chat',
        detail: `"${packName}" is a skill web-chat manages; the next \`claude-web-chat install\` would revert it.`,
      });
      errors.push(`skill "${packName}" is reserved — refused`);
    } else {
      const destDir = claude.skillDir(packName);
      const existing = path.join(destDir, 'SKILL.md');
      if (fs.existsSync(existing)) {
        const owner = ownerOf(root, tier, 'skill', packName);
        if (owner !== packName) {
          collisions.push({
            kind: 'skill', name: packName, severity: 'replace', owner: owner || 'you',
            detail: `a skill called "${packName}" already exists at ${claude.rel('skills', packName, 'SKILL.md')}`,
          });
          if (!replace) errors.push(`skill "${packName}" already exists — re-run in a terminal with --replace to overwrite it`);
        }
      }
      const unit = fileUnit('skill', packName, destDir, stageDir, ['SKILL.md']);
      units.push(unit);
      skill = {
        name: manifest.skill.name || packName,
        description: manifest.skill.description || null,
        dest: claude.rel('skills', packName, 'SKILL.md'),
        bytes: (unit.files[0] && unit.files[0].bytes) || 0,
      };
    }
  }

  return { tier, units, collisions, services, errors, skill, root };
}

module.exports = { planInstall, COMPONENT_FILES };
