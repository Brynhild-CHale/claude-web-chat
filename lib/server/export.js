const fs = require('fs');
const path = require('path');
const { normalizeTheme, mergeTokensAt, tokenDecls } = require('./theme');
const { inlineFontCss } = require('./fonts');
const brand = require('./brand');
const { resolveNodeRef } = require('./domain/refs');
// The node's theme layers and its page sequence come from the preview engine —
// one idea of what a node looks like. Markdown is rendered at EXPORT time
// (pageItems, lib/core/markdown), so the exported page carries finished,
// escaped HTML and no parser.
const { themeLayers, pageItems } = require('./preview');

// ---------------------------------------------------------------------------
// Self-contained page export.
//
// A graph node is { mounts: [{id, html, target, params, pane_state, theme}],
// store, comments }. Every pane's HTML/JS is already a string and the store is
// plain data, so a node serializes to one interactive .html with no headless
// browser: a minimal shell + THE shared mount runtime (public/mount-runtime.js —
// the same source the live client and the preview use) + a small EXPORT_SHELL
// that drives it (createStore without the WebSocket publish, one pane card each).
//
// assembleExport() is pure (no fs / no ctx) so it unit-tests in isolation — the
// runtime source is read+memoized at module load (lib/server/runtime/
// mount-runtime-src.js), not inside assembleExport. The ctx-dependent resolution
// (nodeForExport / resolveExportTheme / writeExport) sits below it.
// ---------------------------------------------------------------------------

// Escape a value for safe interpolation into HTML text/attributes. The engine is
// lib/core/html — this was a private fifth copy of the identical replace chain,
// differing only in the coercion (core renders nullish as '' rather than the
// literal 'null', which is what this file wants too). `htmlEscape` stays as the
// local name so the call sites and the test export read unchanged.
const { escapeHtml: htmlEscape } = require('../core/html');

