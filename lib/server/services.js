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
const { serviceInfo, componentTiers } = require('./components-registry');
const { RENDER_CONTROL_PARAMS } = require('./domain/mounts');
const { fence } = require('../core/paths');
const { readJsonOr } = require('../core/fsjson');
const { isComponentName } = require('../core/names');
const { readTrustMarks, describeCovers, describeExact, coversProjectPath, pathReach } = require('../core/trust-marks');
const { findPack, findLedgerEntry } = require('../packs/store');

const RUNNER = require.resolve('./service-runner');
const DEBOUNCE_MS = 200;
const STOP_GRACE_MS = 2000;

// ---- trust identity — minted HERE and nowhere else --------------------------
// A consent is a triple: (project root, code hash, params). The pure functions
// below are the only place that triple becomes a value, and everything
// downstream — the trust-file key, the pending listing, the WS notice, the
// browser's card map, the CLI's selector, `trust --pack`'s pre-approval, the
// supervisor's restart test — QUOTES what they produced. It used to be
// re-projected per consumer (the WS frames carried the hash alone, so two
// params-variants of one service collapsed to one card and clearing either
// cleared both), and every lossy projection was a place two different consents
// could be mistaken for one.
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
// stay inside, and so must the realpath of its nearest entry that exists, found
// by lstat, so a symlink pointing out, one pointing nowhere, or an ancestor
// reached through a link out all count as outside. Before that, the value must
// read as a plain path:
//   * a string — anything else is exact;
//   * no longer than MAX_PATH_VALUE — see below;
//   * no control characters (C0, DEL, C1) — a NUL cannot be in a path at all,
//     and the others only make a value print as something it is not;
//   * not option-shaped (`-…`) — a service that hands it to a command line
//     would pass a flag (`--output=<file>` makes `git log` write a file);
//   * not `~…` — a shell or a helper expands that to the home directory;
//   * no URL scheme (`file:…`, in any case: schemes are case-insensitive, so
//     `FILE:///etc/passwd` is the same URL) — a service that takes a URL reads
//     it as one;
//   * no `..` segment at all, not even one that stays inside. `fence` resolves
//     `..` as TEXT before it looks at the disk, but the kernel follows a link
//     first and applies the `..` after: with `link-out -> /elsewhere/deep`,
//     `link-out/../secret.txt` is `<root>/secret.txt` to the fence and
//     `/elsewhere/secret.txt` to the service that opens it. The service is
//     handed the raw value, so the two must not be able to disagree.
// The service runs with the project root as its working directory (spawn,
// below), so a relative value it resolves the ordinary way lands where this
// proved it does.
//
// The proof is paid on the daemon's only thread, so three bounds cap its
// filesystem work. A value outside a bound is not refused: it counts by its
// exact value, like any value not proven inside, so it asks.
//
// MAX_PATH_VALUE bounds the string. `fence` walks up one segment at a time to
// the nearest existing entry, re-resolving the remaining string at each step,
// so its cost grows with length × segments: a 256 KiB `a/a/a/…` held the event
// loop for seconds, and any pane can mount a component with any params. 1024
// is macOS's PATH_MAX — no longer path opens there.
//
// MAX_PATH_DEPTH bounds one proof. The walk makes one lstat per segment on its
// way up, and 1024 characters still hold 512 segments (about 1.5 ms a proof).
// At 64 a proof makes at most 65 lstats and three realpaths. A real project
// path is far shallower. Both separators count, as they do for `..`, so the
// count is never lower than the walk's.
//
// PROOFS_PER_PASS bounds a pass (passProofs, below). Each reconcile proves the
// values of every service-backed pane on the surface, and the number of panes
// has no cap: any pane can mount more, and a committed draft.json restores as
// many as it lists. So one pass proves at most this many DIFFERENT values, the
// first it meets in the order the panes were mounted; any other counts by its
// exact value. A real surface holds a handful.
const MAX_PATH_VALUE = 1024;
const MAX_PATH_DEPTH = 64;
const PROOFS_PER_PASS = 64;
// eslint-disable-next-line no-control-regex
const PLAIN_PATH = /^(?![-~])(?![a-z][a-z0-9+.-]*:)[^\x00-\x1f\x7f-\x9f]*$/i;
const DOT_DOT_SEGMENT = /(^|[\\/])\.\.([\\/]|$)/;
const SEGMENT = /[^\\/]+/g;

