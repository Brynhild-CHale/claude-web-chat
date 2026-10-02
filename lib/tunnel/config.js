// The tunnel's configuration — ~/.web-chat/tunnel/tunnel.json — read, checked
// and turned into the one thing every portal request needs: "which hostname is
// this, and what does it name?" — plus the named tunnel cloudflared runs.
//
// Shared (lib/tunnel), not the portal's own: the portal process, `tunnel
// setup|up|status` and `doctor` all read this file, and they must agree on what
// a valid one is, so there is exactly one normaliser and one loader.
//
// The file (written by `claude-web-chat tunnel setup`):
//
//   {
//     "hostname": "wc.example.com",        the picker; sessions hang off it
//     "style":    "flat" | "nested",       default flat
//     "access":   { "team": "<team>", "aud": "<Access application AUD tag>" },
//     "allow":    { "emails": ["me@example.com"], "domains": [] },
//     "showRoots": false,                  picker shows full project paths
//     "remote":   { "allowDestructive": false,  a remote viewer may wipe the graph
//                                           or start a new one
//                   "mirror": { "/abs/project/dir": "full", "0a1b2c3d": "read" } },
//                                           the chat mirror's opt-in (below)
//     "expose":   { "exclude": ["0a1b2c3d", "/abs/project/dir"] },  never served
//     "tunnel":   { "kind": "token" | "local", "name": "<tunnel>",
//                   "credentialsFile": "<path>", "metricsPort": 5172 },
//     "signin":   "pin+biometric" | "pin" | "google"   optional — what
//                  `tunnel setup --api-token` configured in Access (a record
//                  for status and a re-run, never a permission)
//   }
//
// `tunnel` is the NAMED Cloudflare tunnel the portal supervises cloudflared
// for. `token`: a dashboard-managed tunnel, its connector token in
// ~/.web-chat/tunnel/token (0600) and handed to cloudflared in TUNNEL_TOKEN —
// never argv, where every local user's `ps` can read it. `local`: a tunnel
// created with `cloudflared tunnel create <name>`, run from an ingress file the
// portal generates. Absent: the portal runs alone (you run cloudflared). A
// QUICK tunnel (trycloudflare.com) is refused outright — it cannot sit behind
// Cloudflare Access, so every request would arrive with no token to check.
//
// Hostname styles. FLAT is the default because Cloudflare's free Universal SSL
// certificate covers ONE level of subdomain: `wc-<id>.example.com` is covered by
// `*.example.com`, while NESTED `<id>.wc.example.com` needs Advanced/Total TLS.
//
//   flat    picker wc.example.com      session wc-<id>.example.com
//   nested  picker wc.example.com      session <id>.wc.example.com
//
// `<id>` is the registry's instance id (lib/util/registry instanceId): eight
// lowercase hex characters, and nothing else is ever read as one.
//
// The chat mirror's opt-in, `remote.mirror` (spec §5.2): which projects show
// Claude's conversation to their remote viewers, and how much. Each key names
// ONE project — its absolute root, as `claude-web-chat tunnel mirror on`
// writes it, or its instance id — and matches exactly: unlike expose.exclude,
// which hides everything under a directory, a grant never spreads to the
// projects under the one it names. Each value is `read` (the conversation,
// watch-only) or `full` (the composer and task stops too); a project with no
// key is `off`, and its remote viewers get the heartbeat only (`basic`).
// Anything else fails the file like every other field, so the portal fails
// closed. `mirror` is in the normalised config only when it names something,
// so configFingerprint is unchanged for every file without it. It lives here,
// in the user tier, because it widens what leaves the machine: a project's own
// files must never be able to grant it (the consent rule, lib/core/paths), and
// only the CLI on the host writes it (withMirrorLevel). An older portal
// ignores the key and has no rows for the mirror's routes, so it refuses them
// all: a rollback fails safe.
//
// Fails CLOSED: a config the portal cannot fully understand is an error, never
// a partial run. An empty email allowlist in particular is refused here rather
// than read as "nobody" — a portal that starts and admits no one is a support
// question; one that starts with a typo'd allow list is worse.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isLocalHost } = require('../core/cors');
const { userPaths, projectPaths, isInside } = require('../core/paths');
const { readJson } = require('../core/fsjson');

