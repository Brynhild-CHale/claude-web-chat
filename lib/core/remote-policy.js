// Which daemon routes a REMOTE viewer may reach — the table the tunnel portal
// (lib/portal) consults before it proxies a request to a loopback daemon — and,
// beside it, the two tables the daemon itself reads to decide what a remote
// viewer's WebSocket frames and graph bodies may carry (FRAME_RULES and
// TEXT_RULES, at the end of this file).
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
//   * theme saves and raw theme layers — raw CSS into the chrome, and a saved
//     system default reaches every project on the host.
//   * the turn/hook/channel internals and the event log — the Claude Code
//     harness's own endpoints, not the surface's. The chat mirror's hook
//     intake, the hook-facing asks routes, the control layer's notices claim
//     and the mod's bridge are the same kind (spec §5.7, class P1).
//   * shutdown, `format=file` exports, profile reload — act on the host's disk
//     or process.
//   * captures and the extension downloads — the capture pipeline is the host
//     browser's, with its own token.
//   * remote-access setup (/tunnel/setup and the setup page's /setup/*) — it
//     takes a Cloudflare API token and decides where the surfaces go.
//   * POST /api/graph/wipe and POST /api/graph/new — refused unless the
//     operator opted into `remote.allowDestructive`. A new graph takes more
//     than a wipe does (pinned panes and markdown go, `active` detaches), so it
//     is no less destructive.
//   * GET /api/machine/sessions — it answers about EVERY project on the
//     machine (roots, ports, who is mid-turn), not the one being viewed.
//   * setting the project's identity — display-only, but the host's choice
//     (claude-web-chat identity), like a brand image.
//
// THE CHAT MIRROR'S LEVEL. A row may also name `mirror: 'basic'|'read'|'full'`,
// the least mirror level a remote viewer needs for it (spec §5.2). A remote
// viewer's level is its project's opt-in in ~/.web-chat/tunnel/tunnel.json
// (`remote.mirror`, set only by `claude-web-chat tunnel mirror on|off` on the
// host and read by lib/tunnel/config mirrorLevelFor): no key is `basic`, the
// heartbeat only; `--read-only` is `read`, all of the conversation and nothing
// that acts; `on` is `full`, the composer and task stops too. classify() takes
// that opt-in and refuses a row it does not meet with reason 'mirror' and the
// row's hint, which names the host command. The daemon checks the level again
// itself (lib/server/audience requireMirror), the shape of the packs routes'
// second lock, and is the only lock for a peer on a WEB_CHAT_HOST bind, which
// never reaches this table and is held to `basic` (Q9, carve-strict).
//
// Rows for routes that land in later units of the release are here already:
// the ratchet needs every route to have a row, not every row a route, so the
// table is written once, ahead of the route files (spec §5.3, §11.1 rule 5). A
// portal older than these rows (PORTAL_PROTOCOL_VERSION 8) has no row for any
// of them and refuses them all by the default deny, so a rollback fails safe —
// except the two queue writes below, which that table's `/api/queue/*` row
// lets through and the daemon's own level check refuses.
//
// Two decisions are not a path's. An `html` spawn on POST /api/pane/spawn: the
// path is allowed (a pane putting up a saved component is surface-level), but
// raw HTML sent by a remote viewer's pane is code the viewer writes into the
// host user's surface, so the ROUTE refuses that body when the portal's
// X-WC-Remote label is on the request (lib/server/routes/spawn.js). And a
// clear with no `id` on POST /api/clear: closing one pane (the chrome's ×) is
// surface-level, but a page-wide clear — `force:true` takes the pinned panes
// too — empties the surface as a wipe does, so lib/server/routes/render.js
// refuses it under the same label. The table stays the one place for
// path-level decisions; a body-level rule is recorded on its row as a `note`,
// so reading the table still tells the whole story.
//
// Matching mirrors Express, which is what finally routes the request: HEAD is
// GET, paths match case-insensitively, one trailing slash is ignored. Anything
// Express and this table might READ DIFFERENTLY — an encoded slash, a `.`/`..`
// segment, an empty segment, a backslash, a control character, a malformed
// escape — is refused outright rather than guessed at, because the failure this
// table exists to prevent is "classified as the allowed route, routed to the
// refused one".
//
// NOT in this table: the portal's own apex routes. The picker (GET
// /api/sessions, its static assets) and its one write — POST
// /api/sessions/<id>/start, which starts a KNOWN project's daemon — live on the
// PORTAL (lib/portal/picker.js, lib/portal/start.js), are answered there, and
// never reach a daemon. On a SESSION hostname `/api/sessions/*` names no rule
// here, so the default deny refuses it: a session's page cannot start other
// projects through its own daemon.
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
const SETUP_HINT = 'remote access is set up on the host: ⌘K → Set up remote access…, or claude-web-chat tunnel setup';
const DESTRUCTIVE_HINT = 'wiping the graph or starting a new one remotely is off — run it on the host, or set remote.allowDestructive in ~/.web-chat/tunnel/tunnel.json';
const MIRROR_HINT = 'the conversation is not shared with remote viewers of this project — on the host: claude-web-chat tunnel mirror on';
const MIRROR_FULL_HINT = 'this needs full mirror access — on the host: claude-web-chat tunnel mirror on (without --read-only)';
const IDENTITY_HINT = 'the project identity is set on the host: claude-web-chat identity';

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
  // web-chat's default favicons, light and dark, and the home-screen icon
  // (public/, spec §9.7) — rows here so the unit that ships them edits no table.
  { methods: ['GET'], path: '/favicon.png', allow: true },
  { methods: ['GET'], path: '/favicon-dark.png', allow: true },
  { methods: ['GET'], path: '/apple-touch-icon.png', allow: true },
  // The live surface's WebSocket (an upgrade is a GET).
  { methods: ['GET'], path: '/ws', allow: true },

  // ── the graph ────────────────────────────────────────────────────────────
  { methods: ['GET'], path: '/api/graph', allow: true },
  { methods: ['GET'], path: '/api/graph/node/:id', allow: true },
  { methods: ['GET'], path: '/api/graph/changes', allow: true },
  { methods: ['GET'], path: '/api/graph/diff', allow: true },
  { methods: ['GET'], path: '/preview/node/:id', allow: true },
  // One pane of one node, read-only, under the same PREVIEW_CSP.
  { methods: ['GET'], path: '/preview/pane/:node/:mount', allow: true },
  { methods: ['POST'], path: '/api/graph/active', allow: true },
  { methods: ['POST'], path: '/api/graph/bookmark', allow: true },
  { methods: ['POST'], path: '/api/graph/new', allow: true, destructive: true, hint: DESTRUCTIVE_HINT },
  { methods: ['POST'], path: '/api/graph/wipe', allow: true, destructive: true, hint: DESTRUCTIVE_HINT },

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
  // The chat mirror's hook intake (POST /api/hooks/event): Claude Code's hooks
  // post here through lib/client, never a browser.
  { methods: '*', path: '/api/hooks/*', allow: false, hint: HOST_ONLY },

  // ── the surface itself ───────────────────────────────────────────────────
  { methods: ['GET', 'POST'], path: '/api/store', allow: true },
  { methods: ['GET'], path: '/api/mounts', allow: true },
  // A pane's version history, and putting an old version back — a user
  // surface action; the lock and the owner gate are still the daemon's.
  { methods: ['GET'], path: '/api/mounts/:id/history', allow: true },
  { methods: ['POST'], path: '/api/mounts/:id/restore', allow: true },
  { methods: ['POST'], path: '/api/clear', allow: true,
    note: 'body-level: a clear with no `id` (the whole page, or a whole target) is refused by the route when X-WC-Remote is set; closing one pane by id, forced or not, is not' },
  // The user's layout actions: ↺ Claude's layout, a run's stack flag, a move.
  { methods: ['POST'], path: '/api/page/reset-layout', allow: true },
  { methods: ['POST'], path: '/api/page/run', allow: true },
  { methods: ['POST'], path: '/api/page/move', allow: true },
  // Panes spawning panes (api.spawn / api.close).
  { methods: ['POST'], path: '/api/pane/spawn', allow: true,
    note: 'body-level: a spawn carrying `html` is refused by the route when X-WC-Remote is set (a remote viewer\'s raw HTML into the host\'s surface); a component spawn is not' },
  { methods: ['POST'], path: '/api/pane/close', allow: true },
  { methods: '*', path: '/api/comments/*', allow: true },
  // A composer message and a task's stop request reach Claude in the user's
  // voice (spec §6.3, §6.9): a remote viewer needs the project's full opt-in.
  // Above the queue's own row, which they would otherwise fall to. The other
  // queue writes stay on that row; PATCH, DELETE, push and pending/recall check
  // the level in the route whenever they would send, edit, re-hold or remove a
  // message.
  { methods: ['POST'], path: '/api/queue/message', allow: true, mirror: 'full', hint: MIRROR_FULL_HINT },
  { methods: ['POST'], path: '/api/queue/task-stop', allow: true, mirror: 'full', hint: MIRROR_FULL_HINT },
  { methods: '*', path: '/api/queue/*', allow: true },

  // ── the chat mirror (spec §2.10, §4.3, §5.3) ─────────────────────────────
  // The heartbeat (access, status, the snapshot's status rows) reaches every
  // remote viewer; the conversation itself needs `read`. A `basic` row never
  // refuses by level — its `mirror` says it is the mirror's, and the route
  // projects its body below `read`.
  { methods: ['GET'], path: '/api/mirror/access', allow: true, mirror: 'basic', hint: MIRROR_HINT },
  { methods: ['GET'], path: '/api/mirror/status', allow: true, mirror: 'basic', hint: MIRROR_HINT },
  { methods: ['GET'], path: '/api/mirror', allow: true, mirror: 'basic', hint: MIRROR_HINT,
    note: 'route-level: below read the body is status rows only' },
  { methods: ['GET'], path: '/api/mirror/*', allow: true, mirror: 'read', hint: MIRROR_HINT },
  { methods: '*', path: '/api/mirror/*', allow: false, hint: HOST_ONLY },
  // Asks: the chrome's read of what waits on the user; the hook-facing routes
  // (create, the long-poll, withdraw, handed) are the harness's. A decision is
  // made on the answer origin, never here.
  { methods: ['GET'], path: '/api/asks', allow: true, mirror: 'basic', hint: MIRROR_HINT,
    note: 'route-level: below read, the typed projection' },
  { methods: '*', path: '/api/asks/*', allow: false, hint: HOST_ONLY },
  // The composer's `@` files (names only, never content) and `/` skills.
  { methods: ['GET'], path: '/api/files', allow: true, mirror: 'full', hint: MIRROR_FULL_HINT },
  { methods: ['GET'], path: '/api/skills', allow: true, mirror: 'full', hint: MIRROR_FULL_HINT },
  // The control layer (spec §15): the restore preview is a read; restoring is
  // a control action on the answer origin, never a route here. The notices
  // claim is turn-begin's, and the bridge is the mod's — both host only.
  { methods: ['GET'], path: '/api/code/preview', allow: true, mirror: 'read', hint: MIRROR_HINT },
  { methods: '*', path: '/api/code/*', allow: false, hint: HOST_ONLY },
  { methods: '*', path: '/api/control/*', allow: false, hint: HOST_ONLY },
  { methods: '*', path: '/api/bridge/*', allow: false, hint: HOST_ONLY },
  // An image the user adds to a composer message (tier 2, spec §15.7).
  { methods: ['POST'], path: '/api/attachments', allow: true, mirror: 'full', hint: MIRROR_FULL_HINT },

  // ── the project's identity (spec §9.3): read anywhere, set on the host ────
  { methods: ['GET'], path: '/api/project', allow: true },
  // The logo, the mark and the home-screen icon.
  { methods: ['GET'], path: '/project/*', allow: true },
  { methods: '*', path: '/api/project/*', allow: false, hint: IDENTITY_HINT },

  // ── theme ────────────────────────────────────────────────────────────────
  { methods: ['GET'], path: '/api/theme', allow: true },
  { methods: ['POST'], path: '/api/theme/apply', allow: true },
  // The picker only LISTS themes and applies one it listed. Saving a theme is
  // save_theme's route: its raw `css` reaches the unsandboxed chrome, and
  // `location:'system'` / `set_default` write ~/.web-chat, which every project
  // on the host falls back to — hidden ones included.
  { methods: ['GET'], path: '/api/themes', allow: true },
  { methods: ['POST'], path: '/api/themes', allow: false, hint: 'themes are saved by Claude (save_theme) on the host; the theme picker still works' },
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
  // a staged theme's logo thumbnail — an image that passed the Brand check,
  // served sandboxed; the review card is readable remotely, so its pictures are
  { methods: ['GET'], path: '/api/packs/quarantine/:name/logo', allow: true },
  { methods: '*', path: '/api/packs/*', allow: false, hint: PACK_HINT },

  // ── brand: the chrome reads the slots; setting one is the host's ──────────
  { methods: ['GET'], path: '/api/brand', allow: true },
  { methods: ['POST', 'PUT', 'PATCH', 'DELETE'], path: '/api/brand/*', allow: false, hint: 'brand images are set on the host' },

  // ── replay (forward-declared) — reading is fine; rendering spawns a process
  { methods: '*', path: '/api/replay/render', allow: false, hint: 'rendering a replay spawns a process — run it on the host' },
  // Opening the player is Claude's (export open:true), on the host — the route refuses a remote request itself too.
  { methods: '*', path: '/api/replay/open', allow: false, hint: 'Claude opens a replay in the player from the host; R opens the player here' },
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
  // Remote-access setup takes a Cloudflare API token and decides where this
  // machine's surfaces are published — the host's act, never a remote
  // viewer's. /tunnel/setup is the daemon's launcher; /setup/* is the setup
  // page's own listener (lib/server/tunnel-setup), which the portal never
  // proxies to — named here so the refusal is on record either way.
  { methods: '*', path: '/tunnel/*', allow: false, hint: SETUP_HINT },
  { methods: '*', path: '/setup/*', allow: false, hint: SETUP_HINT },
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

