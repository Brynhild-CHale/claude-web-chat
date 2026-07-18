const client = require('../client');

module.exports = {
  name: 'use_component',
  description: 'Render a saved component by name with params. Equivalent to `render` but uses stored source instead of an inline payload — cheaper and more consistent across calls.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Component name (must already be saved).' },
      params: { type: 'object', description: 'Params passed to the component\'s script as the `params` global. Shape defined by the component\'s params_schema. Server-recognized keys ride here too: `form_reset:true` drops the mount\'s persisted form_state on this render (use when supplying fresh prefills); `routing:"none"`/`"auto"` overrides activity routing as in `render`.' },
      id: { type: 'string', description: 'Stable mount id.' },
      target: { type: 'string', description: 'Target slot. Defaults to "main".' },
    },
    required: ['name'],
  },
  async handler({ name, params, id, target }) {
    return await client.post(`/api/components/${encodeURIComponent(name)}/use`, { params, id, target });
  },
};
