// The dependency direction, made true rather than aspirational.
//
// docs/extending.md draws it:
//
//     entry points       cli/* · mcp/* · hooks/* · driver.js · hub/* · server/*
//                              │  import ↓ only      (never each other)
//     shared libraries   util/* · toggle/* · update/* · packs/* · capture/* · channel/*
//                              │  import ↓ only      (may import each other)
//     lib/client/        the one daemon HTTP client
//                              │  import ↓ only
//     lib/core/          zero deps on the rest of lib/
//
// plus two sentences that carry as much weight as the picture: "entry points
// never reach into each other's internals", and "a helper that seems to belong
// in two layers belongs in the lower one".
//
// That rule was a paragraph, and a paragraph is one lazy `require` away from
// being wrong. It already was, in four places: lib/packs reached UP into
// lib/server for a path adapter and SIDEWAYS into lib/update for a path
// predicate, and lib/capture reached into lib/server for an HTML escaper. Each
// of those was a generic leaf helper parked above the leaf layer, and each edge
// looked harmless on its own.
//
// This test parses every relative require() under lib/, maps it to an edge
// between two subsystems, and fails on any edge the direction forbids that is
// not in the BASELINE below. The baseline may only ever SHRINK: an entry that
// no longer exists fails as stale, exactly like the conventions ratchet, so a
// consolidation is forced to tighten the rule in the same PR.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIB = path.join(REPO_ROOT, 'lib');

// ── the layers ──────────────────────────────────────────────────────────────
// core is the leaf; client sits on it; SHARED libraries implement one concern
// each and are consumed by the entry points; ENTRY points are the six processes
// this package actually starts. Downward is always fine. What is forbidden:
//
//   core    → anything but core          (it is the leaf, by definition)
//   client  → anything but core          (one documented exception, below)
//   entry   → entry                      (reaching into another process's guts)
//   shared  → entry                      (a library reaching up into a process)
//
// A shared library importing another shared library is allowed and expected —
// lib/packs consumes lib/update's archive reader, and that is composition, not
// a direction violation.
const ENTRY = new Set(['cli', 'mcp', 'hooks', 'hub', 'driver', 'server']);
const SHARED = new Set(['util', 'toggle', 'update', 'packs', 'capture', 'channel']);

// ── the baseline: edges that legitimately remain ────────────────────────────
// Each is `from => to` at FILE granularity, because the point of naming them is
// that a reader can go and look. Keyed to a reason; if you cannot write the
// reason, the edge is not legitimate.
const BASELINE = {
  // The one exception docs/extending.md already spells out: the daemon HTTP
  // client needs the spawn helper, which is not core-shaped.
  'lib/client/index.js => lib/util/daemon.js':
    'documented in extending.md: lib/client imports core/* + util/daemon',

  // `start` IS the server process — the CLI subcommand that runs it in the
  // foreground. Not a reach into another process; it is how that process boots.
  'lib/cli/commands/start.js => lib/server/index.js':
    'start runs the server in-process; this is the entry point, not a reach',

  // doctor diagnoses a running daemon's turn lock and asks the MCP client where
  // the daemon is. Read-only introspection of state doctor exists to explain.
  'lib/cli/commands/doctor.js => lib/server/domain/turns.js':
    'doctor reads the turn-lock rules it reports on',
  'lib/cli/commands/doctor.js => lib/mcp/client.js':
    'doctor uses the MCP client shim to find/reach the daemon it is diagnosing',

  // `hub` is the CLI face of the hub process, same shape as `start`.
  'lib/cli/commands/hub.js => lib/hub/index.js':
    'the hub subcommand runs the hub in-process',

  // `profile` renders a capture pane to test a profile without a daemon.
  'lib/cli/commands/profile.js => lib/server/routes/capture.js':
    'profile reuses the capture pane renderer so CLI output matches the surface',

  // The two hooks are MCP-adjacent by construction: they talk to the same daemon
  // through the same spawn-injecting shim the 23 tools use.
  'lib/hooks/turn-begin.js => lib/mcp/client.js':
    'hooks reach the daemon through the same auto-spawning client the tools use',
  'lib/hooks/turn-end.js => lib/mcp/client.js':
    'hooks reach the daemon through the same auto-spawning client the tools use',

  // The supervisor runs a component's service.js, and lib/driver.js IS the
  // contract that service is written against — the runner hands it in.
  'lib/server/service-runner.js => lib/driver.js':
    'the service runner injects the driver API a service.js is authored against',

  // Still owed. BUILTINS lives in lib/server/builtins.js and the pack validator
  // must refuse a builtin component name, so the pack pipeline reaches up for
  // the list. The fix is to move the reserved-name list to the leaf layer, not
  // to widen the rule.
  'lib/packs/manifest.js => lib/server/builtins.js':
    'OWED: the reserved component-name list should move to lib/core',
  'lib/packs/plan.js => lib/server/components-registry.js':
    'OWED: the components registry is server-shaped but tier resolution is not',
};

