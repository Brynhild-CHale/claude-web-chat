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
  2: require('./v2-to-v3'),
  3: require('./v3-to-v4'),
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

// The look a project born on this build starts in. Only a stateDir with no
// _version.json whose graph directory is empty or absent is a new project:
// every project that has ever booted a daemon has a version file or a graph, so
// it never reaches here and keeps the look it had — lib/server/theme
// resolveDefault falls back to Earthy without this marker.
// A marker already there (or one the user edited) is never replaced. A builtin
// pack id (test/theme-default.test.js holds it to one).
const NEW_PROJECT_PACK = 'georgetown-blue';

// The version a stateDir with a graph but no _version.json is read as: the
// newest schema before the element log (v3→v4), the oldest one whose steps a
// lost version file could have skipped and that any graph on disk may still need
// (a lost version file, a hand-copied .web-chat/). The steps are append-only, so
// a graph that was already v4 loses nothing, but it is not a no-op: v3→v4
// re-plans its copies against its own log and may append versions beside the
// ones it holds (no id is re-minted).
const GRAPH_PRESENT_VERSION = 3;

// Whether the graph directory holds anything the graph wrote: a node file, an
// aside (n<K>.json.corrupt-*), _meta.json — any entry not starting with '.'.
// An absent directory, an empty one (ensureProjectDirs makes it before the
// runner) and one holding only dotfiles (.DS_Store) are not a graph. An
// unreadable one counts as present: the safe side is to migrate, as the
// torn-version branch in run() reasons.
function graphPresent(stateDir) {
  let names;
  try {
    names = fs.readdirSync(projectPaths(path.dirname(stateDir)).graphDir);
  } catch (e) {
    return !(e && e.code === 'ENOENT');
  }
  return names.some((n) => !n.startsWith('.'));
}
function seedNewProject(stateDir) {
  const file = projectPaths(path.dirname(stateDir)).themeDefault;
  if (fs.existsSync(file)) return;
  try {
    writeJsonAtomic(file, { name: NEW_PROJECT_PACK }, { newline: true });
  } catch { /* unwritable: the project keeps the Earthy fallback */ }
}

// The `steps`/`target` options are a test seam: production callers pass only
// stateDir and get the real migration map + SCHEMA_VERSION, but the runner's
// branches (missing-migration stop, forward-version warn) are exercisable against
// an injected gapped map without depending on the real map's current shape.
//
// `context` names who is running the steps: 'daemon' (the default: createServer,
// at every boot) or another caller ('install'). A step marked `daemonOnly` (one
// that writes a log only the daemon may write, v3→v4) is DEFERRED outside the
// daemon: one stderr line, nothing stamped, and the daemon runs it at its next
// boot. A step that answers `{refused: …}` stops the run with the version left
// where it was (one stderr line naming the report), and the next boot tries
// again.
//
// Returns {ok: true, version} when the state is current (or newer, or there is
// no state), {deferred: v} when a daemon-only step waits, {refused: {from: v,
// report}} when a step refused, and {gap: v} when no step is registered for v.
function run(stateDir, { steps = migrations, target = SCHEMA_VERSION, context = 'daemon' } = {}) {
  if (!fs.existsSync(stateDir)) return { ok: true, version: null }; // no project state means nothing to migrate
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
  if (v === 0 && graphPresent(stateDir)) {
    // A graph with no version file is an existing project, not a new one: read it
    // as v3 and migrate (no stamp before the steps, no new-project look).
    process.stderr.write(`[claude-web-chat] ${stateDir} holds a graph but no _version.json; ` +
      `treating it as v${GRAPH_PRESENT_VERSION} and migrating.\n`);
    v = Math.min(GRAPH_PRESENT_VERSION, target);
    if (v === target) {
      writeVersion(stateDir, v);
      return { ok: true, version: v };
    }
  }
  if (v === 0) {
    // First-touch: only a stateDir whose graph directory is empty or absent is a
    // new project — stamp the baseline current schema and seed its look.
    v = target;
    writeVersion(stateDir, v);
    seedNewProject(stateDir);
    return { ok: true, version: v };
  }
  if (v > target) {
    process.stderr.write(`[claude-web-chat] state is at v${v}, this build expects v${target}. ` +
      `Newer state will be used as-is; consider updating the package.\n`);
    return { ok: true, version: v };
  }
  while (v < target) {
    const fn = steps[v];
    if (!fn) {
      process.stderr.write(`[claude-web-chat] no migration registered for v${v} → v${v + 1}; stopping.\n`);
      return { gap: v };
    }
    const what = fn.what || 'migration';
    if (fn.daemonOnly && context !== 'daemon') {
      process.stderr.write(`[claude-web-chat] the v${v}→v${v + 1} ${what} runs in the daemon at its next boot; ` +
        `\`claude-web-chat migrate\` shows what it will do\n`);
      return { deferred: v };
    }
    const out = fn(stateDir);
    if (out && out.refused) {
      const report = out.report_file || null;
      const why = report ? `see ${report}` : (out.error ? `it failed: ${out.error}` : 'see the report');
      process.stderr.write(`[claude-web-chat] the v${v}→v${v + 1} ${what} was refused (${why}); the state stays at v${v}. ` +
        `\`claude-web-chat migrate\` shows what it would do\n`);
      return { refused: { from: v, report } };
    }
    v++;
    writeVersion(stateDir, v);
    process.stderr.write(`[claude-web-chat] migrated state ${v - 1} → ${v}\n`);
  }
  return { ok: true, version: v };
}

module.exports = { run, SCHEMA_VERSION, NEW_PROJECT_PACK };
