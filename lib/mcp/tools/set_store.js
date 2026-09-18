const client = require('../client');

module.exports = {
  name: 'set_store',
  description: 'Write a patch into the shared store. Useful for seeding state a component will read on mount (e.g., setting a list of items before rendering a viewer of them).',
  inputSchema: {
    type: 'object',
    properties: {
      patch: { type: 'object', description: 'Object whose keys+values are merged into the store.' },
    },
    required: ['patch'],
  },
  async handler(args) {
    const r = await client.post('/api/store', args);
    // Deliberately NOT the route's `{ok, store}`. POST /api/store echoes the
    // ENTIRE store back (lib/server/routes/store.js) and nothing reads the echo:
    // lib/driver.js's setStore returns the call result unread, and no browser
    // code fetches /api/store at all — the surface takes store:patch over the WS.
    // For Claude it is pure cost, and measurably so: 288KB for a one-key write
    // against a real project store, and 14% of every byte this MCP surface has
    // ever spent on the author's machine. get_store is the read path; this is
    // the write path, and it reports what it wrote plus enough to notice the
    // store growing.
    //
    // Shaped here rather than at the route, because the route's response is a
    // wire shape an out-of-tree driver could depend on; an MCP tool's return
    // value is read by exactly one caller.
    const store = (r && r.store) || {};
    return {
      ok: !r || r.ok !== false,
      keys_written: Object.keys((args && args.patch) || {}),
      store_keys: Object.keys(store).length,
      store_bytes: JSON.stringify(store).length,
    };
  },
};
