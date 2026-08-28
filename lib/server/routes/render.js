// HTTP routes for the live surface's panes. The mount-SET (lock check, owner
// gate, the pane_state/form_state/theme carry rules, the gen bump, the owner
// stamp and the paired ring event + WS frame) lives in lib/server/domain/mounts
// — this file is the HTTP shell over it (setMount / removeMount), plus the one
// BULK primitive the engine deliberately does not own: the pin-filtered
// clear-all and its batched per-pane frames.
//
// lockReject is re-exported: lib/server/routes/packs.js documents the refusal
// envelope as "the shape from routes/render.js" and both it and
// routes/components.js import it from here.
const { setMount, removeMount, lockReject, ownerReject, normalizeOwner } = require('../domain/mounts');

function mountRenderRoutes(app, { state, bus }) {
  app.post('/api/render', (req, res) => {
    const { html, target = 'main', id, params, force, theme } = req.body || {};
    if (typeof html !== 'string') return res.status(400).json({ error: 'html required' });
    const mountId = id || `mount-${Date.now()}`;
    res.json(setMount(state, bus, {
      id: mountId, html, target, params, force, theme,
      owner: req.body && req.body.owner,
    }));
  });

  app.get('/api/mounts', (req, res) => {
    const mounts = [...state.mounts.entries()].map(([id, m]) => ({
      id,
      target: m.target,
      component: m.component || null,
      pane_state: m.pane_state || null,
      // The user's current typed form values (delegated capture) — how Claude
      // reads an unsent draft even when the pane's own script never ran.
      form_state: m.form_state || null,
      owner: m.owner || null,
    }));
    res.json({ mounts });
  });

  app.post('/api/clear', (req, res) => {
    const { target, id, force } = req.body || {};
    const source = normalizeOwner(req.body && req.body.owner);
    // Clobber-guard, mirroring /api/render above: clearing a pane someone else
    // owns is the same clobber as re-rendering over it (worse — the pane just
    // vanishes), so it gets the same soft envelope and the same force:true
    // escape. A bulk `{}`/target clear is rejected WHOLE rather than
    // half-applied, so the WS clear frame always describes what the server did.
    const inScope = ([mid, m]) => (id ? mid === id : (!target || m.target === target));
    const foreign = force ? [] : [...state.mounts].filter(inScope).filter(([, m]) => m.owner && m.owner !== source);
    if (foreign.length) {
      const rej = ownerReject(foreign[0][0], foreign[0][1].owner);
      if (!id) rej.hint = `${foreign.length} pane(s) owned by another writer (${foreign.map(([mid]) => mid).join(', ')}); clear your own by id, or pass force:true`;
      return res.json(rej);
    }
    // Naming a pane by id is deliberate — that clear always lands. A BULK clear
    // (no id: the agent's clear-all, or a whole target) leaves PINNED panes
    // standing unless force:true, because a pin is the user saying "this one
    // stays" and it has to mean that against the agent too, not just against
    // drag-reorder. Composes with the ownership guard above: foreignness is
    // rejected first, pinning filters what's left.
    if (id) {
      removeMount(state, bus, { id, source, target });
      return res.json({ ok: true });
    }
    const removed = [];
    const kept = [];
    for (const [mid, m] of state.mounts) {
      if (target && m.target !== target) continue;
      if (!force && m.pane_state && m.pane_state.pinned) { kept.push(mid); continue; }
      removed.push(mid);
    }
    for (const mid of removed) state.mounts.delete(mid);
    if (!kept.length) {
      // Nothing survived: the bulk frame describes the server exactly, so the
      // wire is unchanged from before pins were load-bearing.
      bus.emit({ event: { kind: 'clear', target, id, source }, ws: { type: 'clear', target, id } });
      return res.json({ ok: true });
    }
    // A bulk frame would tell clients to drop the survivors too. Name the
    // removals instead — one ring entry, one per-pane frame each (the client's
    // clear handler removes exactly the pane it names) — so what the browser
    // shows matches what the server holds without the client second-guessing it.
    bus.emit({
      event: { kind: 'clear', target, id, source, kept: kept.length },
      ws: removed.map((mid) => ({ type: 'clear', id: mid })),
    });
    res.json({ ok: true, kept });
  });
}

module.exports = { mountRenderRoutes, lockReject };
