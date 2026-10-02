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
// respawn (v1 has no warm-idle).
//
// Trust is confirm-on-first-use, recorded per (project root, code, params) so an
// edit, a different project, or different params all re-prompt — except a param
// the component declared it may vary without asking (`x-trust`, below). The
// decision is made by the CLI (`claude-web-chat trust`) writing the user-tier
// trust file — NOT in the browser, which cannot gate this: pane scripts share
// the page's realm and origin (see surfaceTrustPrompt below).

const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
const { serviceInfo } = require('./components-registry');
const { RENDER_CONTROL_PARAMS } = require('./domain/mounts');
const { fence } = require('../core/paths');
const { readJsonOr } = require('../core/fsjson');
const { readTrustMarks } = require('../core/trust-marks');

const RUNNER = require.resolve('./service-runner');
const DEBOUNCE_MS = 200;
const STOP_GRACE_MS = 2000;

// ---- trust identity — minted HERE and nowhere else --------------------------
// A consent is a triple: (project root, code hash, params). The pure functions
// below are the only place that triple becomes a value, and everything
// downstream — the trust-file key, the pending listing, the WS notice, the
// browser's card map, the CLI's selector, the supervisor's restart test —
// QUOTES what they produced. It used to be re-projected per consumer (the WS
// frames carried the hash alone, so two params-variants of one service collapsed
// to one card and clearing either cleared both), and every lossy projection was
// a place two different consents could be mistaken for one.
//
// Pure and module-scoped so a test can assert the identity directly rather than
// through a booted daemon.

// One key order for every bag the identity hashes — the params and the
// declaration — so an equivalent object never reads as a different request.
// `skip` drops keys on the way.
function sortedBag(obj, skip = null) {
  const out = {};
  for (const k of Object.keys(obj).sort()) if (!skip || !skip.has(k)) out[k] = obj[k];
  return out;
}

// The service-facing half of a mount's params: the bag MINUS the keys the shell
// reads for itself (lib/server/domain/mounts RENDER_CONTROL_PARAMS). Those keys
// ride in `mount.params` only because /render and /use take one params object;
// they change how the render behaves, never what the host process does. Leaving
// them in made `params.form_reset:true` on a re-render — a purely visual choice —
// restart the child and re-ask for approval under a new identity, i.e. the user
// being asked to re-consent to a service that had not changed.
//
// This is what the child is spawned with. Key order is normalised.
function serviceParams(params) {
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  return sortedBag(p, RENDER_CONTROL_PARAMS);
}

// Stable fingerprint of a params bag (render-control keys stripped first).
function paramsFingerprint(params) {
  return crypto.createHash('sha256').update(JSON.stringify(serviceParams(params))).digest('hex').slice(0, 16);
}

// ---- declared params: `x-trust` ---------------------------------------------
// The render-control keys left the identity because they re-asked for a service
// that had not changed. A component can declare more params of that kind, on its
// params_schema (the vocabulary is lib/core/trust-marks):
//
//   display       never part of the identity
//   project-path  left out while the value is a path inside the project root;
//                 otherwise its exact value
//   (anything else, or no mark — its exact value, as for every param before)
//
// The service is still handed every value unchanged. Only the identity — what
// the user is asked to approve — loses them.

// The declaration as it enters the identity: the KNOWN marks only (an unknown
// one counts as absent), keys sorted. `{}` for a component that declares none.
function trustDeclaration(schema) {
  return sortedBag(readTrustMarks(schema).marks);
}

