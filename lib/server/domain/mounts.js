// The mount-set engine — ONE choke point for putting a pane on the live surface
// and taking it off again.
//
// Putting a pane up is not one write. It is: validate the id against the shell's
// own chrome, refuse a user-LOCKED pane, refuse another writer's pane unless
// forced, carry the pane's persisted state (pane_state / form_state / theme)
// across the replacement, bump the generation counter a queued Revert is stamped
// against, stamp the owner, and emit the paired ring event + WS frame. Four
// routes hand-copied that sequence and each dropped a DIFFERENT part of it:
// /api/components/:name/use had no owner gate, no owner, no gen and no theme
// carry (so a queued Revert's generation guard degraded to delete-if-present and
// the drawer's "owned" hint was unreachable); both capture mount-sets emitted a
// WS frame with no ring entry, so the service supervisor's reconcile subscriber
// was deaf to capture panes. A list fix at one site is re-copied by the next
// route, which is why this is a module and not a review note.
//
// Its three exports own every write to `state.mounts` outside the two BULK restore
// paths (graph.restoreLiveToNode / turns.loadDraft, which replace the whole
// surface at once and broadcast a `reset` instead of per-pane frames) and
// render.js's bulk clear (which owns a pin filter and batched frames).
// test/conventions.test.js ratchets that boundary.

const { normalizeTheme } = require('../theme');
// The page sequence (panes + markdown, one order). Every pane put/remove below
// keeps it exact; see lib/server/domain/page.js.
const page = require('./page');

// ── refusal envelopes ───────────────────────────────────────────────────────
// Soft refusals: HTTP 200 with `ok:false`. Every consumer — Claude's MCP tools,
// the drawer, the ⌘K palette — reads `.ok`, never the status code, and
// lib/server/routes/packs.js documents this shape as the tree's refusal
// convention. A 4xx here would flash nothing in the UI. (A malformed request —
// no `html` — is still a 400: that is a caller bug, not an answer of "no".)

function lockReject(id) {
  return {
    ok: false,
    rejected: true,
    locked: true,
    id,
    hint: `pane '${id}' is locked; user must unlock to allow re-render`,
  };
}

function ownerReject(id, owner) {
  return {
    ok: false,
    rejected: true,
    owned: true,
    id,
    owner,
    hint: `pane '${id}' is owned by '${owner}'; pass force:true to take it over`,
  };
}

function reservedReject(id) {
  return {
    ok: false,
    rejected: true,
    reserved: true,
    id,
    hint: `'${id}' is a reserved shell element id; pick another mount id`,
  };
}

// Normalize the requester's identity. Claude (the MCP render tool) sends no
// owner and is treated as 'claude'; drivers send 'service:<name>'. Stored as a
// string so it rides into committed graph nodes (see graph.snapshotLive).
function normalizeOwner(owner) {
  if (owner == null) return 'claude';
  return String(owner);
}

