// lib/server/replay/document.js — the replay document.
//
// ONE self-contained HTML page that plays a lineage of the graph node by node:
// a controller (lib/server/replay/player.js, spliced in as text), a caption bar,
// a scrubber with one tick per step, and a stage the steps are drawn on. It is
// what the in-browser player overlay iframes (GET /replay), what the user
// downloads as replay-<from>_<to>.html (GET /api/replay/html), and what a GIF
// renderer drives headless (`chrome:false`, window.__wcReplay.seek).
//
// Each step's frame is the node PREVIEW document (lib/server/preview.js), but
// the page does not inline N copies of it — the mount runtime alone would make
// a long replay megabytes. The payload carries the preview template ONCE, as the
// three pieces around its two holes, plus each distinct theme once and each
// step's node JSON; the player fills a frame by concatenation when the step is
// about to be shown. Every string that lands in a hole is escaped here, on the
// server, by the preview module's own fillers — the browser never escapes.
//
// No network, by construction: no fetch, no WebSocket, no URL. Served under
// PREVIEW_CSP (connect-src 'none'), which the srcdoc frames inherit.
//
// assembleReplay is pure (it unit-tests without a server); buildReplay below it
// is the ctx-dependent resolution — path, nodes, themes — like export.js.

const fs = require('fs');
const path = require('path');
const { escapeHtml } = require('../../core/html');
const { tokenDecls } = require('../theme');
const { jsonForScript, slugLabel } = require('../export');
const { previewTemplate, previewThemeCss, previewNodeJson, themeLayers, modeParam } = require('../preview');
const { resolveReplayPath } = require('../domain/replay-path');

let playerSrc = null;
function playerSource() {
  if (playerSrc == null) playerSrc = fs.readFileSync(path.join(__dirname, 'player.js'), 'utf8');
  return playerSrc;
}

// ── options ─────────────────────────────────────────────────────────────────

const DEFAULTS = Object.freeze({
  hold_ms: 2500,
  pacing: 'hold',          // 'hold' (every step hold_ms) | 'realtime' (the real gaps, clamped 1–6 s)
  transition: 'cut',       // 'cut' | 'fade'
  captions: 'on',          // 'on' | 'none'
  include_prompts: false,  // true: captions show the user's prompts too
  size: { w: 1280, h: 800 },
  chrome: true,            // false: stage + caption only — what a GIF renderer captures
  speed: 1,
  autoplay: false,
  at: null,                // start on this step index instead of the first
});

const HOLD_MIN = 500;
const HOLD_MAX = 20000;

const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
const flag = (v, dflt) => {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
};
const num = (v) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? null : n; };

// Normalize replay options from a query string or a JSON body. Unknown or
// out-of-range values fall back to the default (a replay is a view, not a
// contract a bad parameter should fail): hold 0.5–20 s, size 320–3840 ×
// 240–2160, speed 0.25–4.
function normalizeReplayOpts(q = {}) {
  const o = { ...DEFAULTS, size: { ...DEFAULTS.size } };
  const hold = num(one(q.hold_ms));
  if (hold != null) o.hold_ms = Math.round(Math.min(HOLD_MAX, Math.max(HOLD_MIN, hold)));
  if (one(q.pacing) === 'realtime') o.pacing = 'realtime';
  if (one(q.transition) === 'fade') o.transition = 'fade';
  // `none` is the one caption choice left; anything else (the retired
  // 'prompt' / 'summary' included) is captions on. Whether a caption carries
  // the user's prompt is its own switch, and it is off unless asked for BY
  // NAME — an old `captions=prompt` link does not turn it on.
  if (one(q.captions) === 'none') o.captions = 'none';
  o.include_prompts = flag(one(q.include_prompts), false);
  const size = one(q.size);
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(String(size || ''));
  if (m) {
    o.size = { w: Math.min(3840, Math.max(320, +m[1])), h: Math.min(2160, Math.max(240, +m[2])) };
  }
  o.chrome = flag(one(q.chrome), DEFAULTS.chrome);
  const sp = num(one(q.speed));
  if (sp != null) o.speed = Math.min(4, Math.max(0.25, sp));
  o.autoplay = flag(one(q.autoplay), false);
  const at = num(one(q.at));
  if (at != null && at >= 0) o.at = Math.floor(at);
  return o;
}

