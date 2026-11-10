// The connector's versions record and machine facts (tranche 6, U725; PLAN-T6
// 6A.3): what the connector tells the hub about its own build, each daemon's
// build and the machine it runs on.
//
//   versionsRecord({ claudeVersion, daemons, describe }) → 12's `versions`
//     (contract 12 C-12.12, 12-compat.json $defs/versions; 06 C-06.10): this
//     tree's packageVersion(), describeInstall's {kind, link_mismatch}, the
//     connector protocol range [CONNECTOR_PROTOCOL_MIN, CONNECTOR_PROTOCOL_VERSION],
//     PORTAL_PROTOCOL_VERSION as policy_protocol, SCHEMA_VERSION — all from
//     lib/core/versions, none changed here — Node, platform, arch, the Claude
//     Code version (or null) and, optionally, the daemons already running.
//   readClaudeVersion({ runClaude }) → Promise<string | null>
//     `claude --version` through lib/core/claude-cli runClaudeAsync (the
//     asynchronous runner: the connector is a long-lived process), read with
//     registration's claudeVersionOf (probeMod's reading); null when there is
//     no claude, it fails or prints no version.
//   daemonVersions(chat, health, now) → 12's `daemon_versions`, from a HOST
//     read of that daemon's /api/health the caller made (06 C-06.28):
//     package_version, version as instance_protocol, boot, observed_at and
//     catalogue.sha256 once health reports it. Never a pid or a port (05
//     C-05.50). null when the health body cannot make a valid record.
//   machineFacts({ record, settings, tailnetName, names }) → the machine.facts
//     body (05 C-05.18 as A-05.2 replaces it; amendments/05-2's schema), the
//     frame's ch/kind/id/seq the link's: hostname, login, tailnet_name, the
//     record's OFFERED folders whole (06's folder objects, the only paths the
//     hub learns, 11 C-11.6), the settings in force, the machine's ceiling,
//     and the MCP server and skill names (names only).
//   tailnetName({ exec, pathEnv, platform }) → Promise<string | null>
//     `tailscale status --json` through ./exec (never a shell, a 3 s timeout):
//     Self.DNSName without one trailing dot, lowercase, kept only when it fits
//     05-machine-facts' tailnet_name pattern. `tailscale` is looked for on
//     `pathEnv` (the PATH captured at install, the record's service.path_env,
//     06 C-06.6), then — on macOS — at the app's CLI. null when none is found,
//     the command fails or times out, or the name is empty or invalid.
//   createFacts(opts) → { start, versions, facts, refresh, install }
//     The running connector's holder: start() reads the Claude Code version,
//     the tool names and the tailnet name once; versions() answers the
//     memoised record (re-read when the install changes); facts() builds
//     machine.facts from the record as it stands now and remembers what it
//     handed out; install(ctx) (CONNECTOR@install-seam; U790 wires it) sets
//     ctx.facts and ctx.versions for the link, and on the link's 'ready'
//     (every hello.ack) and every REFRESH_MS re-reads the tailnet name and the
//     names and calls ctx.link.factsChanged() when the facts now differ from
//     what was last handed out.
//
// WHAT NEVER LEAVES. No folder the record does not offer and no path outside
// an offered folder (11 C-11.6); nothing read from a chat's .web-chat/, a
// transcript or a working tree (C-11.4); no MCP server's command, args or
// env, no skill's content or path — the names come from
// lib/setup/registration claudeToolNames, the one reader of Claude Code's
// config file. Nothing here writes anything.

const os = require('os');
const versions = require('../core/versions');
const { runClaudeAsync } = require('../core/claude-cli');
const { stableKey } = require('../core/stable-json');
const { describeInstall } = require('../update/install-layout');
const { claudeToolNames, claudeVersionOf, TOOL_NAME_RE, TOOL_NAMES_MAX } = require('../setup/registration');
const setup = require('../setup/connector');
const execMod = require('./exec');

const CLAUDE_VERSION_TIMEOUT_MS = 10000;
const TAILSCALE_TIMEOUT_MS = 3000;
// `status --json` lists every peer of the tailnet; a large one is still far
// below this.
const TAILSCALE_MAX_BYTES = 8 * 1024 * 1024;
const TAILSCALE = 'tailscale';
const TAILSCALE_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const REFRESH_MS = 5 * 60 * 1000;

