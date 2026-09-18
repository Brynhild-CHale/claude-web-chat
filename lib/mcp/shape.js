// Shaping a daemon response for the MCP boundary — what CLAUDE sees, as distinct
// from what the daemon returns on the wire.
//
// The distinction is the whole point of this module. /api/graph's response is
// consumed by the browser and by out-of-tree drivers as well as by Claude, so a
// field that is merely expensive for a context window is narrowed HERE rather
// than at the route, where narrowing it would be a wire-shape change.
//
// Today that is one field. `graph.lock.message` is the user's own prompt, stored
// unsliced (lib/server/domain/turns.js, `graph.lock = { base, started_at,
// message, author }`) and returned whole by /api/graph. Both of its neighbours
// were already capped — FOLDED_MESSAGE_MAX slices a folded message to 1000, and
// a trigger summary is sliced to 100 — and this one was missed. The cost was not
// theoretical: across every web-chat MCP result recorded on the author's machine,
// the single largest was a get_active of 49,556 characters, 49,400 of them this
// one field, handing the user's prompt back to the model that had just read it.

// 200: the trigger-summary slice (100) doubled, because a live lock's message is
// the prompt currently being worked on and a little more of it is worth seeing.
const LOCK_MESSAGE_MAX = 200;

// Cap lock.message, reporting the TRUE size beside it so the caller knows what it
// is not seeing — the shape lib/server/routes/capture.js uses for a capped raw
// read. Returns the lock untouched when there is nothing to cut (so no
// `message_bytes` appears unless something was actually withheld), and never
// mutates its input.
function capLock(lock) {
  if (!lock || typeof lock.message !== 'string') return lock || null;
  const bytes = lock.message.length;
  if (bytes <= LOCK_MESSAGE_MAX) return lock;
  return { ...lock, message: lock.message.slice(0, LOCK_MESSAGE_MAX), message_bytes: bytes };
}

module.exports = { capLock, LOCK_MESSAGE_MAX };
