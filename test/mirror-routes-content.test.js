// The chat mirror's content routes (lib/server/routes/mirror-content.js, design
// spec §2.10 "Content"): a conversation's turns, one turn, one item's field and
// an attachment's bytes, on a bare Express app with a fake ctx, as §10.1 says
// route units are tested. Tranche 2's integration (U40) mounts them.
//
// The fakes. ctx.mirror is the part of the facade these routes read (§2.12:
// ready, enabled, status, turns, turn, itemField, attachment); each content
// method answers what the test hands it, and every call is logged in order so
// the test can see that `rev` was read before the dispatched call. ctx.audience
// is §5.4's gate on the real level order and hints (lib/core/remote-policy);
// one test also runs the real lib/server/audience.
//
// What is pinned:
//   * each route answers the facade's value in §2.10's shape, cut to its keys,
//     with `rev` from status() read before the call;
//   * every query parameter's default, its bounds, and a 400 for each malformed
//     value — before the facade is asked anything; an id over 128 characters is
//     404;
//   * null → 404; {unavailable:true}, a rejection coded 'unavailable' and no
//     mirror at all → 503; disabled → 200 with the hint; a throw → 500 that
//     names no file, to the client or the host's log;
//   * the gate: requireMirror('read') on all four, refusing a remote viewer
//     below `read` with the hint and letting a local one through;
//   * attachments: the five types sent with the four security headers; any
//     other type, an SVG, HTML, 21 MiB or a body that is not bytes is 404;
//   * no path to a Claude Code file is ever returned;
//   * the route module requires neither fs nor lib/core/claude-files.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { request } = require('../lib/client');
const {
  atLeast, fromOptIn, classify, MIRROR_HINT, MIRROR_FULL_HINT,
} = require('../lib/core/remote-policy');
const { isRemoteRequest } = require('../lib/core/cors');
const { createAudience } = require('../lib/server/audience');
const { disabledBody } = require('../lib/server/routes/mirror');
const {
  mountMirrorContentRoutes, ID_MAX, LIMIT_DEFAULT, LIMIT_MAX, FIELD_MAX, ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES,
} = require('../lib/server/routes/mirror-content');

const REPO_ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(REPO_ROOT, 'lib/server/routes/mirror-content.js');

// ── fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_780_000_000_000;
const CID = '0b6c1f4e-3f2a-4c7e-9d5b-2a1f8e6c4d10';
const TURN_ID = 'p_7f3a9c0d2e1b';
const ITEM_ID = 'i_7f3a9c0d2e1b_3';

const ITEM = {
  id: ITEM_ID, turn_id: TURN_ID, kind: 'tool_call', tool: 'Bash', status: 'done', seq: 3,
  input: { command: 'npm test' }, result: { text: 'ok 1 - passes', truncated: false },
};
const TURN = {
  id: TURN_ID, conversation_id: CID, seq: 7, kind: 'prompt', author: 'user', status: 'closed',
  started_at: NOW - 60_000, ended_at: NOW - 30_000, prompt: 'run the tests', reply_preview: 'All green.',
  counts: { items: 4, tools: 1, tool_errors: 0, agents: 0, tasks: 0, edits: 0 },
};
const TURNS_BODY = { conversation_id: CID, turns: [{ ...TURN, items: [ITEM] }], next_before: 7, total: 12 };
const TURN_BODY = { turn: TURN, items: [ITEM] };
const FIELD_BODY = { id: ITEM_ID, field: 'result', text: 'ok 1 - passes\n', from: 0, to: 14, total: 40, eof: false };

// A small PNG's first bytes, and a PDF's; the route never sniffs, it serves
// what the source checked (notes-A decision 11).
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

const STATUS = { rev: 42, now: NOW, aggregate: { state: 'idle' }, conversations: [] };

// ── fakes and the host ──────────────────────────────────────────────────────

