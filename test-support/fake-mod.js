// A fake web-chat mod for the tests: it says hello, long-polls ops, posts
// results and posts events over the bridge's host-only routes
// (lib/server/routes/bridge.js), through lib/client — no Origin, no
// Sec-Fetch-*, as the real mod's $.http.fetch. It is what stands in for a
// Claude Code session with the mod loaded (§11.9's "fake mod client over the
// bridge routes"): no test ever runs `claude`.
//
//   const mod = fakeMod({ port, sessionId, root });
//   await mod.hello();                       // → {status, body}; keeps the token
//   await mod.poll({ wait: 500 });           // → {status, body: {ok, ops}}
//   await mod.result(id, { ok: true, result: {...} });
//   await mod.events([{ kind: 'turn.start', at: Date.now(), turn_id: 't1' }]);
//   const stop = mod.runOps({ abort: () => ({ aborted: true }) });
//   await stop();                            // the loop has ended
//   await mod.close();                       // every loop ended; nothing left open
//
// runOps(handlers, {wait}) polls in a loop and answers each op with its
// handler's return value ({ok: true, result}); a handler that throws, or
// returns {refused}, answers {ok: false, refused}; an op with no handler
// answers {ok: false, refused: 'unsupported'}. Each poll waits at most `wait`
// ms (default 200), so stopping takes no longer than one wait.
//
// The hello's defaults are a mod that knows every op and event of the wire
// (lib/core/mod-protocol); `hello(extra)` merges `extra` over the body, and
// `hello(extra, {replace: true})` sends `extra` alone (a malformed hello).
// `request(method, path, body, headers)` is the raw route call, for a test
// that sends its own header (or none).

const { request } = require('../lib/client');
const { OPS, EVENT_KINDS, MOD_PROTOCOL } = require('../lib/core/mod-protocol');

function fakeMod({ port, sessionId, root, ccVersion = '2.1.296', modVersion = '0.8.5-test' } = {}) {
  if (!port) throw new TypeError('fakeMod: port is required');
  let token = null;
  const loops = new Set();

  const call = (method, path, body, headers = {}) => request(port, method, path, body, { headers });
  const auth = () => (token ? { 'X-WC-Bridge': token } : {});

  async function hello(extra = {}, { replace = false } = {}) {
    const body = replace ? extra : {
      v: 1, protocol: MOD_PROTOCOL, session_id: sessionId, cc_version: ccVersion, mod_version: modVersion,
      ops: [...OPS], events: [...EVENT_KINDS], root, ...extra,
    };
    const r = await call('POST', '/api/bridge/hello', body);
    if (r.status === 200 && r.body && typeof r.body.token === 'string') token = r.body.token;
    return r;
  }

  function poll({ wait = 0 } = {}) {
    return call('GET', `/api/bridge/ops?wait=${Math.max(0, Math.floor(wait))}`, null, auth());
  }

  function result(id, body = {}) {
    return call('POST', '/api/bridge/result', { id, ok: true, ...body }, auth());
  }

  function events(list) {
    return call('POST', '/api/bridge/events', { events: list }, auth());
  }

  function status() {
    return call('GET', '/api/bridge/status', null);
  }

  async function answer(op, handlers) {
    const fn = handlers[op.op];
    if (typeof fn !== 'function') return result(op.id, { ok: false, refused: 'unsupported' });
    let out;
    try { out = await fn(op.args, op); } catch (e) { return result(op.id, { ok: false, refused: 'failed', error: String((e && e.message) || e) }); }
    if (out && typeof out === 'object' && typeof out.refused === 'string') return result(op.id, { ok: false, refused: out.refused });
    return result(op.id, { ok: true, result: out === undefined ? null : out });
  }

  function runOps(handlers = {}, { wait = 200 } = {}) {
    let running = true;
    const done = (async () => {
      while (running) {
        let r;
        try { r = await poll({ wait }); } catch { break; }
        if (!running) break;
        if (r.status !== 200 || !r.body || !Array.isArray(r.body.ops)) break;
        for (const op of r.body.ops) {
          try { await answer(op, handlers); } catch {}
        }
      }
    })();
    const stop = async () => { running = false; await done; loops.delete(stop); };
    loops.add(stop);
    return stop;
  }

  async function close() {
    await Promise.all([...loops].map((stop) => stop()));
  }

  return {
    hello, poll, result, events, status, runOps, close,
    request: call,
    get token() { return token; },
    set token(v) { token = v; },
  };
}

module.exports = { fakeMod };