// ── reserved ids ────────────────────────────────────────────────────────────
// A mount id is agent-supplied text and 'main', 'status', 'overlay', 'dock' are
// all plausible ids for Claude to pick. The browser shell resolves its own
// chrome live by element id, so a pane host that claimed one won every later
// lookup of it — and because the mount persists in state.mounts AND in every
// committed node, `hello` replayed the damage on every reload.
//
// The client half of that fence landed first (public/app/mounts.js keeps the id
// in a dataset unless it is free, sweeps only `.mount-host` elements, and
// resolves `target` against a slot allowlist) and it is the half that covers
// history — a bad id already committed in a node is replayed by graph.js →
// ws.js with no server involvement. This is the other half: it stops the bad id
// from being written down in the first place, on every path that writes one.
//
// Every id below is DERIVED, not transcribed — test/mount-engine.test.js reads
// the sources and fails if this set falls behind any of them, so no half of it
// can drift as the chrome grows:
//   * the static ids in public/index.html;
//   * the ids the shell creates LAZILY, scanned as `id="…"` / `.id = '…'`
//     literals out of public/app/*.js (the lazy half used to be a hand list
//     pinned by a test repeating the same hand list — circular, and it fell four
//     behind: the graph inspector's gv-* ids);
//   * the chrome of the OTHER two documents a mount host is written into —
//     the export shell (lib/server/export.js) and the glance preview
//     (lib/server/preview.js). Both do `host.id = m.id` unconditionally,
//     with none of the live shell's free-id check, so reserving their ids here
//     is what stops a pane called `export-main` from duplicating an id in the
//     exported page.
//
// Only ids a HELPER builds from a non-literal (theme.js's two <style> tags) stay
// hand-listed, plus the cmd-opt-<n> family below; the test labels them as the
// residue the scan cannot see.
//
// `target` is deliberately NOT validated here: the client resolves it against a
// slot allowlist and falls back to 'main', so an unknown target can only ever
// land in the surface — and tests legitimately render into a non-slot target.
const RESERVED_IDS = new Set([
  // public/index.html (static chrome)
  'active-pill', 'bookmark-name', 'brand-msg', 'brand-slots', 'bookmark-pop', 'btn-add', 'btn-bookmark',
  'btn-bookmark-save', 'btn-branch', 'btn-down', 'btn-graph', 'btn-gv-name-cancel',
  'btn-gv-name-go', 'btn-more', 'btn-new-graph-cancel', 'btn-new-graph-go',
  'btn-pin-mode', 'btn-return-active', 'btn-set-active-here', 'btn-theme-toggle',
  'btn-up', 'btn-update-dismiss', 'btn-wipe-cancel', 'btn-wipe-go', 'cmd-input',
  'cmd-list', 'cmd-palette', 'cmd-trigger', 'dock', 'drawer', 'drawer-close',
  'drawer-library', 'drawer-manage', 'drawer-tab-library', 'drawer-tab-manage',
  'drawer-tabs', 'drawer-title', 'graph-svg', 'gv-collapsed-n', 'gv-compare',
  'gv-filters', 'gv-graphsel', 'gv-history-list', 'gv-inspector', 'gv-jump',
  'gv-mode', 'gv-name-hint', 'gv-name-input', 'gv-name-panel', 'gv-name-title',
  'gv-scope', 'gv-show-collapsed', 'gv-status-active', 'gv-status-counts',
  'gv-turncount', 'gv-zoom-in', 'gv-zoom-out', 'gv-zoom-pct', 'key-legend',
  'main', 'minbar', 'more-menu', 'new-graph-name', 'new-graph-panel', 'node-label',
  'overlay', 'overlay-close', 'overlay-fit', 'queue-rail', 'rail-add',
  'replay-pop', 'rpo-captions', 'rpo-close', 'rpo-download', 'rpo-frame', 'rpo-from',
  'rpo-gif', 'rpo-mp4', 'rpo-note', 'rpo-open', 'rpo-speed', 'rpo-to', 'rpo-transition',
  'rpo-webm',
  'sessions-list', 'sessions-meta', 'sessions-panel',
  'settings-panel', 'settings-theme', 'stage', 'status', 'topbar',
  'ub-release-link', 'update-banner', 'wipe-name', 'wipe-panel',
  // Created lazily by the shell, so absent from index.html.
  'branch-picker',        // public/app/topbar.js — built per open
  'reaim-note',           // public/app/topbar.js — the queued-re-aim notice
  'wc-theme-global-css',  // public/app/theme.js — the two raw-CSS <style> tags
  'wc-theme-node-css',
  'pk-url',               // public/app/drawer.js — the pack-install form
  'pk-global',
  'service-trust',        // public/app/service-trust.js — the approval notice
  'pin-layer',            // public/app/comments.js — the comment-pin overlay
  'gv-preview',           // public/app/graph-view.js — the inspector, built per open
  'gv-diff',
  'gv-diff-sect',
  'gv-set-active',
  'brand-logotype',       // public/app/brand.js — the topbar logotype, only while set
  'rpo-render-file',      // public/app/replay.js — the rendered GIF/video's link
  // The export shell's own chrome (lib/server/export.js). Not the live surface,
  // but the exported page writes every pane host with `host.id = m.id`, so a
  // mount holding one of these names would duplicate the id in the export.
  'export-head', 'export-main', 'export-empty', 'export-foot', 'wc-export-data',
]);

// The ⌘K palette numbers its rows `cmd-opt-<n>` (public/app/shell.js), so that
// reserved id is a family rather than a literal.
const RESERVED_ID_PATTERNS = [/^cmd-opt-\d+$/];

function isReservedId(id) {
  const s = String(id == null ? '' : id);
  return RESERVED_IDS.has(s) || RESERVED_ID_PATTERNS.some((re) => re.test(s));
}

