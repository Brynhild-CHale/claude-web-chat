// The control frame in a REAL Chrome (spec §15.5, §4.5 'The control frame'):
// a harness page on a loopback port — the "chrome", which the answer surface
// allows as its frame ancestor (mainPort) — frames the real control documents
// of the real answer surface (U55) served by the real control domain (U81),
// over a fake mirror, and dresses the frames the way a hostile pane could.
//
//   * stop: a trusted click (CDP Input.dispatchMouseEvent: the browser's own
//     input) after the dwell sends ONE interrupt, accepted — so it carried the
//     frame's nonce, which the gate checks; the frame reads 'Interrupting…'
//     until the mirror reports the conversation idle, then 'Interrupted', and
//     the harness receives ONE wc-answer:done {id, outcome: 'interrupted'}.
//   * confirm: the action button stays disabled, and a trusted click runs
//     nothing, in U56's clickjacking cases — the frame at opacity .5, an
//     element over the button, an element over only the summary, an ancestor
//     clip-path hiding the summary, an ancestor mask hiding it, an iframe
//     smaller than its content. Fully visible, after the dwell, a trusted
//     click runs the action once, and the done the harness receives carries
//     'restored' and counts — never the restore id.
//
// No Claude and no terminal: only a Chrome. OPT-IN: it SKIPS unless
// WEB_CHAT_E2E_CHROME=1 (and a Chrome is found, or WEB_CHAT_CHROME names one):
//   WEB_CHAT_E2E_CHROME=1 node --test --test-timeout=60000 \
//     --import ./test-support/sandbox.js test/answer-control-e2e.test.js
//
// The harness reads the frame's DOM through an isolated world of the frame's
// own context (Page.createIsolatedWorld): it sees the DOM, never the page's
// JS, and nothing it does is an input event.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');

const { e2eGate, tmpRoot, waitUntil } = require('../test-support/helpers');
const { launchChrome, closeAllBrowsers, liveBrowsers } = require('../lib/replay/chrome');
const { createAnswerSurface } = require('../lib/server/answer-surface');
const { createControl } = require('../lib/server/control');
const { createBus } = require('../lib/core/bus');

const e2e = e2eGate(['chrome']);
const W = 900;
const H = 700;
const S1 = '5f0e1d2c-3b4a-4958-8776-655443322110';

test.after(async () => {
  const up = liveBrowsers();
  await closeAllBrowsers();
  assert.equal(up, 0, `${up} browser(s) were still up when the file finished`);
});

// ── the fake mirror: one conversation, working ─────────────────────────────
function fakeMirror() {
  const subs = new Set();
  const m = {
    conversations: [{ id: 'c1', name: 'fix the flaky tests', current_session_id: S1, process: null, live: { state: 'working' } }],
    snapshot: () => ({ conversations: m.conversations }),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit(ev) { for (const fn of [...subs]) fn({ kind: 'mirror', ...ev }); },
    conversationOfPid: () => null,
  };
  return m;
}

// ── the harness: the "chrome" page that frames a control document ──────────
// /?src=<frame url>&frame=<css for the iframe>&wrap=<css for its parent>&over=<css for an overlay>
// It records every message a frame posts in window.__msgs.
function harness(t) {
  const page = (q) => {
    const src = String(q.get('src') || '');
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const over = q.get('over') ? `<div id="over" style="position:absolute;${esc(q.get('over'))}"></div>` : '';
    return `<!doctype html><html><body style="margin:0;background:#fff">
<script>window.__msgs = []; addEventListener('message', (e) => { window.__msgs.push({ origin: e.origin, data: e.data }); });</script>
<div id="wrap" style="position:absolute;left:20px;top:20px;${esc(q.get('wrap') || '')}">
<iframe id="f" src="${esc(src)}" referrerpolicy="no-referrer" allow="clipboard-write" style="display:block;border:0;width:420px;height:320px;${esc(q.get('frame') || '')}"></iframe>
</div>${over}</body></html>`;
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://harness.invalid');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page(u.searchParams));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
      resolve(server.address().port);
    });
  });
}

