// The dependency direction, made true rather than aspirational.
//
// docs/extending.md draws it:
//
//     entry points       cli/* · mcp/* · hooks/* · driver.js · hub/* · server/* · portal/*
//                              │  import ↓ only      (never each other)
//     shared libraries   util/* · toggle/* · update/* · packs/* · capture/* · channel/* · tunnel/*
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
// not in the BASELINE below. The baseline grows only by a reviewed, reasoned
// entry — never silently: an unlisted edge fails, and an entry that no longer
// exists fails as stale, exactly like the conventions ratchet, so a
// consolidation is forced to tighten the rule in the same PR.
//
// A baseline edge is keyed per FILE, so it admits more than the one import it
// names: everything the target file requires is loaded into the importing
// process too. Where that matters — an entry point reaching into another's
// file — the target is PINNED below: what it may itself require is written
// down, and anything else it grows fails the build naming the importer.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIB = path.join(REPO_ROOT, 'lib');

// ── the layers ──────────────────────────────────────────────────────────────
// core is the leaf; client sits on it; SHARED libraries implement one concern
// each and are consumed by the entry points; ENTRY points are the seven processes
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
const ENTRY = new Set(['cli', 'mcp', 'hooks', 'hub', 'driver', 'server', 'portal']);
// lib/setup is SHARED: the project-registration model (what it means for a
// project to be registered with Claude Code), consumed by the cli and mcp entry
// points and layered on lib/update's managed-file primitives. It must never
// import an entry point — which is why resolveRoot takes no prompt of its own
// and the `claude` shell-out is injectable rather than reaching for lib/cli.
// It also holds what `install` and `update` seed in the user tier
// (setup/theme-logos), which the server's brand fill reads its pack list from.
// lib/tunnel is SHARED: what the portal process, `tunnel setup|up|status` and
// doctor all need to agree on — tunnel.json's one normaliser, Cloudflare
// Access's key set, and cloudflared (finding, launching, supervising it). It
// lived inside lib/portal until the CLI needed it too; an entry point cannot
// import another's internals, so it moved down a layer.
// lib/replay is SHARED: the host-side half of rendering a replay to an image —
// finding a system Chrome / ffmpeg and driving Chrome over its debugging pipe.
// It knows nothing of the graph (the daemon hands it a URL and frame times), so
// both the server's render route and `doctor` can use it.
const SHARED = new Set(['util', 'toggle', 'update', 'packs', 'capture', 'channel', 'setup', 'tunnel', 'replay']);

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

  // `portal run` is the CLI face of the tunnel portal process, same shape as
  // `hub run`. (It reads tunnel.json through lib/tunnel/config, a shared
  // library, so that is no longer an edge into the portal.)
  'lib/cli/commands/portal.js => lib/portal/index.js':
    'the portal subcommand runs the portal in-process',

  // The two hooks are MCP-adjacent by construction: they talk to the same daemon
  // through the same spawn-injecting shim the 24 tools use.
  'lib/hooks/turn-begin.js => lib/mcp/client.js':
    'hooks reach the daemon through the same auto-spawning client the tools use',
  'lib/hooks/turn-end.js => lib/mcp/client.js':
    'hooks reach the daemon through the same auto-spawning client the tools use',

  // The supervisor runs a component's service.js, and lib/driver.js IS the
  // contract that service is written against — the runner hands it in.
  'lib/server/service-runner.js => lib/driver.js':
    'the service runner injects the driver API a service.js is authored against',

  // The portal picker wears Georgetown Blue from the pack's own token table,
  // declared through the one token sanitiser, rather than a pasted palette
  // that would drift. theme.js needs only fs + the pack data — and PINNED
  // holds it to that, because the portal is the remote-facing access-control
  // process and must not load daemon state through this edge.
  'lib/portal/picker.js => lib/server/theme.js':
    'the picker themes itself from the canonical Georgetown Blue tokens via tokenDecls',

  // Still owed. The components registry is server-shaped; tier resolution is
  // not. The fix is to lift the registry, not to widen the rule.
  'lib/packs/plan.js => lib/server/components-registry.js':
    'OWED: the components registry is server-shaped but tier resolution is not',
};

