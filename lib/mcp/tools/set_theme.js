const client = require('../client');

const VOCAB =
  'Token vocabulary (CSS custom properties, all `--wc-` prefixed; values are partial — unset ones fall through to defaults): ' +
  '--wc-bg (page/canvas background), --wc-fg (text), --wc-panel-bg (panes/topbar/drawer/overlay), ' +
  '--wc-header-bg (pane & section headers), --wc-muted (secondary text), --wc-border, --wc-border-light, ' +
  '--wc-accent / --wc-accent-dark (primary blue), --wc-gold (lock/viewed/bookmark), --wc-green (active chip/primary button), ' +
  '--wc-radius / --wc-radius-sm / --wc-radius-lg (corner radii), --wc-shadow, --wc-font / --wc-mono (font stacks), ' +
  '--wc-content-bg / --wc-content-fg / --wc-content-accent (tokens pane CONTENT opts into), ' +
  '--wc-theme-transition (swap-animation duration, e.g. "280ms" or "0ms" to disable).';

module.exports = {
  name: 'set_theme',
  description:
    'Restyle the web-chat surface (chrome + pane content) by setting design tokens and/or a raw-CSS escape hatch at a scope. ' +
    'A theme = { tokens: {"--wc-…":"value"}, css?: "raw css" }. ' +
    'Cascade is pane → node → global: the most specific layer wins per token, and unset tokens fall through to the layer below (then to built-in defaults). ' +
    'Scopes: "global" sets the web-chat-wide default (persists in the project theme.json); "node" attaches a theme to a graph node by its stored id (travels with the node, shows on its surface and glance preview); "pane" themes one mount by its id (does NOT re-render its content). ' +
    'Tokens cross BOTH chrome and shadow-DOM pane content (they inherit through shadow roots). Raw CSS does NOT cross the shadow boundary: at global/node scope `css` styles chrome only; at pane scope `css` styles that pane\'s content only — so tokens are the only lever that reaches both. ' +
    'Set `clear:true` to remove the theme at that scope. ' + VOCAB,
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['global', 'node', 'pane'], description: 'Which layer to set.' },
      target: { type: 'string', description: 'For scope "node": the node\'s stored id. For scope "pane": the mount id. Omit for "global".' },
      tokens: { type: 'object', description: 'Partial map of --wc-* token → CSS value. Unset tokens fall through the cascade.' },
      css: { type: 'string', description: 'Raw CSS escape hatch. Global/node = chrome only; pane = that pane\'s content only.' },
      clear: { type: 'boolean', description: 'Remove the theme at this scope (ignores tokens/css).' },
    },
    required: ['scope'],
  },
  async handler(args) {
    return await client.post('/api/theme', args);
  },
};