// The half of the proof that needs no filesystem: is this a plain path, inside
// the bounds? Checked first, and the string is short by the time the segments
// are counted.
function plainPathValue(value) {
  return typeof value === 'string'
    && value.length <= MAX_PATH_VALUE
    && PLAIN_PATH.test(value)
    && !DOT_DOT_SEGMENT.test(value)
    && (value.match(SEGMENT) || []).length <= MAX_PATH_DEPTH;
}

function insideProject(root, value) {
  return plainPathValue(value) && fence(root, value) !== null;
}

// The proofs of ONE pass against one root: a function from a value to "proven
// inside". Each different value is proven once, however many panes pass it,
// and at most `budget` values are proven at all; a value past the budget counts
// by its exact value (fail closed: it asks). Never kept past the pass: a path
// proven inside can become a symlink out of the project before the next one (a
// checkout, a pull), and the next pass has to look again.
function passProofs(root, budget = PROOFS_PER_PASS) {
  const proven = new Map();
  const prove = (value) => {
    if (!plainPathValue(value)) return false;
    if (proven.has(value)) return proven.get(value);
    if (proven.size >= budget) return false;
    const inside = fence(root, value) !== null;
    proven.set(value, inside);
    return inside;
  };
  prove.root = root;
  return prove;
}

// Split one request's params by the declaration (`declared`, { param: mark }):
//   identity — the identity-bearing params: everything but what is left out;
//   covers   — what an approval of THIS request spans beyond the values it
//              shows: every `display` param, and every `project-path` param
//              whose value is absent or proven inside the project. Those can
//              change without asking again;
//   exact    — the `project-path` params this request passes a value it could
//              not prove inside (outside the root, a link out, not a plain
//              path). Those stay in the identity by their exact value, so an
//              approval covers that one value and no other.
// `covers` is NOT the declaration: reporting the declaration for a request
// whose path lies outside the project said "any path inside this project" of
// an approval that is in fact for `/etc/hosts` alone.
// `prove` is a pass's proofs (passProofs).
function splitParams(params, declared, prove) {
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const identity = {};
  const exact = {};
  for (const [k, v] of Object.entries(params)) {
    const mark = has(declared, k) ? declared[k] : null;
    if (mark === 'display') continue;
    if (mark === 'project-path' && prove(v)) continue;
    if (mark) exact[k] = mark;
    identity[k] = v;
  }
  const covers = {};
  for (const [k, mark] of Object.entries(declared)) if (!has(exact, k)) covers[k] = mark;
  return { identity, covers: sortedBag(covers), exact: sortedBag(exact) };
}

