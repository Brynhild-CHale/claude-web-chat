// `claude-web-chat tunnel <setup|up|down|status|logs>` — remote access to this
// machine's web-chat surfaces through a Cloudflare tunnel, behind Cloudflare
// Access (an emailed PIN + biometrics, or Google) AND the portal's own check
// of every Access token.
//
//   setup   two paths to the same tunnel.json.
//           ONE TOKEN (--api-token-file / --api-token / a paste): a Cloudflare
//           API token lets setup create the tunnel, its routes, the DNS, the
//           login method, the Access policy and application itself
//           (lib/tunnel/cf-setup), idempotently, then read back the team name
//           and AUD tag. --dry-run prints the plan and changes nothing. The
//           API token is used for this run only and never stored.
//           MANUAL (--team/--aud/--kind…): ask for (or take as flags) the
//           hostname, style, Access team, AUD tag, the allowlisted account(s)
//           and the tunnel; print the dashboard steps.
//           Both prove the team's signing keys answer, then write
//           ~/.web-chat/tunnel/tunnel.json (0600) and the connector token (0600).
//   up      preflight everything that would make the tunnel unsafe or broken,
//           then start the portal detached (`portal run`), which supervises
//           cloudflared. Waits for the portal's /api/health. A running portal
//           from an older build, or one not enforcing tunnel.json as it is
//           (the portal applies most edits live, but not a new hostname,
//           style or tunnel), or one whose cloudflared runs on a connector
//           token the file no longer holds, is restarted instead. `update`
//           runs the same bounce (restartPortal) from the new build.
//   down    ask the portal to stop (SIGTERM to the pid its own /api/health
//           reported); cloudflared dies with it.
//   status  config, portal, connector readiness (cloudflared's loopback
//           `--metrics` /ready), last key-set refresh, exposed sessions and
//           the ones hidden (expose.exclude, a project's no-remote marker).
//   logs    the portal and cloudflared logs and the remote access log;
//           --follow keeps printing.
//
// Everything that decides what a valid config is lives in lib/tunnel (shared by
// this command, the portal and doctor) — nothing here re-derives it. So does
// the one-token RUN (lib/tunnel/api-setup) and up/down/status
// (lib/tunnel/control): the browser setup page (⌘K "Set up remote access…",
// lib/server/tunnel-setup) runs the same code, so this file is the terminal's
// questions and printing around it.

const fs = require('fs');
const { userPaths } = require('../../core/paths');
const { ago } = require('../../core/mcp-seen');
const { createPrompt } = require('../prompt');
const {
  normalizeConfig, sessionHost, portalPort, routeNames, STYLES, KINDS,
} = require('../../tunnel/config');
const { defaultFetchJwks, parseJwks } = require('../../tunnel/jwks');
const { readToken } = require('../../tunnel/cloudflared');
const { createCfApi, PERMS, PERM_ALIASES } = require('../../tunnel/cf-api');
const {
  readExisting, defaultsFrom, writeTunnelFiles, buildWant, runSetup, finishSetup, ALLOWLIST_WARNING, SIGNIN_FLAG,
} = require('../../tunnel/api-setup');
const { up, down, restartPortal, collectStatus, tail } = require('../../tunnel/control');

const BOOLEAN_FLAGS = new Set(['yes', 'no-input', 'skip-verify', 'follow', 'json', 'portal', 'cloudflared', 'access', 'dry-run', 'api']);

function fail(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  throw e;
}

// `--k v`, `--k=v`, repeatable `--email`, and the boolean flags above.
function parseFlags(args) {
  const out = { email: [], _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq !== -1) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    if (BOOLEAN_FLAGS.has(key)) { out[key] = val == null ? true : val !== 'false'; continue; }
    if (val == null) val = args[++i];
    if (val == null) fail(`--${key} needs a value`);
    if (key === 'email') out.email.push(...String(val).split(',').map((s) => s.trim()).filter(Boolean));
    else out[key] = val;
  }
  return out;
}

