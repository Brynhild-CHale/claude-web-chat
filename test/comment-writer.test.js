// The comment write stamp (PLAN 1B.4 / 1B.5 / 1D.3, U214c; ruling A2): every
// add, edit and reply records `writer: {class, owner, verified}` (the writers
// domain's resolveWriter) and `provenance: {origin, device}` (queue.provenance
// of the request, with the chrome's own device claim), as plain sibling
// objects on the live pin and reply; an edit adds `edited: {writer,
// provenance, at}` and keeps the creator's `writer`. A reply claiming author
// 'claude' needs the claude class. The chrome sends `device` on every write.
//
// S-10 (F9): the 2x2x3 matrix — X-WC-Remote {absent, present} x User-Agent
// {desktop, mobile} x the chrome's device claim {none, mobile, desktop}. E1:
// the pin's stamp equals queue.provenance of the same request. E2: sending
// what the chrome now sends (the same claim on the pin and on the push), the
// pin's stamp equals the push's. Both read 0/12 disagreements.
const test = require('node:test');
const { describe, before, after } = test;
const assert = require('node:assert');
const path = require('path');
const { withServer, tmpRoot, waitUntil, commentBody } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const { WRITER_HEADER } = require('../lib/core/writer-token');
const { provenance } = require('../lib/server/domain/queue');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');

const UA = {
  desktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  mobile: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const ANCHOR = Object.freeze({ mount: 'm1', selector: 'p', text: 'p', ordinal: 0 });

// A daemon whose remote viewers are opted in at `full` (tunnel.json, as
// `tunnel mirror on full` writes it), so a remote viewer may write pins.
async function fullDaemon(t) {
  const root = tmpRoot('wc-cw-full-');
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, {
    hostname: 'wc.example.test',
    style: 'flat',
    access: { team: 'testteam', aud: 'test-aud-0123456789' },
    allow: { emails: ['me@example.com'], domains: [] },
    remote: { mirror: { [path.resolve(root)]: 'full' } },
  });
  const d = await withServer(t, { root, seed });
  await d.api.post('/api/render', { id: 'm1', html: '<p>p</p>' });
  return d;
}

const CLAIMS = [null, 'mobile', 'desktop'];

test('S-10: a pin\'s provenance is queue.provenance of its request (E1 0/12) and, with the claim the chrome now sends, the push\'s (E2 0/12)', async (t) => {
  const d = await fullDaemon(t);
  const rows = [];
  let n = 0;
  for (const remote of [false, true]) {
    for (const ua of ['desktop', 'mobile']) {
      for (const claim of CLAIMS) {
        const headers = { 'User-Agent': UA[ua], ...(remote ? REMOTE : {}) };
        const claimed = claim ? { device: claim } : {};
        const r = await d.anonApi.post('/api/elements', commentBody({ text: `cell ${++n}`, shared: true, anchor: ANCHOR, ...claimed }), headers);
        assert.equal(r.status, 200, `cell ${n}: ${r.text}`);
        const pin = r.json.pin;
        const E1 = provenance({ remote, device: claim || undefined, userAgent: UA[ua] });
        const push = await d.anonApi.post('/api/queue/push', claimed, headers);
        assert.equal(push.status, 200, `push ${n}: ${push.text}`);
        const pend = (await d.api.get('/api/queue/pending')).json.pending;
        assert.ok(pend, `cell ${n}: the push parked`);
        await d.api.post('/api/queue/pending/consume', { id: pend.id });
        rows.push({ remote, ua, claim: claim || 'none', pin: pin.provenance, E1, P: { origin: pend.origin, device: pend.device } });
      }
    }
  }
  const same = (a, b) => !!(a && b && a.origin === b.origin && a.device === b.device);
  assert.strictEqual(rows.length, 12);
  const e1 = rows.filter((r) => !same(r.pin, r.E1));
  const e2 = rows.filter((r) => !same(r.pin, r.P));
  assert.deepStrictEqual(e1, [], `E1 disagreements ${e1.length}/12`);
  assert.deepStrictEqual(e2, [], `E2 disagreements ${e2.length}/12`);
  // The matrix is not degenerate: both origins and both devices occur.
  assert.deepStrictEqual([...new Set(rows.map((r) => r.pin.origin))].sort(), ['local', 'remote']);
  assert.deepStrictEqual([...new Set(rows.map((r) => r.pin.device))].sort(), ['desktop', 'mobile']);
  // The claim wins over the User-Agent.
  const desk = rows.find((r) => r.ua === 'mobile' && r.claim === 'desktop');
  assert.strictEqual(desk.pin.device, 'desktop');
});

