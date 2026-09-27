// An in-process stand-in for the slice of Cloudflare's API v4 that
// `tunnel setup --api-token` uses (lib/tunnel/cf-api.js + cf-setup.js).
//
// A real HTTP server on 127.0.0.1:0 — the client's own outbound request runs
// against it — reached through the client's injectable base URL
// (`createCfApi({ base })`, or WEB_CHAT_CF_API for a whole CLI run). Nothing
// here, and no test using it, touches the real API.
//
// It holds just enough state to be converged against: accounts, zones, DNS
// records, tunnels + their ingress, the Zero Trust organization, login methods,
// Access apps and reusable policies. Every request is recorded (`calls`, and
// `writes()` for the non-GETs) so a test can prove a re-run changed nothing and
// a dry run wrote nothing.
//
// Simulations (set on `fake.sim` at any time):
//   missing: ['org', …]   token permissions the token lacks (PERMS keys in
//                         cf-api: account, tunnel, apps, org, dns) → 403 code
//                         10000 — except 'account' (Account Settings › Read)
//                         on GET /accounts, which answers an EMPTY list, as
//                         the real API did in the maintainer's live run
//   mfaRefused: true      org and app writes carrying mfa_config → 400 (a
//                         plan without independent MFA): the org as the live
//                         API answered, 12062 invalid_org_config; the app 12130.
//                         'org' or 'app' refuses only that one
//
// PUT /access/organizations is checked the way the live API refused the
// maintainer's first run (400, 12062 "access.api.error.invalid_org_config"):
// the body must be the WHOLE organization (auth_domain and name present, and
// no setting GET returned dropped), carry only the fields the Update endpoint
// takes (no created_at / updated_at), and no "" for a duration (GET answers ""
// for an unset one). Which of these the real API trips on is not known; each
// is a way our body could differ from the documented one, so each is refused.
//   rateLimit: n          the next n requests answer 429 (Retry-After: 0)
//   zeroTrust: false      the account has no Zero Trust organization (404)
//   badToken: true        every request is 401 "Invalid API Token" (1000)
//   accountOwned: true    an ACCOUNT-owned token: /user/tokens/verify refuses
//                         it (401, 1000); /accounts/<id>/tokens/verify takes it
//   fail: [{ method, path, status, times }]
//                         a matching request (path: a RegExp on the path
//                         without /client/v4) answers `status` (500 default),
//                         `times` times (1 default) — a run that dies half way
//
// A missing zone is not a simulation: pass `zones` without the hostname's zone
// (`zones: []`). Each zone carries its `account` ({ id, name }) as the real
// API's do — the first account's, unless the zone says otherwise.

const http = require('http');
const crypto = require('crypto');

const hex = (n) => crypto.randomBytes(n).toString('hex');
const uuid = () => crypto.randomUUID();

