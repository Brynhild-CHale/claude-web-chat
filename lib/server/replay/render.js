// Rendering a replay to a FILE — a GIF drawn by a headless system Chrome, or
// the replay document itself as .html — under .web-chat/exports/.
//
// The pieces, and who owns each:
//   which nodes, which captions ... domain/replay-path via document.resolveReplay
//   what a frame looks like ....... the replay document (document.js + player.js),
//                                   served by GET /replay with chrome=0
//   when each frame is taken ...... frameSchedule below, over player.js's own
//                                   timeline(), so the file keeps the same time
//                                   the in-browser player does
//   drawing the frames ............ lib/replay/chrome (system Chrome over a pipe)
//   PNG → pixels → GIF ............ lib/core/png, lib/core/gif
//
// The browser is pointed at this daemon's own /replay route over loopback, so a
// frame is drawn under the same PREVIEW_CSP as every other replay and preview.
//
// renderReplay is the whole operation; routes/replay.js is HTTP translation,
// single-flight and nothing else. Its answer is either
//   { ok:true, path, label, from, to, format, frames, encoder, bytes, duration_ms }
// or
//   { ok:false, status, code, error, hint? }

const fs = require('fs');
const path = require('path');
const { LOOPBACK } = require('../../core/cors');
const { projectPaths } = require('../../core/paths');
const { decodePng } = require('../../core/png');
const { createGifEncoder } = require('../../core/gif');
const { findChrome, CHROME_HINT } = require('../../replay/find');
const { captureFrames } = require('../../replay/chrome');
const { slugLabel, stamp } = require('../export');
const { resolveReplay, normalizeReplayOpts, assembleReplay } = require('./document');
const { timeline } = require('./player');

// The caps. A render occupies a whole browser and the daemon's CPU, so each one
// is bounded in frames, pixels, bytes and wall-clock time.
const LIMITS = Object.freeze({
  width: { min: 320, max: 1920, dflt: 960 },
  fps: { min: 1, max: 30, dflt: 10 },
  maxFrames: 1000,
  maxBytes: 64 * 1024 * 1024,
  timeoutMs: 5 * 60 * 1000,
});

// What POST /api/replay/render can produce here. mp4/webm need ffmpeg and are
// refused by name until an encoder for them exists.
const FORMATS = ['gif', 'replay'];
const LATER_FORMATS = ['mp4', 'webm'];

const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
const clampInt = (v, { min, max, dflt }) => {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return dflt;
  return Math.round(Math.min(max, Math.max(min, n)));
};
const even = (n) => n - (n % 2);

// When to take each frame, over a replay timeline ({spans:[{start,dur,fade}]}).
// A cut step is ONE frame held for its whole span. A faded step is sampled at
// `fps` across its fade — each sample held until the next — then one frame at
// full opacity held for the rest of the span. The delays sum to the timeline's
// total exactly; the GIF encoder merges any frame identical to the one before.
// → [{ t, delay }]
function frameSchedule(tl, { fps = LIMITS.fps.dflt } = {}) {
  const out = [];
  for (const sp of tl.spans) {
    if (sp.fade > 0) {
      const n = Math.max(1, Math.round((sp.fade * fps) / 1000));
      const slice = sp.fade / n;
      for (let k = 0; k < n; k++) out.push({ t: sp.start + slice * k, delay: slice });
      out.push({ t: sp.start + sp.fade, delay: sp.dur - sp.fade });
    } else {
      out.push({ t: sp.start, delay: sp.dur });
    }
  }
  return out;
}

// Normalize a render request body. → { ok, format, width, fps, docQuery } | { ok:false, … }
function normalizeRenderRequest(body = {}) {
  const format = String(one(body.format) || 'gif').toLowerCase();
  if (LATER_FORMATS.includes(format)) {
    return {
      ok: false, status: 400, code: 'format-unavailable',
      error: `format '${format}' is not available yet — it needs the ffmpeg encoder`,
      hint: "use format 'gif' (built in) or 'replay' (.html)",
    };
  }
  if (!FORMATS.includes(format)) {
    return { ok: false, status: 400, code: 'bad-format', error: `unknown format '${format}'`, hint: `one of: ${FORMATS.join(', ')}` };
  }
  const width = even(clampInt(one(body.width), LIMITS.width));
  const fps = clampInt(one(body.fps), LIMITS.fps);
  // A rendered file defaults to SUMMARY captions: it is made to be sent on, and
  // a prompt is the one thing a replay carries that a page export does not.
  const captions = ['prompt', 'summary', 'none'].includes(one(body.captions)) ? one(body.captions) : 'summary';
  const docQuery = {
    hold_ms: one(body.hold_ms),
    pacing: one(body.pacing),
    transition: one(body.transition),
    captions,
    size: one(body.size),
  };
  return { ok: true, format, width, fps, docQuery };
}

