const client = require('../client');

module.exports = {
  name: 'list_themes',
  description:
    'List every named theme apply_theme can resolve: the ones web-chat ships (`location:"builtin"`) plus the local (this project) '
    + 'and system (~/.web-chat) libraries, each with its name, location, mode-free tokens and css, and the light/dark `modes` it declares '
    + '(names only — one entry means a single-mode theme). The builtins are the packs: earthy (the stock look, light + dark), paper and georgetown (light only). '
    + 'Check this before composing a theme from scratch — there may already be a saved one to apply_theme.',
  inputSchema: { type: 'object', properties: {} },
  async handler() {
    return await client.get('/api/themes');
  },
};