// A timestamp as "3m ago" through the one relative-time formatter (which takes
// an age, not a time), or "never" for a key set that has not loaded yet.
function since(t, now = Date.now()) {
  return Number.isFinite(t) ? ago(Math.max(0, now - t)) : 'never';
}

// ── setup ───────────────────────────────────────────────────────────────────

function dashboardSteps(config, { port }) {
  const { sessionsDns, sessionsAccess } = routeNames(config);
  const example = sessionHost(config, '0a1b2c3d');
  const t = config.tunnel;
  const lines = [
    'Next, once, in the Cloudflare Zero Trust dashboard (https://one.dash.cloudflare.com):',
    '',
  ];
  if (t.kind === 'token') {
    lines.push(
      '  1. Networks → Tunnels → Create a tunnel (type: Cloudflared). Its connector token',
      '     is what you gave setup (kept in ~/.web-chat/tunnel/token, 0600) — do not run',
      '     the `cloudflared service install` line the dashboard shows; `tunnel up` runs it.',
      `  2. In that tunnel, Public Hostnames → add ${config.hostname} AND ${sessionsDns}`,
      `     (or one per project, like ${example} — \`claude-web-chat tunnel status\` lists them),`,
      `     each with service  http://127.0.0.1:${port}`,
    );
  } else {
    lines.push(
      `  1. The tunnel "${t.name}" comes from \`cloudflared tunnel create ${t.name}\` (run once, on this machine).`,
      '     Its ingress is generated for you on every `tunnel up`.',
      `  2. Point DNS at it:  cloudflared tunnel route dns ${t.name} ${config.hostname}`,
      `                      cloudflared tunnel route dns ${t.name} '${sessionsDns}'`,
      `     (or one per project, like ${example} — \`claude-web-chat tunnel status\` lists them)`,
    );
  }
  lines.push(
    '  3. Access → Applications → Add an application → Self-hosted, covering',
    `     ${config.hostname} and ${sessionsAccess}. Identity provider: Google (Settings →`,
    '     Authentication → Login methods). Policy: Action Allow, Include → Emails →',
    `     ${config.allow.emails.join(', ')}.`,
    '  4. Copy that application\'s Application Audience (AUD) Tag. It must equal the one',
    `     saved here (${config.access.aud.slice(0, 12)}…) — rerun setup with --aud if not.`,
    '',
    'Then: claude-web-chat tunnel up   (a running portal applies this file by itself; `up` restarts it when the hostname or tunnel changed)',
  );
  if (config.style === 'nested') {
    lines.push('', `Nested hostnames need a certificate for *.${config.hostname} (Advanced Certificate Manager) —`,
      'the free Universal SSL certificate covers one level of subdomain only.');
  }
  return lines;
}

