// Capture pane rendering — how a distilled capture becomes the HTML that mounts
// on the surface.
//
// These six functions lived in lib/server/routes/capture.js, which made the
// dependency arrow point the wrong way: three files under lib/capture/ carry
// comments that say "routes/capture.js renders …", and lib/cli/commands/profile.js
// had to `require('../../server/routes/capture')` — an entry point reaching into
// another entry point — to get `defaultReduce`, then re-implement
// renderProfilePane's reduce-then-render inline "to mirror production". None of
// the six touches req/res: they are pure functions of (record, distilled, mode,
// paths). They belong beside the profiles engine they render, where the route,
// the CLI and the tests can all import the SAME copy.
//
// Two of them are contracts with code outside this file and must not be tidied:
//   - feedbackCard's markup is pinned byte-for-byte by test/bus-golden.test.js.
//   - wrapModes' `.wc-pane-modes[data-mode]` markup + `wc:mode` bootstrap are
//     consumed by public/app/mounts.js — the surface's mode toggle breaks
//     silently if the strings drift.
//
// renderSimplifiedPane is the one non-pure member: it writes the reader-document
// sidecar (parity with the raw-DOM tier), so it takes `paths` and does fs.

const fs = require('fs');
const path = require('path');
const { escapeHtml } = require('../core/html');
const { simplifyDom, simplifiedPaneInner, simplifiedDocument } = require('./profiles/simplify');

const SIMPLIFIED_CAP = 200000; // reader-lite pane body cap (~200KB)

function feedbackCard(record) {
  const d = record.distilled || {};
  let summary;
  if (d.kind === 'tables') {
    summary = `${d.table_count || 0} table(s), ${(d.tables || []).reduce((n, t) => n + (t.row_count || 0), 0)} rows`;
  } else {
    summary = `${d.text_chars || 0} chars of text`;
  }
  return `
    <div style="font:13px var(--wc-font,system-ui);color:var(--wc-fg,#111)">
      <div style="font-weight:600;margin-bottom:4px">📥 Captured: ${escapeHtml(record.title || record.url || record.id)}</div>
      <div style="color:var(--wc-muted,#57606a);font:11.5px var(--wc-mono,monospace)">${escapeHtml(record.url || '')}</div>
      <div style="margin-top:6px">profile <code>${escapeHtml(record.profile)}</code> · ${escapeHtml(summary)} · raw ${(record.bytes_raw / 1024).toFixed(1)} KB</div>
      <div style="margin-top:4px;color:var(--wc-muted,#8c959f);font-size:11px">id <code>${escapeHtml(record.id)}</code> · signal <code>tab_capture</code></div>
    </div>`;
}

// The capture pane for a `kind:'selection'` excerpt: the sanitized,
// rendered-Markdown view over the same fragment parse, plus a source link back to
// the page the user clipped from. No reduced/expanded modes — a curated excerpt
// is already the reduction, so the pane shows it whole.
function selectionCard(record, bodyHtml) {
  const src = record.url
    ? `<a href="${escapeHtml(record.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--wc-accent,#0969da);text-decoration:none">${escapeHtml(record.title || record.url)}</a>`
    : escapeHtml(record.title || '(no source)');
  return `
    <div style="font:14px/1.55 var(--wc-font,system-ui);color:var(--wc-content-fg,var(--wc-fg,#111))">
      <div class="wc-selection-body">${bodyHtml}</div>
      <div style="margin-top:12px;padding-top:8px;border-top:1px solid var(--wc-border,#d0d7de);color:var(--wc-muted,#57606a);font:11.5px var(--wc-font,system-ui)">
        📌 clipped from ${src}
      </div>
    </div>`;
}

// Default reduction used when a profile's pane has no reduce(). The reduced view
// is a deterministic shrink of the SAME distilled payload (Contract 6) — first
// rows of tables / a text prefix — never a second fetch.
function defaultReduce(distilled) {
  const d = distilled || {};
  if (d.kind === 'tables') {
    return {
      kind: 'tables',
      table_count: d.table_count,
      tables: (d.tables || []).map((t) => ({
        headers: t.headers,
        rows: (t.rows || []).slice(0, 5),
        row_count: t.row_count,
      })),
    };
  }
  if (typeof d.text === 'string') {
    return { ...d, text: d.text.slice(0, 400), truncated: d.text.length > 400 };
  }
  return d;
}

// Wrap reduced/expanded pane inner HTML so it toggles client-side with zero
// round-trip. The inner marks elements `data-wc-when="reduced|expanded"`; the
// platform appends shadow-scoped CSS that collapses the off-mode elements and a
// bootstrap script that reacts to the `wc:mode` CustomEvent (dispatched by the
// pane-chrome toggle and by WS pane:state updates from other clients). One copy,
// shared by the profile-pane path and the simplified-site pane.
function wrapModes(inner, mode) {
  const m = mode === 'expanded' ? 'expanded' : 'reduced';
  return `<div class="wc-pane-modes" data-mode="${escapeHtml(m)}">${inner}</div>
<style>
  .wc-pane-modes[data-mode="reduced"] [data-wc-when="expanded"] { display: none; }
  .wc-pane-modes[data-mode="expanded"] [data-wc-when="reduced"] { display: none; }
</style>
<script>
  (function () {
    var box = root.querySelector('.wc-pane-modes');
    if (!box) return;
    if (params && params.mode) box.setAttribute('data-mode', params.mode);
    root.addEventListener('wc:mode', function (e) {
      if (e && e.detail && e.detail.mode) box.setAttribute('data-mode', e.detail.mode);
    });
  })();
</script>`;
}

// Render a profile author's pane. The author's render() gets the full `distilled`
// AND the precomputed `ctx.reduced` to build both modes.
function renderProfilePane(profile, distilled, ctx) {
  const reduced = profile.pane.reduce ? profile.pane.reduce(distilled) : defaultReduce(distilled);
  const inner = profile.pane.render(distilled, { ...ctx, reduced });
  return wrapModes(inner, ctx.mode);
}

// Render the reader-lite simplified-site pane for a `simplified_pane`
// builtin (article / default). The rich body is generated server-side from the
// parsed DOM (simplify.js) and lives ONLY here + in the sidecar — never in the
// distillate get_captures returns. Writes the standalone reader document to a
// sidecar (parity with the raw-DOM tier) and returns { html2, simplified_ref }.
function renderSimplifiedPane({ id, record, url, root, mode, distilled, paths }) {
  const simplified = simplifyDom(root, { url, cap: SIMPLIFIED_CAP });
  let simplified_ref = null;
  try {
    const doc = simplifiedDocument({
      title: record.title, url,
      byline: distilled && distilled.byline, date: distilled && distilled.date,
      bodyHtml: simplified.bodyHtml, truncated: simplified.truncated, bytes: simplified.bytes,
    });
    fs.writeFileSync(path.join(paths.CAPTURES_DIR, `${id}.simplified.html`), doc);
    simplified_ref = path.join('captures', `${id}.simplified.html`);
  } catch (e) {
    console.error(`[capture] simplified sidecar write failed: ${(e && e.message) || e}`);
  }
  const readerUrl = simplified_ref ? `/api/captures/${id}/simplified` : '';
  const inner = simplifiedPaneInner(simplified, {
    title: record.title, url,
    byline: distilled && distilled.byline, date: distilled && distilled.date, readerUrl,
  });
  return { html2: wrapModes(inner, mode), simplified_ref };
}

module.exports = {
  feedbackCard,
  selectionCard,
  defaultReduce,
  wrapModes,
  renderProfilePane,
  renderSimplifiedPane,
  SIMPLIFIED_CAP,
};