// The facade. Each content answer may be a function of the call's arguments
// (to answer per call, throw or reject). `calls` logs every read in order.
function fakeMirror({
  status = STATUS, on = { enabled: true }, ready = Promise.resolve(),
  turns = TURNS_BODY, turn = TURN_BODY, itemField = FIELD_BODY, attachment = { media_type: 'image/png', bytes: PNG },
} = {}) {
  const answer = (v, args) => (typeof v === 'function' ? v(...args) : v);
  const m = {
    calls: [],
    answers: { status, turns, turn, itemField, attachment },
    on,
    ready,
    enabled() { m.calls.push(['enabled']); return m.on; },
    status() { m.calls.push(['status']); return answer(m.answers.status, []); },
    turns(...args) { m.calls.push(['turns', ...args]); return Promise.resolve().then(() => answer(m.answers.turns, args)); },
    turn(...args) { m.calls.push(['turn', ...args]); return Promise.resolve().then(() => answer(m.answers.turn, args)); },
    itemField(...args) {
      m.calls.push(['itemField', ...args]);
      return Promise.resolve().then(() => answer(m.answers.itemField, args));
    },
    attachment(...args) {
      m.calls.push(['attachment', ...args]);
      return Promise.resolve().then(() => answer(m.answers.attachment, args));
    },
  };
  return m;
}
const contentCalls = (m) => m.calls.filter((c) => !['enabled', 'status'].includes(c[0]));

// §5.4's gate on the real level order and hints: a plain loopback request is
// `local`; one with the portal's label gets the project's opt-in ('off' is
// `basic`).
function fakeAudience({ optIn = 'off' } = {}) {
  const a = {
    optIn,
    needs: [],
    levelOf(req) { return isRemoteRequest(req) ? fromOptIn(a.optIn) : 'local'; },
    requireMirror(need) {
      a.needs.push(need);
      return (req, res, next) => {
        const level = a.levelOf(req);
        if (atLeast(level, need)) return next();
        return res.status(403).json({ ok: false, mirror: level, remote: isRemoteRequest(req),
          hint: need === 'full' ? MIRROR_FULL_HINT : MIRROR_HINT });
      };
    },
  };
  return a;
}

async function host(t, { mirror = fakeMirror(), audience = fakeAudience(), opts } = {}) {
  const app = express();
  app.use(express.json());
  const ctx = { audience };
  if (mirror) ctx.mirror = mirror;
  mountMirrorContentRoutes(app, ctx, opts);
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const { port } = srv.address();
  const headersOf = (remote) => (remote ? { 'X-WC-Remote': '1' } : {});
  // JSON through lib/client, as a host process asks; `remote` adds the label
  // the portal puts on every request it forwards.
  const get = (p, { remote = false } = {}) => request(port, 'GET', p, null, { headers: headersOf(remote), timeout: 30000 });
  // Bytes and headers, for the attachment route.
  const raw = async (p, { remote = false } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: headersOf(remote) });
    return { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) };
  };
  return { get, raw, mirror, audience, ctx };
}

const enc = encodeURIComponent;
const TURNS_URL = `/api/mirror/conversations/${CID}/turns`;
const TURN_URL = `/api/mirror/turns/${TURN_ID}`;
const ITEM_URL = `/api/mirror/items/${ITEM_ID}`;
const ATTACH_URL = (n = 0) => `/api/mirror/items/${ITEM_ID}/attachments/${n}`;
// The four routes, with the facade method each dispatches to and the answer
// key on the fake.
const ROUTES = [
  { url: TURNS_URL, method: 'turns', json: true },
  { url: TURN_URL, method: 'turn', json: true },
  { url: ITEM_URL, method: 'itemField', json: true },
  { url: ATTACH_URL(0), method: 'attachment', json: false },
];

// ── the bodies ──────────────────────────────────────────────────────────────

test('GET …/conversations/:cid/turns: the facade\'s page in §2.10\'s shape, its defaults, and rev read before the call', async (t) => {
  const m = fakeMirror();
  // The facade moves on while the read runs: a frame newer than the body's rev
  // is what the chrome re-applies, so the body must carry the rev from before.
  m.answers.turns = () => { m.answers.status = { ...STATUS, rev: 43 }; return TURNS_BODY; };
  const h = await host(t, { mirror: m });
  const r = await h.get(TURNS_URL);
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.body, { ...TURNS_BODY, rev: 42 });
  assert.deepStrictEqual(m.calls, [['enabled'], ['status'],
    ['turns', CID, { before: null, limit: LIMIT_DEFAULT, items: 'summary' }]],
  'status first; `items` defaults to summary (ruled 2026-10-04), `limit` to 20, `before` to none');
  // The next page: next_before handed back as before.
  const r2 = await h.get(`${TURNS_URL}?before=${r.body.next_before}&limit=5&items=none`);
  assert.equal(r2.status, 200);
  assert.deepStrictEqual(r2.body.rev, 43);
  assert.deepStrictEqual(contentCalls(m)[1], ['turns', CID, { before: 7, limit: 5, items: 'none' }]);
});