// The code half of the identity. The declaration is part of it: marking a param
// widens what every approval of that code covers, so changing the marks must
// ask again, exactly as editing service.js does. With no declaration this is the
// sha256 of service.js BYTE FOR BYTE as before x-trust existed — every approval
// already on disk was recorded under it, and must not ask again. With one, it is
// the sha256 of `<sha256 of service.js>\0<the declaration as sorted JSON>`
// (`\0` spelled as an escape — see trustKey). The first part is fixed-length
// hex, so no service.js and no declaration can be read as a different pair.
function codeHash(sourceHash, covers) {
  if (!sourceHash || !covers || !Object.keys(covers).length) return sourceHash;
  return crypto.createHash('sha256').update(`${sourceHash}\0${JSON.stringify(covers)}`).digest('hex');
}

// Can a `project-path` value be left out of the identity? Only a value PROVEN to
// be a path inside the project root, and when in doubt, no — the value then
// counts by its exact value, which asks as an unmarked param always has.
//
// The proof is lib/core/paths `fence`: the value resolves against the root (a
// relative one) or stands as given (an absolute one), and the lexical shape must
// stay inside — a `..` that leaves is refused — and so must the realpath of its
// nearest entry that exists, found by lstat, so a symlink pointing out, one
// pointing nowhere, or an ancestor reached through a link out all count as
// outside. Before that, the value must read as a plain path:
//   * a string — anything else is exact;
//   * no control characters — a NUL cannot be in a path at all;
//   * not option-shaped (`-…`) — a service that hands it to a command line
//     would pass a flag (`--output=<file>` makes `git log` write a file);
//   * not `~…` — a shell or a helper expands that to the home directory;
//   * no URL scheme (`file:…`) — a service that takes a URL reads it as one.
// The service runs with the project root as its working directory (spawn,
// below), so a relative value it resolves the ordinary way lands where this
// proved it does.
// eslint-disable-next-line no-control-regex
const PLAIN_PATH = /^(?![-~])(?![a-z][a-z0-9+.-]*:)[^\x00-\x1f\x7f]*$/i;
function insideProject(root, value) {
  return typeof value === 'string' && PLAIN_PATH.test(value) && fence(root, value) !== null;
}

// The identity-bearing half of a service's params: `params` (already the service
// params) minus what the declaration covers.
function identityParams(params, covers, root) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    const mark = Object.prototype.hasOwnProperty.call(covers, k) ? covers[k] : null;
    if (mark === 'display') continue;
    if (mark === 'project-path' && insideProject(root, v)) continue;
    out[k] = v;
  }
  return out;
}

// The key consent is recorded under. It is NOT the code hash alone. Two things
// besides the code decide what a service actually does:
//   * WHICH PROJECT it runs in — a service reads and writes the project it is
//     spawned under, so one approval must not become a machine-wide capability
//     that any repo you later clone inherits.
//   * ITS PARAMS — `file-editor` takes `unfenced:true`, which lifts its writes
//     out of the project root. Approving the fenced form must not silently
//     approve the unfenced one. (`paramsFp` here is the fingerprint of the
//     IDENTITY-bearing params — identityParams above.)
//
// The separator is spelled `\0`, NOT a literal NUL byte: one raw 0x00 anywhere
// in a file makes git classify the whole file as binary, and `git diff`,
// `git log -p` and `git blame` go silent on it. The escape produces the
// identical byte, so every trust key already recorded in trusted.json still
// matches — do not "simplify" this back to the literal.
function trustKey(hash, root, paramsFp) {
  return crypto.createHash('sha256').update(`${root}\0${hash}\0${paramsFp}`).digest('hex');
}

// The whole identity of one request, from its parts. computeDesired mints every
// pane's through this.
//   root       — the project root
//   sourceHash — the sha256 of service.js (serviceInfo().hash)
//   schema     — the component's params_schema, where the declaration lives
//   params     — the mount's params bag, as given
// Returns what every consumer quotes:
//   params     — what the child is handed (render-control keys stripped)
//   covers     — the declaration, { param: mark }, sorted
//   hash       — the code hash (codeHash)
//   paramsFp   — the fingerprint of the identity-bearing params
//   key        — the trust key
//   spawnFp    — the fingerprint of everything the child is handed. Equal to
//                paramsFp unless a covered param is set; the supervisor
//                restarts a child whose spawnFp changed under the same key.
function mintIdentity({ root, sourceHash, schema, params }) {
  const spawned = serviceParams(params);
  const covers = trustDeclaration(schema);
  const hash = codeHash(sourceHash, covers);
  const paramsFp = paramsFingerprint(identityParams(spawned, covers, root));
  return {
    params: spawned, covers, hash, paramsFp,
    key: trustKey(hash, root, paramsFp),
    spawnFp: paramsFingerprint(spawned),
  };
}

