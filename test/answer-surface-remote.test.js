// Remote answering on the daemon's side (spec §4.6, §4.4 'the decide gate';
// rulings Q3 (ride), Q-C, Q2, Q9, E3 (a); U74): the answer surface's three
// remote knobs, and GET /api/health's answer port.
//   * createAnswerSurface with a fake audience: remoteAnswering() is false with
//     no audience and at the opt-ins 'off' and 'read', true at 'full';
//   * at 'full' an X-WC-Remote request whose own level is 'full' passes the
//     engine (document, view, decide — the decide marked remote); one whose
//     level is below (a network peer is basic) is refused;
//   * at 'read' every X-WC-Remote request is refused 403 with the hint naming
//     `tunnel mirror on`, and a refused decide is noted on the ask as 'remote';
//   * a domain refusal of a remote decide (403 'remote-off', an elicitation) is
//     noted on the ask's audit with origin 'remote';
//   * frameAncestors still names only the main port's two loopback origins
//     (the portal sets the public one, Q2 (a));
//   * GET /api/health answers `answer: {port}` to a local request and
//     `answer: null` to an X-WC-Remote request at basic, read and full and to a
//     network peer (ruled E3 (a));
//   * the chrome (test-support/chrome-shell): a remote page whose /api/health
//     carries NO X-WC-Answer-Origin offers neither the mod stopper's Kill frame
//     nor the fork-in-place turn action, even at full (U86's viewer rule:
//     remotely, a known answer origin). The case with the header, through a
//     real portal, is test/portal-answer.test.js's.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { withServer, withTempHome, tmpRoot } = require('../test-support/helpers');
const { createFakeAccess } = require('../test-support/fake-access');
const { createAnswerSurface } = require('../lib/server/answer-surface');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const client = require('../lib/client');

const MAIN = 54322;
const FONTS = path.join(__dirname, '..', 'public', 'fonts');
const ASK = 'ask_0a1b2c3d4e5f';
const PEER = '192.168.1.23';

const PUB = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-answer-remote-pub-'));
  fs.writeFileSync(path.join(dir, 'index.html'),
    '<!doctype html><html data-kind="{{KIND}}"><head><meta name="wc-answer-nonce" content="{{NONCE}}"></head><body></body></html>\n');
  fs.writeFileSync(path.join(dir, 'answer.js'), 'export {};\n');
  return dir;
})();
test.after(() => fs.rmSync(PUB, { recursive: true, force: true }));

// A fake ctx.asks: one pending ask, decide answered from a queue, every
// decide and noted refusal recorded.
function fakeAsks() {
  const out = {
    decides: [],
    refusals: [],
    results: [],
    pending: () => [{ id: ASK }],
    decide(id, decision, meta) {
      out.decides.push({ id, decision, meta });
      return out.results.shift() || { ok: true, state: 'decided', outcome: 'allowed', version: 2 };
    },
    noteRefusal(id, info) { out.refusals.push({ id, ...info }); },
    waitView: async (id) => (id === ASK ? { id, version: 1, state: 'pending' } : null),
  };
  return out;
}

// An audience whose opt-in is `optIn` and which judges every request `level`.
const fakeAudience = (optIn, level) => ({ remoteLevel: () => optIn, levelOf: () => level });

async function boot(t, audience) {
  const asks = fakeAsks();
  const s = createAnswerSurface({ asks, mainPort: () => MAIN, audience, publicDir: PUB, fontsDir: FONTS, idleMs: 60_000 });
  t.after(() => s.close());
  const { origin, port } = await s.ensure();
  return { s, asks, origin, port };
}

