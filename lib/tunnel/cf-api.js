// A small Cloudflare API v4 client — just the calls `tunnel setup --api-token`
// needs (lib/tunnel/cf-setup.js), over the one outbound home
// (lib/util/outbound: https only, bounded in time and size).
//
// What it adds over a bare request:
//   * the envelope. Cloudflare answers { success, errors, messages, result,
//     result_info }; call() returns `result` or throws a CfApiError carrying the
//     status, Cloudflare's error codes and messages.
//   * the permission a refusal means. Every call names the token permission it
//     needs (PERMS); a 403 — or Cloudflare's "Authentication error" 10000 /
//     "Unauthorized to access requested resource" 9109 — becomes an error that
//     says which permission the token is missing, not "HTTP 403".
//   * rate limits. A 429 waits (Retry-After, capped) and retries a few times
//     before giving up with a plain "rate limited".
//   * pagination, for the list calls (page/per_page, result_info.total_pages).
//
// The base URL is https://api.cloudflare.com/client/v4, or WEB_CHAT_CF_API —
// how a test points it at the in-process fake (test-support/fake-cloudflare).
// outbound refuses plain http to anything but loopback, so the override cannot
// send the token in cleartext across a network.
//
// The API token is held in this closure for the length of a setup and never
// written anywhere (setup stores the tunnel's CONNECTOR token, as it always has).

const outbound = require('../util/outbound');

const API_BASE = 'https://api.cloudflare.com/client/v4';
const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 30000;
const PER_PAGE = 50;
const MAX_PAGES = 40;

// The token permissions setup needs, in the words of the dashboard's "Create
// Custom Token" form — what an error tells the user to tick.
const PERMS = {
  tunnel: 'Account › Cloudflare Tunnel › Edit',
  apps: 'Account › Access: Apps and Policies › Edit',
  org: 'Account › Access: Organizations, Identity Providers, and Groups › Edit',
  dns: 'Zone › DNS › Edit',
};
const PERMISSION_CODES = new Set([10000, 9109]);

class CfApiError extends Error {
  constructor({ method, path, status, errors = [], permission = null, rateLimited = false }) {
    const detail = errors.length ? errors.map((e) => `${e.message || 'error'}${e.code ? ` (${e.code})` : ''}`).join('; ') : `HTTP ${status}`;
    let msg = `Cloudflare API ${method} ${path}: ${detail}`;
    if (permission) msg = `the API token is missing a permission: ${permission} (Cloudflare refused ${method} ${path}: ${detail})`;
    if (rateLimited) msg = `Cloudflare API ${method} ${path}: rate limited (HTTP 429) — wait a minute and run setup again`;
    super(msg);
    this.name = 'CfApiError';
    this.status = status;
    this.errors = errors;
    this.codes = errors.map((e) => e.code).filter((c) => c != null);
    this.permission = permission;
    this.rateLimited = rateLimited;
    this.userFacing = true;
  }
}

function apiBase(env = process.env) {
  const b = env.WEB_CHAT_CF_API;
  return (b && String(b).trim() ? String(b).trim() : API_BASE).replace(/\/+$/, '');
}

function qs(query) {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v != null) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

function retryAfterMs(headers, attempt) {
  const s = Number.parseFloat(headers && headers['retry-after']);
  const ms = Number.isFinite(s) && s >= 0 ? s * 1000 : 1000 * 2 ** attempt;
  return Math.min(ms, MAX_RETRY_WAIT_MS);
}

