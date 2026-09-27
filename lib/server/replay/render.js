// Rendering a replay to a FILE — a GIF, MP4 or WebM drawn by a headless system
// Chrome, or the replay document itself as .html — under .web-chat/exports/.
//
// The pieces, and who owns each:
//   which nodes, which captions ... domain/replay-path via document.resolveReplay
//                                   (a replay script, when the body carries one)
//   what a frame looks like ....... the replay document (document.js + player.js),
//                                   served by GET /replay with chrome=0
//   when each frame is taken ...... frameSchedule below, over player.js's own
//                                   timeline(), so the file keeps the same time
//                                   the in-browser player does
//   drawing the frames ............ lib/replay/chrome (system Chrome over a pipe)
//   frames → file ................. lib/replay/encode: ffmpeg when the machine
//                                   has it (GIF, MP4, WebM), else the built-in
//                                   lib/core/png → lib/core/gif (GIF only)
//
// The browser is pointed at this daemon's own /replay route over loopback, so a
// frame is drawn under the same PREVIEW_CSP as every other replay and preview.
//
// renderReplay is the whole operation; routes/replay.js is HTTP translation,
// single-flight and nothing else. Its answer is either
//   { ok:true, path, label, from, to, format, frames, encoder, bytes, duration_ms, include_prompts }
// or
//   { ok:false, status, code, error, hint? }

const fs = require('fs');
const path = require('path');
const { LOOPBACK } = require('../../core/cors');
const { projectPaths } = require('../../core/paths');
const { findChrome, findFfmpeg, CHROME_HINT, FFMPEG_HINT } = require('../../replay/find');
const { createFrameEncoder, VIDEO_FORMATS } = require('../../replay/encode');
const { captureFrames } = require('../../replay/chrome');
const { sweepStaleTmp } = require('../../replay/tmp');
const { slugLabel, stamp } = require('../export');
const { resolveReplay, replayOpts, assembleReplay, one, flag } = require('./document');
const { modeParam } = require('../preview');
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

// What POST /api/replay/render can produce. mp4/webm need ffmpeg on the
// machine (lib/replay/encode); gif prefers it and falls back to the built-in
// encoder; replay (.html) needs neither ffmpeg nor a browser.
const FORMATS = ['gif', 'mp4', 'webm', 'replay'];

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

// Normalize a render request body. → { ok, format, width, fps, mode, docQuery } | { ok:false, … }
function normalizeRenderRequest(body = {}) {
  const format = String(one(body.format) || 'gif').toLowerCase();
  if (!FORMATS.includes(format)) {
    return { ok: false, status: 400, code: 'bad-format', error: `unknown format '${format}'`, hint: `one of: ${FORMATS.join(', ')}` };
  }
  const width = even(clampInt(one(body.width), LIMITS.width));
  const fps = clampInt(one(body.fps), LIMITS.fps);
  // A rendered file leaves the user's prompts OUT unless include_prompts asks
  // for them: it is made to be sent on, and a prompt is the one thing a replay
  // carries that a page export does not. Captions stay on (Claude's reply and
  // each node's label and time) unless `captions: 'none'`.
  const docQuery = {
    hold_ms: one(body.hold_ms),
    pacing: one(body.pacing),
    transition: one(body.transition),
    captions: one(body.captions) === 'none' ? 'none' : 'on',
    include_prompts: flag(one(body.include_prompts), false),
    size: one(body.size),
  };
  // A rendered file is LIGHT unless the body names a mode: it is sent on, and
  // whoever opens it was not looking at the viewer's chrome.
  const mode = modeParam(one(body.mode));
  return { ok: true, format, width, fps, mode, docQuery };
}

function writeOut(dir, name, data) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

