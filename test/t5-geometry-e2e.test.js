// Tranche 5's real-browser geometry check (design spec §11.8's last clause,
// §10.1, §8.2): jsdom cannot lay out, so the numbers the pull's stops come from
// (sheet-model.js computeStops) are checked here against a REAL Chrome laying
// out the real chrome a real daemon serves, at two phone sizes (390×844 and an
// iPhone SE's 375×667), emulated as mobile:
//
//   * closed, #chat-pull's bottom sits on #bottombar's top;
//   * at full, #chat-tab's top sits on #topbar's bottom (full = avail − 22: the
//     23px tab flush under the topbar);
//   * at half, the pull is computeStops(avail).half tall, avail being
//     round(#bottombar top − #topbar bottom) as laid out; and the sheet's own
//     measure agrees with it.
// Each within 1px. Reduced motion is emulated, so no height transition is
// mid-flight when a rectangle is read.
//
// OPT-IN: it SKIPS unless WEB_CHAT_E2E_CHROME=1 (and a Chrome is found, or
// WEB_CHAT_CHROME names one). CI never sets it, and no build seat runs it: it
// is the maintainer's —
//   WEB_CHAT_E2E_CHROME=1 node --test --test-timeout=60000 \
//     --import ./test-support/sandbox.js test/t5-geometry-e2e.test.js
//
// The page is driven only through Runtime.evaluate: the same-origin module
// URLs (/app/chat-sheet.js, /app/sheet-model.js) are the instances main.js
// loaded, so setStop() moves the real sheet.
const test = require('node:test');
const assert = require('node:assert');

const { withServer, e2eGate, waitUntil } = require('../test-support/helpers');
const { launchChrome, closeAllBrowsers, liveBrowsers } = require('../lib/replay/chrome');

const e2e = e2eGate(['chrome']);
const SIZES = [{ width: 390, height: 844 }, { width: 375, height: 667 }];
const PX = 1;   // the tolerance, in CSS px

test.after(async () => {
  const up = liveBrowsers();
  await closeAllBrowsers();
  assert.equal(up, 0, `${up} browser(s) were still up when the file finished`);
});

// ── CDP ─────────────────────────────────────────────────────────────────────

async function openTab(cdp, { width, height }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true }, sessionId);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
  return sessionId;
}
async function navigate(cdp, sid, url) {
  const loaded = cdp.once('Page.loadEventFired', { sessionId: sid });
  const nav = await cdp.send('Page.navigate', { url }, sid);
  if (nav.errorText) throw new Error(`could not load ${url}: ${nav.errorText}`);
  await loaded;
}
async function evaluate(cdp, sid, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`evaluate failed: ${(d.exception && d.exception.description) || d.text}`);
  }
  return r.result ? r.result.value : undefined;
}

// In the page: the rectangles that matter, after two frames (so a setStop has
// been laid out), with the sheet's own state and computeStops over the laid-out
// avail.
const MEASURE = `(async () => {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const S = await import('/app/chat-sheet.js');
  const M = await import('/app/sheet-model.js');
  const rect = (id) => { const b = document.getElementById(id).getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, height: b.height, left: b.left, right: b.right }; };
  const topbar = rect('topbar');
  const bottombar = rect('bottombar');
  const avail = Math.round(bottombar.top - topbar.bottom);
  const st = S.sheetState();
  return { topbar, bottombar, pull: rect('chat-pull'), tab: rect('chat-tab'), avail,
    model: M.computeStops(avail), sheet: { open: st.open, stop: st.stop, h: st.h, stops: st.stops } };
})()`;
const SET = (what) => `(async () => {
  const S = await import('/app/chat-sheet.js');
  ${what}
  return S.sheetState().stop;
})()`;

for (const size of SIZES) {
  test(`real Chrome at ${size.width}×${size.height} (mobile): the pull on the bottom bar, full flush under the topbar, half = computeStops(avail).half`,
    { skip: e2e.skip, timeout: 60000 }, async (t) => {
      // The browser's close is registered BEFORE withServer's teardown (t.after
      // hooks run in the order they were added), so Chrome exits before the
      // daemon stops and the root holding its profile directory is removed.
      let browser = null;
      t.after(() => (browser ? browser.close() : undefined));
      const { port, root } = await withServer(t);
      browser = launchChrome({ chromePath: e2e.chrome, tmpDir: root });
      const { cdp } = browser;
      const sid = await openTab(cdp, size);
      await navigate(cdp, sid, `http://127.0.0.1:${port}/`);
      await waitUntil(() => evaluate(cdp, sid, `(async () => {
        const p = document.getElementById('chat-pull');
        if (!p || !p.classList.contains('chat-pull')) return false;
        const S = await import('/app/chat-sheet.js');
        return S.sheetState().stops.full > 0 && document.getElementById('bottombar').getBoundingClientRect().height > 0;
      })()`), { what: 'the pull stamped and measured', timeout: 15000, interval: 100 });

      // Closed: the pull rides the bottom bar's top edge.
      const closed = await evaluate(cdp, sid, MEASURE);
      t.diagnostic(`closed: ${JSON.stringify(closed)}`);
      assert.equal(closed.sheet.open, false);
      assert.ok(Math.abs(closed.pull.bottom - closed.bottombar.top) <= PX,
        `#chat-pull's bottom ${closed.pull.bottom} on #bottombar's top ${closed.bottombar.top}`);
      assert.deepEqual(closed.sheet.stops, closed.model, 'the sheet measured the avail the layout gives');

      // Full: the tab's top on the topbar's bottom.
      assert.equal(await evaluate(cdp, sid, SET('S.openSheet(); S.setStop(S.sheetState().stops.full);')), 'full');
      const full = await evaluate(cdp, sid, MEASURE);
      t.diagnostic(`full: ${JSON.stringify(full)}`);
      assert.equal(full.sheet.h, full.model.full);
      assert.ok(Math.abs(full.tab.top - full.topbar.bottom) <= PX,
        `#chat-tab's top ${full.tab.top} on #topbar's bottom ${full.topbar.bottom}`);
      assert.ok(Math.abs(full.pull.bottom - full.bottombar.top) <= PX, 'the open pull still on the bottom bar');

      // Half, where the size has one (§8.2: dropped when full − half < 96).
      if (full.model.half !== null) {
        assert.equal(await evaluate(cdp, sid, SET('S.setStop(S.sheetState().stops.half);')), 'half');
        const half = await evaluate(cdp, sid, MEASURE);
        t.diagnostic(`half: ${JSON.stringify(half)}`);
        assert.ok(Math.abs(half.pull.height - half.model.half) <= PX,
          `#chat-pull ${half.pull.height}px tall at half; computeStops(${half.avail}).half is ${half.model.half}`);
        assert.ok(Math.abs(half.pull.bottom - half.bottombar.top) <= PX);
      } else {
        t.diagnostic(`avail ${full.avail}: no half stop (computeStops drops it)`);
      }
      await evaluate(cdp, sid, SET('S.closeSheet({ returnFocus: false });'));
    });
}
