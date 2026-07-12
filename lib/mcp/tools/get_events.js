const client = require('../client');

module.exports = {
  name: 'get_events',
  description: 'Read the recent event log: renders, clicks, store mutations, graph operations. Filter by sequence number (`since`) to catch up on what happened since you last looked. Returns `{events, latest, oldest, gap, dropped}`. The log is a ring buffer (last 1000 events), so if your `since` cursor predates `oldest`, `gap` is true and `dropped` counts the silently-evicted events — when that happens, resync from a full get_store/get_graph snapshot instead of trusting the partial catch-up.',
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