function createFakeCloudflare({
  token = 'cf-api-token-TEST',
  accounts = [{ id: 'acc0000000000000000000000000001', name: 'Test Account' }],
  zones = [{ id: 'zone000000000000000000000000001', name: 'example.test' }],
  team = 'testteam',
} = {}) {
  zones = zones.map((z) => ({ ...z, account: z.account || { id: accounts[0].id, name: accounts[0].name } }));
  const sim = { missing: [], accountOwned: false, mfaRefused: false, rateLimit: 0, zeroTrust: true, badToken: false, fail: [] };
  const refuses = (what) => sim.mfaRefused === true || sim.mfaRefused === what;
  const db = {
    dns: [],
    tunnels: [],
    configs: new Map(),
    // As GET answers it: read-only timestamps, unset settings as "", and a
    // setting of the user's own (login_design) a whole-object PUT must keep.
    org: {
      auth_domain: `${team}.cloudflareaccess.com`, name: team, is_ui_read_only: false, ui_read_only_toggle_reason: '',
      auto_redirect_to_identity: false, allow_authenticate_via_warp: false, session_duration: '24h',
      user_seat_expiration_inactive_time: '', warp_auth_session_duration: '',
      login_design: { background_color: '#112233', header_text: 'Team login', logo_path: '' },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    },
    orgRefusals: [],   // why each refused org PUT was invalid (badOrg), for a test to read
    idps: [],
    apps: [],
    policies: [],
  };
  const calls = [];

  const ok = (res, result, extra = {}) => send(res, 200, { success: true, errors: [], messages: [], result, ...extra });
  const list = (res, arr) => ok(res, arr, { result_info: { page: 1, per_page: arr.length, count: arr.length, total_count: arr.length, total_pages: 1 } });
  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }
  const err = (res, status, code, message) => send(res, status, { success: false, errors: [{ code, message }], messages: [], result: null });

  // The Update endpoint's body fields (Cloudflare's "Zero Trust Organization ›
  // Update" reference) — kept here on its own, not read from lib/, so a change
  // to what setup sends is checked against the API, not against itself.
  const ORG_FIELDS = new Set([
    'allow_authenticate_via_warp', 'auth_domain', 'auto_redirect_to_identity', 'custom_pages',
    'deny_unmatched_requests', 'deny_unmatched_requests_exempted_zone_names', 'is_ui_read_only',
    'login_design', 'mfa_config', 'mfa_piv_key_requirements', 'mfa_required_for_all_apps', 'name',
    'service_token_inactivity', 'session_duration', 'ui_read_only_toggle_reason',
    'user_seat_expiration_inactive_time', 'warp_auth_non_browser_401', 'warp_auth_session_duration',
  ]);
  const ORG_DURATIONS = ['session_duration', 'user_seat_expiration_inactive_time', 'warp_auth_session_duration'];
  // Why an org PUT body is invalid, or null.
  function badOrg(body) {
    if (!body || typeof body !== 'object') return 'no body';
    const extra = Object.keys(body).filter((k) => !ORG_FIELDS.has(k));
    if (extra.length) return `read-only or unknown: ${extra.join(', ')}`;
    if (!body.auth_domain || !body.name) return 'partial: auth_domain and name are required';
    const lost = Object.keys(db.org).filter((k) => ORG_FIELDS.has(k) && !(k in body) && db.org[k] !== '' && db.org[k] != null
      && !(typeof db.org[k] === 'object' && !Object.values(db.org[k]).some((v) => v !== '' && v != null)));
    if (lost.length) return `partial: drops ${lost.join(', ')}`;
    const empty = ORG_DURATIONS.filter((k) => body[k] === '');
    if (body.mfa_config && body.mfa_config.session_duration === '') empty.push('mfa_config.session_duration');
    if (empty.length) return `empty duration: ${empty.join(', ')}`;
    return null;
  }
  const invalidOrg = (res) => err(res, 400, 12062, 'access.api.error.invalid_org_config');

  function permFor(p) {
    if (/^\/accounts\/[^/]+\/?$/.test(p)) return 'account';
    if (/^\/zones/.test(p)) return 'dns';
    if (/\/cfd_tunnel/.test(p)) return 'tunnel';
    if (/\/access\/(organizations|identity_providers)/.test(p)) return 'org';
    if (/\/access\/(apps|policies)/.test(p)) return 'apps';
    return null;
  }

  function route(method, p, q, body, res) {
    let m;
    if (p === '/user/tokens/verify') return sim.accountOwned ? err(res, 401, 1000, 'Invalid API Token') : ok(res, { id: 'tok1', status: 'active' });
    if (p === '/accounts') return list(res, sim.missing.includes('account') ? [] : accounts);
    if ((m = p.match(/^\/accounts\/([^/]+)\/tokens\/verify$/))) return ok(res, { id: 'tok1', status: 'active' });

    if (p === '/zones') {
      return list(res, zones.filter((z) => (!q.get('name') || z.name === q.get('name'))
        && (!q.get('account.id') || z.account.id === q.get('account.id'))));
    }
    if ((m = p.match(/^\/zones\/([^/]+)\/dns_records$/))) {
      const zid = m[1];
      if (method === 'GET') return list(res, db.dns.filter((r) => r.zone_id === zid && (!q.get('name') || r.name === q.get('name'))));
      if (method === 'POST') {
        if (db.dns.some((r) => r.zone_id === zid && r.name === body.name)) return err(res, 400, 81053, 'An A, AAAA, or CNAME record with that host already exists.');
        const rec = { id: hex(16), zone_id: zid, ...body };
        db.dns.push(rec);
        return ok(res, rec);
      }
    }
    if ((m = p.match(/^\/zones\/([^/]+)\/dns_records\/([^/]+)$/)) && method === 'PATCH') {
      const rec = db.dns.find((r) => r.id === m[2]);
      if (!rec) return err(res, 404, 81044, 'Record does not exist.');
      Object.assign(rec, body);
      return ok(res, rec);
    }

    if (!(m = p.match(/^\/accounts\/([^/]+)(\/.*)?$/))) return err(res, 404, 7003, 'Could not route');
    const [, acc, rest = ''] = m;
    if (!accounts.some((a) => a.id === acc)) return err(res, 403, 9109, 'Unauthorized to access requested resource');
    if (rest === '/' || rest === '') return ok(res, accounts.find((a) => a.id === acc));

    if (rest === '/cfd_tunnel') {
      if (method === 'GET') return list(res, db.tunnels.filter((t) => (!q.get('name') || t.name === q.get('name')) && !(q.get('is_deleted') === 'false' && t.deleted_at)));
      if (method === 'POST') {
        const t = { id: uuid(), name: body.name, account_tag: acc, created_at: new Date().toISOString(), deleted_at: null, remote_config: body.config_src === 'cloudflare', status: 'inactive', connections: [] };
        db.tunnels.push(t);
        return ok(res, { ...t, token: `eyJ-connector-${t.id}` });
      }
    }
    if ((m = rest.match(/^\/cfd_tunnel\/([^/]+)\/token$/))) {
      const t = db.tunnels.find((x) => x.id === m[1]);
      return t ? ok(res, `eyJ-connector-${t.id}`) : err(res, 404, 1003, 'tunnel not found');
    }
    if ((m = rest.match(/^\/cfd_tunnel\/([^/]+)\/configurations$/))) {
      const t = db.tunnels.find((x) => x.id === m[1]);
      if (!t) return err(res, 404, 1003, 'tunnel not found');
      if (method === 'GET') return ok(res, { tunnel_id: t.id, version: 0, config: db.configs.get(t.id) || null, source: 'cloudflare' });
      if (method === 'PUT') {
        db.configs.set(t.id, body.config);
        return ok(res, { tunnel_id: t.id, config: body.config });
      }
    }

    if (rest === '/access/organizations') {
      if (!sim.zeroTrust) return err(res, 404, 12106, 'organization not found');
      if (method === 'GET') return ok(res, db.org);
      if (method === 'PUT') {
        const bad = badOrg(body);
        if (bad) { db.orgRefusals.push(bad); return invalidOrg(res); }
        if (refuses('org') && body.mfa_config) return invalidOrg(res);
        db.org = { ...body, created_at: db.org.created_at, updated_at: new Date().toISOString() };
        return ok(res, db.org);
      }
    }
    if (rest === '/access/identity_providers') {
      if (method === 'GET') return list(res, db.idps);
      if (method === 'POST') {
        const idp = { id: uuid(), ...body };
        db.idps.push(idp);
        return ok(res, idp);
      }
    }
    if (rest === '/access/policies') {
      if (method === 'GET') return list(res, db.policies);
      if (method === 'POST') {
        const pol = { id: uuid(), reusable: true, ...body };
        db.policies.push(pol);
        return ok(res, pol);
      }
    }
    if ((m = rest.match(/^\/access\/policies\/([^/]+)$/)) && method === 'PUT') {
      const i = db.policies.findIndex((x) => x.id === m[1]);
      if (i === -1) return err(res, 404, 12130, 'policy not found');
      db.policies[i] = { id: m[1], reusable: true, ...body };
      return ok(res, db.policies[i]);
    }
    if (rest === '/access/apps') {
      if (method === 'GET') return list(res, db.apps);
      if (method === 'POST') {
        if (refuses('app') && body.mfa_config) return err(res, 400, 12130, 'independent MFA is not available for this account');
        const app = { ...body, id: uuid(), aud: hex(32), created_at: new Date().toISOString() };
        db.apps.push(app);
        return ok(res, app);
      }
    }
    if ((m = rest.match(/^\/access\/apps\/([^/]+)$/)) && method === 'PUT') {
      const i = db.apps.findIndex((x) => x.id === m[1]);
      if (i === -1) return err(res, 404, 12130, 'app not found');
      if (refuses('app') && body.mfa_config && body.mfa_config.mfa_disabled === false) return err(res, 400, 12130, 'independent MFA is not available for this account');
      for (const k of ['id', 'aud', 'created_at']) if (k in body) return err(res, 400, 12130, `${k} is read-only`);
      db.apps[i] = { ...body, id: db.apps[i].id, aud: db.apps[i].aud, created_at: db.apps[i].created_at };
      return ok(res, db.apps[i]);
    }
    return err(res, 404, 7003, `Could not route to ${p}`);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const p = u.pathname.replace(/^\/client\/v4/, '');
      let body = null;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch {}
      calls.push({ method: req.method, path: p, query: Object.fromEntries(u.searchParams), body, auth: req.headers.authorization || null });
      if (sim.rateLimit > 0) { sim.rateLimit--; return send(res, 429, { success: false, errors: [{ code: 971, message: 'Please wait and consider throttling your request speed' }] }, { 'retry-after': '0' }); }
      if (sim.badToken || req.headers.authorization !== `Bearer ${token}`) return err(res, 401, 1000, 'Invalid API Token');
      const f = sim.fail.find((x) => x.times !== 0 && (!x.method || x.method === req.method) && x.path.test(p));
      if (f) {
        f.times = (f.times == null ? 1 : f.times) - 1;
        return err(res, f.status || 500, 10001, 'simulated failure');
      }
      const perm = permFor(p);
      if (perm && sim.missing.includes(perm)) return err(res, 403, 10000, 'Authentication error');
      try { route(req.method, p, u.searchParams, body, res); } catch (e) { err(res, 500, 10001, e.message); }
    });
  });

  return {
    token,
    team,
    sim,
    db,
    calls,
    writes: () => calls.filter((c) => c.method !== 'GET'),
    base: null,
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      this.base = `http://127.0.0.1:${server.address().port}/client/v4`;
      return this.base;
    },
    close() {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

// Boot one for a test and close it after.
async function withFakeCloudflare(t, opts) {
  const fake = createFakeCloudflare(opts);
  await fake.start();
  t.after(() => fake.close());
  return fake;
}

module.exports = { createFakeCloudflare, withFakeCloudflare };
