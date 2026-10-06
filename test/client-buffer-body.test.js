// lib/client request() with a Buffer body (spec §9.6, §11.2's "Buffer body").
//
// The identity CLI uploads the image the pipeline made to PUT /api/project/*,
// and those bytes must arrive exactly: on 2026-10-02 two of three images
// hand-copied into a render call arrived corrupted (D11). Before this, request()
// JSON-serialised every non-string body, so a Buffer went out as
// {"type":"Buffer","data":[…]} under application/json.
//
// What must hold:
//   * a Buffer arrives byte-identical, with the caller's Content-Type and its
//     byte length as Content-Length;
//   * a Buffer with no Content-Type goes as application/octet-stream, never
//     application/json;
//   * a string and an object are sent exactly as before (an object as JSON under
//     application/json; a string as it is).
//
// A raw stub server, as test/client-contract.test.js uses: what is under test is
// what the client puts on the wire.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');

const client = require('../lib/client');

// A stub that records each request's headers and its body, byte for byte.
function recorder(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  t.after(() => new Promise((r) => server.close(r)));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen }));
  });
}

// Every byte value, a few times over, with a run that is not valid UTF-8 — a
// body a string round trip would mangle.
const BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(Array.from({ length: 768 }, (_, i) => i % 256)), Buffer.from([0xc3, 0x28, 0xff, 0xfe])]);

test('a Buffer body arrives byte-identical, with the caller\'s Content-Type and its byte length', async (t) => {
  const { port, seen } = await recorder(t);
  const r = await client.request(port, 'PUT', '/api/project/logo', BYTES, { headers: { 'Content-Type': 'image/png' } });
  assert.equal(r.status, 200);
  assert.equal(seen.length, 1);
  const got = seen[0];
  assert.equal(got.method, 'PUT');
  assert.ok(got.body.equals(BYTES), 'the bytes on the wire are the bytes given');
  assert.equal(crypto.createHash('sha256').update(got.body).digest('hex'),
    crypto.createHash('sha256').update(BYTES).digest('hex'));
  assert.equal(got.headers['content-type'], 'image/png');
  assert.equal(got.headers['content-length'], String(BYTES.length));
});

test('a caller\'s Content-Type in any case is the one sent, never doubled', async (t) => {
  const { port, seen } = await recorder(t);
  await client.request(port, 'PUT', '/x', BYTES, { headers: { 'content-type': 'image/svg+xml' } });
  assert.equal(seen[0].headers['content-type'], 'image/svg+xml');
  assert.ok(seen[0].body.equals(BYTES));
});

test('a Buffer with no Content-Type goes as application/octet-stream, never application/json', async (t) => {
  const { port, seen } = await recorder(t);
  await client.request(port, 'POST', '/x', BYTES);
  assert.equal(seen[0].headers['content-type'], 'application/octet-stream');
  assert.equal(seen[0].headers['content-length'], String(BYTES.length));
  assert.ok(seen[0].body.equals(BYTES));
});

test('an empty Buffer is sent as zero bytes, labelled and sized', async (t) => {
  const { port, seen } = await recorder(t);
  await client.request(port, 'PUT', '/x', Buffer.alloc(0), { headers: { 'Content-Type': 'image/png' } });
  assert.equal(seen[0].headers['content-length'], '0');
  assert.equal(seen[0].headers['content-type'], 'image/png');
  assert.equal(seen[0].body.length, 0);
});

test('a string and an object are sent exactly as before', async (t) => {
  const { port, seen } = await recorder(t);
  const obj = { name: 'Acme Web — ✓', n: 1 };
  await client.request(port, 'PUT', '/api/project/name', obj);
  assert.equal(seen[0].headers['content-type'], 'application/json');
  assert.equal(seen[0].body.toString('utf8'), JSON.stringify(obj));
  assert.equal(seen[0].headers['content-length'], String(Buffer.byteLength(JSON.stringify(obj))));

  const str = '{"already":"json","é":true}';
  await client.request(port, 'POST', '/x', str);
  assert.equal(seen[1].headers['content-type'], 'application/json');
  assert.equal(seen[1].body.toString('utf8'), str);
  assert.equal(seen[1].headers['content-length'], String(Buffer.byteLength(str)));

  await client.request(port, 'POST', '/x', 'plain', { headers: { 'Content-Type': 'text/plain' } });
  assert.equal(seen[2].headers['content-type'], 'text/plain', 'a caller\'s header still wins over the JSON default');
  assert.equal(seen[2].body.toString('utf8'), 'plain');

  await client.request(port, 'GET', '/x');
  assert.equal(seen[3].headers['content-type'], undefined, 'no body, no Content-Type');
  assert.equal(seen[3].body.length, 0);
});

test('api() passes a Buffer body and its headers through to the wire', async (t) => {
  const { port, seen } = await recorder(t);
  const out = await client.api('PUT', '/api/project/favicon', BYTES, { port, noSpawn: true, headers: { 'Content-Type': 'image/png' } });
  assert.deepEqual(out, { ok: true });
  assert.ok(seen[0].body.equals(BYTES));
  assert.equal(seen[0].headers['content-type'], 'image/png');
});
