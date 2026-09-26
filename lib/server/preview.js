// lib/server/preview.js — the node preview document.
//
// One node, drawn as a self-contained page: its page sequence (domain/page
// pageOrder — panes and markdown items interleaved; a node with no markdown is
// just its mounts array) laid out the way the live chrome lays it out — each run
// of consecutive panes its own 12-column grid, under the ONE page stylesheet
// (public/page.css, inlined) — each pane placed by its pane_state (col, span,
// rows; minimized / pinned / locked) and persisted
// form_state, each markdown item rendered by the one renderer
// (lib/core/markdown), all under the node's resolved theme. It backs
// /preview/node/:id (graph thumbnails and the glance preview), /preview/pane
// (one version of one pane, for pane history) and is the frame the replay
// player draws — which is why it lives here rather than inside routes/graph.js:
// three callers need the same document, and a second copy of it would be a
// second idea of what a node looks like.
//
// Pure: renderPreviewHtml takes an already-resolved theme and touches no disk.
// themeLayers is the one "what theme is this node drawn under" resolution —
// global default ⊕ node layer — shared with lib/server/export.js, which needs
// the two layers separately so it can fold each pane's own layer on top.

const { source: mountRuntimeSource } = require('./runtime/mount-runtime-src');
const { source: pageCssSource } = require('./runtime/page-css-src');
const { resolveDefault, normalizeTheme, mergeTokens, mergeCss, tokenDecls } = require('./theme');
const { renderMarkdown } = require('../core/markdown');
const { pageOrder } = require('./domain/page');

// A node's page sequence, ready to draw: `{ pane: id }` for a pane and
// `{ md: id, html }` for a markdown item, in page order. The markdown is rendered
// HERE, on the host, by the one renderer — every character already escaped — so
// neither the preview document nor an export carries a parser of its own.
// lib/server/export.js reads the same list.
function pageItems(node) {
  const mdById = new Map(((node && node.markdown) || []).map((m) => [m.id, m]));
  return pageOrder(node || {}).map((id) => (mdById.has(id)
    ? { md: id, html: renderMarkdown(mdById.get(id).text) }
    : { pane: id }));
}

// The preview document is ONE template with two holes — the node's theme and
// the node itself — so the same bytes can be filled on the server (one node,
// renderPreviewHtml) or in a replay document's browser (one frame per step, from
// a payload that carries the template once rather than N copies of the runtime:
// lib/server/replay/document.js). previewTemplate() is the three fixed pieces
// around the holes; previewThemeCss / previewNodeJson are the ONLY two
// producers of what goes in them, and both are already escaped for the element
// they land in, so a filler only ever concatenates:
//
//   pieces[0] + previewThemeCss(theme) + pieces[1] + previewNodeJson(node) + pieces[2]
//
// Splitting at build time (not substituting a placeholder at fill time) means a
// pane whose own html happens to contain the placeholder text can never be
// mistaken for the hole.
const THEME_HOLE = '\u0000wc-preview-theme\u0000';
const NODE_HOLE = '\u0000wc-preview-node\u0000';

// The node, as the JS expression the template's `const NODE = …;` takes: the
// node with its page sequence baked in as `page` (pageItems — rendered markdown,
// so the raw `markdown` texts are not carried twice). A `<` can only occur
// inside a JSON string, where `\u003c` means the same character, so escaping
// every one leaves no `</script` to break out of the element and no `<!--` to
// push the parser into the script-data-escaped state. Everything else in JSON is
// already a valid JS literal (U+2028/9 included, since ES2019).
function previewNodeJson(node) {
  const { markdown: _rendered, ...rest } = node == null ? {} : node;
  return JSON.stringify({ ...rest, page: pageItems(node) }).replace(/</g, '\\u003c');
}

// The node's resolved theme, as the text appended to the template's <style>.
// Tokens go on :root (chrome only — they don't cross the shadow boundary into
// pane content here, matching the live surface), then the raw-CSS escape hatch.
// A second :root rule after the base one is the same cascade as folding the
// declarations into it: the base rule sets no --wc-* property of its own.
function previewThemeCss(theme) {
  const decls = tokenDecls((theme && theme.tokens) || {}, '    ');
  const rootTokens = decls ? `\n  :root {\n${decls}\n  }` : '';
  const rawCss = (theme && typeof theme.css === 'string') ? `\n/* theme css */\n${theme.css.replace(/<\/style/gi, '<\\/style')}` : '';
  return rootTokens + rawCss;
}

