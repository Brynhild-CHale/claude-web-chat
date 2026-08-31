const client = require('../client');

module.exports = {
  name: 'list_components',
  description:
    'List the saved components available here, across both tiers: this project (`location:"local"`, .web-chat/components) and this user (`location:"system"`, ~/.web-chat/components), deduped by name — `shadows` names the tiers a same-named entry hides, and `use_component` resolves the entry listed. '
    + 'Each carries `description`, `params_schema`, `has_seed`, `builtin:true` for the ones web-chat ships, and `has_service`: a host-side service.js the daemon runs while the pane is up, which is what keeps a pane showing LIVE HOST STATE (git, tests, logs, file editing) between your turns — prefer one of those over one-shot terminal output. '
    + 'Scan this before rendering from scratch — a component might already exist for what you need.',
  inputSchema: { type: 'object', properties: {} },
  async handler() {
    return await client.get('/api/components');
  },
};
