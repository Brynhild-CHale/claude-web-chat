// A straggler request cannot reopen the answer surface after teardown (U53c,
// spec §4.3, §10.1). Both teardown paths stop the asks domain and then close
// the answer surface (stopTurnControls in lib/server/index.js) BEFORE the HTTP
// server stops taking requests, and the surface's close() is re-openable (its
// idle close needs that). So a GET /api/asks?ensure=1 already riding a
// keep-alive connection, landing in that window, used to open a fresh
// listener plus its idle timer after teardown: a leaked handle.
//
// The race made deterministic: the server's own close() is held until the
// straggler has been answered, so the request lands after asks.stop() and the
// surface's close(), and before the server closes — on the real server
// (withServer), through the real route, the real asks domain and the real
// answer surface, on a keep-alive agent warmed before the teardown.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { withServer, waitUntil } = require('../test-support/helpers');

function get(agent, port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, agent, method: 'GET' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Listening handles in this process (each test file runs in its own). A closed
// server's handle is released a loop turn or two after its close callback, so
// both counts are read by waitUntil, never once.
const listeners = () => process.getActiveResourcesInfo().filter((r) => r === 'TCPServerWrap').length;

// Holds `srv.server.close` until the straggler GET has been answered, and
// returns that answer's promise. Both teardown paths call server.close() last
// of all (stop() directly, gracefulShutdown() through closeServer), after the
// asks and the answer surface have been stopped. gracefulShutdown() also hangs
// up idle keep-alive sockets just before (closeIdleConnections): that is held
// too, so the warmed connection is still there for the straggler to ride.
function stragglerAtClose(srv, agent, port) {
  const server = srv.server;
  const origClose = server.close.bind(server);
  const origIdle = server.closeIdleConnections;
  let answered = null;
  server.closeIdleConnections = () => {};
  server.close = (cb) => {
    answered = get(agent, port, '/api/asks?ensure=1');
    answered.catch(() => {}).then(() => {
      server.closeIdleConnections = origIdle;
      origClose(cb);
    });
    return server;
  };
  return () => answered;
}

for (const path of ['stop', 'graceful']) {
  test(`${path}(): an ensure=1 landing during teardown leaves no answer-surface listener`, async (t) => {
    await waitUntil(() => listeners() === 0, { what: 'no listener before the boot' });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    t.after(() => agent.destroy());
    const ctx = await withServer(t);
    const { srv, port } = ctx;
    // A red run must fail on the assertions, not hang the file on the leak.
    t.after(() => srv.answerSurface.close());

    // Warm the keep-alive connection; the surface is not started yet.
    const warm = await get(agent, port, '/api/asks');
    assert.equal(warm.status, 200);
    assert.equal(srv.answerSurface.port, null);

    const straggler = stragglerAtClose(srv, agent, port);
    await (path === 'stop' ? srv.stop() : ctx.graceful());

    const res = await straggler();
    assert.ok(res, 'the straggler reached the server during teardown');
    assert.equal(res.status, 200, 'the straggler is answered');
    assert.equal(res.json.answer, null, 'and handed no answer port');
    assert.equal(srv.answerSurface.port, null, 'the answer surface stays closed');
    agent.destroy();
    await waitUntil(() => listeners() === 0, { what: 'no listener handle left after teardown' });
  });
}
