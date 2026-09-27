// The one-token Cloudflare setup behind `tunnel setup --api-token`: from one
// API token to a named, remotely managed tunnel routed to the portal, its DNS,
// and an Access application in front of it — then read back the two values the
// portal needs (the team name and the application's AUD tag).
//
// Three phases, so a conflict stops the run BEFORE anything is changed, and
// `--dry-run` is the first two alone:
//
//   gather(api, want)          READS only: account, zone, Zero Trust org (the
//                              team name), login methods, the tunnel and its
//                              ingress, the DNS records at our names, the
//                              Access app and policy.
//   plan(state, want)          PURE: what to create / update / keep, and every
//                              conflict (a DNS record we would clobber, a tunnel
//                              that is locally managed, an Access app of
//                              another type on our hostname). A conflict is an
//                              explanation, not a write.
//   apply(api, state, want)    the writes, in dependency order, each one
//                              converging (create if absent, update if it
//                              differs, keep if equal) so a re-run duplicates
//                              nothing.
//
// Sign-in (want.signin):
//   'pin+biometric'  the default — Cloudflare's One-time PIN (an emailed code)
//                    plus Access INDEPENDENT MFA with biometrics (Face ID,
//                    Touch ID, Windows Hello) or a security key. Independent MFA
//                    must be on at the organization level first; setup turns it
//                    on there (only when it is off — an org that already has it
//                    keeps its own authenticators) WITHOUT requiring it for
//                    other apps, then sets custom MFA on this app alone. The
//                    org is GET, and PUT back whole with only the MFA settings
//                    changed (orgBody). If Cloudflare refuses the org, setup
//                    still asks for MFA on this application alone — the least
//                    invasive place for it; if that is refused too (a plan
//                    without it, a feature not enabled), it falls back to
//                    'pin': the PIN alone, with a long session, and says why.
//   'pin'            the emailed PIN alone, as asked.
//   'google'         Google as the login method (option A). A passkey is the
//                    Google account's own setting.
// What was actually configured comes back as result.signin + result.why.

const { routeNames, SIGNINS } = require('./config');
const { CfApiError, PERMS } = require('./cf-api');

const DEFAULT_TUNNEL_NAME = 'web-chat';
const DEFAULT_SESSION = '720h';       // 30 days — the Access maximum is a month
const DEFAULT_MFA_SESSION = '720h';   // Access caps an MFA session at 720h
const MFA_AUTHENTICATORS = ['biometrics', 'security_key'];
const DURATION_RE = /^\d+(?:m|h)$/;

function fail(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  throw e;
}

const tunnelTarget = (id) => `${id}.cfargotunnel.com`;
const appName = (picker) => `web-chat (${picker})`;
const policyName = (picker) => `web-chat allow (${picker})`;
const lower = (s) => String(s || '').toLowerCase().replace(/\.$/, '');
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

// Everything setup wants, with defaults applied. `service` is where the tunnel
// sends traffic — the portal's fixed loopback port.
function normalizeWant(w) {
  const want = {
    hostname: lower(w.hostname),
    style: w.style || 'flat',
    emails: [...new Set((w.emails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))],
    tunnelName: w.tunnelName || DEFAULT_TUNNEL_NAME,
    signin: w.signin || 'pin+biometric',
    session: w.session || DEFAULT_SESSION,
    mfaSession: w.mfaSession || DEFAULT_MFA_SESSION,
    service: w.service,
    account: w.account || null,
    google: w.google || null,
  };
  if (!want.emails.length) fail('at least one allowed email is required (--email you@example.com)');
  if (!SIGNINS.includes(want.signin)) fail(`--signin must be one of ${SIGNINS.join('|')} (got "${w.signin}")`);
  for (const [k, v] of [['session', want.session], ['mfa-session', want.mfaSession]]) {
    if (!DURATION_RE.test(v)) fail(`--${k} must be a duration in minutes or hours, like 720h (got "${v}")`);
  }
  if (Number.parseInt(want.mfaSession, 10) * (want.mfaSession.endsWith('h') ? 60 : 1) > 720 * 60) fail(`--mfa-session is at most 720h (Cloudflare's cap; got "${want.mfaSession}")`);
  want.names = routeNames({ hostname: want.hostname, style: want.style });
  return want;
}

// ── gather (reads only) ─────────────────────────────────────────────────────