function req(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, method, path: p, agent: false,
      headers: { ...(data != null ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

const REMOTE = { 'x-wc-remote': '1' };
const nonceOf = (r) => /name="wc-answer-nonce" content="([^"]*)"/.exec(r.text)[1];
const doc = (port, headers = {}) => req(port, { path: `/answer/ask/${ASK}?layout=bar`, headers: { 'sec-fetch-dest': 'iframe', ...headers } });
const view = (port, nonce, headers = {}) => req(port, { path: `/answer/api/asks/${ASK}?v=0`, headers: { 'x-wc-answer': nonce, 'sec-fetch-site': 'same-origin', ...headers } });
const decide = (port, origin, nonce, headers = {}) => req(port, {
  method: 'POST',
  path: `/answer/api/asks/${ASK}/decide`,
  headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-wc-answer': nonce, ...headers },
  body: { decision: { behavior: 'allow' }, version: 1, device: 'mobile' },
});

// ── remoteAnswering() ────────────────────────────────────────────────────────

test('remoteAnswering(): false with no audience and at the opt-ins off and read, true at full; a throwing audience is false', async (t) => {
  const asks = fakeAsks();
  const make = (audience) => {
    const s = createAnswerSurface({ asks, mainPort: () => MAIN, audience, publicDir: PUB, fontsDir: FONTS });
    t.after(() => s.close());
    return s;
  };
  assert.equal(make(null).remoteAnswering(), false, 'no audience');
  assert.equal(make(fakeAudience('off', 'basic')).remoteAnswering(), false, 'off');
  assert.equal(make(fakeAudience('read', 'read')).remoteAnswering(), false, 'read: watch-only');
  assert.equal(make(fakeAudience('full', 'full')).remoteAnswering(), true, 'full');
  assert.equal(make({ levelOf: () => 'full' }).remoteAnswering(), false, 'an audience with no remoteLevel');
  assert.equal(make({ remoteLevel: () => { throw new Error('x'); }, levelOf: () => 'full' }).remoteAnswering(), false);
});

// ── the engine's remote gate ─────────────────────────────────────────────────

test('at full: an X-WC-Remote request whose level is full gets the document, the view and a decide marked remote', async (t) => {
  const { asks, origin, port } = await boot(t, fakeAudience('full', 'full'));
  const d = await doc(port, REMOTE);
  assert.equal(d.status, 200, d.text);
  const nonce = nonceOf(d);
  assert.ok(nonce);
  const v = await view(port, nonce, REMOTE);
  assert.equal(v.status, 200, v.text);
  assert.equal(v.json.id, ASK);
  const r = await decide(port, origin, nonce, REMOTE);
  assert.equal(r.status, 200, r.text);
  assert.equal(asks.decides.length, 1);
  assert.equal(asks.decides[0].meta.remote, true, 'the domain is told it is a remote decision');
  assert.equal(asks.decides[0].meta.device, 'mobile');
  assert.deepEqual(asks.refusals, []);
});

test('at full, a request whose own level is below full (a network peer is basic) is refused', async (t) => {
  const { asks, origin, port } = await boot(t, fakeAudience('full', 'basic'));
  const nonce = nonceOf(await doc(port));
  const r = await decide(port, origin, nonce, REMOTE);
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.remote, true);
  assert.equal(asks.decides.length, 0);
  assert.deepEqual([asks.refusals.at(-1).reason, asks.refusals.at(-1).origin], ['remote', 'remote']);
});

test('at read: every X-WC-Remote request is refused 403 with the `tunnel mirror on` hint, a refused decide noted as remote', async (t) => {
  const { asks, origin, port } = await boot(t, fakeAudience('read', 'read'));
  const nonce = nonceOf(await doc(port)); // a local load
  for (const r of [await doc(port, REMOTE), await view(port, nonce, REMOTE), await decide(port, origin, nonce, REMOTE)]) {
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.remote, true);
    assert.match(r.json.error, /claude-web-chat tunnel mirror on/);
    assert.match(r.json.error, /host/);
  }
  assert.equal(asks.decides.length, 0, 'nothing reached the domain');
  const last = asks.refusals.at(-1);
  assert.deepEqual([last.id, last.reason, last.origin], [ASK, 'remote', 'remote']);
  // The same requests without the label are the host's own: answered.
  assert.equal((await decide(port, origin, nonce)).status, 200);
});

