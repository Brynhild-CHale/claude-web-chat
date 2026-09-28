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
const page = require('../domain/page');
const { headings } = require('../../core/markdown');

function mountRenderRoutes(app, { state, bus }) {
  app.post('/api/render', (req, res) => {
    const { html, target = 'main', id, params, force, theme, after, place } = req.body || {};
    if (typeof html !== 'string') return res.status(400).json({ error: 'html required' });
    const mountId = id || `mount-${Date.now()}`;
    res.json(setMount(state, bus, {
      id: mountId, html, target, params, force, theme, after, place,
      owner: req.body && req.body.owner,
    }));
  });

  app.get('/api/mounts', (req, res) => {
    // Panes in PAGE order, with the page's markdown items and the full order
    // beside them (lib/server/domain/page). Markdown is summarised, not echoed:
    // its headings are what a reader needs to find its way around the page.
    const mounts = page.orderedMounts(state).map(([id, m]) => ({
      id,
      target: m.target,
      component: m.component || null,
      pane_state: m.pane_state || null,
      // Where the pane sits, in grid terms — derived from pane_state (an old
      // pane sized in heightPx answers in rows), so a reader never re-derives it.
      place: page.placeOf(m.pane_state),
      // The user's current typed form values (delegated capture) — how Claude
      // reads an unsent draft even when the pane's own script never ran.
      form_state: m.form_state || null,
      owner: m.owner || null,
    }));
    const markdown = page.orderedMarkdown(state).map(([id, m]) => ({
      id,
      owner: m.owner || null,
      chars: String(m.text || '').length,
      headings: headings(m.text).map(({ level, text }) => ({ level, text })),
    }));
    res.json({ mounts, markdown, order: state.order.slice(), runs: { ...state.runs } });
  });

  app.post('/api/clear', (req, res) => {
    const { target, id, force } = req.body || {};
    const source = normalizeOwner(req.body && req.body.owner);
    // Clobber-guard, mirroring /api/render above: clearing a pane someone else
    // owns is the same clobber as re-rendering over it (worse — the pane just
    // vanishes), so it gets the same soft envelope and the same force:true
    // escape. A bulk `{}`/target clear is rejected WHOLE rather than
    // half-applied, so the WS clear frame always describes what the server did.
    //
    // Markdown items are page content with no slot of their own: a clear by id
    // takes one, and a bulk clear takes them when it is page-wide (no target,
    // or 'main'). They have no pin; the one prose a page-wide clear keeps is the
    // run directly above a pane it keeps (page.markdownAbove), same as a wipe.
    page.ensure(state);
    const mdInScope = id ? state.markdown.has(id) : (!target || target === 'main');
    const inScope = ([mid, m]) => (id ? mid === id : (!target || m.target === target));
    // What a bulk clear KEEPS is not something it clobbers, so it is not part of
    // the ownership question: a pinned pane (unless force) and the markdown run
    // directly above it stay whoever owns them. Without this a pinned pane a
    // driver or a parent pane owns refused every page-wide clear — and every
    // spawned child is foreign to Claude — while the hint's force:true would
    // then have swept the user's pinned panes too.
    const pinnedKept = (!id && !force)
      ? [...state.mounts].filter(inScope).filter(([, m]) => m.pane_state && m.pane_state.pinned).map(([mid]) => mid)
      : [];
    const keptSet = new Set(pinnedKept);
    const keptMd = mdInScope && pinnedKept.length ? page.markdownAbove(state, pinnedKept) : new Set();
    const foreign = force ? [] : [
      ...[...state.mounts].filter(inScope).filter(([mid]) => !keptSet.has(mid)),
      ...(mdInScope ? [...state.markdown].filter(([mid]) => (!id || mid === id) && !keptMd.has(mid)) : []),
    ].filter(([, m]) => m.owner && m.owner !== source);
    if (foreign.length) {
      const rej = ownerReject(foreign[0][0], foreign[0][1].owner);
      if (!id) rej.hint = `${foreign.length} pane(s) owned by another writer (${foreign.map(([mid]) => mid).join(', ')}); clear your own by id instead — force:true on a bulk clear also removes every pinned pane`;
      return res.json(rej);
    }
    // Naming a pane by id is deliberate — that clear always lands. A BULK clear
    // (no id: the agent's clear-all, or a whole target) leaves PINNED panes
    // standing unless force:true, because a pin is the user saying "this one
    // stays" and it has to mean that against the agent too, not just against
    // drag-reorder. Composes with the ownership guard above: foreignness is
    // rejected first, pinning filters what's left.
    if (id) {
      if (state.markdown.has(id)) page.removeMarkdown(state, bus, { id, source });
      else removeMount(state, bus, { id, source, target });
      return res.json({ ok: true });
    }
    const removed = [];
    const kept = [];
    for (const [mid, m] of state.mounts) {
      if (target && m.target !== target) continue;
      if (!force && m.pane_state && m.pane_state.pinned) { kept.push(mid); continue; }
      removed.push(mid);
    }
    // Read before the delete: "directly above" is the page as it stands now.
    const keepMd = mdInScope ? page.markdownAbove(state, kept) : null;
    for (const mid of removed) state.mounts.delete(mid);
    // page.clearMarkdown re-derives the order for the survivors either way.
    const mdRemoved = mdInScope ? page.clearMarkdown(state, { keep: keepMd }) : (page.reconcile(state), []);
    // A chrome that predates markdown knows nothing of these frames and ignores
    // them; they are appended only when prose was actually removed, so a clear
    // on a page without markdown puts exactly the frames it always did.
    const mdFrames = mdRemoved.map((mid) => ({ type: 'markdown:remove', id: mid }));
    const mdEvent = mdRemoved.length ? { markdown: mdRemoved.length } : {};
    if (!kept.length) {
      // Nothing survived: the bulk frame describes the server exactly, so the
      // wire is unchanged from before pins were load-bearing.
      const frame = { type: 'clear', target, id };
      bus.emit({ event: { kind: 'clear', target, id, source, ...mdEvent }, ws: mdFrames.length ? [frame, ...mdFrames] : frame });
      return res.json({ ok: true });
    }
    // A bulk frame would tell clients to drop the survivors too. Name the
    // removals instead — one ring entry, one per-pane frame each (the client's
    // clear handler removes exactly the pane it names) — so what the browser
    // shows matches what the server holds without the client second-guessing it.
    bus.emit({
      event: { kind: 'clear', target, id, source, kept: kept.length, ...mdEvent },
      ws: [...removed.map((mid) => ({ type: 'clear', id: mid })), ...mdFrames],
    });
    res.json({ ok: true, kept });
  });
}

module.exports = { mountRenderRoutes, lockReject };