async function gather(api, wantIn, { choose } = {}) {
  const want = normalizeWant(wantIn);
  const state = { want };

  try {
    const v = await api.verifyToken({ account: want.account });
    if (!v.ok) fail(`the Cloudflare API token is not active (status: ${v.status || 'unknown'}) — create a new one`);
  } catch (e) {
    if (e instanceof CfApiError && !e.rateLimited) fail(`Cloudflare did not accept the API token — ${e.message}. Check you pasted the whole token.`);
    throw e;
  }

  const account = await pickAccount(api, want, { choose });
  state.account = { id: account.id, name: account.name };
  state.accountVia = account.via;

  const zone = await api.findZone(account.id, want.hostname);
  if (!zone) {
    fail(`no zone on account "${account.name || account.id}" holds ${want.hostname} — add the domain to Cloudflare first, `
      + `and give the token ${PERMS.dns} on it`);
  }
  state.zone = { id: zone.id, name: zone.name };
  // An account taken by id alone has no name until its zone says it.
  if (!state.account.name) state.account.name = (zone.account && zone.account.name) || account.id;

  let org;
  try {
    org = await api.organization(account.id);
  } catch (e) {
    if (e instanceof CfApiError && e.status === 404) org = null; else throw e;
  }
  const authDomain = org && typeof org.auth_domain === 'string' ? org.auth_domain : '';
  const team = authDomain.endsWith('.cloudflareaccess.com') ? authDomain.slice(0, -'.cloudflareaccess.com'.length) : '';
  if (!team) {
    fail('Zero Trust is not turned on for this account yet — open https://one.dash.cloudflare.com once, '
      + 'pick a team name and the Free plan, then run setup again');
  }
  state.org = org;
  state.team = team;

  state.idps = await api.identityProviders(account.id);

  const tunnel = await api.findTunnel(account.id, want.tunnelName);
  state.tunnel = tunnel;
  state.tunnelConfig = null;
  if (tunnel && tunnel.remote_config !== false) {
    const c = await api.tunnelConfig(account.id, tunnel.id);
    state.tunnelConfig = (c && c.config) || { ingress: [] };
  }

  state.dns = {};
  for (const name of [want.names.picker, want.names.sessionsDns]) {
    state.dns[name] = await api.dnsRecords(zone.id, name);
  }

  const apps = await api.accessApps(account.id);
  state.appsOnHost = apps.filter((a) => a && (lower(a.domain) === want.names.picker
    || (Array.isArray(a.destinations) && a.destinations.some((d) => d && lower(d.uri) === want.names.picker))));
  state.app = state.appsOnHost.find((a) => a.type === 'self_hosted') || null;
  const policies = await api.accessPolicies(account.id);
  state.policy = policies.find((p) => p && p.name === policyName(want.names.picker)) || null;
  return state;
}

// The account to set up in, → { id, name, via }. `via` says how it was found:
//   'id'        --account <id>, used directly — no listing at all (a token
//               without Account Settings › Read cannot list; name may be null
//               until the zone says it)
//   'accounts'  GET /accounts (the token has Account Settings › Read)
//   'zones'     /accounts came back empty, so the accounts of the zones the
//               token can see — what the real API does for a token without it
// --account also takes an account NAME, matched against the discovered list.
async function pickAccount(api, want, { choose } = {}) {
  let direct = null;
  if (want.account) {
    try {
      const a = await api.account(want.account);
      return { ...a, via: 'id' };
    } catch (e) {
      if (!(e instanceof CfApiError) || e.rateLimited) throw e;
      direct = e;
    }
  }
  const { accounts, via } = await api.discoverAccounts();
  const seen = () => accounts.map((a) => `${a.name} (${a.id})`).join(', ');
  if (want.account) {
    const a = accounts.find((x) => x.id === want.account || lower(x.name) === lower(want.account));
    if (a) return { ...a, via };
    fail(`the API token cannot reach account "${want.account}" (${direct.message})`
      + `${accounts.length ? ` — it sees: ${seen()}` : ''}. Check the id (dashboard → Account home → ⋯ → Copy account ID) and the token's Account Resources.`);
  }
  if (!accounts.length) {
    fail(`the API token can see no Cloudflare account — give it ${PERMS.account} (so it can list its account), `
      + 'or pass --account <id> (dashboard → Account home → ⋯ → Copy account ID); and check its Account and Zone Resources include your account and zone');
  }
  if (accounts.length === 1) return { ...accounts[0], via };
  const picked = choose ? await choose(accounts) : null;
  if (!picked) fail(`the token sees ${accounts.length} accounts — pick one with --account <id>: ${seen()}`);
  return { ...picked, via };
}

