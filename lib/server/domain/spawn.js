// Panes spawning panes (notes.txt) — the policy a pane script's `api.spawn` /
// `api.close` runs under. The WRITES are lib/server/domain/mounts' (setMount /
// removeMount: reserved ids, the markdown id space, the user's lock, the owner
// gate, the gen bump, the paired emit); this module decides only whether a pane
// may make one, and what it is called.
//
// Ownership. A spawned pane is `owner:'pane:<parent>'`. That one stamp is the
// whole relationship, and setMount's existing owner gate enforces it for free:
//   * a parent may re-render (replace) a pane it spawned — same owner;
//   * it may not render over anything else — Claude's panes, a driver's, a
//     sibling's children — because it never passes `force`;
//   * Claude re-rendering or clearing a pane-spawned pane is the ordinary
//     driver-ownership refusal (`owned:true`), with `force:true` as the escape,
//     exactly as for a `service:<name>` pane.
// A pane may close only a pane it spawned, or itself.
//
// Attribution. `parent` is stamped by the chrome's per-pane facade
// (public/app/mounts.js), from the SAME closure-bound mount id the store facade
// stamps on a store write — a pane script calls `api.spawn(spec)` and never
// names its parent. The server additionally requires the parent to be a pane
// that is live on the surface right now. That is the attribution the store
// facade has too, and it is cooperative, not a security fence: every pane runs
// in the one page document and can reach this route with any `parent` it likes
// (as it can reach /api/render). The caps below bound what a runaway script can
// do; they are not a sandbox.
//
// What a pane can NOT do that Claude can: declare wake signals. `params.signals`
// is stripped from every spawn, because the signal registry is derived from all
// live mounts (domain/signals) — a spawned pane declaring `wake:'immediate'`
// would let a pane script wake Claude on its own, or redeclare one of Claude's
// keys over his. No `force`, no `owner`, no `theme`, no `target` either: a child
// lands in its parent's slot.

const { setMount, removeMount, lockReject, ownerReject } = require('./mounts');

// ── caps ────────────────────────────────────────────────────────────────────
// Live children one pane may have at once (re-rendering an existing child does
// not count against it).
const MAX_CHILDREN = 20;
// Pane-spawned panes on the whole surface at once — the bound on a chain, where
// every generation is a new parent with its own MAX_CHILDREN.
const MAX_SPAWNED_TOTAL = 60;
// Generations: a child of a Claude/driver pane is depth 1.
const MAX_DEPTH = 3;
// Spawn + close writes one parent may make per window. Every write is a ring
// event and a WS frame to every browser, so a script re-rendering a child in a
// tight loop would otherwise flood the event ring Claude catches up from.
const RATE_MAX = 30;
const RATE_WINDOW_MS = 10_000;
// The spawned pane's html (raw or a component's source), and its params as JSON.
const HTML_MAX_CHARS = 256 * 1024;
const PARAMS_MAX_CHARS = 16 * 1024;

const OWNER_PREFIX = 'pane:';
const ownerFor = (parent) => OWNER_PREFIX + parent;

function refuse(fields, hint) {
  return { ok: false, rejected: true, ...fields, hint };
}

// Per-state sliding windows of write timestamps, keyed by parent id. Live-only
// (a restart forgets them) and never serialised.
const rateWindows = new WeakMap();
function rateOk(state, parent, now) {
  let byParent = rateWindows.get(state);
  if (!byParent) { byParent = new Map(); rateWindows.set(state, byParent); }
  const recent = (byParent.get(parent) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) { byParent.set(parent, recent); return false; }
  recent.push(now);
  byParent.set(parent, recent);
  return true;
}

// Which generation a live pane is: 0 for a pane Claude or a driver put up, 1 for
// its child, … Walks the owner chain (a parent that has since gone ends it).
function depthOf(state, id) {
  let d = 0;
  const seen = new Set();
  let cur = state.mounts.get(id);
  while (cur && typeof cur.owner === 'string' && cur.owner.startsWith(OWNER_PREFIX) && !seen.has(cur)) {
    seen.add(cur);
    d++;
    cur = state.mounts.get(cur.owner.slice(OWNER_PREFIX.length));
  }
  return d;
}

function childrenOf(state, parent) {
  const owner = ownerFor(parent);
  return [...state.mounts].filter(([, m]) => m.owner === owner).map(([id]) => id);
}

// A new child lands after its parent's last child on the page (or the parent
// itself), so a parent's children read in spawn order beneath it.
function defaultAfter(state, parent) {
  const kids = new Set(childrenOf(state, parent));
  let at = state.order.indexOf(parent);
  state.order.forEach((id, i) => { if (kids.has(id) && i > at) at = i; });
  return at === -1 ? undefined : state.order[at];
}

function nextChildId(state, parent) {
  const taken = (id) => state.mounts.has(id) || (state.markdown instanceof Map && state.markdown.has(id));
  let n = 1;
  while (taken(`${parent}-${n}`)) n++;
  return `${parent}-${n}`;
}

// The parent check both verbs share.
function liveParent(state, parent) {
  if (typeof parent !== 'string' || !parent) return refuse({ no_parent: true }, 'spawn/close must come from a pane on the surface');
  if (!state.mounts.has(parent)) {
    return refuse({ no_parent: true, parent }, `pane '${parent}' is not on the live surface; only a live pane can spawn or close panes`);
  }
  return null;
}