test('GET /api/mirror/turns/:turnId: {turn, items, rev}', async (t) => {
  const m = fakeMirror();
  m.answers.turn = () => { m.answers.status = { ...STATUS, rev: 50 }; return TURN_BODY; };
  const h = await host(t, { mirror: m });
  const r = await h.get(TURN_URL);
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.body, { ...TURN_BODY, rev: 42 });
  assert.deepStrictEqual(m.calls, [['enabled'], ['status'], ['turn', TURN_ID]]);
});

test('GET /api/mirror/items/:itemId: {id, field, text, from, to, total, eof, rev}, and `to` passed back as `from` pages on', async (t) => {
  const m = fakeMirror();
  // A field in pages of `max` characters, as the source answers it: `to` is
  // where the next page starts.
  const FULL = 'line one\nline two\nline three\n';
  m.answers.itemField = (id, q) => {
    const text = FULL.slice(q.from, q.from + q.max);
    const to = q.from + text.length;
    return { id, field: q.field, text, from: q.from, to, total: FULL.length, eof: to >= FULL.length };
  };
  const h = await host(t, { mirror: m });
  const first = await h.get(ITEM_URL);
  assert.equal(first.status, 200);
  assert.deepStrictEqual(first.body, { id: ITEM_ID, field: 'text', text: FULL, from: 0, to: FULL.length,
    total: FULL.length, eof: true, rev: 42 });
  assert.deepStrictEqual(contentCalls(m)[0], ['itemField', ITEM_ID, { field: 'text', from: 0, max: FIELD_MAX }],
    'the defaults: field text, from 0, max 262144');
  // Paged: every character arrives exactly once.
  let from = 0;
  let got = '';
  for (let i = 0; i < 20; i++) {
    const r = await h.get(`${ITEM_URL}?field=result&from=${from}&max=7`);
    assert.equal(r.status, 200);
    got += r.body.text;
    if (r.body.eof) break;
    from = r.body.to;
  }
  assert.equal(got, FULL);
  assert.ok(contentCalls(m).slice(1).every((c) => c[2].field === 'result' && c[2].max === 7));
});