// ── the mirror level (spec §5.2) ─────────────────────────────────────────────
// What one viewer may see of the chat mirror, least first. `local` is a
// loopback peer without the portal's label — the chrome, panes, local
// processes — and is never a remote viewer's: nothing in this file grants it.
// The one home for the order, so the daemon's audience gate and this table
// cannot disagree about it.
const MIRROR_LEVELS = Object.freeze(['basic', 'read', 'full', 'local']);

// -1 for anything that is not a level, which then meets nothing.
function rankLevel(level) {
  return MIRROR_LEVELS.indexOf(level);
}

// Does `level` meet `need`? False for an unknown either side: fail closed.
function atLeast(level, need) {
  const n = rankLevel(need);
  return n !== -1 && rankLevel(level) >= n;
}

// A project's opt-in ('off' | 'read' | 'full', lib/tunnel/config
// mirrorLevelFor) as the level its remote viewers get. Anything else — absent,
// misspelt, 'local' — is `basic`: a remote viewer is never granted more than
// the opt-in says.
function remoteLevel(optIn) {
  return optIn === 'read' || optIn === 'full' ? optIn : 'basic';
}

// A rule's name in a verdict (`key`): its methods and path, e.g.
// `GET /api/mirror/*`.
function keyOf(rule) {
  const m = rule.methods === '*' ? '*' : rule.methods.join('|');
  return `${m} ${rule.path}`;
}