// The locked schemas' grammars (12-compat.json, amendments/05-2/schemas/05-machine-facts.json).
const PACKAGE_VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.+-]{1,48})?$/;
const NODE_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const CHAT_ID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TAILNET_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const INSTALL_KINDS = ['managed', 'dev', 'unmanaged'];
const FOLDER_KEYS = ['id', 'path', 'display', 'label', 'access', 'offered_at'];
const SETTINGS_KEYS = ['agents_at_once', 'local_cap', 'accept_new_chats', 'let_home_start_agents', 'paused', 'rev'];
const FOLDERS_MAX = 256;
const DAEMONS_MAX = 256;

const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// ── the versions record (12 C-12.12) ────────────────────────────────────────

// describeInstall's answer as 12-compat's install def.
function installOf(describe = describeInstall) {
  let d = null;
  try { d = describe(); } catch { d = null; }
  return {
    kind: d && INSTALL_KINDS.includes(d.kind) ? d.kind : 'unmanaged',
    link_mismatch: Boolean(d && d.linkMismatch),
  };
}

function versionsRecord({ claudeVersion = null, daemons, describe = describeInstall } = {}) {
  const cc = typeof claudeVersion === 'string' && PACKAGE_VERSION_RE.test(claudeVersion) ? claudeVersion : null;
  const out = {
    kind: 'versions',
    package_version: versions.packageVersion(),
    install: installOf(describe),
    protocol: { min: versions.CONNECTOR_PROTOCOL_MIN, max: versions.CONNECTOR_PROTOCOL_VERSION },
    policy_protocol: versions.PORTAL_PROTOCOL_VERSION,
    schema_version: versions.SCHEMA_VERSION,
    node: process.versions.node,
    platform: process.platform,
    arch: String(process.arch).slice(0, 16),
    claude_code_version: cc,
  };
  const rows = Array.isArray(daemons) ? daemons.filter(isPlain).slice(0, DAEMONS_MAX) : [];
  if (rows.length) out.daemons = rows;
  return out;
}

async function readClaudeVersion({ runClaude = runClaudeAsync, timeoutMs = CLAUDE_VERSION_TIMEOUT_MS } = {}) {
  let r;
  try { r = await runClaude(['--version'], { timeoutMs }); } catch { return null; }
  if (!r || r.ok !== true) return null;
  const v = claudeVersionOf(r.stdout);
  return v && PACKAGE_VERSION_RE.test(v) ? v : null;
}

// ── one daemon's versions (12 C-12.12, from a host health read) ────────────

function daemonVersions(chat, health, now = Date.now()) {
  if (typeof chat !== 'string' || !CHAT_ID_RE.test(chat) || !isPlain(health)) return null;
  const pkg = health.package_version;
  const proto = health.version;
  const boot = health.boot;
  if (typeof pkg !== 'string' || !PACKAGE_VERSION_RE.test(pkg)) return null;
  if (!Number.isSafeInteger(proto) || proto < 1) return null;
  if (typeof boot !== 'string' || boot.length < 1 || boot.length > 64) return null;
  const at = new Date(now);
  if (Number.isNaN(at.getTime())) return null;
  const out = {
    kind: 'daemon_versions',
    chat,
    package_version: pkg,
    instance_protocol: proto,
    boot,
    observed_at: at.toISOString(),
  };
  const sha = isPlain(health.catalogue) ? health.catalogue.sha256 : undefined;
  if (typeof sha === 'string' && SHA256_RE.test(sha)) out.catalogue_sha256 = sha;
  return out;
}

// ── machine facts (05 C-05.18 as A-05.2 replaces it) ────────────────────────

function loginName() {
  try {
    const name = os.userInfo().username;
    return typeof name === 'string' && name.length >= 1 && name.length <= 256 ? name : null;
  } catch {
    return null;
  }
}

function hostName() {
  try { return String(os.hostname()).slice(0, 253); } catch { return ''; }
}

function validTailnetName(v) {
  return typeof v === 'string' && v.length <= 253 && TAILNET_NAME_RE.test(v) ? v : null;
}

