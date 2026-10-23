// The chrome's half of the report path (annotation engine PLAN.md 2B.1; U311 is
// the daemon's half, lib/server/domain/reports.js): what this viewer's resolver
// answered for the elements anchored on the live page — exact, re-resolved or
// orphaned — batched into `report` messages, one per change per viewer.
//
//   initOverlayReport({overlay, send, now, timers}) → {stop, stats}
//       overlay  the overlay's seams (public/app/overlay.js: onAnswers,
//                elementsOf, surfaceOf); default the module itself
//       send     the socket's send (public/app/ws.js send)
//       now      the clock the mount grace is read against (Date.now)
//       timers   {setTimeout, clearTimeout, raf}: the quiet window's frames
//   setReportTransport(fn) → unregister
//       a remote page's carrier (U312): fn({type: 'report', surface, mounts})
//       takes every batch; a remote page with none registered reports nothing
//
// WHERE THE ANSWERS COME FROM. The overlay's onAnswers seam, after each pass it
// delivers (a settle's, a set change's, a markdown item's) and after U303's
// hidden probe: {mount, scope, surface, gen, items: [{id, v, state, how, tie,
// why, el}]}. Only scope 'live' is read; a previewed node is a committed node,
// never the live surface (P-17), so nothing is sent while the chrome previews
// (mounts.js contentReadOnly). No `cfg` is ever handed to the overlay or the
// resolver: what is reported is what the pinned row config (DECISIONS.md H2)
// answers, the config the C-8 clause measured.
//
// THE ECHO (RULED 2B@replace-key = b). Every report echoes the `surface` the
// last hello or reset carried (U311's per-surface counter, bumped on every
// reset) and each mount's gen. A delivery whose `surface` is not the current
// one began before the last hello or reset and is DROPPED, and so is one whose
// resolved elements are no longer in the mount's current root (a pass begun on
// a DOM a reset replaced): answers computed on an old DOM are never stamped
// with the new counter (the D18 confusion). There is no node id in a report and
// no active-node test here. The gen is the daemon's re-render counter, learned
// from the frames that carry it (render and markdown frames, the pane and
// markdown records of hello and reset; absent reads 0) — the overlay's own
// `gen` is the root's SETTLE generation, a different count. A clear or a
// markdown:remove forgets the item: a mount with no known gen is not live and
// nothing is sent for it.
//
// THE QUALIFIER IS THE DAEMON'S (RULED U311@qualifier-mechanism = a): the chrome
// computes no hash. The daemon stamps each answer on acceptance; after a store
// write, each watched mount's next pass sends a CONFIRM (`items: []`) — at
// most one per store change per viewer, folded into the same message — so its
// held answers are re-stamped with the store now. When that pass also changed
// answers, the confirm is the entry right ahead of the mount's items, in the
// same message: the unchanged answers are re-stamped, then the changed ones
// replaced (a store write that moves one row of a store-driven pane).
//
// BATCHING. A delivery is only gathered (per mount, the newest answer per
// id@v); a flush runs after a quiet window of QUIET_FRAMES animation frames
// with no delivery (a frame is requestAnimationFrame, or FRAME_FALLBACK_MS when
// a background tab gives no frames). A flush sends, for every touched mount,
// the items whose answer (state, how, why, tie) or gen differs from what this
// viewer last sent for that id@v — so an answer that changes and changes back
// inside the window is never sent, and a re-render (a new gen) re-sends the
// mount's answers once under its new gen. A mount still inside its mount grace
// (overlay-hidden.js MOUNT_GRACE_MS) with a hidden answer is held until the
// grace's own re-settle answers it (or the grace runs out): a removed element
// reads hidden 'mounting' first and orphaned after, and the two go as ONE
// report. A message carries at most MAX_MOUNTS mounts, MAX_ITEMS items and
// MAX_BYTES of JSON; a larger batch is split, one mount's chunk included (the
// daemon refuses an over-cap message whole). Timers are setTimeout and
// requestAnimationFrame only, each armed for one quiet window and never
// re-armed while nothing is pending: no setInterval, no perpetual poller.
//
// WHAT IS SENT: exact, re-resolved and orphaned (the resolver's three answers,
// the vocabulary's first three). `hidden` and every drawing state never are
// (C-8: a hidden element is never reported; a removed one always reads
// orphaned). A `tie` goes only as the finite number the daemon takes.
//
// THE SOCKET. Reports never ride the outbox: while the socket is not live (the
// chrome bus's `conn` other than 'live') nothing is sent and the module waits
// for the next hello, which re-reports every watched mount's current answers
// once (a hello is a change). The outbox's 100-frame log is shared with events
// and script errors, which a report burst across a laptop sleep would evict,
// and a report held across a gap is refused as stale anyway. This module
// never asks ws.js whether the socket is open (the conventions ratchet).
//
// THE MINTED RECORD (U204's note; PLAN-T2 §2.3). When a stored anchor is a
// converted `pin-locator@1` record answered re-resolved with how 'locator' (an
// exact locator hit), or an engine element record whose rows lack the row head
// answered exact, the full record is minted once per id@v per surface with
// the factory's record(root, el) on the pane's shadow root and sent as that
// item's `record` (U313 keeps it in the side table, never as a version). The
// element is the delivered item's `el`; without one, that record is resolved
// once through window.__wcMount.anchor.resolve.
//
// C-15-1: the module sends only what the overlay resolved, and no rule here
// treats pane:<id> or user as a boundary. C-15-2: no rule here is enforced on
// claude, service or driver. C-15-3: nothing here stamps a source; the
// daemon's source stamp is attribution, not authorization.
import * as overlayApi from './overlay.js';
import { send as wsSend, onFrame, onHello } from './ws.js';
import { view } from './state.js';
import { bus } from './bus.js';
import { onWrite } from './store.js';
import { contentReadOnly, mountState } from './mounts.js';
import { MOUNT_GRACE_MS } from './overlay-hidden.js';
import { isRemote, remoteNow, remoteKnown } from './remote.js';
import anchors from './anchors.js';