// What a caption carries. The payload holds ONLY what will be shown: a
// replay.html is a file the user may send on, and a prompt the viewer did not
// choose to include must not be sitting in its source — not the prompt, not
// the trigger's `summary` (a typed turn's is the prompt's first 100
// characters). Without prompts a caption is Claude's reply summary alone; the
// step's label and time are drawn from the step itself.
function captionFor(step, opts) {
  if (opts.captions === 'none') return {};
  const c = {};
  if (opts.include_prompts) {
    const p = step.prompt || step.summary || '';
    if (p) c.prompt = p;
  }
  if (step.reply) c.reply = step.reply;
  return c;
}

// A step's frame: exactly what the preview draws — the page (panes, markdown,
// order) and the store. previewNodeJson bakes the markdown into rendered page
// items, so a node with prose replays with it in place.
function frameNode(s) {
  const n = s.node || {};
  return {
    id: n.id ?? s.id, mounts: n.mounts || [],
    ...(n.markdown && n.markdown.length ? { markdown: n.markdown } : {}),
    ...(Array.isArray(n.order) ? { order: n.order } : {}),
    store: n.store || {},
  };
}

// ── the pure assembler ──────────────────────────────────────────────────────

const PAGE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; display: flex; flex-direction: column; overflow: hidden;
  background: var(--wc-bg, #14110c); color: var(--wc-fg, #ece4d4);
  font: 13px var(--wc-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif); }