test('a domain refusal of a remote decide (403 remote-off) is relayed and noted on the ask with origin remote', async (t) => {
  const { asks, origin, port } = await boot(t, fakeAudience('full', 'full'));
  const nonce = nonceOf(await doc(port, REMOTE));
  asks.results.push({ ok: false, status: 403, why_not: 'remote-off' });
  const r = await decide(port, origin, nonce, REMOTE);
  assert.equal(r.status, 403, r.text);
  assert.deepEqual(r.json, { ok: false, why_not: 'remote-off' });
  assert.equal(asks.decides.length, 1, 'the domain decided the refusal');
  const last = asks.refusals.at(-1);
  assert.deepEqual([last.id, last.reason, last.origin, last.device], [ASK, 'remote-off', 'remote', 'mobile']);
  // A domain refusal that is not a 403 (a stale version) is not a refusal to note.
  const n = asks.refusals.length;
  asks.results.push({ ok: false, status: 409, stale: true, version: 4 });
  assert.equal((await decide(port, origin, nonce, REMOTE)).status, 409);
  assert.equal(asks.refusals.length, n);
});

test('frameAncestors still names only the main port\'s loopback origins, at full too', async (t) => {
  const { port } = await boot(t, fakeAudience('full', 'full'));
  const d = await doc(port, REMOTE);
  assert.equal(d.status, 200);
  const fa = /frame-ancestors ([^;]*)/.exec(String(d.headers['content-security-policy']))[1].trim();
  assert.equal(fa, `http://localhost:${MAIN} http://127.0.0.1:${MAIN}`);
  assert.equal(d.headers['x-frame-options'], undefined);
});

// ── GET /api/health's answer port (ruled E3 (a)) ─────────────────────────────

// Requests carrying x-test-peer arrive from that address: their socket's
// remoteAddress is stubbed before the app sees them (test/t6-e2e.test.js's).
function stubPeers(server) {
  const onRequest = (r, res) => {
    const addr = r.headers['x-test-peer'];
    if (!addr) return;
    Object.defineProperty(r.socket, 'remoteAddress', { value: addr, configurable: true });
    res.once('close', () => { delete r.socket.remoteAddress; });
  };
  server.prependListener('request', onRequest);
  return () => server.off('request', onRequest);
}

test('GET /api/health: answer {port} to a local request; null to a remote viewer at basic, read and full, and to a network peer', async (t) => {
  for (const optIn of ['off', 'read', 'full']) {
    await t.test(optIn, async (tt) => {
      withTempHome(tt);
      const root = tmpRoot('wc-answer-remote-');
      const access = createFakeAccess();
      const mirror = optIn === 'off' ? {} : { mirror: { [path.resolve(root)]: optIn } };
      writeJsonAtomic(userPaths().tunnelConfig, access.config({ remote: { allowDestructive: false, ...mirror } }));
      const srv = await withServer(tt, { root });
      tt.after(stubPeers(srv.server));
      const call = { port: srv.port, noSpawn: true, timeout: 10000 };
      const started = await client.get('/api/asks?ensure=1', call);
      assert.ok(started.answer && Number.isInteger(started.answer.port), 'the surface listens');
      const local = await client.get('/api/health', call);
      assert.deepEqual(local.answer, { port: started.answer.port }, 'local: the port');
      const remote = await client.request(srv.port, 'GET', '/api/health', null, { headers: REMOTE, timeout: 10000 });
      assert.equal(remote.status, 200);
      assert.equal(remote.body.remote, true);
      assert.equal(remote.body.answer, null, `remote at ${optIn}: no loopback port`);
      const peer = await client.request(srv.port, 'GET', '/api/health', null, { headers: { 'x-test-peer': PEER }, timeout: 10000 });
      assert.equal(peer.status, 200);
      assert.equal(peer.body.answer, null, 'a network peer: no port');
    });
  }
});

// ── the chrome with no answer origin (U86's viewer rule) ─────────────────────