// The identity-bearing half of a service's params: `params` (already the service
// params) minus what the declaration covers.
function identityParams(params, declared, root) {
  return splitParams(params, declared, passProofs(root)).identity;
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

// The whole identity of one request, from its parts. mintSurface mints every
// pane's through this, and packRequests mints a pack's pre-approvals through it
// too, so the two can never disagree about the same component.
//   root       — the project root
//   sourceHash — the sha256 of service.js (serviceInfo().hash)
//   schema     — the component's params_schema, where the declaration lives
//   params     — the mount's params bag, as given
//   proofs     — optional: the pass's proofs (passProofs) for this root, so a
//                pass proves each value once. Without it (or for another
//                root), this mint gets proofs of its own.
// Returns what every consumer quotes:
//   params     — what the child is handed (render-control keys stripped)
//   declared   — the declaration, { param: mark }, sorted: what the code hash
//                folds in, the same for every request of the component
//   covers     — what an approval of THIS request spans beyond its values
//                (splitParams), sorted
//   exact      — the marked params this request holds to one exact value
//   hash       — the code hash (codeHash)
//   paramsFp   — the fingerprint of the identity-bearing params
//   key        — the trust key
//   spawnFp    — the fingerprint of everything the child is handed. Equal to
//                paramsFp unless a covered param is set; the supervisor
//                restarts a child whose spawnFp changed under the same key.
function mintIdentity({ root, sourceHash, schema, params, proofs = null }) {
  const spawned = serviceParams(params);
  const declared = trustDeclaration(schema);
  const hash = codeHash(sourceHash, declared);
  const prove = proofs && proofs.root === root ? proofs : passProofs(root);
  const { identity, covers, exact } = splitParams(spawned, declared, prove);
  const paramsFp = paramsFingerprint(identity);
  return {
    params: spawned, declared, covers, exact, hash, paramsFp,
    key: trustKey(hash, root, paramsFp),
    spawnFp: paramsFingerprint(spawned),
  };
}

// The files that decide a service component's identity: the code, and the
// meta.json whose params_schema carries the declaration. `trust --pack` approves
// a component only while both are the bytes its pack installed.
const IDENTITY_FILES = ['service.js', 'meta.json'];

// Why `trust --pack` leaves out a component only the project's own pack record
// names. Said in full, because the user is deciding whether to approve host
// code and this is the line that tells them the claim is unverifiable.
const NOT_RECORDED = "only this project's .web-chat/packs.json names it, and no install on this machine "
  + 'recorded it (a repository can commit that file; a pack installed here before 0.8.2 has no record '
  + 'either — install it again to approve it as a pack)';

function createServiceSupervisor({ state, graph, paths, bus, getPort, getViewers, log = () => {} }) {
  // mountId -> { child, name, hash, paramsFp, spawnFp, key, status, params, servicePath }
  const children = new Map();
  const prompted = new Map();   // trustKey -> pending request awaiting a CLI decision
  const failed = new Map();     // mountId -> hash that crashed — don't auto-respawn same version
  let debounceTimer = null;
  let shuttingDown = false;

  // ---- trust store -----------------------------------------------------------
  // Read afresh by every reconcile pass, and never kept from one pass to the
  // next: the CLI (`claude-web-chat trust`) is what writes this file, so the
  // daemon must never cache it.
  // The key itself is minted by trustKey() above — this project's root plus the
  // (hash, params) pair mintSurface already resolved.

  // Anything that is not a readable JSON object reads as "nothing decided" —
  // fail closed: a torn or wrong-shaped file approves nothing.
  function readTrusted() {
    return readJsonOr(paths.TRUSTED_SERVICES_PATH, {}, {
      validate: (d) => d !== null && typeof d === 'object' && !Array.isArray(d),
    });
  }
  // Has the user recorded ANY decision for this exact request, in this snapshot
  // of the trust file? A deny is stored just like an approval, so a refused
  // service stops being asked about instead of re-announcing itself on every
  // reconcile and every arriving viewer.
  // These take the MINTED key, never the parts: re-deriving it per caller is how
  // the identity drifted in the first place.
  function decidedIn(trusted, key) {
    return Boolean(key) && Boolean(trusted[key]);
  }

  function hasDecision(key) {
    return decidedIn(readTrusted(), key);
  }

  // Is `key` approved in this snapshot of the trust file?
  function approvedIn(trusted, key) {
    if (!key) return false;
    const rec = trusted[key];
    return Boolean(rec) && rec.approved !== false;
  }

  function isTrusted(key) {
    return approvedIn(readTrusted(), key);
  }

  // ---- the surface, minted once a pass ----------------------------------------
  // Every service-backed pane on the surface, with its identity, whoever is
  // watching. reconcile() mints this at most ONCE a pass and hands the same map
  // to every step: the desired children are these panes while a browser is
  // watching (and none otherwise), and prune() keys off them as they stand.
  // Prune used to mint the whole surface a second time whenever a request was
  // pending, reading every pane's files and proving every path again.
  //
  // Within the pass, each component's files are read once, however many panes
  // use it, and each project-path value is proven once (passProofs, at most
  // PROOFS_PER_PASS different values). Nothing is kept for the next pass: a
  // service.js can be edited, and a path can become a link out of the project,
  // between two.
  function mintSurface() {
    const out = new Map();
    const infos = new Map();
    const proofs = passProofs(paths.root);
    // state.mounts IS the active surface (the live, possibly-uncommitted node, or
    // whatever restoreLiveToNode last populated). We do NOT gate on graph.active:
    // it is null before the first commit, yet the live surface can already show a
    // service-backed pane. Navigating away empties state.mounts (restoreLiveToNode
    // / graph.clearLiveMounts), which is what makes lifetime graph-aware.
    for (const [mountId, m] of state.mounts) {
      if (!m || !m.component) continue;
      if (!infos.has(m.component)) infos.set(m.component, serviceInfo(paths, m.component));
      const info = infos.get(m.component);
      if (!info || !info.exists) continue;
      // The identity is minted HERE, once, and carried whole from this point:
      // the params the service will actually be spawned with (shell control keys
      // stripped), the declaration, the code hash, the fingerprints, and the
      // trust key every consumer quotes.
      const id = mintIdentity({
        root: paths.root, sourceHash: info.hash, schema: info.params_schema, params: m.params, proofs,
      });
      out.set(mountId, {
        name: m.component, servicePath: info.servicePath, sourceHash: info.hash, ...id,
      });
    }
    return out;
  }

  // ---- reconcile --------------------------------------------------------------
  function reconcile(reason) {
    if (shuttingDown) return;
    // Each read at most once this pass, and only if a step needs it.
    let minted = null;
    const surface = () => minted || (minted = mintSurface());
    let trustFile = null;
    const trusted = () => trustFile || (trustFile = readTrusted());
    // The desired children: the service-backed panes on the surface while a
    // browser is watching. None otherwise, which stops everything.
    const desired = getViewers() < 1 ? new Map() : surface();

    // 1. Stop children no longer desired, or whose identity changed. Identity is
    //    the TRUST KEY itself — the same value consent is recorded under, so a
    //    restart and a re-ask can never disagree about what changed, and a
    //    render-control key (`form_reset` &c, stripped in serviceParams) can
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
    //    And the approval itself can be withdrawn while the child runs:
    //    `trust --pack <name> --deny` records a denial over a key it approved,
    //    and says the service will not run. Starting is gated on the trust file
    //    (step 2); running must be too, or the denial waits for whatever
    //    unrelated event next restarts the child. The CLI's refresh-trust nudge
    //    is what brings this pass round straight away. The file is read once a
    //    pass, for this step and the next: a child stops, and starts, on the
    //    file as it stood, not on a write half-way through.
    for (const [mountId, entry] of [...children]) {
      const d = desired.get(mountId);
      if (!d || d.key !== entry.key) stop(mountId);
      else if (d.spawnFp !== entry.spawnFp) stop(mountId);
      else if (!approvedIn(trusted(), entry.key)) stop(mountId);
    }

    // 2. Start desired children not already running.
    for (const [mountId, d] of desired) {
      if (children.has(mountId)) continue;
      if (failed.get(mountId) === d.hash) continue; // crashed on this exact version — don't loop
      ensureStarted(mountId, d, trusted());
    }

    // 3. Forget bookkeeping about panes that are gone.
    prune(surface);
  }

  // `prompted` and `failed` outlive their panes otherwise: a trust request stays
  // listed by `claude-web-chat trust` (and re-announced to every arriving viewer)
  // for a pane nobody can see, and a crash block keeps a mount id unusable long
  // after something else has been mounted under it.
  //
  // Keyed off the panes on the surface, NOT off `desired`: `desired` is empty
  // whenever no browser is watching, and a refresh — or a sleeping laptop — must
  // not retire a request the user is at that moment walking to the terminal to
  // approve. `surface` hands back the pass's mint (reconcile), minting it only
  // if nothing earlier in the pass has.
  function prune(surface) {
    if (!prompted.size && !failed.size) return;
    const onSurface = surface();
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

  // `trusted` is the pass's snapshot of the trust file (reconcile).
  function ensureStarted(mountId, d, trusted) {
    if (approvedIn(trusted, d.key)) { spawn(mountId, d); return; }
    // Refused earlier: stay stopped, and stay quiet.
    if (decidedIn(trusted, d.key)) return;
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
    // must resolve it from the same place. The child is also handed it as
    // ctx.root, spelled as here: the proof compares an absolute value to THIS
    // spelling as text, and the child's process.cwd() is the realpath, which
    // differs when the root is reached through a symlink.
    // `covers` tells the child which params its approval left out (this
    // request's, from the same mint as the key). A covered project-path value
    // was proven inside when the identity was minted, not for the life of the
    // child: a service that keeps using one — file-editor fences every path
    // against its `root` — holds it inside the project at use time.
    // `sourceHash` is the sha256 of the service.js bytes this approval was
    // keyed on. The runner reads the file ONCE, checks that read against it,
    // and runs exactly those bytes: a fresh `require` by path re-read the file
    // after the fork, so bytes written in between (POST /api/components can
    // rewrite a non-builtin's service.js) ran under the approved key.
    try {
      child.send({
        type: 'start', servicePath: d.servicePath, sourceHash: d.sourceHash, mountId, name: d.name,
        owner: `service:${d.name}`, params: d.params || {}, covers: d.covers || {}, port,
        webChatDir: paths.WEB_CHAT_DIR, root: paths.root,
      });
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
      covers: d.covers || {}, exact: d.exact || {}, root: paths.root, requested_at: Date.now(),
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
  // is what an approval of THIS request spans beyond the values shown, and
  // `exact` the marked params it holds to one value (mintIdentity). The card
  // prints them as the `*_text` words, composed here from lib/core/trust-marks
  // so the page and the CLI say the same thing — the card is where the user
  // reads the command, so it is where the range has to be said BEFORE they run
  // it: `trust <name>` writes at once.
  function trustFrame(p) {
    const covers = p.covers || {};
    const exact = p.exact || {};
    return {
      type: 'service:trust',
      key: p.key,
      name: p.name,
      hash: p.hash,
      params: p.params || {},
      params_fp: p.paramsFp,
      covers,
      exact,
      covers_text: describeCovers(covers),
      exact_text: describeExact(exact),
      reach_text: coversProjectPath(covers) ? pathReach('it') : '',
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
  // x-trust), which is what a user can check the file against. `covers` and
  // `exact` are this request's (mintIdentity), not the component's declaration.
  function pendingTrust() {
    return [...prompted.values()].map((p) => ({
      name: p.name, hash: p.hash, source_hash: p.sourceHash, params: p.params,
      covers: p.covers || {}, exact: p.exact || {},
      requested_at: p.requested_at, root: p.root, params_fp: p.paramsFp, key: p.key,
    }));
  }

  // What `claude-web-chat trust --pack <name>` approves: every service component
  // the named pack installed, in this project or for all projects, each at its
  // CURRENT code, for the identity it has when no exact-valued param is passed —
  // every param it gets display-only or a path inside the project. That is the
  // identity minted for an empty params bag, so it never names a pending
  // exact-valued request (an `unfenced:true` file-editor, a path outside the
  // project): those keep their own keys and `trust <name> --params-fp`.
  //
  // Read-only, like pendingTrust(): the keys come from here, so the identity is
  // still minted in one place, and the CLI writes the grant. Nothing needs to be
  // open or pending.
  //
  // WHAT THE PACK INSTALLED comes only from records this machine wrote:
  //   * for all projects — the user-tier record (~/.web-chat/packs.json);
  //   * for this project — the ledger (lib/packs/store), the user-tier account
  //     the install pipeline keeps of every project install.
  // Never from the project's own record (.web-chat/packs.json): a repository
  // can commit one naming any pack, any source and any digests (it ships the
  // files too, so they agree with themselves), and it used to be read first —
  // offering the repository's code as the pack's, under its claimed version and
  // "sha256 verified", while silently dropping the same-named unit of the
  // user's real install. A component that record names and the ledger does not
  // is listed as skipped, with the reason.
  //
  // A component is offered only when what would run here is bytes this
  // machine installed: the copy that resolves here is the one the trusted
  // record covers, its service.js and meta.json (the declaration) still hash to
  // what that record says was written, and no second copy sits behind it — a
  // project copy shadowing one installed for all projects is a choice between
  // two installs that one confirmation must not make. And a pack installed both
  // here and for all projects from two different sources has no single
  // provenance at all, so nothing of it is offered.
  //
  // Returns { pack: null } for a pack installed in neither tier, else
  //   { pack: { name, installs: [{ tier, recorded, version, source, actor }] },
  //     requests: [{ name, tier, source_url, actor, hash, source_hash, params,
  //                  covers, exact, params_fp, key, root, decision }],
  //     skipped: [{ name, reason }] }
  // An install with `recorded: false` is a project record no install on this
  // machine wrote; its version and source are not repeated. `decision` is
  // 'approved', 'denied' or null for what the trust file already holds.
  function packRequests(name) {
    const root = paths.root;
    const forAll = findPack(root, name, 'system');
    const projectRecord = findPack(root, name, 'local');
    if (!forAll && !projectRecord) return { pack: null, requests: [], skipped: [] };
    const ledger = projectRecord ? findLedgerEntry(root, name) : null;

    const installs = [];
    if (projectRecord) {
      installs.push(ledger
        ? { tier: 'local', recorded: true, version: ledger.version || null, source: ledger.source || null, actor: ledger.actor || null }
        : { tier: 'local', recorded: false });
    }
    if (forAll) {
      const rec = forAll.pack;
      installs.push({ tier: 'system', recorded: true, version: rec.version || null, source: rec.source || null, actor: rec.actor || null });
    }

    // name -> Map(path -> sha256) of the service components a unit list names.
    // A unit name that is not a component name names no component — and it is
    // never echoed back, since the CLI prints what this returns.
    const serviceUnits = (units) => {
      const out = new Map();
      for (const unit of Array.isArray(units) ? units : []) {
        if (!unit || unit.kind !== 'component' || !isComponentName(unit.name) || out.has(unit.name)) continue;
        const files = new Map((Array.isArray(unit.files) ? unit.files : [])
          .filter((f) => f && typeof f.path === 'string').map((f) => [f.path, f.sha256]));
        if (files.has('service.js')) out.set(unit.name, files);
      }
      return out;
    };
    const fromAll = serviceUnits(forAll && forAll.pack.units);
    const fromLedger = serviceUnits(ledger && ledger.units);
    const claimedOnly = new Set([...serviceUnits(projectRecord && projectRecord.pack.units).keys()]
      .filter((n) => !fromLedger.has(n)));
    const urlOf = (src) => (src && typeof src.url === 'string' ? src.url : null);
    const conflict = Boolean(forAll && ledger && urlOf(forAll.pack.source) !== urlOf(ledger.source));

    const trusted = readTrusted();
    const requests = [];
    const skipped = [];
    for (const unitName of new Set([...fromLedger.keys(), ...fromAll.keys(), ...claimedOnly])) {
      const skip = (reason) => skipped.push({ name: unitName, reason });
      if (conflict) {
        skip(`"${name}" is installed for this project and for all projects from different sources, so neither is approved here as the pack`);
        continue;
      }
      const info = serviceInfo(paths, unitName);
      if (!info || !info.exists) { skip('its service.js is not on disk'); continue; }
      let recorded = null;
      let install = null;
      if (info.tier === 'local') {
        // The project's copy is what runs here.
        if (componentTiers(paths, unitName).includes('system')) {
          skip('a copy in this project shadows the one installed for all projects; one confirmation must not choose between them');
          continue;
        }
        if (fromLedger.has(unitName)) { recorded = fromLedger.get(unitName); install = { tier: 'local', source: ledger.source, actor: ledger.actor }; }
        else if (claimedOnly.has(unitName)) { skip(NOT_RECORDED); continue; }
        else { skip("a project component of the same name shadows the pack's here"); continue; }
      } else {
        // The copy installed for all projects is what runs here.
        if (fromAll.has(unitName)) { recorded = fromAll.get(unitName); install = { tier: 'system', source: forAll.pack.source, actor: forAll.pack.actor }; }
        else if (claimedOnly.has(unitName)) { skip(NOT_RECORDED); continue; }
        else { skip('the copy this pack installed in this project is not on disk'); continue; }
      }
      // The digests serviceInfo took of the very bytes the identity is minted
      // from — not a second read, which a swap in between could answer for. A
      // file the record never listed counts as changed: a meta.json written
      // after the install is a declaration the pack did not ship.
      const now = { 'service.js': info.hash, 'meta.json': info.metaHash };
      const changed = IDENTITY_FILES.filter((f) => (recorded.get(f) || null) !== now[f]);
      if (changed.length) {
        skip(`${changed.join(' and ')} changed since the pack installed it`);
        continue;
      }
      const d = mintIdentity({ root, sourceHash: info.hash, schema: info.params_schema, params: {} });
      const held = trusted[d.key];
      requests.push({
        name: unitName, tier: install.tier, source_url: urlOf(install.source), actor: install.actor || null,
        hash: d.hash, source_hash: info.hash, params: d.params, covers: d.covers, exact: d.exact,
        params_fp: d.paramsFp, key: d.key, root,
        decision: held ? (held.approved === false ? 'denied' : 'approved') : null,
      });
    }
    return { pack: { name, installs }, requests, skipped };
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

  return { attach, setViewers, pendingTrust, packRequests, refreshTrust, scheduleReconcile, reconcile, stopAll, _children: children, _isTrusted: isTrusted, _prompted: prompted, _failed: failed };
}

module.exports = {
  createServiceSupervisor, serviceParams, paramsFingerprint, trustKey,
  trustDeclaration, codeHash, identityParams, insideProject, passProofs, mintIdentity,
  MAX_PATH_VALUE, MAX_PATH_DEPTH, PROOFS_PER_PASS,
};