async function setup(flags, { log, prompt, fetchJwks = defaultFetchJwks, env = process.env }) {
  const paths = userPaths();
  // An unreadable tunnel.json is moved aside, never silently replaced
  // (lib/tunnel/api-setup readExisting).
  const { existingRead, unreadable, existing } = readExisting(paths);
  const ex = (o, k) => (o && typeof o === 'object' ? o[k] : undefined);

  async function ask(question, def) {
    const a = await prompt.line(`${question}${def ? ` [${def}]` : ''}:`);
    return a || def || '';
  }

  // Which path. A flag of either decides it (both at once is refused); with
  // neither, a first-time setup asks, defaulting to the one-token path.
  const apiFlag = API_FLAGS.find((k) => flags[k] != null);
  const manualFlag = MANUAL_FLAGS.find((k) => flags[k] != null);
  if (apiFlag && manualFlag) fail(`--${apiFlag} (the one-token setup) and --${manualFlag} (the manual setup) do not go together — pick one`);
  let useApi = !!apiFlag;
  if (!apiFlag && !manualFlag && existingRead.absent) {
    log('claude-web-chat tunnel setup — remote access through Cloudflare Tunnel + Access');
    log('');
    useApi = await prompt.confirm('Set everything up with one Cloudflare API token (recommended — otherwise you do each step in the dashboard)?', { def: true });
    log('');
  }
  if (useApi) {
    return setupWithApi(flags, { log, prompt, fetchJwks, env, paths, existing, existingRead, unreadable, ask });
  }

  log('claude-web-chat tunnel setup — remote access through Cloudflare Tunnel + Access');
  log('');
  if (unreadable) {
    log(`  ⚠  ${paths.tunnelConfig} is there but unreadable — starting from defaults; it will be moved aside, not overwritten.`);
    log('');
  }
  const hostname = flags.hostname || await ask('Picker hostname (e.g. wc.example.com)', existing.hostname);
  if (!hostname) fail('a hostname is required (--hostname wc.example.com)');
  const style = flags.style || await ask(`Hostname style: flat (wc-<id>.example.com, free certificate) or nested (<id>.wc.example.com) — ${STYLES.join('|')}`, existing.style || 'flat');
  const team = flags.team || await ask('Cloudflare Zero Trust team name (the <team> in <team>.cloudflareaccess.com)', ex(existing.access, 'team'));
  if (!team) fail('an Access team name is required (--team <team>)');
  const aud = flags.aud || await ask('Access application AUD tag', ex(existing.access, 'aud'));
  if (!aud) fail('the Access application\'s AUD tag is required (--aud <tag>)');

  let emails = flags.email.length ? flags.email : (Array.isArray(ex(existing.allow, 'emails')) ? existing.allow.emails : []);
  if (!emails.length) {
    const one = await ask('The ONE Google account allowed in (your own)', '');
    if (one) emails = [one];
  }
  if (!emails.length) fail('at least one allowed Google account is required (--email you@example.com)');

  const kind = (flags.kind || await ask(`Tunnel kind: token (created in the dashboard) or local (\`cloudflared tunnel create\`) — ${KINDS.join('|')}`, ex(existing.tunnel, 'kind') || 'token')).toLowerCase();
  let name = flags.name || ex(existing.tunnel, 'name') || null;
  if (kind === 'local' && !flags.name) name = await ask('Tunnel name (from `cloudflared tunnel create <name>`)', name || '');

  const raw = {
    ...existing,
    hostname,
    style,
    access: { team, aud },
    allow: { ...(existing.allow || {}), emails },
    tunnel: {
      kind,
      ...(name ? { name } : {}),
      ...((flags['credentials-file'] || ex(existing.tunnel, 'credentialsFile')) ? { credentialsFile: flags['credentials-file'] || existing.tunnel.credentialsFile } : {}),
      ...((flags['metrics-port'] || ex(existing.tunnel, 'metricsPort')) ? { metricsPort: Number(flags['metrics-port'] || existing.tunnel.metricsPort) } : {}),
    },
  };
  // The one normaliser — the portal will read this file through it, so setup
  // never writes anything the portal would refuse.
  const config = normalizeConfig(raw);

  // The connector token (token kind): from --token-file, or pasted, or the one
  // already on disk. Never a flag VALUE — that would put it in shell history.
  let token = null;
  if (kind === 'token') {
    if (flags['token-file']) {
      try { token = fs.readFileSync(flags['token-file'], 'utf8').trim(); } catch (e) { fail(`could not read --token-file ${flags['token-file']}: ${e.message}`); }
      if (!token) fail(`--token-file ${flags['token-file']} is empty`);
    } else if (!readToken(paths.tunnelToken)) {
      token = await prompt.line('Connector token (the long string after `--token` in the dashboard\'s install command; stored 0600):');
    }
  }

  // Prove the team name: its Access signing keys must answer. A typo here is
  // otherwise a portal that 503s every visitor.
  if (flags['skip-verify']) {
    log(`  (--skip-verify — not checking https://${config.access.team}.cloudflareaccess.com/cdn-cgi/access/certs)`);
  } else {
    let n = 0;
    try { n = parseJwks(await fetchJwks(config.access.team)).size; } catch (e) {
      fail(`could not fetch the Access signing keys for team "${config.access.team}": ${e.message} — check the team name (or pass --skip-verify to save anyway)`);
    }
    if (!n) fail(`the Access key set for team "${config.access.team}" holds no RSA signing keys — check the team name (or pass --skip-verify)`);
    log(`  ✓ Access signing keys for "${config.access.team}" answer (${n} key${n === 1 ? '' : 's'})`);
  }

  writeTunnelFiles({ paths, config, token, unreadable, existingRead, log });
  if (token) log(`  ✓ wrote the connector token to ${paths.tunnelToken} (0600)`);
  else if (kind === 'token' && !readToken(paths.tunnelToken)) {
    log(`  ✗ no connector token yet — put it in ${paths.tunnelToken} (or rerun setup with --token-file <file>); \`tunnel up\` refuses without it`);
  }

  for (const l of ALLOWLIST_WARNING) log(l);
  if (config.allow.emails.length > 1) {
    log(`  ⚠  ${config.allow.emails.length} accounts are allowlisted: ${config.allow.emails.join(', ')}`);
    log('');
  }
  for (const l of dashboardSteps(config, { port: portalPort() })) log(l);
  return config;
}

