const client = require('../client');

module.exports = {
  name: 'get_captures',
  description: "List tab-stream captures — page snapshots the user sent from the browser extension. Returns each capture's DISTILLED content (the profile's output), which is the agent-visible tier; the full raw DOM is NOT included. Drill into the raw with inspect_capture only when the distillation dropped something you need. Without args, lists captures on the live surface; pass `node` to read a committed graph node's captures, or `since` (a seq cursor) for only newer ones. Captures auto-collect in the queue rail, so a fresh capture reaches you when the user hits Push → Claude (or via parked delivery on their next message) — no wait to arm.",
  inputSchema: {
    type: 'object',
    properties: {
      node: {
        type: 'string',
        description: "A committed node id (e.g. 'n5') to read that node's captures instead of the live surface.",
      },
      since: {
        type: 'number',
        description: 'Only return captures with seq greater than this (catch-up cursor).',
      },
    },
  },
  async handler({ node, since } = {}) {
    const params = [];
    if (node) params.push(`node=${encodeURIComponent(node)}`);
    if (since != null) params.push(`since=${encodeURIComponent(since)}`);
    const q = params.length ? `?${params.join('&')}` : '';
    return await client.get(`/api/captures${q}`);
  },
};
