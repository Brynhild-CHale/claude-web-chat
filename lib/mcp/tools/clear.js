const client = require('../client');

module.exports = {
  name: 'clear',
  description: 'Remove mounts from the page. Pass `id` to remove one specific mount, `target` to clear a slot, or `{}` to clear everything. Panes owned by a local driver (`owner:"service:*"` in list_mounts) are soft-rejected like a render over them — pass force:true to clear them anyway.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Specific mount id to remove.' },
      target: { type: 'string', description: 'Clear all mounts in this target slot.' },
      force: { type: 'boolean', description: 'Clear panes owned by another writer (a driver) too. Without it, a clear that would take one is soft-rejected.' },
    },
  },
  async handler(args) {
    return await client.post('/api/clear', args);
  },
};
