const client = require('../client');

module.exports = {
  name: 'get_active',
  description: 'Get the active node id, its hierarchical `label` (e.g. n1.7) — the parent of the next commit — and the current turn `lock` (null when no turn is in flight). Cheaper than `get_graph` when you only need these.',
  inputSchema: { type: 'object', properties: {} },
  async handler() {
    const g = await client.get('/api/graph');
    return { active: g.active, active_label: g.active_label, lock: g.lock };
  },
};
