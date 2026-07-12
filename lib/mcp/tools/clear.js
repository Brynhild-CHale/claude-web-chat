const client = require('../client');

module.exports = {
  name: 'clear',
  description: 'Remove mounts from the page. Pass `id` to remove one specific mount, `target` to clear a slot, or `{}` to clear everything.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Specific mount id to remove.' },
      target: { type: 'string', description: 'Clear all mounts in this target slot.' },
    },
  },
  async handler(args) {
    return await client.post('/api/clear', args);
  },
};
