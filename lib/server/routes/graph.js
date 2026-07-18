function renderPreviewHtml(node, theme) {
  // Self-contained doc that hydrates the node's mounts into shadow-rooted panes.
  // No WS, no API access — mount scripts run against a local in-memory store only.
  const safeNode = JSON.stringify(node).replace(/<\/script/gi, '<\\/script');
  // Bake the node's resolved theme so glance previews reflect it: tokens go on
  // :root (chrome only — they don't cross the shadow boundary into pane content
  // here, matching the live surface), then the raw-CSS escape hatch is appended.
  const tokens = (theme && theme.tokens) || {};
  const tokenDecls = Object.entries(tokens)
    .filter(([k]) => /^--wc-[\w-]+$/.test(k))
    .map(([k, v]) => `    ${k}: ${String(v).replace(/[{}<]/g, '')};`)
    .join('\n');
  const rootTokens = tokenDecls ? `\n${tokenDecls}\n  ` : ' ';
  const rawCss = (theme && typeof theme.css === 'string') ? `\n/* theme css */\n${theme.css.replace(/<\/style/gi, '<\\/style')}` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>node ${escapeHtml(node.id)} preview</title>
<style>
  :root {${rootTokens}font-family: var(--wc-font, ui-sans-serif, system-ui, -apple-system, sans-serif); color: var(--wc-fg, #111); }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--wc-bg, #fafafa); }
  main {
    padding: 12px;
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    grid-auto-rows: minmax(40px, auto);
    gap: 10px;
  }
  .pane {
    background: var(--wc-panel-bg, #fff); border: 1px solid var(--wc-border, #e3e3e3); border-radius: var(--wc-radius, 8px);
    grid-column: span 12; display: flex; flex-direction: column; min-width: 0;
  }
  .pane.minimized { display: none; }
  .pane.locked { border-color: var(--wc-gold, #d4a72c); }
  .pane.pinned { border-color: var(--wc-accent, #0969da); }
  .pane-header {
    padding: 4px 8px; border-bottom: 1px solid var(--wc-border-light, #eaeef2);
    background: var(--wc-header-bg, #fafbfc); border-radius: var(--wc-radius, 8px) var(--wc-radius, 8px) 0 0;
    font: 600 11.5px var(--wc-mono, ui-monospace, Menlo, monospace); color: var(--wc-muted, #57606a);
    display: flex; gap: 6px; align-items: center;
  }
  .pane-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pane-flag { font-size: 11px; }
  .mount-host { padding: 12px; flex: 1; min-height: 24px; }
  .empty { padding: 24px; text-align: center; color: var(--wc-muted, #8c959f); font-size: 13px; font-style: italic; }${rawCss}
</style>
</head>
<body>
<main id="main"></main>
<script>${mountRuntimeSource()}</script>
<script>
  const NODE = ${safeNode};
  const main = document.getElementById('main');

  // Sandboxed store from the shared runtime, seeded with the node snapshot. NOT
  // put on window (preview is a read-only sandbox) and given NO publish hook, so
  // mutations stay inside this doc; subscriptions still work.
  const store = window.__wcMount.createStore(NODE.store || {});

  const mounts = NODE.mounts || [];
  if (!mounts.length) {
    main.innerHTML = '<div class="empty">node has no mounts</div>';
  }
  for (const m of mounts) {
    const ps = m.pane_state || {};
    const pane = document.createElement('div');
    pane.className = 'pane'
      + (ps.minimized ? ' minimized' : '')
      + (ps.locked ? ' locked' : '')
      + (ps.pinned ? ' pinned' : '');
    pane.style.gridColumn = 'span ' + (ps.colSpan || 12);
    let hpx = ps.heightPx;
    if (hpx == null && ps.rowSpan && ps.rowSpan > 1) hpx = ps.rowSpan * 60;
    if (hpx) pane.style.minHeight = hpx + 'px';

    const header = document.createElement('div');
    header.className = 'pane-header';
    const title = document.createElement('span');
    title.className = 'pane-title';
    title.textContent = (m.params && m.params.title) || m.id;
    header.appendChild(title);
    if (ps.pinned) { const s = document.createElement('span'); s.className = 'pane-flag'; s.textContent = '📌'; header.appendChild(s); }
    if (ps.locked) { const s = document.createElement('span'); s.className = 'pane-flag'; s.textContent = '🔒'; header.appendChild(s); }
    pane.appendChild(header);

    const host = document.createElement('div');
    host.id = m.id;
    host.className = 'mount-host';
    pane.appendChild(host);
    main.appendChild(pane);

    const { root: sr, scripts } = window.__wcMount.attachAndExtract(host, m.html || '');
    window.__wcMount.runScripts(sr, scripts, store, m.params || {}, m.id);
    // rehydrate persisted form values (typed drafts travel with the node)
    if (m.form_state) window.__wcMount.applyFormState(sr, m.form_state);
    // post-script title rewrite (matches live behavior)
    const hostTitle = host.dataset && host.dataset.paneTitle;
    if (hostTitle && !(m.params && m.params.title)) title.textContent = hostTitle;
  }
</script>
</body>
</html>`;
}

const { escapeHtml } = require('../util/html');
const { projectPaths } = require('../../core/paths');
const { computeLabels } = require('../graph');
const {
  deleteDraft, acquireLock, releaseLock, guardReaim, lockHeld, commitNode, liveIsDirty,
  setPendingReaim, takePendingReaim,
} = require('../domain/turns');
const { source: mountRuntimeSource } = require('../runtime/mount-runtime-src');
const { diffNodes } = require('../diff');
const { resolveDefault, normalizeTheme, mergeTokens, mergeCss } = require('../theme');

function mountGraphRoutes(app, { graph, paths, bus, broadcastReset }) {
  const draftPath = projectPaths(paths.root).draft;

  // ── Re-aim executors ──────────────────────────────────────────────────────
  // The four re-aim bodies, extracted so each runs from TWO places: the route
  // (no fresh lock → execute now) and applyPendingReaim (a fresh lock queued
  // the intent; turn-end/unlock applies it). Behavior is byte-identical to the
  // old inline route bodies.
  function execSetActive(id) {
    graph.active = id;
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

  function execWipe() {
    graph.clearLiveMounts();
    graph.pendingBookmark = { name: '' };
    deleteDraft(draftPath);
    broadcastReset();
    bus.emit({ event: { kind: 'graph', op: 'wipe' } });
    return { ok: true, active: graph.active };
  }

  function execNewGraph(name) {
    graph.clearLiveMounts();
    graph.active = null;
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
    const r = intent.op === 'wipe' ? execWipe()
      : intent.op === 'new-graph' ? execNewGraph(intent.name || '')
      : intent.op === 'branch-here' ? execBranchHere(intent.id)
      : execSetActive(intent.id);
    return { op: intent.op, ...(intent.id ? { id: intent.id } : {}), ok: r.ok };
  }
  app.get('/api/graph', (req, res) => {
    const labels = computeLabels(graph);
    res.json({
      nodes: [...graph.topology.values()].map(t => ({ ...t, label: labels.get(t.id) || t.id })),
      active: graph.active,
      active_label: graph.active ? (labels.get(graph.active) || null) : null,
      lock: graph.lock,
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
    const labels = computeLabels(graph);
    const labelToId = new Map();
    for (const [id, label] of labels) labelToId.set(label, id);

    const resolveRef = (ref) => {
      const s = String(ref);
      if (s === 'live') {
        const snap = graph.snapshotLive();
        // The live surface has no node-level theme of its own; until the turn
        // commits it mirrors the active node, so borrow that node's theme.
        // (Hardcoding null here would report a spurious full-theme removal when
        // diffing a themed `active` against `live`.)
        const liveTheme = graph.active ? (graph.nodes.get(graph.active)?.theme ?? null) : null;
        return { ok: true, value: { id: 'live', label: 'live', node: { mounts: snap.mounts, store: snap.store, theme: liveTheme } } };
      }
      if (s === 'active') {
        if (!graph.active) return { ok: false, error: 'no active node — the surface has no commit point yet (try `live`)' };
        return { ok: true, value: { id: graph.active, label: labels.get(graph.active) || graph.active, node: graph.nodes.get(graph.active) } };
      }
      const id = graph.nodes.has(s) ? s : labelToId.get(s);
      if (!id || !graph.nodes.has(id)) return { ok: false, error: 'node not found' };
      return { ok: true, value: { id, label: labels.get(id) || id, node: graph.nodes.get(id) } };
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
    const node = graph.nodes.get(req.params.id);
    if (!node) return res.status(404).type('text/html').send('<h1>node not found</h1>');
    // Glance preview reflects the node's resolved theme: global default ⊕ node.
    const global = resolveDefault(paths);
    const nodeTheme = node.theme ? normalizeTheme(node.theme) : { tokens: {} };
    const theme = { tokens: mergeTokens(global, nodeTheme), css: mergeCss(global, nodeTheme) };
    res.type('text/html').send(renderPreviewHtml(node, theme));
  });

  app.post('/api/graph/active', (req, res) => {
    const { id } = req.body || {};
    // guardReaim persists the steal immediately so the cleared lock can't reappear
    // if we bail on the 404 below (or the process dies before the later saveMeta).
    const g = guardReaim(graph, bus);
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
    const g = guardReaim(graph, bus);
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
    if (!graph.lock) return res.json({ ok: true, skipped: 'no-lock' });
    const { author = 'claude', summary } = req.body || {};
    const r = commitNode(graph, bus, {
      draftPath, parentId: graph.lock.base, author,
      triggerKind: 'turn', message: graph.lock.message, summary,
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
    const g = guardReaim(graph, bus);
    if (g.blocked) {
      setPendingReaim(graph, bus, { op: 'wipe' });
      return res.json({ ok: true, pending: true, applies: 'turn-end', op: 'wipe' });
    }
    graph.pendingReaim = null;
    res.json(execWipe());
  });

  // New graph: start a fresh top-level tree. Detaches active → null (so the next
  // turn's node is a new root) and bookmarks that root with the graph's name.
  app.post('/api/graph/new', (req, res) => {
    // guardReaim (unlike the old inline steal here) persists the stale-lock steal
    // immediately — fixing the drift where new-graph forgot saveMeta.
    const g = guardReaim(graph, bus);
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
