const client = require('../client');

module.exports = {
  name: 'use_component',
  description: 'Render a saved component by name with params. Equivalent to `render` — same mount-set, same ownership guard and `force`, same declared `signals`, same persisted form_state and per-pane theme — but it uses stored source instead of an inline payload, so it is cheaper and more consistent across calls.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Component name (must already be saved).' },
      params: { type: 'object', description: 'Params passed to the component\'s script as the `params` global. Shape defined by the component\'s params_schema. Server-recognized keys ride here too: `form_reset:true` drops the mount\'s persisted form_state on this render (use when supplying fresh prefills); `routing:"none"`/`"auto"` overrides activity routing as in `render`.' },
      id: { type: 'string', description: 'Stable mount id (replace-in-place). Reserved shell element ids ("main", "topbar", "status", "overlay", …) are refused with {ok:false, reserved:true}, exactly as in `render`.' },
      target: { type: 'string', description: 'Target slot. Defaults to "main".' },
      force: { type: 'boolean', description: 'Take over a pane owned by another writer (owner:"service:<name>"). Without it, mounting over an owned pane soft-rejects with {ok:false, owned:true, owner}.' },
      signals: {
        type: 'array',
        description: 'Optional declared wake signals (channels), exactly as in `render`: each entry names a store key this pane writes on a deliberate user action and how it should wake you. wake:"queue" (default) folds a browser write to that key into the user\'s queue rail, to send when they hit Push; wake:"immediate" wakes you the moment the pane writes it.',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'The store key the pane writes (e.g. "form_submit").' },
            wake: { type: 'string', enum: ['queue', 'immediate'], description: 'queue (default) or immediate.' },
            why: { type: 'string', description: 'Short human label for why this wakes you (shown in the queue rail).' },
          },
          required: ['key'],
        },
      },
    },
    required: ['name'],
  },
  async handler({ name, params, id, target, force, signals }) {
    // Declared signals ride under params.signals (a persisted mount field the
    // daemon derives its wake registry from), exactly as in render.js — a
    // top-level `signals` array used to be dropped by this destructuring, so a
    // declared wake silently never registered.
    const body = { params, id, target, force };
    if (Array.isArray(signals) && signals.length) {
      body.params = { ...(params || {}), signals };
    }
    return await client.post(`/api/components/${encodeURIComponent(name)}/use`, body);
  },
};
