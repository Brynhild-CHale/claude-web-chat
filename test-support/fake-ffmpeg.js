#!/usr/bin/env node
// A stand-in for the `ffmpeg` binary, for test/replay-encode.test.js.
//
// lib/replay/encode.js shells out to the real thing, so the honest test of that
// path is a real process on PATH (or WEB_CHAT_FFMPEG) that the real spawn
// reaches — the pattern of test-support/fake-gh.js. It records every
// invocation's argv to FAKE_FFMPEG_CALLS, plus — because the frame directory is
// gone by the time a test looks — the ffconcat list it was handed and whether
// each image the list names was really a PNG on disk.
//
// It writes its last argument (the output) with FAKE:<basename>, so a test can
// prove the daemon's file is ffmpeg's bytes and not the built-in encoder's.
//
//   FAKE_FFMPEG_MODE  'ok' (default) | 'fail' (exit 1 naming a missing encoder)
//                     | 'hang' (never exit)

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const MODE = process.env.FAKE_FFMPEG_MODE || 'ok';
const rec = { argv };
const at = argv.indexOf('concat');
const li = at >= 0 ? argv.indexOf('-i', at) : -1;
if (li >= 0) {
  const list = argv[li + 1];
  try {
    rec.list = fs.readFileSync(list, 'utf8');
    rec.images = [...rec.list.matchAll(/^file '([^']+)'$/gm)].map((m) => {
      const file = path.join(path.dirname(list), m[1]);
      let png = false;
      try { png = fs.readFileSync(file).subarray(1, 4).toString('latin1') === 'PNG'; } catch { /* absent */ }
      return { name: m[1], png };
    });
  } catch (e) { rec.listError = e.message; }
}
if (process.env.FAKE_FFMPEG_CALLS) fs.appendFileSync(process.env.FAKE_FFMPEG_CALLS, JSON.stringify(rec) + '\n');

if (MODE === 'hang') setInterval(() => {}, 1000);
else if (MODE === 'fail') {
  process.stderr.write("[vost#0:0 @ 0x1] Unknown encoder 'libx264'\nError selecting an encoder\n");
  process.exit(1);
} else {
  const out = argv[argv.length - 1];
  fs.writeFileSync(out, `FAKE:${path.basename(out)}`);
  process.exit(0);
}
