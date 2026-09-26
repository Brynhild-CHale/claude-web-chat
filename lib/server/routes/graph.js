const { findMount } = require('../domain/lineage');
const { PREVIEW_CSP } = require('../../core/cors');
const { projectPaths } = require('../../core/paths');
const { summarizeReply } = require('../../core/reply');
const { computeLabels, computeCollapse } = require('../graph');
const {
  deleteDraft, acquireLock, releaseLock, guardReaim, lockHeld, commitNode, liveIsDirty,
  setPendingReaim, takePendingReaim, discardFolded, skipTurn,
} = require('../domain/turns');
const { diffNodes } = require('../diff');
const { renderNodePreview } = require('../preview');
const { resolveNodeRef } = require('../domain/refs');

function mountGraphRoutes(app, { graph, paths, bus, broadcastReset }) {
  const draftPath = projectPaths(paths.root).draft;

  // ── Re-aim executors ──────────────────────────────────────────────────────
  // The four re-aim bodies, extracted so each runs from TWO places: the route
  // (no fresh lock → execute now) and applyPendingReaim (a fresh lock queued
  // the intent; turn-end/unlock applies it). Behavior is byte-identical to the
  // old inline route bodies.
  function execSetActive(id) {
    graph.active = id;
    // The commit point moved: chat-only turns collapsed against the OLD context
    // must not be stapled onto whatever commits next over here.
    discardFolded(graph);
    graph.restoreLiveToNode(id, bus);
    graph.saveMeta();
    deleteDraft(draftPath);
    broadcastReset();
    bus.emit({ event: { kind: 'graph', op: 'set-active', id } });
    return { ok: true, active: id };
  }

  function execBranchHere(id) {
    let preserved = null;
    if (liveIsDirty(graph)) {
      const r = commitNode(graph, bus, {
        draftPath, parentId: graph.active, author: 'user',
        triggerKind: 'preserve', message: 'auto-preserved before branch edit',
        clearLock: false, op: 'commit', includeLabelAndUnlock: false,
      });
      preserved = r.node_id;
    }
    // If there was work to preserve, that commit already drained the collapsed
    // turns onto it (commitNode → applyFolded) and this is a no-op. If there
    // wasn't, the commit point is simply moving, so they're dropped — same rule
    // as set-active.
    discardFolded(graph);
    graph.active = id;
    graph.restoreLiveToNode(id, bus);
    graph.saveMeta();
    deleteDraft(draftPath);
    bus.emit({
      event: { kind: 'graph', op: 'branch-here', id, ...(preserved ? { preserved } : {}) },
      ws: { type: 'branch-here', id, active: id, preserved },
    });
    return { ok: true, active: id, preserved };
  }

  // A wipe empties the page but STAYS on this node, so (unlike the other three
  // re-aims) it does not move the commit point: collapsed chat-only turns are
  // deliberately kept — the node they eventually land on is still their child.
  // Pinned panes survive: the pin is the user saying "this one stays". The
  // bookmark is set either way, including when survivors mean the page isn't
  // actually empty afterwards — the gesture is what earns the bookmark.
  function execWipe(name = '') {
    const kept = graph.clearLiveMounts({ keepPinned: true });
    const label = String(name || '').trim();
    graph.pendingBookmark = { name: label };
    // pendingBookmark now rides _meta.json, so persist the gesture rather than
    // leaving it to whatever writes meta next.
    graph.saveMeta();
    deleteDraft(draftPath);
    broadcastReset();
    bus.emit({ event: { kind: 'graph', op: 'wipe', ...(label ? { name: label } : {}), ...(kept.length ? { kept: kept.length } : {}) } });
    return { ok: true, active: graph.active, name: label, kept };
  }

  function execNewGraph(name) {
    graph.clearLiveMounts();
    graph.active = null;
    discardFolded(graph);
    graph.pendingBookmark = { name };
    graph.saveMeta();
    deleteDraft(draftPath);
    broadcastReset();
    bus.emit({ event: { kind: 'graph', op: 'new-graph', name } });
    return { ok: true, active: null, name };
  }

  // Apply (claim-and-run) the queued re-aim, if any. Called after the turn-end
  // commit and after a manual unlock. A queued branch-here applies with nothing
  // dirty (the commit just snapshotted live), so its preserve step naturally
  // no-ops. A queued intent whose target node vanished can't exist — nodes are
  // append-only — but guard anyway.
  function applyPendingReaim() {
    const intent = takePendingReaim(graph);
    if (!intent) return null;
    if ((intent.op === 'set-active' || intent.op === 'branch-here') && !graph.nodes.has(intent.id)) {
      return { op: intent.op, id: intent.id, ok: false, error: 'not found' };
    }
    const r = intent.op === 'wipe' ? execWipe(intent.name || '')
      : intent.op === 'new-graph' ? execNewGraph(intent.name || '')
      : intent.op === 'branch-here' ? execBranchHere(intent.id)
      : execSetActive(intent.id);
    return { op: intent.op, ...(intent.id ? { id: intent.id } : {}), ok: r.ok };
  }
  app.get('/api/graph', (req, res) => {
    const labels = computeLabels(graph);
    // Read-time only: which nodes are byte-identical to their parent, and which
    // surviving node stands for each run of them (see graph.computeCollapse).
    // Purely additive — `parent_id` stays the truth on disk, `display_parent` is
    // the edge to draw when the collapsed ones are hidden.
    const collapse = computeCollapse(graph);
    const brief = (id) => {
      const t = graph.topology.get(id) || {};
      return {
        id,
        label: labels.get(id) || id,
        created_at: t.created_at,
        author: t.author,
        trigger_summary: t.trigger_summary || '',
      };
    };
    res.json({
      nodes: [...graph.topology.values()].map(t => {
        const c = collapse.get(t.id) || {};
        const absorbed = c.absorbed || [];
        return {
          ...t,
          label: labels.get(t.id) || t.id,
          ...(c.collapsed ? { collapsed: true } : {}),
          display_parent: c.collapsed ? t.parent_id : (c.display_parent !== undefined ? c.display_parent : t.parent_id),
          ...(absorbed.length ? { absorbed: absorbed.map(brief), absorbed_count: absorbed.length } : {}),
        };
      }),
      // How many nodes the viewer will hide. Lets a reader tell "this graph is
      // 12 turns" from "this graph is 12 turns and 559 collapsed no-change ones".
      collapsed_count: [...collapse.values()].filter((c) => c.collapsed).length,
      active: graph.active,
      active_label: graph.active ? (labels.get(graph.active) || null) : null,
      lock: graph.lock,
      // Intent that has been accepted but not yet applied. Without these, the
      // two things about to happen to the graph were invisible to the only
      // reader that needs them: after `new graph`, the name the user typed lives
      // in pendingBookmark until the first commit — so Claude could be working
      // in a graph the user named and have no way to know it — and a re-aim
      // queued during a turn moves `active` the moment that turn ends, which the
      // guidance warns Claude about while giving it nothing to observe.
      pending_reaim: graph.pendingReaim || null,
      pending_bookmark: graph.pendingBookmark || null,
      // How many turns so far ended without changing the surface and so
      // committed no node. They fold onto the next node that does commit (which
      // then reports them as `folded_count`), so a non-zero value here means
      // "the last N turns are still waiting for something to attach to".
      pending_folded: (graph.pendingFolded || []).length + (graph.pendingFoldedDropped || 0),
    });
  });

  app.get('/api/graph/node/:id', (req, res) => {
    const node = graph.nodes.get(req.params.id);
    if (!node) return res.status(404).json({ error: 'not found' });
    const labels = computeLabels(graph);
    res.json({ ...node, label: labels.get(node.id) || node.id });
  });

  // Structural diff between two nodes. `a`/`b` accept a hierarchical label
  // (n1.2), an opaque id (n3), `active`, or `live` (the uncommitted surface).
  app.get('/api/graph/diff', (req, res) => {
    const aRef = req.query.a, bRef = req.query.b;
    if (aRef == null || bRef == null) {
      return res.status(400).json({ error: 'both `a` and `b` query params are required' });
    }
    // One resolver for every node ref (domain/refs). `live` borrows the active
    // node's theme there, so a themed `active` diffed against `live` is not a
    // spurious full-theme removal. The messages stay this route's own.
    const resolveRef = (ref) => {
      const r = resolveNodeRef(graph, String(ref));
      if (r.ok) return { ok: true, value: r };
      if (r.code === 'no-active') return { ok: false, error: 'no active node — the surface has no commit point yet (try `live`)' };
      return { ok: false, error: 'node not found' };
    };

    const A = resolveRef(aRef);
    if (!A.ok) return res.status(404).json({ error: A.error, ref: String(aRef), which: 'a' });
    const B = resolveRef(bRef);
    if (!B.ok) return res.status(404).json({ error: B.error, ref: String(bRef), which: 'b' });

    const ctx = parseInt(req.query.context, 10);
    const opts = Number.isFinite(ctx) && ctx >= 0 ? { context: ctx } : {};
    res.json({
      a: { id: A.value.id, label: A.value.label },
      b: { id: B.value.id, label: B.value.label },
      ...diffNodes(A.value.node, B.value.node, opts),
    });
  });

  app.get('/preview/node/:id', (req, res) => {
    // Set before the 404 too, so every document this path can produce is under
    // the same policy and the header is never a function of which branch ran.
    res.setHeader('Content-Security-Policy', PREVIEW_CSP);
    const node = graph.nodes.get(req.params.id);
    if (!node) return res.status(404).type('text/html').send('<h1>node not found</h1>');
    // Glance preview reflects the node's resolved theme: global default ⊕ node.
    res.type('text/html').send(renderNodePreview(paths, node));
  });

  // ONE version of ONE pane, read-only — what the pane-history popover shows
  // (GET /api/mounts/:id/history lists the versions). The same preview document
  // (lib/server/preview) and the same PREVIEW_CSP as /preview/node, handed a
  // node narrowed to that pane: no markdown, no other panes, the node's store
  // (the pane's script reads it) and theme. The pane is shown full-width and
  // never minimized — a collapsed pane would preview as an empty page.
  app.get('/preview/pane/:node/:mount', (req, res) => {
    res.setHeader('Content-Security-Policy', PREVIEW_CSP);
    const node = graph.nodes.get(req.params.node);
    if (!node) return res.status(404).type('text/html').send('<h1>node not found</h1>');
    const m = findMount(node, req.params.mount);
    if (!m) return res.status(404).type('text/html').send('<h1>pane not found in that node</h1>');
    const ps = { ...(m.pane_state || {}) };
    delete ps.minimized;
    delete ps.col;
    ps.colSpan = 12;
    const one = { id: node.id, mounts: [{ ...m, pane_state: ps }], store: node.store || {}, theme: node.theme };
    res.type('text/html').send(renderNodePreview(paths, one));
  });

  app.post('/api/graph/active', (req, res) => {
    const { id } = req.body || {};
    // guardReaim persists the steal immediately so the cleared lock can't reappear
    // if we bail on the 404 below (or the process dies before the later saveMeta).
    const g = guardReaim(graph, bus, { draftPath });
    if (!graph.nodes.has(id)) return res.status(404).json({ error: 'not found' });
    // A fresh lock QUEUES the intent (applied after the turn-end commit) —
    // never a 409 to the user; last queued intent wins.
    if (g.blocked) {
      setPendingReaim(graph, bus, { op: 'set-active', id });
      return res.json({ ok: true, pending: true, applies: 'turn-end', op: 'set-active', id });
    }
    graph.pendingReaim = null; // an immediate re-aim supersedes any queued intent
    res.json(execSetActive(id));
  });

  // Branch-on-edit: the user edited a form while previewing an older node.
  // Silent re-aim with auto-preserve — (1) if the live surface differs from the
  // active node, commit it first as a user-authored node so the re-aim can't
  // discard uncommitted work; (2) re-aim active onto the edited node. The next
  // commit then lands as a branch CHILD of that node; the original and its
  // downstream stay untouched (nodes are immutable, commits append-only).
  //
  // Deliberately NO broadcastReset: the editing client's DOM (the previewed
  // node + the in-flight edit) IS the new live state — a reset frame would eat
  // the keystroke that triggered the branch. Bystander clients adopt the new
  // state off the 'branch-here' WS frame instead (fetch node → fullReset).
  app.post('/api/graph/branch-here', (req, res) => {
    const { id } = req.body || {};
    const g = guardReaim(graph, bus, { draftPath });
    if (!graph.nodes.has(id)) return res.status(404).json({ error: 'not found' });
    if (g.blocked) {
      // The edit waits out the turn: queued, applied after the commit. The
      // editing client keeps its preview and completes the transition off the
      // eventual 'branch-here' WS frame.
      setPendingReaim(graph, bus, { op: 'branch-here', id });
      return res.json({ ok: true, pending: true, applies: 'turn-end', op: 'branch-here', id });
    }
    graph.pendingReaim = null;
    res.json(execBranchHere(id));
  });

  app.post('/api/turn-begin', (req, res) => {
    const { message = '', author = 'user' } = req.body || {};
    // The next node continues the current lineage (child of active). A *new*
    // top-level tree happens only when active is null — set exclusively by
    // `new graph` (POST /api/graph/new). `wipe` clears the panes but keeps
    // active, so it stays on the same graph. (A blank surface no longer implies
    // a new tree; that conflation is what `new graph` now makes explicit.)
    const r = acquireLock(graph, bus, { message, author });
    if (!r.ok) return res.status(409).json({ error: 'already locked', lock: r.lock });
    res.json({ ok: true, lock: r.lock, stole_stale_lock: r.stole_stale_lock, ...(r.upgraded_wake_lock ? { upgraded_wake_lock: true } : {}) });
  });

  app.post('/api/unlock', (req, res) => {
    const r = releaseLock(graph, bus);
    // A manual unlock releases the turn — honor whatever re-aim was waiting.
    const reaim = applyPendingReaim();
    res.json({ ok: true, cleared: r.cleared, ...(reaim ? { reaim } : {}) });
  });

  app.post('/api/turn-end', (req, res) => {
    const { author = 'claude', summary } = req.body || {};
    // The Stop hook's summary of Claude's reply (hooks/reply.js). Re-summarised
    // here because a request body is not trusted to be short or a string;
    // '' (absent) means the node simply records no reply.
    const reply = summarizeReply((req.body || {}).reply);
    // No lock, but the surface changed: this is the daemon-spawning turn. The
    // turn-begin hook found nothing reachable and returned WITHOUT locking (it
    // cannot lock a daemon that isn't running), then a tool call auto-spawned the
    // daemon and rendered. Answering `skipped:'no-lock'` here left that work
    // uncommitted until the NEXT prompt's turn-end swept it up and stamped it
    // with that prompt's message — provenance silently wrong for every
    // first-turn-after-spawn, against the promise that every turn commits a node.
    // Commit it as its own node instead, onto the current commit point, with a
    // trigger that says plainly why it carries no prompt.
    if (!graph.lock) {
      if (!liveIsDirty(graph)) return res.json({ ok: true, skipped: 'no-lock' });
      const u = commitNode(graph, bus, {
        draftPath, parentId: graph.active, author,
        triggerKind: 'unlocked-turn', message: '',
        summary: summary || 'turn that began before the daemon was running', reply,
        clearLock: false, op: 'turn-end', includeLabelAndUnlock: true,
      });
      return res.json({ ok: true, node_id: u.node_id, unlocked: true });
    }
    // A node exists only where the SURFACE actually changed. A turn that spent
    // itself in chat would otherwise commit a byte-identical copy of its parent,
    // and a run of those makes the graph unnavigable. liveIsDirty is the SAME
    // comparison branch-on-edit uses (mounts incl. per-pane theme + store +
    // comments + captures), so "changed" means exactly "this node would differ".
    //
    // liveIsDirty compares against graph.active; turn-end commits onto
    // graph.lock.base. Those are equal for the whole life of a fresh lock (every
    // re-aim queues while one is held), but if they ever diverge we commit
    // rather than reason about it — a spurious node is a nuisance, a lost node
    // is data loss.
    if (graph.lock.base === graph.active && !liveIsDirty(graph)) {
      const accumulated = skipTurn(graph, bus, { author, summary, reply });
      // The lock is released either way, so a re-aim the user queued mid-turn
      // must still be honoured — including the case where honouring it discards
      // the very turn we just accumulated (the context it belonged to is gone).
      const reaim = applyPendingReaim();
      return res.json({ ok: true, skipped: 'no-change', accumulated, ...(reaim ? { reaim } : {}) });
    }
    const r = commitNode(graph, bus, {
      draftPath, parentId: graph.lock.base, author,
      triggerKind: 'turn', message: graph.lock.message, summary, reply,
      clearLock: true, op: 'turn-end', includeLabelAndUnlock: true,
    });
    // Commit FIRST (on lock.base), then honor the re-aim the user queued
    // mid-turn — the turn's work lands where the turn began, and the user goes
    // where they asked to go.
    const reaim = applyPendingReaim();
    res.json({ ok: true, node_id: r.node_id, ...(reaim ? { reaim } : {}) });
  });

  // Wipe: empty the live surface's panes (store preserved) but STAY on the same
  // graph — active is kept, so the next turn continues the lineage. The next
  // committed node is bookmarked as the start of fresh content.
  app.post('/api/graph/wipe', (req, res) => {
    const g = guardReaim(graph, bus, { draftPath });
    // An optional label names that bookmark — "the fresh start I called X".
    // Absent/empty still bookmarks; it just has no label.
    const name = String((req.body && req.body.name) || '').trim();
    if (g.blocked) {
      setPendingReaim(graph, bus, { op: 'wipe', name });
      return res.json({ ok: true, pending: true, applies: 'turn-end', op: 'wipe', name });
    }
    graph.pendingReaim = null;
    res.json(execWipe(name));
  });

  // New graph: start a fresh top-level tree. Detaches active → null (so the next
  // turn's node is a new root) and bookmarks that root with the graph's name.
  app.post('/api/graph/new', (req, res) => {
    // guardReaim (unlike the old inline steal here) persists the stale-lock steal
    // immediately — fixing the drift where new-graph forgot saveMeta.
    const g = guardReaim(graph, bus, { draftPath });
    const name = String((req.body && req.body.name) || '').trim();
    if (g.blocked) {
      setPendingReaim(graph, bus, { op: 'new-graph', name });
      return res.json({ ok: true, pending: true, applies: 'turn-end', op: 'new-graph', name });
    }
    graph.pendingReaim = null;
    res.json(execNewGraph(name));
  });

  // Bookmark: name an existing node. Additive fields (bookmarked/name) only —
  // no schema bump, no migration. An empty/absent name un-bookmarks.
  app.post('/api/graph/bookmark', (req, res) => {
    const { id, name = '' } = req.body || {};
    const node = graph.nodes.get(id);
    if (!node) return res.status(404).json({ error: 'not found' });
    const trimmed = String(name || '').trim();
    node.bookmarked = !!trimmed;
    node.name = trimmed;
    graph.writeNode(node);
    const t = graph.topology.get(id);
    if (t) { t.bookmarked = node.bookmarked; t.name = node.name; }
    bus.emit({
      event: { kind: 'graph', op: 'bookmark', id, bookmarked: node.bookmarked },
      ws: { type: 'bookmark', id, bookmarked: node.bookmarked, name: node.name },
    });
    res.json({ ok: true, id, bookmarked: node.bookmarked, name: node.name });
  });

  app.post('/api/commit', (req, res) => {
    if (lockHeld(graph)) return res.status(409).json({ error: 'locked — use turn-end' });
    const { message = '', author = 'manual', summary } = req.body || {};
    const r = commitNode(graph, bus, {
      draftPath, parentId: graph.active, author,
      triggerKind: 'manual', message, summary,
      clearLock: false, op: 'commit', includeLabelAndUnlock: false,
    });
    res.json({ ok: true, node_id: r.node_id });
  });
}

module.exports = { mountGraphRoutes };
