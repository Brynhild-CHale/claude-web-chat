const client = require('../client');

module.exports = {
  name: 'render',
  description: 'Render arbitrary HTML/JS into a shadow-rooted mount in the user\'s browser surface. Inline `<script>` tags execute with `store`, `root`, `params`, and `mountId` injected as globals. Each call replaces any prior mount with the same `id` (reuse the id to update in place). Use this for ad-hoc, one-off UI; for recurring patterns prefer `save_component` then `use_component`. Surfaces can be INTERACTIVE, not one-shot: have the pane write a single signal key on a deliberate user action (e.g. an Apply button → `store.set({form_submit:{seq,payload}})`) and DECLARE that key in `signals` (below); the user hitting Push then wakes you with it and you re-render the same id — a render→declare→react→re-render loop. Don\'t just render a static form and assume submission; declare a signal for any input you expect back.',
  inputSchema: {
    type: 'object',
    properties: {
      html: { type: 'string', description: 'The HTML/JS payload. <style> and <script> tags inside are handled correctly.' },
      id: { type: 'string', description: 'Stable mount id (used for replace-in-place). If omitted, a unique id is generated.' },
      target: { type: 'string', description: 'Slot in the page DOM to mount into. Defaults to "main".' },
      signals: {
        type: 'array',
        description: 'Optional declared wake signals (channels). Each entry names a store key this pane writes on a deliberate user action and how it should wake you: wake:"queue" (default) folds a browser write to that key into the user\'s queue rail, to send when they hit Push; wake:"immediate" wakes you the moment the pane writes it, bypassing the queue. Use "immediate" only for explicit "Ask Claude now" affordances. Declaring signals is the channels-native replacement for the arm-a-wait convention — you no longer need to background a watch for these keys.',
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
    required: ['html'],
  },
  async handler(args) {
    // Declared signals ride under params.signals (a persisted mount field the
    // daemon derives its wake registry from). Nest them without disturbing any
    // other params.
    const { signals, ...body } = args || {};
    if (Array.isArray(signals) && signals.length) {
      body.params = { ...(body.params || {}), signals };
    }
    return await client.post('/api/render', body);
  },
};
