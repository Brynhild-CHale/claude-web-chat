const client = require('../client');

module.exports = {
  name: 'set_store',
  description: 'Write a patch into the shared store. Useful for seeding state a component will read on mount (e.g., setting a list of items before rendering a viewer of them).',
  inputSchema: {
    type: 'object',
    properties: {
      patch: { type: 'object', description: 'Object whose keys+values are merged into the store.' },
    },
    required: ['patch'],
  },
  async handler(args) {
    return await client.post('/api/store', args);
  },
};
