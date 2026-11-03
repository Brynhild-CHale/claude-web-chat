const fs = require('fs');
const path = require('path');
const { normalizeTheme, mergeTokensAt, tokenDecls } = require('./theme');
const { inlineFontCss } = require('./fonts');
const brand = require('./brand');
const { resolveNodeRef } = require('./domain/refs');
// The node's theme layers, its page sequence and its layout come from the
// preview engine — one idea of what a node looks like. Markdown is rendered at
// EXPORT time (pageItems, lib/core/markdown), so the exported page carries
// finished, escaped HTML and no parser; the runs and each pane's placement are
// drawn in the file by drawPage, the same function the node preview splices.
const { themeLayers, pageItems, drawPage } = require('./preview');

// ---------------------------------------------------------------------------
// Self-contained page export.
//
// A graph node is { mounts: [{id, html, target, params, pane_state, theme}],
// markdown, order, runs, store, comments }. Every pane's HTML/JS is already a
// string and the store is plain data, so a node serializes to one interactive
// .html with no headless browser: a minimal shell + THE shared mount runtime
// (public/mount-runtime.js — the same source the live client and the preview
// use) + a small EXPORT_SHELL that drives it (createStore without the WebSocket
// publish; the page laid out in grid runs by the preview's drawPage, one pane
// card in each placed wrapper).
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
// The page's LAYOUT is not here: #export-main is a `.page`, and its runs, grid
// and placement are public/page.css (inlined below) — the card only has to be a
// column whose content scrolls when the pane has a fixed height (.has-rows).
// A minimized pane stays out of the grid, as it does on the page and in the
// node preview.
const BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html { font-family: var(--wc-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
  color: var(--wc-fg, #111); }
body { margin: 0; background: var(--wc-bg, #fafafa); padding: 20px; }
#export-head { max-width: 1100px; margin: 0 auto 16px; display: flex; align-items: baseline;
  gap: 10px; color: var(--wc-muted, #57606a); font-size: 12.5px; }
#export-head .label { font-family: var(--wc-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-weight: 700; color: var(--wc-fg, #24292f); font-size: 13px; }
#export-main { max-width: 1100px; margin: 0 auto; }
.pane { display: flex; flex-direction: column; min-width: 0;
  background: var(--wc-panel-bg, #fff); border: 1px solid var(--wc-border, #e3e3e3);
  border-radius: var(--wc-radius, 8px); box-shadow: var(--wc-shadow, 0 1px 3px rgba(0,0,0,0.08));
  overflow: hidden; }
.pane.minimized { display: none; }
.pane > .pane-title { flex: none; font: 600 12px var(--wc-font, ui-sans-serif, system-ui);
  color: var(--wc-muted, #57606a); padding: 7px 12px;
  border-bottom: 1px solid var(--wc-border-light, #eaeef2); background: var(--wc-header-bg, #fbfcfd); }
.pane > .mount-host { display: block; flex: 1; min-height: 0; overflow: auto; padding: 12px; }
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

// The page stylesheet (public/page.css): how the page is laid out — each run of
// panes its own 12-column grid, placed by --col / --span / --rows, stacking or
// scrolling below 900px by its run flag — and how its markdown reads. The same
// bytes the live chrome links and the node preview inlines.
const PAGE_CSS = require('./runtime/page-css-src').source();

// THE shared mount runtime, read once as text (public/mount-runtime.js). Spliced
// verbatim into the export so the exported page's shadow-root mount + store are
// byte-identical to the live client's. Trusted static source (splice-safety is
// tripwire-tested); no user data.
const RUNTIME = require('./runtime/mount-runtime-src').source();
// The anchor resolver's compacted document copy (lib/server/runtime/anchors-src),
// spliced after the runtime so it installs window.__wcMount.anchor — only when
// the node carries element records (carriesElements, decided in nodeForExport),
// and cut to the anchor kinds they need (kindsOf; assembleExport's `elements`,
// the kind list: [] or false splices nothing, true every kind); read lazily.
const { scriptElement: anchorsScript, carriesElements, kindsOf } = require('./runtime/anchors-src');
// The element records the export DRAWS (PLAN.md 4B.1; DECISIONS.md B3, K.5
// J2, N.1 AD5 = a; U524): the payload is the documents' one builder's
// (lib/server/document-elements documentElements, U521), and the splice is
// the documents' one spelling (lib/server/runtime/elements-doc-src scripts,
// U522: the draw runtime, one inline module per plug-in type, one data
// element), placed right after the resolver's script and before EXPORT_SHELL,
// whose settle starts the runtime. The data rides in U522's own element, never
// in wc-export-data. RULED U524-U525@file-documents-private (a): an export is
// a file made to be shared, saved or sent, so its reader is ALWAYS a file
// reader (fileReader: never seesPrivate) — no export carries a private
// element, whoever downloads it; the default is fileReader('local'), shared
// elements only (writeExport: the MCP tool and the CLI; U564's picture).
const { documentElements, documentDeps, fileReader } = require('./document-elements');
const {
  scripts: elementScripts, runtimeElement, keyOf, DRAW_RULES,
} = require('./runtime/elements-doc-src');
const { anchorItem } = require('./domain/element-refs');
// The export route's key in remote-policy PRIVATE_RULES.routes and TEXT_RULES
// (U521 rowed it): the projection documentElements applies.
const EXPORT_ROUTE = 'GET /api/export/:ref';

// THE EXPORT CAP (PLAN.md 4B.1; DECISIONS.md B3 "a per-export cap that
// refuses or strips with a hint"; X-21, a 15.5 MB export written unchecked;
// U526). RULED U526@cap-scope-figure (a): the cap is on the ELEMENT PAYLOAD
// as serialised — the draw runtime, every plug-in type's module (its assets
// inlined) and the data element (its sources table and its stripped list
// included): elements-doc-src scripts()'s bytes, exactly as the file carries
// them. The panes, the store, the theme and the resolver stay uncapped, as
// they were (capping the whole file would refuse exports that work today).
// Over the cap, fitElements strips in B3's order until the payload fits:
// (1) assets, largest first, each named in its type's `skipped` with reason
// EXPORT_CAP_REASON; (2) HIDDEN items, oldest first (by seq; an item the log
// cannot place in time, seq null, counts oldest) — an item whose recorded
// answer is one the overlay never draws (DRAW_RULES' 'none' rows: orphaned
// with no carried guess, or hidden), or whose anchored pane is minimized in
// the node; a row served masked is drawn whatever its answer, so it is never
// hidden. A placed item is never stripped, and nothing is ever taken from a
// pane: (3) a payload that still does not fit is refused even with strip —
// never an over-cap file written silently (GT-17's no-go row).
// RULED U526@over-cap-browser-download (a): format=file (the MCP tool, the
// CLI) refuses by default (413, OVER_CAP) and strips on strip=1 / --strip;
// the browser download strips by default and says so in #export-head.
// Previews and replays are never capped here (the replay's render keeps its
// own 64 MB file limit, lib/server/replay/render.js LIMITS.maxBytes).
const EXPORT_ELEMENTS_MAX = 4 * 1024 * 1024;
// The reason a stripped asset or item carries (its `stripped` row, and an
// asset's `skipped` row on its type).
const EXPORT_CAP_REASON = 'export-cap';
// The refusal's code: the route answers it 413, the MCP tool relays it.
const OVER_CAP = 'export-over-cap';
// The how a resolver's orphan carries when it found a guess element
// (lib/core/anchors.js): the one orphan the overlay still draws, at its guess.
const GUESS_HOW = 'locator-guess';

// The export's own shell around the shared runtime. Reads the JSON payload, seeds
// a store via __wcMount.createStore (NO publish hook — an export persists
// nowhere), lays the page out with drawPage (the node preview's layout, spliced
// as source: markdown between grid runs, each pane placed from its pane_state)
// and fills each placed wrapper with one static pane card using
// attachAndExtract + runScripts. No WebSocket, no fetch, no graph/SSE: a frozen,
// offline page. The card is the ONE piece unique to export (the divergent outer
// shell); the runtime it drives and the layout it sits in are shared.
const EXPORT_SHELL = `
(function () {
  var data;
  try { data = JSON.parse(document.getElementById('wc-export-data').textContent); }
  catch (e) { console.error('web-chat export: bad payload', e); return; }
  var store = window.__wcMount.createStore(data.store || {});
  window.store = store;
  var drawPage = ${drawPage.toString()};

  // One pane card, drawn into the wrapper drawPage placed in its run's grid.
  function mount(m, pane) {
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

    var r = window.__wcMount.attachAndExtract(host, m.html || '');
    // per-pane raw css (pane.theme.css) lives inside the shadow root
    if (m.css) {
      var st = document.createElement('style');
      st.setAttribute('data-wc-chrome', 'theme');   // the chrome's node, not the pane's
      st.textContent = m.css;
      r.root.appendChild(st);
    }
    window.__wcMount.runScripts(r.root, r.scripts, store, m.params || {}, m.id);
    // rehydrate persisted form values (typed drafts travel with the node)
    if (m.form_state) window.__wcMount.applyFormState(r.root, m.form_state);
    // re-assert the recorded mode (the html bakes the one it was rendered in),
    // as the live chrome does; then the pane's DOM is final: settle
    if (m.params && m.params.modes) {
      r.root.dispatchEvent(new CustomEvent('wc:mode', { detail: { mode: (m.pane_state || {}).mode } }));
    }
    window.__wcMount.settle(r.root, m.id, 'mount');

    // honor data-pane-title set by the component script
    var ht = host.dataset && host.dataset.paneTitle;
    if (ht && !titleText) {
      var t = document.createElement('div');
      t.className = 'pane-title';
      t.textContent = ht;
      pane.insertBefore(t, host);
    }
  }

  // The page: markdown blocks (already rendered + escaped at export time) and
  // the grid runs between them, each pane card in its placed wrapper. An export
  // without a page list is just its mounts, in page order, as one run.
  var drawn = drawPage(document.getElementById('export-main'), data.page || null,
    data.mounts || [], data.runs || null, mount);
  if (!drawn) {
    var empty = document.getElementById('export-empty');
    if (empty) empty.style.display = 'block';
  }
})();
`.trim();

// Assemble a complete .html document from already-resolved inputs.
//   mounts: [{ id, html, target, params, tokens?, css?, pane_state?, form_state? }]
//           (tokens/css = resolved per-pane theme; pane_state = where the pane
//           sits in its run — col / colSpan / rows — and minimized)
//   markdown: [{ id, text }]  + order: [id…]                 (the page sequence; optional)
//   runs:   { [anchor]: { stacks: false } }                   (the node's run flags; optional)
//   store:  plain object (baked snapshot)
//   page:   { tokens?: {--wc-*}, css?: '', fonts?: '' }      (resolved global ⊕ node;
//           fonts = the @font-face rules, already inlined, for the families
//           the theme names — resolveExportTheme builds it via lib/server/fonts)
//   meta:   { label?, title?, exportedAt?, brand?: { lockup?, seal? }, privateLeftOut?, stripped? }
//           (brand = data: URIs from lib/server/brand; an unset slot draws
//           no element at all; privateLeftOut = how many private notes a
//           local browser's download left out — a positive count writes one
//           counts-only line in #export-head, anything else writes nothing;
//           stripped = the export cap's list (fitElements) — a non-empty
//           list writes one line in #export-head naming each, escaped)
//   elements: the anchor kinds the node needs (nodeForExport's kindsOf list;
//           true every kind; [] or false none): the resolver splice
//   docElements: the node's element payload for the file's reader
//           (documentElements, contract v1) or null; spliced by
//           elements-doc-src scripts() right after the resolver, and only
//           where `elements` names a kind — null splices nothing, so the
//           document keeps its bytes
function assembleExport(args) {
  return exportParts(args).html;
}

// assembleExport's work, with the two splices the budget reads beside the
// document: `resolver` (the anchor resolver's script) and `drawn` (the
// element splice, scripts()'s bytes — what the export cap measures).
function exportParts({ mounts = [], markdown = [], order, runs, store = {}, page = {}, meta = {}, elements = false, docElements = null } = {}) {
  // The page sequence the preview draws (pageItems — domain/page pageOrder, the
  // markdown rendered). The mounts ride in that order; only a page WITH
  // markdown also carries the list, since without it the mounts ARE the page.
  const items = pageItems({ mounts, markdown, order });
  const byId = new Map(mounts.map((m) => [String(m.id), m]));
  const ordered = items.filter((it) => it.pane != null).map((it) => byId.get(it.pane));
  const sequence = items.some((it) => it.md != null) ? items : null;
  const flags = runs && typeof runs === 'object' && !Array.isArray(runs) && Object.keys(runs).length ? runs : null;
  const payload = {
    store,
    mounts: ordered.map((m) => ({
      id: m.id,
      html: m.html || '',
      target: m.target || 'main',
      params: m.params || {},
      title: m.title || (m.params && m.params.title) || '',
      tokens: m.tokens || null,
      css: m.css || '',
      ...(m.pane_state ? { pane_state: m.pane_state } : {}),
      ...(m.form_state ? { form_state: m.form_state } : {}),
    })),
    ...(sequence ? { page: sequence } : {}),
    ...(flags ? { runs: flags } : {}),
  };

  const title = meta.title || meta.label || 'web-chat export';
  const rootTokens = tokenDecls(page.tokens);
  const rootBlock = rootTokens ? `:root {\n${rootTokens}\n}` : '';
  const pageCss = styleSafe(page.css);
  const fontCss = styleSafe(page.fonts);
  const headLabel = meta.label ? `<span class="label">${htmlEscape(meta.label)}</span>` : '';
  const headStamp = meta.exportedAt ? `<span>exported ${htmlEscape(meta.exportedAt)}</span>` : '';
  // A number only (S2's rider on U524-U525@file-documents-private a; REQ@honest-
  // marks): the user is told their notes were left out, never what they say.
  const left = Number.isSafeInteger(meta.privateLeftOut) && meta.privateLeftOut > 0 ? meta.privateLeftOut : 0;
  const headPrivate = left
    ? `<span data-private-left-out="${left}">${left} private note${left === 1 ? '' : 's'} left out</span>` : '';
  const cut = Array.isArray(meta.stripped) && meta.stripped.length ? meta.stripped : null;
  const headStripped = cut ? `<span data-export-stripped="${cut.length}">${htmlEscape(strippedLine(cut))}</span>` : '';
  const kinded = elements === true || (Array.isArray(elements) && elements.length > 0);
  const drawn = kinded && docElements ? elementScripts(docElements) : '';
  const resolver = elements ? anchorsScript(Array.isArray(elements) ? { kinds: elements } : undefined) : '';
  const art = meta.brand || {};
  // Only a data: image URI reaches an attribute — the export must not fetch.
  const img = (uri, cls, alt) => (typeof uri === 'string' && /^data:image\/(png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(uri)
    ? `<img class="${cls}" alt="${alt}" src="${uri}">` : '');
  const lockup = img(art.lockup, 'brand-lockup', 'lockup');
  const seal = img(art.seal, 'brand-seal', 'seal');
  const foot = seal ? `<div id="export-foot"><span>made with web-chat</span>${seal}</div>\n` : '';

  const html = `<!doctype html>
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
<div id="export-head"${lockup ? ' class="has-lockup"' : ''}>${lockup}${headLabel}${headStamp}${headPrivate}${headStripped}</div>
<main id="export-main" class="page"></main>
<div id="export-empty" style="display:none">(this page has no panes)</div>
${foot}<script id="wc-export-data" type="application/json">${jsonForScript(payload)}</script>
<script>${RUNTIME}</script>
${resolver}${drawn}<script>${EXPORT_SHELL}</script>
</body>
</html>
`;
  return { html, resolver, drawn };
}

// The one line #export-head writes for a stripped export: each asset by its
// type and path, each item by its type and id (the caller escapes it).
function strippedLine(list) {
  const what = list.map((s) => (s.kind === 'asset' ? `${s.type} asset ${s.rel}` : `hidden ${s.type} ${s.id}`));
  return `stripped to fit the export cap: ${what.join(', ')}`;
}

// ---------------------------------------------------------------------------
// ctx-dependent resolution
// ---------------------------------------------------------------------------

// Resolve a node reference to its data. ref may be:
//   undefined | 'active'  → graph.active
//   'live'                → current uncommitted surface (graph.snapshotLive)
//   a hierarchical label  → 'n1.7'
//   a stored id           → 'n5'
// Returns { mounts, markdown, order, runs, store, nodeId, label, node } or { error }. The resolution
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
    runs: r.node.runs,
    store: { ...(r.node.store || {}) },
    nodeId: r.live ? null : r.id,
    label: r.label,
    node: r.node,
    elements: carriesElements(r.node) ? kindsOf(r.node) : [],
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
      pane_state: m.pane_state,
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

// The export's brand images as data: URIs ({} when there are none) — the ones
// kept with the project's current global theme, else that theme's logo fill
// (brand.effective), in the mode the export is drawn in (light unless one was
// asked for).
function exportBrand(ctx, mode = null) {
  const root = ctx.root || (ctx.paths && ctx.paths.root);
  const out = {};
  for (const slot of ['lockup', 'seal']) {
    const uri = brand.dataUri(root, slot, mode ? { mode } : undefined);
    if (uri) out[slot] = uri;
  }
  return out;
}

// The node's element payload for a FILE read at `level`: documentElements
// under fileReader(level), so no private element is ever in it (AD5, J2).
// null when the node carries no element record (nothing to project) or the
// reader sees none.
function exportElements(ctx, resolved, level) {
  if (!resolved.elements.length) return null;
  return documentElements(documentDeps(ctx), resolved.node, { reader: fileReader(level), route: EXPORT_ROUTE });
}

// How many private notes a download of `ref` leaves out for `viewer`
// (readerOf: {level, seesPrivate}) — the count #export-head names on a local
// browser's download (S2's rider). 0 unless the viewer sees private records;
// else the items documentElements gives that viewer in place that are
// private (shared === false), counted only: no type file is read for it, and
// no element of it leaves this function.
function privateLeftOut(ctx, ref, viewer) {
  if (!viewer || viewer.seesPrivate !== true) return 0;
  const resolved = nodeForExport(ctx, ref);
  if (resolved.error || !resolved.elements.length) return 0;
  const deps = {
    ...documentDeps(ctx),
    readTypeFile: () => { throw new Error('a count reads no type file'); },
    typeRecord: () => null,
  };
  const p = documentElements(deps, resolved.node, { reader: viewer, route: EXPORT_ROUTE });
  return p ? p.items.filter((it) => it.shared === false).length : 0;
}

// ── the export cap ──────────────────────────────────────────────────────────
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const bytesOf = (s) => Buffer.byteLength(s, 'utf8');
// The element payload's bytes as the file carries them (0 for none: no
// splice at all).
const elementBytes = (p) => (isObj(p) && Array.isArray(p.items) && p.items.length ? bytesOf(elementScripts(p)) : 0);
// A value's bytes inside the data element (jsonForScript is per character,
// so a member's bytes are exactly its own serialisation's).
const jsonBytes = (v) => bytesOf(jsonForScript(v));
// An inlined asset: its raw bytes (the base64 decoded) and its bytes in the
// file (the data: URI as jsonForScript writes it, less the quotes).
const assetRaw = (uri) => Buffer.from(String(uri).slice(String(uri).indexOf(',') + 1), 'base64').length;
const assetInlined = (uri) => jsonBytes(String(uri)) - 2;

// How the overlay draws a recorded answer: the draw of the first DRAW_RULES
// row it matches (the one set of rules; its guess is the resolver's carried
// guess element, GUESS_HOW).
function drawOf(answer) {
  const guess = answer.how === GUESS_HOW;
  for (const r of DRAW_RULES) {
    if (r.state !== answer.state) continue;
    if (r.how != null && r.how !== answer.how) continue;
    if (r.guess != null && r.guess !== guess) continue;
    return r.draw;
  }
  return null;
}

// Is an item HIDDEN in this node (B3's second strip): never drawn by the
// overlay (its recorded answer's draw is 'none'), or anchored on a pane the
// node minimizes. A row served masked is drawn whatever its answer.
function isHiddenItem(it, minimized) {
  if (it.state !== undefined) return false;
  if (isObj(it.answer) && drawOf(it.answer) === 'none') return true;
  const at = anchorItem({ anchor: it.anchor });
  return at != null && minimized.has(at);
}

// What a payload's kept items use, and nothing else (validatePayload refuses
// a listed type no item uses and a sources row no item names): the builtins,
// the type rows, the removed names and the sources table, cut in place.
function prunePayload(q) {
  const used = new Set(q.items.map((it) => it.type));
  q.builtins = q.builtins.filter((t) => used.has(t));
  q.types = q.types.filter((r) => used.has(r.type));
  q.removed = q.removed.filter((t) => used.has(t));
  if (isObj(q.sources)) {
    const named = new Set(q.items.filter((it) => isObj(it.anchor) && it.anchor.kind === 'source').map((it) => it.anchor.md));
    for (const md of Object.keys(q.sources)) if (!named.has(md)) delete q.sources[md];
    if (!Object.keys(q.sources).length) delete q.sources;
  }
}

// fitElements(payload, node, cap) → {bytes, fitted, fits, payload, stripped}:
// bytes the payload's size as the file carries it, unstripped; over the cap,
// a COPY stripped in B3's order until it fits (the payload handed in is never
// changed), fitted its size, fits whether fitted is within the cap, and
// stripped the list [{kind: 'asset' | 'item', type, rel? | id?, bytes,
// reason}] (each one's bytes: what it took in the file) that the copy carries
// as its `stripped` (elements-doc-src contract v1). Under the cap the payload
// is returned as it is and stripped is empty. Pure: no fs, no ctx.
function fitElements(payload, node, cap = EXPORT_ELEMENTS_MAX) {
  const bytes = elementBytes(payload);
  if (bytes <= cap) return { bytes, fitted: bytes, fits: true, payload, stripped: [] };
  const q = {
    ...payload,
    types: payload.types.map((r) => ({ ...r, assets: { ...r.assets }, skipped: [...r.skipped] })),
    items: [...payload.items],
    ...(isObj(payload.sources) ? { sources: { ...payload.sources } } : {}),
    stripped: [],
  };
  const stripped = q.stripped;
  let cur = elementBytes(q);

  // (1) assets, largest first (by raw bytes; a tie by type, then path).
  const assets = q.types.filter((r) => r.module !== '').flatMap((r) => Object.entries(r.assets)
    .map(([rel, uri]) => ({ row: r, rel, raw: assetRaw(uri), inlined: assetInlined(uri) })))
    .sort((a, b) => b.raw - a.raw || (a.row.type < b.row.type ? -1 : a.row.type > b.row.type ? 1 : 0)
      || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const a of assets) {
    if (cur <= cap) break;
    delete a.row.assets[a.rel];
    a.row.skipped.push({ rel: a.rel, reason: EXPORT_CAP_REASON });
    stripped.push({ kind: 'asset', type: a.row.type, rel: a.rel, bytes: a.inlined, reason: EXPORT_CAP_REASON });
    cur = elementBytes(q);
  }

  // (2) hidden items, oldest first (seq; null first; a tie by id). An item's
  // bytes leave the data element exactly, its stripped row joins it exactly;
  // only a removal that frees a type, a built-in or a sources row (a cut of
  // the runtime, a module or the table) is measured again.
  const minimized = new Set((Array.isArray(node && node.mounts) ? node.mounts : [])
    .filter((m) => m && m.pane_state && m.pane_state.minimized === true).map((m) => String(m.id)));
  const seqOf = (it) => (Number.isSafeInteger(it.seq) ? it.seq : -1);
  const hidden = q.items.filter((it) => isHiddenItem(it, minimized))
    .sort((a, b) => seqOf(a) - seqOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const it of hidden) {
    if (cur <= cap) break;
    const row = { kind: 'item', type: it.type, id: it.id, bytes: jsonBytes(it), reason: EXPORT_CAP_REASON };
    q.items.splice(q.items.indexOf(it), 1);
    const typeFreed = !q.items.some((x) => x.type === it.type);
    const sourceFreed = isObj(it.anchor) && it.anchor.kind === 'source';
    cur = cur - row.bytes - (q.items.length ? 1 : 0) + jsonBytes(row) + (stripped.length ? 1 : 0);
    stripped.push(row);
    if (!q.items.length) { cur = 0; break; }
    if (typeFreed || sourceFreed) { prunePayload(q); cur = elementBytes(q); }
  }
  prunePayload(q);
  const fitted = elementBytes(q);
  return { bytes, fitted, fits: fitted <= cap, payload: q, stripped };
}

// The hint an over-cap refusal carries: the strip flag and the CLI line, or,
// when even a strip cannot fit it, what the user can do instead.
function overCapHint(label, fit, cap) {
  const line = `claude-web-chat export ${label} --strip`;
  const what = `the export's annotations come to ${fit.bytes} bytes, over the ${cap}-byte export cap`;
  if (fit.fits) {
    return `${what}. Run \`${line}\` (strip=1 on GET /api/export/:ref?format=file) to leave out what does not fit — `
      + 'the plug-in types\' assets, largest first, then annotations the page never shows — and the file names what it '
      + 'left out; the page\'s download button strips the same way.';
  }
  return `${what}, and even \`${line}\` cannot fit them: with every asset and every hidden annotation left out they are `
    + `${fit.fitted} bytes. Remove some annotations from the page, or the plug-in type's large assets, and export again.`;
}

// The budget readings (the 4B gate's F3 adapter reads them): the file's
// bytes, and its parts — page_bytes (the shell, the mount runtime, the panes,
// the store and the theme), resolver_bytes (the anchor resolver's script),
// runtime_bytes (the element draw runtime) and payload_bytes (the type
// modules with their assets, and the data element) — which sum to bytes; the
// cap's figure is runtime_bytes + payload_bytes. assets_raw / assets_inlined
// total every inlined asset's raw bytes and its bytes in the file, and
// `assets` lists each one {type, rel, raw, inlined}.
function budgetOf(parts, payload) {
  const bytes = bytesOf(parts.html);
  const resolverBytes = bytesOf(parts.resolver);
  const drawnBytes = bytesOf(parts.drawn);
  const runtimeBytes = parts.drawn ? bytesOf(runtimeElement(keyOf(payload))) : 0;
  const assets = parts.drawn ? payload.types.filter((r) => r.module !== '').flatMap((r) => Object.entries(r.assets)
    .map(([rel, uri]) => ({ type: r.type, rel, raw: assetRaw(uri), inlined: assetInlined(uri) }))) : [];
  return {
    bytes,
    page_bytes: bytes - resolverBytes - drawnBytes,
    resolver_bytes: resolverBytes,
    runtime_bytes: runtimeBytes,
    payload_bytes: drawnBytes - runtimeBytes,
    assets_raw: assets.reduce((n, a) => n + a.raw, 0),
    assets_inlined: assets.reduce((n, a) => n + a.inlined, 0),
    assets,
  };
}

// A cap a caller hands in narrows the cap, never widens it (opts.cap, the
// test seam).
const capOf = (cap) => (Number.isSafeInteger(cap) && cap >= 0 ? Math.min(cap, EXPORT_ELEMENTS_MAX) : EXPORT_ELEMENTS_MAX);

// Build the full .html for a node reference. Returns { html, label, nodeId,
// budget, stripped? } or { error } (an unknown ref), or the export cap's
// refusal { error, code: OVER_CAP, hint, bytes, cap, would_strip, label }.
// opts.mode ('light' | 'dark'): draw it in that mode. Omitted, an export is
// LIGHT whatever the viewer's chrome shows — a file sent on has no viewer.
// opts.reader: whose file it is — only its level is read; the file's reader
// is fileReader(level) whatever else it says, and none means
// fileReader('local'): shared elements, with their text. opts.privateLeftOut:
// the count privateLeftOut computed for a local browser's download (a number,
// never elements); omitted, the file carries no count and no line.
// opts.strip: over the cap, strip (fitElements) rather than refuse; a payload
// that does not fit even stripped is refused all the same. opts.cap: the
// cap, narrowed only (a test seam; default EXPORT_ELEMENTS_MAX). A stripped
// export carries `stripped` in its data element and one #export-head line,
// and returns the list; an export within the cap is byte-equal to one built
// with no cap at all.
function buildExportHtml(ctx, ref, now = new Date(), { mode = null, reader = null, privateLeftOut: leftOut = 0, strip = false, cap: capIn } = {}) {
  const resolved = nodeForExport(ctx, ref);
  if (resolved.error) return resolved;
  const theme = resolveExportTheme(ctx, resolved, mode);
  const level = reader && typeof reader.level === 'string' ? reader.level : 'local';
  const cap = capOf(capIn);
  const docElements = exportElements(ctx, resolved, level);
  const fit = fitElements(docElements, resolved.node, cap);
  if (fit.bytes > cap && (strip !== true || !fit.fits)) {
    return {
      error: `the export is over the cap: its annotations come to ${fit.bytes} bytes, and the cap is ${cap}`,
      code: OVER_CAP, hint: overCapHint(resolved.label, fit, cap), bytes: fit.bytes, cap, would_strip: fit.stripped,
      label: resolved.label,
    };
  }
  const stripped = fit.stripped;
  const parts = exportParts({
    mounts: theme.mounts,
    markdown: resolved.markdown,
    order: resolved.order,
    runs: resolved.runs,
    store: resolved.store,
    page: theme.page,
    elements: resolved.elements,
    docElements: fit.payload,
    meta: {
      label: resolved.label,
      title: `web-chat — ${resolved.label}`,
      exportedAt: now.toISOString().replace('T', ' ').slice(0, 19),
      // The current theme's lockup and seal, inlined — the file has no server
      // to fetch /brand/ from. The topbar logotype is chrome, not page, so it stays.
      brand: exportBrand(ctx, mode),
      ...(Number.isSafeInteger(leftOut) && leftOut > 0 ? { privateLeftOut: leftOut } : {}),
      ...(stripped.length ? { stripped } : {}),
    },
  });
  return {
    html: parts.html, label: resolved.label, nodeId: resolved.nodeId, budget: budgetOf(parts, fit.payload),
    ...(stripped.length ? { stripped } : {}),
  };
}

// Assemble and write to .web-chat/exports/<label>-<stamp>.html. Returns
// { path, label, stripped? } or { error } (buildExportHtml's, the cap's
// refusal included: nothing is written then). Used by the MCP tool + CLI
// (server-side, where paths lives); the browser route streams the html
// instead of writing.
function writeExport(ctx, ref, now = new Date(), opts = {}) {
  const built = buildExportHtml(ctx, ref, now, opts);
  if (built.error) return built;
  const dir = ctx.paths.EXPORTS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slugLabel(built.label)}-${stamp(now)}.html`);
  fs.writeFileSync(file, built.html);
  return { path: file, label: built.label, ...(built.stripped ? { stripped: built.stripped } : {}) };
}

module.exports = {
  assembleExport,
  nodeForExport,
  resolveExportTheme,
  buildExportHtml,
  writeExport,
  privateLeftOut,
  EXPORT_ROUTE,
  // the export cap (U526)
  EXPORT_ELEMENTS_MAX,
  EXPORT_CAP_REASON,
  OVER_CAP,
  fitElements,
  strippedLine,
  // exported for tests
  jsonForScript,
  htmlEscape,
  slugLabel,
  stamp,
};
