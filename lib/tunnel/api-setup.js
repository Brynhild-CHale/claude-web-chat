// The one-token setup RUN — what `tunnel setup --api-token` does around
// lib/tunnel/cf-setup's gather/plan/apply: read what tunnel.json holds now,
// build what setup wants, read the account, print the plan, stop on a conflict,
// apply, then prove the Access keys answer and write tunnel.json + the
// connector token. Shared by the two callers that run it:
//
//   * the CLI (lib/cli/commands/tunnel), which asks for what it lacks in the
//     terminal, and
//   * the daemon's browser setup page (lib/server/tunnel-setup), which takes
//     the same values from a form on its own origin.
//
// Both hand in a `log` and get the SAME lines, so the page shows the text the
// terminal would. It lived inside the CLI command until the page needed it; an
// entry point cannot import another's internals, so it moved down a layer.
//
// The API token is used for the one run it is handed to and never written
// anywhere: what setup stores is the tunnel's CONNECTOR token, as it always has.

const fs = require('fs');
const { userPaths } = require('../core/paths');
const { readJson, writeJsonAtomic, renameAside } = require('../core/fsjson');
const { normalizeConfig, publicOrigin, portalPort } = require('./config');
const { defaultFetchJwks, parseJwks } = require('./jwks');
const cfSetup = require('./cf-setup');

function fail(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  throw e;
}

// Where the person goes to make the token, and to turn Zero Trust on once.
const TOKEN_PAGE_URL = 'https://dash.cloudflare.com/profile/api-tokens';
const ZERO_TRUST_URL = 'https://one.dash.cloudflare.com';

const ALLOWLIST_WARNING = [
  '',
  '  ⚠  WHO YOU ALLOWLIST CAN ACT AS YOU ON THIS MACHINE.',
  '     A signed-in, allowlisted account drives your surfaces exactly as you do',
  '     locally — including panes of TRUSTED service components, which run host',
  '     code with your user account. Pack installs and service approval stay',
  '     host-only, but treat every address here as someone you would hand a',
  '     shell to. One address (your own) is the intended setup.',
  '',
];

// `--signin` spellings → cf-setup's names, and how each is said to a person.
const SIGNIN_FLAG = { pin: 'pin', 'pin+biometric': 'pin+biometric', biometric: 'pin+biometric', google: 'google' };
const SIGNIN_LABEL = {
  'pin+biometric': 'emailed one-time PIN + biometrics (independent MFA)',
  pin: 'emailed one-time PIN',
  google: 'Google login',
};

// tunnel.json as it is now. Only an ABSENT file starts from nothing. One that
// is there but cannot be read (a JSON typo, usually from hand-editing
// expose.exclude — the one section only a hand edit sets) is never silently
// replaced: writeTunnelFiles moves it aside, kept and named, just before the
// new one is written, so nothing it held is lost without a word (and a setup
// that fails first leaves it be).
function readExisting(paths = userPaths()) {
  const existingRead = readJson(paths.tunnelConfig);
  const unreadable = !existingRead.absent
    && !(existingRead.ok && existingRead.value && typeof existingRead.value === 'object' && !Array.isArray(existingRead.value));
  const existing = unreadable || existingRead.absent ? {} : existingRead.value;
  return { existingRead, unreadable, existing };
}

// What a re-run starts from: the hostname, style, allowlist and (a token-kind
// tunnel's) name tunnel.json already holds — each '' / [] when it holds none.
function defaultsFrom(existing) {
  const ex = (o, k) => (o && typeof o === 'object' ? o[k] : undefined);
  return {
    hostname: typeof existing.hostname === 'string' ? existing.hostname : '',
    style: typeof existing.style === 'string' ? existing.style : 'flat',
    emails: Array.isArray(ex(existing.allow, 'emails')) ? existing.allow.emails : [],
    tunnelName: (ex(existing.tunnel, 'kind') === 'token' && ex(existing.tunnel, 'name')) || cfSetup.DEFAULT_TUNNEL_NAME,
  };
}

// tunnel.json (0600) and, when there is one, the connector token (0600) — for
// both setup paths. An unreadable tunnel.json is moved aside and named first.
function writeTunnelFiles({ paths, config, token, unreadable, existingRead, log }) {
  fs.mkdirSync(paths.tunnelDir, { recursive: true, mode: 0o700 });
  if (unreadable) {
    const why = existingRead.error ? existingRead.error.message : 'not a JSON object';
    const aside = renameAside(paths.tunnelConfig);
    log(`  ✗ the existing ${paths.tunnelConfig} could not be read (${why}).`);
    log(`    Moved aside, untouched, to ${aside}.`);
    log('    Nothing in it was carried over — expose.exclude, allow.domains, showRoots, remote.allowDestructive');
    log('    and tunnel.credentialsFile are back to their defaults. Copy back what you need from that file.');
  }
  const { tunnel: t, signin, ...rest } = config;
  writeJsonAtomic(paths.tunnelConfig, {
    ...rest,
    tunnel: Object.fromEntries(Object.entries(t).filter(([, v]) => v != null)),
    ...(signin ? { signin } : {}),
  }, { newline: true });
  fs.chmodSync(paths.tunnelConfig, 0o600);
  if (token) {
    fs.writeFileSync(paths.tunnelToken, `${token}\n`, { mode: 0o600 });
    fs.chmodSync(paths.tunnelToken, 0o600);
  }
  log(`  ✓ wrote ${paths.tunnelConfig} (0600)`);
}