test('the chrome, remote at full with NO X-WC-Answer-Origin: neither the mod stopper\'s Kill frame nor fork-in-place is offered', async (t) => {
  const { bootShell, respond, helloFrame } = require('../test-support/chrome-shell');
  const { waitUntil } = require('../test-support/helpers');
  const cid = 'c-remote';
  const T0 = Date.UTC(2026, 9, 13, 14, 0, 0);
  const caps = { interrupt: true, task_stop: true, mod: true, rewind_in_place: true, fork: true };
  const snapshot = {
    v: 1, enabled: true, now: Date.now(), rev: 9001, content: true, access: { level: 'full', remote: true }, capabilities: caps,
    primary: cid, aggregate: { state: 'idle' },
    conversations: [{ id: cid, rev: 1, headless: false, counts: { shells: 0, agents: 0, workflows: 0, monitors: 0 },
      process: { pid: 4242, mod: true }, live: { state: 'idle', since: T0, last_activity_at: T0 } }],
    tasks: [{ id: 's1', kind: 'shell', conversation_id: cid, title: 'npm run dev', status: 'running', started_at: T0 - 60000 }],
    asks: [],
  };
  const turn = {
    id: 't1', rev: 9002, conversation_id: cid, session_id: 's1', seq: 1, kind: 'prompt', author: 'user', status: 'done',
    started_at: T0, ended_at: T0 + 5000, duration_ms: 5000,
    counts: { items: 1, tools: 0, tool_errors: 0, agents: 0, tasks: 0, edits: 0 },
    tool_names: [], groups: [], node: { id: 'n1', label: 'n1.1', role: 'commit' }, folded_into: null,
    items: [{ id: 'p_t1', kind: 'prompt', text: 'prompt t1', origin: 'human', turn_id: 't1', seq: 1000, ts: T0, rev: 9002 }],
  };
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  let MC = null;
  const shell = await bootShell({
    routes: {
      // A remote page (through a portal) at full, but no answer origin header.
      '/api/health': respond({ ok: true, remote: true }),
      '/api/mirror': () => snapshot,
      '/api/mirror/conversations/*': () => ({ conversation_id: cid, turns: [turn], next_before: null, total: 1, rev: 9003 }),
      '/api/asks': () => ({ asks: [], answer: null }),
    },
    init: async (sh) => {
      MC = await sh.importApp('mod-controls.js');
      MC.initModControls();
    },
  });
  t.after(async () => {
    if (MC) MC.stopModControls();
    delete globalThis.IntersectionObserver;
    await shell.restore();
  });
  const { bus } = await shell.importApp('bus.js');
  const S = await shell.importApp('chat-state.js');
  const remote = await shell.importApp('remote.js');
  const asksMod = await shell.importApp('asks.js');
  const P = await shell.importApp('chat-present.js');
  const Q = await shell.importApp('queue.js');
  await shell.frame(helloFrame());
  bus.emit('chat:open', { view: 'chat' });
  await waitUntil(() => S.mirror.rev >= 9001 && S.mirror.stream.conversationId === cid && !S.mirror.stream.loading
    && shell.$('chat-stream').querySelectorAll('.ct-turn').length === 1, { timeout: 3000, what: 'the stream' });
  await shell.tick();

  assert.equal(await remote.isRemote(), true, 'the page knows it is remote');
  assert.equal(remote.answerOrigin(), null, 'no answer origin');
  assert.equal(asksMod.answerFrameOrigin(), null, 'so nothing frames');
  const row = P.categories(S.mirror, Q.queueSnapshot(), { now: S.serverNow() }).find((e) => e.cat === 'shells').rows.find((r) => r.id === 's1');
  const slot = shell.document.createElement('div');
  shell.document.body.append(slot);
  assert.equal(MC.modStopper.mount(slot, row, { density: 'compact' }), false, 'the stopper declines');
  assert.equal(slot.querySelector('iframe'), null, 'no Kill frame');
  const actions = [...shell.$('chat-stream').querySelectorAll('.ct-turn[data-turn-id="t1"] .ct-foot .ct-action')].map((b) => b.dataset.action);
  assert.ok(!actions.includes('fork-in-place'), `no fork-in-place: ${actions.join(', ')}`);
});
