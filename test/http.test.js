// The chrome's one HTTP reader, public/app/http.js (annotation engine 2A.5):
// one answer shape {ok, status, body, refused, hint} for every request, the
// daemon's refusal grammar read the same way everywhere, the device claim
// added in one place and only into a JSON body — and queue.js, whose private
// request is now a thin adapter over it, sending and answering byte for byte
// what it did before (ae/int 39b52f8).
//
// Through the real shell (test-support/chrome-shell.js): the modules call the
// bare global fetch, which the shell answers from setRoutes(); a route given
// as a function sees the raw (url, init) the module passed, so the tests below
// read the exact headers and body string sent.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bootShell, respond } = require('../test-support/chrome-shell');

const REPO = path.resolve(__dirname, '..');
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

let shell, http, queue;
before(async () => {
  shell = await bootShell();
  http = await shell.importApp('http.js');
  queue = await shell.importApp('queue.js');
});
after(() => shell && shell.restore());

// Answer `url` with `answer` (a value, a respond(), or a function of (url, init)),
// and record the raw init of every request to it.
function route(url, answer) {
  const sent = [];
  shell.setRoutes({
    [url]: (u, init) => {
      sent.push({ url: u, init });
      return typeof answer === 'function' ? answer(u, init) : answer;
    },
  });
  return sent;
}
const reject = () => { throw new TypeError('Failed to fetch'); };

// ── the four refusal shapes ──────────────────────────────────────────────────

test('(a) a fetch that rejects answers status 0, refused network, and never rejects', async () => {
  route('/t/a', reject);
  const r = await http.request('POST', '/t/a', { body: { x: 1 } });
  assert.deepEqual(r, { ok: false, status: 0, body: null, refused: 'network', hint: http.NETWORK_HINT });
});

test('(a) a fetch the caller\'s signal aborted answers refused aborted', async () => {
  // In flight, then aborted.
  route('/t/abort', (u, init) => new Promise((resolve, rej) => {
    init.signal.addEventListener('abort', () => rej(new DOMException('The operation was aborted.', 'AbortError')));
  }));
  const ctl = new AbortController();
  const pending = http.request('GET', '/t/abort', { signal: ctl.signal });
  ctl.abort();
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.equal(r.body, null);
  assert.equal(r.refused, 'aborted');
  assert.equal(typeof r.hint, 'string');
  assert.notEqual(r.hint, http.NETWORK_HINT, 'an abort is the caller\'s own, not a daemon that did not answer');

  // Aborted before it was sent: the rejection carries no AbortError name, the signal says it.
  const gone = new AbortController();
  gone.abort();
  route('/t/abort2', reject);
  const r2 = await http.request('GET', '/t/abort2', { signal: gone.signal });
  assert.equal(r2.refused, 'aborted');
});