test('stamps: Claude\'s token writes as claude verified; a plain browser as user; each reply carries its own pair', async (t) => {
  const { api, anonApi } = await withServer(t);
  const add = await api.post('/api/elements', commentBody({ text: 'by claude', shared: true, anchor: ANCHOR }));
  assert.deepStrictEqual(add.json.pin.writer, { class: 'claude', owner: 'claude', verified: true });
  assert.deepStrictEqual(add.json.pin.provenance, { origin: 'local', device: 'desktop' });

  const user = await anonApi.post('/api/elements', commentBody({ text: 'by the user', shared: true, anchor: ANCHOR, device: 'mobile' }));
  assert.deepStrictEqual(user.json.pin.writer, { class: 'user', owner: 'user', verified: false });
  assert.deepStrictEqual(user.json.pin.provenance, { origin: 'local', device: 'mobile' });

  const r1 = await api.post(`/api/elements/${user.json.pin.id}/reply`, { text: 'Claude answers', author: 'claude' });
  assert.equal(r1.status, 200, r1.text);
  const r2 = await anonApi.post(`/api/elements/${user.json.pin.id}/reply`, { text: 'the user answers', author: 'user', device: 'mobile' });
  const replies = r2.json.pin.replies;
  assert.deepStrictEqual(replies.map((r) => [r.author, r.writer.class, r.writer.verified, r.provenance.device]),
    [['claude', 'claude', true, 'desktop'], ['user', 'user', false, 'mobile']]);
  assert.deepStrictEqual(r2.json.pin.writer, { class: 'user', owner: 'user', verified: false }, 'a reply never rewrites the pin\'s writer');

  // An author-less reply from Claude's token is still 'user' by author (the
  // default), stamped claude: the author is the claim, the stamp the proof.
  const r3 = await api.post(`/api/elements/${user.json.pin.id}/reply`, { text: 'no author' });
  assert.strictEqual(r3.json.pin.replies.slice(-1)[0].author, 'user');
});

