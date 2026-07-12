const client = require('../client');

module.exports = {
  name: 'get_graph',
  description: 'Get the turn graph topology: every node\'s id/parent_id/created_at/author/trigger_summary/children plus a derived hierarchical `label` (e.g. n1.0, n1.1, n1.1.0) and bookmark fields (`bookmarked`/`name`), plus which node is `active` (where the next turn commits, with its `active_label`) and the current `lock` state. Use this to know where you are and reference prior nodes by their hierarchical label (e.g. n1.7) when talking with the user — the stored id is opaque.',
  inputSchema: { type: 'object', properties: {} },
  async handler() {
    return await client.get('/api/graph');
  },
};
