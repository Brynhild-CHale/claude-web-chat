// The context meter's read (lib/server/routes/mirror-context.js and
// lib/server/control/session-ops.js createContextReadings, U93; spec §15.7
// 'Session controls'; notes-C D8; ruled D1 (a)), on a bare Express app with a
// REAL hook tap (lib/server/hook-tap.js) and a fake mirror facade:
//   * a ModEvent session.measure on the tap, as the bridge publishes it (U87),
//     → GET /api/mirror/context?conversation=<cid> answers exactly {tokens,
//     window, percent, at} — never the rate limits or the cost it carried;
//   * a later measure replaces it; a {window}-only context is no reading;
//   * a main-loop SessionEnd, or the mirror's process-gone, forgets it;
//   * an unknown conversation → context null; a bad query → 400;
//   * X-WC-Remote below read → refused by requireMirror('read') (the real
//     audience), covered by remote-policy's existing GET /api/mirror/* row;
//   * stop() unsubscribes from the tap and the mirror.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const { request } = require('../lib/client');
const { createHookTap } = require('../lib/server/hook-tap');
const { createAudience } = require('../lib/server/audience');
const { classify, RULES, MIRROR_HINT } = require('../lib/core/remote-policy');
const { MOD_EVENT } = require('../lib/core/mod-protocol');
const { createContextReadings, READINGS_MAX } = require('../lib/server/control/session-ops');
const { mountMirrorContextRoutes } = require('../lib/server/routes/mirror-context');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const T0 = 1_760_000_000_000;

function fakeMirror(map = { [S1]: 'c1', [S2]: 'c1' }) {
  const subs = new Set();
  const m = {
    map: { ...map },
    conversationOf(id) {
      if (Object.values(m.map).includes(id)) return id;
      return m.map[typeof id === 'string' ? id.toLowerCase() : id] || null;
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit(ev) { for (const fn of [...subs]) fn({ kind: 'mirror', ...ev }); },
    subscribers: () => subs.size,
  };
  return m;
}

// The envelope the bridge publishes (lib/server/domain/bridge.js), its payload
// already through validateEvent's measureOf: numbers, or objects of numbers.
const measure = (sid, context, ts, extra = {}) => ({
  v: 1, event: MOD_EVENT, synthetic: true, ts, session_id: sid,
  mod: { kind: 'session.measure', changed: ['context'], context, cost: { usd: 1.25, total_tokens: 99 }, rateLimits: { percentUsed: 81 }, ...extra },
});

async function host(t, { mirror = fakeMirror(), audience = null } = {}) {
  const hooks = createHookTap();
  const readings = createContextReadings({ hooks, mirror, now: () => T0 });
  t.after(() => readings.stop());
  const aud = audience || createAudience({ configFile: null });
  if (!audience) t.after(() => aud.stop());
  const app = express();
  const ctx = { audience: aud, contextReadings: readings, mirror };
  mountMirrorContextRoutes(app, ctx);
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const { port } = srv.address();
  const get = (p, { remote = false } = {}) => request(port, 'GET', p, null,
    { headers: remote ? { 'X-WC-Remote': '1' } : {}, timeout: 30000 });
  return { hooks, readings, mirror, get, ctx };
}

const URL_C1 = '/api/mirror/context?conversation=c1';

test('a session.measure on the tap → exactly {tokens, window, percent, at}, never the rate limits or the cost', async (t) => {
  const h = await host(t);
  assert.deepEqual((await h.get(URL_C1)).body, { ok: true, context: null }, 'no reading yet');
  h.hooks.publish(measure(S1, { tokens: 76000, window: 200000, percent: 38 }, T0 + 5));
  const r = await h.get(URL_C1);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, context: { tokens: 76000, window: 200000, percent: 38, at: T0 + 5 } });
  assert.deepEqual(Object.keys(r.body.context), ['tokens', 'window', 'percent', 'at']);
  assert.doesNotMatch(JSON.stringify(r.body), /rate|cost|usd|percentUsed/i);
  // The session's own read says the same; a session id as the query names its conversation.
  assert.deepEqual(h.readings.forSession(S1.toUpperCase()), r.body.context);
  assert.deepEqual((await h.get(`/api/mirror/context?conversation=${S1}`)).body, r.body);
});

test('a later measure replaces it; the newest of the conversation\'s sessions wins; a {window}-only context is no reading', async (t) => {
  const h = await host(t);
  h.hooks.publish(measure(S1, { tokens: 76000, window: 200000, percent: 38 }, T0 + 5));
  h.hooks.publish(measure(S1, { tokens: 164000, window: 200000, percent: 82 }, T0 + 9));
  assert.deepEqual((await h.get(URL_C1)).body.context, { tokens: 164000, window: 200000, percent: 82, at: T0 + 9 });
  h.hooks.publish(measure(S2, { tokens: 1000, window: 200000 }, T0 + 20));
  assert.deepEqual((await h.get(URL_C1)).body.context, { tokens: 1000, window: 200000, percent: 0.5, at: T0 + 20 },
    'the newer session\'s, its percent computed');
  h.hooks.publish(measure(S2, { window: 200000 }, T0 + 30));
  assert.equal((await h.get(URL_C1)).body.context.at, T0 + 20, 'before the first request: kept as it was');
  // A subagent's measure is never the session's; nor is another event's.
  h.hooks.publish(measure(S2, { tokens: 5, window: 10 }, T0 + 40, { agent_id: 'a1' }));
  h.hooks.publish({ v: 1, event: MOD_EVENT, synthetic: true, ts: T0 + 41, session_id: S2, mod: { kind: 'session.compact', trigger: 'manual', context: { tokens: 5, window: 10 } } });
  assert.equal((await h.get(URL_C1)).body.context.at, T0 + 20);
});

