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
const { resolveReplay, replayOpts, assembleReplay, normalizeReplayOpts, one, flag, CAPTIONS } = require('./document');
const { modeParam } = require('../preview');
const { timeline } = require('./player');

// The caps. A render occupies a whole browser and the daemon's CPU, so each one
// is bounded in frames, pixels, bytes and wall-clock time. `maxArea` bounds a
// frame's pixels whatever its shape: the widest frame at 16:10, 1920×1200 —
// the height follows the replay's size, and a tall size would otherwise make a
// 1920-wide frame 1920×12960. `maxBytes` bounds every file a render writes,
// the .html replay included.
const LIMITS = Object.freeze({
  width: { min: 320, max: 1920, dflt: 960 },
  fps: { min: 1, max: 30, dflt: 10 },
  maxFrames: 1000,
  maxArea: 1920 * 1200,
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

// When to take each frame, over a replay timeline
// ({spans:[{start, dur, fade, moves:[{at, dur}]}]}). Whatever is still is ONE
// frame held until the next motion; whatever moves — a fade-in, and each of the
// step's scroll moves (player.js focusMoves) — is sampled at `fps`, each sample
// held until the next. So a cut step that scrolls nowhere is one frame, and a
// scroll is drawn as motion even in `cut` mode. The delays sum to the
// timeline's total exactly; the GIF encoder merges any frame identical to the
// one before (a move slot whose target was already in view costs nothing).
// → [{ t, delay }]
function frameSchedule(tl, { fps = LIMITS.fps.dflt } = {}) {
  const out = [];
  for (const sp of tl.spans) {
    const end = sp.start + sp.dur;
    const motion = [];
    if (sp.fade > 0) motion.push([sp.start, sp.start + sp.fade]);
    for (const m of sp.moves || []) if (m.dur > 0) motion.push([sp.start + m.at, Math.min(end, sp.start + m.at + m.dur)]);
    let cur = sp.start;
    for (const [a, b] of motion) {
      if (a > cur) { out.push({ t: cur, delay: a - cur }); cur = a; }
      const len = b - cur;
      if (len <= 0) continue;
      const n = Math.max(1, Math.round((len * fps) / 1000));
      const slice = len / n;
      for (let k = 0; k < n; k++) out.push({ t: cur + slice * k, delay: slice });
      cur = b;
    }
    if (end > cur) out.push({ t: cur, delay: end - cur });
  }
  return out;
}

// The frames to take over a timeline: at `fps`, or — when the caller named no
// fps (`auto`) and that comes to more than `maxFrames` — at the highest fps
// down to 1 that fits. Only motion (a fade, a scroll move) is sampled at fps,
// so a lower fps costs smoothness, never time: a long plain replay, every step
// scrolling to what it changed, renders instead of being refused.
// → { schedule, fps } (fps: the one used; the schedule may still be over the
//   cap when even 1 fps is, or when the caller's own fps is)
function fitSchedule(tl, { fps = LIMITS.fps.dflt, auto = false, maxFrames = LIMITS.maxFrames } = {}) {
  let used = fps;
  let schedule = frameSchedule(tl, { fps: used });
  while (auto && schedule.length > maxFrames && used > LIMITS.fps.min) {
    used -= 1;
    schedule = frameSchedule(tl, { fps: used });
  }
  return { schedule, fps: used };
}

// A frame's pixel size: `width` wide, as tall as the replay's size says —
// unless that is over `maxArea`, when the frame shrinks (width, and the height
// with it, so the page is never letterboxed) until it fits. Both even: the
// video encoders need them so. → { width, height }
function frameSize(width, size, maxArea = LIMITS.maxArea) {
  const ratio = size.h / size.w;
  let w = width;
  let h = even(Math.round(w * ratio));
  if (w * h > maxArea) {
    w = Math.min(w, even(Math.floor(Math.sqrt(maxArea / ratio))));
    h = even(Math.round(w * ratio));
    while (w * h > maxArea && w > 2) { w -= 2; h = even(Math.round(w * ratio)); }
  }
  return { width: w, height: h };
}

// Normalize a render request body.
// → { ok, format, width, height, fps, fpsAuto, mode, docQuery } | { ok:false, … }
function normalizeRenderRequest(body = {}) {
  const format = String(one(body.format) || 'gif').toLowerCase();
  if (!FORMATS.includes(format)) {
    return { ok: false, status: 400, code: 'bad-format', error: `unknown format '${format}'`, hint: `one of: ${FORMATS.join(', ')}` };
  }
  // Captions are 'on' (the default) or 'none', and a file is not a view: the
  // document routes read any other value as 'on', but here a typo would write
  // a file the caller did not ask for, so it is refused by name instead.
  const captions = one(body.captions);
  if (captions != null && captions !== '' && !CAPTIONS.includes(captions)) {
    return {
      ok: false, status: 400, code: 'bad-captions', error: `unknown captions '${captions}'`,
      hint: `one of: ${CAPTIONS.join(', ')}${captions === 'prompt' ? ' (for the user\'s prompts in the captions, pass include_prompts: true)' : ''}`,
    };
  }
  const fpsSaid = one(body.fps);
  const fps = clampInt(fpsSaid, LIMITS.fps);
  // No usable fps from the caller: the render may lower it to fit (fitSchedule).
  // The player's buttons never send one; the export tool and the CLI send one
  // only when asked to (fps, --fps).
  const fpsAuto = fpsSaid == null || fpsSaid === '' || !Number.isFinite(Number(fpsSaid));
  // A rendered file leaves the user's prompts OUT unless include_prompts asks
  // for them: it is made to be sent on, and a prompt is the one thing a replay
  // carries that a page export does not. The body's include_prompts is kept
  // only when it SAYS one (true/false): an explicit choice wins over a
  // script's, and a body that says nothing leaves it to the script, else off
  // (document.js replayOpts). Captions stay on (Claude's reply and each node's
  // label and time) unless `captions: 'none'`.
  const said = one(body.include_prompts);
  const docQuery = {
    hold_ms: one(body.hold_ms),
    pacing: one(body.pacing),
    transition: one(body.transition),
    captions: captions === 'none' ? 'none' : 'on',
    include_prompts: said == null || said === '' ? undefined : flag(said, false),
    size: one(body.size),
  };
  // A rendered file is LIGHT unless the body names a mode: it is sent on, and
  // whoever opens it was not looking at the viewer's chrome.
  const mode = modeParam(one(body.mode));
  // The frame: the asked width, the replay's own shape, within LIMITS.maxArea.
  const { width, height } = frameSize(even(clampInt(one(body.width), LIMITS.width)), normalizeReplayOpts({ size: docQuery.size }).size);
  return { ok: true, format, width, height, fps, fpsAuto, mode, docQuery };
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
//       and its include_prompts decides when the body says none — an explicit
//       include_prompts on the body, the viewer's checkbox, wins over it)
// opts: { port, now, env, findChromeImpl, findFfmpegImpl, captureImpl, timeoutMs,
//         maxBytes, maxFrames (default LIMITS'; a test passes smaller ones),
//         signal (an AbortSignal: abandons the capture and tears the browser
//         down, or the encode and kills ffmpeg — whichever phase is running),
//         scripts (routes/replay's script store: every GIF/MP4/WebM render
//         hands the browser a pinned script's id — never a from/to it would
//         resolve again) }
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
  const maxBytes = opts.maxBytes || LIMITS.maxBytes;
  const maxFrames = opts.maxFrames || LIMITS.maxFrames;

  if (req.format === 'replay') {
    const docOpts = replayOpts(res, { ...req.docQuery, chrome: true });
    const html = assembleReplay({ steps: res.steps, themes: res.themes, opts: docOpts, meta: res.meta });
    // The document inlines every step's node (its panes and store), so it is
    // bounded like any file a render writes.
    const bytes = Buffer.byteLength(html);
    if (bytes > maxBytes) {
      return {
        ok: false, status: 413, code: 'too-large',
        error: `the replay .html came to ${bytes} bytes; the limit is ${maxBytes}`,
        hint: 'use a shorter from/to range, or a script that shows fewer nodes',
      };
    }
    const file = writeOut(exportsDir, `${base}.html`, html);
    return {
      ok: true, format: 'replay', path: file, label, from, to,
      frames: res.steps.length, encoder: 'document', bytes,
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

  if (!opts.scripts) return { ok: false, status: 500, code: 'no-script-store', error: 'this daemon cannot hand a replay script to the browser' };
  const docOpts = replayOpts(res, { ...req.docQuery, chrome: false });
  // The same spans the player will play — a script's per-step holds and
  // transitions included — so the file keeps the player's time exactly.
  const tl = timeline(res.steps.map((s) => ({ dt_from_prev: s.dt_from_prev, hold_ms: s.hold_ms, transition: s.transition, focus: s.focus })), docOpts);
  const { schedule, fps } = fitSchedule(tl, { fps: req.fps, auto: req.fpsAuto, maxFrames });
  if (schedule.length > maxFrames) {
    return {
      ok: false, status: 413, code: 'too-many-frames',
      error: `this replay would take ${schedule.length} frames${req.fpsAuto ? ' even at 1 fps' : ` at ${fps} fps`}; the limit is ${maxFrames}`,
      hint: `use a shorter from/to range, or a script that groups in-between nodes into fewer steps${req.fpsAuto ? '' : ' — or leave fps out, and it is lowered to fit'}`,
    };
  }
  const { width, height } = req;

  // The browser draws exactly the steps the schedule above was built from: it
  // is handed a pinned script, every ref a stored id — a script's own, or, for
  // a plain replay, one step per node resolved here. Handed only from/to, it
  // would resolve the path again a second later, and a node set active,
  // bookmarked or branched from meanwhile would change which nodes it plays
  // under a schedule already fixed.
  const pinnedScript = scripted ? res.path.script : {
    from: res.path.from.id,
    to: res.path.to.id,
    ...(res.path.default_hold_ms != null ? { default_hold_ms: res.path.default_hold_ms } : {}),
    steps: res.steps.map((s) => ({ node: s.id })),
  };
  const q = new URLSearchParams({
    script: opts.scripts.put(pinnedScript),
    hold_ms: String(docOpts.hold_ms),
    pacing: docOpts.pacing,
    transition: docOpts.transition,
    captions: docOpts.captions,
    // The decision made above, always explicit: the document lets a request's
    // own include_prompts win, so the browser draws exactly this.
    include_prompts: docOpts.include_prompts ? '1' : '0',
    size: `${docOpts.size.w}x${docOpts.size.h}`,
    chrome: '0',
  });
  if (req.mode) q.set('mode', req.mode);
  const url = `http://${LOOPBACK}:${opts.port}/replay?${q}`;

  const tmpDir = projectPaths(ctx.root || ctx.paths.root).tmp;
  // What a daemon that died mid-render left here goes before this one adds more.
  sweepStaleTmp(tmpDir);
  const timeoutMs = opts.timeoutMs || LIMITS.timeoutMs;
  const enc = createFrameEncoder({ format: req.format, ffmpegPath, width, height, fps, loop: 0, tmpDir });
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
    // The encode shares the render's one wall-clock budget, and its abort: a
    // daemon shutting down mid-encode kills ffmpeg and answers 503 aborted.
    out = await enc.finish({ timeoutMs: Math.max(1000, timeoutMs - (Date.now() - started)), signal: opts.signal });
  } catch (e) {
    const code = e.code || 'render-failed';
    const status = code === 'timeout' ? 504 : code === 'aborted' ? 503 : 502;
    return { ok: false, status, code, error: e.message };
  } finally {
    enc.dispose();
  }
  const what = req.format === 'gif' ? 'GIF' : req.format.toUpperCase();
  if (out.data.length > maxBytes) {
    return {
      ok: false, status: 413, code: 'too-large',
      error: `the ${what} came to ${out.data.length} bytes; the limit is ${maxBytes}`,
      hint: 'use a smaller width or a shorter from/to range',
    };
  }
  const file = writeOut(exportsDir, `${base}.${req.format}`, out.data);
  return {
    ok: true, format: req.format, path: file, label, from, to,
    frames: out.frames, encoder: out.encoder, bytes: out.data.length,
    ...(out.fallback ? { fallback: out.fallback } : {}),
    width, height, fps, duration_ms: tl.total, render_ms: Date.now() - started,
    include_prompts: docOpts.include_prompts,
  };
}

module.exports = { renderReplay, frameSchedule, fitSchedule, frameSize, normalizeRenderRequest, LIMITS, FORMATS };
