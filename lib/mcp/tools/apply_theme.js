const client = require('../client');

module.exports = {
  name: 'apply_theme',
  description:
    'Apply a named theme at a scope. The name resolves builtin first (case-insensitively), then the local library (this project), then system (~/.web-chat) — so a builtin name cannot be shadowed by a saved theme; list_themes shows which is which. ' +
    'Same scopes and pane → node → global cascade as set_theme: "global" sets the web-chat-wide default, "node" attaches it to a node id, "pane" themes a mount id. ' +
    'Use list_themes to discover names. To apply an ad-hoc (unsaved) theme, use set_theme instead.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name of a saved theme.' },
      scope: { type: 'string', enum: ['global', 'node', 'pane'], description: 'Which layer to apply it at.' },
      target: { type: 'string', description: 'Node id (scope "node") or mount id (scope "pane").' },
    },
    required: ['name', 'scope'],
  },
  async handler(args) {
    return await client.post('/api/theme/apply', args);
  },
};
