// Which daemon routes a REMOTE viewer may reach — the table the tunnel portal
// (lib/portal) consults before it proxies a request to a loopback daemon.
//
// Why a table and not the daemon's own gates. Every gate in lib/core/cors.js
// answers "is this request LOCAL?", and through the portal every request is:
// the portal is a process on this machine talking to 127.0.0.1. So the daemon
// cannot tell a remote viewer's `fetch` from the developer's own browser, the
// same way it cannot tell a pane's `fetch` from a user's click (read the risk
// paragraph at the head of lib/server/routes/packs.js). The line between "what
// the surface is for" and "what only the host should do" therefore has to be
// drawn at the one place that DOES know a request came from outside: here,
// consulted by the portal, per request.
//
// DEFAULT DENY. A path no rule names is refused, so a route added to the daemon
// is unreachable remotely until someone classifies it on purpose.
// test/remote-policy.test.js parses every `app.<verb>(` in lib/server/routes/ and
// fails on any route this table does not name — the ratchet that turns "forgot
// to think about remote" from a silent exposure into a red build.
//
// What is refused, and why, in one line each (the hint names what to run on the
// host instead):
//   * pack writes, component saves, service trust — host code reaches the
//     machine through these; consent for that is a terminal act, never a page's.
//   * the turn/hook/channel internals and the event log — the Claude Code
//     harness's own endpoints, not the surface's.
//   * shutdown, `format=file` exports, profile reload — act on the host's disk
//     or process.
//   * captures and the extension downloads — the capture pipeline is the host
//     browser's, with its own token.
//   * POST /api/graph/wipe — refused unless the operator opted into
//     `remote.allowDestructive`.
//   * GET /api/machine/sessions — it answers about EVERY project on the
//     machine (roots, ports, who is mid-turn), not the one being viewed.
//
// One decision is not a path's: an `html` spawn on POST /api/pane/spawn. The
// path is allowed (a pane putting up a saved component is surface-level), but
// raw HTML sent by a remote viewer's pane is code the viewer writes into the
// host user's surface, so the ROUTE refuses that body when the portal's
// X-WC-Remote label is on the request (lib/server/routes/spawn.js). The table
// stays the one place for path-level decisions; a body-level rule is recorded
// on its row as a `note`, so reading the table still tells the whole story.
//
// Matching mirrors Express, which is what finally routes the request: HEAD is
// GET, paths match case-insensitively, one trailing slash is ignored. Anything
// Express and this table might READ DIFFERENTLY — an encoded slash, a `.`/`..`
// segment, an empty segment, a backslash, a control character, a malformed
// escape — is refused outright rather than guessed at, because the failure this
// table exists to prevent is "classified as the allowed route, routed to the
// refused one".
//
// Zero imports: lib/core is the dependency leaf, and a policy table has no
// business needing anything.

// Pattern grammar: literal segments; `:name` matches exactly one segment; a
// final `*` matches zero or more further segments (so `/api/comments/*` covers
// `/api/comments` and everything below it). `methods` is a list, or '*' for
// any. FIRST MATCH WINS — a narrower allow must sit above a broader refuse.
//
// The hints are read by a person looking at a 403 in a remote browser, so they
// say what to do on the host, not what the rule is.
const HOST_ONLY = 'this is the Claude Code harness\'s endpoint — it is driven from the host, never from a browser';
const PACK_HINT = 'run on the host: claude-web-chat pack install|approve|remove <…>';
const CAPTURE_HINT = 'captures come from the browser extension on the host — capture there';
const EXT_HINT = 'the browser extensions are installed on the host: run claude-web-chat open there';

