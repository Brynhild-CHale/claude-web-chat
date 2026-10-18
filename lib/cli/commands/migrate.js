// `claude-web-chat migrate [--json]` — the v3→v4 comment migration's DRY RUN.
//
// It shows what the daemon will do at its next boot: how many nodes, copies and
// pins the project holds, the versions it would mint and reuse, every copy it
// cannot map (which refuses the migration), park rule b2's numbers, what
// happens to the draft, the bytes it would append and how long the derivation
// took. It writes NOTHING — no log, no report, no directory: the element log has
// one writer, the project's daemon, and only the daemon migrates
// (lib/update/migrations v3-to-v4 is `daemonOnly`). It reads the project's
// version the way the runner does (readVersion), including the graph-present
// rule: a .web-chat/ that holds a graph but no _version.json is read as v3
// (GRAPH_PRESENT_VERSION) and dry-run, because the daemon migrates it.
//
// Exit 0 when the migration would run (or the project is already migrated),
// 2 when it would refuse.

const { resolveRoot } = require('../../setup/registration');
const { projectPaths } = require('../../core/paths');
const { SCHEMA_VERSION } = require('../../core/versions');
const { readVersion, graphPresent, GRAPH_PRESENT_VERSION } = require('../../update/migrations');
const { migrateComments, FROM, TO } = require('../../core/element-migrate');

const USAGE = 'Usage: claude-web-chat migrate [--json]';

function userFacing(message) {
  return Object.assign(new Error(message), { userFacing: true });
}

function lines(report) {
  const out = [];
  const c = report.counters;
  out.push(`The v${FROM}→v${TO} comment migration (a dry run: nothing was written)`);
  out.push(`  nodes        ${report.graph_nodes} in the graph, ${report.nodes} carrying pins`);
  out.push(`  copies       ${report.copies} on nodes, ${report.draft.copies} in the draft`);
  out.push(`  pins         ${report.elements} (${report.versions} versions pinned)`);
  out.push(`  versions     ${report.versions_to_mint} to mint (${c.minted_root} new pins or roots, ${c.minted_edge} edits or replies), ${report.reused} copies reuse one`);
  if (c.reuse_refused_home_off_ancestry) out.push(`               ${c.reuse_refused_home_off_ancestry} equal twins on another branch not reused (each mints its own)`);
  if (c.beside_only_mints) out.push(`               ${c.beside_only_mints} equal in text but not in seq or locator (each mints its own)`);
  if (report.unmapped.length) {
    out.push(`  UNMAPPED     ${report.unmapped.length} copies: the migration will REFUSE and leave the project at v${FROM}`);
    for (const u of report.unmapped) out.push(`               ${u.node} ${u.id == null ? '(no id)' : u.id}: ${u.reason}`);
  } else {
    out.push('  unmapped     none');
  }
  const p = report.park;
  out.push(`  park (b2)    ${p.states.present} present, ${p.states.orphan} kept ghosts, ${p.states.parked} parked; median ${p.median_orphans_per_node ?? 0} orphans per node, ${p.homeless_pin_ids} homeless pins, ${p.replies_lost} replies lost`);
  const d = report.draft;
  const draftSay = {
    migrated: `${d.copies} copies on ${d.base_active} (${d.versions_new} uncommitted versions)`,
    'draft-stale-skipped': `skipped: it sits on ${d.base_active}, the active node is ${d.active ?? 'none'} (the daemon sets it aside at boot)`,
    'draft-unreadable': 'unreadable, skipped (its seqs still count toward the floor)',
    empty: 'no pins in it',
    absent: 'none',
  };
  out.push(`  draft        ${draftSay[d.state] || d.state}`);
  out.push(`  seq floor    ${report.seq_floor} (no pin id at or below it is minted again)`);
  if (report.suspects.length) {
    out.push(`  suspects     ${report.suspects.length} ids minted twice (kept as one pin, reported, not refused):`);
    for (const s of report.suspects) out.push(`               ${s.id}: ${s.reason} on ${s.nodes.join(', ')}`);
  }
  if (report.unreadable.length) {
    out.push(`  unreadable   ${report.unreadable.length} files skipped:`);
    for (const u of report.unreadable) out.push(`               ${u.file}: ${u.why}`);
  }
  out.push(`  would append ${report.would_append.records} records, ${report.would_append.bytes} bytes to .web-chat/elements/log.jsonl`);
  out.push(`  derive       ${report.derive_ms} ms (a one-time cost at the daemon's first boot after the upgrade)`);
  out.push(report.unmapped.length
    ? 'The daemon will refuse this migration at its next boot; comments stay read-only until the copies above are fixed.'
    : 'The daemon runs this migration at its next boot (claude-web-chat restart).');
  return out;
}

// migrate(args, {cwd, log}) → {code, report?}. The dispatcher calls it with
// args only; the exit code goes on process.exitCode.
function migrate(args = [], opts = {}) {
  const log = opts.log || ((s) => console.log(s));
  const cwd = opts.cwd || process.cwd();
  const flags = args.map(String);
  if (flags.includes('--help') || flags.includes('-h')) { log(USAGE); return { code: 0 }; }
  const unknown = flags.filter((f) => f !== '--json');
  if (unknown.length) throw userFacing(`migrate: unknown argument ${unknown[0]}\n${USAGE}`);
  const json = flags.includes('--json');
  const { root } = resolveRoot(cwd, { mode: 'existing' });
  const paths = projectPaths(root);
  const version = readVersion(paths.dir);
  // No _version.json but a graph on disk: the daemon reads it as v3 and
  // migrates (lib/update/migrations run()), so the dry run does too.
  const assumed = version === 0 && graphPresent(paths.dir) ? GRAPH_PRESENT_VERSION : null;
  const done = (code, body, text) => {
    if (assumed !== null) {
      body = { ...body, assumed };
      text = [`This project has no _version.json but holds a graph: the daemon reads it as v${assumed} and migrates it at its next boot.`, ...text];
    }
    if (json) log(JSON.stringify(body, null, 2));
    else for (const l of text) log(l);
    if (code) process.exitCode = code;
    return { code, ...body };
  };
  if (version !== null && version >= TO) {
    return done(0, { state: 'current', version, schema: SCHEMA_VERSION },
      [`Already migrated: this project's state is at v${version} (this build expects v${SCHEMA_VERSION}); there is nothing to do.`]);
  }
  if (version === 0 && assumed === null) {
    return done(0, { state: 'fresh', version: 0, schema: SCHEMA_VERSION },
      [`This project has no _version.json yet: its first daemon boot stamps it at v${SCHEMA_VERSION} with nothing to migrate.`]);
  }
  const r = migrateComments(paths.dir, { dryRun: true });
  if (r.already) {
    return done(0, { state: 'migrated', version, migration: r.migration },
      ['Already migrated: the element log holds the migration record; the daemon stamps v4 at its next boot.']);
  }
  if (r.empty) {
    return done(0, { state: 'empty', version, report: r.report },
      [`No comment pins in this project: the daemon stamps v${TO} at its next boot and writes nothing.`]);
  }
  const code = r.refused ? 2 : 0;
  return done(code, { state: r.refused ? 'would-refuse' : 'would-migrate', version, report: r.report }, lines(r.report));
}

module.exports = migrate;
module.exports.USAGE = USAGE;