test('SessionEnd on the tap, or the mirror\'s process-gone, forgets the session', async (t) => {
  const h = await host(t);
  h.hooks.publish(measure(S1, { tokens: 76000, window: 200000, percent: 38 }, T0 + 5));
  h.hooks.publish({ v: 1, event: 'SessionEnd', ts: T0 + 6, session_id: S1, agent: { id: 'x' } });
  assert.notEqual((await h.get(URL_C1)).body.context, null, 'a subagent\'s SessionEnd is not the session\'s');
  h.hooks.publish({ v: 1, event: 'SessionEnd', ts: T0 + 7, session_id: S1 });
  assert.equal((await h.get(URL_C1)).body.context, null);
  h.hooks.publish(measure(S2, { tokens: 76000, window: 200000, percent: 38 }, T0 + 8));
  assert.notEqual((await h.get(URL_C1)).body.context, null);
  h.mirror.emit({ op: 'process-gone', session_ids: [S2.toUpperCase()] });
  assert.equal((await h.get(URL_C1)).body.context, null);
  assert.equal(h.readings.size(), 0);
});

test('an unknown conversation → context null; no conversation, an empty or repeated one → 400; an id over 128 → 404', async (t) => {
  const h = await host(t);
  h.hooks.publish(measure(S1, { tokens: 76000, window: 200000, percent: 38 }, T0 + 5));
  assert.deepEqual((await h.get('/api/mirror/context?conversation=c9')).body, { ok: true, context: null });
  assert.equal((await h.get('/api/mirror/context')).status, 400);
  assert.equal((await h.get('/api/mirror/context?conversation=')).status, 400);
  assert.equal((await h.get('/api/mirror/context?conversation=c1&conversation=c2')).status, 400);
  assert.equal((await h.get(`/api/mirror/context?conversation=${'c'.repeat(129)}`)).status, 404);
});

test('the readings are bounded: past READINGS_MAX sessions the oldest goes', async (t) => {
  const mirror = fakeMirror({});
  const h = await host(t, { mirror });
  for (let i = 0; i <= READINGS_MAX; i++) {
    const sid = `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`;
    h.hooks.publish(measure(sid, { tokens: i, window: 100 }, T0 + i));
  }
  assert.equal(h.readings.size(), READINGS_MAX);
  assert.equal(h.readings.forSession('00000000-1111-4111-8111-111111111111'), null);
});

test('X-WC-Remote below read is refused by requireMirror(\'read\'); the existing GET /api/mirror/* row covers it — no row of its own', async (t) => {
  const h = await host(t);
  h.hooks.publish(measure(S1, { tokens: 76000, window: 200000, percent: 38 }, T0 + 5));
  const refused = await h.get(URL_C1, { remote: true });
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { ok: false, mirror: 'basic', remote: true, hint: MIRROR_HINT });
  assert.equal((await h.get(URL_C1)).status, 200, 'local passes');
  // The portal's table: the wildcard row at read, nothing of its own.
  const basic = classify('GET', URL_C1, { mirror: 'off' });
  assert.deepEqual([basic.allow, basic.key], [false, 'GET /api/mirror/*']);
  assert.deepEqual(classify('GET', URL_C1, { mirror: 'read' }), { allow: true, key: 'GET /api/mirror/*' });
  assert.equal(classify('POST', URL_C1, { mirror: 'full' }).allow, false);
  assert.ok(!RULES.some((r) => r.path.startsWith('/api/mirror/context')));
});

test('mounting without an audience gate throws; with no readings wired the route answers 503', async (t) => {
  const app = express();
  assert.throws(() => mountMirrorContextRoutes(app, {}), /ctx\.audience/);
  assert.throws(() => mountMirrorContextRoutes(app, { audience: {} }), /requireMirror/);
  const audience = createAudience({ configFile: null });
  t.after(() => audience.stop());
  mountMirrorContextRoutes(app, { audience });
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const r = await request(srv.address().port, 'GET', URL_C1, null, { timeout: 30000 });
  assert.deepEqual([r.status, r.body], [503, { ok: false, unavailable: true }]);
});

test('stop() unsubscribes from the tap and the mirror, and forgets every reading', async (t) => {
  const mirror = fakeMirror();
  const hooks = createHookTap();
  const readings = createContextReadings({ hooks, mirror });
  assert.equal(mirror.subscribers(), 1);
  hooks.publish(measure(S1, { tokens: 76000, window: 200000, percent: 38 }, T0 + 5));
  assert.equal(readings.size(), 1);
  readings.stop();
  readings.stop();   // idempotent
  assert.equal(mirror.subscribers(), 0);
  assert.equal(readings.size(), 0);
  hooks.publish(measure(S1, { tokens: 76000, window: 200000, percent: 38 }, T0 + 6));
  assert.equal(readings.size(), 0, 'the tap no longer reaches it');
  assert.equal(readings.forConversation('c1'), null);
  void t;
});
