// The portal's configuration — ~/.web-chat/tunnel/tunnel.json — read, checked
// and turned into the one thing every request needs: "which hostname is this,
// and what does it name?"
//
// The file (written by `claude-web-chat tunnel setup`):
//
//   {
//     "hostname": "wc.example.com",        the picker; sessions hang off it
//     "style":    "flat" | "nested",       default flat
//     "access":   { "team": "<team>", "aud": "<Access application AUD tag>" },
//     "allow":    { "emails": ["me@example.com"], "domains": [] },
//     "showRoots": false,                  picker shows full project paths
//     "remote":   { "allowDestructive": false }
//   }
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

const { isLocalHost } = require('../core/cors');

const ID_RE = /^[0-9a-f]{8}$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TEAM_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const STYLES = ['flat', 'nested'];

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
  if (emails.length === 0) fail('allow.emails is empty — name at least one Google account that may reach this machine');
  for (const e of emails) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) fail(`allow.emails has "${e}", which is not an email address`);
  }
  const domains = [...new Set((Array.isArray(allow.domains) ? allow.domains : []).map(normEmail))];
  for (const d of domains) {
    if (!d || !d.split('.').every((l) => LABEL_RE.test(l)) || !d.includes('.')) fail(`allow.domains has "${d}", which is not a domain`);
  }

  const remote = raw.remote || {};
  return {
    hostname,
    style,
    access: { team, aud },
    allow: { emails, domains },
    showRoots: raw.showRoots === true,
    remote: { allowDestructive: remote.allowDestructive === true },
  };
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

module.exports = { normalizeConfig, parseHost, sessionHost, publicOrigin, hostOnly, ID_RE };
