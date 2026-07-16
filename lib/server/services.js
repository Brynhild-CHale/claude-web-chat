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
const { fork } = require('child_process');
const { serviceInfo } = require('./components-registry');

const RUNNER = require.resolve('./service-runner');
const DEBOUNCE_MS = 200;
const STOP_GRACE_MS = 2000;

function createServiceSupervisor({ state, graph, paths, bus, getPort, getViewers, log = () => {} }) {
  // mountId -> { child, name, hash, status, params, servicePath }
  const children = new Map();
  const prompted = new Set();   // service.js hashes we've already surfaced a trust pane for
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
      child.send({ type: 'start', servicePath: d.servicePath, mountId, name: d.name, owner: `service:${d.name}`, params: d.params || {}, port });
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

  // ---- trust prompt (WS-only overlay — never committed to the graph) ---------
  function surfaceTrustPrompt(d) {
    if (prompted.has(d.hash)) return;
    prompted.add(d.hash);
    bus.emit({
      ws: {
        type: 'render',
        target: 'overlay',
        id: `wc-service-approve-${d.name}`,
        html: approvalHtml(d.name, d.hash),
        params: { name: d.name, hash: d.hash },
      },
    });
  }

  function clearTrustPrompt(name) {
    bus.emit({ ws: { type: 'clear', id: `wc-service-approve-${name}`, target: 'overlay' } });
  }

  function maybeHandleApproval(event) {
    const v = event && event.patch && event.patch.wc_service_approval;
    if (!v || !v.hash) return;
    // Find the component name we prompted for this hash (for the clear + trust record).
    const name = v.name || nameForHash(v.hash) || 'service';
    if (v.decision === 'approve') { addTrusted(v.hash, name); prompted.delete(v.hash); }
    else { denied.add(v.hash); prompted.delete(v.hash); }
    clearTrustPrompt(name);
    // Drop the transient control-plane key so it doesn't linger in the committed store.
    try {
      delete state.store.wc_service_approval;
      bus.emit({ event: { kind: 'store', patch: { wc_service_approval: null }, source: 'server' }, ws: { type: 'store:patch', patch: { wc_service_approval: null } } });
    } catch {}
    scheduleReconcile('approval');
  }

  function nameForHash(hash) {
    for (const [, m] of state.mounts) {
      if (!m || !m.component) continue;
      const info = serviceInfo(paths, m.component);
      if (info && info.hash === hash) return m.component;
    }
    return null;
  }

  // ---- public API -------------------------------------------------------------
  function attach() {
    return bus.subscribe((event) => {
      if (!event || shuttingDown) return;
      if (event.kind === 'graph') return scheduleReconcile('graph:' + event.op);
      if (event.kind === 'render' || event.kind === 'clear') return scheduleReconcile(event.kind);
      if (event.kind === 'store' && event.source === 'browser') return maybeHandleApproval(event);
    });
  }

  function setViewers() { scheduleReconcile('viewers'); }

  function stopAll() {
    shuttingDown = true;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    for (const mountId of [...children.keys()]) stop(mountId);
  }

  return { attach, setViewers, scheduleReconcile, reconcile, stopAll, _children: children, _isTrusted: isTrusted };
}

// The approval overlay. Approve/Deny write the single control key the supervisor
// taps off the bus. This key is deliberately NOT a declared signal, so it never
// enqueues or wakes Claude — the supervisor is the audience, not Claude.
function approvalHtml(name, hash) {
  const short = String(hash).slice(0, 12);
  const safeName = String(name).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'));
  return `<style>
    .wc-svc-approve { font-family: var(--wc-font, system-ui, sans-serif); color: var(--wc-fg,#1a1a1a);
      border: 1px solid var(--wc-gold,#c99a00); border-radius: var(--wc-radius,10px);
      background: var(--wc-panel-bg,#fff); padding: 16px 18px; max-width: 460px; }
    .wc-svc-approve h3 { margin: 0 0 6px; font-size: 15px; }
    .wc-svc-approve p { margin: 4px 0; font-size: 12.5px; color: var(--wc-muted,#666); }
    .wc-svc-approve code { font-family: var(--wc-mono,monospace); font-size: 11.5px; }
    .wc-svc-approve .row { display:flex; gap:8px; margin-top: 12px; }
    .wc-svc-approve button { font-family: inherit; font-size: 13px; font-weight: 600; border-radius: 7px; padding: 7px 16px; cursor: pointer; border: 1px solid var(--wc-border,#ccc); }
    .wc-svc-approve .ok { color:#fff; background: var(--wc-green,#2a9d5c); border-color: var(--wc-green,#2a9d5c); }
    .wc-svc-approve .no { background: var(--wc-bg,#fff); }
  </style>
  <div class="wc-svc-approve">
    <h3>Run host service for “${safeName}”?</h3>
    <p>This component ships a <code>service.js</code> that will run as a host process on your machine while its pane is active.</p>
    <p>service.js hash: <code>${short}…</code></p>
    <div class="row">
      <button class="ok">Approve &amp; run</button>
      <button class="no">Deny</button>
    </div>
  </div>
  <script>
    const H = params.hash, N = params.name;
    root.querySelector('.ok').addEventListener('click', () => store.set({ wc_service_approval: { seq: Date.now(), hash: H, name: N, decision: 'approve' } }));
    root.querySelector('.no').addEventListener('click', () => store.set({ wc_service_approval: { seq: Date.now(), hash: H, name: N, decision: 'deny' } }));
  </script>`;
}

module.exports = { createServiceSupervisor };
