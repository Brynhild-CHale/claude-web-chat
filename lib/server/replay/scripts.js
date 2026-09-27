// The replay scripts a daemon is holding for a browser to load.
//
// A replay script (domain/replay-path normalizeReplayScript) travels to the
// replay document by URL — GET /replay?script=<id> — because two browsers load
// that document by navigating to it: the headless Chrome a GIF/video render
// drives, and the player overlay the `export` tool's `open` asks the user's
// browser to show. A script with captions can outgrow what a request line may
// carry, so the script stays here and the URL carries its id.
//
// The id is a hash of the script's pinned form (every ref a stored id), so the
// same script always gets the same id and a repeat never grows the store. The
// store is in memory and bounded: the oldest entry goes first, and a restart
// forgets them all — a player opened before it says so and asks for the replay
// again. Nothing here validates: callers put only a script that normalised.

const crypto = require('crypto');

const MAX_SCRIPTS = 64;

function createScriptStore({ max = MAX_SCRIPTS } = {}) {
  const held = new Map(); // id → script, oldest first

  return {
    put(script) {
      const id = crypto.createHash('sha256').update(JSON.stringify(script)).digest('hex').slice(0, 20);
      held.delete(id);            // re-put = most recent
      held.set(id, script);
      while (held.size > max) held.delete(held.keys().next().value);
      return id;
    },
    get(id) {
      return typeof id === 'string' && held.has(id) ? held.get(id) : null;
    },
    get size() { return held.size; },
  };
}

module.exports = { createScriptStore, MAX_SCRIPTS };
