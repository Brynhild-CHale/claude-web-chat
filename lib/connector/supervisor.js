// The connector's supervisor, its spawn half (contract 06 C-06.19; 03 C-03.22;
// 10 C-10.5): bring a chat's daemon up, adopting before spawning, and know
// which daemons are the connector's own.
//
//   * ADOPT FIRST. A live daemon of the chat's root (lib/util/registry
//     daemonFor: the portfile, else the registry entry, each accepted only once
//     it answers as its pid and this root) is adopted, never doubled. An
//     adopted daemon was handed no relay secret, so it is `started_by: other`
//     and the connector relays to it without X-WC-Relay and X-WC-Actor (0.9's
//     rule serves those requests) until U719's idle restart makes it ours.
//   * SPAWN WITH THE SECRET. Otherwise the supervisor mints a fresh relay
//     secret (32 random bytes, 64 hex characters, held in this process's memory
//     only) and calls lib/util/daemon spawnDaemon with it: spawnDaemon puts it on
//     the child's fd 3 and names the fd (WEB_CHAT_RELAY_SECRET_FD=3); the
//     supervisor adds WEB_CHAT_CONNECTOR_RECORD, the record's absolute path (a
//     path, not a secret; C-06.23a). Nothing else changes in the child's
//     environment, and no port is named or set (WEB_CHAT_PORT included: an
//     inherited one is removed, 10 C-10.5).
//   * CONFIRM IDENTITY. The record spawnDaemon verified is asked once more
//     with the strict rule (answersFor, strictInstance: the daemon must NAME
//     this root's instance id); a no is `failed`, `identity-mismatch`.
//   * THE PID COMPARE (wc-13 O1). `started_by: connector` only when the
//     verified daemon's pid is the pid of the child this call spawned: a racing
//     spawn (the MCP auto-spawn, a user's `open`) can win the bind, and its
//     daemon holds no secret of ours. Any other answer is `other` and the
//     secret is dropped.
//   * RATE-LIMITED per chat as lib/portal/start.js limits a start: one spawn
//     attempt per START_EVERY_MS, counted from the attempt (a failed one spent
//     it); a daemon that does not answer within START_WAIT_MS is `failed`,
//     `daemon-timeout`. Both constants live in lib/relay (never lib/portal: an
//     entry point never requires another).
//
// THE SECRET is never written to disk, a log line, an argv, a record or a
// frame, and never its hash either: the log names a chat id, a pid, a port and
// started_by, and nothing else. A connector restart holds no secret, so every
// daemon it finds is adopted as `other` until the idle restart (C-06.12).
//
// install(ctx) is the CONNECTOR@install-seam hook (lib/connector/run.js's
// wiring calls it); the supervisor has no link handler of its own.

const path = require('path');
const crypto = require('crypto');
const registry = require('../util/registry');
const daemon = require('../util/daemon');
const { userPaths, isSafeId } = require('../core/paths');
const { START_EVERY_MS, START_WAIT_MS } = require('../relay');

const SECRET_BYTES = 32;
const STARTED_BY = Object.freeze({ CONNECTOR: 'connector', OTHER: 'other' });

// A chat id as a log line may name it; anything else is logged as '?'.
function logId(id) {
  return isSafeId(id) ? id : '?';
}

function chatOf(chat) {
  const id = chat && (chat.id != null ? chat.id : chat.chat_id);
  const root = chat && chat.root;
  if (typeof id !== 'string' || !id) throw new TypeError('ensureRunning: a chat needs an id');
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('ensureRunning: a chat needs an absolute root');
  return { id, root };
}

// The child's environment beside the secret's fd (which spawnDaemon names):
// this process's, plus the record's path, minus WEB_CHAT_PORT.
function childEnv(base, recordPath) {
  const env = { ...base, WEB_CHAT_CONNECTOR_RECORD: recordPath };
  delete env.WEB_CHAT_PORT;
  return env;
}

