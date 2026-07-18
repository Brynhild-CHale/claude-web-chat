// Component script failures are observable outside the browser console: the
// runtime's runScripts reports a throwing script via its optional onError hook,
// the live client forwards it over WS ('script:error'), and the daemon rings a
// kind:'script-error' event — so get_events diagnoses a dead pane (the
// "declared signal that silently never fires" bug) in one call.

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { withServer } = require('../test-support/helpers');
const runtime = require('../public/mount-runtime.js');

test('runScripts: a throwing script reaches onError with its index; siblings still run', () => {
  const calls = [];
  const store = { probe: (i) => calls.push(i) };
  runtime.runScripts(null, [
    'store.probe(0)',
    'throw new Error("boom at mount")',
    'store.probe(2)',
  ], store, {}, 'm1', (err, i) => calls.push(['err', err.message, i]));
  assert.deepEqual(calls, [0, ['err', 'boom at mount', 1], 2]);
});

test('runScripts: onError is optional and a throwing onError cannot abort the loop', () => {
  const calls = [];
  const store = { probe: (i) => calls.push(i) };
  runtime.runScripts(null, ['throw new Error("x")', 'store.probe(1)'], store, {}, 'm1');
  runtime.runScripts(null, ['throw new Error("x")', 'store.probe(2)'], store, {}, 'm1', () => { throw new Error('reporter died'); });
  assert.deepEqual(calls, [1, 2]);
});

test('a script:error WS frame rings a capped kind:script-error event', async (t) => {
  const { api, port } = await withServer(t);
  await new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://localhost:${port}/ws`);
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'hello') {
        sock.send(JSON.stringify({
          type: 'script:error', id: 'connector-vision-gate', script_index: 0,
          message: 'x'.repeat(900),
          stack: 'TypeError: null is not an object\n    at <anonymous>:1:10',
        }));
        setTimeout(() => { sock.close(); resolve(); }, 100);
      }
    });
    sock.on('error', reject);
  });

  const ev = await api.get('/api/events');
  const errs = ev.json.events.filter((e) => e.kind === 'script-error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].id, 'connector-vision-gate');
  assert.equal(errs[0].script_index, 0);
  assert.equal(errs[0].message.length, 500, 'message is length-capped for the ring');
  assert.match(errs[0].stack, /TypeError/);
  assert.equal(errs[0].source, 'browser');

  const q = await api.get('/api/queue');
  assert.equal(q.json.count, 0, 'a script error is diagnostics, not wake-worthy activity');
});
