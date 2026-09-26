const client = require('../client');

module.exports = {
  name: 'get_theme',
  description:
    'Read the resolved theme at a scope, after the pane → node → global cascade. ' +
    'scope "global" returns the web-chat-wide default; "node" returns global ⊕ that node\'s theme; ' +
    '"pane" returns the effective global ⊕ active-node ⊕ pane tokens that the pane actually sees, plus its content `css` and the inherited `chromeCss`. ' +
    'Resolved at one light/dark `mode` (default light; a single-mode theme resolves to its own) — the result reports `mode` and the global theme\'s `modes`. ' +
    'Use this to see what a pane/node currently resolves to before adjusting it with set_theme.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['global', 'node', 'pane'], description: 'Which layer to resolve. Defaults to "global".' },
      target: { type: 'string', description: 'Node id (scope "node") or mount id (scope "pane").' },
      mode: { type: 'string', enum: ['light', 'dark'], description: 'Which mode to resolve. Defaults to light.' },
    },
  },
  async handler(args) {
    const scope = args.scope || 'global';
    const qs = `scope=${encodeURIComponent(scope)}` + (args.target ? `&target=${encodeURIComponent(args.target)}` : '')
      + (args.mode ? `&mode=${encodeURIComponent(args.mode)}` : '');
    return await client.get('/api/theme?' + qs);
  },
};