// Serialize an object for embedding inside <script type="application/json">.
// Escaping `<` and `>` neutralizes `</script>`, `<!--`, and `<script` breakout;
// U+2028/U+2029 are escaped because they're raw newlines in JS string context.
// JSON.parse decodes < etc. back to the original characters at view time.
function jsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Neutralize the one sequence that can break out of an HTML <style> raw-text
// element: the literal `</style`. Raw theme css (mergeCss) is author-controlled
// and kept verbatim by normalizeTheme (lib/server/theme.js) — the live client
// injects it via element.textContent (parser-safe), but an export emits it as
// text inside <style>…</style> in the served document, where the recipient's
// HTML parser WOULD honor a `</style>`. Breaking `</` keeps it inert CSS.
function styleSafe(css) {
  return String(css || '').replace(/<\//g, '<\\/');
}

// Base CSS for the export shell + pane cards. Mirrors the client's token-
// consuming pattern: every literal routes through var(--wc-TOKEN, <fallback>),
// so an unthemed export still looks right and a baked :root token overrides it.
const BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html { font-family: var(--wc-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
  color: var(--wc-fg, #111); }
body { margin: 0; background: var(--wc-bg, #fafafa); padding: 20px; }
#export-head { max-width: 1100px; margin: 0 auto 16px; display: flex; align-items: baseline;
  gap: 10px; color: var(--wc-muted, #57606a); font-size: 12.5px; }
#export-head .label { font-family: var(--wc-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-weight: 700; color: var(--wc-fg, #24292f); font-size: 13px; }
#export-main { max-width: 1100px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.pane { background: var(--wc-panel-bg, #fff); border: 1px solid var(--wc-border, #e3e3e3);
  border-radius: var(--wc-radius, 8px); box-shadow: var(--wc-shadow, 0 1px 3px rgba(0,0,0,0.08));
  overflow: hidden; }
.pane > .pane-title { font: 600 12px var(--wc-font, ui-sans-serif, system-ui);
  color: var(--wc-muted, #57606a); padding: 7px 12px;
  border-bottom: 1px solid var(--wc-border-light, #eaeef2); background: var(--wc-header-bg, #fbfcfd); }
.pane > .mount-host { display: block; padding: 12px; }
#export-head .brand-lockup { height: 52px; max-width: 260px; object-fit: contain; object-position: left center;
  align-self: center; margin-right: auto; }
#export-head.has-lockup { padding-bottom: 12px; border-bottom: 2px solid var(--wc-topbar-border, var(--wc-border, #e3e3e3)); }
#export-foot { max-width: 1100px; margin: 16px auto 0; display: flex; align-items: center; gap: 10px;
  padding-top: 10px; border-top: 1px solid var(--wc-border, #e3e3e3);
  font: 10.5px var(--wc-mono, ui-monospace, SFMono-Regular, Menlo, monospace); color: var(--wc-muted, #57606a); }
#export-foot .brand-seal { width: 44px; height: 44px; object-fit: contain; margin-left: auto; }
#export-empty { max-width: 1100px; margin: 0 auto; color: var(--wc-muted, #888);
  font: 13px var(--wc-font, ui-sans-serif, system-ui); }
`.trim();

// The page stylesheet (public/page.css): how the page's markdown reads — the
// same bytes the live chrome links and the node preview inlines. The export's
// own layout is the column above; the prose is the page's.
const PAGE_CSS = require('./runtime/page-css-src').source();

// THE shared mount runtime, read once as text (public/mount-runtime.js). Spliced
// verbatim into the export so the exported page's shadow-root mount + store are
// byte-identical to the live client's. Trusted static source (splice-safety is
// tripwire-tested); no user data.
const RUNTIME = require('./runtime/mount-runtime-src').source();

// The export's own shell around the shared runtime. Reads the JSON payload, seeds
// a store via __wcMount.createStore (NO publish hook — an export persists
// nowhere), and lays out one static pane card per mount using attachAndExtract +
// runScripts. No WebSocket, no fetch, no graph/SSE: a frozen, offline page. This
// is the ONE piece unique to export (the divergent outer shell); the runtime it
// drives is shared.
const EXPORT_SHELL = `
(function () {
  var data;
  try { data = JSON.parse(document.getElementById('wc-export-data').textContent); }
  catch (e) { console.error('web-chat export: bad payload', e); return; }
  var store = window.__wcMount.createStore(data.store || {});
  window.store = store;

  function mount(m) {
    var slot = document.getElementById('export-main');
    var pane = document.createElement('div');
    pane.className = 'pane';
    pane.setAttribute('data-pane-id', m.id);
    if (m.tokens) for (var k in m.tokens) { if (/^--wc-[\\w-]+$/.test(k)) pane.style.setProperty(k, m.tokens[k]); }
    var titleText = (m.params && m.params.title) || m.title || '';
    if (titleText) {
      var titleEl = document.createElement('div');
      titleEl.className = 'pane-title';
      titleEl.textContent = titleText;
      pane.appendChild(titleEl);
    }
    var host = document.createElement('div');
    host.id = m.id;
    host.className = 'mount-host';
    pane.appendChild(host);
    slot.appendChild(pane);

    var r = window.__wcMount.attachAndExtract(host, m.html || '');
    // per-pane raw css (pane.theme.css) lives inside the shadow root
    if (m.css) {
      var st = document.createElement('style');
      st.textContent = m.css;
      r.root.appendChild(st);
    }
    window.__wcMount.runScripts(r.root, r.scripts, store, m.params || {}, m.id);
    // rehydrate persisted form values (typed drafts travel with the node)
    if (m.form_state) window.__wcMount.applyFormState(r.root, m.form_state);

    // honor data-pane-title set by the component script
    var ht = host.dataset && host.dataset.paneTitle;
    if (ht && !titleText) {
      var t = document.createElement('div');
      t.className = 'pane-title';
      t.textContent = ht;
      pane.insertBefore(t, host);
    }
  }

  // The page sequence: markdown blocks (already rendered + escaped at export
  // time) interleaved with the pane cards. An export without a page list is
  // just its mounts, in order.
  var mounts = data.mounts || [];
  var byId = {};
  for (var i = 0; i < mounts.length; i++) byId[mounts[i].id] = mounts[i];
  var items = data.page || [];
  if (!data.page) for (var j = 0; j < mounts.length; j++) items.push({ pane: mounts[j].id });
  if (!items.length) {
    var empty = document.getElementById('export-empty');
    if (empty) empty.style.display = 'block';
  }
  for (var k = 0; k < items.length; k++) {
    var it = items[k];
    if (it.md != null) {
      var block = document.createElement('div');
      block.className = 'md-block';
      block.setAttribute('data-md-id', it.md);
      block.innerHTML = it.html;
      document.getElementById('export-main').appendChild(block);
    } else if (byId[it.pane]) {
      mount(byId[it.pane]);
    }
  }
})();
`.trim();

// Assemble a complete .html document from already-resolved inputs.
//   mounts: [{ id, html, target, params, tokens?, css? }]   (tokens/css = resolved per-pane theme)
//   markdown: [{ id, text }]  + order: [id…]                 (the page sequence; optional)
//   store:  plain object (baked snapshot)
//   page:   { tokens?: {--wc-*}, css?: '', fonts?: '' }      (resolved global ⊕ node;
//           fonts = the @font-face rules, already inlined, for the families
//           the theme names — resolveExportTheme builds it via lib/server/fonts)
//   meta:   { label?, title?, exportedAt?, brand?: { lockup?, seal? } }
//           (brand = data: URIs from lib/server/brand; an unset slot draws
//           no element at all)
function assembleExport({ mounts = [], markdown = [], order, store = {}, page = {}, meta = {} } = {}) {
  // Only a page WITH markdown carries a page list; without one the shell walks
  // the mounts array, so an export of a markdown-free node is byte-for-byte what
  // it always was.
  const sequence = (markdown || []).length ? pageItems({ mounts, markdown, order }) : null;
  const payload = {
    store,
    mounts: mounts.map((m) => ({
      id: m.id,
      html: m.html || '',
      target: m.target || 'main',
      params: m.params || {},
      title: m.title || (m.params && m.params.title) || '',
      tokens: m.tokens || null,
      css: m.css || '',
      ...(m.form_state ? { form_state: m.form_state } : {}),
    })),
    ...(sequence ? { page: sequence } : {}),
  };

  const title = meta.title || meta.label || 'web-chat export';
  const rootTokens = tokenDecls(page.tokens);
  const rootBlock = rootTokens ? `:root {\n${rootTokens}\n}` : '';
  const pageCss = styleSafe(page.css);
  const fontCss = styleSafe(page.fonts);
  const headLabel = meta.label ? `<span class="label">${htmlEscape(meta.label)}</span>` : '';
  const headStamp = meta.exportedAt ? `<span>exported ${htmlEscape(meta.exportedAt)}</span>` : '';
  const art = meta.brand || {};
  // Only a data: image URI reaches an attribute — the export must not fetch.
  const img = (uri, cls, alt) => (typeof uri === 'string' && /^data:image\/(png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(uri)
    ? `<img class="${cls}" alt="${alt}" src="${uri}">` : '');
  const lockup = img(art.lockup, 'brand-lockup', 'lockup');
  const seal = img(art.seal, 'brand-seal', 'seal');
  const foot = seal ? `<div id="export-foot"><span>made with web-chat</span>${seal}</div>\n` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="claude-web-chat export">
<title>${htmlEscape(title)}</title>
<style>
${fontCss}
${BASE_CSS}
${styleSafe(PAGE_CSS)}
${rootBlock}
${pageCss}
</style>
</head>
<body>
<div id="export-head"${lockup ? ' class="has-lockup"' : ''}>${lockup}${headLabel}${headStamp}</div>
<div id="export-main"></div>
<div id="export-empty" style="display:none">(this page has no panes)</div>
${foot}<script id="wc-export-data" type="application/json">${jsonForScript(payload)}</script>
<script>${RUNTIME}</script>
<script>${EXPORT_SHELL}</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// ctx-dependent resolution
// ---------------------------------------------------------------------------

// Resolve a node reference to its data. ref may be:
//   undefined | 'active'  → graph.active
//   'live'                → current uncommitted surface (graph.snapshotLive)
//   a hierarchical label  → 'n1.7'
//   a stored id           → 'n5'
// Returns { mounts, markdown, order, store, nodeId, label, node } or { error }. The resolution
// itself is domain/refs resolveNodeRef — the one resolver every node ref goes
// through; this only reshapes its answer for the export pipeline. `node` is what
// resolveExportTheme reads the node layer from: for `live` that is a synthesized
// node carrying the ACTIVE node's theme (the live surface is drawn under it, so
// the topbar button's default export keeps node-scoped theming).
function nodeForExport(ctx, ref) {
  const r = resolveNodeRef(ctx.graph, ref || 'active');
  if (!r.ok) return { error: r.code === 'no-active' ? 'no active node to export' : `node not found: ${ref}` };
  return {
    mounts: (r.node.mounts || []).map((m) => ({ ...m })),
    markdown: (r.node.markdown || []).map((m) => ({ ...m })),
    order: r.node.order,
    store: { ...(r.node.store || {}) },
    nodeId: r.live ? null : r.id,
    label: r.label,
    node: r.node,
  };
}

// Resolve the baked theme for an export: page-level (global ⊕ node) tokens/css,
// and per-pane (global ⊕ node ⊕ pane) tokens + the pane's own raw css. Mirrors
// the pane→node→global cascade in routes/theme.js resolveScope, but for an
// arbitrary node + its stored mounts (resolveScope only handles the *active*
// node and *live* mounts). `mode` is null — the light an export is drawn in —
// unless the caller explicitly asked for one (?mode= / the export tool's mode).
function resolveExportTheme(ctx, resolved, mode = null) {
  const { layers, page } = themeLayers(ctx.paths, resolved.node, mode);

  const mounts = resolved.mounts.map((m) => {
    const paneTheme = m.theme ? normalizeTheme(m.theme) : { tokens: {} };
    return {
      id: m.id,
      html: m.html,
      target: m.target,
      params: m.params,
      tokens: mergeTokensAt(mode, [...layers, paneTheme]),
      css: paneTheme.css || '',
      form_state: m.form_state,
    };
  });

  // The bundled fonts this theme names, inlined — the page has no server to
  // fetch /fonts/ from. Pane tokens and pane css count too: a pane themed into
  // Caslon renders in Caslon inside its shadow root, and @font-face declared on
  // the document reaches in there.
  page.fonts = inlineFontCss([
    ...Object.values(page.tokens), page.css,
    ...mounts.flatMap((m) => [...Object.values(m.tokens), m.css]),
  ], ctx.paths.PUBLIC_DIR);

  return { page, mounts };
}

// Pad to 2 digits.
function p2(n) { return String(n).padStart(2, '0'); }

// Timestamp for filenames + the export caption. now is injectable for tests.
function stamp(now = new Date()) {
  const d = now;
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

// Slugify a label for a filename: 'n1.7' → 'n1-7', 'live' → 'live'.
function slugLabel(label) {
  return String(label || 'export').replace(/[^\w.-]/g, '_').replace(/\./g, '-') || 'export';
}

// The export's brand images as data: URIs ({} when the project has none) —
// the project's own, else the theme pack's fill (brand.effective), in the
// mode the export is drawn in (light unless one was asked for).
function exportBrand(ctx, mode = null) {
  const root = ctx.root || (ctx.paths && ctx.paths.root);
  const out = {};
  for (const slot of ['lockup', 'seal']) {
    const uri = brand.dataUri(root, slot, mode ? { mode } : undefined);
    if (uri) out[slot] = uri;
  }
  return out;
}

// Build the full .html for a node reference. Returns { html, label, nodeId } or { error }.
// opts.mode ('light' | 'dark'): draw it in that mode. Omitted, an export is
// LIGHT whatever the viewer's chrome shows — a file sent on has no viewer.
function buildExportHtml(ctx, ref, now = new Date(), { mode = null } = {}) {
  const resolved = nodeForExport(ctx, ref);
  if (resolved.error) return resolved;
  const theme = resolveExportTheme(ctx, resolved, mode);
  const html = assembleExport({
    mounts: theme.mounts,
    markdown: resolved.markdown,
    order: resolved.order,
    store: resolved.store,
    page: theme.page,
    meta: {
      label: resolved.label,
      title: `web-chat — ${resolved.label}`,
      exportedAt: now.toISOString().replace('T', ' ').slice(0, 19),
      // The project's lockup and seal, inlined — the file has no server to
      // fetch /brand/ from. The topbar logotype is chrome, not page, so it stays.
      brand: exportBrand(ctx, mode),
    },
  });
  return { html, label: resolved.label, nodeId: resolved.nodeId };
}

// Assemble and write to .web-chat/exports/<label>-<stamp>.html. Returns
// { path, label } or { error }. Used by the MCP tool + CLI (server-side, where
// paths lives); the browser route streams the html instead of writing.
function writeExport(ctx, ref, now = new Date(), opts = {}) {
  const built = buildExportHtml(ctx, ref, now, opts);
  if (built.error) return built;
  const dir = ctx.paths.EXPORTS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slugLabel(built.label)}-${stamp(now)}.html`);
  fs.writeFileSync(file, built.html);
  return { path: file, label: built.label };
}

module.exports = {
  assembleExport,
  nodeForExport,
  resolveExportTheme,
  buildExportHtml,
  writeExport,
  // exported for tests
  jsonForScript,
  htmlEscape,
  slugLabel,
  stamp,
};