test('a reply as author claude needs the verified claude class: a browser is refused 403 unverified, and so is Claude\'s MCP tool run tokenless (C-15-2)', async (t) => {
  const { api, anonApi, port } = await withServer(t);
  const pin = (await api.post('/api/elements', commentBody({ text: 'a note', shared: true, anchor: ANCHOR }))).json.pin;
  const forged = await anonApi.post(`/api/elements/${pin.id}/reply`, { text: 'I am Claude', author: 'claude' });
  assert.equal(forged.status, 403, forged.text);
  assert.strictEqual(forged.json.ok, false);
  assert.strictEqual(forged.json.writer, 'unverified');

  // reply_comment's own handler, through lib/mcp/client with no token (the
  // MCP tool tests' shape: WEB_CHAT_MCP_SERVER unset): on the element API a
  // claude reply needs the verified credential (C-15-2, U355), so a tokenless
  // one is refused like the browser's, and nothing is appended.
  const saved = { port: process.env.WEB_CHAT_PORT, mcp: process.env.WEB_CHAT_MCP_SERVER };
  t.after(() => {
    for (const [k, v] of [['WEB_CHAT_PORT', saved.port], ['WEB_CHAT_MCP_SERVER', saved.mcp]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  process.env.WEB_CHAT_PORT = String(port);
  delete process.env.WEB_CHAT_MCP_SERVER;
  const tool = require('../lib/mcp/tools/reply_comment');
  await assert.rejects(tool.handler({ id: pin.id, text: 'from the tool' }), (e) => e.status === 403 && e.body.writer === 'unverified');
  const live = (await api.get('/api/elements?type=comment')).json.elements.find((c) => c.id === pin.id);
  assert.deepStrictEqual(live.replies || [], [], 'the refused reply appended nothing');

  // A stale token is a 401 the MCP client knows, not a pin.
  const stale = await api.post(`/api/elements/${pin.id}/reply`, { text: 'x', author: 'claude' }, { [WRITER_HEADER]: 'f'.repeat(64) });
  assert.equal(stale.status, 401, stale.text);
  assert.strictEqual(stale.json.writer, 'stale');
});

test('an edit keeps the creator\'s writer and records `edited`; a no-op PATCH records nothing; a delete answers as before', async (t) => {
  const { api, anonApi } = await withServer(t);
  const pin = (await anonApi.post('/api/elements', commentBody({ text: 'mine', shared: true, anchor: ANCHOR, device: 'mobile' }))).json.pin;
  const noop = await api.patch(`/api/elements/${pin.id}`, {});
  assert.strictEqual(noop.json.unchanged, true);
  assert.strictEqual(noop.json.pin.edited, undefined);

  const before = Date.now();
  const ed = await api.patch(`/api/elements/${pin.id}`, { text: 'edited by Claude' });
  assert.equal(ed.status, 200, ed.text);
  assert.deepStrictEqual(ed.json.pin.writer, { class: 'user', owner: 'user', verified: false }, 'the creator stays');
  assert.deepStrictEqual(ed.json.pin.provenance, { origin: 'local', device: 'mobile' }, 'and the creation\'s provenance');
  const { edited } = ed.json.pin;
  assert.deepStrictEqual(edited.writer, { class: 'claude', owner: 'claude', verified: true });
  assert.deepStrictEqual(edited.provenance, { origin: 'local', device: 'desktop' });
  assert.ok(edited.at >= before);

  const del = await anonApi.del(`/api/elements/${pin.id}`);
  assert.deepStrictEqual(del.json, { ok: true, removed: pin.id });
});

test('a private pin\'s ring events carry no text and keep the stamps', async (t) => {
  const { api, anonApi } = await withServer(t);
  const MARK = 'wc-u214c-private-mark';
  const pin = (await anonApi.post('/api/elements', commentBody({ text: MARK, shared: false, anchor: ANCHOR, device: 'mobile' }))).json.pin;
  await anonApi.post(`/api/elements/${pin.id}/reply`, { text: MARK + '-reply', device: 'mobile' });
  let events = [];
  await waitUntil(async () => {
    events = ((await api.get('/api/events?since=0')).json.events || []).filter((e) => e.kind === 'comment');
    return events.length >= 2;
  });
  assert.ok(!JSON.stringify(events).includes(MARK), 'no private text in the ring');
  const add = events.find((e) => e.op === 'add');
  assert.deepStrictEqual(add.pin.writer, { class: 'user', owner: 'user', verified: false });
  assert.deepStrictEqual(add.pin.provenance, { origin: 'local', device: 'mobile' });
  const reply = events.find((e) => e.op === 'reply');
  assert.strictEqual(reply.pin.replies[0].text, '');
  assert.deepStrictEqual(reply.pin.replies[0].writer, { class: 'user', owner: 'user', verified: false });
  assert.deepStrictEqual(reply.pin.replies[0].provenance, { origin: 'local', device: 'mobile' });
});

// ── the chrome sends its device claim ───────────────────────────────────────

describe('chrome: every comment write carries `device`', () => {
  let shell, W, deviceKind;
  before(async () => {
    shell = await bootShell({ open: true });
    W = shell.window;
    ({ deviceKind } = await shell.importApp('viewport.js'));
    await shell.frame(helloFrame({ mounts: [{ id: 'drop', html: '<p>plain</p>', target: 'main', params: {}, pane_state: {} }] }));
  });
  after(() => shell && shell.restore());

  const pinPop = () => W.document.querySelector('.pin-pop');
  const pressInPane = (mountId, sel) => {
    const host = [...W.document.querySelectorAll('.mount-host')].find((h) => (h.dataset.mountId || h.id) === mountId);
    const target = host.shadowRoot.querySelector(sel);
    for (const type of ['pointerdown', 'click']) {
      target.dispatchEvent(new W.MouseEvent(type, { bubbles: true, composed: true, clientX: 40, clientY: 40 }));
    }
  };
  const sent = (method, re) => shell.calls.filter((c) => c.method === method && re.test(c.url)).pop();

  test('add, reply, toggle and delete each send deviceKind() in the body', async () => {
    const want = deviceKind();
    assert.ok(want === 'desktop' || want === 'mobile');

    // add: pin mode, a press in the pane, the composer's Pin.
    shell.key('c');
    pressInPane('drop', 'p');
    await shell.tick();
    pinPop().querySelector('.pin-text').value = 'a note';
    shell.click(pinPop().querySelector('.pin-save'));
    await shell.tick();
    const add = sent('POST', /^\/api\/elements$/);
    assert.ok(add, 'the add was sent');
    assert.strictEqual(add.body.device, want);
    assert.strictEqual(add.body.type, 'comment');
    assert.strictEqual(add.body.payload.text, 'a note');

    // The thread of a pin the server holds.
    await shell.frame({ type: 'element:comment', elements: [{ id: 'c9', text: 'look', shared: true, replies: [], anchor: { mount: 'drop', selector: 'p', text: 'plain', ordinal: 0 } }] });
    shell.key('c');
    const marker = shell.$('pin-layer').querySelector('.pin-marker');
    assert.ok(marker, 'the pin drew a marker');
    marker.dispatchEvent(new W.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 40 }));
    await shell.tick();
    const thread = pinPop();
    assert.ok(thread && thread.classList.contains('pin-thread'), 'the thread opened');

    thread.querySelector('.pin-reply-text').value = 'a reply';
    shell.click(thread.querySelector('.pin-reply-send'));
    await shell.tick();
    const reply = sent('POST', /^\/api\/elements\/c9\/reply$/);
    assert.ok(reply, 'the reply was sent');
    assert.deepStrictEqual({ author: reply.body.author, device: reply.body.device }, { author: 'user', device: want });

    // The thread may have been redrawn by the reply's refresh: re-open it.
    if (!pinPop() || !pinPop().querySelector('.pin-share-cb')) {
      marker.dispatchEvent(new W.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 40 }));
      await shell.tick();
    }
    const cb = pinPop().querySelector('.pin-share-cb');
    cb.checked = false;
    cb.dispatchEvent(new W.Event('change', { bubbles: true }));
    await shell.tick();
    const toggle = sent('PATCH', /^\/api\/elements\/c9$/);
    assert.ok(toggle, 'the toggle was sent');
    assert.deepStrictEqual(toggle.body, { shared: false, device: want });

    shell.click(pinPop().querySelector('.pin-del'));
    await shell.tick();
    const del = sent('DELETE', /^\/api\/elements\/c9$/);
    assert.ok(del, 'the delete was sent');
    assert.deepStrictEqual(del.body, { device: want }, 'a JSON body on the delete');
  });
});