// ── setup: the one-token path ───────────────────────────────────────────────

// Flags that pick a path. A flag of the other path alongside is refused.
const API_FLAGS = ['api', 'api-token', 'api-token-file', 'signin', 'dry-run', 'account', 'session', 'mfa-session', 'google-client-id', 'google-client-secret-file'];
const MANUAL_FLAGS = ['team', 'aud', 'kind', 'token-file', 'credentials-file'];

function tokenHelp() {
  return [
    'Create a Cloudflare API token: https://dash.cloudflare.com/profile/api-tokens → Create Token →',
    'Create Custom Token, with these permissions:',
    ...Object.values(PERMS).map((p) => `    ${p}${PERM_ALIASES[p] ? `   (newer dashboards: ${PERM_ALIASES[p].split(' › ').slice(1).join(' › ')})` : ''}`),
    `  ${PERMS.account} lets setup list your account; without it, it finds the account through your zone.`,
    '  Account Resources: your account.  Zone Resources: the zone your hostname is in.',
    '  setup uses it for this run only and does not save it — delete it afterwards if you like.',
    '  (Zero Trust must be turned on once: https://one.dash.cloudflare.com → pick a team name, Free plan.)',
    '',
  ];
}

function googleSteps(team) {
  return [
    'Google sign-in needs an OAuth client, made once in Google Cloud (https://console.cloud.google.com):',
    '  1. Create a project → APIs & Services → OAuth consent screen: Get started, any app name,',
    '     your email as support + contact, Audience: External → Create.',
    '  2. Credentials → Create OAuth client → Application type: Web application.',
    `  3. Authorized JavaScript origins:  https://${team}.cloudflareaccess.com`,
    `  4. Authorized redirect URIs:       https://${team}.cloudflareaccess.com/cdn-cgi/access/callback`,
    '  5. Create, then copy the Client ID and the Client secret.',
    '  A passkey on that Google account is Google\'s own setting (myaccount.google.com → Security → Passkeys).',
    '',
  ];
}