#rp-stage { position: relative; flex: 1; min-height: 0; overflow: hidden; background: var(--wc-bg, #14110c); }
.rp-frame { position: absolute; left: var(--rp-ox, 0); top: var(--rp-oy, 0); border: 0;
  transform: scale(var(--rp-scale, 1)); transform-origin: 0 0; pointer-events: none;
  background: var(--wc-bg, #fafafa); visibility: hidden; }
#rp-caption { display: flex; flex-direction: column; gap: 3px; padding: 8px 14px 9px;
  border-top: 1px solid var(--wc-border, #3a3224); background: var(--wc-header-bg, #1d1911); min-height: 52px; }
.rp-cap-head { display: flex; align-items: baseline; gap: 8px; font: 600 11px var(--wc-mono, ui-monospace, Menlo, monospace);
  color: var(--wc-muted, #9a8f7b); }
#rp-cap-label { color: var(--wc-accent, #d8a657); }
#rp-cap-time { font-weight: 400; }
#rp-cap-folded { margin-left: auto; font-weight: 400; }
#rp-cap-text, #rp-cap-reply { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#rp-cap-text { color: var(--wc-fg, #ece4d4); }
#rp-cap-text::before { content: "› "; color: var(--wc-muted, #9a8f7b); }
#rp-cap-reply { color: var(--wc-muted, #9a8f7b); }
#rp-cap-reply::before { content: "Claude: "; font-weight: 600; }
#rp-controls { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-top: 1px solid var(--wc-border, #3a3224); background: var(--wc-panel-bg, #1d1911); }
#rp-controls button { min-width: 30px; height: 28px; border: 1px solid var(--wc-border, #3a3224);
  border-radius: var(--wc-radius, 6px); background: transparent; color: var(--wc-fg, #ece4d4); font: 12px var(--wc-font, sans-serif); cursor: pointer; }
#rp-controls button:hover { border-color: var(--wc-accent, #d8a657); }
#rp-scrub { position: relative; flex: 1; height: 22px; cursor: pointer; touch-action: none; }
#rp-scrub::before { content: ""; position: absolute; left: 0; right: 0; top: 10px; height: 3px; border-radius: 2px;
  background: var(--wc-border, #3a3224); }
#rp-scrub-fill { position: absolute; left: 0; top: 10px; height: 3px; border-radius: 2px; width: 0;
  background: var(--wc-accent, #d8a657); pointer-events: none; }
.rp-tick { position: absolute; top: 6px; width: 2px; height: 11px; margin-left: -1px; border-radius: 1px;
  background: var(--wc-muted, #9a8f7b); }
#rp-scrub-tip { position: absolute; bottom: 22px; transform: translateX(-50%); padding: 2px 6px; white-space: nowrap;
  border-radius: var(--wc-radius-sm, 4px); background: var(--wc-panel-bg, #1d1911); border: 1px solid var(--wc-border, #3a3224);
  font: 11px var(--wc-mono, ui-monospace, Menlo, monospace); pointer-events: none; }
.rp-num { font: 11px var(--wc-mono, ui-monospace, Menlo, monospace); color: var(--wc-muted, #9a8f7b); white-space: nowrap; }
body.rp-bare #rp-controls { display: none; }
body.rp-bare #rp-caption { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3;
  background: color-mix(in srgb, var(--wc-header-bg, #1d1911) 88%, transparent); }
body.rp-nocap #rp-caption { display: none; }
[hidden] { display: none !important; }
`.trim();

// assembleReplay({ steps, themes, opts, meta }) → html
//   steps:  [{ id, label, author, kind, prompt, reply, summary, folded_count,
//              created_at, dt_from_prev, theme: <index into themes>,
//              node: { id, mounts, markdown?, order?, store } }]
//   themes: [{ tokens, css }]            (resolved global ⊕ node, deduplicated)
//   opts:   normalizeReplayOpts(...)
//   meta:   { from, to, truncated, total_steps }   (labels)
function assembleReplay({ steps = [], themes = [], opts = normalizeReplayOpts(), meta = {} } = {}) {
  const payload = {
    v: 1,
    meta: {
      from: meta.from || (steps[0] && steps[0].label) || '',
      to: meta.to || (steps.length && steps[steps.length - 1].label) || '',
      truncated: !!meta.truncated,
      total_steps: meta.total_steps ?? steps.length,
    },
    opts,
    frame: previewTemplate(),
    themes: themes.map(previewThemeCss),
    steps: steps.map((s) => ({
      id: s.id,
      label: s.label,
      author: s.author || null,
      kind: s.kind || null,
      created_at: s.created_at ?? null,
      dt_from_prev: s.dt_from_prev ?? null,
      folded_count: s.folded_count || 0,
      caption: captionFor(s, opts),
      theme: Number.isInteger(s.theme) ? s.theme : 0,
      // Only what the preview draws — whatever else the caller's node carries
      // (its trigger, i.e. the prompt) stays out of a file the user may send on.
      node: previewNodeJson(frameNode(s)),
    })),
  };

  // The page chrome wears the theme the replay ARRIVES at.
  const last = steps.length ? themes[steps[steps.length - 1].theme] : themes[0];
  const decls = tokenDecls((last && last.tokens) || {});
  const rootBlock = decls ? `:root {\n${decls}\n}\n` : '';
  const { from, to } = payload.meta;
  const title = `Replay ${from}${to && to !== from ? ` → ${to}` : ''}`;
  const bodyClass = [opts.chrome ? '' : 'rp-bare', opts.captions === 'none' ? 'rp-nocap' : ''].filter(Boolean).join(' ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="claude-web-chat replay">
<title>${escapeHtml(title)}</title>
<style>
${rootBlock}${PAGE_CSS}
</style>
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
<div id="rp-stage" aria-label="${escapeHtml(title)}"></div>
<div id="rp-caption" aria-live="polite">
  <div class="rp-cap-head"><span id="rp-cap-label"></span><span id="rp-cap-who"></span><span id="rp-cap-time"></span><span id="rp-cap-folded" hidden></span></div>
  <div id="rp-cap-text" hidden></div>
  <div id="rp-cap-reply" hidden></div>
</div>
<div id="rp-controls">
  <button id="rp-prev" type="button" title="Previous step (←)" aria-label="Previous step">⏮</button>
  <button id="rp-play" type="button" title="Play / pause (Space)" aria-label="Play">▶</button>
  <button id="rp-next" type="button" title="Next step (→)" aria-label="Next step">⏭</button>
  <div id="rp-scrub" role="slider" aria-label="Replay position"><div id="rp-ticks"></div><div id="rp-scrub-fill"></div><div id="rp-scrub-tip" hidden></div></div>
  <span class="rp-num" id="rp-time">0:00 / 0:00</span>
  <span class="rp-num" id="rp-count"></span>
</div>
<script id="wc-replay-data" type="application/json">${jsonForScript(payload)}</script>
<script>${playerSource()}</script>
</body>
</html>
`;
}

// ── ctx-dependent resolution ────────────────────────────────────────────────

// Resolve a replay from the graph: which nodes (domain/replay-path), each
// node's frame data, and the themes they are drawn under (deduplicated — most
// nodes carry no theme of their own and share the global default). `mode`
// ('light' | 'dark') is the viewer's, passed by the player overlay so a replay
// reads like the page beside it; null — a download, a rendered file — is light.
// → { ok:true, steps, themes, meta, path } | { ok:false, status, code, error, which }
function resolveReplay(ctx, { from, to, includeCollapsed = false, mode = null } = {}) {
  const r = resolveReplayPath(ctx.graph, { from, to, includeCollapsed });
  if (!r.ok) {
    const status = (r.code === 'not-found' || r.code === 'no-active') ? 404 : 400;
    return { ok: false, status, code: r.code, error: r.error, which: r.which };
  }
  const themes = [];
  const themeIdx = new Map();
  const base = themeLayers(ctx.paths, null, mode).page;
  const themeOf = (node) => {
    const page = node && node.theme ? themeLayers(ctx.paths, node, mode).page : base;
    const key = JSON.stringify(page);
    if (!themeIdx.has(key)) { themeIdx.set(key, themes.length); themes.push(page); }
    return themeIdx.get(key);
  };
  const steps = r.steps.map((s) => {
    const node = ctx.graph.nodes.get(s.id) || {};
    return {
      ...s,
      theme: themeOf(node),
      // Only what the preview draws. The node's trigger (the prompt) is NOT
      // here: a caption carries it, and only when include_prompts asks for it.
      node: { id: s.id, mounts: node.mounts || [], markdown: node.markdown, order: node.order, store: node.store || {} },
    };
  });
  return {
    ok: true,
    steps,
    themes,
    path: r,
    meta: { from: r.from.label, to: r.to.label, truncated: r.truncated, total_steps: r.total_steps },
  };
}

// The whole document for a query ({from, to, include_collapsed, mode, …opts}).
// → { ok:true, html, from, to, filename } | { ok:false, status, code, error, which }
function buildReplay(ctx, q = {}) {
  const res = resolveReplay(ctx, {
    from: one(q.from) || undefined,
    to: one(q.to) || undefined,
    includeCollapsed: flag(one(q.include_collapsed), false),
    mode: modeParam(one(q.mode)),
  });
  if (!res.ok) return res;
  const opts = normalizeReplayOpts(q);
  const html = assembleReplay({ steps: res.steps, themes: res.themes, opts, meta: res.meta });
  return {
    ok: true,
    html,
    from: res.meta.from,
    to: res.meta.to,
    filename: `replay-${slugLabel(res.meta.from)}_${slugLabel(res.meta.to)}.html`,
  };
}

module.exports = {
  assembleReplay, normalizeReplayOpts, resolveReplay, buildReplay, playerSource, DEFAULTS,
  // The query/body readers every replay entry point shares (routes/replay.js,
  // render.js), so `include_collapsed=yes` means the same thing on each.
  one, flag,
};
