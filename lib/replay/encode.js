// Turning a replay's captured frames into a file: a GIF, an MP4 or a WebM.
//
// Two encoders, one interface. The built-in one (lib/core/png → lib/core/gif)
// needs nothing on the machine and writes GIFs only. When ffmpeg is there
// (lib/replay/find: WEB_CHAT_FFMPEG, else PATH) it is used instead — for every
// format, because it does GIFs better too: a palette computed over the whole
// replay (palettegen) and applied with error diffusion (paletteuse, sierra2_4a,
// limited to each frame's changed rectangle so a still frame does not shimmer),
// where the built-in encoder quantizes each frame on its own with no dithering.
// MP4 (H.264, yuv420p) and WebM (VP9) exist ONLY through ffmpeg; without it they
// are an honest `ffmpeg-not-found`.
//
//   const enc = createFrameEncoder({ format, ffmpegPath, width, height, fps, tmpDir });
//   enc.addFrame(pngBuffer, delayMs);          // as each screenshot arrives
//   const { data, frames, encoder } = await enc.finish({ timeoutMs });
//   enc.dispose();                             // always — removes the frame dir
//
// The ffmpeg path writes each distinct screenshot to a throwaway directory under
// .web-chat/tmp/ (an identical screenshot adds its delay to the one before, as
// the built-in encoder does), describes the sequence in an ffconcat list — one
// `file` + `duration` per frame, so a held node is ONE image, not a run of
// copies — and runs ffmpeg over it: argv only (never a shell), `-nostdin`, the
// list and output paths built here, killed if it outlives the render's wall
// clock. If ffmpeg fails on a GIF, the frames already on disk go through the
// built-in encoder instead, and the answer says so (`fallback`); a failed MP4 or
// WebM has no fallback and fails with ffmpeg's last line of stderr.
//
// Needs ffmpeg 4.4 or later (the ffconcat `option` directive).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { decodePng, pngSize } = require('../core/png');
const { createGifEncoder } = require('../core/gif');

class EncodeError extends Error {
  constructor(code, message) { super(message); this.name = 'EncodeError'; this.code = code; }
}

const FORMATS = ['gif', 'mp4', 'webm'];
const VIDEO_FORMATS = ['mp4', 'webm'];
const STDERR_KEEP = 4000;

// The encoder settings per video format. Both take yuv420p — what every player
// decodes — which needs even dimensions; render.js only ever asks for even ones.
const VIDEO_CODEC = {
  mp4: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
  webm: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p'],
};

// Which encoder a format gets on a machine with (or without) ffmpeg.
// → 'ffmpeg' | 'builtin' | null (cannot be made here)
function pickEncoder(format, ffmpegPath) {
  if (ffmpegPath) return FORMATS.includes(format) ? 'ffmpeg' : null;
  return format === 'gif' ? 'builtin' : null;
}

// The ffconcat list for frames [{ file, delay }] (file names relative to the
// list, and always ours: f00000.png …). Every entry reads at a 100 Hz input rate, so a duration
// lands on the GIF's own centisecond grid instead of the image demuxer's default
// 25 Hz one. `repeatLast` adds the last image once more with no duration: the
// concat demuxer otherwise ends the stream at the last frame's START, which
// a video encoder would drop (the GIF path sets its final delay directly).
function ffconcat(frames, { repeatLast = false } = {}) {
  const lines = ['ffconcat version 1.0'];
  const secs = (ms) => (Math.max(1, Math.round(ms)) / 1000).toFixed(3);
  for (const f of frames) lines.push(`file '${f.file}'`, 'option framerate 100', `duration ${secs(f.delay)}`);
  if (repeatLast && frames.length) lines.push(`file '${frames[frames.length - 1].file}'`, 'option framerate 100');
  return lines.join('\n') + '\n';
}

// The ffmpeg runs for one encode, as argv arrays (never a shell string).
// A GIF is two passes — the palette over every frame, then the frames through
// it — rather than one split filter graph, which would buffer every decoded
// frame in memory until the palette was known.
// → [argv, …]
function ffmpegPasses({ format, list, out, palette, fps, totalMs, lastMs, loop = 0 }) {
  // `-safe 0`: safe mode refuses the per-file `option` directive. It exists to
  // stop a list naming paths outside its directory — and every line of this
  // list, names included, is written by ffconcat() above, never by a caller.
  const input = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', list];
  if (format === 'gif') {
    return [
      [...input, '-vf', 'palettegen=stats_mode=full', '-update', '1', palette],
      [...input, '-i', palette,
        '-lavfi', '[0:v][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
        '-loop', String(loop == null ? -1 : loop),
        '-final_delay', String(Math.max(1, Math.round(lastMs / 10))),
        '-f', 'gif', out],
    ];
  }
  if (!VIDEO_CODEC[format]) throw new EncodeError('bad-format', `ffmpeg cannot write '${format}' here`);
  // Constant frame rate (players handle it everywhere), cut at the replay's
  // own length — the repeated last list entry is only there to reach it.
  return [[...input, '-vf', `fps=${fps}`, ...VIDEO_CODEC[format],
    '-t', (totalMs / 1000).toFixed(3), '-f', format, out]];
}