async function setupWithApi(flags, { log, prompt, fetchJwks, env, paths, existing, unreadable, existingRead, ask }) {
  const dryRun = flags['dry-run'] === true;
  log(`claude-web-chat tunnel setup — one Cloudflare API token${dryRun ? ' (--dry-run: nothing will be changed)' : ''}`);
  log('');

  // The API token: a file, a flag value (discouraged — shell history), or a
  // paste. Held in memory for this run only.
  let apiToken = '';
  if (flags['api-token-file']) {
    try { apiToken = fs.readFileSync(flags['api-token-file'], 'utf8').trim(); } catch (e) { fail(`could not read --api-token-file ${flags['api-token-file']}: ${e.message}`); }
    if (!apiToken) fail(`--api-token-file ${flags['api-token-file']} is empty`);
  } else if (typeof flags['api-token'] === 'string' && flags['api-token']) {
    apiToken = flags['api-token'].trim();
    log('  ⚠  --api-token puts the token in your shell history — --api-token-file <file> or a paste does not.');
  } else {
    for (const l of tokenHelp()) log(l);
    apiToken = (await prompt.line('Paste the Cloudflare API token:')).trim();
  }
  if (!apiToken) fail('no Cloudflare API token — paste one, or pass --api-token-file <file> (or use the manual setup: --team/--aud/--kind)');

  const hostname = flags.hostname || await ask('Picker hostname (e.g. wc.example.com)', existing.hostname);
  if (!hostname) fail('a hostname is required (--hostname wc.example.com)');
  const style = flags.style || existing.style || 'flat';
  let emails = flags.email.length ? flags.email : defaultsFrom(existing).emails;
  if (!emails.length) {
    const one = await ask('The ONE email address allowed in (your own — the sign-in code goes there)', '');
    if (one) emails = [one];
  }
  if (!emails.length) fail('at least one allowed email is required (--email you@example.com)');
  const signinFlag = flags.signin == null ? 'pin+biometric' : String(flags.signin).toLowerCase();
  const signinWant = SIGNIN_FLAG[signinFlag];
  if (!signinWant) fail(`--signin must be pin+biometric (the default), pin, or google (got "${flags.signin}")`);
  const api = createCfApi({ token: apiToken, env });
  const want = buildWant({
    hostname, style, emails, signin: signinWant,
    tunnelName: flags.name || defaultsFrom(existing).tunnelName,
    session: flags.session, mfaSession: flags['mfa-session'], account: flags.account, env,
  });
  const choose = async (accounts) => {
    accounts.forEach((a, i) => log(`  ${i + 1}. ${a.name} (${a.id})`));
    const n = Number.parseInt(await ask('Which Cloudflare account', ''), 10);
    return accounts[n - 1] || null;
  };
  const google = async (state) => {
    for (const l of googleSteps(state.team)) log(l);
    const clientId = flags['google-client-id'] || await ask('Google OAuth Client ID', '');
    let clientSecret = '';
    if (flags['google-client-secret-file']) {
      try { clientSecret = fs.readFileSync(flags['google-client-secret-file'], 'utf8').trim(); } catch (e) { fail(`could not read --google-client-secret-file: ${e.message}`); }
    } else clientSecret = (await prompt.line('Google OAuth Client secret:')).trim();
    if (!clientId || !clientSecret) fail('Google sign-in needs both the OAuth Client ID and secret (--google-client-id, --google-client-secret-file)');
    return { clientId, clientSecret };
  };
  const run = await runSetup({ api, want, dryRun, log, choose, google });
  if (run.dryRun) return { dryRun: true, plan: run.plan, team: run.state.team };

  return finishSetup({
    paths, existing, existingRead, unreadable, hostname, style, emails, result: run.result,
    log, fetchJwks, skipVerify: !!flags['skip-verify'],
  });
}

const HIDDEN_WHY = {
  excluded: 'expose.exclude in tunnel.json',
  'no-remote': 'the project\'s .web-chat/no-remote marker',
};

