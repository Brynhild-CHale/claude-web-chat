const client = require('../client');

module.exports = {
  name: 'get_theme',
  description:
    'Read the resolved theme at a scope, after the pane → node → global cascade. ' +
    'scope "global" returns the web-chat-wide default; "node" returns global ⊕ that node\'s theme; ' +
    '"pane" returns the effective global ⊕ active-node ⊕ pane tokens that the pane actually sees, plus its content `css` and the inherited `chromeCss`. ' +
    'Use this to see what a pane/node currently resolves to before adjusting it with set_theme.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['global', 'node', 'pane'], description: 'Which layer to resolve. Defaults to "global".' },
      target: { type: 'string', description: 'Node id (scope "node") or mount id (scope "pane").' },
    },
  },
  async handler(args) {
    const scope = args.scope || 'global';
    const qs = `scope=${encodeURIComponent(scope)}` + (args.target ? `&target=${encodeURIComponent(args.target)}` : '');
    return await client.get('/api/theme?' + qs);
  },
};
