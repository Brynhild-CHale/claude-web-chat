// POST /api/shutdown — the acknowledged shutdown request that replaced "fire a
// signal and hope".
//
// Mounted against a bare express app with a STUB triggerShutdown: the real one
// calls process.exit(0), which would take the test runner with it. The stub is
// the only thing faked — the gate, the ordering and the response shape are the
// production code from lib/server/routes/health.js.
//
// Note the two request helpers. `raw()` uses http.request, which is what
// lib/client (and therefore `stop`) actually sends — no fetch metadata. Node's
// global `fetch` sends `sec-fetch-mode: cors`, so it is deliberately on the
// browser side of this gate; the tests use it to stand in for a web page.

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('http');
const { mountHealthRoutes } = require('../lib/server/routes/health');
const { isBrowserRequest, SHUTDOWN_HEADER, SHUTDOWN_HEADER_VALUE } = require('../lib/core/cors');

const OK_HEADERS = { [SHUTDOWN_HEADER]: SHUTDOWN_HEADER_VALUE };

// Non-browser request, exactly as lib/client makes it.
function raw(port, method, pathStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathStr, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch {}
        resolve({ status: res.statusCode, json, body, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// A minimal daemon-shaped host for the health routes.
async function routeHost(t, { wire = true } = {}) {
  const app = express();
  app.use(express.json());
  const graph = { active: 'n1', nodes: new Map(), lock: null };
  const state = { calls: 0, responseEndedAtTrigger: null };
  // Keep a handle on the live response so the stub can record whether the reply
  // had already been written when the shutdown started — the ordering invariant.
  let lastRes = null;
  app.use((req, res, next) => { lastRes = res; next(); });
  mountHealthRoutes(app, {
    graph,
    bus: { bootId: 'boot-1' },
    ...(wire ? {
      triggerShutdown: () => {
        state.calls++;
        state.responseEndedAtTrigger = lastRes ? lastRes.writableEnded : null;
      },
    } : {}),
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    state,
    post: (headers) => raw(port, 'POST', '/api/shutdown', headers),
    async waitForTrigger(maxMs = 1000) {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        if (state.calls > 0) return true;
        await new Promise((r) => setTimeout(r, 10));
      }
      return false;
    },
  };
}

test('shutdown: a gated POST is ACKNOWLEDGED with a real response body', async (t) => {
  const { post } = await routeHost(t);
  const res = await post(OK_HEADERS);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.shutting_down, true);
  assert.equal(res.json.pid, process.pid, 'the ack names the process that is going away');
  // The whole point over SIGTERM: the caller got an answer, not a dropped socket.
});

test('shutdown: the ack is fully written BEFORE the shutdown runs', async (t) => {
  const { post, state, waitForTrigger } = await routeHost(t);
  const res = await post(OK_HEADERS);
  assert.equal(res.json.ok, true, 'the caller received a complete, parseable ack');
  assert.ok(await waitForTrigger(), 'the shutdown then runs');
  assert.equal(state.calls, 1, 'exactly one shutdown per request');
  // The invariant that makes the ack possible at all: gracefulShutdown drains
  // in-flight requests, so starting it before the reply was written would mean
  // waiting on this very request. Assert the response was already finished.
  assert.equal(state.responseEndedAtTrigger, true);
});

test('shutdown: the reply hangs up the socket so the drain cannot wait on it', async (t) => {
  const { post } = await routeHost(t);
  const res = await post(OK_HEADERS);
  assert.equal(res.headers.connection, 'close');
});

// ── the gate ───────────────────────────────────────────────────────────────
// A page the user visits can POST to http://127.0.0.1:<port> as a *simple*
// request. CORS only withholds the reply; the daemon would already be dead. So
// every one of these must be refused, and must not have triggered anything.

test('shutdown: a request from a browser is refused even with the header', async (t) => {
  const { post, state } = await routeHost(t);
  const res = await post({ ...OK_HEADERS, Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /Origin/);
  assert.equal(state.calls, 0, 'a refused request must not shut anything down');
});

test('shutdown: a LOCAL browser origin is refused too — the surface never kills its own daemon', async (t) => {
  const { post, base, state } = await routeHost(t);
  const res = await post({ ...OK_HEADERS, Origin: base });
  assert.equal(res.status, 403, 'isLocalOrigin is the wrong gate here: a pane script runs same-origin and needs no preflight');
  assert.equal(state.calls, 0);
});

test('shutdown: Fetch Metadata alone identifies a browser, with no Origin at all', async (t) => {
  const { post, state } = await routeHost(t);
  for (const h of ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user']) {
    const res = await post({ ...OK_HEADERS, [h]: 'cross-site' });
    assert.equal(res.status, 403, `${h} should mark the caller as a browser`);
  }
  assert.equal(state.calls, 0);
});

test("shutdown: Node's global fetch is on the browser side of the gate (fails closed)", async (t) => {
  const { base, state } = await routeHost(t);
  // undici sends `sec-fetch-mode: cors`. Documented, deliberate: local tooling
  // is expected to go through lib/client, which uses raw http.request.
  const res = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: OK_HEADERS });
  assert.equal(res.status, 403);
  assert.equal(state.calls, 0);
});

test('shutdown: a non-browser caller without the header is refused', async (t) => {
  const { post, state } = await routeHost(t);
  const res = await post({});
  assert.equal(res.status, 403);
  assert.match(res.json.error, new RegExp(SHUTDOWN_HEADER));
  assert.equal(state.calls, 0, 'a stray curl / link / form post cannot kill the daemon by accident');
});

test('shutdown: no CORS preflight is ever granted, so a browser cannot send the header', async (t) => {
  const { port, post } = await routeHost(t);
  // The custom header makes any cross-origin fetch non-simple: the browser must
  // preflight first. A preflight only succeeds if the OPTIONS response allows
  // the origin AND the header. This route grants neither, so the real request
  // never leaves the browser.
  const pre = await raw(port, 'OPTIONS', '/api/shutdown', {
    Origin: 'https://evil.example',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': SHUTDOWN_HEADER,
  });
  assert.equal(pre.headers['access-control-allow-origin'], undefined);
  assert.equal(pre.headers['access-control-allow-headers'], undefined);

  // And the success response is not CORS-readable either.
  const ok = await post(OK_HEADERS);
  assert.equal(ok.headers['access-control-allow-origin'], undefined);
});

test('shutdown: a server with no shutdown hook says so instead of pretending', async (t) => {
  const { post } = await routeHost(t, { wire: false });
  const res = await post(OK_HEADERS);
  assert.equal(res.status, 501);
  assert.equal(res.json.ok, false);
});

test('shutdown: GET /api/health still answers next to it', async (t) => {
  const { port } = await routeHost(t);
  const res = await raw(port, 'GET', '/api/health');
  assert.equal(res.json.ok, true);
  assert.equal(res.json.role, 'instance');
});

// ── the gate's own unit ────────────────────────────────────────────────────

test('isBrowserRequest: Origin or any Sec-Fetch-* means browser; nothing else does', () => {
  assert.equal(isBrowserRequest({}), false);
  assert.equal(isBrowserRequest(), false);
  assert.equal(isBrowserRequest({ 'user-agent': 'Mozilla/5.0' }), false, 'user-agent is forgeable and not a signal');
  assert.equal(isBrowserRequest({ 'content-type': 'application/json' }), false);
  assert.equal(isBrowserRequest({ origin: 'https://evil.example' }), true);
  assert.equal(isBrowserRequest({ origin: 'http://localhost:5173' }), true);
  assert.equal(isBrowserRequest({ 'sec-fetch-site': 'same-origin' }), true);
  assert.equal(isBrowserRequest({ 'sec-fetch-mode': 'cors' }), true);
  assert.equal(isBrowserRequest({ 'sec-fetch-dest': 'empty' }), true);
  assert.equal(isBrowserRequest({ 'sec-fetch-user': '?1' }), true);
});
