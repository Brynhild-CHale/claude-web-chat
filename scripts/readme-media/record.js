#!/usr/bin/env node
// Re-record the README's replay clips from this checkout.
//
//   node scripts/readme-media/record.js [flow] [replay] [--out <dir>] [--keep]
//
// Boots this checkout's daemon IN-PROCESS on a throwaway project with a
// throwaway HOME (so nothing reaches ~/.web-chat or a daemon already running),
// drives the demo story (story.js) through the HTTP API, then records:
//
//   flow    flow.gif — the product's own scripted replay render
//           (POST /api/replay/render, story.FLOW), 960×600. NOT the README's
//           flow.gif, which is the original screen recording (2026-10-02).
//   replay  .github/media/replay.gif — the live chrome, 1280×800 at 0.75 scale,
//           while Claude opens a directed replay in it (POST /api/replay/open,
//           story.REPLAY)
//
// Needs a Chrome-family browser (WEB_CHAT_CHROME to pick one) and, for a small
// GIF, ffmpeg (WEB_CHAT_FFMPEG). With no clip named it records both. Output
// goes to --out (default: a fresh temp dir, printed). To replace the README's
// replay clip, record only it: `replay --out .github/media` — never `flow` into
// .github/media. See README.md beside this file.

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flagValue = (name) => { const i = args.indexOf(name); return i === -1 ? null : args.splice(i, 2)[1]; };
const outArg = flagValue('--out');
const keep = args.includes('--keep');
const CLIPS = ['flow', 'replay'];
const wanted = args.filter((a) => !a.startsWith('--'));
for (const c of wanted) if (!CLIPS.includes(c)) { console.error(`unknown clip "${c}" — one of: ${CLIPS.join(', ')}`); process.exit(2); }
const clips = wanted.length ? wanted : CLIPS;

// The sandbox comes FIRST — before anything under lib/ is required — so every
// user-tier path the daemon resolves lands in the scratch HOME.
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-readme-media-')));
const HOME = path.join(work, 'home');
const ROOT = path.join(work, 'orders-api');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(path.join(ROOT, '.web-chat'), { recursive: true });
process.env.HOME = HOME;
delete process.env.WEB_CHAT_PORT;

const WebSocket = require('ws');
const { createServer } = require('../../lib/server');
const { LOOPBACK } = require('../../lib/core/cors');
const client = require('../../lib/client');
const { closeAllBrowsers } = require('../../lib/replay/chrome');
const story = require('./story');
const { openPage, recordClip, sleep } = require('./browser');

const OUT = path.resolve(outArg || path.join(work, 'out'));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = createServer({ root: ROOT, port: 0 });
  await new Promise((resolve, reject) => {
    srv.server.once('error', reject);
    srv.server.listen(0, LOOPBACK, resolve);
  });
  const port = srv.server.address().port;
  const base = `http://${LOOPBACK}:${port}`;
  const opts = { port, noSpawn: true };
  const post = async (p, body) => {
    const r = await client.post(p, body || {}, opts);
    if (r && r.ok === false) throw new Error(`${p} refused: ${JSON.stringify(r)}`);
    return r;
  };

  // A viewer for the whole run: the story's "user" writes go over it.
  const ws = new WebSocket(`ws://${LOOPBACK}:${port}/ws`, { headers: { origin: base } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const send = (frame) => ws.send(JSON.stringify(frame));

  try {
    await story.drive({ post, send, sleep });
    const g = await client.get('/api/graph', opts);
    console.log('graph:', g.nodes.map((n) => `${n.label}${n.bookmarked ? '★' : ''}${n.folded_count ? `+${n.folded_count}` : ''}`).join(' '));

    for (const clip of clips) {
      const file = path.join(OUT, `${clip}.gif`);
      if (clip === 'flow') {
        const r = await post('/api/replay/render', story.FLOW);
        fs.copyFileSync(r.path, file);
        console.log(`flow    ${file}  ${r.width}x${r.height}  ${r.frames} frames  ${(r.bytes / 1024).toFixed(0)} KB  (${r.encoder})`);
      } else if (clip === 'replay') {
        const W = 1280;
        const H = 800;
        const SCALE = 0.75;
        const page = await openPage({ url: `${base}/`, width: W, height: H, scale: SCALE, tmpDir: work });
        try {
          await sleep(1500); // the chrome's first paint + the theme swap
          const hold = story.REPLAY.steps.reduce((t, s) => t + s.hold_ms, 0);
          const r = await recordClip(page, async () => {
            await sleep(1200);
            await post('/api/replay/open', { script: story.REPLAY });
            await sleep(hold + 2000);
          }, { width: Math.round(W * SCALE), height: Math.round(H * SCALE), tmpDir: work });
          fs.writeFileSync(file, r.data);
          console.log(`replay  ${file}  ${Math.round(W * SCALE)}x${Math.round(H * SCALE)}  ${r.frames} frames of ${r.captured}  ${(r.data.length / 1024).toFixed(0)} KB  (${r.encoder})`);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    ws.terminate();
    await closeAllBrowsers();
    await Promise.race([srv.stop().catch(() => {}), sleep(5000)]);
    // The scratch project, HOME and browser profiles go; the output stays (it
    // is inside `work` when no --out was given).
    if (!keep && OUT.startsWith(work + path.sep)) {
      for (const e of fs.readdirSync(work)) if (path.join(work, e) !== OUT) fs.rmSync(path.join(work, e), { recursive: true, force: true });
    } else if (!keep) {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  console.log(`out: ${OUT}${keep ? `\nwork: ${work}` : ''}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