// The daemon's caps (lib/server/domain/reports.js MAX_MOUNTS, MAX_ITEMS,
// MAX_BYTES, MAX_CODE, MAX_RECORD); a message stays under each.
export const MAX_MOUNTS = 200;
export const MAX_ITEMS = 500;
export const MAX_BYTES = 200 * 1024;
export const MAX_CODE = 32;
export const MAX_RECORD = 4 * 1024;
// The message's own JSON around its entries ({"type":"report","surface":…,"mounts":[]}),
// a surface of up to 16 digits included.
const ENVELOPE_BYTES = 64;
export const QUIET_FRAMES = 2;
export const FRAME_FALLBACK_MS = 100;
// How long past a mount's grace a held mount waits for the grace's re-settle
// before it is flushed with what it has.
export const GRACE_SLACK_MS = 150;
// How long a mount whose root settled again after its last delivered pass
// waits for that pass before it is flushed with what it has.
export const PASS_WAIT_MS = 1000;

const LOCATOR_FORM = 'pin-locator@1';

// The resolver's three answers, from the one vocabulary (lib/core/anchor-states
// via anchors.js), never spelled as literals here.
function stateOf(name) {
  if (!anchors.STATES || anchors.STATES.indexOf(name) < 0) throw new Error(`overlay-report: the state vocabulary has no ${name}`);
  return name;
}
const EXACT = stateOf('exact');
const RE_RESOLVED = stateOf('re-resolved');
const ORPHANED = stateOf('orphaned');
export const REPORTED_STATES = Object.freeze([EXACT, RE_RESOLVED, ORPHANED]);
const REPORTED = new Set(REPORTED_STATES);

// ── the remote carrier ──────────────────────────────────────────────────────
const transports = [];
export function setReportTransport(fn) {
  if (typeof fn !== 'function') throw new TypeError('setReportTransport: expects a function');
  const entry = { fn };
  transports.push(entry);
  return () => {
    const i = transports.indexOf(entry);
    if (i >= 0) transports.splice(i, 1);
  };
}
const currentTransport = () => (transports.length ? transports[transports.length - 1].fn : null);