let templateCache = null;
function previewTemplate() {
  if (templateCache) return templateCache;
  // Trusted static source; the one sequence that could end the <style> early is
  // broken anyway, as the theme css is.
  const pageCss = pageCssSource().replace(/<\/style/gi, '<\\/style');
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
  // never reaches inside. The CSP is the part that holds for all three. (A
  // replay frame is an <iframe srcdoc> of this template inside a document served
  // under the same CSP, which a srcdoc child inherits.)
  const full = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>node preview</title>
<style>
  :root { font-family: var(--wc-font, ui-sans-serif, system-ui, -apple-system, sans-serif); color: var(--wc-fg, #111); }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--wc-bg, #fafafa); }
  main { padding: 12px; }
  .pane {
    background: var(--wc-panel-bg, #fff); border: 1px solid var(--wc-border, #e3e3e3); border-radius: var(--wc-radius, 8px);
    display: flex; flex-direction: column; min-width: 0;
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
  .mount-host { padding: 12px; flex: 1; min-height: 24px; overflow: auto; }
/* public/page.css — the page's layout and prose, shared with the live chrome */
${pageCss}
  .empty { padding: 24px; text-align: center; color: var(--wc-muted, #8c959f); font-size: 13px; font-style: italic; }${THEME_HOLE}
</style>
</head>
<body>
<main id="main" class="page"></main>
<script>${mountRuntimeSource()}</script>
<script>
  const NODE = ${NODE_HOLE};
  const main = document.getElementById('main');
  // Named here rather than in <title>: the id is data, and the template holds none.
  document.title = 'node ' + NODE.id + ' preview';

  // Sandboxed store from the shared runtime, seeded with the node snapshot. NOT
  // put on window (preview is a read-only sandbox) and given NO publish hook, so
  // mutations stay inside this doc; subscriptions still work.
  const store = window.__wcMount.createStore(NODE.store || {});

  const mounts = NODE.mounts || [];
  const byId = new Map(mounts.map((m) => [m.id, m]));
  // The page sequence, baked by previewNodeJson (pageItems on the host).
  const PAGE = NODE.page || mounts.map((m) => ({ pane: m.id }));
  if (!PAGE.length) {
    main.innerHTML = '<div class="empty">node has no mounts</div>';
  }
  // Cut the sequence into markdown blocks and grid RUNS (consecutive panes),
  // each run keyed by its anchor — the markdown id before it, or 'start' — which
  // is what its narrow-screen flag (NODE.runs) is stored under.
  const RUNS = NODE.runs || {};
  let anchor = 'start';
  let grid = null;
  for (const item of PAGE) {
    if (item.md != null) {
      // Server-rendered by lib/core/markdown: every character already escaped.
      const block = document.createElement('div');
      block.className = 'md-block';
      block.setAttribute('data-md-id', item.md);
      block.innerHTML = item.html;
      main.appendChild(block);
      anchor = item.md;
      grid = null;
      continue;
    }
    const m = byId.get(item.pane);
    if (!m) continue;
    if (!grid) {
      const run = document.createElement('section');
      const fixed = !!(RUNS[anchor] && RUNS[anchor].stacks === false);
      run.className = 'page-run ' + (fixed ? 'fixed' : 'stacks');
      run.setAttribute('data-anchor', anchor);
      grid = document.createElement('div');
      grid.className = 'run-grid';
      run.appendChild(grid);
      main.appendChild(run);
    }
    const ps = m.pane_state || {};
    const pane = document.createElement('div');
    pane.className = 'pane'
      + (ps.minimized ? ' minimized' : '')
      + (ps.locked ? ' locked' : '')
      + (ps.pinned ? ' pinned' : '');
    // Placed as the live chrome places it (public/app/mounts.js applyPaneState):
    // three custom properties public/page.css turns into the grid area.
    const n = (v) => { const x = Number(v); return v != null && v !== '' && Number.isFinite(x) ? Math.round(x) : null; };
    const col = n(ps.col) != null && n(ps.col) >= 1 && n(ps.col) <= 12 ? n(ps.col) : null;
    let span = n(ps.colSpan) != null && n(ps.colSpan) >= 1 ? Math.min(n(ps.colSpan), 12) : 12;
    if (col != null) span = Math.min(span, 13 - col);
    pane.style.setProperty('--col', col != null ? String(col) : 'auto');
    pane.style.setProperty('--span', String(span));
    const rows = n(ps.rows);
    if (rows != null) { pane.classList.add('has-rows'); pane.style.setProperty('--rows', String(rows)); }
    else {
      let hpx = ps.heightPx;
      if (hpx == null && ps.rowSpan && ps.rowSpan > 1) hpx = ps.rowSpan * 60;
      if (hpx) pane.style.minHeight = hpx + 'px';
    }

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
    grid.appendChild(pane);

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
  const [a, rest] = full.split(THEME_HOLE);
  const [b, c] = rest.split(NODE_HOLE);
  templateCache = Object.freeze([a, b, c]);
  return templateCache;
}

function renderPreviewHtml(node, theme) {
  const [a, b, c] = previewTemplate();
  return a + previewThemeCss(theme) + b + previewNodeJson(node) + c;
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

module.exports = {
  renderPreviewHtml, renderNodePreview, themeLayers, pageItems,
  // the template's pieces + the two hole fillers — the replay document's frames
  previewTemplate, previewThemeCss, previewNodeJson,
};
