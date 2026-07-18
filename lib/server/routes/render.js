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
    const { target, id } = req.body || {};
    const source = normalizeOwner(req.body && req.body.owner);
    if (id) {
      state.mounts.delete(id);
    } else if (target) {
      for (const [mid, m] of state.mounts) if (m.target === target) state.mounts.delete(mid);
    } else {
      state.mounts.clear();
    }
    bus.emit({ event: { kind: 'clear', target, id, source }, ws: { type: 'clear', target, id } });
    res.json({ ok: true });
  });
}

module.exports = { mountRenderRoutes, lockReject };
