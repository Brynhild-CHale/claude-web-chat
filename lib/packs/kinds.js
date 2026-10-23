// The pack unit kinds — one row per kind (annotation engine tranche 2, U321;
// PLAN.md 2C.1 step 1, DECISIONS.md B2).
//
// A pack installs UNITS, and every unit is of one kind: a component, a theme,
// the pack's skill or an element type (U322). Each kind differs from the others in a handful of places —
// where its files land, whether its name builds a directory, which names are
// reserved for it, how a plan decides what it would write and what collides,
// how a result line names it, which list a record or a listing keeps it in —
// and those places used to be spelled as their own `if (unit.kind === …)` arm
// in six files. This table is where a kind is now described, once: a new kind
// is a row here, not sixteen arms across the pipeline, and every arm in
// lib/packs and the CLI reads the row instead. test/conventions.test.js holds
// the arms that remain elsewhere at their baseline (the chrome's drawer, which
// cannot require lib/).
//
// Each row:
//
//   kind         the unit's `kind`, as a record and a plan carry it
//   manifestKey  the key planInstall reads off the VALIDATED manifest: the list
//                of names for a component, a theme or an element type, the
//                parsed SKILL.md for the skill (a raw web-chat-pack.json has no
//                `skill` key)
//   listKey      the list a record or a listing names this kind's units in —
//                `components`, `themes`, `elements` — or null for a kind kept
//                in no list
//   dest(unit, tier, root)  the directory its files live in, resolved fresh
//                from the path authority (store.js unitDir delegates here)
//   checksName   whether the unit's name builds a directory, so a record's
//                name must be plain kebab-case before anything is joined to it
//   sharedDir    whether that directory is shared with other units, so a remove
//                takes the unit's files and never the directory itself
//   reserved(name)  whether the name is web-chat's own — a hard refusal
//   plan(ctx)    planInstall's ladder for this kind: appends to ctx.units,
//                ctx.collisions, ctx.services, ctx.errors and ctx.warnings
//                exactly the objects the ladder appended before the table (the
//                collision objects are JSON the drawer and the CLI print)
//   label(unit)  the result line's name for a unit, "<kind> <name>"
//
// The rows hold the per-kind code MOVED from where it was, not rewritten:
// test/pack-kinds.test.js compares every plan, record, audit line and CLI
// output against what the code printed before the move.
//
// The rows are in the order planInstall emits units: components, then themes,
// then the skill, then element types (appended after the three the table was
// built from, so their outputs kept their order).

const fs = require('fs');
const path = require('path');
const { projectPaths, userPaths, claudePaths, userClaudePaths } = require('../core/paths');
const { isComponentName, isBuiltinThemeName, isReservedElementType } = require('../core/names');
const { ownerOf, sha256File } = require('./store');
const { inspectPackTheme } = require('./themes');
const { elementDest, elementSrcDir, elementFiles, ELEMENT_FILE, DRAW_FILE } = require('./elements');

// manifest.js reads this table for its "at least one kind listed" rule, so the
// reserved-name lists it owns are read lazily here rather than at load.
const manifest = () => require('./manifest');

// Files that make up a component unit inside a staged pack tree.
const COMPONENT_FILES = ['component.html', 'meta.json', 'seed.js', 'service.js'];

function fileUnit(kind, name, destDir, srcDir, rels) {
  const files = [];
  for (const rel of rels) {
    const abs = path.join(srcDir, rel);
    if (!fs.existsSync(abs)) continue;
    files.push({ path: rel, src: abs, sha256: sha256File(abs), bytes: fs.statSync(abs).size });
  }
  return { kind, name, dir: destDir, files };
}

// ── component ───────────────────────────────────────────────────────────────
// <tier components dir>/<name>/
function componentDest(unit, tier, root) {
  const p = tier === 'system' ? userPaths() : projectPaths(root);
  return path.join(p.components, unit.name);
}

function componentReserved(name) {
  return manifest().reservedComponentNames().includes(name);
}

