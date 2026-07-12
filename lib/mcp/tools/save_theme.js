const client = require('../client');

module.exports = {
  name: 'save_theme',
  description:
    'Save a named, reusable theme to the local (this project\'s .web-chat) or system (~/.web-chat) library so it can be re-applied later with apply_theme. ' +
    'A theme = { tokens: {"--wc-…":"value"}, css?: "raw css" } — see set_theme for the token vocabulary. ' +
    'Pass set_default:true to also make it the web-chat-wide default at that location (project or system), which takes effect immediately. ' +
    'Use when you compose a look worth keeping; otherwise set_theme applies an ad-hoc theme without saving.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Theme name (letters, digits, space, dot, dash; becomes <name>.json).' },
      location: { type: 'string', enum: ['local', 'system'], description: 'local = this project; system = ~/.web-chat (all projects). Defaults to local.' },
      tokens: { type: 'object', description: 'Partial map of --wc-* token → CSS value.' },
      css: { type: 'string', description: 'Optional raw-CSS escape hatch baked into the saved theme.' },
      set_default: { type: 'boolean', description: 'Also set this as the web-chat-wide default at the chosen location.' },
    },
    required: ['name'],
  },
  async handler(args) {
    return await client.post('/api/themes', args);
  },
};