test('(b) a non-2xx whose body is not JSON (a 502 HTML page) answers refused network with its status', async () => {
  route('/t/b', respond('<html><body>Bad Gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } }));
  const r = await http.request('GET', '/t/b');
  assert.deepEqual(r, { ok: false, status: 502, body: null, refused: 'network', hint: http.NETWORK_HINT });
});

test('(c) a JSON refusal that names `refused` passes its reason and hint through', async () => {
  const body = { ok: false, refused: 'locked', hint: 'Claude is mid-turn — try again when it ends.' };
  route('/t/c', respond(body, { status: 409 }));
  const r = await http.request('POST', '/t/c', { body: {} });
  assert.deepEqual(r, { ok: false, status: 409, body, refused: 'locked', hint: body.hint });

  // No hint: the error, else NETWORK_HINT.
  route('/t/c2', respond({ ok: false, refused: 'too_large', error: 'Too long.' }, { status: 413 }));
  assert.equal((await http.request('POST', '/t/c2', { body: {} })).hint, 'Too long.');
  route('/t/c3', respond({ ok: false, refused: 'stale' }, { status: 409 }));
  assert.equal((await http.request('POST', '/t/c3', { body: {} })).hint, http.NETWORK_HINT);
});

test('(d) a JSON 403 with no `refused` is forbidden, its error the hint', async () => {
  route('/t/d', respond({ error: 'This needs the full mirror level.' }, { status: 403 }));
  const r = await http.request('POST', '/t/d', { body: {} });
  assert.deepEqual(r, { ok: false, status: 403, body: { error: 'This needs the full mirror level.' },
    refused: 'forbidden', hint: 'This needs the full mirror level.' });
});

test('(d) a JSON 409 {code} with no `refused` takes the code', async () => {
  route('/t/d2', respond({ code: 'conflict' }, { status: 409 }));
  const r = await http.request('PATCH', '/t/d2', { body: {} });
  assert.deepEqual(r, { ok: false, status: 409, body: { code: 'conflict' }, refused: 'conflict', hint: http.NETWORK_HINT });

  route('/t/d3', respond({ message: 'no' }, { status: 500 }));
  assert.equal((await http.request('GET', '/t/d3')).refused, 'error', 'neither refused nor code: error');
});

// ── what is ok ───────────────────────────────────────────────────────────────

test('a 200 JSON body without `ok` is ok, with that body', async () => {
  route('/t/ok', { nodes: [{ id: 'n1' }], active: 'n1' });
  const r = await http.request('GET', '/t/ok');
  assert.deepEqual(r, { ok: true, status: 200, body: { nodes: [{ id: 'n1' }], active: 'n1' }, refused: null, hint: null });
});

test('a 200 {ok:false, refused} is a refusal', async () => {
  route('/t/ok2', { ok: false, refused: 'reserved', hint: 'That id is the shell\'s.' });
  const r = await http.request('POST', '/t/ok2', { body: {} });
  assert.deepEqual(r, { ok: false, status: 200, body: { ok: false, refused: 'reserved', hint: 'That id is the shell\'s.' },
    refused: 'reserved', hint: 'That id is the shell\'s.' });
});

test('a 204 (no body) is ok with body null', async () => {
  route('/t/204', respond('', { status: 204 }));
  assert.deepEqual(await http.request('DELETE', '/t/204'), { ok: true, status: 204, body: null, refused: null, hint: null });
});

test('request never throws or rejects, whatever it is handed', async () => {
  route('/t/never', reject);
  const cyclic = {}; cyclic.self = cyclic;
  // Each attempt with the refusal it must answer.
  const attempts = [
    [() => http.request('POST', '/t/never'), 'network'],
    [() => http.request('POST', '/t/never', { body: cyclic }), 'error'],
    [() => http.request('POST', '/t/never', { body: { big: 1n } }), 'error'],
    [() => http.request('GET', '/t/never', null), 'network'],
    [() => http.request(undefined, '/t/never', { headers: 'not an object' }), 'network'],
  ];
  for (const [go, refused] of attempts) {
    let r;
    assert.doesNotThrow(() => { r = go(); });
    const a = await r;
    assert.deepEqual(Object.keys(a), ['ok', 'status', 'body', 'refused', 'hint']);
    assert.equal(a.ok, false);
    assert.equal(a.refused, refused);
    assert.equal(typeof a.hint, 'string');
  }
  // No arguments at all: still an answer (the shell answers any unknown URL ok).
  const bare = await http.request();
  assert.deepEqual(Object.keys(bare), ['ok', 'status', 'body', 'refused', 'hint']);
});

test('an object body is sent as JSON with Content-Type application/json; a string goes as it is', async () => {
  const sent = route('/t/json', { ok: true });
  await http.request('POST', '/t/json', { body: { a: 1, b: [2] } });
  await http.request('PUT', '/t/json', { body: 'raw text', headers: { 'Content-Type': 'text/plain' } });
  await http.request('POST', '/t/json', { body: { a: 1 }, headers: { 'X-Extra': '1' } });
  assert.equal(sent[0].init.method, 'POST');
  assert.deepEqual(sent[0].init.headers, { 'Content-Type': 'application/json' });
  assert.equal(sent[0].init.body, '{"a":1,"b":[2]}');
  assert.deepEqual(sent[1].init.headers, { 'Content-Type': 'text/plain' });
  assert.equal(sent[1].init.body, 'raw text');
  assert.deepEqual(sent[2].init.headers, { 'Content-Type': 'application/json', 'X-Extra': '1' });
});

// ── the device claim ─────────────────────────────────────────────────────────

test('device:true puts device: deviceKind() into an object body — desktop, then mobile on a phone', async (t) => {
  t.after(() => shell.setViewport(DESKTOP));
  const sent = route('/t/dev', { ok: true });
  const body = { text: 'hi' };
  await http.request('POST', '/t/dev', { body, device: true });
  assert.equal(sent[0].init.body, '{"text":"hi","device":"desktop"}');
  assert.deepEqual(body, { text: 'hi' }, 'the caller\'s body is not written to');

  shell.setViewport(PHONE);
  assert.ok(shell.document.documentElement.classList.contains('phone'), 'the phone class is set');
  await http.request('POST', '/t/dev', { body: { text: 'hi' }, device: true });
  assert.equal(sent[1].init.body, '{"text":"hi","device":"mobile"}');

  // Without device:true nothing is added.
  await http.request('POST', '/t/dev', { body: { text: 'hi' } });
  assert.equal(sent[2].init.body, '{"text":"hi"}');
});

test('an explicit body.device is kept', async () => {
  const sent = route('/t/dev2', { ok: true });
  await http.request('POST', '/t/dev2', { body: { device: 'mobile', n: 1 }, device: true });
  assert.equal(sent[0].init.body, '{"device":"mobile","n":1}');
});

test('a GET with device:true sends no body and no header', async () => {
  const sent = route('/t/dev3', { items: [] });
  const r = await http.request('GET', '/t/dev3', { device: true, body: { ignored: true } });
  assert.equal(r.ok, true);
  assert.equal(sent[0].init.method, 'GET');
  assert.equal('body' in sent[0].init, false);
  assert.equal('headers' in sent[0].init, false);
});

test('no request carries an X-WC-Pane or a device header; http.js never spells the pane header', async () => {
  const sent = route('/t/hdr', { ok: true });
  await http.request('POST', '/t/hdr', { body: { a: 1 }, device: true });
  await http.request('GET', '/t/hdr', { device: true });
  await http.request('DELETE', '/t/hdr', { device: true });
  for (const { init } of sent) {
    const keys = Object.keys(init.headers || {}).map((k) => k.toLowerCase());
    assert.equal(keys.includes('x-wc-pane'), false);
    assert.equal(keys.includes('device'), false);
    assert.equal(keys.some((k) => k.includes('device')), false);
  }
  const src = fs.readFileSync(path.join(REPO, 'public/app/http.js'), 'utf8');
  assert.equal(/x-wc-pane/i.test(src), false, 'pane identity is public/mount-runtime.js paneFetch\'s alone');
});

// ── queue.js, byte for byte as at 39b52f8 ────────────────────────────────────
//
// The values below were recorded from queue.js's own private request at ae/int
// 39b52f8 (this file ran green against it before the adapter landed): what it
// sent — method, URL, headers and the body string, in an init of exactly those
// three keys — and what it resolved with, compared as JSON so the key order
// counts too.

const NETWORK_HINT = 'The daemon did not answer — check that web-chat is running, then try again.';

const ANSWERS = [
  { name: 'ok JSON', answer: () => ({ ok: true, msg_id: 'm-1', id: 'q-1', mode: 'queued' }),
    expect: { ok: true, msg_id: 'm-1', id: 'q-1', mode: 'queued' } },
  { name: 'refused JSON', answer: () => respond({ ok: false, refused: 'locked', hint: 'Wait.' }, { status: 409 }),
    expect: { ok: false, refused: 'locked', hint: 'Wait.' } },
  { name: '403 JSON without refused', answer: () => respond({ error: 'Below full.' }, { status: 403 }),
    expect: { error: 'Below full.', ok: false, refused: 'forbidden', hint: 'Below full.', status: 403 } },
  { name: 'non-JSON 2xx', answer: () => respond('accepted', { status: 200 }),
    expect: { ok: true } },
  { name: 'non-JSON 500', answer: () => respond('<html>boom</html>', { status: 500 }),
    expect: { ok: false, refused: 'network', hint: NETWORK_HINT, status: 500 } },
  { name: 'rejecting fetch', answer: reject,
    expect: { ok: false, refused: 'network', hint: NETWORK_HINT } },
  // Two more, where queue.js's legacy reading and http.js's part ways: a 200
  // JSON body that does not say ok:true is a refusal to queue.js.
  { name: '200 JSON without ok', answer: () => ({ items: 1 }),
    expect: { items: 1, ok: false, refused: 'error', hint: NETWORK_HINT, status: 200 } },
  { name: '409 JSON {code}', answer: () => respond({ code: 'conflict', ok: false, hint: 'Edited elsewhere.' }, { status: 409 }),
    expect: { code: 'conflict', ok: false, hint: 'Edited elsewhere.', refused: 'conflict', status: 409 } },
];

const CALLS = [
  { name: 'sendMessage', url: '/api/queue/message', method: 'POST',
    run: () => queue.sendMessage({ text: 'hi there', conversation_id: 'c-1', skill: { name: 'plan', args: 'x' } }),
    body: '{"text":"hi there","conversation_id":"c-1","send":"auto","device":"desktop","skill":{"name":"plan","args":"x"}}' },
  { name: 'editMessage', url: '/api/queue/q%201', method: 'PATCH',
    run: () => queue.editMessage('q 1', { text: 'edited', files: ['a.md'] }),
    body: '{"text":"edited","files":["a.md"]}' },
  { name: 'sendNow (the push)', url: '/api/queue/push', method: 'POST',
    run: () => queue.sendNow('q-7'),
    body: '{"ids":["q-7"],"device":"desktop"}' },
  { name: 'recallPending', url: '/api/queue/pending/recall', method: 'POST',
    run: () => queue.recallPending('pw1'),
    body: '{"id":"pw1"}' },
];

for (const c of CALLS) {
  test(`queue.js ${c.name}: the same request and the same answer as at 39b52f8, over every stubbed answer`, async () => {
    for (const a of ANSWERS) {
      const sent = route(c.url, a.answer);
      const r = await c.run();
      assert.equal(sent.length, 1, `${a.name}: one request`);
      const { url, init } = sent[0];
      assert.equal(url, c.url, `${a.name}: url`);
      assert.deepEqual(Object.keys(init), ['method', 'headers', 'body'], `${a.name}: the init's keys`);
      assert.equal(init.method, c.method, `${a.name}: method`);
      assert.deepEqual(init.headers, { 'Content-Type': 'application/json' }, `${a.name}: headers`);
      assert.equal(init.body, c.body, `${a.name}: body string`);
      assert.equal(JSON.stringify(r), JSON.stringify(a.expect), `${a.name}: the resolved value, key order included`);
    }
  });
}
