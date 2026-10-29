'use strict';
// The box grab's content box at the live HEIGHT, and a clamped scroll on the
// capture (U328f; DECISIONS.md K.2-85).
//
// The frame of reference is the live content box in BOTH dimensions (K.2-72):
// the export's shell lays a rows-capped pane's header out inside the rows
// height where the live chrome caps the whole pane, so the export's
// `.mount-host` is about a header taller and its scroll range that much
// shorter. lib/server/box-grab.js boxStyle pins the content box at the sent
// box.h as well as box.w, so the scroll the chrome measured (K.2-80) lands;
// and when the browser still applies a different scroll (more than 1 px on
// either axis), the capture's image record carries `scroll_clamped` (the
// APPLIED {top, left}) and inspect_capture says how far short it fell.
//
// Pinned here: the three height rules in the injected style with box.h, none
// without a box (a pane and a markdown item); a clamped scroll recorded and
// named by inspect_capture; an applied scroll equal to the asked one records
// nothing. The real-Chrome case is test/chrome-type-residuals-w10.test.js's
// opt-in e2e.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { withServer, waitUntil } = require('../test-support/helpers');
const { encodePng, solid } = require('../test-support/png-encode');
const { setSeams, contentSelector } = require('../lib/server/box-grab');

// Never a real Chrome here: every render goes through the captureImpl seam.
process.env.WEB_CHAT_CHROME = '/nonexistent/web-chat-test/chrome';

const MCP_BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');
const VIEWPORT = { w: 1024, h: 700 };

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
const captureOf = (srv, id) => srv.state.captures.find((c) => c.id === id);
async function settled(srv, capture) {
  await waitUntil(() => { const c = captureOf(srv, capture); return c && c.image && c.image.state !== 'pending'; },
    { timeout: 10000, what: `${capture}'s image to settle` });
  return captureOf(srv, capture).image;
}
// The body the chrome posts (measureGrab's shape); box and scroll only when given.
function grabBody({ item, mount = item, box, scroll }) {
  const rect = { x: 4, y: 6, w: 32, h: 20 };
  return {
    type: 'box-grab', device: 'desktop',
    anchor: { v: 1, kind: 'page', item, mount, rect, ...(box ? { box } : {}), ...(scroll ? { scroll } : {}), viewport: VIEWPORT },
    payload: { rect: { ...rect, item, viewport: VIEWPORT }, meta: { mode: 'light', viewport: VIEWPORT } },
  };
}
const postGrab = async (api, body) => (await ok(api.post('/api/elements', grabBody(body)), 'POST box grab')).element;
// A captureImpl that draws a solid clip and reports `applied(opts)` as the scroll the browser set.
function seam(calls, applied = (opts) => opts.scroll) {
  return async (opts) => {
    calls.push(opts);
    return { png: encodePng(solid(opts.clip.w, opts.clip.h, [10, 120, 200]), opts.clip.w, opts.clip.h, { alpha: false }), scroll: applied(opts) };
  };
}
const head = (html) => html.slice(0, html.indexOf('</head>'));
const ruleFor = (html, selector) => {
  const h = head(html);
  const at = h.indexOf(`${selector} {`);
  return at < 0 ? null : h.slice(at, h.indexOf('}', at) + 1);
};
const HEIGHT_RULES = (h) => [`height: ${h}px !important;`, `min-height: ${h}px !important;`, `max-height: ${h}px !important;`];

test('the box style pins the content box at the sent height as well as its width (K.2-85); no box, no style — a pane and a markdown item', async (t) => {
  const { api, srv } = await withServer(t);
  const calls = [];
  setSeams(srv.state, { findChrome: () => '/fake/chrome', captureImpl: seam(calls) });
  await ok(api.post('/api/render', { id: 'm1', html: '<p>Hello</p>', place: { rows: 6 } }), 'render');
  await ok(api.post('/api/markdown', { id: 'md-g', text: '## Notes\n\nA short line.' }), 'markdown');

  // A pane with a box: the content box carries the width rules AND the height rules.
  const pane = await postGrab(api, { item: 'm1', box: { w: 600, h: 280.5 } });
  await settled(srv, pane.grab.capture);
  const paneRule = ruleFor(calls.at(-1).html, contentSelector('m1', true));
  assert.ok(paneRule, 'the content box has a rule in the head');
  assert.ok(paneRule.includes('width: 600px !important;'), paneRule);
  for (const r of HEIGHT_RULES(280.5)) assert.ok(paneRule.includes(r), `${r} in ${paneRule}`);
  assert.ok(!/overflow/.test(paneRule), 'the overflow is left as the built document has it');
  const wrapper = ruleFor(calls.at(-1).html, '[data-pane-id="m1"]');
  assert.ok(wrapper.includes('width: max-content !important;') && !/height/.test(wrapper), `the wrapper's rule is unchanged: ${wrapper}`);

  // A markdown item with a box: its block gets the same height rules.
  const md = await postGrab(api, { item: 'md-g', mount: null, box: { w: 600, h: 80 } });
  await settled(srv, md.grab.capture);
  const mdRule = ruleFor(calls.at(-1).html, contentSelector('md-g', false));
  assert.ok(mdRule && mdRule.includes('width: 600px !important;'), String(mdRule));
  for (const r of HEIGHT_RULES(80)) assert.ok(mdRule.includes(r), `${r} in ${mdRule}`);

  // No box (an older chrome): no style at all, for either.
  for (const item of ['m1', 'md-g']) {
    const bare = await postGrab(api, { item, mount: item === 'md-g' ? null : item });
    await settled(srv, bare.grab.capture);
    assert.ok(!calls.at(-1).html.includes('data-wc-grab'), `${item}: no style without a box`);
    assert.ok(!/max-height: [\d.]+px !important/.test(head(calls.at(-1).html)), `${item}: no height rule`);
  }
});