const RULES = [
  // ── the SPA's static assets ──────────────────────────────────────────────
  { methods: ['GET'], path: '/', allow: true },
  { methods: ['GET'], path: '/index.html', allow: true },
  { methods: ['GET'], path: '/app.css', allow: true },
  { methods: ['GET'], path: '/page.css', allow: true },
  { methods: ['GET'], path: '/mount-runtime.js', allow: true },
  { methods: ['GET'], path: '/app/*', allow: true },
  { methods: ['GET'], path: '/fonts/*', allow: true },
  { methods: ['GET'], path: '/brand/*', allow: true },
  // The live surface's WebSocket (an upgrade is a GET).
  { methods: ['GET'], path: '/ws', allow: true },

  // ── the graph ────────────────────────────────────────────────────────────
  { methods: ['GET'], path: '/api/graph', allow: true },
  { methods: ['GET'], path: '/api/graph/node/:id', allow: true },
  { methods: ['GET'], path: '/api/graph/diff', allow: true },
  { methods: ['GET'], path: '/preview/node/:id', allow: true },
  // One pane of one node, read-only, under the same PREVIEW_CSP.
  { methods: ['GET'], path: '/preview/pane/:node/:mount', allow: true },
  { methods: ['POST'], path: '/api/graph/active', allow: true },
  { methods: ['POST'], path: '/api/graph/bookmark', allow: true },
  { methods: ['POST'], path: '/api/graph/new', allow: true },
  { methods: ['POST'], path: '/api/graph/wipe', allow: true, destructive: true,
    hint: 'wiping the graph remotely is off — run it on the host, or set remote.allowDestructive in ~/.web-chat/tunnel/tunnel.json' },

  // ── turn / hook / channel internals and the event log ────────────────────
  { methods: '*', path: '/api/turn-begin', allow: false, hint: HOST_ONLY },
  { methods: '*', path: '/api/turn-end', allow: false, hint: HOST_ONLY },
  { methods: '*', path: '/api/commit', allow: false, hint: HOST_ONLY },
  { methods: '*', path: '/api/unlock', allow: false, hint: 'run on the host: claude-web-chat unlock' },
  { methods: '*', path: '/api/wait', allow: false, hint: HOST_ONLY },
  { methods: '*', path: '/api/render', allow: false, hint: HOST_ONLY },
  // write_markdown's route — Claude's write path like /api/render; the chrome
  // never calls it.
  { methods: '*', path: '/api/markdown', allow: false, hint: HOST_ONLY },
  { methods: '*', path: '/api/channel/*', allow: false, hint: HOST_ONLY },
  { methods: '*', path: '/api/events/*', allow: false, hint: HOST_ONLY },

  // ── the surface itself ───────────────────────────────────────────────────
  { methods: ['GET', 'POST'], path: '/api/store', allow: true },
  { methods: ['GET'], path: '/api/mounts', allow: true },
  // A pane's version history, and putting an old version back — a user
  // surface action; the lock and the owner gate are still the daemon's.
  { methods: ['GET'], path: '/api/mounts/:id/history', allow: true },
  { methods: ['POST'], path: '/api/mounts/:id/restore', allow: true },
  { methods: ['POST'], path: '/api/clear', allow: true },
  // The user's layout actions: ↺ Claude's layout, a run's stack flag, a move.
  { methods: ['POST'], path: '/api/page/reset-layout', allow: true },
  { methods: ['POST'], path: '/api/page/run', allow: true },
  { methods: ['POST'], path: '/api/page/move', allow: true },
  // Panes spawning panes (api.spawn / api.close).
  { methods: ['POST'], path: '/api/pane/spawn', allow: true,
    note: 'body-level: a spawn carrying `html` is refused by the route when X-WC-Remote is set (a remote viewer\'s raw HTML into the host\'s surface); a component spawn is not' },
  { methods: ['POST'], path: '/api/pane/close', allow: true },
  { methods: '*', path: '/api/comments/*', allow: true },
  { methods: '*', path: '/api/queue/*', allow: true },

  // ── theme ────────────────────────────────────────────────────────────────
  { methods: ['GET'], path: '/api/theme', allow: true },
  { methods: ['POST'], path: '/api/theme/apply', allow: true },
  { methods: ['GET', 'POST'], path: '/api/themes', allow: true },
  // Setting a raw theme layer is set_theme's route (Claude's), not the chrome's.
  { methods: ['POST'], path: '/api/theme', allow: false, hint: 'theme layers are set by Claude (set_theme) on the host; the theme picker still works' },

  // ── components and services ──────────────────────────────────────────────
  { methods: ['POST'], path: '/api/components/:name/use', allow: true },
  { methods: ['GET'], path: '/api/components/*', allow: true },
  { methods: '*', path: '/api/components/*', allow: false, hint: 'components are saved by Claude (save_component) or a pack on the host' },
  { methods: ['GET'], path: '/api/services/pending', allow: true },
  { methods: '*', path: '/api/services/*', allow: false, hint: 'run on the host: claude-web-chat trust <name>' },

  // ── packs: read-only remotely ────────────────────────────────────────────
  { methods: ['GET'], path: '/api/packs', allow: true },
  { methods: ['GET'], path: '/api/packs/audit', allow: true },
  { methods: ['GET'], path: '/api/packs/quarantine/:name/review', allow: true },
  { methods: '*', path: '/api/packs/*', allow: false, hint: PACK_HINT },

  // ── brand: the chrome reads the slots; setting one is the host's ──────────
  { methods: ['GET'], path: '/api/brand', allow: true },
  { methods: ['POST', 'PUT', 'PATCH', 'DELETE'], path: '/api/brand/*', allow: false, hint: 'brand images are set on the host' },

  // ── replay (forward-declared) — reading is fine; rendering spawns a process
  { methods: '*', path: '/api/replay/render', allow: false, hint: 'rendering a replay spawns a process — run it on the host' },
  { methods: ['GET'], path: '/replay', allow: true },
  { methods: ['GET'], path: '/api/replay/*', allow: true },

  // ── misc read-only ───────────────────────────────────────────────────────
  { methods: ['GET'], path: '/api/version', allow: true },
  { methods: ['GET'], path: '/api/health', allow: true },
  { methods: ['GET'], path: '/api/embed-check', allow: true },
  // The Sessions panel's feed lists every project on this machine — their
  // absolute roots, ports and turn state. Refused outright, never filtered
  // (lib/server/routes/machine.js).
  { methods: '*', path: '/api/machine/*', allow: false,
    hint: 'this lists every project on the host machine — run on the host: claude-web-chat ls' },
  // Download-as-attachment only; `format=file` writes to the host's disk.
  { methods: ['GET'], path: '/api/export/:ref', allow: true,
    refuseQuery: { key: 'format', value: 'file', hint: 'run on the host: claude-web-chat export <node>' } },

  // ── host process / disk ──────────────────────────────────────────────────
  { methods: '*', path: '/api/shutdown', allow: false, hint: 'run on the host: claude-web-chat stop' },
  { methods: '*', path: '/api/profiles/reload', allow: false, hint: 'run on the host: claude-web-chat profile reload' },
  { methods: '*', path: '/api/profiles/*', allow: false, hint: CAPTURE_HINT },

  // ── captures and the extensions ──────────────────────────────────────────
  { methods: '*', path: '/api/capture/*', allow: false, hint: CAPTURE_HINT },
  { methods: '*', path: '/api/captures/*', allow: false, hint: CAPTURE_HINT },
  { methods: '*', path: '/api/profile-match', allow: false, hint: CAPTURE_HINT },
  { methods: '*', path: '/extensions/*', allow: false, hint: EXT_HINT },
  { methods: '*', path: '/embed-helper/*', allow: false, hint: EXT_HINT },
];

