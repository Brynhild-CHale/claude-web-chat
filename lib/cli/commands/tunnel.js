// `claude-web-chat tunnel <setup|up|down|status|logs>` — remote access to this
// machine's web-chat surfaces through a Cloudflare tunnel, behind Cloudflare
// Access (Google sign-in) AND the portal's own check of every Access token.
//
//   setup   ask for (or take as flags) the hostname, style, Access team, AUD
//           tag, the allowlisted Google account(s) and the tunnel; prove the
//           team's signing keys answer; write ~/.web-chat/tunnel/tunnel.json
//           (0600) and the connector token (0600); print the dashboard steps.
//   up      preflight everything that would make the tunnel unsafe or broken,
//           then start the portal detached (`portal run`), which supervises
//           cloudflared. Waits for the portal's /api/health. A running portal
//           from an older build, or one enforcing an older tunnel.json (it
//           reads the file once, at start), is restarted instead.
//   down    ask the portal to stop (SIGTERM to the pid its own /api/health
//           reported); cloudflared dies with it.
//   status  config, portal, connector readiness (cloudflared's loopback
//           `--metrics` /ready), last key-set refresh, exposed sessions and
//           the ones hidden (expose.exclude, a project's no-remote marker).
//   logs    the portal and cloudflared logs and the remote access log;
//           --follow keeps printing.
//
// Everything that decides what a valid config is lives in lib/tunnel (shared by
// this command, the portal and doctor) — nothing here re-derives it.

const fs = require('fs');
const path = require('path');
const { userPaths } = require('../../core/paths');
const { readJson, writeJsonAtomic, renameAside } = require('../../core/fsjson');
const { isLoopbackBind } = require('../../core/cors');
const { ago } = require('../../core/mcp-seen');
const client = require('../../client');
const { isPortalCurrent, PORTAL_PROTOCOL_VERSION } = require('../../core/versions');
const { readInstances } = require('../../util/registry');
const { spawnDetached } = require('../../util/daemon');
const { createPrompt } = require('../prompt');
const {
  normalizeConfig, loadConfig, configFingerprint, sessionHost, publicOrigin, portalPort, hiddenReason, STYLES, KINDS,
} = require('../../tunnel/config');
const { defaultFetchJwks, parseJwks } = require('../../tunnel/jwks');
const { checkBinary, readToken, probeReady, isStrayConnector } = require('../../tunnel/cloudflared');

const BOOLEAN_FLAGS = new Set(['yes', 'no-input', 'skip-verify', 'follow', 'json', 'portal', 'cloudflared', 'access']);

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

function dashboardSteps(config, { port }) {
  const flatParent = config.hostname.split('.').slice(1).join('.');
  const sessionsDns = config.style === 'nested' ? `*.${config.hostname}` : `*.${flatParent}`;
  const sessionsAccess = config.style === 'nested' ? `*.${config.hostname}` : `${config.hostname.split('.')[0]}-*.${flatParent}`;
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
    'Then: claude-web-chat tunnel up   (a portal already running is restarted, so it enforces this file)',
  );
  if (config.style === 'nested') {
    lines.push('', `Nested hostnames need a certificate for *.${config.hostname} (Advanced Certificate Manager) —`,
      'the free Universal SSL certificate covers one level of subdomain only.');
  }
  return lines;
}

