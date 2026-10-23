'use strict';
// The report path (annotation engine, PLAN.md 2B.1; DECISIONS.md A3, B6 = b,
// ruling U311@qualifier-mechanism = a): the one holder of what a live viewer
// says its resolver answered for the elements anchored on a pane or a markdown
// item — exact, re-resolved or orphaned — and of the per-surface counter every
// such answer is ordered by.
//
//   createReports({state, graph, bus, audience, answerSurface, now, log}) → ctx.reports
//     surface()      the counter (state.surface): stamped on hello and reset by
//                    ws.js's two snapshot frames (element-projection surfaceOf)
//     bump()         +1, empties the held table; called once, at the top of
//                    ws.js broadcastReset, so every reset (Set active, Branch,
//                    Wipe, New graph) carries a new value
//     accept(msg, {viewer, peer, device, transport, bytes})
//                    the one entry both halves use: the local socket's `report`
//                    message (transport 'socket', local peers only) and U312's
//                    remote answer kind (transport 'answer', peer 'remote')
//     recordable({specOf, storeDigest})
//                    the held answers whose daemon-stamped qualifier matches the
//                    node being recorded (U313, at commit); never a live-only one
//     answers({mount})  copies of the held answers, for the tests and the gate
//     stats()        {surface, held, live_only, accepted, confirms, refused,
//                    dropped_items, evicted, stamped_after_store_change}
//     start() / stop()  the seams U312 fills; stop drops the store subscription
//
// THE COUNTER. state.surface is seeded here from the wall clock in ms, so a
// value never repeats across restarts of one root's daemon and no report made
// against an earlier daemon's surface can match a fresh one; it moves only by
// bump(). Nothing else writes it, and no snapshot, draft or dirty check reads
// it. A report echoes it: an older one is `stale-surface`, a newer one
// `unknown-surface`. A report carries no node id, and none is refused for its
// node (B6 = b): a restore, a Wipe or a New graph resets gens (a restored
// record carries none, a cleared id re-renders at 0 — D18), and the counter is
// what tells a pre-reset answer from a post-reset one.
//
// THE MESSAGE, a `report` socket message: {type, surface, mounts: [{mount,
// gen, items: [{id, v, state, how?, why?, tie?, record?}]}]}, one per change
// per viewer, batched across mounts. `items: []` is a CONFIRM: the viewer
// re-resolved that mount after a store change and nothing moved; it re-stamps
// that viewer's held answers for the mount with the store now. Caps: MAX_MOUNTS
// mounts, MAX_ITEMS items per mount, MAX_BYTES per message; how/why strings of
// at most MAX_CODE characters, tie a finite number, record a plain object of at
// most MAX_RECORD bytes as JSON whose `mount` is the item's mount. An item's
// id@v must be a version the element store holds, anchored on that mount.
// `hidden` and every drawing state are refused (C-8: a hidden element is never
// reported): an item's state is one of the resolver's three answers.
//
// THE QUALIFIER IS THE DAEMON'S (notes-B Q1, ruling U311@qualifier-mechanism):
// on acceptance each answer is stamped qual {spec, store} — spec the live
// item's content hash (paneSpec = lineage specHash, which the viewer resolved
// against because its gen equals the report's; markdownSpec for a markdown
// item), store the store's digest (storeDigest). U313 records an answer for a
// node only when both match that node. The residual — a report racing a store
// write on the wire is stamped with the newer store until the viewer's
// re-resolve replaces it (at most one round trip) — is counted, as an upper
// bound, in stats().stamped_after_store_change.
//
// THE REPLACE RULE, per (mount, id@v), ordered by the key (surface, gen,
// storeEpoch — the count of store events at acceptance): a newer key replaces;
// an equal key replaces only when it is the same viewer's; another viewer at an
// equal key never does, so two viewers that disagree never flap the held
// answer (C-9's prototype rule).
//
// A pane (or markdown item) whose owner is service:<name> is held live_only and
// never recordable (P-11; GT-06).
//
// NOTHING HERE EMITS: no ring entry, no ws frame, no file write. A report is not
// activity and never wakes Claude; SNAPSHOT_FIELDS, snapshotView, nodeViewKey
// and liveIsDirty never see it (S-15). The table is bounded (MAX_HELD answers,
// the least recently reported mount's dropped first, counted `evicted`).
//
// C-15-1: a pane script runs in the chrome's realm and can open its own local
// socket and send a report (GT-15's in-realm residual). The surface/gen checks
// and the daemon-stamped qualifier bound it to an answer for the current
// content — never a node, a version or the store — and no rule here treats
// pane:<id> or user as a boundary. C-15-2: no rule here is enforced on claude,
// service or driver. C-15-3: `source` is attribution, not authorization.

