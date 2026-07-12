const fs = require('fs');
const path = require('path');
const { projectPaths } = require('../../core/paths');
const { SCHEMA_VERSION } = require('../../core/versions');

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

function readVersion(stateDir) {
  try {
    return JSON.parse(fs.readFileSync(versionFile(stateDir), 'utf8')).version;
  } catch {
    return 0;
  }
}

function writeVersion(stateDir, v) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(versionFile(stateDir), JSON.stringify({ version: v }, null, 2) + '\n');
}

// The `steps`/`target` options are a test seam: production callers pass only
// stateDir and get the real migration map + SCHEMA_VERSION, but the runner's
// branches (missing-migration stop, forward-version warn) are exercisable against
// an injected gapped map without depending on the real map's current shape.
function run(stateDir, { steps = migrations, target = SCHEMA_VERSION } = {}) {
  if (!fs.existsSync(stateDir)) return; // no project state means nothing to migrate
  let v = readVersion(stateDir);
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
