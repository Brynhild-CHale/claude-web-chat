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
// Pure: renderPreviewHtml takes an already-resolved theme and touches no disk
// beyond the bundled font files it inlines (lib/server/fonts, read once each).
// Three pieces are shared with the page export (lib/server/export.js):
// themeLayers, the one "what theme is this node drawn under" resolution —
// global default ⊕ node layer, which the export needs as separate layers so it
// can fold each pane's own layer on top; pageItems, the page sequence with its
// markdown rendered; and drawPage, the run/placement layout both documents
// splice as source — so an exported page keeps the layout its preview shows.

const { source: mountRuntimeSource } = require('./runtime/mount-runtime-src');
const { source: pageCssSource } = require('./runtime/page-css-src');
const { resolveDefault, normalizeTheme, mergeTokensAt, mergeCssAt, tokenDecls, MODES, themeModes, getBuiltin } = require('./theme');
const { renderMarkdown } = require('../core/markdown');
const { pageOrder } = require('./domain/page');
const { inlineFontCss } = require('./fonts');

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

// THE page layout of a document the host writes — the one place a page sequence
// becomes markdown blocks and grid RUNS with each pane placed, for every document
// that is not the live chrome: this file's preview template (graph thumbnails,
// the glance, pane history, every replay frame) and the page export
// (lib/server/export.js). Both splice this function's SOURCE into their page
// (`drawPage.toString()`, the way lib/core/markdown hands the browser its
// renderer) and call it with their own pane drawer, so a node is laid out one
// way in its preview and in the file it exports to.
//
// It lays the page out as the live chrome does (public/app/page.js layoutPage):
// consecutive panes form a run — a `section.page-run > div.run-grid`, the
// 12-column grid public/page.css draws — keyed by its anchor (the markdown id
// above it, or 'start'), and a run whose flag is `runs[anchor].stacks === false`
// is `.fixed` (keeps its grid on a narrow screen and scrolls) where every other
// run `.stacks` (folds to one column). Each pane gets a `.pane` wrapper placed
// from its pane_state as public/app/mounts.js applyPaneState places it: --col
// (1–12, else auto), --span (1–12, else the whole row, cut to what fits right of
// --col) and, with `rows`, .has-rows + --rows (else the min-height an older pane
// was sized in), plus the minimized / locked / pinned classes. What goes INSIDE
// a wrapper is the caller's — `drawPane(m, pane)`, called once the wrapper is in
// the grid: the preview draws a header carrying the pane's flags, the export a
// card carrying the pane's baked tokens.
//
//   main      the container (.page) the sequence is drawn into
//   page      [{ md, html } | { pane }] in page order (pageItems below — the
//             markdown already rendered and escaped); null → every mount, in order
//   mounts    the node's mounts ({ id, pane_state, … })
//   runs      the node's run flags ({ [anchor]: { stacks: false } }), or null
//   drawPane  fills one placed wrapper
// Returns how many items it drew, so a caller can show its own empty state.
//
// Self-contained on purpose: the browser copy is this function's text, so it
// may reference nothing but its parameters and the DOM they lead to — a closure
// over a module-level helper would work here and throw a ReferenceError in the
// page (test/export.test.js runs it in both documents). Its text is spliced into
// an inline <script>, so it must never contain a script end tag or an HTML
// comment opener (test/export.test.js pins that too).
function drawPage(main, page, mounts, runs, drawPane) {
  var doc = main.ownerDocument;
  var byId = new Map();
  for (var i = 0; i < mounts.length; i++) byId.set(mounts[i].id, mounts[i]);
  var items = page || mounts.map(function (m) { return { pane: m.id }; });
  var flags = runs || {};
  var num = function (v) {
    var x = Number(v);
    return v != null && v !== '' && Number.isFinite(x) ? Math.round(x) : null;
  };
  var anchor = 'start';
  var grid = null;
  var drawn = 0;
  for (var k = 0; k < items.length; k++) {
    var item = items[k];
    if (item.md != null) {
      // Rendered on the host by lib/core/markdown: every character already escaped.
      var block = doc.createElement('div');
      block.className = 'md-block';
      block.setAttribute('data-md-id', item.md);
      block.innerHTML = item.html;
      main.appendChild(block);
      anchor = item.md;
      grid = null;
      drawn++;
      continue;
    }
    var m = byId.get(item.pane);
    if (!m) continue;
    if (!grid) {
      var run = doc.createElement('section');
      var fixed = !!(flags[anchor] && flags[anchor].stacks === false);
      run.className = 'page-run ' + (fixed ? 'fixed' : 'stacks');
      run.setAttribute('data-anchor', anchor);
      grid = doc.createElement('div');
      grid.className = 'run-grid';
      run.appendChild(grid);
      main.appendChild(run);
    }
    var ps = m.pane_state || {};
    var pane = doc.createElement('div');
    pane.className = 'pane'
      + (ps.minimized ? ' minimized' : '')
      + (ps.locked ? ' locked' : '')
      + (ps.pinned ? ' pinned' : '');
    var col = num(ps.col);
    if (col != null && (col < 1 || col > 12)) col = null;
    var span = num(ps.colSpan);
    span = span != null && span >= 1 ? Math.min(span, 12) : 12;
    if (col != null) span = Math.min(span, 13 - col);
    pane.style.setProperty('--col', col != null ? String(col) : 'auto');
    pane.style.setProperty('--span', String(span));
    var rows = num(ps.rows);
    if (rows != null) {
      pane.classList.add('has-rows');
      pane.style.setProperty('--rows', String(rows));
    } else {
      var hpx = ps.heightPx;
      if (hpx == null && ps.rowSpan && ps.rowSpan > 1) hpx = ps.rowSpan * 60;
      if (hpx) pane.style.minHeight = hpx + 'px';
    }
    grid.appendChild(pane);
    drawn++;
    drawPane(m, pane);
  }
  return drawn;
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
//
// First the bundled faces the theme names — lib/server/fonts inlineFontCss, the
// export's own inliner — every url() a data: URI. Nothing drawn from this
// template can fetch /fonts/: the chrome frames a preview in an opaque origin,
// and a downloaded replay.html or a GIF/video render has no server at all; so
// PREVIEW_CSP (lib/core/cors) admits `font-src data:` and nothing else. Without
// them Georgetown Blue's Caslon drew in Georgia (and Earthy's Geist in
// system-ui) in every thumbnail, glance, pane-history version, replay frame and
// rendered GIF. The faces go ahead of the raw css, so an unbalanced rule there
// cannot swallow them; a theme that names no bundled family adds nothing.
//
// Then the tokens on :root (chrome only — they don't cross the shadow boundary
// into pane content here, matching the live surface), then the raw-CSS escape
// hatch. A second :root rule after the base one is the same cascade as folding
// the declarations into it: the base rule sets no --wc-* property of its own.
function previewThemeCss(theme) {
  const tokens = (theme && theme.tokens) || {};
  const css = (theme && typeof theme.css === 'string') ? theme.css : null;
  const fonts = inlineFontCss([...Object.values(tokens), css]);
  const faces = fonts ? `\n/* bundled fonts */\n${fonts}` : '';
  const decls = tokenDecls(tokens, '    ');
  const rootTokens = decls ? `\n  :root {\n${decls}\n  }` : '';
  const rawCss = css != null ? `\n/* theme css */\n${css.replace(/<\/style/gi, '<\\/style')}` : '';
  return faces + rootTokens + rawCss;
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
  // The CSP binds only THIS document's realm, though: framed same-origin, old
  // pane code could still reach the chrome's realm (no CSP) through parent/top.
  // So the chrome frames every copy it shows sandboxed — `allow-scripts`, no
  // `allow-same-origin` — the graph inspector's thumbnail, the glance and a
  // block's version preview (public/app/graph-view.js PREVIEW_SANDBOX), as
  // templates/components/node-render does; Escape comes back by postMessage
  // (the script at the head of <body>). The REPLAY player is the exception: the
  // chrome drives it through its contentWindow and it measures its step frames
  // (<iframe srcdoc> of this template, inheriting the CSP), so it is same-origin
  // and top-reachable — an accepted, recorded risk (r3 holds, security-preview-
  // frames-escape-csp).
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
<script>
  // The chrome frames this document SANDBOXED (an opaque origin it cannot read
  // into), so a keypress focused here cannot be forwarded by reaching in: say it
  // instead (public/app/graph-view.js forwardEscapeFrom). Before the panes, so a
  // pane script cannot stop it being wired.
  if (window.parent !== window) {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { try { window.parent.postMessage({ wc: 'escape' }, '*'); } catch (err) {} }
    });
  }