test('GET …/attachments/:n: each allowed type is sent as bytes with the four security headers', async (t) => {
  const m = fakeMirror();
  const h = await host(t, { mirror: m });
  const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1');
  // Each binary form the facade lets through untouched (typed arrays and
  // ArrayBuffers): a Buffer, a Uint8Array view into a larger buffer, an ArrayBuffer.
  const forms = [
    (b) => b,
    (b) => { const big = new Uint8Array(b.length + 8); big.set(b, 4); return big.subarray(4, 4 + b.length); },
    (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length),
  ];
  for (const type of ATTACHMENT_TYPES) {
    for (const form of forms) {
      const bytes = type === 'application/pdf' ? PDF : PNG;
      m.answers.attachment = { media_type: type, bytes: form(bytes), name: 'shot.png' };
      const r = await h.raw(ATTACH_URL(2));
      assert.equal(r.status, 200, type);
      assert.ok(r.bytes.equals(bytes), `${type}: the bytes as the source decoded them`);
      assert.equal(r.headers.get('content-type'), type);
      assert.equal(r.headers.get('content-length'), String(bytes.length));
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; sandbox");
      assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
      assert.equal(r.headers.get('cache-control'), 'no-cache');
    }
  }
  assert.deepStrictEqual(ATTACHMENT_TYPES, ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
  assert.ok(contentCalls(m).every((c) => c[0] === 'attachment' && c[1] === ITEM_ID && c[2] === 2),
    'n is handed over as a number');
  assert.ok(!m.calls.some((c) => c[0] === 'status'), 'bytes carry no rev, so the status is not read');
});

test('GET …/attachments/:n: HTML, an SVG, any other type, 21 MiB and a body that is not bytes are 404', async (t) => {
  const m = fakeMirror();
  const h = await host(t, { mirror: m });
  const refused = [
    { media_type: 'text/html', bytes: Buffer.from('<script>alert(1)</script>') },
    { media_type: 'image/svg+xml', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>') },
    { media_type: 'image/png; charset=utf-8', bytes: PNG },
    { media_type: 'IMAGE/PNG', bytes: PNG },
    { media_type: 'application/octet-stream', bytes: PNG },
    { media_type: 'image/bmp', bytes: PNG },
    { bytes: PNG },
    { media_type: 'image/png', bytes: PNG.toString('base64') },
    { media_type: 'image/png', bytes: [...PNG] },
    { media_type: 'image/png' },
    { media_type: 'image/png', bytes: Buffer.alloc(21 * 1024 * 1024) },
    { media_type: 'image/png', bytes: Buffer.alloc(ATTACHMENT_MAX_BYTES + 1) },
  ];
  for (const a of refused) {
    m.answers.attachment = a;
    const r = await h.get(ATTACH_URL(0));
    assert.equal(r.status, 404, `${a.media_type} ${a.bytes && a.bytes.length}`);
    assert.deepStrictEqual(r.body, { ok: false, error: 'not found' });
  }
  // The cap itself is allowed.
  m.answers.attachment = { media_type: 'image/webp', bytes: Buffer.alloc(ATTACHMENT_MAX_BYTES, 7) };
  const at = await h.raw(ATTACH_URL(0));
  assert.equal(at.status, 200);
  assert.equal(at.bytes.length, 20 * 1024 * 1024);
});

// ── parameters ──────────────────────────────────────────────────────────────

test('query parameters: defaults, the bounds accepted, and a 400 for each malformed value before the facade is asked', async (t) => {
  const m = fakeMirror();
  const h = await host(t, { mirror: m });

  const ok = [
    [`${TURNS_URL}?limit=1`, ['turns', CID, { before: null, limit: 1, items: 'summary' }]],
    [`${TURNS_URL}?limit=${LIMIT_MAX}`, ['turns', CID, { before: null, limit: 50, items: 'summary' }]],
    [`${TURNS_URL}?limit=007`, ['turns', CID, { before: null, limit: 7, items: 'summary' }]],
    [`${TURNS_URL}?before=0`, ['turns', CID, { before: 0, limit: 20, items: 'summary' }]],
    [`${TURNS_URL}?before=12.5`, ['turns', CID, { before: 12.5, limit: 20, items: 'summary' }]],
    [`${TURNS_URL}?items=none`, ['turns', CID, { before: null, limit: 20, items: 'none' }]],
    [`${TURNS_URL}?items=summary`, ['turns', CID, { before: null, limit: 20, items: 'summary' }]],
    [`${TURNS_URL}?items=full`, ['turns', CID, { before: null, limit: 20, items: 'full' }]],
    [`${ITEM_URL}?field=input`, ['itemField', ITEM_ID, { field: 'input', from: 0, max: FIELD_MAX }]],
    [`${ITEM_URL}?field=result`, ['itemField', ITEM_ID, { field: 'result', from: 0, max: FIELD_MAX }]],
    [`${ITEM_URL}?field=text&from=0&max=1`, ['itemField', ITEM_ID, { field: 'text', from: 0, max: 1 }]],
    [`${ITEM_URL}?from=9007199254&max=262144`, ['itemField', ITEM_ID, { field: 'text', from: 9007199254, max: 262144 }]],
    [`${TURN_URL}?ignored=1`, ['turn', TURN_ID]],
  ];
  for (const [url, call] of ok) {
    m.calls.length = 0;
    const r = await h.get(url);
    assert.equal(r.status, 200, url);
    assert.deepStrictEqual(contentCalls(m), [call], url);
  }
  m.calls.length = 0;
  assert.equal((await h.raw(ATTACH_URL(0))).status, 200);
  assert.equal((await h.raw(ATTACH_URL(17))).status, 200);
  assert.deepStrictEqual(contentCalls(m), [['attachment', ITEM_ID, 0], ['attachment', ITEM_ID, 17]]);

  const bad = [
    ['limit', TURNS_URL, ['0', '51', '-1', '1.5', 'abc', '', ' 5', '1e1', '0x10', '99999999999999999']],
    ['before', TURNS_URL, ['-1', 'abc', '', '1e3', 'Infinity', 'NaN', '.5', '5.', ' 1']],
    ['items', TURNS_URL, ['FULL', 'some', '', 'none ']],
    ['field', ITEM_URL, ['foo', 'TEXT', '', 'path']],
    ['from', ITEM_URL, ['-1', 'x', '1.5', '', '1e2']],
    ['max', ITEM_URL, ['0', String(FIELD_MAX + 1), '-5', 'x', '']],
  ];
  for (const [name, base, values] of bad) {
    for (const v of values) {
      m.calls.length = 0;
      const url = `${base}?${name}=${enc(v)}`;
      const r = await h.get(url);
      assert.equal(r.status, 400, url);
      assert.equal(r.body.ok, false, url);
      assert.ok(typeof r.body.error === 'string' && r.body.error.startsWith(`${name}: `), `${url}: ${JSON.stringify(r.body)}`);
      assert.deepStrictEqual(m.calls, [], `${url}: the facade is not asked`);
    }
  }
  // A parameter given twice is no single value.
  for (const url of [`${TURNS_URL}?limit=5&limit=6`, `${ITEM_URL}?field=text&field=input`, `${TURNS_URL}?before[a]=1`]) {
    const r = await h.get(url);
    assert.equal(r.status, 400, url);
  }
  // n, the attachment's index.
  for (const n of ['-1', 'x', '1.5', '1e2', '99999999999999999']) {
    m.calls.length = 0;
    const r = await h.get(`/api/mirror/items/${ITEM_ID}/attachments/${enc(n)}`);
    assert.equal(r.status, 400, n);
    assert.ok(r.body.error.startsWith('n: '));
    assert.deepStrictEqual(m.calls, []);
  }
});

test('path ids pass through as given; one over 128 characters is 404 and asks nothing', async (t) => {
  const m = fakeMirror();
  const h = await host(t, { mirror: m });
  const longest = 'a'.repeat(ID_MAX);
  const odd = 'p_x y/z.ü';
  for (const id of [longest, odd]) {
    m.calls.length = 0;
    assert.equal((await h.get(`/api/mirror/conversations/${enc(id)}/turns`)).status, 200);
    assert.equal((await h.get(`/api/mirror/turns/${enc(id)}`)).status, 200);
    assert.equal((await h.get(`/api/mirror/items/${enc(id)}`)).status, 200);
    assert.equal((await h.raw(`/api/mirror/items/${enc(id)}/attachments/0`)).status, 200);
    assert.deepStrictEqual(contentCalls(m).map((c) => c[1]), [id, id, id, id], 'the id as given');
  }
  m.calls.length = 0;
  const tooLong = 'a'.repeat(ID_MAX + 1);
  for (const url of [`/api/mirror/conversations/${tooLong}/turns`, `/api/mirror/turns/${tooLong}`,
    `/api/mirror/items/${tooLong}`, `/api/mirror/items/${tooLong}/attachments/0`]) {
    const r = await h.get(url);
    assert.equal(r.status, 404, url);
    assert.deepStrictEqual(r.body, { ok: false, error: 'not found' });
  }
  assert.deepStrictEqual(m.calls, []);
});

// ── the shared answers ──────────────────────────────────────────────────────

test('a source answering null is 404 {ok:false, error:\'not found\'}', async (t) => {
  for (const nothing of [null, undefined]) {
    const m = fakeMirror();
    Object.assign(m.answers, { turns: nothing, turn: nothing, itemField: nothing, attachment: nothing });
    const h = await host(t, { mirror: m });
    for (const { url } of ROUTES) {
      const r = await h.get(url);
      assert.equal(r.status, 404, url);
      assert.deepStrictEqual(r.body, { ok: false, error: 'not found' });
    }
  }
});

test('a source not registered yet is 503 {ok:false, unavailable:true}: the answer, a rejection coded so, and no mirror', async (t) => {
  const unavailable = { unavailable: true };
  const rejecting = () => Promise.reject(Object.assign(new Error('transcripts is not registered'), { code: 'unavailable' }));
  for (const answer of [unavailable, rejecting]) {
    const h = await host(t, { mirror: fakeMirror({ turns: answer, turn: answer, itemField: answer, attachment: answer }) });
    for (const { url } of ROUTES) {
      const r = await h.get(url);
      assert.equal(r.status, 503, url);
      assert.deepStrictEqual(r.body, { ok: false, unavailable: true });
    }
  }
  // The facade's status unavailable.
  const st = await host(t, { mirror: fakeMirror({ status: { unavailable: true } }) });
  for (const { url } of ROUTES.filter((x) => x.json)) {
    assert.deepStrictEqual((await st.get(url)).body, { ok: false, unavailable: true });
  }
  // No mirror wired at all.
  const none = await host(t, { mirror: null });
  for (const { url } of ROUTES) {
    const r = await none.get(url);
    assert.equal(r.status, 503, url);
    assert.deepStrictEqual(r.body, { ok: false, unavailable: true });
  }
});

test('a disabled mirror: 200 {ok:false, disabled:true, scope, hint}, the content never read', async (t) => {
  for (const scope of ['project', 'user', 'session']) {
    const m = fakeMirror({ on: { enabled: false, scope } });
    const h = await host(t, { mirror: m });
    for (const { url } of ROUTES) {
      const r = await h.get(url);
      assert.equal(r.status, 200, url);
      assert.deepStrictEqual(r.body, disabledBody(scope));
      assert.match(r.body.hint, /claude-web-chat on/);
    }
    assert.deepStrictEqual(contentCalls(m), []);
  }
  assert.match(disabledBody('user').hint, /--global/);
});

test('a throw is 500 with a message-free body: no file named to the client or in the host\'s log', async (t) => {
  const SECRET_PATH = '/Users/me/.claude/projects/-Users-me-Dev-x/0b6c1f4e-3f2a-4c7e-9d5b-2a1f8e6c4d10.jsonl';
  const boom = () => { throw Object.assign(new Error(`ENOENT: no such file, open '${SECRET_PATH}'`), { code: 'ENOENT' }); };
  const rejecting = () => Promise.reject(new Error(`EACCES ${SECRET_PATH}`));
  const logged = [];
  const orig = console.error;
  console.error = (...a) => { logged.push(a.join(' ')); };
  t.after(() => { console.error = orig; });
  const ALL = ROUTES.map((r) => r.url);
  const JSON_ONLY = ROUTES.filter((r) => r.json).map((r) => r.url);
  const cases = [
    [fakeMirror({ turns: boom, turn: boom, itemField: boom, attachment: boom }), ALL],
    [fakeMirror({ turns: rejecting, turn: rejecting, itemField: rejecting, attachment: rejecting }), ALL],
    // An answer that is no object is a fault, never a body.
    [fakeMirror({ turns: SECRET_PATH, turn: [SECRET_PATH], itemField: 42, attachment: SECRET_PATH }), ALL],
    // The status read before the call (the attachment route reads none).
    [fakeMirror({ status: () => { throw new Error(SECRET_PATH); } }), JSON_ONLY],
    [fakeMirror({ status: SECRET_PATH }), JSON_ONLY],
  ];
  for (const [m, urls] of cases) {
    const h = await host(t, { mirror: m });
    for (const url of urls) {
      const r = await h.get(url);
      assert.equal(r.status, 500, url);
      assert.deepStrictEqual(r.body, { ok: false, error: 'the chat mirror could not answer' });
    }
  }
  console.error = orig;
  assert.ok(logged.length > 0);
  for (const line of logged) {
    assert.ok(!line.includes('.claude') && !line.includes('/Users/') && !line.includes('no such file'), line);
  }
});

test('the wait on mirror.ready is bounded: a start that never settles still gets an answer', async (t) => {
  const h = await host(t, { mirror: fakeMirror({ ready: new Promise(() => {}) }), opts: { readyWaitMs: 50 } });
  const r = await h.get(TURN_URL);
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.body, { ...TURN_BODY, rev: 42 });
});

// ── the gate ────────────────────────────────────────────────────────────────

test('requireMirror(\'read\') on all four: a remote viewer below read gets the 403 hint, local, read and full get through', async (t) => {
  const m = fakeMirror();
  const audience = fakeAudience();
  const h = await host(t, { mirror: m, audience });
  assert.deepStrictEqual(audience.needs, ['read'], 'one gate, at read, in front of every route');
  for (const { url } of ROUTES) {
    audience.optIn = 'off';
    m.calls.length = 0;
    const refused = await h.get(url, { remote: true });
    assert.equal(refused.status, 403, url);
    assert.deepStrictEqual(refused.body, { ok: false, mirror: 'basic', remote: true, hint: MIRROR_HINT });
    assert.deepStrictEqual(m.calls, [], `${url}: a refused viewer asks the facade nothing`);
    assert.equal((await h.get(url)).status, 200, `${url} local`);
    for (const optIn of ['read', 'full']) {
      audience.optIn = optIn;
      assert.equal((await h.get(url, { remote: true })).status, 200, `${url} remote ${optIn}`);
    }
  }
});

test('the real audience gate: with no opt-in a remote request is refused with the mirror hint, a local one passes', async (t) => {
  const audience = createAudience({ configFile: null });
  t.after(() => audience.stop());
  const m = fakeMirror();
  const h = await host(t, { mirror: m, audience });
  for (const { url } of ROUTES) {
    const refused = await h.get(url, { remote: true });
    assert.equal(refused.status, 403, url);
    assert.deepStrictEqual(refused.body, { ok: false, mirror: 'basic', remote: true, hint: MIRROR_HINT });
    assert.equal((await h.get(url)).status, 200, url);
  }
  // The portal's table agrees: GET at read, every other method host-only.
  for (const { url } of ROUTES) {
    assert.equal(classify('GET', url, { mirror: 'off' }).reason, 'mirror', url);
    assert.equal(classify('GET', url, { mirror: 'read' }).allow, true, url);
    assert.equal(classify('POST', url, { mirror: 'full' }).allow, false, url);
  }
});

test('mounting without an audience gate throws rather than serve the conversation ungated', () => {
  const app = express();
  assert.throws(() => mountMirrorContentRoutes(app, { mirror: fakeMirror() }), /ctx\.audience/);
  assert.throws(() => mountMirrorContentRoutes(app, { mirror: fakeMirror(), audience: {} }), /requireMirror/);
});

// ── no path, no file access ─────────────────────────────────────────────────

test('no path to a Claude Code file is ever returned: a body is cut to §2.10\'s keys', async (t) => {
  const PATHS = {
    file: '/Users/me/.claude/projects/-Users-me-Dev-x/0b6c1f4e.jsonl',
    transcript_path: '~/.claude/projects/-Users-me-Dev-x/0b6c1f4e.jsonl',
    tool_results_path: '~/.claude/projects/x/0b6c1f4e/tool-results/toolu_01.txt',
    output_file: '/private/tmp/claude-501/x/tasks/bx81k2.output',
  };
  const m = fakeMirror({
    turns: { ...TURNS_BODY, ...PATHS },
    turn: { ...TURN_BODY, ...PATHS },
    itemField: { ...FIELD_BODY, ...PATHS },
  });
  const h = await host(t, { mirror: m });
  const want = [
    [TURNS_URL, ['conversation_id', 'next_before', 'rev', 'total', 'turns']],
    [TURN_URL, ['items', 'rev', 'turn']],
    [ITEM_URL, ['eof', 'field', 'from', 'id', 'rev', 'text', 'to', 'total']],
  ];
  for (const [url, keys] of want) {
    const r = await h.get(url);
    assert.equal(r.status, 200, url);
    assert.deepStrictEqual(Object.keys(r.body).sort(), keys, url);
    const text = JSON.stringify(r.body);
    for (const s of ['.jsonl', 'tool-results', '.output', '/.claude/', '/Users/']) {
      assert.ok(!text.includes(s), `${url} carries ${JSON.stringify(s)}`);
    }
  }
  // An attachment's name is metadata: it is never a header.
  m.answers.attachment = { media_type: 'image/png', bytes: PNG, name: PATHS.file, path: PATHS.file };
  const a = await h.raw(ATTACH_URL(0));
  assert.equal(a.status, 200);
  for (const [k, v] of a.headers) assert.ok(!v.includes('.claude') && !v.includes('/Users/'), `${k}: ${v}`);
  assert.equal(a.headers.get('content-disposition'), null);
});

test('the route module is thin: it requires neither fs nor lib/core/claude-files, only routes/mirror.js', () => {
  const src = fs.readFileSync(MODULE, 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  const requires = [...code.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((x) => x[2]);
  assert.deepStrictEqual(requires, ['./mirror']);
  assert.ok(!/require\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/.test(code), 'fs');
  assert.ok(!/claude-files/.test(code), 'lib/core/claude-files');
  assert.ok(!/\bimport\s*\(/.test(code), 'no dynamic import');
  // Nor does it redact or fence on its own (§2.9: the source's and the facade's).
  assert.ok(!/\bredact\w*\s*\(|\bfence\s*\(|readWindow|sessionDirFile/.test(code));
});
