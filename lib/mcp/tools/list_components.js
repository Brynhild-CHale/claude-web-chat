const client = require('../client');

module.exports = {
  name: 'list_components',
  description: 'List all saved components in this project, with their names + descriptions + param schemas. Scan this before rendering from scratch — a component might already exist for what you need.',
  inputSchema: { type: 'object', properties: {} },
  async handler() {
    return await client.get('/api/components');
  },
};
