// Tab-stream capture ingest — the "listener" half of the tab-streaming feature.
//
// The browser extension (extensions/tab-stream) POSTs a snapshot of the user's
// active tab here. We pick a profile, distill the raw DOM down to something
// context-friendly, persist the raw as a sidecar file, and fold a capture record
// into live state so it commits into the next graph node (like a user pane
// interaction). Captures are ext:*-sourced, so policy.classify enqueues them —
// they ride the queue rail to Claude on the user's Push.
//
// Tiered storage (the design's lazy-context-loading model):
//   - distilled → the capture record (in state.captures → node.captures) →
//     agent-visible via get_captures.
//   - raw DOM   → a sidecar file under .web-chat/captures/, referenced by
//     raw_ref, NEVER inlined into the node or the store → fetched on demand via
//     GET /api/captures/:id/raw (inspect_capture).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolve, runProfile, inspectRaw, listProfiles, safeParse } = require('../../capture/profiles');
const { simplifyDom, simplifiedPaneInner, simplifiedDocument } = require('../../capture/profiles/simplify');
const { toMarkdown, toSafeHtml } = require('../../capture/markdown');
const { projectPaths } = require('../../core/paths');
const { setCors } = require('../../core/cors');
const { escapeHtml } = require('../util/html');

const LEGACY_MOUNT_ID = 'tab-capture'; // the old single fixed mount, pre per-profile panes
const MOUNT_PREFIX = 'tab-capture:';   // per-profile panes mount at tab-capture:<suffix>[:<page-hash>]
const CAPTURE_OWNER = 'service:tab-stream';
const RAW_FULL_CAP = 50000; // unscoped raw reads are capped; scope with selector/query
const SIMPLIFIED_CAP = 200000; // reader-lite pane body cap (~200KB)

// Stable short hash of a page's URL (sans #fragment) — the per-page pane key so
// distinct pages of the same profile get distinct mounts and coexist, while
// re-capturing the same page replaces its pane in place (Fix #2).
function urlKey(url) {
  const noFrag = String(url || '').split('#')[0];
  return crypto.createHash('sha1').update(noFrag).digest('hex').slice(0, 8);
}

// Optional shared-secret gate. If a token is configured (env WEB_CHAT_CAPTURE_TOKEN
// or a `capture-token` file in .web-chat), the request must present it in the
// X-WC-Token header — so a random localhost page can't POST captures. With no
// token configured (default local dogfood), ingest is open.
function configuredToken(paths) {
  if (process.env.WEB_CHAT_CAPTURE_TOKEN) return String(process.env.WEB_CHAT_CAPTURE_TOKEN);
  try {
    const p = projectPaths(paths.root).captureToken;
    if (fs.existsSync(p)) {
      const t = fs.readFileSync(p, 'utf8').trim();
      return t || null;
    }
  } catch {}
  return null;
}

// Locate a capture by id — live captures first, then any committed node's
// captures (so a capture can be inspected long after its turn committed).
function findCapture(graph, state, id) {
  const live = state.captures.find((c) => c.id === id);
  if (live) return live;
  for (const node of graph.nodes.values()) {
    const rec = (node.captures || []).find((c) => c.id === id);
    if (rec) return rec;
  }
  return null;
}

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

