// viewer_peers on GET /api/health (tranche 6 U753; 06 C-06.24, Q-06.13): the
// watchers split by peer — the two counts of ws.js getViewerSummary, a tunnel
// or relayed socket counted as remote — sent to a LOCAL request only, as
// `answer` is; `viewers` stays the one integer.
//
// The relay secret is a fresh random value per test process, carried only in
// request headers here: never printed. HOME is a sandbox (npm test's
// test-support/sandbox.js, and withServer's own), so the connector directory
// is a throwaway one.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { withServer, waitUntil, wsConnect } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const { LEVEL_HEADER, REMOTE_HEADER } = require('../lib/core/cors');
const { RELAY_HEADER } = require('../lib/core/writer-token');
const { createServer } = require('../lib/server');

const SECRET = crypto.randomBytes(32).toString('hex');

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});

const REMOTE_H = [REMOTE_HEADER, '1'];
const RELAYED_H = (stamp) => [REMOTE_H, [RELAY_HEADER, SECRET], [LEVEL_HEADER, stamp]];

// A daemon handed the relay secret, in connected mode with a full ceiling, and
// the project opted in to the tunnel at `optIn`.
async function boot(t, { optIn = 'full' } = {}) {
  let recordPath = null;
  return withServer(t, {
    seed: ({ root }) => {
      writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(root)]: optIn } } });
      const dir = userPaths().connectorDir;
      fs.mkdirSync(dir, { recursive: true });
      recordPath = path.join(dir, 'hub-test.json');
      writeJsonAtomic(recordPath, { record_version: 1, hub: { id: 'hub-test' }, ceiling: 'full' });
    },
    createServer: (o) => createServer({ ...o, relaySecret: SECRET, relaySecretVia: 'option', connectorRecord: recordPath }),
  });
}

// GET /api/health with headers as [[name, value], …] → {status, json, text}.
function health(port, headers = []) {
  return new Promise((resolve, reject) => {
    const h = {};
    for (const [k, v] of headers) h[k] = v;
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/health', agent: false, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
      res.on('error', reject);
    });
    r.on('error', reject);
    r.end();
  });
}

// A socket that has had its hello (so the daemon has counted it).
async function openSocket(t, port, headers = []) {
  const h = {};
  for (const [k, v] of headers) h[k] = v;
  const ws = wsConnect(port, '/ws', { headers: h });
  t.after(() => { try { ws.terminate(); } catch {} });
  let hello = false;
  ws.on('message', (data) => { try { if (JSON.parse(data.toString()).type === 'hello') hello = true; } catch {} });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await waitUntil(() => hello, { timeout: 10000, interval: 5, what: 'the hello' });
  return ws;
}

test('a local GET /api/health reports viewer_peers {local: 1, remote: 1} with one local and one relayed socket open, and viewers 2', async (t) => {
  const d = await boot(t);
  const before = await health(d.port);
  assert.equal(before.status, 200, before.text);
  assert.deepStrictEqual(before.json.viewer_peers, { local: 0, remote: 0 }, 'no socket: both zero, still sent');
  assert.equal(before.json.viewers, 0);

  await openSocket(t, d.port);
  await openSocket(t, d.port, RELAYED_H('full'));
  const r = await health(d.port);
  assert.equal(r.status, 200, r.text);
  assert.deepStrictEqual(r.json.viewer_peers, { local: 1, remote: 1 }, 'the relayed socket counts as remote');
  assert.deepStrictEqual(Object.keys(r.json.viewer_peers).sort(), ['local', 'remote'], 'the two counts only, never the last_* times');
  assert.equal(r.json.viewers, 2, 'viewers stays the one integer');
  assert.ok(r.json.answer === null || typeof r.json.answer === 'object', 'answer unchanged beside it');
});

test('a tunnel socket counts as remote; a labelled remote request and a relayed request get no viewer_peers', async (t) => {
  const d = await boot(t);
  await openSocket(t, d.port);
  await openSocket(t, d.port, [REMOTE_H]);
  await openSocket(t, d.port, RELAYED_H('full'));

  const local = await health(d.port);
  assert.equal(local.status, 200, local.text);
  assert.deepStrictEqual(local.json.viewer_peers, { local: 1, remote: 2 }, 'a tunnel socket and a relayed socket are both remote');
  assert.equal(local.json.viewers, 3);

  const cases = [
    ['a labelled remote request (X-WC-Remote: 1) at full', [REMOTE_H]],
    ['a relayed request stamped full', RELAYED_H('full')],
    ['a relayed request stamped read', RELAYED_H('read')],
  ];
  for (const [what, headers] of cases) {
    const r = await health(d.port, headers);
    assert.equal(r.status, 200, `${what}: ${r.text}`);
    assert.ok(!('viewer_peers' in r.json), `${what}: no viewer_peers (local only)`);
    assert.equal(r.json.answer, null, `${what}: answer is local only too`);
    assert.equal(r.json.viewers, 3, `${what}: viewers still the integer`);
  }
});

test('below read (a tunnel viewer of a project that has not opted in) gets no viewer_peers either', async (t) => {
  const off = await boot(t, { optIn: 'off' });
  await openSocket(t, off.port);
  const basic = await health(off.port, [REMOTE_H]);
  assert.equal(basic.status, 200, basic.text);
  assert.ok(!('viewer_peers' in basic.json), 'basic: no viewer_peers');
  assert.equal(basic.json.viewers, 1, 'basic: viewers still the integer');
  assert.deepStrictEqual((await health(off.port)).json.viewer_peers, { local: 1, remote: 0 }, 'the same daemon, asked locally');
});
