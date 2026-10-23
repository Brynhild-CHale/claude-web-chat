'use strict';
// Chrome-type residuals from wave 10 (U328e; DECISIONS.md K.2-80): the box
// grab of a SCROLLED content box. A rows-capped pane's `.mount-host` scrolls
// (overflow auto); the live chrome measures the rect over what is scrolled
// into view, so it sends the box's own scroll `{top, left}` beside `box`
// (public/app/box-grab.js measureGrab), the daemon keeps it in the page anchor
// and hands it on (lib/server/box-grab.js), and captureClip sets it as the
// export's content box's own scrollTop / scrollLeft before the clip
// (lib/replay/chrome.js) — never folded into the clip, which would clip
// outside the box.
//
// Pinned here:
//   - in the document captureClip is handed, a rows-capped pane's content box
//     is a scroll container of a fixed height (the export's has-rows rule and
//     its `.mount-host` overflow, read through test-support/css-cascade), so
//     the scroll the chrome measured has somewhere to land;
//   - opt-in (WEB_CHAT_E2E_CHROME=1, skipped otherwise): a real Chrome draws
//     the grab of a rows-capped pane scrolled 200 px, and the clip lands on the
//     element the chrome measured — a band of solid colour, compared by its
//     pixels, the bands either side of it where the measure put them; and
//     (U328f, K.2-85) scrolled into the last header-height of the live range,
//     which lands only because the export's content box is pinned at the live
//     box's height as well as its width.
// The chrome's half is pinned in test/box-grab-chrome.test.js (scroll beside
// box), the seam's in test/box-grab.test.js (captureImpl handed it,
// captureClip's page script setting it before the clip); K.2-79's highlight
// and section-card cases in test/highlight-chrome.test.js and
// test/orphans.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { withServer, waitUntil, e2eGate } = require('../test-support/helpers');
const { createCascade } = require('../test-support/css-cascade');
const { decodePng } = require('../lib/core/png');
const { setSeams } = require('../lib/server/box-grab');
const { liveBrowsers } = require('../lib/replay/chrome');

const VIEWPORT = { w: 1024, h: 768 };
// Ten solid bands, 100 px each, one colour apiece.
const BANDS = [[255, 0, 0], [0, 160, 0], [0, 0, 255], [255, 200, 0], [200, 0, 200],
  [0, 200, 200], [120, 60, 0], [0, 0, 0], [128, 128, 128], [255, 128, 128]];
const BAND_PX = 100;
const PAD = 12;           // the export's (and the live chrome's) .mount-host padding
const ROWS = 6;           // 6 × 40 + 5 × 14 = 310 px tall: the content scrolls
const PANE_HTML = BANDS.map(([r, g, b], i) => `<div class="band" id="b${i}" style="height:${BAND_PX}px;background:rgb(${r},${g},${b})"></div>`).join('');

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
const captureOf = (srv, id) => srv.state.captures.find((c) => c.id === id);
async function settled(srv, capture) {
  await waitUntil(() => { const c = captureOf(srv, capture); return c && c.image && c.image.state !== 'pending'; },
    { timeout: 40000, what: `${capture}'s image to settle` });
  return captureOf(srv, capture).image;
}
// The body the chrome posts (measureGrab's shape): rect relative to the
// item's content box, box that box's size, scroll its own scroll offset.
function grabBody({ item, mount, rect, box, scroll }) {
  return {
    type: 'box-grab', device: 'desktop',
    anchor: { v: 1, kind: 'page', item, mount, rect, box, scroll, viewport: VIEWPORT },
    payload: { shared: true, rect: { ...rect, item, viewport: VIEWPORT }, box, scroll, meta: { mode: 'light', viewport: VIEWPORT } },
  };
}

