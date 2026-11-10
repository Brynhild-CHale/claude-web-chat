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
const { setMount, removeMount, lockReject, ownerReject, normalizeOwner, refusesNewId, badIdReject } = require('../domain/mounts');
const page = require('../domain/page');
const { headings } = require('../../core/markdown');
const { isRemoteRequest } = require('../../core/cors');
const { annotationsOn, annotationsOf, byState } = require('../domain/annotation-impact');
const { onPage } = require('../domain/element-refs');

// A remote viewer closes panes one at a time (the chrome's × sends
// {id, force:true}); emptying the whole page is the host's, like a wipe — see the
// /api/clear row in lib/core/remote-policy.js.
const REMOTE_BULK_CLEAR_HINT = 'clearing the whole page remotely is off — close panes one at a time (×), or clear it on the host';

// THE RENDER-IMPACT ANSWER (PLAN 4F.2; lib/server/domain/annotation-impact):
// an ok render, a clear and a use_component (routes/components.js) carry
// `annotations` — counts only, present only when an annotation anchors the item
// written or cleared, so every unannotated answer is byte-equal to what it was.
// A portal request never counts a private element and gets no `private` key.
// GET /api/mounts gives each annotated pane the same counts and, once a viewer
// has reported its resolver's answers (ctx.reports), the post-resolve verdict
// `by_state`. The tools relay the daemon's answer unchanged (no tool file,
// description or inputSchema changes: catalogue 1.0.0).
function withAnnotations(answer, impact) {
  return impact && answer && answer.ok ? { ...answer, annotations: impact } : answer;
}

function mountRenderRoutes(app, { state, bus, graph, reports }) {
  const elementStore = () => (graph && graph.elements) || null;
  const impactOn = (req, items) => annotationsOn(state, elementStore(), items, { remote: isRemoteRequest(req) });

  app.post('/api/render', (req, res) => {
    const { html, target = 'main', id, params, force, theme, after, place } = req.body || {};
    if (typeof html !== 'string') return res.status(400).json({ error: 'html required' });
    const mountId = id || `mount-${Date.now()}`;
    // A caller-passed NEW id outside the page record's grammar is refused before
    // the mount-set (domain/mounts refusesNewId; U763). The generated mount-<ms>
    // default always meets it; a pane already live under any id re-renders.
    if (id && refusesNewId(state, id)) return res.json(badIdReject(id));
    const r = setMount(state, bus, {
      id: mountId, html, target, params, force, theme, after, place,
      owner: req.body && req.body.owner,
    });
    // Read after the write: a render drops no reference, so these are the
    // annotations the chrome now re-resolves over the new content.
    res.json(r && r.ok ? withAnnotations(r, impactOn(req, r.id || mountId)) : r);
  });

  app.get('/api/mounts', (req, res) => {
    // Panes in PAGE order, with the page's markdown items and the full order
    // beside them (lib/server/domain/page). Markdown is summarised, not echoed:
    // its headings are what a reader needs to find its way around the page.
    const remote = isRemoteRequest(req);
    // An annotated pane's counts, and the held answers for its live content
    // (the verdict: by_state — the pane's live gen, each element's live v)
    // when a viewer has reported them. Read at request time; a remote
    // request's counts and verdict leave private out.
    const annotationsRow = (id, gen) => {
      const a = annotationsOf(state, elementStore(), id, { remote });
      if (!a) return {};
      const { ids, ...counts } = a;
      let held = [];
      try { held = reports && typeof reports.answers === 'function' ? reports.answers({ mount: id }) : []; } catch { held = []; }
      const verdict = byState(held, ids, gen);
      return { annotations: verdict ? { ...counts, by_state: verdict } : counts };
    };
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
      ...annotationsRow(id, Number.isSafeInteger(m.gen) ? m.gen : 0),
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
    // A BULK clear (no id — the page, or a whole target; `force` takes the
    // pinned panes too) through the portal is refused whole. The table allows
    // the path because closing one pane is surface-level; this is its body-level
    // rule, the same shape as spawn's raw-html refusal.
    if (!id && isRemoteRequest(req)) {
      return res.status(403).json({ ok: false, remote: true, hint: REMOTE_BULK_CLEAR_HINT });
    }
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
      // Read before the removal: what went with the item — none when the item
      // is not on the page (a clear drops no reference or pin, so a repeat
      // clear would otherwise answer for what went the first time).
      const impact = onPage(state, id) ? impactOn(req, id) : null;
      if (state.markdown.has(id)) page.removeMarkdown(state, bus, { id, source });
      else removeMount(state, bus, { id, source, target });
      return res.json(withAnnotations({ ok: true }, impact));
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
    // Read before the delete, over exactly what goes: the removed panes and the
    // markdown page.clearMarkdown is about to take (a kept pane's not counted).
    const impact = impactOn(req, [
      ...removed,
      ...(mdInScope ? [...state.markdown.keys()].filter((mid) => !keepMd.has(mid)) : []),
    ]);
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
      return res.json(withAnnotations({ ok: true }, impact));
    }
    // A bulk frame would tell clients to drop the survivors too. Name the
    // removals instead — one ring entry, one per-pane frame each (the client's
    // clear handler removes exactly the pane it names) — so what the browser
    // shows matches what the server holds without the client second-guessing it.
    bus.emit({
      event: { kind: 'clear', target, id, source, kept: kept.length, ...mdEvent },
      ws: [...removed.map((mid) => ({ type: 'clear', id: mid })), ...mdFrames],
    });
    res.json(withAnnotations({ ok: true, kept }, impact));
  });
}

module.exports = { mountRenderRoutes, lockReject };
