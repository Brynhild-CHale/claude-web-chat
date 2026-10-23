// The box grab's two halves reconciled (U328d; DECISIONS.md K.2-72): ONE
// frame of reference for the rect. The chrome (public/app/box-grab.js
// measureGrab) measures the drawn box from the item's CONTENT BOX — a pane's
// `.mount-host`, a markdown item's block — and sends that box's size beside
// the rect; the daemon (lib/server/box-grab.js) clips from the export's
// content box of the same item (contentSelector), in a document whose width
// style lays that box out at the sent width, so nothing reflows under the
// clip (lib/replay/chrome captureClip's `selector`).
//
// Pinned here:
//   - in the document the daemon hands captureClip (the export of the live
//     surface, its scripts run in jsdom), the content-box selector finds
//     exactly the item's content box — an untitled pane's `.mount-host`, a
//     titled pane's, a markdown block — and the injected style fixes that
//     box's width at the sent one (test-support/css-cascade reads the cascade);
//   - opt-in (WEB_CHAT_E2E_CHROME=1, skipped otherwise, like the export's): a
//     real Chrome draws an untitled pane's grab and the clip lands on the
//     element the chrome measured — its pixels compared against the element's
//     own render (a solid block), never a byte-equal PNG.
// The chrome's half (y = 35 from `.mount-host`, the box size) is pinned in
// test/box-grab-chrome.test.js; captureClip's arguments in test/box-grab.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { withServer, waitUntil, e2eGate } = require('../test-support/helpers');
const { createCascade } = require('../test-support/css-cascade');
const { decodePng } = require('../lib/core/png');
const { setSeams, contentSelector } = require('../lib/server/box-grab');
const { liveBrowsers } = require('../lib/replay/chrome');

const VIEWPORT = { w: 1024, h: 768 };

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
// item's content box, box that content box's size.
function grabBody({ item, mount, rect, box }) {
  return {
    type: 'box-grab', device: 'desktop',
    anchor: { v: 1, kind: 'page', item, mount, rect, box, viewport: VIEWPORT },
    payload: { shared: true, rect: { ...rect, item, viewport: VIEWPORT }, box, meta: { mode: 'light', viewport: VIEWPORT } },
  };
}

test('the document captureClip is handed: the content-box selector finds exactly the item\'s content box, and the width style fixes it at the sent width', async (t) => {
  const { api, srv } = await withServer(t);
  const calls = [];
  setSeams(srv.state, {
    findChrome: () => '/fake/chrome',
    captureImpl: async (opts) => { calls.push(opts); throw new Error('recorded, not drawn'); },
  });
  await ok(api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello <b>world</b></p>' }), 'render m1');
  await ok(api.post('/api/render', { id: 'm2', html: '<p>titled</p>', params: { title: 'A title' } }), 'render m2');
  await ok(api.post('/api/markdown', { id: 'md-g', text: '## Notes\n\nA short line.' }), 'markdown');
  const cases = [
    { item: 'm1', mount: 'm1', w: 612.5, what: 'an untitled pane' },
    { item: 'm2', mount: 'm2', w: 480, what: 'a titled pane' },
    { item: 'md-g', mount: null, w: 700, what: 'a markdown block' },
  ];
  for (const c of cases) {
    const g = (await ok(api.post('/api/elements', grabBody({ item: c.item, mount: c.mount, rect: { x: 2, y: 3, w: 40, h: 20 }, box: { w: c.w, h: 200 } })), `POST ${c.what}`)).element;
    await settled(srv, g.grab.capture);
    const call = calls.at(-1);
    assert.equal(call.selector, contentSelector(c.item, c.mount != null), c.what);
    const dom = new JSDOM(call.html, { runScripts: 'dangerously' });
    t.after(() => dom.window.close());
    const doc = dom.window.document;
    const found = [...doc.querySelectorAll(call.selector)];
    assert.equal(found.length, 1, `${c.what}: one element answers the selector`);
    const el = found[0];
    if (c.mount != null) {
      assert.ok(el.classList.contains('mount-host'), `${c.what}: the content box, never the wrapper`);
      assert.equal(el.parentElement.getAttribute('data-pane-id'), c.item);
      assert.equal(el.parentElement.querySelector('.pane-header'), null, 'the export has no header to measure from');
    } else {
      assert.ok(el.classList.contains('md-block'), `${c.what}: the block itself`);
    }
    const css = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    // jsdom has no matchMedia: the media queries are judged at the viewport
    // the grab is drawn at (only max-width ones appear in the export's sheets).
    const atViewport = { matchMedia: (q) => ({ matches: [...String(q).matchAll(/max-width:\s*(\d+)px/g)].every((m) => VIEWPORT.w <= Number(m[1])) && /max-width/.test(q) }) };
    const cascade = createCascade(css, { win: atViewport });
    assert.equal(cascade.value(el, 'width'), `${c.w}px`, `${c.what}: laid out at the sent width`);
    assert.equal(cascade.value(el, 'max-width'), `${c.w}px`);
  }
});

// ── opt-in: a real Chrome ───────────────────────────────────────────────────

const e2e = e2eGate(['chrome']);
test('a real Chrome: an untitled pane\'s clip lands on the element the chrome measured', { skip: e2e.skip }, async (t) => {
  const { api, srv, root } = await withServer(t);
  setSeams(srv.state, { findChrome: () => e2e.chrome });
  // The target: a solid red block 40 px below the content's top, half the
  // content's width — so its width depends on the content box's (a reflow
  // under the clip shows), and its top on the frame (a header-sized or
  // border-sized shift shows).
  await ok(api.post('/api/render', {
    id: 'm1',
    html: '<div style="height:40px"></div><div id="t" style="width:50%;height:30px;background:rgb(255,0,0)"></div><div style="height:200px"></div>',
  }), 'render');
  // The live chrome's measure at a 600 px content box: 12 px padding, so the
  // target sits at (12, 52), (600 - 24) / 2 = 288 wide. The clip starts 10 px
  // above it and ends 20 px past its right edge.
  const box = { w: 600, h: 300 };
  const target = { x: 12, y: 52, w: 288, h: 30 };
  const rect = { x: target.x, y: target.y - 10, w: target.w + 20, h: target.h + 10 };
  const g = (await ok(api.post('/api/elements', grabBody({ item: 'm1', mount: 'm1', rect, box })), 'POST')).element;
  const image = await settled(srv, g.grab.capture);
  assert.equal(image.state, 'ready', JSON.stringify(image));
  const png = decodePng(fs.readFileSync(path.join(root, '.web-chat', 'captures', `${g.grab.capture}.png`)));
  assert.deepEqual([png.width, png.height], [rect.w, rect.h], 'the clip is the rect\'s size');
  const red = (x, y) => {
    const i = (y * png.width + x) * 4;
    const [r, gg, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
    return r > 230 && gg < 30 && b < 30;
  };
  const rows = (y0, y1, x0, x1, want) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (red(x, y) !== want) return `(${x}, ${y}) is ${want ? 'not ' : ''}red`;
    }
    return null;
  };
  assert.equal(rows(0, 10, 0, rect.w, false), null, 'the 10 rows above the element are not the element');
  assert.equal(rows(10, rect.h, 0, target.w, true), null, 'the element\'s own render, where the chrome measured it');
  assert.equal(rows(10, rect.h, target.w, rect.w, false), null, 'the element ends where the chrome measured: no reflow under the clip');
  assert.equal(liveBrowsers(), 0);
});
