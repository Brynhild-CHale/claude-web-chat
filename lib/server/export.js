const fs = require('fs');
const path = require('path');
const {
  normalizeTheme, resolveDefault, mergeTokens, mergeCss,
} = require('./theme');

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

// Escape a value for safe interpolation into HTML text/attributes.
function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

// Render a {--wc-*: value} token map into CSS declarations.
function tokensToCss(tokens) {
  if (!tokens) return '';
  return Object.entries(tokens)
    .filter(([k]) => /^--wc-[\w-]+$/.test(k))
    // Strip the chars that could break out of `name: value;` or the enclosing
    // <style> (`<>`). In production these never reach here — page.tokens flow
    // through theme.js sanitizeTokens first — but assembleExport is pure and
    // exported, so it must stand on its own.
    .map(([k, v]) => `  ${k}: ${String(v).replace(/[\n;{}<>]/g, '')};`)
    .join('\n');
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
#export-empty { max-width: 1100px; margin: 0 auto; color: var(--wc-muted, #888);
  font: 13px var(--wc-font, ui-sans-serif, system-ui); }
`.trim();

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

  var mounts = data.mounts || [];
  if (!mounts.length) {
    var empty = document.getElementById('export-empty');
    if (empty) empty.style.display = 'block';
  }
  for (var i = 0; i < mounts.length; i++) mount(mounts[i]);
})();
`.trim();

// Assemble a complete .html document from already-resolved inputs.
//   mounts: [{ id, html, target, params, tokens?, css? }]   (tokens/css = resolved per-pane theme)
//   store:  plain object (baked snapshot)
//   page:   { tokens?: {--wc-*}, css?: '' }                  (resolved global ⊕ node)
//   meta:   { label?, title?, exportedAt? }
function assembleExport({ mounts = [], store = {}, page = {}, meta = {} } = {}) {
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
  };

  const title = meta.title || meta.label || 'web-chat export';
  const rootTokens = tokensToCss(page.tokens);
  const rootBlock = rootTokens ? `:root {\n${rootTokens}\n}` : '';
  const pageCss = styleSafe(page.css);
  const headLabel = meta.label ? `<span class="label">${htmlEscape(meta.label)}</span>` : '';
  const headStamp = meta.exportedAt ? `<span>exported ${htmlEscape(meta.exportedAt)}</span>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="claude-web-chat export">
<title>${htmlEscape(title)}</title>
<style>
${BASE_CSS}
${rootBlock}
${pageCss}
</style>
</head>
<body>
<div id="export-head">${headLabel}${headStamp}</div>
<div id="export-main"></div>
<div id="export-empty" style="display:none">(this page has no panes)</div>
<script id="wc-export-data" type="application/json">${jsonForScript(payload)}</script>
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
// Returns { mounts, store, nodeId, label, theme } or { error }.
function nodeForExport(ctx, ref) {
  const { graph } = ctx;
  const { computeLabels } = require('./graph');

  if (ref === 'live') {
    const snap = graph.snapshotLive();
    // The live surface visually carries the *active* node's theme (the client
    // applies it to #main), so bake that node layer in — otherwise a 'live'
    // export, which is the topbar button's default, loses node-scoped theming.
    const activeNode = (graph.active && graph.nodes.get(graph.active)) || null;
    return { mounts: snap.mounts || [], store: snap.store || {}, nodeId: null, label: 'live', node: activeNode };
  }

  let id = ref;
  if (!ref || ref === 'active') {
    id = graph.active;
    if (!id) return { error: 'no active node to export' };
  } else if (!graph.nodes.has(ref)) {
    // Not a stored id — try resolving as a hierarchical label.
    const labels = computeLabels(graph); // id -> label
    let match = null;
    for (const [nid, label] of labels) {
      if (label === ref) { match = nid; break; }
    }
    if (!match) return { error: `node not found: ${ref}` };
    id = match;
  }

  const node = graph.nodes.get(id);
  if (!node) return { error: `node not found: ${ref}` };
  const labels = computeLabels(graph);
  return {
    mounts: (node.mounts || []).map((m) => ({ ...m })),
    store: { ...(node.store || {}) },
    nodeId: id,
    label: labels.get(id) || id,
    node,
  };
}

// Resolve the baked theme for an export: page-level (global ⊕ node) tokens/css,
// and per-pane (global ⊕ node ⊕ pane) tokens + the pane's own raw css. Mirrors
// the pane→node→global cascade in routes/theme.js resolveScope, but for an
// arbitrary node + its stored mounts (resolveScope only handles the *active*
// node and *live* mounts).
function resolveExportTheme(ctx, resolved) {
  const { paths } = ctx;
  const global = resolveDefault(paths);
  const nodeTheme = resolved.node && resolved.node.theme ? normalizeTheme(resolved.node.theme) : { tokens: {} };

  const page = { tokens: mergeTokens(global, nodeTheme), css: mergeCss(global, nodeTheme) };

  const mounts = resolved.mounts.map((m) => {
    const paneTheme = m.theme ? normalizeTheme(m.theme) : { tokens: {} };
    return {
      id: m.id,
      html: m.html,
      target: m.target,
      params: m.params,
      tokens: mergeTokens(global, nodeTheme, paneTheme),
      css: paneTheme.css || '',
      form_state: m.form_state,
    };
  });

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

// Build the full .html for a node reference. Returns { html, label, nodeId } or { error }.
function buildExportHtml(ctx, ref, now = new Date()) {
  const resolved = nodeForExport(ctx, ref);
  if (resolved.error) return resolved;
  const theme = resolveExportTheme(ctx, resolved);
  const html = assembleExport({
    mounts: theme.mounts,
    store: resolved.store,
    page: theme.page,
    meta: {
      label: resolved.label,
      title: `web-chat — ${resolved.label}`,
      exportedAt: now.toISOString().replace('T', ' ').slice(0, 19),
    },
  });
  return { html, label: resolved.label, nodeId: resolved.nodeId };
}

// Assemble and write to .web-chat/exports/<label>-<stamp>.html. Returns
// { path, label } or { error }. Used by the MCP tool + CLI (server-side, where
// paths lives); the browser route streams the html instead of writing.
function writeExport(ctx, ref, now = new Date()) {
  const built = buildExportHtml(ctx, ref, now);
  if (built.error) return built;
  const dir = path.join(ctx.paths.WEB_CHAT_DIR, 'exports');
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