// ── plan (pure) ─────────────────────────────────────────────────────────────

function desiredIngress(state) {
  const { names, service } = state.want;
  const ours = [{ hostname: names.picker, service }, { hostname: names.sessionsDns, service }];
  const mine = new Set(ours.map((r) => r.hostname));
  const existing = (state.tunnelConfig && Array.isArray(state.tunnelConfig.ingress)) ? state.tunnelConfig.ingress : [];
  // Keep any rule of the user's own for another hostname (ahead of our
  // wildcard, so it still wins); drop the catch-all, then end with one.
  const others = existing.filter((r) => r && r.hostname && !mine.has(lower(r.hostname)));
  return [...others, ...ours, { service: 'http_status:404' }];
}

function sameIngress(a, b) {
  const key = (rs) => JSON.stringify((rs || []).map((r) => [lower(r.hostname), r.service, r.path || null]));
  return key(a) === key(b);
}

// One DNS name → { action: create|update|keep } or { conflict }.
function planDns(name, records, tunnelId) {
  const target = tunnelId ? tunnelTarget(tunnelId) : null;
  if (!records.length) return { name, action: 'create' };
  const ours = records.length === 1 && records[0].type === 'CNAME' && target && lower(records[0].content) === target;
  if (ours) return { name, action: records[0].proxied ? 'keep' : 'update', record: records[0] };
  const r = records[0];
  const what = `${r.type} ${r.name} → ${r.content}${records.length > 1 ? ` (and ${records.length - 1} more)` : ''}`;
  const why = r.type === 'CNAME' && /\.cfargotunnel\.com$/i.test(r.content || '')
    ? 'it already routes to a different tunnel'
    : 'setup never replaces a record you made';
  return { name, conflict: `DNS already has ${what} — ${why}. Remove or rename it in the Cloudflare dashboard (DNS → Records), or pick another --hostname, then run setup again.` };
}

function plan(state) {
  const { want } = state;
  const steps = [];
  const conflicts = [];
  const step = (what, action, detail) => steps.push({ what, action, detail });

  // Login method.
  if (want.signin === 'google') {
    const g = state.idps.find((p) => p.type === 'google');
    step('login method: Google', g ? 'keep' : 'create', g ? g.name : 'from the OAuth client you give setup');
  } else {
    const otp = state.idps.find((p) => p.type === 'onetimepin');
    step('login method: One-time PIN', otp ? 'keep' : 'create', otp ? otp.name : 'emailed sign-in codes');
  }

  // Tunnel.
  const t = state.tunnel;
  if (t && t.remote_config === false) {
    conflicts.push(`the tunnel "${want.tunnelName}" exists but is managed from a local config file, so its routes cannot be set through the API — `
      + 'pick another name with --name, or keep using it through the manual setup (`--kind local`).');
  }
  step(`tunnel "${want.tunnelName}"`, t ? 'keep' : 'create', t ? t.id : 'remotely managed');
  const ingress = desiredIngress(state);
  step(`tunnel routes → ${want.service}`, t && sameIngress(state.tunnelConfig && state.tunnelConfig.ingress, ingress) ? 'keep' : (t ? 'update' : 'create'),
    `${want.names.picker}, ${want.names.sessionsDns}`);

  // DNS.
  for (const name of [want.names.picker, want.names.sessionsDns]) {
    const d = planDns(name, state.dns[name] || [], t && t.id);
    if (d.conflict) conflicts.push(d.conflict);
    else step(`DNS ${name} (proxied CNAME to the tunnel)`, d.action);
  }

  // Access.
  const foreign = state.appsOnHost.filter((a) => a.type !== 'self_hosted');
  if (!state.app && foreign.length) {
    conflicts.push(`an Access application of type "${foreign[0].type}" ("${foreign[0].name}") already covers ${want.names.picker} — remove it, or pick another --hostname.`);
  }
  step(`Access policy "${policyName(want.names.picker)}"`, state.policy
    ? (policyMatches(state.policy, want) ? 'keep' : 'update') : 'create', want.emails.join(', '));
  if (want.signin === 'pin+biometric') {
    step('independent MFA (organization)', orgHasMfa(state.org) ? 'keep' : 'update',
      orgHasMfa(state.org) ? 'already on' : 'turned on, not required for other apps — or, if refused, on this application alone');
  }
  step(`Access application "${appName(want.names.picker)}"`, state.app ? 'converge' : 'create',
    `${want.names.picker} + ${want.names.sessionsAccess}, session ${want.session}`);

  // A flat wildcard on the zone apex (*.example.com) is what the free
  // certificate covers, and the maintainer's call is to keep it — but say what
  // it means, once. A warning, never a conflict.
  const warnings = [];
  const apex = state.zone && lower(state.zone.name);
  if (apex && want.names.sessionsDns === `*.${apex}`) {
    warnings.push(`DNS ${want.names.sessionsDns} catches every undefined subdomain of ${apex}; the portal refuses them (421) but they reach this machine`);
  }

  return { steps, conflicts, warnings };
}