// ── shell-interpreted params ────────────────────────────────────────────────
// `params` is ONE bag, but not every key in it is addressed to the pane. Three
// are read by the SHELL and by nothing else: `form_reset` (the form_state carry
// below), `routing` and `signals` (the activity/wake layer in
// lib/server/domain/signals.js). They say how this RENDER behaves — they say
// nothing about what the pane's code, or a service-backed component's host
// process, actually does.
//
// That distinction is load-bearing one level down: lib/server/services.js mints a
// service's consent identity from (project root, service.js hash, params), so a
// control key left in the bag would make a UI-only re-render — adding
// `form_reset:true` to keep prefills fresh — read as a DIFFERENT service asking
// for approval. It strips this set before fingerprinting. A new shell-read params
// key that is missing here would silently rejoin that identity, so
// test/service-trust-identity.test.js scans the two files that read the bag and
// fails on one.
const RENDER_CONTROL_PARAMS = new Set(['form_reset', 'routing', 'signals']);

// ── write policies ──────────────────────────────────────────────────────────
// A named policy exists so the one caller that legitimately deviates says WHY by
// name instead of threading booleans through the signature. There are two, and a
// THIRD would be the signal that this abstraction is wrong.
// The capture path used to deviate on five axes (WS frame with no ring entry, no
// lock check, no owner gate, no gen, no form_state carry). Four were artefacts of
// the hand-copy rather than intent, and decision D1 folded them back in: a
// capture pane now emits the ring event like every other pane — so it shows in
// /api/events and the service supervisor's reconcile subscriber sees it — gets a
// gen, soft-rejects against a user-LOCKED pane like every other writer, and
// carries form_state unless params.form_reset. What is left is the one real
// deviation, and it is why the policy has a name rather than a boolean at the
// call site: the extension re-renders ITS OWN pane on every capture and must not
// soft-reject itself against a stale owner sitting on that id.
const POLICIES = {
  default: { force: false },
  capture: { force: true },
};

// One frame builder, so a re-emit (emitMount) and a fresh write (setMount) put
// the SAME shape on the wire. `component` rides the frame for both; it used to
// be on the queue-revert re-emit alone, which is how that fifth hand-written
// frame shape stayed invisible to review.
function renderFrame(id, rec) {
  return {
    type: 'render',
    id,
    html: rec.html,
    target: rec.target,
    params: rec.params,
    component: rec.component,
    pane_state: rec.pane_state,
    form_state: rec.form_state,
    theme: rec.theme,
  };
}