const UNKNOWN_HINT = 'this route is not available remotely — use it on the host';
const MALFORMED_HINT = 'malformed path';

function keyOf(rule) {
  const m = rule.methods === '*' ? '*' : rule.methods.join('|');
  return `${m} ${rule.path}`;
}

// Pre-split once. Lowercased to match Express's case-insensitive routing.
const COMPILED = RULES.map((r) => ({
  rule: r,
  key: keyOf(r),
  segs: r.path === '/' ? [] : r.path.toLowerCase().split('/').slice(1),
}));

// A raw request target (`/a/b?x=1`) → { segs, query } in the one form rules
// match against, or null when the path is one Express and this table could
// read differently (see the header). Never throws.
function normalize(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl[0] !== '/') return null;
  const hash = rawUrl.indexOf('#');
  const noHash = hash === -1 ? rawUrl : rawUrl.slice(0, hash);
  const q = noHash.indexOf('?');
  let p = q === -1 ? noHash : noHash.slice(0, q);
  const query = q === -1 ? '' : noHash.slice(q + 1);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  const raw = p === '/' ? [] : p.split('/').slice(1);
  const segs = [];
  for (const s of raw) {
    let d;
    try { d = decodeURIComponent(s); } catch { return null; }
    // Checked AFTER decoding, so `%2f`, `%5c`, `%00` and `%2e%2e` are caught in
    // the same test as their literal spellings.
    // eslint-disable-next-line no-control-regex
    if (d === '' || d === '.' || d === '..' || /[\\/\x00-\x1f\x7f]/.test(d)) return null;
    segs.push(d.toLowerCase());
  }
  return { segs, query };
}