// ── the walk ────────────────────────────────────────────────────────────────

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile() && e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

function rel(abs) {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

// The subsystem a file belongs to: its directory directly under lib/, or the
// file's own basename for a top-level module (lib/driver.js -> 'driver').
function subsystemOf(file) {
  const parts = path.relative(LIB, file).split(path.sep);
  return parts.length === 1 ? parts[0].replace(/\.js$/, '') : parts[0];
}

// Resolve a relative require specifier to a file inside lib/, or null.
function resolveTarget(fromFile, spec) {
  let target = path.resolve(path.dirname(fromFile), spec);
  if (!target.startsWith(LIB + path.sep)) return null;
  try {
    if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.js');
  } catch {
    if (!target.endsWith('.js')) target += '.js';
  }
  return target;
}

// Why this edge is forbidden, or null when it is fine.
function violation(from, to) {
  if (from === 'core') return 'lib/core is the dependency leaf — it may import nothing else from lib/';
  if (from === 'client' && to !== 'core') return 'lib/client may import only lib/core';
  if (ENTRY.has(from) && ENTRY.has(to)) return 'entry points never reach into each other\'s internals';
  if (SHARED.has(from) && ENTRY.has(to)) return `lib/${from} is a shared library reaching UP into the lib/${to} entry point`;
  return null;
}

function census() {
  const found = new Map(); // 'a => b' -> reason
  for (const file of walk(LIB)) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      const target = resolveTarget(file, m[1]);
      if (!target) continue;
      const from = subsystemOf(file);
      const to = subsystemOf(target);
      if (from === to) continue;
      const why = violation(from, to);
      if (why) found.set(`${rel(file)} => ${rel(target)}`, why);
    }
  }
  return found;
}

test('dependency direction: no new upward or sideways import under lib/', () => {
  const found = census();
  const unexpected = [...found.entries()]
    .filter(([edge]) => !(edge in BASELINE))
    .map(([edge, why]) => `  ${edge}\n      ${why}`);

  assert.deepEqual(
    unexpected,
    [],
    'These imports break the direction in docs/extending.md (core <- client <- everything, and entry\n'
    + 'points never reach into each other). Move the shared helper DOWN into lib/core (or another\n'
    + 'leaf) and import it from there; do not widen the rule. If the edge is genuinely right, add it\n'
    + 'to BASELINE in this file with the reason:\n' + unexpected.join('\n'),
  );
});

test('dependency direction: the baseline is not stale', () => {
  const found = census();
  const gone = Object.keys(BASELINE).filter((edge) => !found.has(edge));
  assert.deepEqual(
    gone,
    [],
    'STALE baseline: these edges no longer exist. A consolidation removed them — delete the entries\n'
    + 'from BASELINE in this file in the same PR, so the rule tightens with the code:\n  '
    + gone.join('\n  '),
  );
});

test('dependency direction: lib/core imports nothing but lib/core', () => {
  // Stated separately because it is the load-bearing half. core is what every
  // other layer is allowed to reach for; the moment it reaches back, "import the
  // engine" stops being free and people start copying instead.
  const offenders = [];
  for (const file of walk(path.join(LIB, 'core'))) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      const target = resolveTarget(file, m[1]);
      if (target && subsystemOf(target) !== 'core') offenders.push(`${rel(file)} => ${rel(target)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('dependency direction: every subsystem under lib/ is classified', () => {
  // A new top-level directory under lib/ is invisible to the rule until someone
  // says which layer it is in — and an unclassified subsystem silently passes
  // every check above. Fail instead, so the choice is deliberate.
  const known = new Set([...ENTRY, ...SHARED, 'core', 'client']);
  const actual = new Set(walk(LIB).map(subsystemOf));
  const unclassified = [...actual].filter((s) => !known.has(s)).sort();
  assert.deepEqual(
    unclassified,
    [],
    'New subsystem(s) under lib/ with no layer. Add each to ENTRY (a process this package starts)\n'
    + 'or SHARED (a library the entry points consume) in this file:\n  ' + unclassified.join('\n  '),
  );
});