function createServiceSupervisor({ state, graph, paths, bus, getPort, getViewers, log = () => {} }) {
  // mountId -> { child, name, hash, paramsFp, spawnFp, key, status, params, servicePath }
  const children = new Map();
  const prompted = new Map();   // trustKey -> pending request awaiting a CLI decision
  const failed = new Map();     // mountId -> hash that crashed — don't auto-respawn same version
  let debounceTimer = null;
  let shuttingDown = false;

  // ---- trust store -----------------------------------------------------------
  // Read fresh every time: the CLI (`claude-web-chat trust`) is what writes this
  // file, so the daemon must never cache it.
  // The key itself is minted by trustKey() above — this project's root plus the
  // (hash, params) pair computeDesired already resolved.

  // Anything that is not a readable JSON object reads as "nothing decided" —
  // fail closed: a torn or wrong-shaped file approves nothing.
  function readTrusted() {
    return readJsonOr(paths.TRUSTED_SERVICES_PATH, {}, {
      validate: (d) => d !== null && typeof d === 'object' && !Array.isArray(d),
    });
  }
  // Has the user recorded ANY decision for this exact request? A deny is stored
  // just like an approval, so a refused service stops being asked about instead
  // of re-announcing itself on every reconcile and every arriving viewer.
  // Both take the MINTED key, never the parts: re-deriving it per caller is how
  // the identity drifted in the first place.
  function hasDecision(key) {
    return Boolean(key) && Boolean(readTrusted()[key]);
  }

  function isTrusted(key) {
    if (!key) return false;
    const rec = readTrusted()[key];
    return Boolean(rec) && rec.approved !== false;
  }

  // ---- desired-state computation ---------------------------------------------
  // The desired children = service-backed mounts currently on the active surface,
  // but only while a browser is watching. Empty otherwise, which stops everything.
  // `ignoreViewers` drops only the viewer gate, giving the set of service-backed
  // panes ON THE SURFACE regardless of who is watching — what the bookkeeping
  // prune below has to key off (see prune()).
  function computeDesired({ ignoreViewers = false } = {}) {
    const out = new Map();
    // state.mounts IS the active surface (the live, possibly-uncommitted node, or
    // whatever restoreLiveToNode last populated). We do NOT gate on graph.active:
    // it is null before the first commit, yet the live surface can already show a
    // service-backed pane. Navigating away empties state.mounts (restoreLiveToNode
    // / graph.clearLiveMounts), which is what makes lifetime graph-aware.
    if (shuttingDown || (!ignoreViewers && getViewers() < 1)) return out;
    for (const [mountId, m] of state.mounts) {
      if (!m || !m.component) continue;
      const info = serviceInfo(paths, m.component);
      if (!info || !info.exists) continue;
      // The identity is minted HERE, once, and carried whole from this point:
      // the params the service will actually be spawned with (shell control keys
      // stripped), the declaration, the code hash, the fingerprints, and the
      // trust key every consumer quotes.
      const id = mintIdentity({ root: paths.root, sourceHash: info.hash, schema: info.params_schema, params: m.params });
      out.set(mountId, {
        name: m.component, servicePath: info.servicePath, sourceHash: info.hash, ...id,
      });
    }
    return out;
  }

  // ---- reconcile --------------------------------------------------------------
  function reconcile(reason) {
    if (shuttingDown) return;
    const desired = computeDesired();

    // 1. Stop children no longer desired, or whose identity changed. Identity is
    //    the TRUST KEY itself — the same value consent is recorded under, so a
    //    restart and a re-ask can never disagree about what changed, and a
    //    render-control key (`form_reset` &c, stripped in computeDesired) can
    //    never restart a child on its own.
    //    Params are not decoration: `file-editor`'s `unfenced:true` is what
    //    lifts its writes out of the project root. /use with an existing id
    //    replaces the mount in place, so without the params half a re-use with
    //    new params leaves the old child running with the old ones — the change
    //    silently not applied, and the new shape never trust-checked until some
    //    unrelated restart makes the pane go dark waiting for an approval the
    //    user was never asked for.
    //    A COVERED param (x-trust: a display value, or a path inside the
    //    project) changes what the child was handed without changing what it
    //    was approved for. v1 has no way to hand a running child new params, so
    //    it restarts with them — still approved, so nothing is asked.
    for (const [mountId, entry] of [...children]) {
      const d = desired.get(mountId);
      if (!d || d.key !== entry.key) stop(mountId);
      else if (d.spawnFp !== entry.spawnFp) stop(mountId);
    }

    // 2. Start desired children not already running.
    for (const [mountId, d] of desired) {
      if (children.has(mountId)) continue;
      if (failed.get(mountId) === d.hash) continue; // crashed on this exact version — don't loop
      ensureStarted(mountId, d);
    }

    // 3. Forget bookkeeping about panes that are gone.
    prune();
  }

  // `prompted` and `failed` outlive their panes otherwise: a trust request stays
  // listed by `claude-web-chat trust` (and re-announced to every arriving viewer)
  // for a pane nobody can see, and a crash block keeps a mount id unusable long
  // after something else has been mounted under it.
  //
  // Keyed off the panes on the surface, NOT off `desired`: `desired` is empty
  // whenever no browser is watching, and a refresh — or a sleeping laptop — must
  // not retire a request the user is at that moment walking to the terminal to
  // approve.
  function prune() {
    if (!prompted.size && !failed.size) return;
    const onSurface = computeDesired({ ignoreViewers: true });
    const live = new Set([...onSurface.values()].map((d) => d.key));
    for (const [key, p] of [...prompted]) {
      if (!live.has(key)) { prompted.delete(key); clearTrustPrompt(key); }
    }
    for (const mountId of [...failed.keys()]) {
      if (!onSurface.has(mountId)) failed.delete(mountId);
    }
  }

  function scheduleReconcile(reason) {
    if (shuttingDown) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { debounceTimer = null; reconcile(reason); }, DEBOUNCE_MS);
    if (debounceTimer.unref) debounceTimer.unref();
  }

  function ensureStarted(mountId, d) {
    if (isTrusted(d.key)) { spawn(mountId, d); return; }
    // Refused earlier: stay stopped, and stay quiet.
    if (hasDecision(d.key)) return;
    surfaceTrustPrompt(d);
  }

  // ---- child lifecycle --------------------------------------------------------
  function spawn(mountId, d) {
    const port = getPort();
    if (!port) return; // no bound port yet — reconcile will retry on the next event
    let child;
    try {
      child = fork(RUNNER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    } catch (e) { log(`failed to fork service '${d.name}':`, e && e.message); return; }

    const entry = { child, name: d.name, hash: d.hash, paramsFp: d.paramsFp, spawnFp: d.spawnFp, key: d.key, status: 'starting', params: d.params, servicePath: d.servicePath };
    children.set(mountId, entry);

    if (child.stdout) child.stdout.on('data', (b) => log(`[${d.name}]`, b.toString().trimEnd()));
    if (child.stderr) child.stderr.on('data', (b) => log(`[${d.name}!]`, b.toString().trimEnd()));
    child.on('exit', (code, signal) => onChildExit(mountId, entry, code, signal));
    child.on('error', (e) => log(`service '${d.name}' process error:`, e && e.message));
    child.on('message', (m) => {
      if (m && m.type === 'started' && children.get(mountId) === entry) entry.status = 'running';
    });

    // `root` becomes the child's working directory (service-runner), wherever the
    // daemon itself was started from: a `project-path` value was proven inside
    // the root by resolving it against the root (insideProject), so the service
    // must resolve it from the same place.
    try {
      child.send({ type: 'start', servicePath: d.servicePath, mountId, name: d.name, owner: `service:${d.name}`, params: d.params || {}, port, webChatDir: paths.WEB_CHAT_DIR, root: paths.root });
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

  // Bound to the ENTRY, not just the mount id: reconcile stops and respawns a
  // mount in one synchronous pass (an identity change), and stop() deletes the
  // entry long before the old child's 'exit' arrives. Keyed on the mount id
  // alone, that late exit reads as the REPLACEMENT crashing — evicting a child
  // that is still running, so nothing ever stops it and the next reconcile forks
  // a third. Same identity check the 'message' handler already makes.
  function onChildExit(mountId, entry, code, signal) {
    if (children.get(mountId) !== entry) return; // stopped on request, or superseded
    children.delete(mountId);
    // Unexpected exit (crash): record the version so reconcile won't hot-loop
    // respawning it. Editing service.js (new hash) clears the block naturally.
    failed.set(mountId, entry.hash);
    log(`service '${entry.name}' exited unexpectedly (code=${code} signal=${signal})`);
  }

  // ---- trust prompt ----------------------------------------------------------
  // The DECISION IS NOT MADE IN THE BROWSER, and cannot be. Pane scripts are
  // compiled with `new Function` and run in the main window realm
  // (public/mount-runtime.js) with `document`, `fetch` and `WebSocket`, and no
  // CSP is served. So a pane can synthesise a click on any chrome button, open
  // its own same-origin socket and read anything broadcast to the shell, and
  // call any localhost HTTP endpoint. Nothing delivered to the page — a nonce, a
  // token, DOM state — is a secret from the very code this gate exists to gate.
  //
  // That is not hypothetical: a repository can commit `.web-chat/draft.json`
  // plus `.web-chat/components/<name>/`, and `loadDraft` restores those mounts
  // verbatim at daemon boot — so cloning a hostile repo and running `open` is
  // enough to get its pane script running.
  //
  // Consent therefore lives where pane JS cannot reach: the filesystem, written
  // by the CLI (`claude-web-chat trust`). What the browser gets is purely
  // INFORMATIONAL — it tells the user which command to run. It grants nothing.
  function surfaceTrustPrompt(d) {
    const key = d.key;
    if (prompted.has(key)) return;
    prompted.set(key, {
      key, name: d.name, hash: d.hash, sourceHash: d.sourceHash, params: d.params || {}, paramsFp: d.paramsFp,
      covers: d.covers || {}, root: paths.root, requested_at: Date.now(),
    });
    log(`service '${d.name}' needs approval before it can run — approve with: claude-web-chat trust ${d.name}`);
    // Informational only: no nonce, nothing that could be replayed into a grant.
    bus.emit({ ws: trustFrame(prompted.get(key)) });
  }

  // ONE frame shape for the notice, so the fresh announce, the re-announce to an
  // arriving viewer and the CLI listing all describe the same request the same
  // way. It is keyed by `key`, not by `hash`: two panes of one component mounted
  // with different params are two decisions, and under the hash alone they
  // collapsed into a single card in every browser — so clearing either one (a
  // clear of one pane, or an approval of one variant) silently took the other's
  // card away while the request stayed pending on the server. `params` rides
  // along because two cards for one component are otherwise indistinguishable;
  // it is not a secret — the page already rendered the pane with them. `covers`
  // is the component's x-trust declaration: the params an approval of this
  // request covers beyond the values shown.
  function trustFrame(p) {
    return {
      type: 'service:trust',
      key: p.key,
      name: p.name,
      hash: p.hash,
      params: p.params || {},
      params_fp: p.paramsFp,
      covers: p.covers || {},
      command: `claude-web-chat trust ${p.name}`,
    };
  }

  // Re-announce every outstanding request. Called whenever the viewer count
  // changes upward: the card lives only in the connected browsers, so a refresh,
  // a sleeping laptop or a flapping VPN would otherwise leave the pane sitting
  // there with no visible explanation. Announcements are idempotent and carry no
  // authority, so re-sending them is always safe.
  function reissuePrompts() {
    for (const [, p] of prompted) bus.emit({ ws: trustFrame(p) });
  }

  // Retires ONE request — addressed by the same key the card was raised under.
  function clearTrustPrompt(key) {
    bus.emit({ ws: { type: 'service:trust:clear', key } });
  }

  // What `claude-web-chat trust` (with no argument) lists. Read-only — exposing
  // it over HTTP grants nothing, since the decision is a filesystem write.
  // `hash` is the code hash the key was minted from; `source_hash` is the plain
  // sha256 of service.js (the two differ only when the component declares
  // x-trust), which is what a user can check the file against.
  function pendingTrust() {
    return [...prompted.values()].map((p) => ({
      name: p.name, hash: p.hash, source_hash: p.sourceHash, params: p.params, covers: p.covers || {},
      requested_at: p.requested_at, root: p.root, params_fp: p.paramsFp, key: p.key,
    }));
  }

  // Called after the CLI writes the trust file, so the pane comes alive without
  // waiting for an unrelated event. Grants nothing by itself: reconcile re-reads
  // the file from disk and only spawns what is actually recorded there.
  function refreshTrust() {
    for (const [key, p] of [...prompted]) {
      // Any recorded decision retires the request — a deny as much as an approval.
      if (hasDecision(key)) { prompted.delete(key); clearTrustPrompt(key); }
    }
    scheduleReconcile('trust-changed');
  }

  // ---- public API -------------------------------------------------------------
  function attach() {
    return bus.subscribe((event) => {
      if (!event || shuttingDown) return;
      if (event.kind === 'graph') return scheduleReconcile('graph:' + event.op);
      if (event.kind === 'render' || event.kind === 'clear') return scheduleReconcile(event.kind);
      // A pack operation changes what is on DISK under a pane that is already
      // mounted, which no render or graph event announces. It matters in one
      // direction especially: re-installing a pack now removes what the new
      // version dropped, so an update that took a component's service.js away
      // has to stop the child that was running it — not leave it running under
      // the new record until some unrelated event happens along.
      if (event.kind === 'packs') return scheduleReconcile('packs:' + (event.op || 'changed'));
    });
  }

  // The WS layer reports the live browser count on every connect/disconnect.
  // A viewer arriving re-announces any outstanding request: the card lives only
  // in the browser, so without this a refresh mid-prompt left the pane sitting
  // there with no visible reason. (Tying this to a ZERO-viewer transition was
  // not enough — with a second tab open, or a half-open socket the 30s heartbeat
  // has not yet reaped, the count never reaches zero.)
  function setViewers(n) {
    if (n > 0) reissuePrompts();
    scheduleReconcile('viewers');
  }

  function stopAll() {
    shuttingDown = true;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    for (const mountId of [...children.keys()]) stop(mountId);
  }

  return { attach, setViewers, pendingTrust, refreshTrust, scheduleReconcile, reconcile, stopAll, _children: children, _isTrusted: isTrusted, _prompted: prompted, _failed: failed };
}

module.exports = {
  createServiceSupervisor, serviceParams, paramsFingerprint, trustKey,
  trustDeclaration, codeHash, identityParams, insideProject, mintIdentity,
};