// Put up (or replace) a child of `parent`. `html` is the child's content — the
// route resolves a component name to its source and passes both.
function spawnPane(state, bus, { parent, id, html, params, component, after, place, now = Date.now() } = {}) {
  const bad = liveParent(state, parent);
  if (bad) return bad;
  if (typeof html !== 'string') return refuse({ invalid: true }, 'spawn needs `html` or `component`');
  if (html.length > HTML_MAX_CHARS) {
    return refuse({ too_large: true, limit: HTML_MAX_CHARS }, `spawned html is ${html.length} chars; the cap is ${HTML_MAX_CHARS}`);
  }
  let p = {};
  if (params != null) {
    if (typeof params !== 'object' || Array.isArray(params)) return refuse({ invalid: true }, '`params` must be an object');
    p = { ...params };
  }
  const stripped = 'signals' in p;
  delete p.signals;
  const pj = JSON.stringify(p);
  if (pj.length > PARAMS_MAX_CHARS) {
    return refuse({ too_large: true, limit: PARAMS_MAX_CHARS }, `spawned params are ${pj.length} chars as JSON; the cap is ${PARAMS_MAX_CHARS}`);
  }
  if (id != null && (typeof id !== 'string' || !id || id.length > 200)) {
    return refuse({ invalid: true }, '`id` must be a non-empty string of at most 200 characters');
  }
  if (id === parent) {
    return refuse({ self: true, id }, `a pane cannot spawn onto its own id '${id}'; redraw your own root, or close yourself with api.close()`);
  }
  const childId = id || nextChildId(state, parent);
  const existing = state.mounts.get(childId);
  const owner = ownerFor(parent);
  if (!existing || existing.owner !== owner) {
    // A NEW child (or an attempt on someone else's pane, which setMount's owner
    // gate refuses below) — the population caps apply.
    if (!existing) {
      if (childrenOf(state, parent).length >= MAX_CHILDREN) {
        return refuse({ cap: 'children', limit: MAX_CHILDREN }, `pane '${parent}' already has ${MAX_CHILDREN} spawned panes; close one first`);
      }
      const total = [...state.mounts.values()].filter((m) => typeof m.owner === 'string' && m.owner.startsWith(OWNER_PREFIX)).length;
      if (total >= MAX_SPAWNED_TOTAL) {
        return refuse({ cap: 'total', limit: MAX_SPAWNED_TOTAL }, `the surface already holds ${MAX_SPAWNED_TOTAL} pane-spawned panes`);
      }
      if (depthOf(state, parent) + 1 > MAX_DEPTH) {
        return refuse({ cap: 'depth', limit: MAX_DEPTH }, `pane '${parent}' is itself ${MAX_DEPTH} spawns deep; it cannot spawn further`);
      }
    }
  }
  if (!rateOk(state, parent, now)) {
    return refuse({ cap: 'rate', limit: RATE_MAX, window_ms: RATE_WINDOW_MS }, `pane '${parent}' made ${RATE_MAX} spawn/close writes in ${RATE_WINDOW_MS / 1000}s; slow down`);
  }
  const parentRec = state.mounts.get(parent);
  const r = setMount(state, bus, {
    id: childId,
    html,
    target: parentRec.target || 'main',
    params: p,
    owner,
    component,
    // Omitted: a new child lands beneath its parent's last child; a re-render
    // of an existing one keeps its place (setMount's own rule).
    after: after !== undefined ? after : (existing ? undefined : defaultAfter(state, parent)),
    place,
  });
  if (r.ok && stripped) {
    const w = 'params.signals ignored: only Claude declares wake signals';
    r.warning = r.warning ? `${r.warning}; ${w}` : w;
  }
  return r.ok ? { ...r, parent } : r;
}

// Take a pane off the surface on a pane's behalf: one it spawned, or itself.
function closePane(state, bus, { parent, id, now = Date.now() } = {}) {
  const bad = liveParent(state, parent);
  if (bad) return bad;
  if (typeof id !== 'string' || !id) return refuse({ invalid: true }, 'close needs the id of a pane');
  const m = state.mounts.get(id);
  if (!m) return refuse({ not_found: true, id }, `no pane '${id}' on the live surface`);
  if (id !== parent && m.owner !== ownerFor(parent)) {
    return { ...ownerReject(id, m.owner || 'claude'), hint: `pane '${parent}' may close only panes it spawned, or itself` };
  }
  if (m.pane_state && m.pane_state.locked) return lockReject(id);
  if (!rateOk(state, parent, now)) {
    return refuse({ cap: 'rate', limit: RATE_MAX, window_ms: RATE_WINDOW_MS }, `pane '${parent}' made ${RATE_MAX} spawn/close writes in ${RATE_WINDOW_MS / 1000}s; slow down`);
  }
  removeMount(state, bus, { id, source: ownerFor(parent) });
  return { ok: true, id, parent };
}

module.exports = {
  spawnPane,
  closePane,
  depthOf,
  MAX_CHILDREN,
  MAX_SPAWNED_TOTAL,
  MAX_DEPTH,
  RATE_MAX,
  RATE_WINDOW_MS,
  HTML_MAX_CHARS,
  PARAMS_MAX_CHARS,
};
