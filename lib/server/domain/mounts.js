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

// Normalize the requester's identity. Claude (the MCP render tool) sends no
// owner and is treated as 'claude'; drivers send 'service:<name>'. Stored as a
// string so it rides into committed graph nodes (see graph.snapshotLive).
function normalizeOwner(owner) {
  if (owner == null) return 'claude';
  return String(owner);
}

// ── write policies ──────────────────────────────────────────────────────────
// A named policy exists so the one caller that legitimately deviates says WHY by
// name instead of threading booleans through the signature. There are two, and a
// THIRD would be the signal that this abstraction is wrong. (Only `default`
// exists at this step; the capture path joins in its own commit.)
const POLICIES = {
  default: { force: false },
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
// Returns `{ ok:true, id, owner }`, or a refusal envelope.
// Carry rules are deliberately NOT uniform and must not be flattened:
//   pane_state  — carried (or patched, for the capture pane's mode).
//   form_state  — carried unless `params.form_reset` (the user's typed values
//                 must survive a re-render).
//   theme       — carried from the existing pane.
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
} = {}) {
  const pol = POLICIES[policy] || POLICIES.default;
  const who = normalizeOwner(owner);
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
  const pane_state = pane_state_patch
    ? { ...((existing && existing.pane_state) || {}), ...pane_state_patch }
    : (existing ? existing.pane_state : undefined);
  // Preserve the user's typed form values across a re-render too (rehydrated
  // best-effort by element key after the new content's scripts run) — a
  // re-render must not eat user input. `params.form_reset:true` opts a render
  // out when it deliberately supplies fresh prefills.
  const form_state = (existing && !(params && params.form_reset)) ? existing.form_state : undefined;
  // Preserve a per-pane theme across re-renders, mirroring locked pane_state:
  // a re-render of content must not silently drop the pane's theme.
  const nextTheme = existing ? existing.theme : theme;
  // B6: a stable-id re-render REUSES the pane but replaces its content. Bump a
  // generation counter (new pane = 0) so a queue item that stamped an earlier
  // gen — a Revert referencing the OLD content — no-ops instead of deleting the
  // fresh pane (see queue.revertPane).
  const gen = existing ? ((existing.gen || 0) + 1) : 0;
  const rec = { html, target, params, pane_state, form_state, theme: nextTheme, owner: who, gen };
  if (component !== undefined) rec.component = component;
  state.mounts.set(id, rec);
  bus.emit({
    event: { kind: 'render', id, target, bytes: String(html || '').length, source: who, component },
    ws: renderFrame(id, rec),
  });
  return { ok: true, id, owner: who };
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

module.exports = {
  setMount,
  removeMount,
  emitMount,
  lockReject,
  ownerReject,
  normalizeOwner,
};