test('the document captureClip is handed: a rows-capped pane\'s content box is a scroll container of a fixed height, and the scroll rides beside it', async (t) => {
  const { api, srv } = await withServer(t);
  const calls = [];
  setSeams(srv.state, {
    findChrome: () => '/fake/chrome',
    captureImpl: async (opts) => { calls.push(opts); throw new Error('recorded, not drawn'); },
  });
  await ok(api.post('/api/render', { id: 'm1', html: PANE_HTML, place: { rows: ROWS } }), 'render m1');
  const scroll = { top: 200, left: 0 };
  const g = (await ok(api.post('/api/elements', grabBody({ item: 'm1', mount: 'm1', rect: { x: 12, y: 2, w: 100, h: 120 }, box: { w: 600, h: 280 }, scroll })), 'POST')).element;
  await settled(srv, g.grab.capture);
  const call = calls.at(-1);
  assert.deepEqual(call.scroll, scroll, 'captureClip is handed the scroll');
  assert.deepEqual(call.clip, { x: 12, y: 2, w: 100, h: 120 }, 'and the clip as measured');
  const dom = new JSDOM(call.html, { runScripts: 'dangerously' });   // the export's shell builds its panes
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const host = doc.querySelector(call.selector);
  assert.ok(host && host.classList.contains('mount-host'), 'the content box');
  const pane = host.parentElement;
  assert.ok(pane.classList.contains('has-rows'), 'the pane keeps its rows in the export');
  const css = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n');
  const atViewport = { matchMedia: (q) => ({ matches: [...String(q).matchAll(/max-width:\s*(\d+)px/g)].every((m) => VIEWPORT.w <= Number(m[1])) && /max-width/.test(q) }) };
  const cascade = createCascade(css, { win: atViewport });
  assert.equal(cascade.value(host, 'overflow'), 'auto', 'the content box scrolls');
  assert.match(String(cascade.value(pane, 'height')), /calc\(var\(--rows/, 'the pane is exactly its rows tall');
});

// ── opt-in: a real Chrome ───────────────────────────────────────────────────

const e2e = e2eGate(['chrome']);
test('a real Chrome: a rows-capped pane scrolled 200 px — the clip lands on the element the chrome measured', { skip: e2e.skip }, async (t) => {
  const { api, srv, root } = await withServer(t);
  setSeams(srv.state, { findChrome: () => e2e.chrome });
  await ok(api.post('/api/render', { id: 'm1', html: PANE_HTML, place: { rows: ROWS } }), 'render');
  // The live chrome's measure with the content box scrolled 200 px: band i's
  // top sits at PAD + i × 100 − 200 in the box's frame, so band 2 spans
  // 12..112. The clip starts 10 px above it and ends 10 px below it.
  const scroll = { top: 200, left: 0 };
  const top = PAD + 2 * BAND_PX - scroll.top;
  const rect = { x: PAD, y: top - 10, w: 100, h: BAND_PX + 20 };
  const g = (await ok(api.post('/api/elements', grabBody({ item: 'm1', mount: 'm1', rect, box: { w: 600, h: 280 }, scroll })), 'POST')).element;
  const image = await settled(srv, g.grab.capture);
  assert.equal(image.state, 'ready', JSON.stringify(image));
  const png = decodePng(fs.readFileSync(path.join(root, '.web-chat', 'captures', `${g.grab.capture}.png`)));
  assert.deepEqual([png.width, png.height], [rect.w, rect.h], 'the clip is the rect\'s size');
  const near = (x, y, [r, gg, b]) => {
    const i = (y * png.width + x) * 4;
    return Math.abs(png.data[i] - r) < 20 && Math.abs(png.data[i + 1] - gg) < 20 && Math.abs(png.data[i + 2] - b) < 20;
  };
  const rows = (y0, y1, want, what) => {
    for (let y = y0; y < y1; y++) for (let x = 0; x < rect.w; x++) {
      if (!near(x, y, want)) return `${what}: (${x}, ${y}) is not rgb(${want.join(', ')})`;
    }
    return null;
  };
  assert.equal(rows(0, 10, BANDS[1], 'above'), null, 'the 10 rows above are band 1, as the chrome saw them');
  assert.equal(rows(10, 10 + BAND_PX, BANDS[2], 'the element'), null, 'band 2, where the chrome measured it — not band 0 (unscrolled)');
  assert.equal(rows(10 + BAND_PX, rect.h, BANDS[3], 'below'), null, 'the 10 rows below are band 3');
  assert.equal(liveBrowsers(), 0);
});

// K.2-85 (U328f): the export's content box is pinned at the live box's HEIGHT
// too. Unpinned, the export's rows-capped `.mount-host` is about a header
// taller than the live one (the export shell lays no header inside the rows
// height), so its scroll range is that much shorter and a scroll in the last
// stretch of the live range clamps — the clip lands up to a header too high.
// Scrolled to (content height − live box h) − 5 px, band 8 sits at 73..173 in
// the live box's frame; the clip takes it with 10 px of bands 7 and 9 around.
test('a real Chrome: a rows-capped pane scrolled into the last header-height of its range — the clip lands on the measured band, and nothing clamped', { skip: e2e.skip }, async (t) => {
  const { api, srv, root } = await withServer(t);
  setSeams(srv.state, { findChrome: () => e2e.chrome });
  await ok(api.post('/api/render', { id: 'm1', html: PANE_HTML, place: { rows: ROWS } }), 'render');
  const box = { w: 600, h: 280 };                       // the live content box under a 6-row cap
  const contentH = BANDS.length * BAND_PX + 2 * PAD;    // 1024: the bands and the box's padding
  const scroll = { top: contentH - box.h - 5, left: 0 };  // 739: inside the live range, past the unpinned export's
  const band = 8;
  const top = PAD + band * BAND_PX - scroll.top;        // 73
  const rect = { x: PAD, y: top - 10, w: 100, h: BAND_PX + 20 };
  const g = (await ok(api.post('/api/elements', grabBody({ item: 'm1', mount: 'm1', rect, box, scroll })), 'POST')).element;
  const image = await settled(srv, g.grab.capture);
  assert.equal(image.state, 'ready', JSON.stringify(image));
  assert.equal(image.scroll_clamped, undefined, `the browser applied the measured scroll: ${JSON.stringify(image.scroll_clamped)}`);
  const png = decodePng(fs.readFileSync(path.join(root, '.web-chat', 'captures', `${g.grab.capture}.png`)));
  assert.deepEqual([png.width, png.height], [rect.w, rect.h], 'the clip is the rect\'s size');
  const near = (x, y, [r, gg, b]) => {
    const i = (y * png.width + x) * 4;
    return Math.abs(png.data[i] - r) < 20 && Math.abs(png.data[i + 1] - gg) < 20 && Math.abs(png.data[i + 2] - b) < 20;
  };
  const rows = (y0, y1, want, what) => {
    for (let y = y0; y < y1; y++) for (let x = 0; x < rect.w; x++) {
      if (!near(x, y, want)) return `${what}: (${x}, ${y}) is not rgb(${want.join(', ')})`;
    }
    return null;
  };
  assert.equal(rows(0, 10, BANDS[band - 1], 'above'), null, 'the 10 rows above are band 7, as the chrome saw them');
  assert.equal(rows(10, 10 + BAND_PX, BANDS[band], 'the element'), null, 'band 8, where the chrome measured it — not shifted by a clamp');
  assert.equal(rows(10 + BAND_PX, rect.h, BANDS[band + 1], 'below'), null, 'the 10 rows below are band 9');
  assert.equal(liveBrowsers(), 0);
});