function policyMatches(p, want) {
  const emails = (p.include || []).map((r) => r && r.email && lower(r.email.email)).filter(Boolean);
  return p.decision === 'allow' && sameSet(emails, want.emails) && (p.include || []).length === emails.length;
}

function orgHasMfa(org) {
  return !!(org && org.mfa_config && Array.isArray(org.mfa_config.allowed_authenticators) && org.mfa_config.allowed_authenticators.length);
}

// ── apply (writes) ──────────────────────────────────────────────────────────

// The organization body that turns independent MFA on. PUT
// /access/organizations replaces the WHOLE organization, so the body is the
// organization as GET returned it with only the MFA settings changed — but
// only the fields the endpoint takes (Cloudflare's "Zero Trust Organization ›
// Update" reference): GET also answers read-only ones (created_at,
// updated_at) and the live API refuses a body carrying them — or carrying
// "" for a setting that is simply unset — with
// access.api.error.invalid_org_config (12062). An unset field ("" or null) is
// left out, which a whole-object PUT reads the same as unset.
// mfa_required_for_all_apps is top-level in that reference (not inside
// mfa_config), and is kept as the org had it — false unless it was true.
const ORG_WRITABLE = [
  'allow_authenticate_via_warp', 'auth_domain', 'auto_redirect_to_identity', 'custom_pages',
  'deny_unmatched_requests', 'deny_unmatched_requests_exempted_zone_names', 'is_ui_read_only',
  'login_design', 'mfa_config', 'mfa_piv_key_requirements', 'mfa_required_for_all_apps', 'name',
  'service_token_inactivity', 'session_duration', 'ui_read_only_toggle_reason',
  'user_seat_expiration_inactive_time', 'warp_auth_non_browser_401', 'warp_auth_session_duration',
];

// A plain object without its unset ("" / null / undefined) members, all the way
// down (arrays are kept as they are).
function dropUnset(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v == null || v === '') continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? dropUnset(v) : v;
  }
  return out;
}

function orgBody(org, want) {
  const kept = dropUnset(Object.fromEntries(Object.entries(org || {}).filter(([k]) => ORG_WRITABLE.includes(k))));
  return {
    ...kept,
    mfa_config: { ...(kept.mfa_config || {}), allowed_authenticators: MFA_AUTHENTICATORS, session_duration: want.mfaSession },
    mfa_required_for_all_apps: !!(org && org.mfa_required_for_all_apps === true),
  };
}

// The app body we want, on top of whatever the app already holds (a PUT must
// carry the whole application — Cloudflare's docs: GET, then PUT everything).
const APP_READ_ONLY = ['id', 'uid', 'aud', 'created_at', 'updated_at'];

