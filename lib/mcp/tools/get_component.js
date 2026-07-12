const client = require('../client');

module.exports = {
  name: 'get_component',
  description: 'Fetch the full source + metadata of a saved component. Use this to inspect before editing (re-save with the same name overwrites).',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Component name.' },
    },
    required: ['name'],
  },
  async handler({ name }) {
    return await client.get(`/api/components/${encodeURIComponent(name)}`);
  },
};