async function setup(flags, { log, prompt, fetchJwks = defaultFetchJwks }) {
  const paths = userPaths();
  const existingRead = readJson(paths.tunnelConfig);
  // Only an ABSENT file starts from nothing. One that is there but cannot be
  // read (a JSON typo, usually from hand-editing expose.exclude — the one
  // section only a hand edit sets) is never silently replaced: it is moved
  // aside, kept and named just before the new one is written, so nothing it
  // held is lost without a word (and a setup that fails first leaves it be).
  const unreadable = !existingRead.absent
    && !(existingRead.ok && existingRead.value && typeof existingRead.value === 'object' && !Array.isArray(existingRead.value));
  const existing = unreadable || existingRead.absent ? {} : existingRead.value;
  const ex = (o, k) => (o && typeof o === 'object' ? o[k] : undefined);

  async function ask(question, def) {
    const a = await prompt.line(`${question}${def ? ` [${def}]` : ''}:`);
    return a || def || '';
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

  fs.mkdirSync(paths.tunnelDir, { recursive: true, mode: 0o700 });
  if (unreadable) {
    const why = existingRead.error ? existingRead.error.message : 'not a JSON object';
    const aside = renameAside(paths.tunnelConfig);
    log(`  ✗ the existing ${paths.tunnelConfig} could not be read (${why}).`);
    log(`    Moved aside, untouched, to ${aside}.`);
    log('    Nothing in it was carried over — expose.exclude, allow.domains, showRoots, remote.allowDestructive');
    log('    and tunnel.credentialsFile are back to their defaults. Copy back what you need from that file.');
  }
  const { tunnel: t, ...rest } = config;
  writeJsonAtomic(paths.tunnelConfig, { ...rest, tunnel: Object.fromEntries(Object.entries(t).filter(([, v]) => v != null)) }, { newline: true });
  fs.chmodSync(paths.tunnelConfig, 0o600);
  if (token) {
    fs.writeFileSync(paths.tunnelToken, `${token}\n`, { mode: 0o600 });
    fs.chmodSync(paths.tunnelToken, 0o600);
  }
  log(`  ✓ wrote ${paths.tunnelConfig} (0600)`);
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

// ── up / down ───────────────────────────────────────────────────────────────

// Every reason not to start, as a userFacing throw. Returns what `up` needs.
function preflight({ env, check = checkBinary }) {
  const config = loadConfig();
  if (!config.tunnel) fail('tunnel.json names no tunnel — run `claude-web-chat tunnel setup` (a NAMED tunnel; quick tunnels cannot sit behind Access)');
  const host = env.WEB_CHAT_HOST;
  if (host && !isLoopbackBind(host)) {
    fail(`WEB_CHAT_HOST=${host} — your daemons are listening on the network with no authentication, so a tunnel in front of them would guard one door of an open house. Unset WEB_CHAT_HOST (loopback only) first.`);
  }
  const bin = check({ env });
  if (!bin.ok) fail(`${bin.error} — ${bin.hint}`);
  if (config.tunnel.kind === 'token' && !readToken()) {
    fail(`no connector token in ${userPaths().tunnelToken} — run \`claude-web-chat tunnel setup\` (or --token-file <file>)`);
  }
  if (config.tunnel.credentialsFile && !fs.existsSync(config.tunnel.credentialsFile)) {
    fail(`tunnel.credentialsFile ${config.tunnel.credentialsFile} does not exist — \`cloudflared tunnel create ${config.tunnel.name}\` writes it`);
  }
  return { config, bin };
}

async function waitFor(pred, maxMs, interval = 100) {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const v = await pred();
    if (v || Date.now() >= deadline) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
}

function tail(file, n) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n);
}

async function up(flags, { log, env, check, waitMs = 8000, kill }) {
  const { config, bin } = preflight({ env, check });
  const port = portalPort(env);
  const picker = `${publicOrigin(config.hostname)}/`;
  let current = await client.probeHealth(port);
  // A portal from an older build is still enforcing that build's rules (see
  // PORTAL_PROTOCOL_VERSION): stop it and start this one, rather than report
  // "already up" over it.
  if (current && current.role === 'portal' && !isPortalCurrent(current)) {
    log(`restarting an older portal (pid ${current.pid}, protocol ${current.portal_protocol || 1} → ${PORTAL_PROTOCOL_VERSION})`);
    await down({}, { log: () => {}, env, waitMs, kill });
    current = null;
  } else if (current && current.role === 'portal' && current.config_fp !== configFingerprint(config)) {
    // The portal read tunnel.json once, at start: an allowlist or exclude
    // edited since is not in force until it is restarted.
    log(`restarting the portal (pid ${current.pid}): ${userPaths().tunnelConfig} changed since it started`);
    await down({}, { log: () => {}, env, waitMs, kill });
    current = null;
  }
  if (current && current.role === 'portal') {
    log(`tunnel already up — portal pid ${current.pid} on 127.0.0.1:${port}`);
    log(`picker: ${picker}`);
    return { already: true, health: current };
  }
  if (current) fail(`port ${port} is answering but it is not the portal (role ${current.role || 'unknown'}) — set WEB_CHAT_PORTAL_PORT and route the tunnel there`);

  // No portal, yet cloudflared's metrics port answers: a connector outlived
  // the portal that ran it (killed outright). One the portal recorded is
  // stopped by the new portal as it starts (lib/tunnel/cloudflared
  // reapStale); anything else is not ours to signal, so say what to do.
  const metrics = config.tunnel.metricsPort;
  const occupant = await probeReady(metrics);
  if (occupant.ready || occupant.status != null) {
    const rec = readJson(userPaths().cloudflaredPid);
    if (!(rec.ok && isStrayConnector(rec.value))) {
      fail(`something already answers on cloudflared's metrics port 127.0.0.1:${metrics} with no portal running — `
        + 'most likely a connector left behind by a portal that was killed. Find it (`ps -ax | grep cloudflared`), stop it, '
        + 'and run `claude-web-chat tunnel up` again (or give tunnel.metricsPort another port)');
    }
    log(`stopping a cloudflared left running by a portal that is gone (pid ${rec.value.pid}) before starting`);
  }

  spawnDetached({ args: ['portal', 'run'], log: userPaths().portalLog, env });
  const health = await waitFor(async () => {
    const h = await client.probeHealth(port);
    return h && h.role === 'portal' ? h : null;
  }, waitMs);
  if (!health) {
    const last = tail(userPaths().portalLog, 8).map((l) => `    ${l}`).join('\n');
    fail(`the portal did not come up on 127.0.0.1:${port} — see ${userPaths().portalLog}${last ? `:\n${last}` : ''}`);
  }
  log(`✓ portal up — pid ${health.pid} on 127.0.0.1:${port} (cloudflared ${bin.version}, ${config.tunnel.kind} tunnel${config.tunnel.name ? ` "${config.tunnel.name}"` : ''})`);
  log(`  picker: ${picker}`);
  log('  `claude-web-chat tunnel status` shows when the connector is ready; `tunnel down` stops both.');
  return { already: false, health };
}