function printStatus(s, log) {
  if (!s.configured) {
    log(`tunnel: not configured — ${s.error}`);
    if (s.portal.running) log(`portal: running (pid ${s.portal.pid}) on 127.0.0.1:${s.portal.port}`);
    if (s.portal.running && s.portal.config && s.portal.config.state === 'invalid') {
      log('  ⚠  FAILING CLOSED: the portal cannot read this tunnel.json, so it answers every remote request');
      log('     503 and has cut every live socket. Fix the file and it resumes on its own within seconds.');
    }
    return;
  }
  log(`tunnel: ${s.hostname} (${s.style})${s.tunnel ? ` · ${s.tunnel.kind} tunnel${s.tunnel.name ? ` "${s.tunnel.name}"` : ''}` : ' · no tunnel configured'}`);
  log(`allowlist: ${s.allowlist.emails} email(s)${s.allowlist.domains ? ` + ${s.allowlist.domains} domain(s)` : ''}`);
  log(s.portal.running
    ? `portal: running — pid ${s.portal.pid} on 127.0.0.1:${s.portal.port}, up since ${new Date(s.portal.started_at).toISOString()}`
    : `portal: not running (would use 127.0.0.1:${s.portal.port}) — \`claude-web-chat tunnel up\``);
  const restart = (s.portal.config && s.portal.config.restart) || [];
  if (s.portal.running && s.portal.config && s.portal.config.state === 'invalid') {
    // The file reads fine now, but the portal has not re-read it yet.
    log('  ⚠  FAILING CLOSED until the portal re-reads tunnel.json (it did not parse last time) — every remote');
    log('     request is answered 503 meanwhile. It picks the file up within seconds, or `tunnel up` restarts it.');
  } else if (s.portal.running && restart.length) {
    log(`  ⚠  restart needed: tunnel.json changed ${restart.join(', ')}, which needs a new cloudflared — the running`);
    log('     portal applied the allowlist and hidden projects live but still routes the hostnames it started');
    log('     with. `claude-web-chat tunnel up` restarts it.');
  } else if (s.portal.running && s.portal.config_current === false) {
    log('  ⚠  the running portal does not enforce this tunnel.json yet (an older build, which reads it only at');
    log('     start, or an edit it has not picked up) — `claude-web-chat tunnel up` restarts it.');
  }
  if (s.portal.running && s.portal.token_current === false) {
    log('  ⚠  restart needed (connector token changed): cloudflared still runs on the token it started with.');
    log('     `claude-web-chat tunnel up` restarts it on the one in the file.');
  }
  if (s.cloudflared) {
    const c = s.cloudflared;
    const readiness = c.ready ? `ready${Number.isFinite(c.connections) ? ` (${c.connections} connection${c.connections === 1 ? '' : 's'})` : ''}` : 'not ready';
    log(`cloudflared: ${c.state}${c.pid ? ` — pid ${c.pid}` : ''} · ${readiness}${c.restarts ? ` · ${c.restarts} restart(s)` : ''}${c.error ? ` · last error: ${c.error}` : ''}`);
  }
  if (s.jwks) log(`access keys: last refreshed ${since(s.jwks.loaded_at)}${s.jwks.error ? ` · last error: ${s.jwks.error}` : ''}`);
  if (s.allowDestructive) log('remote wipe: ALLOWED (remote.allowDestructive) — an allowlisted account can wipe a project\'s graph');
  log(`picker: ${s.picker}`);
  if (!s.sessions.length) log('sessions: none exposed');
  else {
    log(`sessions (${s.sessions.length}):`);
    for (const x of s.sessions) log(`  ${x.id}  ${x.title}  →  ${x.url}`);
  }
  if (s.hidden.length) {
    log(`hidden (${s.hidden.length}):`);
    for (const x of s.hidden) log(`  ${x.id}  ${x.title}  —  ${HIDDEN_WHY[x.reason] || x.reason}`);
  }
}

// ── logs ────────────────────────────────────────────────────────────────────