function appBody(existing, want, { idpId, policyId, mfa }) {
  const base = existing ? Object.fromEntries(Object.entries(existing).filter(([k]) => !APP_READ_ONLY.includes(k))) : {};
  const keepPolicies = (existing && Array.isArray(existing.policies) ? existing.policies : [])
    .filter((p) => p && p.id && p.id !== policyId)
    .map((p) => ({ id: p.id, precedence: p.precedence }));
  const top = keepPolicies.reduce((m, p) => Math.max(m, Number(p.precedence) || 0), 0);
  const body = {
    ...base,
    name: existing && existing.name ? existing.name : appName(want.names.picker),
    type: 'self_hosted',
    domain: want.names.picker,
    destinations: [{ type: 'public', uri: want.names.picker }, { type: 'public', uri: want.names.sessionsAccess }],
    session_duration: want.session,
    allowed_idps: [idpId],
    auto_redirect_to_identity: true,
    app_launcher_visible: false,
    policies: [...keepPolicies, { id: policyId, precedence: top + 1 }],
  };
  delete body.self_hosted_domains; // superseded by destinations
  if (mfa) body.mfa_config = { mfa_disabled: false, allowed_authenticators: MFA_AUTHENTICATORS, session_duration: want.mfaSession };
  else if (want.signin !== 'google') delete body.mfa_config;
  return body;
}

function mfaKey(m) {
  if (!m) return 'none';
  return JSON.stringify([m.mfa_disabled === true, [...(m.allowed_authenticators || [])].sort(), m.session_duration || null]);
}

function appMatches(existing, body) {
  if (!existing) return false;
  const uris = (existing.destinations || []).map((d) => lower(d.uri));
  const want = body.destinations.map((d) => d.uri);
  const pol = (existing.policies || []).map((p) => p.id);
  const mfaSame = mfaKey(existing.mfa_config) === mfaKey(body.mfa_config);
  return lower(existing.domain) === body.domain && sameSet(uris, want)
    && existing.session_duration === body.session_duration
    && sameSet(existing.allowed_idps || [], body.allowed_idps)
    && existing.auto_redirect_to_identity === true
    && sameSet(pol, body.policies.map((p) => p.id))
    && mfaSame;
}

// A refusal that means "your plan/account cannot have this", as opposed to a
// transient failure worth stopping on.
const isRefusal = (e) => e instanceof CfApiError && !e.rateLimited && e.status >= 400 && e.status < 500;