async function down(flags, { log, env, waitMs = 5000, kill = (pid, sig) => process.kill(pid, sig) }) {
  const port = portalPort(env);
  const health = await client.probeHealth(port);
  if (!health || health.role !== 'portal') { log('tunnel is not up'); return { stopped: false }; }
  // The pid the live portal just reported on /api/health — the same identity
  // gate the hub bounce uses — never one read out of a file.
  try { kill(health.pid, 'SIGTERM'); } catch (e) { fail(`could not signal the portal (pid ${health.pid}): ${e.code || e.message}`); }
  const gone = await waitFor(async () => {
    const h = await client.probeHealth(port);
    return !(h && h.role === 'portal');
  }, waitMs);
  if (!gone) fail(`the portal (pid ${health.pid}) is still answering on 127.0.0.1:${port}`);
  const cf = health.cloudflared && health.cloudflared.pid ? `; cloudflared (pid ${health.cloudflared.pid}) stopped with it` : '';
  log(`✓ tunnel down — portal pid ${health.pid} stopped${cf}`);
  return { stopped: true, health };
}

// ── status ──────────────────────────────────────────────────────────────────

async function collectStatus({ env }) {
  const out = { configured: false, error: null, portal: { running: false }, cloudflared: null, sessions: [], hidden: [] };
  let config = null;
  try { config = loadConfig(); out.configured = true; } catch (e) { out.error = e.message; }
  const port = portalPort(env);
  const health = await client.probeHealth(port);
  const running = !!(health && health.role === 'portal');
  out.portal = running
    ? { running: true, pid: health.pid, port, started_at: health.started_at || null }
    : { running: false, port };
  // Does the running portal enforce the file as it is NOW? (It reads it once.)
  // Everything below is the file's view, so a stale portal must be said aloud.
  if (running && config) out.portal.config_current = health.config_fp === configFingerprint(config);
  if (config) {
    out.hostname = config.hostname;
    out.style = config.style;
    out.picker = `${publicOrigin(config.hostname)}/`;
    out.allowlist = { emails: config.allow.emails.length, domains: config.allow.domains.length };
    out.tunnel = config.tunnel;
    if (config.tunnel) {
      const ready = await probeReady(config.tunnel.metricsPort);
      out.cloudflared = { ...(running && health.cloudflared ? health.cloudflared : { state: running ? 'unsupervised' : 'stopped', pid: null }), ...ready };
    }
    out.allowDestructive = config.remote.allowDestructive;
    // The same test the portal applies (lib/tunnel/config hiddenReason), so
    // what this lists as exposed is exactly what a remote viewer can open.
    for (const e of readInstances()) {
      const title = path.basename(String(e.root || e.title || e.id));
      const reason = hiddenReason(config, e);
      if (reason) out.hidden.push({ id: e.id, title, reason });
      else out.sessions.push({ id: e.id, title, port: e.port, url: `${publicOrigin(sessionHost(config, e.id))}/` });
    }
  }
  if (running && health.jwks) out.jwks = health.jwks;
  return out;
}

const HIDDEN_WHY = {
  excluded: 'expose.exclude in tunnel.json',
  'no-remote': 'the project\'s .web-chat/no-remote marker',
};

function printStatus(s, log) {
  if (!s.configured) {
    log(`tunnel: not configured — ${s.error}`);
    if (s.portal.running) log(`portal: running (pid ${s.portal.pid}) on 127.0.0.1:${s.portal.port}`);
    return;
  }
  log(`tunnel: ${s.hostname} (${s.style})${s.tunnel ? ` · ${s.tunnel.kind} tunnel${s.tunnel.name ? ` "${s.tunnel.name}"` : ''}` : ' · no tunnel configured'}`);
  log(`allowlist: ${s.allowlist.emails} email(s)${s.allowlist.domains ? ` + ${s.allowlist.domains} domain(s)` : ''}`);
  log(s.portal.running
    ? `portal: running — pid ${s.portal.pid} on 127.0.0.1:${s.portal.port}, up since ${new Date(s.portal.started_at).toISOString()}`
    : `portal: not running (would use 127.0.0.1:${s.portal.port}) — \`claude-web-chat tunnel up\``);
  if (s.portal.running && s.portal.config_current === false) {
    log('  ⚠  the running portal still enforces the tunnel.json it started with — the allowlist and hidden');
    log('     projects below are the file\'s, not yet in force. `claude-web-chat tunnel up` restarts it.');
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
      return await setup(flags, { log, prompt, fetchJwks: opts.fetchJwks });
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
