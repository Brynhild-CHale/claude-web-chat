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
const { deleteDraft, acquireLock, releaseLock, guardReaim, lockHeld, commitNode } = require('../domain/turns');
const { source: mountRuntimeSource } = require('../runtime/mount-runtime-src');
const { diffNodes } = require('../diff');
const { resolveDefault, normalizeTheme, mergeTokens, mergeCss } = require('../theme');

function mountGraphRoutes(app, { graph, paths, bus, broadcastReset }) {
  const draftPath = projectPaths(paths.root).draft;
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
    if (g.blocked) return res.status(409).json({ error: 'locked', lock: g.lock });
    if (!graph.nodes.has(id)) return res.status(404).json({ error: 'not found' });
    graph.active = id;
    graph.restoreLiveToNode(id, bus);
    graph.saveMeta();
    deleteDraft(draftPath);
    broadcastReset();
    bus.emit({ event: { kind: 'graph', op: 'set-active', id } });
    res.json({ ok: true, active: id });
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
    res.json({ ok: true, lock: r.lock, stole_stale_lock: r.stole_stale_lock });
  });

  app.post('/api/unlock', (req, res) => {
    const r = releaseLock(graph, bus);
    res.json({ ok: true, cleared: r.cleared });
  });

  app.post('/api/turn-end', (req, res) => {
    if (!graph.lock) return res.json({ ok: true, skipped: 'no-lock' });
    const { author = 'claude', summary } = req.body || {};
    const r = commitNode(graph, bus, {
      draftPath, parentId: graph.lock.base, author,
      triggerKind: 'turn', message: graph.lock.message, summary,
      clearLock: true, op: 'turn-end', includeLabelAndUnlock: true,
    });
    res.json({ ok: true, node_id: r.node_id });
  });

  // Wipe: empty the live surface's panes (store preserved) but STAY on the same
  // graph — active is kept, so the next turn continues the lineage. The next
  // committed node is bookmarked as the start of fresh content.
  app.post('/api/graph/wipe', (req, res) => {
    const g = guardReaim(graph, bus);
    if (g.blocked) return res.status(409).json({ error: 'locked', lock: g.lock });
    graph.clearLiveMounts();
    graph.pendingBookmark = { name: '' };
    deleteDraft(draftPath);
    broadcastReset();
    bus.emit({ event: { kind: 'graph', op: 'wipe' } });
    res.json({ ok: true, active: graph.active });
  });

  // New graph: start a fresh top-level tree. Detaches active → null (so the next
  // turn's node is a new root) and bookmarks that root with the graph's name.
  app.post('/api/graph/new', (req, res) => {
    // guardReaim (unlike the old inline steal here) persists the stale-lock steal
    // immediately — fixing the drift where new-graph forgot saveMeta.
    const g = guardReaim(graph, bus);
    if (g.blocked) return res.status(409).json({ error: 'locked', lock: g.lock });
    const name = String((req.body && req.body.name) || '').trim();
    graph.clearLiveMounts();
    graph.active = null;
    graph.pendingBookmark = { name };
    graph.saveMeta();
    deleteDraft(draftPath);
    broadcastReset();
    bus.emit({ event: { kind: 'graph', op: 'new-graph', name } });
    res.json({ ok: true, active: null, name });
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
