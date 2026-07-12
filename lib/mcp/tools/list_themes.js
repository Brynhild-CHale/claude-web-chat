const client = require('../client');

module.exports = {
  name: 'list_themes',
  description:
    'List the named themes saved in the local (this project) and system (~/.web-chat) libraries, each with its name, location, tokens, and css. ' +
    'Check this before composing a theme from scratch — there may already be a saved one to apply_theme.',
  inputSchema: { type: 'object', properties: {} },
  async handler() {
    return await client.get('/api/themes');
  },
};