async function logs(flags, { log, signal, pollMs = 500 }) {
  const paths = userPaths();
  const all = [['portal', paths.portalLog], ['cloudflared', paths.cloudflaredLog], ['access', paths.remoteAccessLog]];
  const picked = all.filter(([k]) => (!flags.portal && !flags.cloudflared && !flags.access) || flags[k]);
  const n = Number.parseInt(flags.lines || '40', 10) || 40;
  for (const [label, file] of picked) {
    const lines = tail(file, n);
    log(`── ${label} (${file})${lines.length ? '' : ' — empty'}`);
    for (const l of lines) log(l);
  }
  if (!flags.follow) return;
  const offsets = new Map(picked.map(([, f]) => { try { return [f, fs.statSync(f).size]; } catch { return [f, 0]; } }));
  await new Promise((resolve) => {
    const tick = () => {
      for (const [label, file] of picked) {
        let size = 0;
        try { size = fs.statSync(file).size; } catch { continue; }
        let from = offsets.get(file);
        if (size < from) from = 0; // truncated or rotated
        if (size === from) continue;
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(size - from);
          fs.readSync(fd, buf, 0, buf.length, from);
          for (const l of buf.toString('utf8').split('\n')) if (l) log(picked.length > 1 ? `[${label}] ${l}` : l);
        } finally { fs.closeSync(fd); }
        offsets.set(file, size);
      }
    };
    const iv = setInterval(tick, pollMs);
    const stop = () => { clearInterval(iv); tick(); resolve(); };
    if (signal) {
      if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    } else {
      process.once('SIGINT', stop);
    }
  });
}

// ── dispatch ────────────────────────────────────────────────────────────────

const USAGE = `usage: claude-web-chat tunnel <setup|up|down|status|logs>
  setup [--api-token-file <file> | --api-token <t>] [--hostname wc.example.com] [--style flat|nested]
        [--email you@example.com] [--signin pin+biometric|pin|google] [--name <tunnel>]
        [--account <id>] [--session 720h] [--mfa-session 720h] [--dry-run]
        [--google-client-id <id>] [--google-client-secret-file <file>]
                                    one token: setup creates the tunnel, DNS and Access app
  setup [--hostname wc.example.com] [--style flat|nested] [--team <team>] [--aud <tag>]
        [--email you@example.com] [--kind token|local] [--name <tunnel>]
        [--token-file <file>] [--credentials-file <file>] [--metrics-port <n>]
        [--skip-verify] [--yes|--no-input]
  up        start the portal + cloudflared (refuses an unsafe or incomplete setup)
  down      stop them
  status    [--json] config, portal, connector readiness, exposed sessions
  logs      [--follow] [--portal|--cloudflared|--access] [--lines <n>]
See \`claude-web-chat docs remote-access\`.`;

async function tunnel(args = [], opts = {}) {
  const log = opts.log || ((s) => console.log(s));
  const env = opts.env || process.env;
  const sub = args[0];
  const flags = parseFlags(args.slice(1));

  if (sub === 'setup') {
    const prompt = opts.prompt || createPrompt({ log, noInput: flags['no-input'] === true, yes: flags.yes === true });
    try {
      return await setup(flags, { log, prompt, fetchJwks: opts.fetchJwks, env });
    } finally {
      prompt.close();
    }
  }
  if (sub === 'up') return up(flags, { log, env, check: opts.checkBinary, waitMs: opts.waitMs, kill: opts.kill });
  if (sub === 'down') return down(flags, { log, env, waitMs: opts.waitMs, kill: opts.kill });
  if (sub === 'status') {
    const s = await collectStatus({ env });
    if (flags.json) log(JSON.stringify(s, null, 2));
    else printStatus(s, log);
    return s;
  }
  if (sub === 'logs') return logs(flags, { log, signal: opts.signal, pollMs: opts.pollMs });
  if (!sub || sub === 'help' || sub === '--help') { log(USAGE); return null; }
  fail(`unknown tunnel subcommand: ${sub}\n${USAGE}`);
}

module.exports = tunnel;
module.exports.parseFlags = parseFlags;
module.exports.collectStatus = collectStatus;
module.exports.restartPortal = restartPortal;