// The real control domain on the real answer surface, plus a confirm row.
async function rig(t, port) {
  const root = tmpRoot('wc-control-e2e-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bus = createBus();
  const events = [];
  bus.subscribe((e) => { if (e && e.kind === 'control') events.push(e); });
  const mirror = fakeMirror();
  const asks = { pending: () => [], displayView: () => null, waitView: async () => null, decide: () => ({ ok: false }), noteRefusal() {} };
  let control = null;
  const surface = createAnswerSurface({
    asks, mainPort: () => port, audience: { levelOf: () => 'local' }, root,
  });
  control = createControl({ root, bus, mirror, answerSurface: surface, getViewers: () => ({ local: 1 }) });
  const runs = [];
  control.action('restore', {
    fields: ['preview'],
    layouts: ['confirm'],
    limit: { scope: 'project', ms: 5000 },
    params: (q) => {
      if (typeof q.preview !== 'string' || !/^pv_[a-z0-9]{1,16}$/.test(q.preview)) throw new TypeError('bad preview');
      return { preview: q.preview };
    },
    key: (target) => target.preview,
    describe: async () => ({ title: 'Restore files', summary: 'Restore 2 files to before turn n1.4: 1 rewritten · 1 deleted', lines: ['M src/a.js', 'D src/b.js'] }),
    check: async () => null,
    run: async (target) => { runs.push(target); return { ok: true, restore_id: 'rs_e2e_secret', counts: { rewritten: 1, recreated: 0, deleted: 1, not_covered: 0 }, residual: [] }; },
  });
  await control.start();
  const { origin } = await surface.ensure();
  t.after(async () => { await control.stop(); await surface.close(); });
  return { root, bus, events, mirror, control, surface, origin, runs };
}

// ── CDP ─────────────────────────────────────────────────────────────────────
async function openTab(cdp, { width = W, height = H } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  return sessionId;
}
async function navigate(cdp, sid, url) {
  const loaded = cdp.once('Page.loadEventFired', { sessionId: sid });
  const nav = await cdp.send('Page.navigate', { url }, sid);
  if (nav.errorText) throw new Error(`could not load ${url}: ${nav.errorText}`);
  await loaded;
}
async function evaluate(cdp, sid, expression, contextId) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) }, sid);
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.text}`);
  return r.result ? r.result.value : undefined;
}
async function frameWorld(cdp, sid, origin) {
  let frameId = null;
  await waitUntil(async () => {
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, sid);
    const kid = (frameTree.childFrames || []).find((f) => f.frame.url.startsWith(origin));
    frameId = kid ? kid.frame.id : null;
    return frameId !== null;
  }, { what: 'the control frame', timeout: 10000 });
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: 'wc-e2e' }, sid);
  return executionContextId;
}
// The rect of `sel` inside the frame, in the top page's coordinates.
async function rectOf(cdp, sid, ctx, sel) {
  const inner = await evaluate(cdp, sid, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
    const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`, ctx);
  if (!inner) return null;
  const outer = await evaluate(cdp, sid, '(() => { const r = document.getElementById("f").getBoundingClientRect(); return { x: r.left, y: r.top }; })()');
  return { left: outer.x + inner.left, top: outer.y + inner.top, width: inner.width, height: inner.height };
}
const centre = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function mouseTo(cdp, sid, p) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }, sid);
}
async function trustedClick(cdp, sid, p) {
  await mouseTo(cdp, sid, p);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }, sid);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }, sid);
}
const harnessUrl = (port, src, opts = {}) => {
  const u = new URL(`http://127.0.0.1:${port}/`);
  u.searchParams.set('src', src);
  for (const k of ['frame', 'wrap', 'over']) if (opts[k]) u.searchParams.set(k, opts[k]);
  return u.href;
};
const doneMessages = (cdp, sid, origin) => evaluate(cdp, sid,
  `window.__msgs.filter((m) => m.origin === ${JSON.stringify(origin)} && m.data && m.data.type === 'wc-answer:done').map((m) => m.data)`);

