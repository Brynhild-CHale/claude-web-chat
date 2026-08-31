// The daemon HTTP client's OUTCOME CONTRACT (lib/client/index.js).
//
// Two holes lived here for the life of the engine, and both of them taught call
// sites the wrong idiom:
//
//   1. request() settled only on the response's 'end'. A daemon that died,
//      restarted or reset the socket AFTER the headers but BEFORE the body
//      completed emitted 'close' with res.complete === false and no 'end' — so
//      the promise never settled at all. With no default socket timeout (a
//      deliberate policy, so a driver's /api/wait long-poll works), every MCP
//      tool call, hook and CLI command behind api() hung forever.
//
//   2. a non-2xx threw a bare Error whose only content was a formatted message,
//      so nothing could branch on the status. lib/mcp/tools/export.js believed
//      client.get returned error BODIES (a dead `r.error` branch), while
//      profile reload / unlock believed the low-level request() threw on a 404
//      and printed success when it did not.
//
// These tests stand up a deliberately misbehaving HTTP server — no web-chat
// daemon involved — because what is under test is the client's behaviour when
// the thing on the other end does NOT behave.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const client = require('../lib/client');

// A raw stub, not test-support/withServer: the point is a server that violates
// the protocol, which the real daemon (correctly) never does.
function stub(t, handler) {
  const server = http.createServer(handler);
  t.after(() => new Promise((r) => server.close(r)));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('request() rejects when the socket dies mid-body instead of hanging forever', async (t) => {
  const port = await stub(t, (req, res) => {
    // Promise 64 bytes, send 11, then cut the connection — exactly what a daemon
    // being restarted or killed mid-response looks like on the wire.
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '64' });
    res.write('{"partial":');
    setTimeout(() => { res.socket.destroy(); }, 10);
  });

  const raced = await Promise.race([
    client.request(port, 'GET', '/api/health').then(
      (v) => ({ settled: 'resolved', v }),
      (e) => ({ settled: 'rejected', e }),
    ),
    new Promise((r) => setTimeout(() => r({ settled: 'hung' }), 3000)),
  ]);

  assert.equal(raced.settled, 'rejected', 'a truncated response must reject, never hang');
  assert.equal(raced.e.code, 'ECONNRESET',
    'the code must be one isConnRefused() recognises, so api() respawns instead of surfacing a novel error');
  assert.match(raced.e.message, /connection closed before the response completed/);
});

test('a mid-body death routes through api()\'s connection-refused path (no spawn -> NoServerError)', async (t) => {
  const port = await stub(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '64' });
    res.write('{"partial":');
    setTimeout(() => { res.socket.destroy(); }, 10);
  });

  // spawn is false here (the default), so api() converts a connection-refused
  // outcome into NoServerError rather than retrying. That it lands there at all
  // is the assertion: the truncated response was classified as a dead daemon.
  await assert.rejects(
    () => client.get('/api/health', { port }),
    (e) => e instanceof client.NoServerError && e.code === 'NO_SERVER',
  );
});

test('a non-2xx through post() is an HttpError carrying the status and the parsed body', async (t) => {
  const port = await stub(t, (req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'node not found' }));
  });

  await assert.rejects(
    () => client.post('/api/export/n9.9', {}, { port }),
    (e) => {
      assert.ok(e instanceof client.HttpError, 'a status error must be typed, not a bare Error');
      assert.equal(e.status, 404);
      assert.deepEqual(e.body, { error: 'node not found' }, 'the body is parsed and carried, not only formatted');
      assert.equal(e.method, 'POST');
      assert.equal(e.path, '/api/export/n9.9');
      // The message is unchanged from the bare Error it replaced.
      assert.equal(e.message, 'POST /api/export/n9.9 → 404: {"error":"node not found"}');
      return true;
    },
  );
});