function planComponents(ctx) {
  const { stageDir, manifest: m, tier, root, replace, p, registry, packName, units, collisions, services, errors } = ctx;
  for (const c of m.components || []) {
    // Grammar before path. validateManifest already refused a non-kebab name,
    // but quarantine deliberately plans packs that FAILED validation (seeing why
    // is the point of review), so plan() cannot assume validation ran and
    // agreed. Both joins below are the reason: a name carrying a separator
    // aims destDir outside the components directory entirely.
    if (!isComponentName(c.name)) {
      errors.push(`component ${JSON.stringify(String(c.name == null ? '' : c.name))}: names must be kebab-case — refused`);
      continue;
    }
    const srcDir = path.join(stageDir, 'components', c.name);
    const destDir = path.join(p.components, c.name);

    if (componentReserved(c.name)) {
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
}

// ── theme ───────────────────────────────────────────────────────────────────
// <tier themes dir>/ — the unit is `<name>.json` and whatever sits under
// `<name>/`, in a directory every theme shares.
function themeDest(unit, tier, root) {
  const p = tier === 'system' ? userPaths() : projectPaths(root);
  return p.themesDir;
}

// What one may carry — tokens, modes, fonts, logos; never raw CSS while
// THEME_CSS_POLICY says so — is lib/packs/themes.js's to decide, and every
// refusal it finds is a plan error, so the review card shows it and the install
// stops on it. A theme unit's `dir` is the tier's SHARED themes directory: its
// files are `<name>.json` and whatever sits under `<name>/`.
function planThemes(ctx) {
  const { stageDir, manifest: m, tier, root, replace, p, packName, units, collisions, errors, warnings } = ctx;
  for (const th of m.themes || []) {
    if (!isComponentName(th.name)) {
      errors.push(`theme ${JSON.stringify(String(th.name == null ? '' : th.name))}: names must be kebab-case — refused`);
      continue;
    }
    if (isBuiltinThemeName(th.name)) {
      // Belt and braces, as for components — validateManifest refused it too.
      collisions.push({
        kind: 'theme', name: th.name, severity: 'refused', owner: 'builtin',
        detail: `"${th.name}" is a built-in theme. The library applies the built-in first, so a pack copy could never be applied. There is no override.`,
      });
      errors.push(`theme "${th.name}" is a built-in name — refused`);
      continue;
    }
    const inspected = inspectPackTheme(stageDir, th.name);
    errors.push(...inspected.errors);
    warnings.push(...inspected.warnings);
    if (!inspected.files.length) continue;
    const present = inspected.files.some((f) => fs.existsSync(path.join(p.themesDir, f.path)));
    if (present) {
      const owner = ownerOf(root, tier, 'theme', th.name);
      if (owner !== packName) {
        collisions.push({
          kind: 'theme', name: th.name, severity: 'replace', owner: owner || 'you',
          detail: `a theme called "${th.name}" already exists here`,
        });
        if (!replace) errors.push(`theme "${th.name}" already exists — re-run in a terminal with --replace to overwrite it`);
      } else {
        collisions.push({ kind: 'theme', name: th.name, severity: 'update', owner, detail: `replacing this pack's own earlier copy` });
      }
    }
    units.push({
      kind: 'theme', name: th.name, dir: p.themesDir,
      files: inspected.files.map((f) => ({ path: f.path, src: f.src, sha256: sha256File(f.src), bytes: f.bytes })),
      summary: inspected.summary,
    });
  }
}

// ── skill ───────────────────────────────────────────────────────────────────
// <tier .claude>/skills/<name>/ — the skill FOLLOWS its components' tier, so a
// skill can never be discoverable somewhere its components are not.
function skillDest(unit, tier, root) {
  const claude = tier === 'system' ? userClaudePaths() : claudePaths(root);
  return claude.skillDir(unit.name);
}

function skillReserved(name) {
  return manifest().reservedSkillNames().includes(name);
}

// The skill. It follows the components' tier by construction (ctx.claude), so
// a skill can never be discoverable somewhere its components are not. Sets
// ctx.skill to what planInstall reports as `skill`.
function planSkill(ctx) {
  const { stageDir, manifest: m, tier, root, replace, claude, packName, units, collisions, errors } = ctx;
  if (m.skill && m.skill.present) {
    if (skillReserved(packName)) {
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
      ctx.skill = {
        name: m.skill.name || packName,
        description: m.skill.description || null,
        dest: claude.rel('skills', packName, 'SKILL.md'),
        bytes: (unit.files[0] && unit.files[0].bytes) || 0,
      };
    }
  }
}

// ── element ─────────────────────────────────────────────────────────────────
// <tier element-types dir>/<name>/ — an element type (lib/packs/elements.js):
// element.json, draw.js and assets/**, in a directory the unit owns, like a
// component's. The ladder is the component's: a built-in type name is refused
// with no override, this pack's own earlier copy is an update, another pack's
// or the user's own copy is a replace only with --replace, and a copy in the
// other tier is reported as shadowed.
//
// ctx.builtin is true only for web-chat's own built-in pack, installed by the
// daemon in process (lib/packs/install installFromStage, via 'builtin'): its
// types carry the reserved names, and their draw code is the chrome's own.
function planElements(ctx) {
  const { stageDir, manifest: m, tier, root, replace, p, packName, units, collisions, errors } = ctx;
  for (const el of m.elements || []) {
    if (!isComponentName(el.name)) {
      errors.push(`element ${JSON.stringify(String(el.name == null ? '' : el.name))}: names must be kebab-case — refused`);
      continue;
    }
    if (isReservedElementType(el.name) && !ctx.builtin) {
      // Belt and braces — validateManifest already refused this.
      collisions.push({
        kind: 'element', name: el.name, severity: 'refused', owner: 'builtin',
        detail: `"${el.name}" is a built-in element type. A pack's type under that name would stand in for web-chat's own. There is no override.`,
      });
      errors.push(`element "${el.name}" is a built-in type name — refused`);
      continue;
    }
    const srcDir = elementSrcDir(stageDir, el.name);
    const destDir = path.join(p.elementTypesDir, el.name);

    if (fs.existsSync(path.join(destDir, ELEMENT_FILE))) {
      const owner = ownerOf(root, tier, 'element', el.name);
      if (owner && owner === packName) {
        collisions.push({ kind: 'element', name: el.name, severity: 'update', owner, detail: `replacing this pack's own earlier copy` });
      } else if (owner) {
        collisions.push({
          kind: 'element', name: el.name, severity: 'replace', owner,
          detail: `element type "${el.name}" already belongs to the pack "${owner}"`,
        });
        if (!replace) errors.push(`element type "${el.name}" belongs to the pack "${owner}" — remove that pack, or re-run in a terminal with --replace`);
      } else {
        collisions.push({
          kind: 'element', name: el.name, severity: 'replace', owner: 'you',
          detail: `you already have an element type called "${el.name}" that no pack installed`,
        });
        if (!replace) errors.push(`element type "${el.name}" already exists and was not installed by a pack — re-run in a terminal with --replace to overwrite it`);
      }
    }

    // The other tier's copy: the project's wins over the one for all projects.
    const other = tier === 'system' ? projectPaths(root) : userPaths();
    if (fs.existsSync(path.join(other.elementTypesDir, el.name, ELEMENT_FILE))) {
      collisions.push(tier === 'system'
        ? {
          kind: 'element', name: el.name, severity: 'shadowed', owner: 'this project',
          detail: `installing "${el.name}" for all projects, but this project already has its own "${el.name}" — the project copy keeps winning here`,
        }
        : {
          kind: 'element', name: el.name, severity: 'shadowed', owner: 'all projects',
          detail: `an element type "${el.name}" is installed for all projects — this project's copy will win here`,
        });
    }

    const unit = fileUnit('element', el.name, destDir, srcDir, elementFiles(srcDir));
    if (!unit.files.some((f) => f.path === ELEMENT_FILE)) {
      errors.push(`element "${el.name}": elements/${el.name}/${ELEMENT_FILE} is missing`);
      continue;
    }
    const draw = unit.files.some((f) => f.path === DRAW_FILE);
    if (!draw && !ctx.builtin) {
      errors.push(`element "${el.name}": elements/${el.name}/${DRAW_FILE} is missing`);
      continue;
    }
    units.push({
      ...unit,
      schema: el.schema, reads: el.reads, anchors: el.anchors,
      draw: draw ? DRAW_FILE : null,
    });
  }
}

// ── the table ───────────────────────────────────────────────────────────────
const UNIT_KINDS = Object.freeze([
  Object.freeze({
    kind: 'component',
    manifestKey: 'components',
    listKey: 'components',
    dest: componentDest,
    checksName: true,
    sharedDir: false,
    reserved: componentReserved,
    plan: planComponents,
    label: (unit) => `component ${unit.name}`,
  }),
  Object.freeze({
    kind: 'theme',
    manifestKey: 'themes',
    listKey: 'themes',
    dest: themeDest,
    // The dir is the shared themes directory and ignores the name entirely,
    // so there the file paths are the load-bearing half.
    checksName: false,
    sharedDir: true,
    reserved: (name) => isBuiltinThemeName(name),
    plan: planThemes,
    label: (unit) => `theme ${unit.name}`,
  }),
  Object.freeze({
    kind: 'skill',
    manifestKey: 'skill',
    listKey: null,
    dest: skillDest,
    checksName: true,
    sharedDir: false,
    reserved: skillReserved,
    plan: planSkill,
    label: (unit) => `skill ${unit.name}`,
  }),
  Object.freeze({
    kind: 'element',
    manifestKey: 'elements',
    listKey: 'elements',
    dest: elementDest,
    checksName: true,
    sharedDir: false,
    reserved: (name) => isReservedElementType(name),
    plan: planElements,
    label: (unit) => `element ${unit.name}`,
  }),
]);

// The row for a kind, or null for anything that is not one — a record's kind
// came out of a file, so `__proto__` and friends must miss, not resolve.
function kindOf(kind) {
  return UNIT_KINDS.find((r) => r.kind === kind) || null;
}

// The units of one kind, in order. Tolerates what a record can hold: no list,
// or a null entry.
function unitsOf(units, kind) {
  return (Array.isArray(units) ? units : []).filter((u) => u && u.kind === kind);
}

function namesOf(units, kind) {
  return unitsOf(units, kind).map((u) => u.name);
}

// A result line's name for any unit — its row's label, or "<kind> <name>" for
// a kind no row describes (a record that did not validate still gets a line).
function labelOf(unit) {
  const row = kindOf(unit.kind);
  return row ? row.label(unit) : `${unit.kind} ${unit.name}`;
}

module.exports = { UNIT_KINDS, kindOf, unitsOf, namesOf, labelOf, COMPONENT_FILES };