const ID_RE = /^[0-9a-f]{8}$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TEAM_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const STYLES = ['flat', 'nested'];
const KINDS = ['token', 'local'];
// The sign-in Access was set up with by the one-token path (lib/tunnel/cf-setup).
const SIGNINS = ['pin+biometric', 'pin', 'google'];
// cloudflared's metrics server, where `/ready` answers 200 once the connector
// holds a live connection to Cloudflare. Loopback, beside the hub (5170) and
// the portal (5171), below the project daemons (5173+).
const DEFAULT_METRICS_PORT = 5172;
// The portal's fixed loopback port — fixed because the tunnel's ingress has to
// name it. Here rather than in lib/portal because `tunnel up|down|status` and
// `doctor` must find the portal on the same port it bound.
const DEFAULT_PORTAL_PORT = 5171;
function portalPort(env = process.env) {
  const n = parseInt(env.WEB_CHAT_PORTAL_PORT || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORTAL_PORT;
}
const TUNNEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function fail(msg) {
  const e = new Error(`tunnel config: ${msg}`);
  e.userFacing = true;
  throw e;
}

function normEmail(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

// The raw object → a normalised config, or a thrown userFacing Error naming the
// first thing wrong. Pure.
function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('not a JSON object');

  const hostname = typeof raw.hostname === 'string' ? raw.hostname.trim().toLowerCase().replace(/\.$/, '') : '';
  const labels = hostname.split('.');
  if (!hostname || !labels.every((l) => LABEL_RE.test(l))) fail(`hostname "${raw.hostname || ''}" is not a valid DNS name`);

  const style = raw.style == null ? 'flat' : String(raw.style);
  if (!STYLES.includes(style)) fail(`style must be one of ${STYLES.join('|')} (got "${style}")`);
  // flat derives its sessions as siblings of the picker, so the picker must
  // have a parent that is itself a registrable domain, not a bare TLD.
  if (style === 'flat' && labels.length < 3) fail(`a flat hostname needs a subdomain of your domain, e.g. wc.example.com (got "${hostname}")`);
  if (style === 'nested' && labels.length < 2) fail(`hostname "${hostname}" needs a domain`);

  const access = raw.access || {};
  const team = typeof access.team === 'string' ? access.team.trim().toLowerCase() : '';
  if (!TEAM_RE.test(team)) fail('access.team must be your Cloudflare Zero Trust team name (the <team> in <team>.cloudflareaccess.com)');
  const aud = typeof access.aud === 'string' ? access.aud.trim() : '';
  if (!aud) fail('access.aud must be the Access application\'s AUD tag');

  const allow = raw.allow || {};
  if (!Array.isArray(allow.emails)) fail('allow.emails must be a list of email addresses');
  const emails = [...new Set(allow.emails.map(normEmail))];
  if (emails.length === 0) fail('allow.emails is empty — name at least one email address that may reach this machine');
  for (const e of emails) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) fail(`allow.emails has "${e}", which is not an email address`);
  }
  const domains = [...new Set((Array.isArray(allow.domains) ? allow.domains : []).map(normEmail))];
  for (const d of domains) {
    if (!d || !d.split('.').every((l) => LABEL_RE.test(l)) || !d.includes('.')) fail(`allow.domains has "${d}", which is not a domain`);
  }

  const signin = raw.signin == null ? null : String(raw.signin);
  if (signin != null && !SIGNINS.includes(signin)) fail(`signin must be one of ${SIGNINS.join('|')} (got "${signin}")`);
  return {
    hostname,
    style,
    access: { team, aud },
    allow: { emails, domains },
    showRoots: raw.showRoots === true,
    remote: normalizeRemote(raw.remote),
    expose: normalizeExpose(raw.expose),
    tunnel: normalizeTunnel(raw.tunnel),
    signin,
  };
}

// `remote` → { allowDestructive[, mirror] }. A `remote` that is not an object
// reads as no settings, as it always has; `mirror` appears only when it names
// at least one project, so a file without one normalises (and fingerprints)
// exactly as before the mirror existed.
function normalizeRemote(r) {
  const remote = r || {};
  const out = { allowDestructive: remote.allowDestructive === true };
  const mirror = normalizeMirror(remote.mirror);
  if (mirror) out.mirror = mirror;
  return out;
}