// Pre-split once. Lowercased to match Express's case-insensitive routing.
function compile(rules) {
  return rules.map((r) => ({
    rule: r,
    key: keyOf(r),
    segs: r.path === '/' ? [] : r.path.toLowerCase().split('/').slice(1),
  }));
}

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
// exactly as the portal received it (path + query); `mirror` is the session's
// project's opt-in ('off' | 'read' | 'full'; absent is 'off'). Returns
//   { allow: true,  key }                    — proxy it
//   { allow: false, key, reason, hint }      — refuse with refusalBody()
// where `key` names the rule that decided (null for the default deny) and
// `reason` is one of 'refused' | 'unknown' | 'malformed' | 'destructive' |
// 'query' | 'mirror'. A 'mirror' refusal also carries `level` (the viewer's)
// and `need` (the row's).
//
// classifier(rules) is the same question over another table in the same
// grammar (first match wins, default deny) — classify is classifier(RULES).
function classifier(rules) {
  const compiled = compile(rules);
  return (method, rawUrl, opts) => decide(compiled, method, rawUrl, opts);
}

function decide(compiled, method, rawUrl, { allowDestructive = false, mirror = 'off' } = {}) {
  let m = String(method || '').toUpperCase();
  if (m === 'HEAD') m = 'GET';
  const n = normalize(rawUrl);
  if (!n) return { allow: false, key: null, reason: 'malformed', hint: MALFORMED_HINT };
  for (const c of compiled) {
    const { rule } = c;
    if (rule.methods !== '*' && !rule.methods.includes(m)) continue;
    if (!segsMatch(c.segs, n.segs)) continue;
    if (!rule.allow) return { allow: false, key: c.key, reason: 'refused', hint: rule.hint || UNKNOWN_HINT };
    if (rule.mirror) {
      const level = remoteLevel(mirror);
      if (!atLeast(level, rule.mirror)) {
        return { allow: false, key: c.key, reason: 'mirror', hint: rule.hint || MIRROR_HINT, level, need: rule.mirror };
      }
    }
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

const classify = classifier(RULES);

// The 403 body a refusal is sent with. `remote:true` is what lets a page tell
// "refused because you are remote" apart from any other 403; a refusal for the
// mirror level also says which level the viewer has (`mirror`), as the
// daemon's own level gate does.
function refusalBody(verdict) {
  const body = { ok: false, remote: true, hint: (verdict && verdict.hint) || UNKNOWN_HINT };
  if (verdict && verdict.reason === 'mirror') body.mirror = verdict.level;
  return body;
}

// ── frames: FRAME_RULES, projectFrame, projectValue (spec §5.3) ─────────────
// The portal relays a socket's frames verbatim — parsing every frame in the
// access-control process is the wrong place — so the DAEMON decides, per
// socket, from this table (lib/server/ws.js, through projectFrame): which
// `mirror:*` frames a socket at a level gets, and for a `basic` socket the
// typed projection of the few that reach it.
//
// A basic schema is data: `{ key: <schema> }`, where a schema is a type name
// (below), a nested object schema, or `{ rows: <object schema> }` — a list of
// objects, each projected by that schema. The types are deliberately narrow:
// a projected value is a state word, an id, a number, a boolean or counts,
// never text, so a field of the wrong shape (a command put in `step_kind`, an
// MCP tool's name, a path) is dropped rather than leaked.
//   word     /^[A-Za-z][A-Za-z0-9_-]{0,23}$/ with no `__`, so `mcp__x__y` fails
//   id       /^[A-Za-z0-9_-]{1,64}$/
//   number   a finite number
//   boolean  true or false
//   counts   an object of at most 8 word keys, each an integer 0–9,999
// A listed key whose value is null keeps null — null carries nothing, and it
// keeps a basic row the same shape as a full one, so a field that went back to
// null clears at every level. `rows` keeps at most 32 objects (the first 32;
// anything in the list that is not an object is dropped) — a bound on what a
// basic viewer can be sent, never a reason to send it nothing.
//
// The HTTP bodies that serve `basic` (GET /api/mirror, /api/mirror/status,
// /api/asks) pass their rows through projectValue with these same schemas,
// exported by name, so a field cannot reach a basic viewer over HTTP and not
// over the socket, or the reverse.
const WORD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COUNTS_MAX_KEYS = 8;
const COUNT_MAX = 9999;
const ROWS_MAX = 32;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isWord = (v) => typeof v === 'string' && WORD_RE.test(v) && !v.includes('__');

const TYPES = {
  word: isWord,
  id: (v) => typeof v === 'string' && ID_RE.test(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  counts: (v) => {
    if (!isObject(v)) return false;
    const keys = Object.keys(v);
    if (keys.length > COUNTS_MAX_KEYS) return false;
    return keys.every((k) => isWord(k) && Number.isInteger(v[k]) && v[k] >= 0 && v[k] <= COUNT_MAX);
  },
};

// `{ rows: <object schema> }` is a list; an object schema whose one key is
// `rows` naming a TYPE (`{ rows: 'number' }`) is an ordinary object with a
// field called rows.
const isRowsSchema = (s) => isObject(s) && Object.keys(s).length === 1 && hasOwn(s, 'rows') && isObject(s.rows);

function badSchema(schema) {
  return new TypeError(`remote-policy: not a projection schema: ${JSON.stringify(schema)}`);
}

// Throws unless `schema` is well-formed all the way down: every leaf a type
// name, every list's rows an object schema (a list of lists is not a shape any
// frame has). Run on every FRAME_RULES schema at load, so a typo fails the
// require, never a frame.
function assertSchema(schema) {
  if (typeof schema === 'string') {
    if (!hasOwn(TYPES, schema)) throw badSchema(schema);
    return;
  }
  if (!isObject(schema)) throw badSchema(schema);
  if (isRowsSchema(schema)) {
    if (isRowsSchema(schema.rows)) throw badSchema(schema);
    assertSchema(schema.rows);
    return;
  }
  for (const k of Object.keys(schema)) assertSchema(schema[k]);
}

// The one basic projection: `value` through `schema`. Returns the value (a
// passing scalar), a new object or array (a structural schema), null (null
// passes every schema), or undefined when the value fails its schema — a key
// whose projection is undefined is left out. Never returns anything the schema
// does not name. Throws only for a malformed SCHEMA (a programmer's error,
// never data's).
function projectValue(schema, value) {
  if (typeof schema === 'string') {
    const check = hasOwn(TYPES, schema) ? TYPES[schema] : null;
    if (!check) throw badSchema(schema);
    if (value === null) return null;
    if (!check(value)) return undefined;
    return schema === 'counts' ? { ...value } : value;
  }
  if (!isObject(schema)) throw badSchema(schema);
  if (isRowsSchema(schema)) {
    if (value === null) return null;
    if (!Array.isArray(value)) return undefined;
    const out = [];
    for (const el of value) {
      if (out.length >= ROWS_MAX) break;
      if (!isObject(el)) continue;
      const row = projectValue(schema.rows, el);
      if (row !== undefined) out.push(row);
    }
    return out;
  }
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const out = {};
  for (const key of Object.keys(schema)) {
    if (!hasOwn(value, key)) continue;
    const v = projectValue(schema[key], value[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// The status bar's heartbeat, one StatusRow per conversation (spec §2.9):
// content-free by construction, and typed here anyway.
const STATUS_ROW_SCHEMA = deepFreeze({
  id: 'id', state: 'word', since: 'number', quiet: 'boolean', step_kind: 'word',
  waiting_kind: 'word', last_activity_at: 'number', ended_reason: 'word', counts: 'counts',
});
const STATUS_SCHEMA = deepFreeze({
  rev: 'number', now: 'number', aggregate: { state: 'word' }, conversations: { rows: STATUS_ROW_SCHEMA },
});
// An ask's public view below `read` (spec §4.3): what kind of thing waits,
// never its subject, input, questions or plan.
const ASK_SCHEMA = deepFreeze({ id: 'id', conversation_id: 'id', kind: 'word', tool_kind: 'word', state: 'word' });
const ASK_FRAME_SCHEMA = deepFreeze({ op: 'word', ask: ASK_SCHEMA });
const RESET_SCHEMA = deepFreeze({ reason: 'word', conversation_id: 'id' });

// One row per `mirror:*` frame type (test/remote-policy.test.js holds a row
// for every `type: 'mirror:<x>'` literal under lib/server/). `level` is the
// least level that gets the whole frame; `basic`, when present, is what a
// `basic` socket gets instead; `posture: 'full'` sends the frame only to a
// socket with a chat view open (posture is whether a socket wants stream
// frames at all, a matter of volume rather than access, spec §2.9).
const FRAME_RULES = deepFreeze([
  { type: 'mirror:status', level: 'basic', basic: STATUS_SCHEMA },
  { type: 'mirror:reset', level: 'basic', basic: RESET_SCHEMA },
  { type: 'mirror:access', level: 'basic' },
  { type: 'mirror:ask', level: 'basic', basic: ASK_FRAME_SCHEMA },
  { type: 'mirror:update', level: 'read' },
  { type: 'mirror:stream', level: 'read', posture: 'full' },
]);
const FRAME_RULE = new Map(FRAME_RULES.map((r) => [r.type, r]));

for (const r of FRAME_RULES) {
  if (r.basic) assertSchema(r.basic);
}

const POSTURES = ['status', 'full'];

// One frame for one socket: the frame itself, a projected copy, or null (do
// not send). In this order:
//   a type not starting with 'mirror:'     → the frame (today's surface, every level)
//   no row                                 → the frame at 'local', else null (default deny)
//   row.posture and the posture below it   → null
//   level 'basic' and row.basic            → { type, …the listed keys whose values pass their type }
//   level meets row.level                  → the frame
//   otherwise                              → null
// The basic projection is decided before the level: a row with a `basic`
// schema is exactly one a basic socket must get only typed — `mirror:status`
// is level 'basic' AND projected. An unknown level meets nothing (null for
// every mirror frame); an unknown posture is 'status'.
function projectFrame(frame, level, posture = 'status') {
  const type = frame && typeof frame === 'object' ? frame.type : undefined;
  if (typeof type !== 'string' || !type.startsWith('mirror:')) return frame;
  const row = FRAME_RULE.get(type);
  if (!row) return level === 'local' ? frame : null;
  if (row.posture && POSTURES.indexOf(posture) < POSTURES.indexOf(row.posture)) return null;
  if (level === 'basic' && row.basic) return { type, ...projectValue(row.basic, frame) };
  if (atLeast(level, row.level)) return frame;
  return null;
}

// ── TEXT_RULES: the graph's conversation text below `read` (spec §5.2-5.3) ──
// Frames and bodies that are not mirror frames but carry conversation text:
// the typed prompt in the lock (lock frames, and the lock inside hello, reset
// and GET /api/graph), each node's trigger_summary (the prompt's first 100
// characters) in node-added frames and GET /api/graph, and the whole node —
// prompt, summary and reply — from GET /api/graph/node/:id, plus the session
// fields 0.8.5 adds to the lock and `node.mirror`. lib/server/ws.js strips
// `frames` for a socket below `read`, and lib/server/routes/graph.js strips
// `routes` for a request below `read`; a local socket or request is never
// projected (test/bus-golden.test.js stays byte-identical).
//
// A path is dot-separated keys; `key[]` steps into every element of an array.
// test/remote-policy.test.js pins the table against today's carriers: every
// `lockView(` call under lib/server/ sits in a frame or body named here.
const LOCK_TEXT = ['lock.message', 'lock.session_id', 'lock.claude_pid', 'lock.prompt_id'];
const TEXT_RULES = deepFreeze({
  frames: {
    hello: [...LOCK_TEXT],
    reset: [...LOCK_TEXT],
    lock: [...LOCK_TEXT],
    'node-added': ['node.trigger_summary'],
  },
  routes: {
    'GET /api/graph': ['nodes[].trigger_summary', 'nodes[].absorbed[].trigger_summary', ...LOCK_TEXT],
    'GET /api/graph/node/:id': ['trigger.message', 'trigger.summary', 'trigger.reply', 'trigger.error',
      'folded[].message', 'folded[].summary', 'folded[].reply', 'mirror'],
  },
});

const TEXT_PATH_RE = /^[a-z_][a-z0-9_]*(\[\])?(\.[a-z_][a-z0-9_]*(\[\])?)*$/;

// A list of paths → one trie, so a body is walked (and copied) once however
// many of its paths are stripped: `{ lock: { message: true, … } }`, an `[]`
// segment kept as its own key (`{ 'nodes[]': { trigger_summary: true } }`).
// `true` deletes the key there; deleting a key wins over any path below it.
function compileTextPaths(paths) {
  const trie = {};
  for (const p of paths) {
    if (typeof p !== 'string' || !TEXT_PATH_RE.test(p) || p.endsWith('[]')) {
      throw new TypeError(`remote-policy: not a TEXT_RULES path: ${JSON.stringify(p)}`);
    }
    const segs = p.split('.');
    let node = trie;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (i === segs.length - 1) { node[seg] = true; break; }
      if (node[seg] === true) break;
      if (!hasOwn(node, seg)) node[seg] = {};
      node = node[seg];
    }
  }
  return trie;
}

const TEXT_TRIES = {
  frames: new Map(Object.entries(TEXT_RULES.frames).map(([k, v]) => [k, compileTextPaths(v)])),
  routes: new Map(Object.entries(TEXT_RULES.routes).map(([k, v]) => [k, compileTextPaths(v)])),
};

// `value` without the trie's paths: a copy of each object and array on the
// way to a stripped key, everything else shared (a frame or body is
// serialized at once, never mutated). Returns `value` itself when nothing the
// trie names is present.
function stripTrie(value, trie) {
  if (!isObject(value)) return value;
  let out = null;
  for (const seg of Object.keys(trie)) {
    const sub = trie[seg];
    const each = seg.endsWith('[]');
    const key = each ? seg.slice(0, -2) : seg;
    if (!hasOwn(value, key)) continue;
    if (sub === true) {
      if (!out) out = { ...value };
      delete out[key];
      continue;
    }
    const cur = value[key];
    let next = cur;
    if (each) {
      if (!Array.isArray(cur)) continue;
      let changed = false;
      const mapped = cur.map((el) => {
        const s = stripTrie(el, sub);
        if (s !== el) changed = true;
        return s;
      });
      if (changed) next = mapped;
    } else {
      next = stripTrie(cur, sub);
    }
    if (next !== cur) {
      if (!out) out = { ...value };
      out[key] = next;
    }
  }
  return out || value;
}

// stripText(kind, key, value) → `value` without TEXT_RULES[kind][key]'s paths
// (a missing path is fine). `kind` is 'frames' (key: a frame's `type`) or
// 'routes' (key: 'GET /api/graph', as the table spells it); 'frame' and
// 'route' are read the same. A key with no entry has nothing to strip, and
// the value comes back as it is.
function stripText(kind, key, value) {
  const table = kind === 'frames' || kind === 'frame' ? TEXT_TRIES.frames
    : kind === 'routes' || kind === 'route' ? TEXT_TRIES.routes : null;
  if (!table) throw new TypeError(`remote-policy: stripText kind must be 'frames' or 'routes' (got ${JSON.stringify(kind)})`);
  const trie = table.get(key);
  return trie ? stripTrie(value, trie) : value;
}

module.exports = {
  RULES, classify, classifier, keyOf, refusalBody, normalize,
  MIRROR_HINT, MIRROR_FULL_HINT, MIRROR_LEVELS, rankLevel, atLeast, remoteLevel,
  FRAME_RULES, projectFrame, projectValue,
  STATUS_SCHEMA, STATUS_ROW_SCHEMA, ASK_SCHEMA, ASK_FRAME_SCHEMA, RESET_SCHEMA,
  TEXT_RULES, stripText,
};
