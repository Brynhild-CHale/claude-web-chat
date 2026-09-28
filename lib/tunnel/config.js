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
//     "remote":   { "allowDestructive": false },  a remote viewer may wipe the graph
//                                           or start a new one
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

  const remote = raw.remote || {};
  const signin = raw.signin == null ? null : String(raw.signin);
  if (signin != null && !SIGNINS.includes(signin)) fail(`signin must be one of ${SIGNINS.join('|')} (got "${signin}")`);
  return {
    hostname,
    style,
    access: { team, aud },
    allow: { emails, domains },
    showRoots: raw.showRoots === true,
    remote: { allowDestructive: remote.allowDestructive === true },
    expose: normalizeExpose(raw.expose),
    tunnel: normalizeTunnel(raw.tunnel),
    signin,
  };
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
};