// The levels a project can be opted into. `off` is no key at all.
const MIRROR_VALUES = ['read', 'full'];

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// One `remote.mirror` key → the form it is matched in (an instance id
// lowercased; an absolute root resolved, so `/a/b/` and `/a//b` name `/a/b`),
// or null for anything that names no project. Never trimmed: a directory name
// may end in a space, and a grant must name exactly the project it says.
function mirrorKey(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  if (ID_RE.test(raw.toLowerCase())) return raw.toLowerCase();
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return null;
}

// `remote.mirror` → { <key>: 'read' | 'full' } with every key in matching
// form, or null when absent or empty. Fails closed: a key that names no
// project, a value other than read/full, or one project named twice with two
// levels is an error, never a guess.
function normalizeMirror(m) {
  if (m == null) return null;
  if (typeof m !== 'object' || Array.isArray(m)) {
    fail('remote.mirror must be an object naming projects (an absolute root or an 8-hex instance id), each "read" or "full"');
  }
  const out = {};
  for (const [rawKey, value] of Object.entries(m)) {
    const key = mirrorKey(rawKey);
    if (!key) fail(`remote.mirror has "${rawKey}", which is neither an instance id (8 hex) nor an absolute project path`);
    if (!MIRROR_VALUES.includes(value)) fail(`remote.mirror["${rawKey}"] must be "read" or "full" (got ${JSON.stringify(value)})`);
    if (hasOwn(out, key) && out[key] !== value) fail(`remote.mirror names ${key} twice, as "${out[key]}" and "${value}"`);
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

// A project's chat-mirror opt-in under a normalised config: 'off' | 'read' |
// 'full'. `session` is the project as the caller knows it — a registry entry
// ({ id, root }: the portal's), or { root, id } for the daemon's own — and a
// key matches it only exactly: its resolved root or its instance id, never a
// directory above it. If both forms are present with different levels, the
// narrower wins: two grants for one project are a conflict, and a conflict
// widens nothing. `classify` (lib/core/remote-policy) and the daemon's
// audience gate read the answer.
function mirrorLevelFor(config, session) {
  const m = config && config.remote && config.remote.mirror;
  if (!m || typeof m !== 'object' || !session) return 'off';
  const found = [];
  if (typeof session.root === 'string' && path.isAbsolute(session.root)) {
    const k = path.resolve(session.root);
    if (hasOwn(m, k)) found.push(m[k]);
  }
  if (typeof session.id === 'string' && ID_RE.test(session.id.toLowerCase())) {
    const k = session.id.toLowerCase();
    if (hasOwn(m, k)) found.push(m[k]);
  }
  if (found.includes('read')) return 'read';
  if (found.includes('full')) return 'full';
  return 'off';
}

// tunnel.json's object with ONE project's mirror level set, for `claude-web-chat
// tunnel mirror on|off`. Pure: `raw` is the file as read, never normalised —
// every unrelated key, unknown ones included, is kept as written — and the
// result is a new object (`raw` is not touched). The project is named by its
// absolute `root`, the form the CLI writes; any other key naming it (the same
// root spelt differently, or its instance `id` when the caller gives one) is
// removed, so the project ends with exactly one key and an older grant under
// another spelling can neither outlive an `off` nor narrow an `on`. `level` is
// 'read' | 'full', or 'off' to remove the project's grant; `remote.mirror` is
// left out once it names nothing, and a `remote` the edit had to create is not
// left behind empty. Throws a userFacing error for a raw that is not an
// object, a root that is not absolute, an id that is not one, an unknown
// level, or a `remote`/`remote.mirror` that is there but not an object (the
// file needs fixing by hand: nothing the user wrote is overwritten). The
// caller validates the result with normalizeConfig before writing it.
function withMirrorLevel(raw, { root, id } = {}, level) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('not a JSON object');
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail(`a project is named by its absolute root (got ${JSON.stringify(root)})`);
  if (id != null && (typeof id !== 'string' || !ID_RE.test(id.toLowerCase()))) fail(`"${id}" is not an instance id (8 hex)`);
  if (level !== 'off' && !MIRROR_VALUES.includes(level)) fail(`the mirror level is read, full or off (got ${JSON.stringify(level)})`);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (raw.remote != null && !isObj(raw.remote)) fail('remote must be an object — fix tunnel.json by hand first');
  const prevRemote = raw.remote || {};
  if (prevRemote.mirror != null && !isObj(prevRemote.mirror)) fail('remote.mirror must be an object — fix tunnel.json by hand first');
  const prevMirror = prevRemote.mirror || {};

  const key = path.resolve(root);
  const idKey = id != null ? id.toLowerCase() : null;
  const mirror = {};
  let placed = false;
  for (const [k, v] of Object.entries(prevMirror)) {
    const nk = mirrorKey(k);
    const namesProject = nk !== null && (nk === key || nk === idKey);
    if (!namesProject) { mirror[k] = v; continue; }
    // The project's place in the list is kept: its first key is replaced.
    if (level !== 'off' && !placed) { mirror[key] = level; placed = true; }
  }
  if (level !== 'off' && !placed) mirror[key] = level;

  const remote = { ...prevRemote };
  if (Object.keys(mirror).length) remote.mirror = mirror;
  else delete remote.mirror;
  const out = { ...raw };
  if (raw.remote != null || Object.keys(remote).length) out.remote = remote;
  return out;
}

// `expose.exclude`: projects the portal must never serve, each named by its
// instance id (eight hex — what `tunnel status` lists) or an ABSOLUTE directory,
// which hides that project and every project under it. A relative path is
// refused rather than resolved against whatever cwd the portal happened to
// start in.
function normalizeExpose(e) {
  if (e == null) return { exclude: [] };
  if (typeof e !== 'object' || Array.isArray(e)) fail('expose must be an object');
  if (e.exclude == null) return { exclude: [] };
  if (!Array.isArray(e.exclude)) fail('expose.exclude must be a list of instance ids or absolute project paths');
  const exclude = [];
  for (const raw of e.exclude) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (ID_RE.test(s.toLowerCase())) exclude.push({ id: s.toLowerCase() });
    else if (s && path.isAbsolute(s)) exclude.push({ path: path.resolve(s) });
    else fail(`expose.exclude has "${raw}", which is neither an instance id (8 hex) nor an absolute path`);
  }
  return { exclude };
}

