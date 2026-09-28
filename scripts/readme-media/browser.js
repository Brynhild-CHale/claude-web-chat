// A headless page over the product's own Chrome launcher (lib/replay/chrome:
// pipe transport, a throwaway profile, a bounded kill on close), plus a
// screen recorder that encodes through the replay encoder (lib/replay/encode).
// Dev-only: the README clips of the live chrome, which the replay renderer
// cannot draw (it draws nodes, not the app around them).

const { launchChrome } = require('../../lib/replay/chrome');
const { findChrome, findFfmpeg } = require('../../lib/replay/find');
const { createFrameEncoder } = require('../../lib/replay/encode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// → { evaluate(expr), shot() → PNG Buffer, close() }
async function openPage({ url, width, height, scale = 1, tmpDir, colorScheme = 'light' }) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('no Chrome found — set WEB_CHAT_CHROME to a Chrome/Chromium binary');
  const browser = launchChrome({ chromePath, tmpDir });
  try {
    const { cdp } = browser;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params || {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: colorScheme }] });
    await send('Page.enable');
    const loaded = cdp.once('Page.loadEventFired', { sessionId });
    await send('Page.navigate', { url });
    await loaded;
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
      return r.result && r.result.value;
    };
    const shot = async () => Buffer.from((await send('Page.captureScreenshot', { format: 'png', fromSurface: true })).data, 'base64');
    return { evaluate, shot, close: () => browser.close() };
  } catch (e) {
    await browser.close();
    throw e;
  }
}

// Screenshot `page` every ~`everyMs` while `act()` runs, then encode the
// frames as a GIF, each held until the next one's capture time (the last for
// `tailMs`). → { data: Buffer, frames, encoder, captured }
async function recordClip(page, act, { width, height, tmpDir, everyMs = 110, tailMs = 2500 }) {
  const frames = [];
  let recording = true;
  const loop = (async () => {
    while (recording) {
      const t = Date.now();
      frames.push({ t, png: await page.shot() });
      const spent = Date.now() - t;
      if (spent < everyMs) await sleep(everyMs - spent);
    }
  })();
  try {
    await act();
  } finally {
    recording = false;
    await loop;
  }
  const enc = createFrameEncoder({ format: 'gif', ffmpegPath: findFfmpeg(), width, height, fps: 10, loop: 0, tmpDir });
  try {
    for (let i = 0; i < frames.length; i++) {
      await enc.addFrame(frames[i].png, i + 1 < frames.length ? frames[i + 1].t - frames[i].t : tailMs);
    }
    const r = await enc.finish({ timeoutMs: 180000 });
    return { ...r, captured: frames.length };
  } finally {
    enc.dispose();
  }
}

module.exports = { openPage, recordClip, sleep };
