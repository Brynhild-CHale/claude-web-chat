const client = require('../client');

module.exports = {
  name: 'save_component',
  description: 'Promote an HTML/JS payload into a named, reusable component stored under `.web-chat/components/<name>/`. After saving, future renders can call `use_component` with this name + params instead of re-emitting the HTML. The `description` is what you read back in `list_components` to decide when to use this — make it specific (purpose, when to use, what params do).',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'kebab-case component name.' },
      source: { type: 'string', description: 'HTML/JS source. Scripts inside can read `params` (passed by `use_component`).' },
      description: { type: 'string', description: 'When/why to use this component. Critical for later discovery.' },
      params_schema: { type: 'object', description: 'JSON Schema for the params object the component expects.' },
      location: { type: 'string', enum: ['local', 'system'], description: 'local = this project (.web-chat/components); system = ~/.web-chat/components (all projects). Defaults to local.' },
    },
    required: ['name', 'source', 'description'],
  },
  async handler(args) {
    return await client.post('/api/components', args);
  },
};
