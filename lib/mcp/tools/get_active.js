const client = require('../client');
const { capLock } = require('../shape');

module.exports = {
  name: 'get_active',
  description: 'Get the active node id, its hierarchical `label` (e.g. n1.7) — the parent of the next commit — and the current turn `lock` (null when no turn is in flight). Cheaper than `get_graph` when you only need these. `lock.message` is the user\'s prompt for the turn in flight, capped at 200 characters; when it is cut, `lock.message_bytes` carries the true length.',
  inputSchema: { type: 'object', properties: {} },
  async handler() {
    const g = await client.get('/api/graph');
    return { active: g.active, active_label: g.active_label, lock: capLock(g.lock) };
  },
};
