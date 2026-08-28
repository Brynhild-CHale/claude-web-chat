// The intentional version facts, each with a single home, plus the ONE version
// comparator. `core` imports nothing else from lib/, so this is a dependency
// leaf every layer can read.
//
//   packageVersion()  — the npm semver users see (package.json).
//   SCHEMA_VERSION    — on-disk .web-chat/ state schema; written ONLY by the
//                       migration runner (lib/update/migrations) into _version.json.
//   PROTOCOL_VERSION  — hub/instance wire protocol; drives the health self-heal.
//   NODE_FLOOR        — the oldest Node major that can run this program.
//   REPO_SLUG         — the GitHub repo builds come from, and every URL built
//                       from it (distribution is GitHub Releases; npm is not
//                       involved at any point).
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
//
// v3: the hub validates the Host header on every route (lib/core/cors
// requireLocalHost). That is a change in what an existing endpoint answers, not a
// new route, and this counter is the only thing that gets the fix into a hub that
// is ALREADY running — without a bump an ungated hub survives on the fixed port
// until it idles out, which is the whole window the gate exists to close.
const PROTOCOL_VERSION = 3;

// True when a probed /api/health is at least the protocol this build expects. A
// health object without a `version` predates the field, so it counts as v1.
function isProtocolCurrent(health) {
  return ((health && health.version) || 1) >= PROTOCOL_VERSION;
}

// ────────────────────────────────────────────────────────── the Node floor ──
// The oldest Node major that can run this program, and the one place that number
// is decided. It was a literal in three places and they disagreed: package.json
// engines said >=22, install.sh refused below 22, and `init` — the only
// precondition check a dev checkout or a hand-copied tree ever sees — printed a
// green tick for Node 18, ran the whole install, and then failed eight seconds
// later at `open` with "server failed to start", which is exactly the confusing
// first-run failure that gate exists to prevent.
//
// 22 is not a preference. node-html-parser pulls in `entities`, which is
// ESM-only, and require(esm) landed in 22 — below it the daemon does not start
// at all. (It is flag-gated on 22.0–22.11, so ">=22" is itself slightly loose;
// the floor is the coarse gate, not a substitute for the real error.)
//
// test/core-leaves.test.js asserts this number, package.json's `engines` range
// and install.sh's shell check are all still the same number.
const NODE_FLOOR = 22;

// Is the running (or a given) Node new enough? Returns the parsed major as well,
// so a caller can name it without re-parsing.
function checkNodeFloor(version = process.versions.node) {
  const major = parseInt(String(version).replace(/^v/, '').split('.')[0], 10);
  return { ok: Number.isFinite(major) && major >= NODE_FLOOR, major, floor: NODE_FLOOR };
}

// ──────────────────────────────────────────────────────────── the repo slug ──
// Where builds come from. Distribution is GitHub Releases, so one slug decides
// the update check, the download, and every URL the CLI prints at a user.
//
// It was declared twice (lib/update/check.js and lib/update/release.js, both
// honouring WEB_CHAT_REPO) and hardcoded four more times in user-facing strings
// that did NOT honour it — so pointing a test or a fork at another repo moved
// the downloads but left the CLI telling people to curl the original's
// install.sh. Every URL below is built from the one slug, so the override is
// total or it is nothing.
const REPO_SLUG = process.env.WEB_CHAT_REPO || 'Brynhild-CHale/claude-web-chat';
const REPO_URL = `https://github.com/${REPO_SLUG}`;
const RELEASES_PAGE = `${REPO_URL}/releases/latest`;
const DOCS_URL = `${REPO_URL}/tree/main/docs`;
const INSTALL_SH_URL = `https://raw.githubusercontent.com/${REPO_SLUG}/main/install.sh`;
function releaseTagUrl(tag) {
  return `${REPO_URL}/releases/tag/${tag}`;
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

module.exports = {
  packageVersion,
  SCHEMA_VERSION,
  PROTOCOL_VERSION,
  isProtocolCurrent,
  NODE_FLOOR,
  checkNodeFloor,
  REPO_SLUG,
  REPO_URL,
  RELEASES_PAGE,
  DOCS_URL,
  INSTALL_SH_URL,
  releaseTagUrl,
  compareVersions,
};