// ── stop ────────────────────────────────────────────────────────────────────

test('real Chrome: a trusted click on the Stop frame sends ONE accepted interrupt (it carried the nonce); Interrupted only on the mirror\'s word, then ONE done', { skip: e2e.skip, timeout: 180000 }, async (t) => {
  const port = await harness(t);
  const r = await rig(t, port);
  const src = `${r.origin}/answer/control/interrupt?conversation_id=c1&size=bar&layout=stop&mode=light&device=desktop`;
  const browser = launchChrome({ chromePath: e2e.chrome, tmpDir: r.root });
  t.after(() => browser.close());
  const { cdp } = browser;
  const sid = await openTab(cdp);
  await navigate(cdp, sid, harnessUrl(port, src, { frame: 'width:160px;height:22px' }));
  const ctx = await frameWorld(cdp, sid, r.origin);
  await waitUntil(() => evaluate(cdp, sid, '!!document.querySelector(".ct-stop-btn")', ctx), { what: 'the Stop drawn', timeout: 10000 });
  assert.equal(await evaluate(cdp, sid, 'document.querySelector(".ct-stop-label").textContent', ctx), 'Stop after this step',
    'no tty here: labelled for the hook halt');
  const p = centre(await rectOf(cdp, sid, ctx, '.ct-stop-btn'));
  await mouseTo(cdp, sid, p);
  await sleep(900);   // past the dwell and the cooldown
  await trustedClick(cdp, sid, p);
  await waitUntil(() => r.events.length >= 1, { what: 'the interrupt', timeout: 5000 });
  await sleep(500);
  assert.equal(r.events.length, 1, 'one interrupt');
  assert.equal(r.events[0].op, 'interrupt');
  assert.equal(r.events[0].conversation_id, 'c1');
  assert.equal(r.events[0].via, 'hook');
  assert.match(await evaluate(cdp, sid, 'document.querySelector(".ct-stop-label").textContent', ctx), /^Stopping after this step…$/);
  assert.deepEqual(await doneMessages(cdp, sid, r.origin), [], 'no done before the mirror says so');
  // The mirror reports the turn over.
  r.mirror.conversations[0].live = { state: 'idle' };
  r.mirror.emit({ op: 'state', conversation_id: 'c1', state: 'idle' });
  await waitUntil(async () => (await evaluate(cdp, sid, 'document.querySelector(".ct-stop-label").textContent', ctx)) === 'Interrupted',
    { what: 'Interrupted', timeout: 25000 });
  await sleep(300);
  assert.deepEqual(await doneMessages(cdp, sid, r.origin), [{ type: 'wc-answer:done', id: 'interrupt', outcome: 'interrupted' }]);
});

// ── confirm, against clickjacking ───────────────────────────────────────────

