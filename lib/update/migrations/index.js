const fs = require('fs');
const path = require('path');
const { projectPaths } = require('../../core/paths');
const { SCHEMA_VERSION } = require('../../core/versions');
const { writeJsonAtomic, readJson } = require('../../core/fsjson');

// SCHEMA_VERSION (the version current code expects) now lives in core/versions.js
// — its single home. Bump it there when a breaking on-disk change ships, and
// register the upgrade function below.
//
// Each migration upgrades the state directory from N to N+1, keyed by the FROM
// version. Migrations must be idempotent and append-only — never rewrite history.
//
// To add vN→vN+1:
//   1) require('./vN-to-vN+1') below, keyed by N
//   2) bump SCHEMA_VERSION in core/versions.js
const migrations = {
  1: require('./v1-to-v2'),
};

// stateDir is <root>/.web-chat; mint the _version.json path through core/paths
// so the '.web-chat'/'_version.json' literals live in exactly one place.
function versionFile(stateDir) {
  return projectPaths(path.dirname(stateDir)).version;
}

// Three answers, not one. This function used to return the literal 0 for a
// missing file, a truncated file and an EACCES alike — and run() reads 0 as
// "fresh project", so a v1 project that lost its version file to a crash got
// stamped at the current schema with every pending migration silently skipped.
// A file containing `{}` was worse still: `undefined` matched neither branch and
// fell out with nothing stamped at all.
//
//   0     the file is absent — a genuinely fresh project
//   n     a recorded integer version
//   null  present but unusable (torn, unreadable, or not a version record)
function readVersion(stateDir) {
  const r = readJson(versionFile(stateDir), {
    validate: (d) => d && typeof d === 'object' && Number.isInteger(d.version) && d.version >= 1,
  });
  if (r.ok) return r.value.version;
  return r.absent ? 0 : null;
}

// Atomic (lib/core/fsjson) so the corrupt case above cannot arise from a crash
// in the first place. Keeps its trailing newline.
function writeVersion(stateDir, v) {
  writeJsonAtomic(versionFile(stateDir), { version: v }, { newline: true });
}

// The `steps`/`target` options are a test seam: production callers pass only
// stateDir and get the real migration map + SCHEMA_VERSION, but the runner's
// branches (missing-migration stop, forward-version warn) are exercisable against
// an injected gapped map without depending on the real map's current shape.
function run(stateDir, { steps = migrations, target = SCHEMA_VERSION } = {}) {
  if (!fs.existsSync(stateDir)) return; // no project state means nothing to migrate
  let v = readVersion(stateDir);
  if (v === null) {
    // Unusable, not fresh. Migrations are required to be idempotent and
    // append-only, so the safe assumption is the OLDEST version this runner
    // knows: re-running a step that already ran is a no-op, whereas stamping the
    // target would skip every pending step and claim the state is current.
    process.stderr.write(`[claude-web-chat] ${versionFile(stateDir)} is unreadable; ` +
      `assuming v1 and re-running migrations (they are idempotent).\n`);
    v = 1;
  }
  if (v === 0) {
    // First-touch: treat as the baseline current schema.
    v = target;
    writeVersion(stateDir, v);
    return;
  }
  if (v > target) {
    process.stderr.write(`[claude-web-chat] state is at v${v}, this build expects v${target}. ` +
      `Newer state will be used as-is; consider updating the package.\n`);
    return;
  }
  while (v < target) {
    const fn = steps[v];
    if (!fn) {
      process.stderr.write(`[claude-web-chat] no migration registered for v${v} → v${v + 1}; stopping.\n`);
      return;
    }
    fn(stateDir);
    v++;
    writeVersion(stateDir, v);
    process.stderr.write(`[claude-web-chat] migrated state ${v - 1} → ${v}\n`);
  }
}

module.exports = { run, SCHEMA_VERSION };
