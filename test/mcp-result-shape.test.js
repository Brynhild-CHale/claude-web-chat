// What the MCP boundary hands CLAUDE, as distinct from what the daemon returns
// on the wire (lib/mcp/shape.js, and the two tool handlers that shape their
// results).
//
// Both behaviours under test were measured against every web-chat MCP result
// recorded on the author's machine, and both were pure cost:
//
//   1. set_store returned POST /api/store's response verbatim, and that route
//      echoes the ENTIRE store. Nothing reads the echo — lib/driver.js returns
//      the call result unread and no browser code fetches /api/store — so for
//      Claude it was 288KB per one-key write on a real project store, and 14%
//      of every byte the MCP surface had ever spent.
//
//   2. get_active/get_graph returned `lock.message` — the user's own prompt —
//      in full. The largest MCP result ever recorded was a get_active of 49,556
//      characters, 49,400 of them that one field, handed back to the model that
//      had just written it. Its two neighbours were already capped; this one
//      was missed.
//
// The tool handlers are exercised with lib/mcp/client stubbed in require.cache
// (the idiom test/lock-ttl.test.js and test/resources.test.js already use), so
// what is pinned is the SHAPE the handler returns for a given daemon response —
// no daemon, no portfile, no spawn.

const test = require('node:test');
const assert = require('node:assert');

const { capLock, LOCK_MESSAGE_MAX } = require('../lib/mcp/shape');

const CLIENT = require.resolve('../lib/mcp/client');
const TOOLS = ['../lib/mcp/tools/set_store', '../lib/mcp/tools/get_active', '../lib/mcp/tools/get_graph'];

// Install a fake lib/mcp/client and load a tool against it. Both the stub and
// the tool are evicted on t.after, so a later test gets the real module back.
function toolWith(t, modPath, fakeClient) {
  const prev = require.cache[CLIENT];
  require.cache[CLIENT] = { id: CLIENT, filename: CLIENT, loaded: true, exports: fakeClient };
  for (const m of TOOLS) delete require.cache[require.resolve(m)];
  t.after(() => {
    if (prev) require.cache[CLIENT] = prev; else delete require.cache[CLIENT];
    for (const m of TOOLS) delete require.cache[require.resolve(m)];
  });
  return require(modPath);
}

// --- capLock (pure) ----------------------------------------------------------

test('capLock leaves a short message alone and adds no message_bytes', () => {
  const lock = { base: 'n1', started_at: 1, message: 'ship it', author: 'user' };
  const out = capLock(lock);
  assert.deepEqual(out, lock);
  // Absent, not present-and-equal: a `message_bytes` key is the signal that
  // something WAS withheld, so it must not appear when nothing was.
  assert.ok(!('message_bytes' in out));
});

test('capLock cuts a long message and reports the TRUE length beside it', () => {
  const message = 'x'.repeat(50_000);
  const out = capLock({ base: 'n1', message, author: 'user' });
  assert.equal(out.message.length, LOCK_MESSAGE_MAX);
  assert.equal(out.message_bytes, 50_000, 'the true size, not the size of what was kept');
  assert.equal(out.base, 'n1', 'every other field survives');
  assert.equal(out.author, 'user');
});

test('capLock never mutates its input', () => {
  const lock = { message: 'y'.repeat(1000) };
  capLock(lock);
  assert.equal(lock.message.length, 1000);
});

test('capLock passes through a null lock and a lock with no message', () => {
  assert.equal(capLock(null), null);
  assert.equal(capLock(undefined), null);
  assert.deepEqual(capLock({ base: 'n1' }), { base: 'n1' });
});

// --- set_store ---------------------------------------------------------------

test('set_store reports what it wrote and never echoes the store back', async (t) => {
  const fatStore = { big: 'z'.repeat(200_000), other: 1, third: 2 };
  let sentPath = null; let sentBody = null;
  const setStore = toolWith(t, '../lib/mcp/tools/set_store', {
    async post(p, b) { sentPath = p; sentBody = b; return { ok: true, store: fatStore }; },
  });

  const out = await setStore.handler({ patch: { other: 1 } });

  assert.equal(sentPath, '/api/store', 'the write still goes to the same route');
  assert.deepEqual(sentBody, { patch: { other: 1 } }, 'with the patch untouched');
  assert.ok(!('store' in out), 'the echoed store must not reach Claude');
  assert.deepEqual(out.keys_written, ['other']);
  assert.equal(out.ok, true);
  assert.equal(out.store_keys, 3, 'the shape still reports enough to notice growth');
  assert.ok(out.store_bytes > 200_000);
  // The whole point, stated as a size assertion so a regression is loud.
  assert.ok(JSON.stringify(out).length < 200, 'the result must be small regardless of store size');
});

test('set_store reports ok:false when the daemon does', async (t) => {
  const setStore = toolWith(t, '../lib/mcp/tools/set_store', {
    async post() { return { ok: false, store: {} }; },
  });
  const out = await setStore.handler({ patch: {} });
  assert.equal(out.ok, false);
});

// --- get_active / get_graph --------------------------------------------------

test('get_active caps the turn lock message', async (t) => {
  const message = 'p'.repeat(49_400);
  const getActive = toolWith(t, '../lib/mcp/tools/get_active', {
    async get() { return { active: 'n9', active_label: 'n1.7', lock: { base: 'n9', message, author: 'user' }, nodes: [] }; },
  });

  const out = await getActive.handler();
  assert.equal(out.active_label, 'n1.7');
  assert.equal(out.lock.message.length, LOCK_MESSAGE_MAX);
  assert.equal(out.lock.message_bytes, 49_400);
  assert.ok(JSON.stringify(out).length < 1000, 'the whole result stays small');
});

test('get_graph caps the lock message and passes everything else through', async (t) => {
  const nodes = [{ id: 'n1', label: 'n1.0' }, { id: 'n2', label: 'n1.1' }];
  const getGraph = toolWith(t, '../lib/mcp/tools/get_graph', {
    async get() { return { active: 'n2', nodes, lock: { message: 'q'.repeat(9000) } }; },
  });

  const out = await getGraph.handler();
  assert.deepEqual(out.nodes, nodes, 'topology is untouched — only the lock is shaped');
  assert.equal(out.active, 'n2');
  assert.equal(out.lock.message.length, LOCK_MESSAGE_MAX);
  assert.equal(out.lock.message_bytes, 9000);
});

test('get_graph with no lock in flight returns the response unchanged', async (t) => {
  const payload = { active: 'n2', nodes: [], lock: null };
  const getGraph = toolWith(t, '../lib/mcp/tools/get_graph', { async get() { return payload; } });
  assert.deepEqual(await getGraph.handler(), payload);
});