test('real Chrome: the confirm\'s action stays disabled however a pane dresses the frame; fully visible, a trusted click after the dwell runs it once', { skip: e2e.skip, timeout: 240000 }, async (t) => {
  const port = await harness(t);
  const r = await rig(t, port);
  const src = `${r.origin}/answer/control/restore?preview=pv_e2e&layout=confirm&mode=light&device=desktop`;
  const browser = launchChrome({ chromePath: e2e.chrome, tmpDir: r.root });
  t.after(() => browser.close());
  const { cdp } = browser;
  const sid = await openTab(cdp);

  // Where the summary and the button sit, undressed.
  await navigate(cdp, sid, harnessUrl(port, src));
  let ctx = await frameWorld(cdp, sid, r.origin);
  await waitUntil(() => evaluate(cdp, sid, '!!document.querySelector(".ct-act")', ctx), { what: 'the confirm drawn', timeout: 10000 });
  const act = await rectOf(cdp, sid, ctx, '.ct-act');
  const sum = await rectOf(cdp, sid, ctx, '.ct-summary');
  const below = Math.ceil(sum.top + sum.height - 20);   // inside the frame's box: the summary's bottom edge
  const box = (x) => `left:${Math.floor(x.left) - 2}px;top:${Math.floor(x.top) - 2}px;width:${Math.ceil(x.width) + 4}px;height:${Math.ceil(x.height) + 4}px;background:#fff`;
  const CASES = [
    ['the frame at opacity .5', { frame: 'opacity:.5' }],
    ['an element over the button', { over: box(act) }],
    ['an element over only the summary', { over: box(sum) }],
    ['an ancestor clip-path hiding the summary', { wrap: `clip-path:inset(${below}px 0 0 0)` }],
    ['an ancestor mask hiding the summary', { wrap: `-webkit-mask-image:linear-gradient(to bottom,transparent ${below}px,#000 ${below}px);mask-image:linear-gradient(to bottom,transparent ${below}px,#000 ${below}px)` }],
    ['an iframe smaller than its content', { frame: 'height:60px' }],
  ];
  for (const [name, dress] of CASES) {
    await navigate(cdp, sid, harnessUrl(port, src, dress));
    ctx = await frameWorld(cdp, sid, r.origin);
    await waitUntil(() => evaluate(cdp, sid, '!!document.querySelector(".ct-act")', ctx), { what: `${name}: the frame drawn`, timeout: 10000 });
    const p = centre(await rectOf(cdp, sid, ctx, '.ct-act'));
    await mouseTo(cdp, sid, p);
    await sleep(1500);   // past the proof's 500 ms, the dwell and the cooldown
    assert.equal(await evaluate(cdp, sid, 'document.querySelector(".ct-act").getAttribute("aria-disabled")', ctx), 'true', `${name}: disabled`);
    await trustedClick(cdp, sid, p);
    await sleep(300);
    assert.equal(r.runs.length, 0, `${name}: a trusted click ran nothing`);
    t.diagnostic(`${name}: disabled (${await evaluate(cdp, sid, 'document.querySelector(".ct").dataset.guard', ctx)})`);
  }

  // Fully visible, after the dwell: the action runs once; the result stays in the frame.
  await navigate(cdp, sid, harnessUrl(port, src));
  ctx = await frameWorld(cdp, sid, r.origin);
  await waitUntil(() => evaluate(cdp, sid, '!!document.querySelector(".ct-act")', ctx), { what: 'the frame drawn', timeout: 10000 });
  const p = centre(await rectOf(cdp, sid, ctx, '.ct-act'));
  await mouseTo(cdp, sid, p);
  await waitUntil(() => evaluate(cdp, sid, 'document.querySelector(".ct-act").getAttribute("aria-disabled") === "false"', ctx),
    { what: 'the action enabled once fully visible', timeout: 5000 });
  await sleep(700);
  await trustedClick(cdp, sid, p);
  await waitUntil(() => r.runs.length === 1, { what: 'the restore', timeout: 5000 });
  assert.deepEqual(r.runs[0], { preview: 'pv_e2e' });
  await waitUntil(async () => (await doneMessages(cdp, sid, r.origin)).length === 1, { what: 'the done', timeout: 5000 });
  const [done] = await doneMessages(cdp, sid, r.origin);
  assert.equal(done.outcome, 'restored');
  assert.deepEqual(done.result, { rewritten: 1, recreated: 0, deleted: 1, not_covered: 0 });
  const all = JSON.stringify(await evaluate(cdp, sid, 'window.__msgs'));
  assert.ok(!all.includes('rs_e2e_secret'), 'the harness — the chrome — never received the restore id');
  assert.match(await evaluate(cdp, sid, 'document.querySelector(".ct-outcome").textContent', ctx), /^Restored: 1 rewritten/);
});