const { specHash } = require('./lineage');
const { stableHash } = require('../../core/stable-json');
const { ANCHOR_STATES } = require('../../core/anchor-states');

// The resolver's three answers (core/anchors stateOf: exact, re-resolved,
// orphaned) are the vocabulary's first three, in its contract order; every
// later state (hidden, the drawing states) is never a report.
const REPORT_STATES = new Set(ANCHOR_STATES.slice(0, 3));

const MAX_MOUNTS = 200;
const MAX_ITEMS = 500;
const MAX_BYTES = 256 * 1024;
const MAX_CODE = 32;
const MAX_RECORD = 4 * 1024;
const MAX_HELD = 5000;
const MAX_ID = 200;
// A report accepted this soon after a store write, from a viewer that has not
// reported since that write, may have been resolved before the write reached
// it: it is counted in stamped_after_store_change (an upper bound).
const RACE_WINDOW_MS = 2000;
const MAX_VIEWERS = 256;

// Which peers each transport takes. The socket is local-only (a remote viewer
// at full reports through U312's answer kind, which checks its own level).
const PEERS = Object.freeze({ socket: new Set(['local']), answer: new Set(['remote']) });

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isPosInt = (n) => Number.isSafeInteger(n) && n > 0;
const isGen = (n) => Number.isSafeInteger(n) && n >= 0;

// The qualifier's three hashes, exported so U313 computes a committed node's
// side exactly as acceptance computed the live one.
const paneSpec = (rec) => specHash(rec);
const markdownSpec = (text) => stableHash({ md: typeof text === 'string' ? text : '' });
const storeDigest = (store) => stableHash(store || {});

function jsonBytes(v) {
  try { return Buffer.byteLength(JSON.stringify(v)); } catch { return Infinity; }
}

