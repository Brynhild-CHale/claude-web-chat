const client = require('../client');

module.exports = {
  name: 'render',
  description: 'Render arbitrary HTML/JS into a shadow-rooted mount in the user\'s browser surface. Inline `<script>` tags execute with `store`, `root`, `params`, and `mountId` injected as globals — query the pane\'s DOM via `root` (an open shadow root), NEVER `document.*` (it cannot see into the shadow DOM and the script dies at mount). Each call replaces any prior mount with the same `id` (reuse the id to update in place). Use this for ad-hoc, one-off UI; for recurring patterns prefer `save_component` then `use_component`; for LIVE HOST STATE (git, test runs, log tails, file editing) prefer a service-backed component — `list_components` first, builtins include git-dashboard and file-editor. OWNERSHIP: rendering over a pane owned by another writer (`owner:"service:<name>"` in list_mounts) is soft-rejected with `{ok:false, owned:true, owner}` — pass `force:true` to take it over deliberately, or use a fresh id alongside it. ROUTING IS OPT-OUT: user interactions in the pane (clicks on affordances, form edits, submits, undeclared store writes) automatically coalesce into one rolling "activity" item per mount in the user\'s queue rail — nothing the user does is silently lost, even if the pane\'s script fails. Typed form values also auto-persist per mount (`form_state`, readable via list_mounts, survives refresh/navigation and re-renders — pass `params.form_reset:true` to drop them; `params.routing:"none"` opts the pane out of activity routing). Declared `signals` (below) remain the SEMANTIC layer on top: a named payload key for a deliberate affordance (Apply/Send button), or an immediate wake. Surfaces can be INTERACTIVE, not one-shot: render→declare→react→re-render on each Push.',
  inputSchema: {
    type: 'object',
    properties: {
      html: { type: 'string', description: 'The HTML/JS payload. <style> and <script> tags inside are handled correctly.' },
      id: { type: 'string', description: 'Stable mount id (used for replace-in-place). If omitted, a unique id is generated.' },
      target: { type: 'string', description: 'Slot in the page DOM to mount into. Defaults to "main".' },
      force: { type: 'boolean', description: 'Take over a pane owned by another writer (owner:"service:<name>"). Without it, rendering over an owned pane soft-rejects with {ok:false, owned:true, owner}.' },
      params: {
        type: 'object',
        description: 'Mount params persisted with the pane and injected into its script as `params`. Recognized keys: `form_reset:true` drops the mount\'s persisted form_state on this render (use when supplying fresh prefills); `routing:"none"` opts the pane out of default activity-item routing ("auto" opts a service-owned pane back in). Other keys pass through to the pane script.',
        properties: {
          form_reset: { type: 'boolean', description: 'Drop the persisted form_state for this mount on this render.' },
          routing: { type: 'string', enum: ['auto', 'none'], description: 'Activity-routing override for this pane. Default: auto (none for service-owned panes).' },
        },
      },
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
