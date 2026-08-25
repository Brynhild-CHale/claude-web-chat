// The three intentional version facts, each with a single home, plus the ONE
// version comparator. `core` imports nothing else from lib/, so this is a
// dependency leaf every layer can read.
//
//   packageVersion()  — the npm semver users see (package.json).
//   SCHEMA_VERSION    — on-disk .web-chat/ state schema; written ONLY by the
//                       migration runner (lib/update/migrations) into _version.json.
//   PROTOCOL_VERSION  — hub/instance wire protocol; drives the health self-heal.
//
// Consolidates what were scattered facts: SCHEMA_VERSION lived in
// migrations/index.js, and PROTOCOL_VERSION was HUB_PROTOCOL_VERSION in
// lib/util/hub.js. Those keep thin re-export aliases so existing callers/tests
// still resolve them.

const path = require('path');

// The package's semver, read from package.json. Not cached deliberately — read so
// rarely (status/mcp banner) that a require-cache hit is already free.
function packageVersion() {
  return require(path.join(__dirname, '..', '..', 'package.json')).version;
}

// On-disk state schema version. Bump whenever a breaking change to the layout of
// <root>/.web-chat/ ships, and register the upgrade in lib/update/migrations.
// v2 landed the first real migration (v1-to-v2: delete the orphaned server.pid).
const SCHEMA_VERSION = 2;

// Hub/instance wire-protocol version. Bump whenever the hub gains or changes
// routes the extension or instances depend on (e.g. /api/profile-match landed in
// v2). A long-running process from before a bump answers /api/health with a lower
// version; ensureHub detects that (isProtocolCurrent) and bounces the stale hub so
// the fresh code loads.
const PROTOCOL_VERSION = 2;

// True when a probed /api/health is at least the protocol this build expects. A
// health object without a `version` predates the field, so it counts as v1.
function isProtocolCurrent(health) {
  return ((health && health.version) || 1) >= PROTOCOL_VERSION;
}

// ────────────────────────────────────────────────────────── the comparator ──
// "Is a newer than b?" had two implementations: lib/update/check.compareVersions
// (dotted numerics + a prerelease tiebreak) and
// lib/update/install-layout.compareVersionNames (dotted numerics + a lexical
// fallback for a non-numeric directory name). Two comparators for one concept
// means the update path and the rollback list could, in principle, disagree
// about which of two versions is newer. This is the one, and both of those now
// delegate to it.
//
// Returns >0 if a is newer, 0 if equal, <0 if a is older.
//
//   * a leading `v` is tag syntax, not part of the version;
//   * a non-numeric tail (`-rc.1`) is ignored for ordering but makes an
//     otherwise-equal version sort OLDER, so a prerelease never advertises
//     itself over the final release of the same number;
//   * if either side's numeric core does not parse (a hand-made directory name
//     like `nightly`), the two are compared as plain strings — an arbitrary but
//     STABLE order, which is all a sort needs.
function compareVersions(a, b) {
  const core = (v) => String(v == null ? '' : v).replace(/^v/, '').split('-')[0];
  const parse = (v) => core(v).split('.').map((n) => parseInt(n, 10));
  const pa = parse(a);
  const pb = parse(b);
  const numeric = pa.every(Number.isFinite) && pb.every(Number.isFinite);
  if (!numeric) {
    const sa = String(a == null ? '' : a);
    const sb = String(b == null ? '' : b);
    return sa < sb ? -1 : (sa > sb ? 1 : 0);
  }
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  const preA = String(a == null ? '' : a).includes('-');
  const preB = String(b == null ? '' : b).includes('-');
  if (preA !== preB) return preA ? -1 : 1;
  return 0;
}

module.exports = { packageVersion, SCHEMA_VERSION, PROTOCOL_VERSION, isProtocolCurrent, compareVersions };