function createSupervisor({ hubId, recordPath, log = () => {}, deps = {} } = {}) {
  const d = {
    spawnDaemon: daemon.spawnDaemon,
    daemonFor: registry.daemonFor,
    answersFor: registry.answersFor,
    instanceId: registry.instanceId,
    randomBytes: crypto.randomBytes,
    now: Date.now,
    env: process.env,
    ...deps,
  };
  const record = recordPath || (hubId ? userPaths().connectorRecord(hubId) : null);
  if (typeof record !== 'string' || !path.isAbsolute(record)) {
    throw new TypeError('createSupervisor: the connector record needs an absolute path (recordPath, or a hub id)');
  }
  const say = (line) => { try { log(line); } catch {} };

  // chat id -> { root, lastAttempt, startedBy, pid, port, childPid, secret }
  const chats = new Map();
  const stateFor = (id) => {
    let st = chats.get(id);
    if (!st) {
      st = { root: null, lastAttempt: null, startedBy: null, pid: null, port: null, childPid: null, secret: null };
      chats.set(id, st);
    }
    return st;
  };
  const drop = (st) => {
    st.secret = null;
    st.startedBy = null;
    st.childPid = null;
    st.pid = null;
    st.port = null;
  };

  const failed = (id, st, reason) => {
    drop(st);
    say(`chat ${logId(id)} start failed: ${reason}`);
    return { state: 'failed', reason };
  };

  const running = (id, st, rec, startedBy) => {
    st.startedBy = startedBy;
    st.pid = rec.pid;
    st.port = rec.port;
    if (startedBy !== STARTED_BY.CONNECTOR) { st.secret = null; st.childPid = null; }
    say(`chat ${logId(id)} daemon pid ${rec.pid} port ${rec.port} started_by ${startedBy}`);
    return { state: 'running', port: rec.port, pid: rec.pid, started_by: startedBy };
  };

  // C-06.4 step 6 with the strict rule: the daemon must name this root's id.
  async function confirmed(rec, root) {
    try {
      return Boolean(await d.answersFor(rec, d.instanceId(root), { strictInstance: true }));
    } catch {
      return false;
    }
  }

  async function ensureRunning(chat) {
    const { id, root } = chatOf(chat);
    const st = stateFor(id);
    if (st.root !== root) { drop(st); st.root = root; }

    // Adopt first. Our own daemon, still the pid we spawned, stays ours.
    let live = null;
    try { live = await d.daemonFor(root); } catch { live = null; }
    if (live) {
      if (!(await confirmed(live, root))) return failed(id, st, 'identity-mismatch');
      const ours = st.startedBy === STARTED_BY.CONNECTOR && st.secret != null
        && st.childPid != null && live.pid === st.childPid;
      return running(id, st, live, ours ? STARTED_BY.CONNECTOR : STARTED_BY.OTHER);
    }

    // Nothing live: a spawn, at most one per START_EVERY_MS per chat. No await
    // between this check and the stamp, so two concurrent calls spawn once.
    const t = d.now();
    if (st.lastAttempt != null && t - st.lastAttempt < START_EVERY_MS) {
      return { state: 'starting', retry_in_ms: START_EVERY_MS - (t - st.lastAttempt) };
    }
    st.lastAttempt = t;
    drop(st);

    let secret = d.randomBytes(SECRET_BYTES).toString('hex');
    let rec = null;
    try {
      rec = await d.spawnDaemon(root, { maxMs: START_WAIT_MS, secret, env: childEnv(d.env, record) });
    } catch {
      secret = null;
      return failed(id, st, 'other');
    }
    if (!rec) { secret = null; return failed(id, st, 'daemon-timeout'); }
    if (!(await confirmed(rec, root))) { secret = null; return failed(id, st, 'identity-mismatch'); }
    if (rec.child_pid != null && rec.pid === rec.child_pid) {
      st.secret = secret;
      st.childPid = rec.child_pid;
      return running(id, st, rec, STARTED_BY.CONNECTOR);
    }
    // A racing spawn won the bind: its daemon holds no secret of ours.
    secret = null;
    return running(id, st, rec, STARTED_BY.OTHER);
  }

  // The relay secret for a chat's daemon — only while that daemon is the
  // connector's own spawn and the last verified pid is the child it started;
  // otherwise null, and the request is relayed without X-WC-Relay/X-WC-Actor.
  function relayCredential(chatId) {
    const st = chats.get(chatId);
    if (!st || st.startedBy !== STARTED_BY.CONNECTOR || st.secret == null) return null;
    if (st.childPid == null || st.pid !== st.childPid) return null;
    return st.secret;
  }

  function startedBy(chatId) {
    const st = chats.get(chatId);
    return (st && st.startedBy) || null;
  }

  // Drop what the supervisor holds for a chat's daemon: its secret and its
  // started_by (on a release, a `now` shutdown, a pid change or an exit). The
  // rate limit's last attempt stays, so a forget never buys an early respawn.
  function forget(chatId) {
    const st = chats.get(chatId);
    if (!st) return;
    drop(st);
  }

  const api = { ensureRunning, relayCredential, startedBy, forget };

  // CONNECTOR@install-seam: the run context holds one supervisor.
  function install(ctx) {
    if (!ctx || typeof ctx !== 'object') throw new TypeError('install: a context object is required');
    if (ctx.supervisor && ctx.supervisor !== api) throw new Error('install: a supervisor is already installed');
    ctx.supervisor = api;
    return () => { if (ctx.supervisor === api) delete ctx.supervisor; };
  }
  api.install = install;

  return api;
}

module.exports = { createSupervisor, STARTED_BY };