function writeOut(dir, name, data) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

// ctx: { graph, paths, root }; opts: { port, now, env, findChromeImpl, captureImpl, timeoutMs }
async function renderReplay(ctx, body = {}, opts = {}) {
  const req = normalizeRenderRequest(body);
  if (!req.ok) return req;
  const res = resolveReplay(ctx, {
    from: one(body.from) || undefined,
    to: one(body.to) || undefined,
    includeCollapsed: ['1', 'true', true].includes(one(body.include_collapsed)),
  });
  if (!res.ok) return res;

  const now = opts.now || new Date();
  const { from, to } = res.meta;
  const base = `replay-${slugLabel(from)}_${slugLabel(to)}-${stamp(now)}`;
  const label = from === to ? from : `${from} → ${to}`;
  const exportsDir = ctx.paths.EXPORTS_DIR;

  if (req.format === 'replay') {
    const docOpts = normalizeReplayOpts({ ...req.docQuery, chrome: true });
    const html = assembleReplay({ steps: res.steps, themes: res.themes, opts: docOpts, meta: res.meta });
    const file = writeOut(exportsDir, `${base}.html`, html);
    return {
      ok: true, format: 'replay', path: file, label, from, to,
      frames: res.steps.length, encoder: 'document', bytes: Buffer.byteLength(html),
    };
  }

  // ── gif ──
  const chromePath = (opts.findChromeImpl || findChrome)({ env: opts.env || process.env });
  if (!chromePath) {
    return { ok: false, status: 422, code: 'chrome-not-found', error: 'no Chrome-family browser found on this machine', hint: CHROME_HINT };
  }
  if (!opts.port) return { ok: false, status: 500, code: 'no-port', error: 'the daemon does not know its own port' };

  const docOpts = normalizeReplayOpts({ ...req.docQuery, chrome: false });
  const tl = timeline(res.steps.map((s) => ({ dt_from_prev: s.dt_from_prev })), docOpts);
  const schedule = frameSchedule(tl, { fps: req.fps });
  if (schedule.length > LIMITS.maxFrames) {
    return {
      ok: false, status: 413, code: 'too-many-frames',
      error: `this replay would take ${schedule.length} frames; the limit is ${LIMITS.maxFrames}`,
      hint: 'use transition:"cut", a lower fps, or a shorter from/to range',
    };
  }
  const width = req.width;
  const height = even(Math.round(width * (docOpts.size.h / docOpts.size.w)));

  // The browser draws exactly the path resolved above: pin both ends by id.
  const q = new URLSearchParams({
    from: res.path.from.id,
    to: res.path.to.id,
    hold_ms: String(docOpts.hold_ms),
    pacing: docOpts.pacing,
    transition: docOpts.transition,
    captions: docOpts.captions,
    size: `${docOpts.size.w}x${docOpts.size.h}`,
    chrome: '0',
  });
  if (['1', 'true', true].includes(one(body.include_collapsed))) q.set('include_collapsed', '1');
  const url = `http://${LOOPBACK}:${opts.port}/replay?${q}`;

  const enc = createGifEncoder({ width, height, loop: 0 });
  const started = Date.now();
  try {
    await (opts.captureImpl || captureFrames)({
      chromePath,
      url,
      width,
      height,
      times: schedule.map((f) => f.t),
      tmpDir: projectPaths(ctx.root || ctx.paths.root).tmp,
      timeoutMs: opts.timeoutMs || LIMITS.timeoutMs,
      onFrame: (png, i) => {
        const img = decodePng(png);
        if (img.width !== width || img.height !== height) {
          const e = new Error(`Chrome drew a ${img.width}x${img.height} frame; ${width}x${height} was asked for`);
          e.code = 'bad-frame';
          throw e;
        }
        enc.addFrame(img.data, schedule[i].delay);
      },
    });
  } catch (e) {
    const code = e.code || 'render-failed';
    const status = code === 'timeout' ? 504 : 502;
    return { ok: false, status, code, error: e.message };
  }
  const gif = enc.finish();
  if (gif.length > LIMITS.maxBytes) {
    return {
      ok: false, status: 413, code: 'too-large',
      error: `the GIF came to ${gif.length} bytes; the limit is ${LIMITS.maxBytes}`,
      hint: 'use a smaller width or a shorter from/to range',
    };
  }
  const file = writeOut(exportsDir, `${base}.gif`, gif);
  return {
    ok: true, format: 'gif', path: file, label, from, to,
    frames: enc.frames, encoder: 'builtin', bytes: gif.length,
    width, height, duration_ms: tl.total, render_ms: Date.now() - started,
  };
}

module.exports = { renderReplay, frameSchedule, normalizeRenderRequest, LIMITS, FORMATS };