// The record's offered folders, each as 06's folder object and nothing more.
function offeredFolders(record) {
  const list = isPlain(record) && Array.isArray(record.folders) ? record.folders : [];
  const out = [];
  for (const f of list) {
    if (!isPlain(f) || typeof f.id !== 'string' || typeof f.path !== 'string' || typeof f.display !== 'string') continue;
    const o = {};
    for (const k of FOLDER_KEYS) if (f[k] !== undefined) o[k] = f[k];
    out.push(o);
    if (out.length >= FOLDERS_MAX) break;
  }
  return out;
}

// The settings in force: the hub's last machine.settings as the record keeps
// them (the local cap beside them, C-06.23), defaults where a key is missing.
function settingsInForce(s) {
  const merged = { ...setup.SETTINGS_DEFAULTS, ...(isPlain(s) ? s : {}) };
  const out = {};
  for (const k of SETTINGS_KEYS) if (merged[k] !== undefined) out[k] = merged[k];
  return out;
}

// The machine's ceiling (C-06.23a): absent means full; anything but full reads
// as the lower one.
function ceilingFor(record) {
  if (!isPlain(record) || !Object.prototype.hasOwnProperty.call(record, 'ceiling')) return 'full';
  return record.ceiling === 'full' ? 'full' : 'read';
}

function nameList(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((n) => typeof n === 'string' && TOOL_NAME_RE.test(n)))].sort().slice(0, TOOL_NAMES_MAX);
}

function machineFacts({
  record, settings, tailnetName: tailnet = null, names, hostname = hostName(), login = loginName(),
} = {}) {
  const n = isPlain(names) ? names : {};
  return {
    hostname: String(hostname == null ? '' : hostname).slice(0, 253),
    login: typeof login === 'string' && login.length >= 1 && login.length <= 256 ? login : null,
    tailnet_name: validTailnetName(tailnet),
    folders: offeredFolders(record),
    settings: settingsInForce(settings !== undefined ? settings : (isPlain(record) ? record.settings : undefined)),
    ceiling: ceilingFor(record),
    mcp_servers: nameList(n.mcp_servers),
    skills: nameList(n.skills),
  };
}

// ── the tailnet name (A-05.2) ───────────────────────────────────────────────

async function tailnetName({
  exec = execMod, pathEnv = process.env.PATH, platform = process.platform, timeoutMs = TAILSCALE_TIMEOUT_MS,
} = {}) {
  try {
    let bin = exec.findProgram(TAILSCALE, typeof pathEnv === 'string' ? pathEnv : '');
    if (!bin && platform === 'darwin' && typeof exec.isExecutable === 'function' && exec.isExecutable(TAILSCALE_APP)) {
      bin = TAILSCALE_APP;
    }
    if (!bin) return null;
    const r = await exec.run(bin, ['status', '--json'], { timeoutMs, maxBytes: TAILSCALE_MAX_BYTES });
    if (!r || r.ok !== true) return null;
    const status = JSON.parse(String(r.stdout || ''));
    const dns = isPlain(status) && isPlain(status.Self) ? status.Self.DNSName : null;
    if (typeof dns !== 'string' || !dns) return null;
    return validTailnetName((dns.endsWith('.') ? dns.slice(0, -1) : dns).toLowerCase());
  } catch {
    return null;
  }
}

// ── the running connector's holder (CONNECTOR@install-seam) ─────────────────

function pickRecord(hubId, readRecord, listRecords) {
  if (hubId != null) {
    const r = readRecord(hubId);
    return r && r.ok ? r.value : null;
  }
  const ok = (listRecords() || []).filter((e) => e && e.read && e.read.ok);
  return ok.length === 1 ? ok[0].read.value : null;
}

