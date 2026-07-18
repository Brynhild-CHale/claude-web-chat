const client = require('../client');

module.exports = {
  name: 'get_events',
  description: 'Read the recent event log: renders, clicks, store mutations, graph operations, and pane script failures (kind:"script-error" — a pane\'s inline <script> threw at mount, with mount id + message; if a pane you rendered is unresponsive or its declared signal never fires, check for one of these FIRST). Each event carries a `source` — `"browser"` for user/page activity, otherwise the writer\'s owner (`"claude"`, `"service:<name>"`, `"server"`) — use it to tell user actions from your own or a driver\'s writes. Filter by sequence number (`since`) to catch up on what happened since you last looked. Returns `{events, latest, oldest, gap, dropped}`. The log is a ring buffer (last 1000 events), so if your `since` cursor predates `oldest`, `gap` is true and `dropped` counts the silently-evicted events — when that happens, resync from a full get_store/get_graph snapshot instead of trusting the partial catch-up.',
  inputSchema: {
    type: 'object',
    properties: {
      since: { type: 'number', description: 'Only return events with seq > this. Default 0 (all).' },
    },
  },
  async handler({ since }) {
    const q = since != null ? `?since=${encodeURIComponent(since)}` : '';
    return await client.get('/api/events' + q);
  },
};