// Put a pane on the live surface (new, or replace-in-place by id).
//
// Returns `{ ok:true, id, owner }` (plus a `warning` when `after` named nothing
// on the page or `place` was not an object, and `place` — the clamped placement
// actually applied — when one was given), or one of the refusal envelopes (a 200
// + `ok:false`, never a 4xx — see above).
//
// `after` positions the pane in the page sequence (lib/server/domain/page): an
// item id or 'start'. Omitted, a new pane appends and a re-render keeps its
// place. The render frame carries the resulting full `order` only when `after`
// was given — an append needs no instruction, and the frame for a plain render
// stays exactly what it was.
// Carry rules are deliberately NOT uniform and must not be flattened:
//   pane_state  — carried (or patched, for the capture pane's mode); `place`
//                 overwrites its layout keys and records the baseline.
//   form_state  — carried unless `params.form_reset` (the user's typed values
//                 must survive a re-render).
//   theme       — the REQUEST's theme when it supplies one, else the pane's.
//   component   — written only when the caller passes one. Never carried: a
//                 plain render over a service-backed pane deliberately drops
//                 `component`, which is how the supervisor stops its child.
function setMount(state, bus, {
  id,
  html,
  target = 'main',
  params,
  owner,
  force = false,
  component,
  theme,
  pane_state_patch,
  policy = 'default',
  after,
  place,
  source,
  restore,
} = {}) {
  const pol = POLICIES[policy] || POLICIES.default;
  const who = normalizeOwner(owner);
  if (isReservedId(id)) return reservedReject(id);
  // One id space across the page: a markdown item already answers to this id.
  if (state.markdown instanceof Map && state.markdown.has(id)) {
    return {
      ok: false,
      rejected: true,
      conflict: 'markdown',
      id,
      hint: `'${id}' is already a markdown item on this page; panes and markdown share one id space — pick another id`,
    };
  }
  const existing = state.mounts.get(id);
  if (existing && existing.pane_state && existing.pane_state.locked) {
    return lockReject(id);
  }
  // Clobber-guard: a pane belongs to whoever last rendered it. A *different*
  // owner re-rendering it (driver vs Claude, or two drivers) is rejected as a
  // soft envelope unless force:true — so a background service and Claude can't
  // silently overwrite each other's panes by colliding on id.
  if (existing && existing.owner && existing.owner !== who && !(force || pol.force)) {
    return ownerReject(id, existing.owner);
  }
  // `restore` (restoreMount's history "make current") supplies pane_state and
  // form_state OUTRIGHT — the version's, not a carry — so it bypasses both carry
  // rules below.
  let pane_state = restore ? restore.pane_state
    : pane_state_patch
      ? { ...((existing && existing.pane_state) || {}), ...pane_state_patch }
      : (existing ? existing.pane_state : undefined);
  // `place` is the writer PROPOSING a layout (lib/server/domain/page): it sets
  // the pane's col/span/rows over whatever the user left, and becomes the
  // pane's "Claude's layout" baseline. Omitted, the layout carries like the rest
  // of pane_state — a re-render never undoes the user's resize.
  const warnings = [];
  let placed = null;
  if (place !== undefined && place !== null) {
    placed = page.normalizePlace(place);
    if (placed) pane_state = page.applyPlace(pane_state, placed);
    else warnings.push('place ignored: expected an object {col, span, rows}');
  }
  // Preserve the user's typed form values across a re-render too (rehydrated
  // best-effort by element key after the new content's scripts run) — a
  // re-render must not eat user input. `params.form_reset:true` opts a render
  // out when it deliberately supplies fresh prefills.
  const form_state = restore ? restore.form_state
    : (existing && !(params && params.form_reset)) ? existing.form_state : undefined;
  // A per-pane theme survives a re-render of the CONTENT, mirroring locked
  // pane_state — but a caller that SUPPLIES one means it. lib/driver.js
  // documents `theme` as a render parameter, and the old `existing ?
  // existing.theme : req.theme` ignored it for every pane that already existed,
  // so a driver that rendered with theme A and re-rendered with theme B kept A
  // forever with nothing in the response to say so. The WS frame below already
  // carries `theme`, so the surface follows for free.
  //
  // It goes through the theme ENGINE's normalizer, the same one POST /api/theme
  // uses. There are two doors onto a pane's theme and they used to disagree: a
  // theme set through the theme route was shape-checked and its tokens
  // sanitised, while one arriving on a render was stored verbatim and written
  // straight into the pane's shadow <style> by public/app/theme.js. GET
  // /api/theme normalizes on the way out, which is why the read door always
  // looked clean and this stayed invisible. `null` still CLEARS (normalizing it
  // into an empty theme would be a different answer); raw `css` is still carried
  // through untouched at pane scope, exactly as set_theme{scope:'pane'} carries
  // it — the documented escape hatch, unchanged by this.
  const nextTheme = theme !== undefined
    ? (theme === null ? null : normalizeTheme(theme))
    : (existing ? existing.theme : undefined);
  // B6: a stable-id re-render REUSES the pane but replaces its content. Bump a
  // generation counter (new pane = 0) so a queue item that stamped an earlier
  // gen — a Revert referencing the OLD content — no-ops instead of deleting the
  // fresh pane (see queue.revertCapturePane).
  const gen = existing ? ((existing.gen || 0) + 1) : 0;
  const rec = { html, target, params, pane_state, form_state, theme: nextTheme, owner: who, gen };
  if (component !== undefined) rec.component = component;
  state.mounts.set(id, rec);
  const { warning } = page.place(state, id, after);
  if (warning) warnings.unshift(warning);
  const frame = renderFrame(id, rec);
  if (after !== undefined) frame.order = state.order.slice();
  bus.emit({
    // `source` defaults to the owner. It differs only for a USER write that keeps
    // Claude's ownership (restoreMount → 'history'), which must not read as
    // Claude's own activity — installLockKeepalive re-stamps the turn lock on
    // every source:'claude' event.
    event: { kind: 'render', id, target, bytes: String(html || '').length, source: source || who, component },
    ws: frame,
  });
  return {
    ok: true, id, owner: who,
    ...(placed ? { place: placed } : {}),
    ...(warnings.length ? { warning: warnings.join('; ') } : {}),
  };
}