async function apply(api, state, { log = () => {}, google = null } = {}) {
  const { want } = state;
  const a = state.account.id;
  const done = (what, action) => log(`  ✓ ${what}${action ? ` — ${action}` : ''}`);

  // 1. The login method.
  let idp;
  if (want.signin === 'google') {
    idp = state.idps.find((p) => p.type === 'google');
    if (idp) done('login method: Google', 'already there');
    else {
      const g = google || want.google;
      if (!g || !g.clientId || !g.clientSecret) fail('Google sign-in needs the OAuth client id and secret (see the steps above)');
      idp = await api.createIdentityProvider(a, { name: 'Google', type: 'google', config: { client_id: g.clientId, client_secret: g.clientSecret } });
      done('login method: Google', 'created');
    }
  } else {
    idp = state.idps.find((p) => p.type === 'onetimepin');
    if (idp) done('login method: One-time PIN', 'already there');
    else {
      idp = await api.createIdentityProvider(a, { name: 'One-time PIN', type: 'onetimepin', config: {} });
      done('login method: One-time PIN', 'created');
    }
  }

  // 2. The tunnel, its connector token and its routes.
  let tunnel = state.tunnel;
  if (tunnel) done(`tunnel "${want.tunnelName}"`, `already there (${tunnel.id})`);
  else {
    tunnel = await api.createTunnel(a, want.tunnelName);
    done(`tunnel "${want.tunnelName}"`, `created (${tunnel.id})`);
  }
  const connectorToken = await api.tunnelToken(a, tunnel.id);
  if (typeof connectorToken !== 'string' || !connectorToken) fail(`Cloudflare returned no connector token for tunnel ${tunnel.id}`);
  const ingress = desiredIngress({ ...state, tunnelConfig: state.tunnel ? state.tunnelConfig : null });
  if (state.tunnel && sameIngress(state.tunnelConfig && state.tunnelConfig.ingress, ingress)) done('tunnel routes', 'unchanged');
  else {
    const kept = state.tunnel && state.tunnelConfig ? { ...state.tunnelConfig } : {};
    await api.putTunnelConfig(a, tunnel.id, { ...kept, ingress });
    done('tunnel routes', `${want.names.picker} + ${want.names.sessionsDns} → ${want.service}`);
  }

  // 3. DNS — re-planned against the real tunnel id (a new tunnel has one only now).
  for (const name of [want.names.picker, want.names.sessionsDns]) {
    const d = planDns(name, state.dns[name] || [], tunnel.id);
    if (d.conflict) fail(d.conflict);
    if (d.action === 'create') {
      await api.createDnsRecord(state.zone.id, { type: 'CNAME', name, content: tunnelTarget(tunnel.id), proxied: true, comment: 'web-chat tunnel' });
      done(`DNS ${name}`, 'created');
    } else if (d.action === 'update') {
      await api.patchDnsRecord(state.zone.id, d.record.id, { proxied: true });
      done(`DNS ${name}`, 'now proxied');
    } else done(`DNS ${name}`, 'already there');
  }

  // 4. The Access policy (reusable, so a re-run finds it by name).
  const policyBody = {
    name: policyName(want.names.picker),
    decision: 'allow',
    include: want.emails.map((email) => ({ email: { email } })),
  };
  let policy = state.policy;
  if (!policy) {
    policy = await api.createAccessPolicy(a, policyBody);
    done('Access policy', `created for ${want.emails.join(', ')}`);
  } else if (!policyMatches(policy, want)) {
    policy = await api.putAccessPolicy(a, policy.id, { ...policyBody, ...(policy.mfa_config ? { mfa_config: policy.mfa_config } : {}) });
    done('Access policy', `updated to ${want.emails.join(', ')}`);
  } else done('Access policy', 'unchanged');

  // 5. Independent MFA — organization first (the prerequisite), then the app.
  //    An organization that refuses still leaves the application to try: MFA
  //    on this app alone is the least invasive form of it, and an org whose
  //    independent MFA was turned on in the dashboard takes it. `orgRefusal`
  //    is kept to explain either outcome.
  let signin = want.signin === 'google' ? 'google' : 'pin';
  let why = want.signin === 'google' ? 'as asked (--signin google)' : (want.signin === 'pin' ? 'as asked (--signin pin)' : null);
  let mfa = false;
  let orgRefusal = null;
  if (want.signin === 'pin+biometric') {
    mfa = true;
    if (orgHasMfa(state.org)) {
      done('independent MFA (organization)', 'already on — its authenticators are left as they are');
    } else {
      try {
        await api.putOrganization(a, orgBody(state.org, want));
        done('independent MFA (organization)', 'turned on (not required for your other apps)');
      } catch (e) {
        if (!isRefusal(e)) throw e;
        orgRefusal = e.message;
        done('independent MFA (organization)', `refused — trying this application alone (${e.message})`);
      }
    }
  }

  // 6. The Access application, then its AUD tag.
  const existing = state.app;
  let app = null;
  const write = async (withMfa) => {
    const body = appBody(existing, want, { idpId: idp.id, policyId: policy.id, mfa: withMfa });
    if (existing && appMatches(existing, body)) { done('Access application', 'unchanged'); return existing; }
    const r = existing ? await api.putAccessApp(a, existing.id, body) : await api.createAccessApp(a, body);
    done('Access application', existing ? 'updated' : 'created');
    return r;
  };
  let mfaScope = null;
  if (mfa) {
    try {
      app = await write(true);
      signin = 'pin+biometric';
      mfaScope = orgRefusal ? 'app' : 'org';
      why = orgRefusal ? `required on this application only; Cloudflare would not turn it on for the organization: ${orgRefusal}` : null;
    } catch (e) {
      if (!isRefusal(e)) throw e;
      why = orgRefusal
        ? `Cloudflare would not turn on independent MFA for the organization (${orgRefusal}), nor require it on the application alone (${e.message})`
        : `Cloudflare would not require independent MFA on the application: ${e.message}`;
    }
  }
  if (!app) app = await write(false);
  if (signin === 'pin' && want.signin === 'pin+biometric') why = `${why} — so sign-in is the emailed one-time PIN alone, with a ${want.session} session`;
  const aud = app && app.aud;
  if (!aud) fail('Cloudflare did not return the Access application\'s AUD tag');

  return {
    team: state.team,
    aud,
    tunnelId: tunnel.id,
    tunnelName: want.tunnelName,
    connectorToken,
    signin,
    why,
    mfaScope,
    account: state.account,
    zone: state.zone,
  };
}

module.exports = {
  gather, plan, apply, normalizeWant, planDns, desiredIngress, orgBody, ORG_WRITABLE,
  DEFAULT_TUNNEL_NAME, DEFAULT_SESSION, DEFAULT_MFA_SESSION, MFA_AUTHENTICATORS,
};