function lastLine(s) {
  const lines = String(s).trim().split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : '';
}

// Run ffmpeg once. Resolves on exit 0; rejects with EncodeError 'ffmpeg-failed'
// (its last line of stderr) or 'timeout' (after a SIGKILL).
function runFfmpeg(ffmpegPath, args, { timeoutMs = 120000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnImpl(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      reject(new EncodeError('ffmpeg-failed', `could not start ${ffmpegPath}: ${e.message}`));
      return;
    }
    let errTail = '';
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      done(reject, new EncodeError('timeout', `ffmpeg did not finish within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    if (proc.stderr) proc.stderr.on('data', (d) => { errTail = (errTail + d.toString('utf8')).slice(-STDERR_KEEP); });
    proc.once('error', (e) => done(reject, new EncodeError('ffmpeg-failed', `could not start ${ffmpegPath}: ${e.message}`)));
    proc.once('close', (code, signal) => {
      if (code === 0) return done(resolve);
      const why = lastLine(errTail);
      return done(reject, new EncodeError('ffmpeg-failed',
        `ffmpeg exited (${signal || `code ${code}`})${why ? `: ${why}` : ''}`));
    });
  });
}

function checkSize(size, width, height) {
  if (size.width !== width || size.height !== height) {
    throw new EncodeError('bad-frame', `a ${size.width}x${size.height} frame arrived; ${width}x${height} was asked for`);
  }
}

// The built-in GIF path: decode each PNG and stream it into lib/core/gif.
function builtinSink({ width, height, loop }) {
  const enc = createGifEncoder({ width, height, loop });
  return {
    addFrame(png, delay) {
      const img = decodePng(png);
      checkSize(img, width, height);
      enc.addFrame(img.data, delay);
    },
    finish() { return enc.finish(); },
    get frames() { return enc.frames; },
  };
}

// createFrameEncoder({ format, ffmpegPath, width, height, fps, loop, tmpDir, spawnImpl })
// Throws EncodeError 'ffmpeg-not-found' for a video format with no ffmpeg.
function createFrameEncoder({
  format, ffmpegPath = null, width, height, fps = 10, loop = 0, tmpDir, spawnImpl,
}) {
  const kind = pickEncoder(format, ffmpegPath);
  if (!kind) {
    if (VIDEO_FORMATS.includes(format)) throw new EncodeError('ffmpeg-not-found', `format '${format}' needs ffmpeg, and none was found`);
    throw new EncodeError('bad-format', `unknown format '${format}'`);
  }

  if (kind === 'builtin') {
    const sink = builtinSink({ width, height, loop });
    return {
      encoder: 'builtin',
      addFrame: (png, delay) => sink.addFrame(png, delay),
      async finish() { return { data: sink.finish(), frames: sink.frames, encoder: 'builtin' }; },
      dispose() {},
    };
  }

  fs.mkdirSync(tmpDir, { recursive: true });
  const dir = path.join(tmpDir, `frames-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  const frames = [];   // [{ file, delay, png }] — png only for the identical-frame check
  let last = null;

  return {
    encoder: 'ffmpeg',
    addFrame(png, delay) {
      checkSize(pngSize(png), width, height);
      if (last && last.png.equals(png)) { last.delay += delay; return; }
      const file = `f${String(frames.length).padStart(5, '0')}.png`;
      fs.writeFileSync(path.join(dir, file), png);
      if (last) last.png = null;
      last = { file, delay, png };
      frames.push(last);
    },
    async finish({ timeoutMs = 120000 } = {}) {
      if (!frames.length) throw new EncodeError('no-frames', 'nothing was captured to encode');
      const totalMs = frames.reduce((a, f) => a + f.delay, 0);
      const list = path.join(dir, 'frames.ffconcat');
      fs.writeFileSync(list, ffconcat(frames, { repeatLast: format !== 'gif' }));
      const out = path.join(dir, `out.${format}`);
      const passes = ffmpegPasses({
        format, list, out, palette: path.join(dir, 'palette.png'),
        fps, totalMs, lastMs: frames[frames.length - 1].delay, loop,
      });
      const deadline = Date.now() + timeoutMs;
      try {
        for (const args of passes) {
          await runFfmpeg(ffmpegPath, args, { timeoutMs: Math.max(1000, deadline - Date.now()), spawnImpl });
        }
        const data = fs.readFileSync(out);
        if (!data.length) throw new EncodeError('ffmpeg-failed', 'ffmpeg wrote an empty file');
        return { data, frames: frames.length, encoder: 'ffmpeg' };
      } catch (e) {
        // A GIF is still possible without ffmpeg: re-encode what is on disk.
        if (format !== 'gif' || e.code !== 'ffmpeg-failed') throw e;
        const sink = builtinSink({ width, height, loop });
        for (const f of frames) sink.addFrame(fs.readFileSync(path.join(dir, f.file)), f.delay);
        return { data: sink.finish(), frames: sink.frames, encoder: 'builtin', fallback: e.message };
      }
    },
    dispose() {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
    },
  };
}

module.exports = {
  createFrameEncoder, pickEncoder, ffconcat, ffmpegPasses, runFfmpeg,
  EncodeError, FORMATS, VIDEO_FORMATS,
};