function segsMatch(pat, segs) {
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] === '*' && i === pat.length - 1) return true;
    if (i >= segs.length) return false;
    if (pat[i].startsWith(':')) continue;
    if (pat[i] !== segs[i]) return false;
  }
  return pat.length === segs.length;
}

// Every value a query key carries, however qs would spell it (`format=file`,
// `format[]=file`, `format[0]=file`) — the daemon's own check is a strict
// `=== 'file'`, but the table should not depend on that staying true.
function queryHas(query, key, value) {
  if (!query) return false;
  let params;
  try { params = new URLSearchParams(query); } catch { return true; } // unparseable: assume the worst
  for (const [k, v] of params) {
    const base = k.toLowerCase().replace(/\[.*$/, '');
    if (base === key && String(v).toLowerCase() === value) return true;
  }
  return false;
}

// THE question. `method` is the HTTP method, `rawUrl` the request target
// exactly as the portal received it (path + query). Returns
//   { allow: true,  key }                    — proxy it
//   { allow: false, key, reason, hint }      — refuse with refusalBody()
// where `key` names the rule that decided (null for the default deny) and
// `reason` is one of 'refused' | 'unknown' | 'malformed' | 'destructive' |
// 'query'.
function classify(method, rawUrl, { allowDestructive = false } = {}) {
  let m = String(method || '').toUpperCase();
  if (m === 'HEAD') m = 'GET';
  const n = normalize(rawUrl);
  if (!n) return { allow: false, key: null, reason: 'malformed', hint: MALFORMED_HINT };
  for (const c of COMPILED) {
    const { rule } = c;
    if (rule.methods !== '*' && !rule.methods.includes(m)) continue;
    if (!segsMatch(c.segs, n.segs)) continue;
    if (!rule.allow) return { allow: false, key: c.key, reason: 'refused', hint: rule.hint || UNKNOWN_HINT };
    if (rule.destructive && !allowDestructive) {
      return { allow: false, key: c.key, reason: 'destructive', hint: rule.hint || UNKNOWN_HINT };
    }
    if (rule.refuseQuery && queryHas(n.query, rule.refuseQuery.key, rule.refuseQuery.value)) {
      return { allow: false, key: c.key, reason: 'query', hint: rule.refuseQuery.hint };
    }
    return { allow: true, key: c.key };
  }
  return { allow: false, key: null, reason: 'unknown', hint: UNKNOWN_HINT };
}

// The 403 body a refusal is sent with. `remote:true` is what lets a page tell
// "refused because you are remote" apart from any other 403.
function refusalBody(verdict) {
  return { ok: false, remote: true, hint: (verdict && verdict.hint) || UNKNOWN_HINT };
}

module.exports = { RULES, classify, refusalBody, normalize };