async function launchMcp(t, port) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-grab-h-mcp-'));
  fs.mkdirSync(path.join(cwd, '.web-chat'), { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-grab-h-home-'));
  // The child closes before cwd and home go (K.2-187): a removal racing the
  // child's own writes throws, and a throwing after hook skips every later one.
  let mcp = null;
  t.after(async () => { if (mcp) await mcp.close(); });
  t.after(() => { for (const d of [cwd, home]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [MCP_BIN], cwd,
    env: { ...process.env, WEB_CHAT_CHANNEL: '0', WEB_CHAT_PORT: String(port), HOME: home, USERPROFILE: home },
  });
  mcp = new Client({ name: 'box-grab-height-test', version: '0.0.0' });
  await mcp.connect(transport);
  return mcp;
}

test('a scroll the browser clamped is on the capture\'s image record as scroll_clamped (the applied values), and inspect_capture names how far short it fell', async (t) => {
  const { api, srv, port } = await withServer(t);
  const calls = [];
  setSeams(srv.state, { findChrome: () => '/fake/chrome', captureImpl: seam(calls, (o) => ({ top: o.scroll.top - 40, left: 0 })) });
  await ok(api.post('/api/render', { id: 'm1', html: '<p>Hello</p>', place: { rows: 6 } }), 'render');
  const requested = 739.25;
  const g = await postGrab(api, { item: 'm1', box: { w: 600, h: 280 }, scroll: { top: requested, left: 0 } });
  const image = await settled(srv, g.grab.capture);
  assert.equal(calls.at(-1).scroll.top, requested, 'the seam was asked for the measured scroll');
  assert.equal(image.state, 'ready', 'a clamp is never a failure');
  assert.deepEqual(image.scroll_clamped, { top: requested - 40, left: 0 });
  assert.deepEqual(calls.at(-1).clip, { x: 4, y: 6, w: 32, h: 20 }, 'the clip is unchanged');

  const mcp = await launchMcp(t, port);
  const res = await mcp.callTool({ name: 'inspect_capture', arguments: { capture_id: g.grab.capture } });
  assert.ok(!res.isError, JSON.stringify(res));
  assert.deepEqual(res.content.map((c) => c.type), ['text', 'image']);
  const text = res.content[0].text;
  assert.match(text, /the pane scrolled 40 px short of the chrome's measure/);
  assert.equal(text.match(/scrolled \d+(\.\d+)? px short/g).length, 1, 'one sentence');
});

test('a scroll applied as asked (within 1 px) records no scroll_clamped, and inspect_capture says nothing of it', async (t) => {
  const { api, srv, port } = await withServer(t);
  const calls = [];
  setSeams(srv.state, { findChrome: () => '/fake/chrome', captureImpl: seam(calls, (o) => ({ top: o.scroll.top - 0.5, left: o.scroll.left })) });
  await ok(api.post('/api/render', { id: 'm1', html: '<p>Hello</p>', place: { rows: 6 } }), 'render');
  const g = await postGrab(api, { item: 'm1', box: { w: 600, h: 280 }, scroll: { top: 200, left: 0 } });
  const image = await settled(srv, g.grab.capture);
  assert.equal(image.state, 'ready');
  assert.equal('scroll_clamped' in image, false);
  // A render that reports no scroll at all (an older captureClip): nothing either.
  setSeams(srv.state, { findChrome: () => '/fake/chrome', captureImpl: seam(calls, () => undefined) });
  const g2 = await postGrab(api, { item: 'm1', box: { w: 600, h: 280 }, scroll: { top: 200, left: 0 } });
  assert.equal('scroll_clamped' in (await settled(srv, g2.grab.capture)), false);

  const mcp = await launchMcp(t, port);
  const res = await mcp.callTool({ name: 'inspect_capture', arguments: { capture_id: g.grab.capture } });
  assert.ok(!res.isError, JSON.stringify(res));
  assert.ok(!/short of the chrome's measure/.test(res.content[0].text));
  assert.equal(JSON.parse(res.content[0].text).image.scroll_clamped, undefined);
});