function createFacts({
  hubId,
  exec = execMod,
  runClaude = runClaudeAsync,
  describe = describeInstall,
  toolNames = claudeToolNames,
  readRecord = setup.readRecord,
  listRecords = setup.listRecords,
  platform = process.platform,
  pathEnv,
  refreshMs = REFRESH_MS,
  timers = { setInterval, clearInterval },
} = {}) {
  let record = null;          // the last record read whole
  let claudeVersion = null;
  let memo = null;            // the versions record
  let installKey = null;      // what the memo was built for
  let tailnet = null;
  let names = { mcp_servers: [], skills: [] };
  let sentKey = null;         // the facts last handed out

  const readNow = () => {
    let r = null;
    try { r = pickRecord(hubId, readRecord, listRecords); } catch { r = null; }
    if (r) record = r; // a torn or missing read keeps the last good one
    return record;
  };
  const pathFor = () => {
    if (typeof pathEnv === 'string') return pathEnv;
    const svc = isPlain(record) && isPlain(record.service) ? record.service : null;
    return svc && typeof svc.path_env === 'string' && svc.path_env ? svc.path_env : process.env.PATH;
  };
  const readNames = () => {
    try { names = toolNames(); } catch { /* keep the last */ }
  };
  const readTailnet = async () => {
    tailnet = await tailnetName({ exec, pathEnv: pathFor(), platform });
  };
  const keyOfInstall = () => stableKey({ install: installOf(describe), pkg: versions.packageVersion() });

  async function rebuildVersions() {
    claudeVersion = await readClaudeVersion({ runClaude });
    installKey = keyOfInstall();
    memo = versionsRecord({ claudeVersion, describe });
    return memo;
  }

  async function start() {
    readNow();
    readNames();
    await Promise.all([rebuildVersions(), readTailnet()]);
    return api;
  }

  function versionsNow() {
    if (!memo) memo = versionsRecord({ claudeVersion, describe });
    return { ...memo, install: { ...memo.install }, protocol: { ...memo.protocol } };
  }

  function build() {
    return machineFacts({ record: readNow(), tailnetName: tailnet, names });
  }

  function facts() {
    const body = build();
    sentKey = stableKey(body);
    return body;
  }

  // Re-read the tailnet name and the names (and the versions, when the install
  // changed); true when the facts now differ from what was last handed out.
  async function refresh() {
    readNames();
    const work = [readTailnet()];
    if (installKey !== null && keyOfInstall() !== installKey) work.push(rebuildVersions());
    await Promise.all(work);
    return sentKey === null || stableKey(build()) !== sentKey;
  }

  function install(ctx) {
    if (!ctx || typeof ctx !== 'object') throw new TypeError('install: a context object is required');
    if (ctx.facts && ctx.facts !== facts) throw new Error('install: machine facts are already installed');
    ctx.facts = facts;
    if (!ctx.versions) ctx.versions = versionsNow;
    let stopped = false;
    const tell = () => {
      if (stopped) return Promise.resolve(false);
      return refresh().then((changed) => {
        const link = ctx.link;
        if (changed && !stopped && link && typeof link.factsChanged === 'function') {
          try { link.factsChanged(); } catch { /* the link's own failure */ }
        }
        return changed;
      }, () => false);
    };
    const link = ctx.link;
    const onReady = () => { tell(); };
    if (link && typeof link.on === 'function') link.on('ready', onReady);
    const timer = timers.setInterval(() => { tell(); }, refreshMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    const stop = () => {
      stopped = true;
      timers.clearInterval(timer);
      if (link && typeof link.off === 'function') link.off('ready', onReady);
      else if (link && typeof link.removeListener === 'function') link.removeListener('ready', onReady);
      if (ctx.facts === facts) delete ctx.facts;
      if (ctx.versions === versionsNow) delete ctx.versions;
    };
    stop.tick = tell;
    return stop;
  }

  const api = { start, versions: versionsNow, facts, refresh, install };
  return api;
}

// The module's own install(ctx, opts): a holder made for this context (or the
// one the wiring already made, ctx.factsHolder), installed, and started in the
// background — when the start settles, one refresh tells the link if the
// facts it may already have sent were built before the first reads finished.
function install(ctx, opts = {}) {
  if (!ctx || typeof ctx !== 'object') throw new TypeError('install: a context object is required');
  const holder = ctx.factsHolder || createFacts(opts);
  const stop = holder.install(ctx);
  holder.start().then(() => stop.tick(), () => {});
  stop.holder = holder;
  return stop;
}

module.exports = {
  install,
  versionsRecord,
  readClaudeVersion,
  daemonVersions,
  machineFacts,
  tailnetName,
  createFacts,
  installOf,
  settingsInForce,
  REFRESH_MS,
  TAILSCALE_TIMEOUT_MS,
  TAILSCALE_APP,
};
