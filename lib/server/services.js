// The service supervisor — one in-process engine that owns every service child
// process for service-backed components (a component dir carrying a service.js).
//
// It is purely REACTIVE: it subscribes to the change bus once (mirroring the
// wake-policy subscriber in lib/server/index.js) and, on every relevant event,
// runs a debounced reconcile() that diffs the DESIRED set of service children
// (derived from state.mounts + trust + viewer presence) against the RUNNING set,
// then starts/stops to match. Because graph.restoreLiveToNode mutates state.mounts
// BEFORE the graph:set-active event fires, and /use mutates state.mounts before its
// render event, state.mounts is always the active node's live mounts by reconcile
// time — so one algorithm covers render, clear, and navigation uniformly.
//
// Lifetime is pane-scoped AND graph-aware: a service runs iff its pane is a live
// mount on the active node AND a browser is watching. Suspend == stop, resume ==
// respawn (v1 has no warm-idle). Trust is confirm-on-first-use, keyed by the
// sha256 of service.js so an edit re-prompts.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
const { serviceInfo } = require('./components-registry');

const RUNNER = require.resolve('./service-runner');
const DEBOUNCE_MS = 200;
const STOP_GRACE_MS = 2000;

function createServiceSupervisor({ state, graph, paths, bus, getPort, getViewers, log = () => {} }) {
  // mountId -> { child, name, hash, status, params, servicePath }
  const children = new Map();
  const prompted = new Map();   // hash -> { name, nonce } for prompts awaiting a decision
  const denied = new Set();     // hashes the user denied — don't re-prompt, don't spawn
  const failed = new Map();     // mountId -> hash that crashed — don't auto-respawn same version
  let debounceTimer = null;
  let shuttingDown = false;

  // ---- trust store (content-hash keyed) --------------------------------------
  function readTrusted() {
    try { return JSON.parse(fs.readFileSync(paths.TRUSTED_SERVICES_PATH, 'utf8')); }
    catch { return {}; }
  }
  function isTrusted(hash) {
    if (!hash) return false;
    return Object.prototype.hasOwnProperty.call(readTrusted(), hash);
  }
  function addTrusted(hash, name) {
    const t = readTrusted();
    t[hash] = { name, approved_at: Date.now() };
    try {
      fs.mkdirSync(path.dirname(paths.TRUSTED_SERVICES_PATH), { recursive: true });
      fs.writeFileSync(paths.TRUSTED_SERVICES_PATH, JSON.stringify(t, null, 2));
    } catch (e) { log('failed to persist trust:', e && e.message); }
  }

  // ---- desired-state computation ---------------------------------------------
  // The desired children = service-backed mounts currently on the active surface,
  // but only while a browser is watching. Empty otherwise, which stops everything.
  function computeDesired() {
    const out = new Map();
    // state.mounts IS the active surface (the live, possibly-uncommitted node, or
    // whatever restoreLiveToNode last populated). We do NOT gate on graph.active:
    // it is null before the first commit, yet the live surface can already show a
    // service-backed pane. Navigating away empties state.mounts (restoreLiveToNode
    // / graph.clearLiveMounts), which is what makes lifetime graph-aware.
    if (shuttingDown || getViewers() < 1) return out;
    for (const [mountId, m] of state.mounts) {
      if (!m || !m.component) continue;
      const info = serviceInfo(paths, m.component);
      if (!info || !info.exists) continue;
      out.set(mountId, { name: m.component, params: m.params, servicePath: info.servicePath, hash: info.hash });
    }
    return out;
  }

  // ---- reconcile --------------------------------------------------------------
  function reconcile(reason) {
    if (shuttingDown) return;
    const desired = computeDesired();

    // 1. Stop children no longer desired, or whose service.js changed (new hash).
    for (const [mountId, entry] of [...children]) {
      const d = desired.get(mountId);
      if (!d || d.hash !== entry.hash) stop(mountId);
    }

    // 2. Start desired children not already running.
    for (const [mountId, d] of desired) {
      if (children.has(mountId)) continue;
      if (failed.get(mountId) === d.hash) continue; // crashed on this exact version — don't loop
      ensureStarted(mountId, d);
    }
  }

  function scheduleReconcile(reason) {
    if (shuttingDown) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { debounceTimer = null; reconcile(reason); }, DEBOUNCE_MS);
    if (debounceTimer.unref) debounceTimer.unref();
  }

  function ensureStarted(mountId, d) {
    if (denied.has(d.hash)) return;
    if (!isTrusted(d.hash)) { surfaceTrustPrompt(d); return; }
    spawn(mountId, d);
  }

  // ---- child lifecycle --------------------------------------------------------
  function spawn(mountId, d) {
    const port = getPort();
    if (!port) return; // no bound port yet — reconcile will retry on the next event
    let child;
    try {
      child = fork(RUNNER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    } catch (e) { log(`failed to fork service '${d.name}':`, e && e.message); return; }

    const entry = { child, name: d.name, hash: d.hash, status: 'starting', params: d.params, servicePath: d.servicePath };
    children.set(mountId, entry);

    if (child.stdout) child.stdout.on('data', (b) => log(`[${d.name}]`, b.toString().trimEnd()));
    if (child.stderr) child.stderr.on('data', (b) => log(`[${d.name}!]`, b.toString().trimEnd()));
    child.on('exit', (code, signal) => onChildExit(mountId, d.hash, code, signal));
    child.on('error', (e) => log(`service '${d.name}' process error:`, e && e.message));
    child.on('message', (m) => {
      if (m && m.type === 'started' && children.get(mountId) === entry) entry.status = 'running';
    });

    try {
      child.send({ type: 'start', servicePath: d.servicePath, mountId, name: d.name, owner: `service:${d.name}`, params: d.params || {}, port, webChatDir: paths.WEB_CHAT_DIR });
    } catch (e) { log(`failed to signal service '${d.name}':`, e && e.message); }
  }

  function stop(mountId) {
    const e = children.get(mountId);
    if (!e) return;
    e.status = 'stopping';
    children.delete(mountId);
    try { e.child.send({ type: 'stop' }); } catch {}
    const t = setTimeout(() => { try { e.child.kill('SIGTERM'); } catch {} }, STOP_GRACE_MS);
    if (t.unref) t.unref();
    e.child.once('exit', () => clearTimeout(t));
  }

  function onChildExit(mountId, hash, code, signal) {
    const e = children.get(mountId);
    if (!e) return; // already removed by stop() — a requested shutdown
    children.delete(mountId);
    // Unexpected exit (crash): record the version so reconcile won't hot-loop
    // respawning it. Editing service.js (new hash) clears the block naturally.
    failed.set(mountId, hash);
    log(`service '${e.name}' exited unexpectedly (code=${code} signal=${signal})`);
  }

  // ---- trust prompt (chrome-level, WS-only — never committed to the graph) ----
  // This gate decides whether host code runs on the user's machine, so BOTH of
  // its old properties had to change:
  //
  //  * It used to be sent as a `render` with target:'overlay'. The client
  //    resolves a target with `$(target) || $('main')`, and `overlay` is a REAL
  //    element — the graph viewer, display:none until the user presses G. The
  //    prompt was therefore filed inside a hidden panel: a service could never
  //    be approved, and its pane simply waited forever with no error anywhere.
  //  * The decision travelled as an ordinary store key (`wc_service_approval`),
  //    which ANY pane can write. A component could mount a second pane and
  //    approve its own service. A nonce would not have fixed that — mounts use
  //    open shadow roots, so a sibling pane can read one out of the DOM.
  //
  // Both are closed by taking the prompt out of the mount system entirely: the
  // client renders it as chrome (see public/app/service-trust.js) and returns
  // the decision on a dedicated `service:decision` WS frame that pane JS has no
  // way to send. The nonce below is belt-and-braces against a replayed or
  // guessed frame from a non-browser client.
  function surfaceTrustPrompt(d) {
    if (prompted.has(d.hash)) return;
    const nonce = crypto.randomBytes(16).toString('hex');
    prompted.set(d.hash, { name: d.name, nonce });
    bus.emit({ ws: { type: 'service:trust', name: d.name, hash: d.hash, nonce } });
  }

  function clearTrustPrompt(hash) {
    bus.emit({ ws: { type: 'service:trust:clear', hash } });
  }

  // A prompt lives only in the connected browsers. When the last viewer goes
  // away (refresh, tab close) the prompt goes with it, so the outstanding-prompt
  // memo has to be released too — otherwise the first refresh after a prompt
  // made that service permanently unpromptable for the life of the daemon.
  function forgetPrompts() {
    prompted.clear();
  }

  // Apply a decision arriving on the dedicated WS frame. Rejects anything that
  // doesn't match an outstanding prompt's nonce, so a stale or forged frame is
  // a no-op rather than a silent grant of host code execution.
  function decide({ hash, decision, nonce } = {}) {
    if (!hash || !nonce) return { ok: false, error: 'malformed decision' };
    const outstanding = prompted.get(hash);
    if (!outstanding || outstanding.nonce !== nonce) return { ok: false, error: 'no matching prompt' };
    prompted.delete(hash);
    if (decision === 'approve') addTrusted(hash, outstanding.name);
    else denied.add(hash);
    clearTrustPrompt(hash);
    scheduleReconcile('approval');
    return { ok: true, decision: decision === 'approve' ? 'approve' : 'deny' };
  }

  // ---- public API -------------------------------------------------------------
  function attach() {
    return bus.subscribe((event) => {
      if (!event || shuttingDown) return;
      if (event.kind === 'graph') return scheduleReconcile('graph:' + event.op);
      if (event.kind === 'render' || event.kind === 'clear') return scheduleReconcile(event.kind);
    });
  }

  // The WS layer reports the live browser count on every connect/disconnect.
  // At zero there is nobody to answer a trust prompt and any rendered prompt
  // died with the socket, so release the already-prompted memo — the next viewer
  // gets prompted again instead of facing a service that silently never starts.
  function setViewers(n) {
    if (n === 0) forgetPrompts();
    scheduleReconcile('viewers');
  }

  function stopAll() {
    shuttingDown = true;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    for (const mountId of [...children.keys()]) stop(mountId);
  }

  return { attach, setViewers, decide, scheduleReconcile, reconcile, stopAll, _children: children, _isTrusted: isTrusted, _prompted: prompted };
}

module.exports = { createServiceSupervisor };
