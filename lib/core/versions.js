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

// The tunnel portal's own counter — separate from PROTOCOL_VERSION because the
// portal is not the hub: bumping the hub's would needlessly bounce every hub,
// and the portal's is about what it ENFORCES, not what it routes. A portal left
// running across an update keeps enforcing the old rules until something
// restarts it; `claude-web-chat tunnel up` compares this against the running
// portal's /api/health `portal_protocol` (absent = 1) and restarts an older
// one. Nothing else bounces it: the portal is access control, and it restarts
// only when the operator runs the command that starts it.
//
// v2: hidden projects (no-remote marker, expose.exclude), the remote access
// log, the failed-sign-in throttle, X-WC-Remote.
// v3: the policy rows for the page/history/spawn/brand/machine routes, the
// picker on live Claude presence (registry sessions()), /preview/pane framing.
// v4: /page.css, the page stylesheet the chrome now links; /api/graph/changes,
// the phone graph log's per-section change chips.
// v5: /replay framed by self; no-store on the framed documents; POST
// /api/themes refused; relays into a project hidden or stopped since their
// handshake closed (4403); `config_fp` on /api/health (the tunnel.json in
// force); a stray cloudflared from a killed portal stopped at start.
// v6: tunnel.json reloaded live (a revoked email's relays cut, 4403); an
// invalid file fails closed (503, relays cut 4503); `config` on /api/health.
// v7: the picker's Active/Inactive sections and POST /api/sessions/<id>/start
// (a known project's daemon, started from the apex); /theme.css and /fonts/*.
const PORTAL_PROTOCOL_VERSION = 7;

function isPortalCurrent(health) {
  return ((health && health.portal_protocol) || 1) >= PORTAL_PROTOCOL_VERSION;
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
//   * a leading `v` is tag syntax, not part of the version, and a `+build` tail
//     is metadata that never orders (semver §10);
//   * a prerelease tail (`-rc.1`, `-dev.202609271200.ab12cd3`) makes an
//     otherwise-equal version sort OLDER, so a prerelease never advertises
//     itself over the final release of the same number — and a dev build of
//     0.8.0 is still offered the real 0.8.0 when it ships;
//   * two prereleases of the same number order by semver §11: identifier by
//     identifier, numeric ones numerically (so two dev builds order by their
//     yyyymmddhhmm stamp), a numeric one below an alphanumeric one, and a
//     shorter run below a longer one it prefixes. This used to ignore the tail
//     entirely, so every dev build of one number compared EQUAL and the version
//     list could not say which was newest;
//   * if either side's numeric core does not parse (a hand-made directory name
//     like `nightly`), the two are compared as plain strings — an arbitrary but
//     STABLE order, which is all a sort needs.
function comparePrerelease(a, b) {
  const ia = a.split('.');
  const ib = b.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    if (i >= ia.length) return -1;
    if (i >= ib.length) return 1;
    const x = ia[i];
    const y = ib[i];
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function compareVersions(a, b) {
  const bare = (v) => String(v == null ? '' : v).replace(/^v/, '').split('+')[0];
  const core = (v) => bare(v).split('-')[0];
  const tail = (v) => {
    const s = bare(v);
    const i = s.indexOf('-');
    return i < 0 ? null : s.slice(i + 1);
  };
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
  const preA = tail(a);
  const preB = tail(b);
  if ((preA === null) !== (preB === null)) return preA === null ? 1 : -1;
  if (preA === null) return 0;
  return comparePrerelease(preA, preB);
}

// Is this a DEV build — one `scripts/build-release.js --dev` stamped
// (`<next-minor>-dev.<yyyymmddhhmm>.<sha>`), never a published release? The one
// spelling of that question, so `version`, `update --list` and the build script
// cannot disagree about it.
function isDevVersion(v) {
  return /^v?\d+(?:\.\d+)*-dev(?:\.|$)/.test(String(v == null ? '' : v));
}

module.exports = {
  packageVersion,
  SCHEMA_VERSION,
  PROTOCOL_VERSION,
  isProtocolCurrent,
  PORTAL_PROTOCOL_VERSION,
  isPortalCurrent,
  NODE_FLOOR,
  checkNodeFloor,
  REPO_SLUG,
  REPO_URL,
  RELEASES_PAGE,
  DOCS_URL,
  INSTALL_SH_URL,
  releaseTagUrl,
  compareVersions,
  isDevVersion,
};