// Take ONE pane off the live surface. Returns whether a pane was removed.
//
// `originGen` is the queue's generation guard: a stable-id re-render replaces a
// pane's content but keeps the id, so a Revert only fires while the CURRENT pane
// is still the one the queue item stamped. A missing stamp or a gen-less mount
// matches (back-compat) — see decision D18: `gen` is live-only, so a Revert
// stamped before a node restore can still match the restored pane.
//
// `target` is omitted from both payloads when the caller did not supply one,
// matching the two frames this replaced.
function removeMount(state, bus, { id, source, originGen, target } = {}) {
  const mount = id == null ? null : state.mounts.get(id);
  if (!mount) return false;
  if (originGen != null && mount.gen != null && originGen !== mount.gen) return false;
  state.mounts.delete(id);
  page.drop(state, id);
  bus.emit({
    event: target === undefined ? { kind: 'clear', id, source } : { kind: 'clear', target, id, source },
    ws: target === undefined ? { type: 'clear', id } : { type: 'clear', target, id },
  });
  return true;
}

// Re-broadcast a pane exactly as it stands, without replacing it. The queue's
// "Revert an activity item" restores the pane's captured form values in place
// and needs every browser to remount it; it used to hand-write its own render
// frame, which is how a fifth frame shape lived outside every guard.
function emitMount(state, bus, id, { source = 'server' } = {}) {
  const mount = id == null ? null : state.mounts.get(id);
  if (!mount) return false;
  bus.emit({
    event: { kind: 'render', id, target: mount.target, bytes: (mount.html || '').length, source },
    ws: renderFrame(id, mount),
  });
  return true;
}

// ── history: "make current" ─────────────────────────────────────────────────
// The pane-history popover's one write (POST /api/mounts/:id/restore): copy an
// older VERSION of a pane — a mount record out of a committed node — back into
// its live slot. It is a USER action, so it is event-sourced 'history' (never
// 'claude'), and it goes through setMount like every other pane write: reserved
// ids, the markdown id space, the user's lock, the gen bump and the paired emit.
//
// What is copied, and what is not:
//   html / params / component / target — the version's (the content IS the
//               version). A version without `component` drops a live one, as a
//               plain render does, which stops a service the version never had.
//   pane_state  — the version's layout (col/span/rows, claude_place, mode), but
//               the user's own flags on the LIVE pane (pinned, locked,
//               minimized) stay as they are: restoring content never re-pins,
//               re-locks or hides a pane behind the user's back.
//   form_state  — the live pane's typed values carry, as on any re-render;
//               `withForm` takes the version's instead.
//   theme       — carried from the live pane (setMount's rule for an omitted one).
//   owner       — kept: the version was Claude's and stays Claude's.
//
// Ownership: only a Claude-owned pane is restorable, in either direction. A live
// pane a driver (service:<name>) or another pane owns would be taken over from a
// writer that is still running and would fight it; a version a driver wrote
// would be put back under that driver's name without the driver. Both refuse,
// with no force — a maintainer hold (p34b-holds.md) records the default.
const USER_PANE_FLAGS = ['pinned', 'locked', 'minimized'];

function restoreMount(state, bus, { id, version, withForm = false, after } = {}) {
  if (isReservedId(id)) return reservedReject(id);
  const live = state.mounts.get(id);
  if (live && live.pane_state && live.pane_state.locked) return lockReject(id);
  const liveOwner = live ? normalizeOwner(live.owner) : 'claude';
  if (liveOwner !== 'claude') {
    return { ...ownerReject(id, liveOwner), hint: `pane '${id}' is owned by '${liveOwner}'; only a pane Claude owns can be restored from history` };
  }
  const verOwner = normalizeOwner(version && version.owner);
  if (verOwner !== 'claude') {
    return {
      ...ownerReject(id, verOwner),
      hint: `that version of '${id}' was written by '${verOwner}'; only a version Claude wrote can be restored from history`,
    };
  }
  const ps = { ...((version && version.pane_state) || {}) };
  for (const k of USER_PANE_FLAGS) delete ps[k];
  const liveFlags = (live && live.pane_state) || {};
  for (const k of USER_PANE_FLAGS) if (k in liveFlags) ps[k] = liveFlags[k];
  return setMount(state, bus, {
    id,
    html: version.html,
    target: version.target || (live && live.target) || 'main',
    params: version.params,
    component: version.component,
    owner: 'claude',
    source: 'history',
    after,
    restore: {
      pane_state: Object.keys(ps).length ? ps : undefined,
      form_state: withForm ? version.form_state : (live ? live.form_state : undefined),
    },
  });
}

module.exports = {
  setMount,
  removeMount,
  emitMount,
  restoreMount,
  lockReject,
  ownerReject,
  reservedReject,
  normalizeOwner,
  RESERVED_IDS,
  isReservedId,
  RENDER_CONTROL_PARAMS,
};