// What setup wants, from the values a caller collected. The manual path's own
// check runs first: a hostname or style the portal would refuse is refused
// here, before anything is created for it.
function buildWant({ hostname, style = 'flat', emails, signin = 'pin+biometric', tunnelName, account = null, session, mfaSession, env = process.env }) {
  normalizeConfig({ hostname, style, access: { team: 'placeholder', aud: 'placeholder' }, allow: { emails } });
  return {
    hostname, style, emails, tunnelName: tunnelName || cfSetup.DEFAULT_TUNNEL_NAME, signin,
    session, mfaSession, account: account || null,
    service: `http://127.0.0.1:${portalPort(env)}`,
  };
}

// The plan as setup prints it: one line per step, then any warning.
function planLines(p, { dryRun = false } = {}) {
  return [
    dryRun ? 'The plan (nothing is changed with --dry-run):' : 'The plan:',
    ...p.steps.map((st) => `  ${st.action.padEnd(8)} ${st.what}${st.detail ? `  (${st.detail})` : ''}`),
    ...(p.warnings || []).map((w) => `  ⚠  ${w}`),
    '',
  ];
}

// Read → plan → (unless dryRun) apply. Stops on a conflict BEFORE any write.
// `google(state)` is asked for the OAuth client only when Google sign-in needs
// one created. Returns { dryRun, state, plan, result }.
async function runSetup({ api, want, dryRun = false, log, choose, google = null, dryRunNote }) {
  log(`Reading your Cloudflare account${api.base.startsWith('https://api.cloudflare.com') ? '' : ` (${api.base})`}…`);
  const state = await cfSetup.gather(api, want, { choose });
  log(`  account ${state.account.name} · zone ${state.zone.name} · Zero Trust team "${state.team}"`);
  log('');

  const p = cfSetup.plan(state);
  for (const l of planLines(p, { dryRun })) log(l);
  if (p.conflicts.length) {
    for (const c of p.conflicts) log(`  ✗ ${c}`);
    fail(`setup stopped before changing anything: ${p.conflicts.length === 1 ? 'a conflict' : `${p.conflicts.length} conflicts`} in your Cloudflare account (above)`);
  }
  if (dryRun) {
    log(dryRunNote || '--dry-run: nothing was changed. Run again without --dry-run to apply it.');
    return { dryRun: true, state, plan: p, result: null };
  }

  const g = want.signin === 'google' && !state.idps.some((i) => i.type === 'google') && google ? await google(state) : null;
  log('Applying:');
  const result = await cfSetup.apply(api, state, { log, google: g });
  log('');
  return { dryRun: false, state, plan: p, result };
}

// After a successful apply: prove the team's Access keys answer (a warning,
// not a failure — they can lag a new team by a minute), write tunnel.json and
// the connector token, and say what was configured and what comes next.
async function finishSetup({
  paths = userPaths(), existing, existingRead, unreadable, hostname, style, emails, result: r,
  log, fetchJwks = defaultFetchJwks, skipVerify = false,
}) {
  const ex = (o, k) => (o && typeof o === 'object' ? o[k] : undefined);
  if (skipVerify) log(`  (--skip-verify — not checking the Access signing keys for "${r.team}")`);
  else {
    let n = 0;
    try { n = parseJwks(await fetchJwks(r.team)).size; } catch (e) {
      log(`  ⚠  the Access signing keys for team "${r.team}" did not answer yet (${e.message}) — \`tunnel up\` works once they do`);
    }
    if (n) log(`  ✓ Access signing keys for "${r.team}" answer (${n} key${n === 1 ? '' : 's'})`);
  }

  const config = normalizeConfig({
    ...existing,
    hostname,
    style,
    access: { team: r.team, aud: r.aud },
    allow: { ...(existing.allow || {}), emails },
    tunnel: {
      kind: 'token',
      name: r.tunnelName,
      ...(ex(existing.tunnel, 'metricsPort') ? { metricsPort: Number(existing.tunnel.metricsPort) } : {}),
    },
    signin: r.signin,
  });
  writeTunnelFiles({ paths, config, token: r.connectorToken, unreadable, existingRead, log });
  log(`  ✓ wrote the tunnel's connector token to ${paths.tunnelToken} (0600)`);
  log('  ✓ the API token was not saved');
  log('');
  log(`Sign-in: ${SIGNIN_LABEL[r.signin]}${r.why ? ` — ${r.why}` : ''}.`);
  if (r.signin === 'pin+biometric') {
    log(`  After the emailed code, Access asks for your second factor; register Face ID / Touch ID / Windows Hello`);
    log(`  when it offers to (or beforehand, in the App Launcher: https://${r.team}.cloudflareaccess.com).`);
  }
  for (const l of ALLOWLIST_WARNING) log(l);
  if (config.allow.emails.length > 1) {
    log(`  ⚠  ${config.allow.emails.length} accounts are allowlisted: ${config.allow.emails.join(', ')}`);
    log('');
  }
  log(`Then: claude-web-chat tunnel up   → ${publicOrigin(config.hostname)}/`);
  return config;
}

module.exports = {
  readExisting, defaultsFrom, writeTunnelFiles, buildWant, planLines, runSetup, finishSetup,
  ALLOWLIST_WARNING, SIGNIN_FLAG, SIGNIN_LABEL, TOKEN_PAGE_URL, ZERO_TRUST_URL,
};