// Why a registry entry must NOT be reachable through the portal, or null when
// it may be: 'excluded' (tunnel.json expose.exclude) or 'no-remote' (the
// project's own .web-chat/no-remote marker). A hidden project is left off the
// picker AND refused on its hostname — the same answer as a project that is not
// running, so the listing does not leak which projects exist. Reads the disk
// (the marker), so callers memoise it with the registry read.
function hiddenReason(config, entry) {
  if (!entry) return 'excluded';
  const exclude = (config.expose && config.expose.exclude) || [];
  for (const x of exclude) {
    if (x.id && x.id === entry.id) return 'excluded';
    if (x.path && entry.root && isInside(x.path, entry.root)) return 'excluded';
  }
  if (entry.root && fs.existsSync(projectPaths(entry.root).noRemote)) return 'no-remote';
  return null;
}

// The `tunnel` section → { kind, name, credentialsFile, metricsPort } or null.
function normalizeTunnel(t) {
  if (t == null) return null;
  if (typeof t !== 'object' || Array.isArray(t)) fail('tunnel must be an object');
  const kind = t.kind == null ? '' : String(t.kind).trim().toLowerCase();
  if (kind === 'quick' || kind === 'trycloudflare' || /trycloudflare\.com/i.test(String(t.url || t.hostname || ''))) {
    fail('a quick tunnel (trycloudflare.com) cannot sit behind Cloudflare Access, so nothing would check who is signing in — create a NAMED tunnel (see `claude-web-chat docs remote-access`)');
  }
  if (!KINDS.includes(kind)) fail(`tunnel.kind must be one of ${KINDS.join('|')} (got "${kind}")`);
  const name = t.name == null ? null : String(t.name).trim();
  if (name != null && name !== '' && !TUNNEL_NAME_RE.test(name)) fail(`tunnel.name "${name}" is not a tunnel name or id`);
  if (kind === 'local' && !name) fail('tunnel.name is required for a local tunnel — the name you gave `cloudflared tunnel create`');
  const credentialsFile = typeof t.credentialsFile === 'string' && t.credentialsFile.trim() ? t.credentialsFile.trim() : null;
  let metricsPort = DEFAULT_METRICS_PORT;
  if (t.metricsPort != null) {
    metricsPort = Number(t.metricsPort);
    if (!Number.isInteger(metricsPort) || metricsPort < 1 || metricsPort > 65535) fail(`tunnel.metricsPort must be a port number (got "${t.metricsPort}")`);
  }
  return { kind, name: name || null, credentialsFile, metricsPort };
}

