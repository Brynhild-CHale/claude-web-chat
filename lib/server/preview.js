// lib/server/preview.js — the node preview document.
//
// One node, drawn as a self-contained page: the real 12-column grid with each
// pane's pane_state (span, height, minimized / pinned / locked), its persisted
// form_state and the node's resolved theme. It backs /preview/node/:id (graph
// thumbnails and the glance preview) and is the frame the replay player draws,
// which is why it lives here rather than inside routes/graph.js: two route
// files need the same document, and a second copy of it would be a second idea
// of what a node looks like.
//
// Pure: renderPreviewHtml takes an already-resolved theme and touches no disk.
// themeLayers is the one "what theme is this node drawn under" resolution —
// global default ⊕ node layer — shared with lib/server/export.js, which needs
// the two layers separately so it can fold each pane's own layer on top.

const { escapeHtml } = require('../core/html');
const { source: mountRuntimeSource } = require('./runtime/mount-runtime-src');
const { resolveDefault, normalizeTheme, mergeTokens, mergeCss, tokenDecls } = require('./theme');

function renderPreviewHtml(node, theme) {
  // Self-contained doc that hydrates the node's mounts into shadow-rooted panes.
  // No WS, and no API access: the store handed to a pane here has no publish
  // hook, and the response carries PREVIEW_CSP (lib/core/cors), whose
  // `connect-src 'none'` is what actually enforces the second half. Both are
  // needed — the document is served from the daemon's own origin, so withholding
  // the hook alone left an inline pane script free to `fetch` /api/render or
  // /api/store, and the graph viewer re-executes one of these documents per
  // visible node every time it draws.
  //
  // The iframes that embed it are deliberately NOT sandboxed in the graph
  // viewer: forwardEscapeFrom (public/app/graph-view.js) reads contentDocument to
  // re-dispatch Escape into the parent, which an opaque origin would silently
  // break. templates/components/node-render does sandbox its copy, because it
  // never reaches inside. The CSP is the part that holds for all three.
  const safeNode = JSON.stringify(node).replace(/<\/script/gi, '<\\/script');
  // Bake the node's resolved theme so glance previews reflect it: tokens go on
  // :root (chrome only — they don't cross the shadow boundary into pane content
  // here, matching the live surface), then the raw-CSS escape hatch is appended.
  const decls = tokenDecls((theme && theme.tokens) || {}, '    ');
  const rootTokens = decls ? `\n${decls}\n  ` : ' ';
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

// The theme a node is drawn under, as its layers and as the page-level merge:
//   global    — resolveDefault(paths): project theme.json → ~/.web-chat → builtins
//   nodeTheme — the node's own layer, normalized ({tokens:{}} when it has none)
//   page      — { tokens, css }: global ⊕ node, what a preview/export bakes on :root
// `node` may be null (nothing to layer on top of the global default).
function themeLayers(paths, node) {
  const global = resolveDefault(paths);
  const nodeTheme = node && node.theme ? normalizeTheme(node.theme) : { tokens: {} };
  return { global, nodeTheme, page: { tokens: mergeTokens(global, nodeTheme), css: mergeCss(global, nodeTheme) } };
}

// The preview document for a stored node, under its resolved theme.
function renderNodePreview(paths, node) {
  return renderPreviewHtml(node, themeLayers(paths, node).page);
}

module.exports = { renderPreviewHtml, renderNodePreview, themeLayers };
