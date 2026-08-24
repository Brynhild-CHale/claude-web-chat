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

function mountRenderRoutes(app, { state, bus }) {
  app.post('/api/render', (req, res) => {
    const { html, target = 'main', id, params, force } = req.body || {};
    if (typeof html !== 'string') return res.status(400).json({ error: 'html required' });
    const owner = normalizeOwner(req.body && req.body.owner);
    const mountId = id || `mount-${Date.now()}`;
    const existing = state.mounts.get(mountId);
    if (existing && existing.pane_state && existing.pane_state.locked) {
      return res.json(lockReject(mountId));
    }
    // Clobber-guard: a pane belongs to whoever last rendered it. A *different*
    // owner re-rendering it (driver vs Claude, or two drivers) is rejected as a
    // soft envelope unless force:true — so a background service and Claude can't
    // silently overwrite each other's panes by colliding on id.
    if (existing && existing.owner && existing.owner !== owner && !force) {
      return res.json(ownerReject(mountId, existing.owner));
    }
    const pane_state = existing ? existing.pane_state : undefined;
    // Preserve the user's typed form values across a re-render too (rehydrated
    // best-effort by element key after the new content's scripts run) — a
    // re-render must not eat user input. `params.form_reset:true` opts a render
    // out when it deliberately supplies fresh prefills.
    const form_state = (existing && !(params && params.form_reset)) ? existing.form_state : undefined;
    // Preserve a per-pane theme across re-renders, mirroring locked pane_state:
    // a re-render of content must not silently drop the pane's theme.
    const theme = existing ? existing.theme : (req.body && req.body.theme);
    // B6: a stable-id re-render REUSES the pane but replaces its content. Bump a
    // generation counter (new pane = 0) so a queue item that stamped an earlier
    // gen — a Revert referencing the OLD content — no-ops instead of deleting the
    // fresh pane (see queue.revertPane).
    const gen = existing ? ((existing.gen || 0) + 1) : 0;
    state.mounts.set(mountId, { html, target, params, pane_state, form_state, theme, owner, gen });
    bus.emit({
      event: { kind: 'render', id: mountId, target, bytes: html.length, source: owner },
      ws: { type: 'render', html, target, id: mountId, params, pane_state, form_state, theme },
    });
    res.json({ ok: true, id: mountId, owner });
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
      state.mounts.delete(id);
      bus.emit({ event: { kind: 'clear', target, id, source }, ws: { type: 'clear', target, id } });
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