test('a non-JSON error body (a 404 HTML page from an older daemon) still types', async (t) => {
  const port = await stub(t, (req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><p>Cannot POST /api/profiles/reload</p>');
  });

  await assert.rejects(
    () => client.post('/api/profiles/reload', {}, { port }),
    (e) => e instanceof client.HttpError && e.status === 404 && typeof e.body === 'string',
  );
});

test('request() still reports a status without throwing (the relay callers depend on it)', async (t) => {
  const port = await stub(t, (req, res) => {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  });
  const r = await client.request(port, 'GET', '/api/whatever');
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { ok: false });
});

test('an opt-in timeout still rejects with the timeout error, not the close error', async (t) => {
  const port = await stub(t, (req, res) => {
    // Headers out, body never finished and the socket never closed — the shape
    // that makes the timeout and the premature-close paths race.
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '64' });
    res.write('{"partial":');
  });

  await assert.rejects(
    () => client.request(port, 'GET', '/api/slow', null, { timeout: 150 }),
    // lib/hub's forward() maps exactly this message to 504; ECONNRESET would
    // make a slow instance look like a dead one (502).
    (e) => e.message === 'request timeout',
  );
});

// ---------------------------------------------------------------------------
// The callers that guessed wrong in both directions, now on the throwing path.
//
// `profile reload` and `unlock` used the never-throwing low-level request() and
// then read fields off the body without looking at the status: a daemon that
// predates the route answers 404 with an HTML body, which parses to a STRING, so
// both printed a success line for something they had not reached. These two
// drive the real commands against a stub daemon that 404s everything.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writePortfileAt } = require('../lib/core/portfiles');

// Run a CLI command with console + process.exit captured. Returns
// {out, err, exit} — exit is the code the command asked for, or null.
async function runCli(fn) {
  const out = [];
  const err = [];
  const realLog = console.log;
  const realErr = console.error;
  const realExit = process.exit;
  let exit = null;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  process.exit = (c) => { exit = c; throw new Error('__exit__'); };
  try { await fn(); } catch (e) { if (e.message !== '__exit__') throw e; } finally {
    console.log = realLog; console.error = realErr; process.exit = realExit;
  }
  return { out: out.join('\n'), err: err.join('\n'), exit };
}

test('`profile reload` reports a 404 as a failure instead of "reloaded undefined"', async (t) => {
  const port = await stub(t, (req, res) => {
    // What a daemon predating /api/profiles/reload actually sends: Express's
    // default 404 page, which JSON.parse cannot read, so body is a STRING.
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><p>Cannot POST /api/profiles/reload</p>');
  });
  const prev = process.env.WEB_CHAT_PORT;
  process.env.WEB_CHAT_PORT = String(port);
  t.after(() => { if (prev === undefined) delete process.env.WEB_CHAT_PORT; else process.env.WEB_CHAT_PORT = prev; });

  const profile = require('../lib/cli/commands/profile');
  const r = await runCli(() => profile(['reload']));
  assert.equal(r.exit, 1, 'a 404 must be a non-zero exit');
  assert.match(r.err, /reload failed/);
  assert.doesNotMatch(r.out, /reloaded/, 'and must never print the success line');
});

test('`unlock` reports a 404 as a failure instead of "no lock was set"', async (t) => {
  const port = await stub(t, (req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no such route' }));
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-unlock-'));
  const webChatDir = path.join(root, '.web-chat');
  fs.mkdirSync(webChatDir, { recursive: true });
  // The record `unlock` reads: a live pid (ours) on the stub's port.
  writePortfileAt(webChatDir, { pid: process.pid, port });
  const prevCwd = process.cwd();
  process.chdir(root);
  t.after(() => {
    try { process.chdir(prevCwd); } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  const unlock = require('../lib/cli/commands/unlock');
  const r = await runCli(() => unlock());
  assert.equal(r.exit, 1, 'a 404 must be a non-zero exit');
  assert.match(r.err, /unlock failed/);
  assert.doesNotMatch(r.out, /no lock was set|lock cleared/, 'and must never print a lock verdict it did not get');
});