</script>
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

  // The page layout — drawPage, the one the page export draws with too: the
  // sequence (baked by previewNodeJson, pageItems on the host) cut into markdown
  // blocks and grid runs, each pane placed from its pane_state; this document
  // fills each placed wrapper with a header and the pane itself.
  const drawPage = ${drawPage.toString()};
  const drawn = drawPage(main, NODE.page || null, NODE.mounts || [], NODE.runs || null, (m, pane) => {
    const ps = m.pane_state || {};
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

    const { root: sr, scripts } = window.__wcMount.attachAndExtract(host, m.html || '');
    window.__wcMount.runScripts(sr, scripts, store, m.params || {}, m.id);
    // rehydrate persisted form values (typed drafts travel with the node)
    if (m.form_state) window.__wcMount.applyFormState(sr, m.form_state);
    // post-script title rewrite (matches live behavior)
    const hostTitle = host.dataset && host.dataset.paneTitle;
    if (hostTitle && !(m.params && m.params.title)) title.textContent = hostTitle;
  });
  if (!drawn) main.innerHTML = '<div class="empty">node has no mounts</div>';
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
//   layers    — the cascade, least-specific first (what a pane layer goes on top of)
//   page      — { tokens, css }: global ⊕ node, what a preview/export bakes on :root
// `node` may be null (nothing to layer on top of the global default). `mode`
// ('light' | 'dark') is the viewer's — the server has none of its own
// (lib/server/theme DEFAULT_MODE) — so only a caller that knows it passes one:
// the chrome framing a preview next to the live page it is drawn in (graph
// inspector, glance, pane history, the replay player). Downloads and exports
// name none unless their caller explicitly asks, so they stay light.
//
// Under a global theme that declares no modes — an existing project on the
// stock look (empty tokens) or a theme saved before packs — the live chrome's
// light/dark comes from public/app.css's own fallbacks, which ARE the Earthy
// pack. The preview document's fallbacks are one fixed light look, so a named
// mode draws such a theme over Earthy at that mode, and a dark viewer gets a
// dark thumbnail instead of a white one. With no mode named nothing changes.
function themeLayers(paths, node, mode = null) {
  const global = resolveDefault(paths);
  const nodeTheme = node && node.theme ? normalizeTheme(node.theme) : { tokens: {} };
  const layers = [global, nodeTheme];
  if (mode && !themeModes(global).length) layers.unshift(getBuiltin('earthy'));
  return {
    global, nodeTheme, layers,
    page: { tokens: mergeTokensAt(mode, layers), css: mergeCssAt(mode, layers) },
  };
}

// A `?mode=` query value, when it names a mode; else null (DEFAULT_MODE).
const modeParam = (v) => (MODES.includes(v) ? v : null);

// The preview document for a stored node, under its resolved theme.
function renderNodePreview(paths, node, { mode = null } = {}) {
  return renderPreviewHtml(node, themeLayers(paths, node, mode).page);
}

module.exports = {
  renderPreviewHtml, renderNodePreview, themeLayers, pageItems, modeParam,
  // the page layout, as the function whose source both documents splice
  drawPage,
  // the template's pieces + the two hole fillers — the replay document's frames
  previewTemplate, previewThemeCss, previewNodeJson,
};