function createReports({ state, graph, bus, audience = null, answerSurface = null, now = Date.now, log = () => {} } = {}) {
  if (!state) throw new TypeError('createReports: state is required');
  // The remote half (U312) reaches these (each a getter or a value); unused
  // by the local half.
  void audience; void answerSurface; void log;

  state.surface = Math.floor(Number(now())) || 0;

  // mount → Map<'id@v', answer>; the Map's own order is the eviction order (a
  // mount reported again moves to the end).
  const held = new Map();
  let heldCount = 0;
  const viewers = new Map(); // viewer → the store epoch at its last accepted message
  const counts = { accepted: 0, confirms: 0, evicted: 0, stamped_after_store_change: 0 };
  const refused = {};
  const dropped = {};
  const bumpOf = (o, k) => { o[k] = (o[k] || 0) + 1; };

  // The store's epoch (a count of store events) and its memoised digest. The
  // memo is also keyed on the store object, so a wholesale replacement (a
  // restore) that emits no store event still misses it.
  let storeEpoch = 0;
  let lastStoreAt = null;
  let memo = null;
  const off = bus && typeof bus.subscribe === 'function'
    ? bus.subscribe((e) => {
      if (e && e.kind === 'store') { storeEpoch += 1; lastStoreAt = Number(now()); memo = null; }
    })
    : null;
  let unsubscribed = false;
  function currentStore() {
    if (!memo || memo.epoch !== storeEpoch || memo.obj !== state.store) {
      memo = { epoch: storeEpoch, obj: state.store, digest: storeDigest(state.store) };
    }
    return memo.digest;
  }

  const surface = () => state.surface;

  function bump() {
    state.surface = (Number.isSafeInteger(state.surface) ? state.surface : 0) + 1;
    held.clear();
    heldCount = 0;
    memo = null;
    return state.surface;
  }

  // The live item a mount id names, as {rec, spec, gen, liveOnly}, or null.
  function liveItem(mount) {
    const pane = state.mounts && state.mounts.get(mount);
    if (pane) {
      return {
        gen: isGen(pane.gen) ? pane.gen : 0,
        spec: () => paneSpec(pane),
        liveOnly: typeof pane.owner === 'string' && pane.owner.startsWith('service:'),
      };
    }
    const md = state.markdown && state.markdown.get(mount);
    if (md) {
      return {
        gen: isGen(md.gen) ? md.gen : 0,
        spec: () => markdownSpec(md.text),
        liveOnly: typeof md.owner === 'string' && md.owner.startsWith('service:'),
      };
    }
    return null;
  }

  function versionAnchoredOn(id, v, mount) {
    const els = graph && graph.elements;
    if (!els || typeof els.version !== 'function') return 'unknown-version';
    let rec = null;
    try { rec = els.version(id, v); } catch { rec = null; }
    if (!rec) return 'unknown-version';
    const a = isObj(rec.payload) ? rec.payload.anchor : null;
    return isObj(a) && a.mount === mount ? null : 'other-mount';
  }

  // One item → a clean answer body, or the reason it is dropped.
  function cleanItem(it, mount) {
    if (!isObj(it) || typeof it.id !== 'string' || !it.id || it.id.length > MAX_ID || !isPosInt(it.v)) return { drop: 'shape' };
    if (!REPORT_STATES.has(it.state)) return { drop: 'state' };
    const out = { id: it.id, v: it.v, state: it.state };
    for (const k of ['how', 'why']) {
      if (it[k] === undefined) continue;
      if (typeof it[k] !== 'string' || it[k].length > MAX_CODE) return { drop: 'shape' };
      out[k] = it[k];
    }
    if (it.tie !== undefined) {
      if (typeof it.tie !== 'number' || !Number.isFinite(it.tie)) return { drop: 'shape' };
      out.tie = it.tie;
    }
    if (it.record !== undefined) {
      const r = it.record;
      if (!isObj(r) || r.mount !== mount || jsonBytes(r) > MAX_RECORD) return { drop: 'record' };
      out.record = JSON.parse(JSON.stringify(r));
    }
    const bad = versionAnchoredOn(it.id, it.v, mount);
    if (bad) return { drop: bad };
    return { item: out };
  }

  // (surface, gen, storeEpoch), lexicographically.
  function cmpKey(a, b) {
    return (a.surface - b.surface) || (a.gen - b.gen) || (a.storeEpoch - b.storeEpoch);
  }

  function touchMount(mount) {
    let m = held.get(mount);
    if (m) held.delete(mount);
    else m = new Map();
    held.set(mount, m);
    return m;
  }

  function evict() {
    while (heldCount > MAX_HELD && held.size) {
      const [oldest, m] = held.entries().next().value;
      heldCount -= m.size;
      counts.evicted += m.size;
      held.delete(oldest);
    }
  }

  function refuse(reason) { bumpOf(refused, reason); return { ok: false, refused: reason }; }

  function accept(msg, { viewer = null, peer = null, device = null, transport = 'socket', bytes } = {}) {
    const allowed = PEERS[transport];
    if (!allowed || !allowed.has(peer)) return refuse('peer');
    const size = Number.isFinite(bytes) ? bytes : jsonBytes(msg);
    if (size > MAX_BYTES) return refuse('too-large');
    if (!isObj(msg) || !Array.isArray(msg.mounts) || !Number.isSafeInteger(msg.surface)) return refuse('shape');
    if (msg.mounts.length > MAX_MOUNTS) return refuse('too-many-mounts');
    if (msg.surface < state.surface) return refuse('stale-surface');
    if (msg.surface > state.surface) return refuse('unknown-surface');

    const at = Number(now());
    const src = { peer, device: device === 'mobile' || device === 'desktop' ? device : null };
    const store = currentStore();
    const epoch = storeEpoch;
    // The race the qualifier cannot see (ruling U311@qualifier-mechanism): a
    // store write this viewer has not reported since, landed a moment ago. A
    // viewer's first report counts too: it may have resolved before the write.
    const seen = viewer != null ? viewers.get(viewer) : undefined;
    const raced = lastStoreAt != null && at - lastStoreAt <= RACE_WINDOW_MS && (seen === undefined || seen < epoch);

    let accepted = 0;
    let confirmed = 0;
    for (const entry of msg.mounts) {
      if (!isObj(entry) || typeof entry.mount !== 'string' || !entry.mount || !isGen(entry.gen) || !Array.isArray(entry.items)) {
        bumpOf(refused, 'shape');
        continue;
      }
      const { mount, gen, items } = entry;
      if (items.length > MAX_ITEMS) { bumpOf(refused, 'too-many-items'); continue; }
      const live = liveItem(mount);
      if (!live) { bumpOf(refused, 'not-live'); continue; }
      if (gen < live.gen) { bumpOf(refused, 'stale-gen'); continue; }
      if (gen > live.gen) { bumpOf(refused, 'unknown-gen'); continue; }
      const key = { surface: state.surface, gen, storeEpoch: epoch };
      const qual = { spec: live.spec(), store };

      if (items.length === 0) {
        // A confirm: this viewer's answers for the mount stand for the store now.
        const m = held.get(mount);
        if (m) {
          for (const a of m.values()) {
            if (a.viewer !== viewer || a.gen !== gen) continue;
            a.qual = { ...qual };
            a.storeEpoch = epoch;
            a.at = at;
          }
        }
        confirmed += 1;
        continue;
      }

      let m = null;
      for (const raw of items) {
        const { item, drop } = cleanItem(raw, mount);
        if (drop) { bumpOf(dropped, drop); continue; }
        if (!m) m = touchMount(mount);
        const k = `${item.id}@${item.v}`;
        const prev = m.get(k);
        if (prev) {
          const c = cmpKey(key, prev);
          if (c < 0 || (c === 0 && prev.viewer !== viewer)) { bumpOf(dropped, 'outranked'); continue; }
        }
        m.set(k, {
          mount, ...item, ...key, qual: { ...qual }, source: { ...src },
          live_only: live.liveOnly, viewer, at,
        });
        if (!prev) heldCount += 1;
        accepted += 1;
        if (raced) counts.stamped_after_store_change += 1;
      }
      if (m && m.size === 0) held.delete(mount);
    }
    evict();
    counts.accepted += accepted;
    counts.confirms += confirmed;
    if (viewer != null && (accepted || confirmed)) {
      viewers.delete(viewer);
      viewers.set(viewer, epoch);
      while (viewers.size > MAX_VIEWERS) viewers.delete(viewers.keys().next().value);
    }
    return { ok: accepted + confirmed > 0, accepted, confirmed, surface: state.surface };
  }

  // A held answer as the outside reads it: no viewer handle.
  function view(a) {
    const { viewer, ...rest } = a;
    return JSON.parse(JSON.stringify(rest));
  }

  function answers({ mount } = {}) {
    const out = [];
    for (const [id, m] of held) {
      if (mount != null && id !== mount) continue;
      for (const a of m.values()) out.push(view(a));
    }
    return out;
  }

  // U313's read at commit: specOf(mount) → the committed node's content hash
  // for that item (paneSpec / markdownSpec of its record; null when the node
  // has none), storeDigest the node's store digest (storeDigest).
  function recordable({ specOf, storeDigest: digest } = {}) {
    if (typeof specOf !== 'function' || typeof digest !== 'string') return [];
    const out = [];
    for (const [mount, m] of held) {
      let spec;
      try { spec = specOf(mount); } catch { spec = null; }
      if (typeof spec !== 'string') continue;
      for (const a of m.values()) {
        if (a.live_only || a.qual.spec !== spec || a.qual.store !== digest) continue;
        out.push(view(a));
      }
    }
    return out;
  }

  function stats() {
    let liveOnly = 0;
    for (const m of held.values()) for (const a of m.values()) if (a.live_only) liveOnly += 1;
    return {
      surface: state.surface,
      held: heldCount,
      live_only: liveOnly,
      accepted: counts.accepted,
      confirms: counts.confirms,
      refused: { ...refused },
      dropped_items: { ...dropped },
      evicted: counts.evicted,
      stamped_after_store_change: counts.stamped_after_store_change,
    };
  }

  function start() {}
  function stop() {
    if (unsubscribed) return;
    unsubscribed = true;
    if (typeof off === 'function') { try { off(); } catch {} }
  }

  return { surface, bump, accept, answers, recordable, stats, start, stop };
}

module.exports = {
  createReports, paneSpec, markdownSpec, storeDigest,
  REPORT_STATES, MAX_MOUNTS, MAX_ITEMS, MAX_BYTES, MAX_CODE, MAX_RECORD, MAX_HELD, RACE_WINDOW_MS,
};