const isGen = (n) => Number.isSafeInteger(n) && n >= 0;
const genOf = (r) => (r && isGen(r.gen) ? r.gen : 0);
const keyOf = (id, v) => `${id}@${v}`;
const codeOk = (s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_CODE;
function sigOf(a) {
  return `${a.state}|${codeOk(a.how) ? a.how : ''}|${codeOk(a.why) ? a.why : ''}|${Number.isFinite(a.tie) ? a.tie : ''}`;
}
function bytesOf(v) {
  let s;
  try { s = JSON.stringify(v); } catch { return Infinity; }
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(s).length : s.length * 3;
}

function defaultTimers() {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    raf: (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16)),
  };
}

// The pane's shadow root, or a markdown item's block, by id.
function itemOf(mount) {
  const M = window.__wcMount;
  return M && typeof M.itemEl === 'function' ? M.itemEl(document, mount) : null;
}
function rootOf(mount) {
  const it = itemOf(mount);
  if (!it || !it.el) return null;
  if (it.kind === 'pane') return it.el.shadowRoot || null;
  return it.el;
}
function within(el, root) {
  if (!el || !root) return false;
  if (root.nodeType === 11) return el.getRootNode && el.getRootNode() === root;
  return el.isConnected !== false && typeof root.contains === 'function' && root.contains(el);
}

// Whether a stored anchor's full record is minted from this answer.
function mintable(anchor, a) {
  if (!anchor || typeof anchor !== 'object' || !a) return false;
  if (anchor.form === LOCATOR_FORM) return a.state === RE_RESOLVED && a.how === 'locator';
  if (anchor.kind === 'element' && a.state === EXACT && Array.isArray(anchor.rows)) {
    return anchor.rows.some((r) => !r || typeof r.head !== 'string');
  }
  return false;
}

let active = null;

