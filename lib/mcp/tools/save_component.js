const client = require('../client');

module.exports = {
  name: 'save_component',
  description: 'Promote an HTML/JS payload into a named, reusable component stored under `.web-chat/components/<name>/`. After saving, future renders can call `use_component` with this name + params instead of re-emitting the HTML. The `description` is what you read back in `list_components` to decide when to use this — make it specific (purpose, when to use, what params do). Optionally pair a host-side `service` (a service.js driver) so the component reflects LIVE state: while its pane is on the active graph node, the daemon runs the service and it writes the shared store the pane reacts to (git status, test runs, file watches). First run of a service prompts the user to approve it.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'kebab-case component name.' },
      source: { type: 'string', description: 'HTML/JS source. Scripts inside can read `params` (passed by `use_component`).' },
      description: { type: 'string', description: 'When/why to use this component. Critical for later discovery.' },
      params_schema: { type: 'object', description: 'JSON Schema for the params object the component expects.' },
      seed: { type: 'string', description: 'Optional seed.js source: a browser-side script run to compute default params when the component is mounted from the drawer.' },
      service: { type: 'string', description: 'Optional service.js host-side source. Presence makes this a service-backed component. Must `module.exports = { async start(ctx), async stop?() }`; ctx = { driver, params, mountId, name, log }. In v1 the service writes the store only (ctx.driver.setStore(...)) — no render. The daemon spawns it while its pane is on the active node and stops it when you navigate away or clear the pane.' },
      location: { type: 'string', enum: ['local', 'system'], description: 'local = this project (.web-chat/components); system = ~/.web-chat/components (all projects). Defaults to local.' },
    },
    required: ['name', 'source', 'description'],
  },
  async handler(args) {
    return await client.post('/api/components', args);
  },
};
