// lib/server/hook-tap.js — the hook tap: every hook envelope the daemon
// accepts, in arrival order, in process (spec §1.4). Exposed as `ctx.hooks`.
//
// It is another instance of the change bus (lib/core/bus.js), not a new
// mechanism: createBus with its own 200-entry ring and NO broadcaster, so
// nothing it carries ever becomes a WebSocket frame, behind a three-function
// adapter:
//
//   publish(env)  → the ring entry, `{seq, ts, kind: 'hook', ...env}`, or null
//                   for something that is not an object. The bus spreads the
//                   event after its own seq and ts, so the envelope keeps its
//                   OWN `ts` (when its hook read stdin). `seq` and `kind` are
//                   the tap's: an envelope cannot overwrite them (v1 has
//                   neither, and the intake refuses unknown fields).
//   subscribe(fn) → unsubscribe. Subscribers run synchronously inside publish,
//                   in registration order, each in its own try/catch, so one
//                   that throws costs the others nothing.
//   recent(n)     → a copy of the last n entries (all of them when n is
//                   omitted).
//
// Who publishes: the hook intake (POST /api/hooks/event, host only), the turn
// routes (their UserPromptSubmit, Stop and StopFailure envelopes, host only,
// §3.1), and, from tranche 4, the asks domain, whose `synthetic` envelopes
// (PermissionResolved) exist only in process. Who subscribes: the mirror engine,
// the turn guard, the asks domain. Arrival order is not event order (async hooks
// race, §1.1), so no subscriber may depend on it.
//
// A separate instance, not the main bus: hook inputs are high-volume internal
// facts (two per tool call), not surface changes; the main ring is shared with
// get_events and its SSE subscribers assume ring seqs. The mirror bus is the
// third instance.

const { createBus } = require('../core/bus');

const TAP_MAX = 200;

function createHookTap({ max = TAP_MAX } = {}) {
  const bus = createBus({ maxEvents: max });

  function publish(env) {
    if (env === null || typeof env !== 'object' || Array.isArray(env)) return null;
    const { seq: _seq, kind: _kind, ...envelope } = env;
    return bus.emit({ event: { kind: 'hook', ...envelope } });
  }

  function recent(n) {
    const all = bus.events;
    if (n === undefined) return all.slice();
    const k = Math.floor(Number(n));
    return k > 0 ? all.slice(-k) : [];
  }

  return { publish, subscribe: bus.subscribe, recent };
}

module.exports = { createHookTap, TAP_MAX };
