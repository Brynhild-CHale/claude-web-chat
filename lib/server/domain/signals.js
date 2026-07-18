// Declared-signal registry — the extensibility seam.
//
// A render can declare wake signals via `params.signals: [{key, wake, why?}]`.
// `wake:'queue'` (default) makes a browser write to that store key fold into the
// queue rail; `wake:'immediate'` wakes Claude the moment the pane writes it,
// bypassing the queue. This is what "a pane takes advantage of wake outside the
// queue" concretely means — the second producer of the `wake` primitive.
//
// The registry is DERIVED from live mounts on demand (params is a persisted mount
// field, so it survives navigation/restart with the mount), never a separate
// stateful copy — so it can never point at a mount that no longer exists, and
// there are no rebuild call sites to keep in sync. The classify subscriber
// derives it only when it actually needs it (a browser store write), so the
// per-event cost is paid only on real pane interactions.

// Parse one mount's declared signals into normalized entries.
function parseSignals(mountId, mount) {
  const out = [];
  const sigs = mount && mount.params && mount.params.signals;
  if (!Array.isArray(sigs)) return out;
  for (const s of sigs) {
    if (!s || typeof s.key !== 'string' || !s.key) continue;
    out.push({
      key: s.key,
      wake: s.wake === 'immediate' ? 'immediate' : 'queue',
      mount: mountId,
      why: typeof s.why === 'string' ? s.why : undefined,
    });
  }
  return out;
}

// Derive the registry { [key]: { wake, mount, why } } from all live mounts.
// Last-writer-wins on a key collision (a later mount re-declaring the same key
// overrides — rare, and deterministic by Map iteration order).
function derive(state) {
  const reg = {};
  for (const [id, m] of state.mounts) {
    for (const s of parseSignals(id, m)) reg[s.key] = { wake: s.wake, mount: s.mount, why: s.why };
  }
  return reg;
}

// Derive the per-mount ACTIVITY-ROUTING map `{ [mountId]: 'auto'|'none' }` —
// the opt-OUT gate for the default activity layer (undeclared browser store
// writes + delegated dom events coalescing into the queue; see
// lib/channel/policy). `params.routing:'none'` opts a pane out; service-owned
// panes (`owner:"service:*"`) default out because their store control-loop is
// pane↔service traffic, not a user handoff — an explicit `routing:'auto'` on
// the render opts one back in. Derived like the signal registry: from live
// mounts on demand, never a stateful copy.
function deriveRouting(state) {
  const out = {};
  for (const [id, m] of state.mounts) {
    const explicit = m && m.params && typeof m.params.routing === 'string' ? m.params.routing : null;
    if (explicit === 'none') out[id] = 'none';
    else if (explicit === 'auto') out[id] = 'auto';
    else out[id] = (typeof m.owner === 'string' && m.owner.startsWith('service:')) ? 'none' : 'auto';
  }
  return out;
}

module.exports = { derive, deriveRouting, parseSignals };