function mountCaptureRoutes(app, { state, graph, paths, bus }) {
  app.options('/api/capture', (req, res) => { setCors(req, res); res.status(204).end(); });

  app.post('/api/capture', (req, res) => {
    setCors(req, res);

    const token = configuredToken(paths);
    if (token && req.headers['x-wc-token'] !== token) {
      return res.status(401).json({ ok: false, error: 'invalid or missing X-WC-Token' });
    }

    const { url = '', title = '', html, profile: hint, render = true, kind } = req.body || {};
    const source = String((req.body && req.body.source) || 'ext:tab-stream');
    if (typeof html !== 'string' || !html) {
      return res.status(400).json({ ok: false, error: 'html (string) required' });
    }

    // A `kind:'selection'` capture is a user-curated excerpt: the extension
    // serialized the highlighted Range into an HTML fragment. We convert it to
    // Markdown here — that Markdown IS the distillate (get_captures returns it
    // verbatim, so the context cost is exactly what the user highlighted). Every
    // other capture resolves a profile and distills the whole-page DOM as before.
    const isSelection = kind === 'selection';
    let picked = null;
    let usedProfile;
    let distilled;
    let fell_back_from;
    let error;
    if (isSelection) {
      const markdown = toMarkdown(html, { baseUrl: url });
      usedProfile = 'selection';
      distilled = { kind: 'selection', url, title, markdown, text_chars: markdown.length };
    } else {
      // Resolve the PICKED profile (the consent target / pane owner) up front, then
      // distill. runProfile may fall back to `default` if a user extractor throws,
      // but the pane slot stays keyed to the picked profile (Contract 4) so a
      // transient extractor error never makes the pane jump mounts.
      picked = resolve({ url, html, hint }).profile;
      ({ profile: usedProfile, distilled, fell_back_from, error } = runProfile(picked, { url, html }));
    }

    // Allocate a globally-unique id (never reset by navigation) → stable sidecar
    // filename. Mirrors the comment-seq discipline.
    const seq = ++state.captureSeq;
    const id = `cap${seq}`;
    const rawRel = path.join('captures', `${id}.html`);
    try {
      fs.writeFileSync(path.join(paths.CAPTURES_DIR, `${id}.html`), html);
    } catch (e) {
      return res.status(500).json({ ok: false, error: `failed to persist raw capture: ${e.message}` });
    }

    const record = {
      id,
      seq,
      ts: Date.now(),
      url,
      title,
      profile: usedProfile,
      distilled,
      raw_ref: rawRel,
      bytes_raw: Buffer.byteLength(html),
      source,
    };
    if (isSelection) record.kind = 'selection';
    if (fell_back_from) { record.fell_back_from = fell_back_from; record.profile_error = error; }
    // In-page interaction result (Slice 1+). The extension posts this when the
    // capture ran a profile's interaction sequence before snapshotting. Stored on
    // the record (flows into the node via state.captures) and tagged on timeout.
    const interaction = req.body && req.body.interaction;
    if (interaction && typeof interaction === 'object') {
      record.interaction = {
        ran: !!interaction.ran,
        timed_out: !!interaction.timed_out,
        last_step: interaction.last_step != null ? String(interaction.last_step) : null,
        log: Array.isArray(interaction.log) ? interaction.log.slice(0, 50) : undefined,
      };
      if (interaction.timed_out) record.interaction_timed_out = true;
    }
    state.captures.push(record);

    // Signal key: the wake path. Claude waits on `tab_capture` (store_key) or the
    // `capture` event kind; the bumping seq makes repeat captures distinguishable.
    state.store.tab_capture = { seq, capture_id: id, url, title, profile: usedProfile };
    // Triple-effect: the store mutation above (signal key), its store:patch WS
    // frame, and the `capture` event — WS frame + event co-located in one emit.
    bus.emit({
      event: { kind: 'capture', capture_id: id, seq, url, profile: usedProfile, source },
      ws: { type: 'store:patch', patch: { tab_capture: state.store.tab_capture } },
    });

    // A selection excerpt renders into its OWN clipping pane, keyed per capture id
    // so multiple highlights (even from the same page) coexist and never clobber
    // one another. Owner-tagged service:tab-stream like every capture pane. The
    // pane is the sanitized rendered-Markdown view + a source link (selectionCard).
    if (render && isSelection) {
      const mountId = MOUNT_PREFIX + 'selection:' + id;
      const existing = state.mounts.get(mountId);
      const bodyHtml = toSafeHtml(html, { baseUrl: url });
      const html2 = selectionCard(record, bodyHtml);
      const pane_state = { ...((existing && existing.pane_state) || {}) };
      const title2 = 'Selection' + (record.title ? ' · ' + record.title : '');
      const params = { title: title2, modes: false };
      const mountRec = { html: html2, target: 'main', params, pane_state, owner: CAPTURE_OWNER };
      if (existing && existing.theme) mountRec.theme = existing.theme;
      state.mounts.set(mountId, mountRec);
      bus.emit({ ws: { type: 'render', html: html2, target: 'main', id: mountId, params, pane_state, theme: mountRec.theme } });
    }

    // Render the capture into the PICKED profile's own pane (replace-in-place),
    // owner-tagged service:tab-stream so Claude's renders don't clobber it. The
    // profile's pane.js renders it (reduced/expanded modes); with no pane — or
    // when the extractor fell back to default, whose distilled the pane can't read
    // — we fall back to the generic feedback card. The mount id is keyed to the
    // picked profile so it stays stable across re-captures and transient errors.
    if (render && !isSelection) {
      const suffix = picked.mount_suffix || picked.name;
      // Per-page by default: a distinct URL → distinct pane (the N pages of a
      // profile coexist); re-capturing the same URL → same id → replace-in-place,
      // preserving the user's mode/theme via the `existing` lookup. A profile may
      // opt into 'profile' dedupe (a single dashboard-style pane all captures
      // share). Builtins carry no dedupe_by and default to 'url'.
      const dedupe = picked.dedupe_by || 'url';
      let mountId = MOUNT_PREFIX + suffix;
      if (dedupe === 'url') mountId += ':' + urlKey(url);
      const existing = state.mounts.get(mountId);
      const mode = (existing && existing.pane_state && existing.pane_state.mode) || picked.default_mode || 'reduced';

      const canPane = picked.pane && typeof picked.pane.render === 'function' && !fell_back_from;
      // A `simplified_pane` builtin (article / default) gets the reader-lite
      // simplified-site pane instead of the generic card — a no-profile page pins
      // as a readable document. Built from the parsed DOM (a second parse only for
      // these builtins); resilient to the extractor having fallen back.
      const wantsSimplified = !canPane && !!picked.simplified_pane;
      let html2;
      let hasModes = canPane;
      if (canPane) {
        try {
          html2 = renderProfilePane(picked, distilled, { mode, mount_id: mountId, profile: picked.name });
        } catch (e) {
          html2 = feedbackCard(record);
          hasModes = false;
          console.error(`[pane] ${picked.name} render failed: ${(e && e.message) || e}`);
        }
      } else if (wantsSimplified) {
        try {
          const root = safeParse(html);
          const out = renderSimplifiedPane({ id, record, url, root, mode, distilled, paths });
          html2 = out.html2;
          if (out.simplified_ref) record.simplified_ref = out.simplified_ref;
          hasModes = true;
        } catch (e) {
          html2 = feedbackCard(record);
          hasModes = false;
          console.error(`[pane] simplified render failed: ${(e && e.message) || e}`);
        }
      } else {
        html2 = feedbackCard(record);
      }

      const pane_state = { ...((existing && existing.pane_state) || {}), mode };
      // Only panes with reduced/expanded representations (profile pane or the
      // simplified-site pane) carry a live toggle — the generic feedback-card
      // fallback has neither, so don't grow a dead toggle.
      // Page-aware title so the N coexisting same-profile panes are distinguishable.
      const title2 = 'Capture · ' + picked.name + (record.title ? ' — ' + record.title : '');
      const params = { title: title2, modes: hasModes, mode };
      const mountRec = { html: html2, target: 'main', params, pane_state, owner: CAPTURE_OWNER };
      if (existing && existing.theme) mountRec.theme = existing.theme; // preserve a per-pane theme across re-renders
      state.mounts.set(mountId, mountRec);

      // One-time: drop the legacy single 'tab-capture' mount the old code wrote, so
      // it doesn't orphan on the live surface beside the new per-profile pane.
      // Solo WS-only frame (no event), matching the pre-bus broadcast.
      if (state.mounts.has(LEGACY_MOUNT_ID)) {
        state.mounts.delete(LEGACY_MOUNT_ID);
        bus.emit({ ws: { type: 'clear', id: LEGACY_MOUNT_ID } });
      }

      // Solo render frame (WS-only) into the per-profile pane.
      bus.emit({ ws: { type: 'render', html: html2, target: 'main', id: mountId, params, pane_state, theme: mountRec.theme } });
    }

    res.json({ ok: true, capture_id: id, seq, profile: usedProfile, distilled, bytes_raw: record.bytes_raw, raw_ref: rawRel, fell_back_from, error });
  });

  // Profile match for a URL — the extension calls this on popup-open to decide
  // whether to offer the "Capture with <profile>" button (the consent path).
  // `matched` is true ONLY for a user-defined profile (Contract 7): the built-in
  // distillers run passively but never trigger the button. URL-only — needs no
  // capture, works before any DOM is grabbed.
  app.options('/api/profile-match', (req, res) => { setCors(req, res); res.status(204).end(); });
  app.get('/api/profile-match', (req, res) => {
    setCors(req, res);
    const token = configuredToken(paths);
    if (token && req.headers['x-wc-token'] !== token) {
      return res.status(401).json({ ok: false, error: 'invalid or missing X-WC-Token' });
    }
    const url = String(req.query.url || '');
    const r = resolve({ url });
    if (!r.matched) return res.json({ matched: false });
    const p = r.profile;
    res.json({
      matched: true,
      name: p.name,
      description: p.description || '',
      has_interaction: !!(p.interact && Array.isArray(p.interact.steps) && p.interact.steps.length),
    });
  });

  // List capture records (distilled only — raw is never included). Live surface
  // by default; `?node=<id>` reads a committed node's captures; `?since=<seq>`
  // returns only newer live captures (catch-up cursor).
  app.get('/api/captures', (req, res) => {
    setCors(req, res);
    if (req.query.node) {
      const node = graph.nodes.get(String(req.query.node));
      if (!node) return res.status(404).json({ error: 'node not found' });
      return res.json({ captures: node.captures || [], source: 'node', node: node.id });
    }
    const since = parseInt(req.query.since || '0', 10);
    const captures = state.captures.filter((c) => c.seq > since);
    res.json({ captures, next_cursor: state.captureSeq, profiles: listProfiles() });
  });

  // Fetch a capture's RAW DOM, optionally scoped. Without a scoping param returns
  // the (capped) full raw; with selector/query/profile returns just that slice.
  app.get('/api/captures/:id/raw', (req, res) => {
    setCors(req, res);
    const rec = findCapture(graph, state, req.params.id);
    if (!rec) return res.status(404).json({ error: 'capture not found' });
    let raw;
    try {
      raw = fs.readFileSync(path.join(paths.WEB_CHAT_DIR, rec.raw_ref), 'utf8');
    } catch (e) {
      return res.status(404).json({ error: `raw sidecar missing: ${e.message}`, raw_ref: rec.raw_ref });
    }

    const { selector, query, profile } = req.query;
    const max = parseInt(req.query.max, 10) || 20;
    const context = parseInt(req.query.context, 10) || 200;
    const scoped = inspectRaw(raw, {
      selector: selector ? String(selector) : undefined,
      query: query ? String(query) : undefined,
      profile: profile ? String(profile) : undefined,
      max, context,
    });
    if (scoped) return res.json({ id: rec.id, url: rec.url, ...scoped });

    res.json({
      id: rec.id,
      url: rec.url,
      mode: 'full',
      bytes: rec.bytes_raw,
      truncated: raw.length > RAW_FULL_CAP,
      raw: raw.slice(0, RAW_FULL_CAP),
      hint: raw.length > RAW_FULL_CAP ? 'raw truncated — pass ?selector=, ?query=, or ?profile= to scope' : undefined,
    });
  });

  // Serve a capture's reader-lite simplified document — the standalone
  // sidecar the simplified-site pane links to as "open the full reader page". A
  // clean semantic HTML page (no scripts/site CSS), it opens in its own tab. Only
  // captures whose pane rendered the simplified view (article/default) have one.
  app.get('/api/captures/:id/simplified', (req, res) => {
    setCors(req, res);
    const rec = findCapture(graph, state, req.params.id);
    if (!rec) return res.status(404).json({ error: 'capture not found' });
    if (!rec.simplified_ref) return res.status(404).json({ error: 'no simplified render for this capture' });
    let doc;
    try {
      doc = fs.readFileSync(path.join(paths.WEB_CHAT_DIR, rec.simplified_ref), 'utf8');
    } catch (e) {
      return res.status(404).json({ error: `simplified sidecar missing: ${e.message}`, simplified_ref: rec.simplified_ref });
    }
    res.type('html').send(doc);
  });
}

module.exports = { mountCaptureRoutes, defaultReduce };