// One instance at a time: a second init stops the first (each registration is
// undone by stop()).
export function initOverlayReport({ overlay = overlayApi, send = wsSend, now = Date.now, timers } = {}) {
  if (active) active.stop();
  const T = { ...defaultTimers(), ...(timers || {}) };
  const offs = [];

  let surface = typeof overlay.surfaceOf === 'function' ? (overlay.surfaceOf('live') ?? null) : null;
  // No hello since the socket last went down (or since init with no surface).
  let awaitingHello = surface == null || view.conn !== 'live';

  const gens = new Map();          // item id → {gen, kind: 'pane'|'md'}
  const cur = new Map();           // mount → Map<id@v, answer>
  const touched = new Set();       // mounts gathered since the last flush
  const sent = new Map();          // mount → Map<id@v, {sig, gen}>
  const minted = new Set();        // id@v whose record went out on this surface
  const storeSeen = new Set();     // mounts with a store write since their last pass
  const confirmDue = new Set();    // mounts whose pass followed a store write
  const forced = new Set();        // mounts a hello re-reports in full
  const holds = new Map();         // mount → a grace timer handle
  const passGen = new Map();       // mount → {gen, at}: the settle generation of its last delivered pass
  const counts = { deliveries: 0, dropped_surface: 0, dropped_stale: 0, dropped_unknown: 0, messages: 0, items: 0, confirms: 0,
    minted: 0, held_offline: 0, remote_dropped: 0 };
  let lastDeliveryAt = 0;

  // ── the frames ──
  function takeSnapshot(msg) {
    for (const m of Array.isArray(msg && msg.mounts) ? msg.mounts : []) {
      if (m && m.id != null) gens.set(String(m.id), { gen: genOf(m), kind: 'pane' });
    }
    for (const m of Array.isArray(msg && msg.markdown) ? msg.markdown : []) {
      if (m && m.id != null) gens.set(String(m.id), { gen: genOf(m), kind: 'md' });
    }
  }
  function resetGens(msg) {
    gens.clear();
    takeSnapshot(msg);
  }
  function newSurface(s) {
    surface = s == null ? null : s;
    sent.clear();
    minted.clear();
    storeSeen.clear();
    confirmDue.clear();
  }
  function onHelloFrame(msg) {
    resetGens(msg);
    awaitingHello = false;
    if (msg && msg.surface != null && msg.surface !== surface) newSurface(msg.surface);
    // A hello is a change: the kept panes' answers are re-reported once (a
    // reconnect's socket is a new viewer to the daemon, and whatever was
    // gathered while the socket was down goes now).
    for (const m of cur.keys()) { forced.add(m); touched.add(m); }
    arm();
  }
  function onResetFrame(msg) {
    resetGens(msg);
    // A reset replaces the surface: every gathered answer was computed on the
    // DOM it replaced, so none survives; the remounts' passes answer anew.
    newSurface(msg && msg.surface != null ? msg.surface : surface);
    cur.clear();
    touched.clear();
    forced.clear();
    passGen.clear();
    for (const h of holds.values()) T.clearTimeout(h);
    holds.clear();
  }
  function onRender(msg) {
    if (msg && msg.id != null) gens.set(String(msg.id), { gen: genOf(msg), kind: 'pane' });
  }
  function onMarkdown(msg) {
    if (msg && msg.id != null) gens.set(String(msg.id), { gen: genOf(msg), kind: 'md' });
  }
  function forget(id) {
    gens.delete(id);
    passGen.delete(id);
    cur.delete(id);
    touched.delete(id);
    forced.delete(id);
    const h = holds.get(id);
    if (h != null) { T.clearTimeout(h); holds.delete(id); }
  }
  function onClear(msg) {
    if (msg && msg.id != null) { forget(String(msg.id)); return; }
    // A clear of a target or of the page: whichever pane is gone from the live
    // surface (the folded one while previewing) is forgotten.
    const snap = view.previewing && view.liveSnapshot ? new Set(view.liveSnapshot.mounts.map((m) => m.id)) : null;
    for (const [id, g] of [...gens]) {
      if (g.kind !== 'pane') continue;
      const here = snap ? snap.has(id) : !!(itemOf(id) && itemOf(id).kind === 'pane');
      if (!here) forget(id);
    }
  }
  function onMarkdownRemove(msg) {
    if (msg && msg.id != null) forget(String(msg.id));
  }

  offs.push(onHello(onHelloFrame));
  offs.push(onFrame('reset', onResetFrame));
  offs.push(onFrame('render', onRender));
  offs.push(onFrame('markdown', onMarkdown));
  offs.push(onFrame('clear', onClear));
  offs.push(onFrame('markdown:remove', onMarkdownRemove));
  // A store change makes the next pass of each mount this viewer reported
  // confirm-worthy. A store:patch frame is the live store's change, and it
  // counts whether or not a preview is up: the daemon moved its store digest,
  // so the first pass after the preview ends sends the confirm (nothing goes
  // while contentReadOnly()). A pane's own write, outside a preview, reaches
  // the module through store.js's onWrite.
  const markStore = () => { for (const m of sent.keys()) storeSeen.add(m); };
  offs.push(onFrame('store:patch', markStore));
  offs.push(onWrite(() => {
    if (view.previewing) return;
    markStore();
  }));
  const onConn = (d) => {
    if (!d || d.state !== 'live') awaitingHello = true;
  };
  offs.push(bus.on('conn', onConn));
  // Into a preview: the live DOM is folded aside, and on the way back the
  // overlay re-resolves every live mount on the remounted DOM, so what was
  // gathered and not yet sent is dropped (what was SENT is kept: an unchanged
  // answer is not sent again).
  offs.push(bus.on('view', () => {
    if (!view.previewing) return;
    cur.clear();
    touched.clear();
    passGen.clear();
    for (const h of holds.values()) T.clearTimeout(h);
    holds.clear();
  }));

  // ── the deliveries ──
  function stale(msg) {
    // A pass on a DOM a reset or a re-mount replaced: one of its elements is
    // no longer in the mount's current root.
    const root = rootOf(msg.mount);
    for (const it of msg.items) {
      if (it && it.el && !within(it.el, root)) return true;
    }
    return false;
  }
  function onDelivery(msg) {
    if (!msg || msg.scope !== 'live' || msg.mount == null) return;
    if (contentReadOnly()) return;   // nothing at all while a committed node is previewed (P-17)
    if (msg.surface !== surface) { counts.dropped_surface += 1; return; }
    const mount = String(msg.mount);
    // No frame named this item's gen: it is not on the live surface (a clear
    // took it), or this module was initialised after the hello that did.
    if (!gens.has(mount)) { counts.dropped_unknown += 1; return; }
    if (!Array.isArray(msg.items) || !msg.items.length) return;
    if (stale(msg)) { counts.dropped_stale += 1; return; }
    counts.deliveries += 1;
    lastDeliveryAt = Number(now());
    let m = cur.get(mount);
    if (!m) { m = new Map(); cur.set(mount, m); }
    for (const it of msg.items) {
      if (!it || it.id == null || !Number.isSafeInteger(it.v) || it.v <= 0) continue;
      m.set(keyOf(it.id, it.v), { id: String(it.id), v: it.v, state: it.state, how: it.how, why: it.why,
        tie: it.tie, el: it.el || null });
    }
    if (msg.report && Number.isSafeInteger(msg.report.gen)) passGen.set(mount, { gen: msg.report.gen, at: lastDeliveryAt });
    else passGen.delete(mount);
    if (storeSeen.has(mount)) { storeSeen.delete(mount); confirmDue.add(mount); }
    touched.add(mount);
    arm();
  }
  offs.push(overlay.onAnswers(onDelivery));

  // ── the quiet window ──
  let armed = false;
  let quiet = 0;
  let seen = 0;
  let frameHandles = null;
  function frame(fn) {
    let done = false;
    const once = () => { if (done) return; done = true; frameHandles = null; fn(); };
    const r = T.raf(once);
    const t = T.setTimeout(once, FRAME_FALLBACK_MS);
    frameHandles = { r, t };
  }
  function arm() {
    seen = counts.deliveries;
    quiet = 0;
    if (armed) return;
    armed = true;
    frame(step);
  }
  function step() {
    if (!armed) return;
    if (counts.deliveries !== seen) { seen = counts.deliveries; quiet = 0; }
    quiet += 1;
    if (quiet < QUIET_FRAMES) { frame(step); return; }
    armed = false;
    flush();
  }

  // ── the flush ──
  function inGrace(mount) {
    const ms = mountState(mount);
    if (!ms || !ms.complete) return gens.get(mount) && gens.get(mount).kind === 'pane' && !!itemOf(mount);
    return Number(now()) - ms.at < MOUNT_GRACE_MS;
  }
  function graceAt(mount) {
    const ms = mountState(mount);
    return ms && ms.complete && Number.isFinite(ms.at) ? ms.at + MOUNT_GRACE_MS : Number(now()) + MOUNT_GRACE_MS;
  }
  function hold(mount) {
    if (holds.has(mount)) return;
    const wait = Math.max(0, graceAt(mount) - Number(now())) + GRACE_SLACK_MS;
    holds.set(mount, T.setTimeout(() => {
      holds.delete(mount);
      if (!cur.has(mount)) return;
      flushMount.add(mount);
      touched.add(mount);
      arm();
    }, wait));
  }
  const flushMount = new Set();   // mounts whose grace ran out: flushed as they stand

  function mintFor(mount, a, anchor) {
    const root = rootOf(mount);
    if (!root || root.nodeType !== 11) return null;
    let el = a.el && within(a.el, root) ? a.el : null;
    if (!el) {
      const M = window.__wcMount;
      const R = M && M.anchor;
      if (!R || typeof R.resolve !== 'function') return null;
      let ans = null;
      try { ans = R.resolve(root, anchor); } catch { ans = null; }
      el = ans && ans.el && within(ans.el, root) ? ans.el : null;
      if (!el) return null;
    }
    let rec = null;
    try { rec = anchors.record(root, el, { mount }); } catch { rec = null; }
    if (!rec || rec.mount !== mount || bytesOf(rec) > MAX_RECORD) return null;
    return rec;
  }

  function itemFor(a, record) {
    const out = { id: a.id, v: a.v, state: a.state };
    if (codeOk(a.how)) out.how = a.how;
    if (codeOk(a.why)) out.why = a.why;
    if (Number.isFinite(a.tie)) out.tie = a.tie;
    if (record) out.record = record;
    return out;
  }

  let waiting = false;
  function passPending(mount) {
    const p = passGen.get(mount);
    if (!p) return false;
    const root = rootOf(mount);
    const M = window.__wcMount;
    if (!root || root.nodeType !== 11 || !M || typeof M.generation !== 'function') return false;
    if (M.generation(root) <= p.gen) return false;
    return Number(now()) - p.at < PASS_WAIT_MS;
  }

  // The batch: [{mount, gen, items, keys: [[id@v, sig]], confirm}].
  function build() {
    const rows = new Map();
    let rowsRead = false;
    const anchorOf = (id) => {
      if (!rowsRead) {
        rowsRead = true;
        if (typeof overlay.elementsOf === 'function') {
          for (const r of overlay.elementsOf('live')) rows.set(String(r.id), r);
        }
      }
      const r = rows.get(id);
      return r ? r.anchor : null;
    };
    const out = [];
    for (const mount of [...touched]) {
      const g = gens.get(mount);
      const m = cur.get(mount);
      if (!g || !m) { touched.delete(mount); continue; }
      // Gathered per settle generation: a root that settled again since the
      // pass delivered has a pass on its way (each pass takes at least an
      // index frame and a resolve frame, longer than the quiet window), and
      // its answers are what this viewer says next.
      if (passPending(mount)) { waiting = true; continue; }
      const answers = [...m.values()];
      const graceRunOut = flushMount.has(mount);
      if (!graceRunOut && answers.some((a) => !REPORTED.has(a.state)) && g.kind === 'pane' && inGrace(mount)) {
        hold(mount);
        continue;
      }
      flushMount.delete(mount);
      const h = holds.get(mount);
      if (h != null) { T.clearTimeout(h); holds.delete(mount); }
      const had = sent.get(mount);
      const force = forced.has(mount);
      const items = [];
      const keys = [];
      const mints = [];
      for (const a of answers) {
        if (!REPORTED.has(a.state)) continue;
        const k = keyOf(a.id, a.v);
        const sig = sigOf(a);
        const prev = had && had.get(k);
        let record = null;
        if (!minted.has(k)) {
          const anchor = anchorOf(a.id);
          if (mintable(anchor, a)) {
            record = mintFor(mount, a, anchor);
            if (record) mints.push(k);
          }
        }
        if (!force && !record && prev && prev.sig === sig && prev.gen === g.gen) continue;
        items.push(itemFor(a, record));
        keys.push([k, sig]);
      }
      // A confirm whenever a store change preceded this pass, beside the items
      // too: the daemon re-stamps this viewer's held answers for the mount only
      // on an `items: []` entry, so the answers that did not move (sent ahead
      // of the items entry, in the same message) are stamped with the store
      // now and the changed ones then replace theirs (K.2-53).
      const confirm = confirmDue.has(mount) && !!had && had.size > 0;
      out.push({ mount, gen: g.gen, items, keys, mints, confirm });
    }
    return out;
  }

  function commit(entry) {
    const { mount, gen, keys, mints } = entry;
    let had = sent.get(mount);
    if (!had) { had = new Map(); sent.set(mount, had); }
    for (const [k, sig] of keys) had.set(k, { sig, gen });
    for (const k of mints) { minted.add(k); counts.minted += 1; }
    confirmDue.delete(mount);
    forced.delete(mount);
    touched.delete(mount);
  }

  // Split into messages under the caps: MAX_MOUNTS entries, MAX_ITEMS items
  // and MAX_BYTES of JSON each (the envelope and every separator counted). A
  // confirm that goes beside items is the entry right ahead of the mount's
  // first items chunk, in the same message, never split from it. A chunk too
  // large for an empty message is halved until it fits; a single item that
  // alone is over the cap goes alone.
  function messages(entries) {
    const msgs = [];
    let curMsg = null;
    let nItems = 0;
    let nBytes = 0;
    const open = () => { curMsg = []; nItems = 0; nBytes = ENVELOPE_BYTES; msgs.push(curMsg); };
    // Each entry costs its JSON plus the comma before it.
    const costOf = (bodies) => bodies.reduce((n, b) => n + bytesOf(b) + 1, 0);
    open();
    for (const e of entries) {
      if (!e.items.length) {
        const body = { mount: e.mount, gen: e.gen, items: [] };
        const b = costOf([body]);
        if (curMsg.length && (curMsg.length >= MAX_MOUNTS || nBytes + b > MAX_BYTES)) open();
        curMsg.push(body);
        nBytes += b;
        continue;
      }
      let lead = e.confirm ? { mount: e.mount, gen: e.gen, items: [] } : null;
      let part = e.items;
      while (part.length) {
        const slots = lead ? 2 : 1;
        if (curMsg.length && (curMsg.length + slots > MAX_MOUNTS || nItems >= MAX_ITEMS)) { open(); continue; }
        let take = Math.min(part.length, MAX_ITEMS - nItems);
        const group = (n) => (lead ? [lead] : []).concat([{ mount: e.mount, gen: e.gen, items: part.slice(0, n) }]);
        let bodies = group(take);
        let b = costOf(bodies);
        if (nBytes + b > MAX_BYTES) {
          if (curMsg.length) { open(); continue; }
          while (take > 1 && nBytes + b > MAX_BYTES) {
            take = Math.floor(take / 2);
            bodies = group(take);
            b = costOf(bodies);
          }
        }
        for (const body of bodies) curMsg.push(body);
        nItems += take;
        nBytes += b;
        lead = null;
        part = part.slice(take);
      }
    }
    return msgs.filter((m) => m.length);
  }

  function flush() {
    if (awaitingHello || surface == null) { if (touched.size) counts.held_offline += 1; return; }
    if (contentReadOnly()) return;   // previewing: the passes after it arm the next flush
    if (!remoteKnown()) {
      isRemote().then(() => { if (touched.size) arm(); }, () => {});
      return;
    }
    const remote = remoteNow();
    const carrier = remote ? currentTransport() : null;
    waiting = false;
    const built = build();
    if (waiting) arm();   // a pass on its way: look again after another quiet window
    const entries = built.filter((e) => e.items.length || e.confirm);
    // A mount with nothing to say is done; a held one waits for its grace.
    const settled = () => {
      for (const e of built) if (!e.items.length && !e.confirm) { touched.delete(e.mount); forced.delete(e.mount); confirmDue.delete(e.mount); }
    };
    if (!entries.length) { settled(); return; }
    if (remote && !carrier) {
      counts.remote_dropped += 1;
      for (const e of entries) commit({ ...e, keys: [], mints: [] });
      settled();
      return;
    }
    for (const body of messages(entries.map((e) => ({ mount: e.mount, gen: e.gen, items: e.items, confirm: e.confirm })))) {
      const msg = { type: 'report', surface, mounts: body };
      if (carrier) {
        try { carrier(msg); } catch (err) { console.error('[web-chat] overlay-report: the report transport failed', err); }
      } else {
        send(msg);
      }
      counts.messages += 1;
      for (const b of body) {
        counts.items += b.items.length;
        if (!b.items.length) counts.confirms += 1;
      }
    }
    for (const e of entries) commit(e);
    settled();
  }

  function stats() {
    return {
      surface,
      armed,
      holding: holds.size,
      pending: touched.size,
      awaiting_hello: awaitingHello,
      last_delivery_at: lastDeliveryAt,
      ...counts,
    };
  }

  function stop() {
    for (const off of offs.splice(0)) { try { off(); } catch { /* already gone */ } }
    for (const h of holds.values()) T.clearTimeout(h);
    holds.clear();
    if (frameHandles) { T.clearTimeout(frameHandles.t); frameHandles = null; }
    armed = false;
    if (active === inst) active = null;
  }

  const inst = { stop, stats };
  active = inst;
  return inst;
}