// tunnel.json → the normalised config, or a thrown userFacing Error: absent
// (with the command that writes it), unreadable, or invalid.
function loadConfig(file = userPaths().tunnelConfig) {
  const r = readJson(file);
  if (r.absent) fail(`none at ${file} — run \`claude-web-chat tunnel setup\` first`);
  if (!r.ok) fail(`${file} is unreadable: ${r.error && r.error.message}`);
  return normalizeConfig(r.value);
}

// A short, stable name for WHAT a normalised config enforces. The portal
// reports the one in force on /api/health (it reloads tunnel.json live, but
// keeps the hostname, style and tunnel it started with); `tunnel up` and
// `tunnel status` compare it with the file as it is now, so an edit is never
// shown as applied while the running portal still enforces something else —
// `up` restarts it, `status` says so.
// Taken over the NORMALISED config, so reformatting the file changes nothing.
function configFingerprint(config) {
  return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
}

// The Host header's name part, lowercased, port and trailing dot dropped. Null
// for anything absent or unparseable.
function hostOnly(hostValue) {
  if (typeof hostValue !== 'string') return null;
  let h = hostValue.trim().toLowerCase();
  if (!h || h.startsWith('[')) return null; // an IPv6 literal is never one of ours
  const colon = h.indexOf(':');
  if (colon !== -1) h = h.slice(0, colon);
  h = h.replace(/\.$/, '');
  return h || null;
}

// The hostname a session is served from.
function sessionHost(config, id) {
  if (config.style === 'nested') return `${id}.${config.hostname}`;
  const [first, ...rest] = config.hostname.split('.');
  return `${first}-${id}.${rest.join('.')}`;
}

// The names a config needs routed, one engine for the dashboard steps and the
// one-token setup (lib/tunnel/cf-setup):
//   picker          the picker's hostname
//   sessionsDns     the wildcard DNS record + tunnel ingress rule covering every
//                   session (flat: *.example.com — DNS wildcards are whole
//                   labels, so a flat session cannot get a narrower one)
//   sessionsAccess  the Access destination covering exactly the sessions
//                   (flat: wc-*.example.com)
function routeNames(config) {
  const [first, ...rest] = config.hostname.split('.');
  const parent = rest.join('.');
  if (config.style === 'nested') {
    return { picker: config.hostname, sessionsDns: `*.${config.hostname}`, sessionsAccess: `*.${config.hostname}` };
  }
  return { picker: config.hostname, sessionsDns: `*.${parent}`, sessionsAccess: `${first}-*.${parent}` };
}

// The browser-visible origin of a hostname. Cloudflare terminates TLS, so the
// page a remote viewer is on is always https on the default port.
function publicOrigin(host) {
  return `https://${host}`;
}

// What the Host a request arrived with names:
//   { kind: 'apex' }                the picker
//   { kind: 'session', id, host }   one project's surface
//   { kind: 'local' }               loopback — the portal's own health probe
//   null                            anything else (421)
function parseHost(config, hostValue) {
  if (isLocalHost(hostValue, '127.0.0.1')) return { kind: 'local' };
  const h = hostOnly(hostValue);
  if (!h) return null;
  if (h === config.hostname) return { kind: 'apex', host: h };
  let id = null;
  if (config.style === 'nested') {
    const suffix = `.${config.hostname}`;
    if (h.endsWith(suffix)) id = h.slice(0, -suffix.length);
  } else {
    const [first, ...rest] = config.hostname.split('.');
    const suffix = `.${rest.join('.')}`;
    const prefix = `${first}-`;
    if (h.endsWith(suffix)) {
      const label = h.slice(0, -suffix.length);
      if (label.startsWith(prefix)) id = label.slice(prefix.length);
    }
  }
  if (id == null || !ID_RE.test(id)) return null;
  return { kind: 'session', id, host: h };
}

module.exports = {
  normalizeConfig, loadConfig, configFingerprint, parseHost, sessionHost, publicOrigin, hostOnly, hiddenReason, ID_RE,
  DEFAULT_METRICS_PORT, DEFAULT_PORTAL_PORT, portalPort, KINDS, STYLES, SIGNINS, routeNames,
  MIRROR_VALUES, mirrorLevelFor, withMirrorLevel,
};
