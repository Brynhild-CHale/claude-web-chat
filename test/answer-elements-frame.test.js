// The report path's frame (lib/server/answer-surface/public/elements-report.js,
// annotation engine PLAN.md 2B.1; U312) in jsdom, booted through answer.js's
// runtime into the real index.html as an `elements` document of layout
// `report` (test/answer-control-frame.test.js's harness).
//
//   * it tells its parent it listens (READY), and nothing else unprompted;
//   * a parent message carrying a batch → ONE POST to
//     /answer/api/elements/report with X-WC-Answer, the body {reports: [part],
//     device, viewer} from the document's own query;
//   * a message from any other source, or of any other shape, is ignored;
//   * a 100 KB batch goes as parts of at most 48 KB, in order, every item once
//     — a mount too large alone split item by item;
//   * the daemon refusing the nonce → ONE EXPIRED to the parent, and nothing
//     more is posted;
//   * it draws nothing and never echoes a body back.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

const REPO = path.resolve(__dirname, '..');
const PUB = path.join(REPO, 'lib/server/answer-surface/public');
const ORIGIN = 'http://127.0.0.1:47125';
const NONCE = 'elements-nonce-for-this-load';
const VIEWER = '0123456789abcdef0123456789abcdef';

let A, R;
test.before(async () => {
  A = await import(pathToFileURL(path.join(PUB, 'answer.js')).href);
  R = await import(pathToFileURL(path.join(PUB, 'elements-report.js')).href);
});

function pageHtml() {
  const values = { NONCE, MODE: 'light', KIND: 'elements', META: '' };
  return fs.readFileSync(path.join(PUB, 'index.html'), 'utf8')
    .replace(/\{\{(NONCE|MODE|KIND|META)\}\}/g, (_, k) => values[k])
    .replace(/<script[^>]*><\/script>/g, '');
}

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function openFrame(t, { query = `layout=report&mode=light&device=mobile&viewer=${VIEWER}`, answer = () => json({ ok: true, accepted: 1, confirmed: 0, refused: {} }) } = {}) {
  const dom = new JSDOM(pageHtml(), { url: `${ORIGIN}/answer/elements/report?${query}`, pretendToBeVisual: true });
  const W = dom.window;
  const posts = [];
  const parent = new JSDOM('', { url: 'https://wc-0a1b2c3d.example.com/' }).window;
  parent.postMessage = (msg, target) => { posts.push({ msg, target }); };
  Object.defineProperty(W, 'parent', { value: parent, configurable: true });
  const calls = [];
  let inflight = 0;
  let maxInflight = 0;
  W.fetch = async (u, init = {}) => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    calls.push({ url: String(u), init, body: init.body ? JSON.parse(init.body) : null, bytes: init.body ? Buffer.byteLength(init.body) : 0 });
    await settle(2);
    inflight -= 1;
    return answer(calls.length);
  };
  const handle = await A.boot(W);
  t.after(() => { try { handle.stop(); } catch {} W.close(); parent.close(); });
  const fromParent = (data, source = parent) => W.dispatchEvent(new W.MessageEvent('message', { data, source }));
  return { W, doc: W.document, handle, parent, posts, calls, fromParent, maxInflight: () => maxInflight };
}

const items = (n, pad = 0) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, v: 1, state: 'exact', how: 'path', ...(pad ? { why: 'x'.repeat(Math.min(32, pad)) } : {}) }));
const channels = (p) => p.posts.map((x) => x.msg && x.msg.channel).filter(Boolean);

test('the frame says it listens, then a parent batch is ONE POST with the nonce, the document\'s device and viewer', async (t) => {
  const p = await openFrame(t);
  await settle();
  assert.deepStrictEqual(channels(p), [R.READY_CHANNEL], 'READY once, nothing else');
  assert.ok(p.posts.every((x) => x.target === '*'), 'outbound hints go to * (they carry nothing)');
  assert.deepStrictEqual(p.posts.find((x) => x.msg.channel).msg, { channel: R.READY_CHANNEL });
  const report = { surface: 1729000000123, mounts: [{ mount: 'p1', gen: 2, items: items(3) }, { mount: 'md-1', gen: 0, items: [] }] };
  p.fromParent({ channel: R.REPORT_CHANNEL, report });
  await settle(40);
  assert.equal(p.calls.length, 1);
  const [c] = p.calls;
  assert.equal(c.url, '/answer/api/elements/report');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['X-WC-Answer'], NONCE);
  assert.equal(c.init.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(c.body, { reports: [report], device: 'mobile', viewer: VIEWER });
  assert.deepStrictEqual(channels(p), [R.READY_CHANNEL], 'no body echoed back, no answer passed on');
  const main = p.doc.getElementById('wc-answer');
  assert.equal(main.children.length, 0, 'draws nothing');
  assert.equal(main.textContent, '');
});

test('a message from any other source, or of another shape, is ignored', async (t) => {
  const p = await openFrame(t);
  await settle();
  const report = { surface: 5, mounts: [{ mount: 'p1', gen: 0, items: items(1) }] };
  const other = new JSDOM('', { url: 'https://evil.example/' }).window;
  t.after(() => other.close());
  p.fromParent({ channel: R.REPORT_CHANNEL, report }, other);
  p.fromParent({ channel: R.REPORT_CHANNEL, report }, p.W);
  p.fromParent({ channel: R.REPORT_CHANNEL, report }, null);
  for (const bad of [
    { type: 'report', surface: 5, mounts: report.mounts },
    { channel: 'wc-answer:mode', report },
    { channel: R.REPORT_CHANNEL },
    { channel: R.REPORT_CHANNEL, report: { surface: '5', mounts: report.mounts } },
    { channel: R.REPORT_CHANNEL, report: { surface: 5, mounts: [] } },
    { channel: R.REPORT_CHANNEL, report: { surface: 5, mounts: 'x' } },
    'report', null, [report],
  ]) p.fromParent(bad);
  await settle(40);
  assert.equal(p.calls.length, 0, 'nothing posted');
  // The rig is sound: the same batch from the parent is posted.
  p.fromParent({ channel: R.REPORT_CHANNEL, report });
  await settle(40);
  assert.equal(p.calls.length, 1);
});

