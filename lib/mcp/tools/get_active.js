const client = require('../client');

module.exports = {
  name: 'get_active',
  description: 'Get just the active node id and its hierarchical `label` (e.g. n1.7) — the parent of the next commit. Cheaper than `get_graph` when you only need this one fact.',
  inputSchema: { type: 'object', properties: {} },
  async handler() {
    const g = await client.get('/api/graph');
    return { active: g.active, active_label: g.active_label, lock: g.lock };
  },
};
