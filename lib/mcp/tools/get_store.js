const client = require('../client');

module.exports = {
  name: 'get_store',
  description: 'Read keys from the shared store. The store is the canonical channel for surface→Claude state — when a user clicks something or submits a form, the component writes to the store, and this is how you read it back. Without `keys`, returns the whole store.',
  inputSchema: {
    type: 'object',
    properties: {
      keys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific store keys to read. Omit to fetch everything.',
      },
    },
  },
  async handler({ keys }) {
    const path = keys && keys.length ? `/api/store?keys=${encodeURIComponent(keys.join(','))}` : '/api/store';
    return await client.get(path);
  },
};