test('a 100 KB batch goes as parts of at most 48 KB, in order, every item once; a mount too large alone is split item by item', async (t) => {
  const p = await openFrame(t);
  await settle();
  const mounts = [];
  for (let m = 0; m < 30; m++) mounts.push({ mount: `p${m}`, gen: m, items: items(30, 32) });
  // One mount alone over the cap.
  mounts.push({ mount: 'big', gen: 7, items: items(900, 32) });
  mounts.push({ mount: 'tail', gen: 0, items: [] });
  const report = { surface: 42, mounts };
  assert.ok(Buffer.byteLength(JSON.stringify(report)) > 100 * 1024, 'over 100 KB');
  p.fromParent({ channel: R.REPORT_CHANNEL, report });
  await settle(400);
  assert.ok(p.calls.length >= 3, `parts: ${p.calls.length}`);
  for (const c of p.calls) {
    assert.ok(c.bytes <= R.PART_MAX_BYTES, `a part of ${c.bytes} bytes`);
    assert.equal(c.body.reports.length, 1);
    assert.equal(c.body.reports[0].surface, 42);
    assert.equal(c.init.headers['X-WC-Answer'], NONCE);
  }
  assert.equal(p.maxInflight(), 1, 'one part at a time');
  // In order, every entry's items once, each chunk under its own mount and gen.
  const flat = p.calls.flatMap((c) => c.body.reports[0].mounts.flatMap((e) => (e.items.length ? e.items.map((i) => `${e.mount}/${e.gen}/${i.id}`) : [`${e.mount}/${e.gen}/confirm`])));
  const want = mounts.flatMap((e) => (e.items.length ? e.items.map((i) => `${e.mount}/${e.gen}/${i.id}`) : [`${e.mount}/${e.gen}/confirm`]));
  assert.deepStrictEqual(flat, want);
  const bigParts = p.calls.filter((c) => c.body.reports[0].mounts.some((e) => e.mount === 'big'));
  assert.ok(bigParts.length >= 2, 'the large mount went in more than one part');
});

test('splitReport alone: under the cap one part; the envelope counted; an item over the cap goes alone', () => {
  const wrap = (part) => ({ reports: [part], device: 'desktop', viewer: VIEWER });
  const small = { surface: 1, mounts: [{ mount: 'a', gen: 0, items: items(2) }] };
  assert.deepStrictEqual(R.splitReport(small, wrap), [small]);
  const huge = { surface: 1, mounts: [{ mount: 'a', gen: 0, items: [{ id: 'x', v: 1, state: 'exact', record: { pad: 'y'.repeat(2000) } }, { id: 'y', v: 1, state: 'exact' }] }] };
  const parts = R.splitReport(huge, wrap, 1000);
  assert.equal(parts.length, 2, 'the over-cap item alone, the next in its own part');
  assert.deepStrictEqual(parts.map((x) => x.mounts[0].items.map((i) => i.id)), [['x'], ['y']]);
});

test('the daemon refusing the nonce → ONE EXPIRED to the parent, and nothing more is posted', async (t) => {
  const p = await openFrame(t, { answer: () => json({ ok: false, refused: 'nonce' }, 403) });
  await settle();
  const report = { surface: 9, mounts: [{ mount: 'p1', gen: 0, items: items(1) }] };
  p.fromParent({ channel: R.REPORT_CHANNEL, report });
  await settle(40);
  assert.equal(p.calls.length, 1);
  assert.deepStrictEqual(channels(p), [R.READY_CHANNEL, R.EXPIRED_CHANNEL]);
  p.fromParent({ channel: R.REPORT_CHANNEL, report });
  await settle(40);
  assert.equal(p.calls.length, 1, 'an expired document posts nothing more');
  assert.deepStrictEqual(channels(p), [R.READY_CHANNEL, R.EXPIRED_CHANNEL], 'EXPIRED once');
});

test('another refusal or a failed POST is not an expiry; a document with no viewer sends none', async (t) => {
  let n = 0;
  const p = await openFrame(t, {
    query: 'layout=report&mode=light',
    answer: () => { n += 1; if (n === 1) throw new Error('offline'); return json({ ok: false, refused: 'mirror' }, 403); },
  });
  await settle();
  const report = { surface: 9, mounts: [{ mount: 'p1', gen: 0, items: items(1) }] };
  p.fromParent({ channel: R.REPORT_CHANNEL, report });
  p.fromParent({ channel: R.REPORT_CHANNEL, report });
  p.fromParent({ channel: R.REPORT_CHANNEL, report });
  await settle(60);
  assert.equal(p.calls.length, 3);
  assert.deepStrictEqual(channels(p), [R.READY_CHANNEL]);
  assert.deepStrictEqual(Object.keys(p.calls[0].body), ['reports', 'device'], 'answer.js defaults the device to desktop; no viewer');
  assert.equal(p.calls[0].body.device, 'desktop');
});