// ctx: { graph, paths, root }
// body: the request — from/to, or `script` (a replay script: domain/replay-path
//       normalizeReplayScript; its from/to and steps replace the body's from/to,
//       and its include_prompts, when it says one, wins over the body's)
// opts: { port, now, env, findChromeImpl, findFfmpegImpl, captureImpl, timeoutMs,
//         signal (an AbortSignal: abandons the capture and tears the browser down),
//         scripts (routes/replay's script store: a scripted render hands the
//         browser the script's id, not the script) }
async function renderReplay(ctx, body = {}, opts = {}) {
  const req = normalizeRenderRequest(body);
  if (!req.ok) return req;
  const scripted = body.script != null;
  const res = resolveReplay(ctx, {
    from: one(body.from) || undefined,
    to: one(body.to) || undefined,
    script: scripted ? body.script : null,
    includeCollapsed: flag(one(body.include_collapsed), false),
    mode: req.mode,
  });
  if (!res.ok) return res;

  const now = opts.now || new Date();
  const { from, to } = res.meta;
  const base = `replay-${slugLabel(from)}_${slugLabel(to)}-${stamp(now)}`;
  const label = from === to ? from : `${from} → ${to}`;
  const exportsDir = ctx.paths.EXPORTS_DIR;

  if (req.format === 'replay') {
    const docOpts = replayOpts(res, { ...req.docQuery, chrome: true });
    const html = assembleReplay({ steps: res.steps, themes: res.themes, opts: docOpts, meta: res.meta });
    const file = writeOut(exportsDir, `${base}.html`, html);
    return {
      ok: true, format: 'replay', path: file, label, from, to,
      frames: res.steps.length, encoder: 'document', bytes: Buffer.byteLength(html),
      include_prompts: docOpts.include_prompts,
    };
  }

  // ── gif / mp4 / webm ──
  const env = opts.env || process.env;
  const ffmpegPath = (opts.findFfmpegImpl || findFfmpeg)({ env });
  if (VIDEO_FORMATS.includes(req.format) && !ffmpegPath) {
    return { ok: false, status: 422, code: 'ffmpeg-not-found', error: `no ffmpeg found on this machine — ${req.format} needs it`, hint: FFMPEG_HINT };
  }
  const chromePath = (opts.findChromeImpl || findChrome)({ env });
  if (!chromePath) {
    return { ok: false, status: 422, code: 'chrome-not-found', error: 'no Chrome-family browser found on this machine', hint: CHROME_HINT };
  }
  if (!opts.port) return { ok: false, status: 500, code: 'no-port', error: 'the daemon does not know its own port' };

  if (scripted && !opts.scripts) return { ok: false, status: 500, code: 'no-script-store', error: 'this daemon cannot hand a replay script to the browser' };
  const docOpts = replayOpts(res, { ...req.docQuery, chrome: false });
  // The same spans the player will play — a script's per-step holds and
  // transitions included — so the file keeps the player's time exactly.
  const tl = timeline(res.steps.map((s) => ({ dt_from_prev: s.dt_from_prev, hold_ms: s.hold_ms, transition: s.transition })), docOpts);
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

  // The browser draws exactly the path resolved above: pin both ends by id —
  // or, for a script, hand it the script with every ref pinned to an id.
  const q = new URLSearchParams({
    ...(scripted ? { script: opts.scripts.put(res.path.script) } : { from: res.path.from.id, to: res.path.to.id }),
    hold_ms: String(docOpts.hold_ms),
    pacing: docOpts.pacing,
    transition: docOpts.transition,
    captions: docOpts.captions,
    include_prompts: docOpts.include_prompts ? '1' : '0',
    size: `${docOpts.size.w}x${docOpts.size.h}`,
    chrome: '0',
  });
  if (flag(one(body.include_collapsed), false)) q.set('include_collapsed', '1');
  if (req.mode) q.set('mode', req.mode);
  const url = `http://${LOOPBACK}:${opts.port}/replay?${q}`;

  const tmpDir = projectPaths(ctx.root || ctx.paths.root).tmp;
  // What a daemon that died mid-render left here goes before this one adds more.
  sweepStaleTmp(tmpDir);
  const timeoutMs = opts.timeoutMs || LIMITS.timeoutMs;
  const enc = createFrameEncoder({ format: req.format, ffmpegPath, width, height, fps: req.fps, loop: 0, tmpDir });
  const started = Date.now();
  let out;
  try {
    await (opts.captureImpl || captureFrames)({
      chromePath,
      url,
      width,
      height,
      times: schedule.map((f) => f.t),
      tmpDir,
      timeoutMs,
      signal: opts.signal,
      onFrame: (png, i) => enc.addFrame(png, schedule[i].delay),
    });
    // The encode shares the render's one wall-clock budget.
    out = await enc.finish({ timeoutMs: Math.max(1000, timeoutMs - (Date.now() - started)) });
  } catch (e) {
    const code = e.code || 'render-failed';
    const status = code === 'timeout' ? 504 : code === 'aborted' ? 503 : 502;
    return { ok: false, status, code, error: e.message };
  } finally {
    enc.dispose();
  }
  const what = req.format === 'gif' ? 'GIF' : req.format.toUpperCase();
  if (out.data.length > LIMITS.maxBytes) {
    return {
      ok: false, status: 413, code: 'too-large',
      error: `the ${what} came to ${out.data.length} bytes; the limit is ${LIMITS.maxBytes}`,
      hint: 'use a smaller width or a shorter from/to range',
    };
  }
  const file = writeOut(exportsDir, `${base}.${req.format}`, out.data);
  return {
    ok: true, format: req.format, path: file, label, from, to,
    frames: out.frames, encoder: out.encoder, bytes: out.data.length,
    ...(out.fallback ? { fallback: out.fallback } : {}),
    width, height, duration_ms: tl.total, render_ms: Date.now() - started,
    include_prompts: docOpts.include_prompts,
  };
}

module.exports = { renderReplay, frameSchedule, normalizeRenderRequest, LIMITS, FORMATS };