// ── pinned targets: what a baseline edge is allowed to drag in ──────────────
// For each target of a baseline edge into another entry point, the complete
// list of what that file — and every lib/ file it pulls in, transitively — may
// require: bare module names (Node built-ins or npm packages), and lib/ files
// by repo-relative path. lib/core/* is always allowed (it is the leaf, and the
// core test below keeps it one). Anything else is a new dependency riding into
// the importing process on an edge that was reviewed for less.
const PINNED = {
  'lib/server/theme.js': {
    importer: 'lib/portal/picker.js',
    process: 'the tunnel portal (the remote-facing access-control process)',
    bare: ['fs'],
    files: ['lib/server/theme-packs.js'],
  },
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

// Every require() specifier in a source text, relative or bare.
function requiresOf(src) {
  const out = [];
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

// What a pinned target (and each lib/ file it pulls in) requires beyond its pin.
// `read` is injectable so a test can show the pin catching a require that is not
// in the tree today.
function pinOffenders(target, pin, read = (abs) => fs.readFileSync(abs, 'utf8')) {
  const offenders = [];
  const seen = new Set();
  const queue = [target];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of requiresOf(read(path.join(REPO_ROOT, file)))) {
      if (!spec.startsWith('.')) {
        if (!pin.bare.includes(spec.replace(/^node:/, ''))) offenders.push(`${file} requires '${spec}'`);
        continue;
      }
      const abs = resolveTarget(path.join(REPO_ROOT, file), spec);
      const dep = abs ? rel(abs) : null;
      if (dep && dep.startsWith('lib/core/')) continue;
      if (dep && pin.files.includes(dep)) { queue.push(dep); continue; }
      offenders.push(`${file} requires '${spec}'${dep ? ` (${dep})` : ''}`);
    }
  }
  return offenders;
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

test('dependency direction: a pinned baseline target requires only what its pin allows', () => {
  for (const [target, pin] of Object.entries(PINNED)) {
    const edge = `${pin.importer} => ${target}`;
    assert.ok(edge in BASELINE, `PINNED names ${edge}, which is not a BASELINE edge — drop the pin with the edge`);
    const offenders = pinOffenders(target, pin);
    assert.deepEqual(
      offenders,
      [],
      `${pin.importer} imports ${target} (a BASELINE edge), so everything ${target} requires is loaded into\n`
      + `${pin.process}. These requires are outside its pin — move what ${pin.importer} needs down into\n`
      + `lib/core, or, if the new dependency is genuinely safe in that process, add it to PINNED in this file\n`
      + `with the reason:\n  ${offenders.join('\n  ')}`,
    );
  }
});

test('dependency direction: the pin catches a require theme.js does not have today', () => {
  // The failure the pin exists for: theme.js starts requiring a daemon-stateful
  // module, and the picker edge — keyed per file — would otherwise wave it into
  // the portal process unnoticed.
  const pin = PINNED['lib/server/theme.js'];
  const real = (abs) => fs.readFileSync(abs, 'utf8');
  const withGraph = (abs) => (rel(abs) === 'lib/server/theme.js'
    ? `${real(abs)}\nconst graph = require('./graph');\n`
    : real(abs));
  assert.deepEqual(pinOffenders('lib/server/theme.js', pin, withGraph),
    ["lib/server/theme.js requires './graph' (lib/server/graph.js)"]);

  // Transitively too: a file the pin allows cannot become the back door.
  const packsGrow = (abs) => (rel(abs) === 'lib/server/theme-packs.js'
    ? `${real(abs)}\nconst { state } = require('./state');\nconst os = require('os');\n`
    : real(abs));
  assert.deepEqual(pinOffenders('lib/server/theme.js', pin, packsGrow), [
    "lib/server/theme-packs.js requires './state' (lib/server/state.js)",
    "lib/server/theme-packs.js requires 'os'",
  ]);
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