function createCfApi({
  token, env = process.env, base = apiBase(env), request = outbound.request,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 15000,
} = {}) {
  if (!token || typeof token !== 'string') throw new Error('cf-api: an API token is required');
  const auth = `Bearer ${token.trim()}`;

  // One call → the envelope's `result` (and `result_info` on the side), or a
  // thrown CfApiError. `perm` names the permission a refusal means.
  async function raw(method, path, { body, query, perm = null } = {}) {
    for (let attempt = 0; ; attempt++) {
      const r = await request(`${base}${path}${qs(query)}`, {
        method, body, timeoutMs, headers: { authorization: auth },
      });
      const env0 = r.json && typeof r.json === 'object' ? r.json : {};
      const errors = Array.isArray(env0.errors) ? env0.errors : [];
      if (r.status === 429) {
        if (attempt < MAX_RETRIES) { await sleep(retryAfterMs(r.headers, attempt)); continue; }
        throw new CfApiError({ method, path, status: 429, errors, rateLimited: true });
      }
      if (r.status >= 200 && r.status < 300 && env0.success !== false) return { result: env0.result, info: env0.result_info || null };
      const refused = r.status === 403 || errors.some((e) => PERMISSION_CODES.has(e.code));
      throw new CfApiError({ method, path, status: r.status, errors, permission: refused && perm ? perm : null });
    }
  }
  const call = async (method, path, opts) => (await raw(method, path, opts)).result;

  // Every page of a list call.
  async function list(path, { query = {}, perm } = {}) {
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { result, info } = await raw('GET', path, { query: { ...query, page, per_page: PER_PAGE }, perm });
      if (Array.isArray(result)) out.push(...result);
      const total = info && Number(info.total_pages);
      if (!Array.isArray(result) || !result.length || !Number.isFinite(total) || page >= total) break;
    }
    return out;
  }

  const acct = (a) => `/accounts/${encodeURIComponent(a)}`;

  return {
    base,
    call,
    list,

    // ── the token ──
    // A user-owned token verifies at /user/tokens/verify; an ACCOUNT-owned one
    // only at /accounts/<id>/tokens/verify. Try the first, then the second
    // against each account the token can see. { ok, status, owner } or throws.
    async verifyToken() {
      try {
        const r = await call('GET', '/user/tokens/verify');
        return { ok: r && r.status === 'active', status: r && r.status, owner: 'user' };
      } catch (e) {
        if (!(e instanceof CfApiError) || e.rateLimited) throw e;
        let accounts;
        try { accounts = await list('/accounts'); } catch { throw e; }
        for (const a of accounts) {
          try {
            const r = await call('GET', `${acct(a.id)}/tokens/verify`);
            return { ok: r && r.status === 'active', status: r && r.status, owner: 'account', account: a.id };
          } catch {}
        }
        throw e;
      }
    },

    listAccounts: () => list('/accounts'),

    // ── zones + DNS ──
    // The zone a hostname lives in: the longest suffix that is a zone on the
    // account. null when none is.
    async findZone(accountId, hostname) {
      const labels = String(hostname).split('.');
      for (let i = 0; i <= labels.length - 2; i++) {
        const name = labels.slice(i).join('.');
        const zones = await list('/zones', { query: { name, 'account.id': accountId }, perm: PERMS.dns });
        const z = zones.find((x) => x && x.name === name);
        if (z) return z;
      }
      return null;
    },
    dnsRecords: (zoneId, name) => list(`/zones/${encodeURIComponent(zoneId)}/dns_records`, { query: { name }, perm: PERMS.dns }),
    createDnsRecord: (zoneId, rec) => call('POST', `/zones/${encodeURIComponent(zoneId)}/dns_records`, { body: rec, perm: PERMS.dns }),
    patchDnsRecord: (zoneId, id, patch) => call('PATCH', `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`, { body: patch, perm: PERMS.dns }),

    // ── the tunnel (remotely managed: config_src cloudflare) ──
    async findTunnel(accountId, name) {
      const ts = await list(`${acct(accountId)}/cfd_tunnel`, { query: { name, is_deleted: 'false' }, perm: PERMS.tunnel });
      return ts.find((t) => t && t.name === name && !t.deleted_at) || null;
    },
    createTunnel: (accountId, name) => call('POST', `${acct(accountId)}/cfd_tunnel`, { body: { name, config_src: 'cloudflare' }, perm: PERMS.tunnel }),
    tunnelToken: (accountId, id) => call('GET', `${acct(accountId)}/cfd_tunnel/${encodeURIComponent(id)}/token`, { perm: PERMS.tunnel }),
    tunnelConfig: (accountId, id) => call('GET', `${acct(accountId)}/cfd_tunnel/${encodeURIComponent(id)}/configurations`, { perm: PERMS.tunnel }),
    putTunnelConfig: (accountId, id, config) => call('PUT', `${acct(accountId)}/cfd_tunnel/${encodeURIComponent(id)}/configurations`, { body: { config }, perm: PERMS.tunnel }),

    // ── Access ──
    organization: (accountId) => call('GET', `${acct(accountId)}/access/organizations`, { perm: PERMS.org }),
    putOrganization: (accountId, body) => call('PUT', `${acct(accountId)}/access/organizations`, { body, perm: PERMS.org }),
    identityProviders: (accountId) => list(`${acct(accountId)}/access/identity_providers`, { perm: PERMS.org }),
    createIdentityProvider: (accountId, body) => call('POST', `${acct(accountId)}/access/identity_providers`, { body, perm: PERMS.org }),
    accessApps: (accountId) => list(`${acct(accountId)}/access/apps`, { perm: PERMS.apps }),
    createAccessApp: (accountId, body) => call('POST', `${acct(accountId)}/access/apps`, { body, perm: PERMS.apps }),
    putAccessApp: (accountId, id, body) => call('PUT', `${acct(accountId)}/access/apps/${encodeURIComponent(id)}`, { body, perm: PERMS.apps }),
    accessPolicies: (accountId) => list(`${acct(accountId)}/access/policies`, { perm: PERMS.apps }),
    createAccessPolicy: (accountId, body) => call('POST', `${acct(accountId)}/access/policies`, { body, perm: PERMS.apps }),
    putAccessPolicy: (accountId, id, body) => call('PUT', `${acct(accountId)}/access/policies/${encodeURIComponent(id)}`, { body, perm: PERMS.apps }),
  };
}

module.exports = { createCfApi, CfApiError, PERMS, API_BASE, apiBase };
