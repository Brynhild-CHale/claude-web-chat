const client = require('../client');

module.exports = {
  name: 'get_graph',
  description: 'Get the turn graph topology: every node\'s id/parent_id/created_at/author/trigger_summary/children plus a derived hierarchical `label` (e.g. n1.0, n1.1, n1.1.0) and bookmark fields (`bookmarked`/`name`), plus which node is `active` (where the next turn commits, with its `active_label`) and the current `lock` state. Use this to know where you are and reference prior nodes by their hierarchical label (e.g. n1.7) when talking with the user — the stored id is opaque. Also returns `pending_bookmark` — the name the user gave a graph they just started, which is applied to the next committed node, so `{active:null, pending_bookmark:{name:"release"}}` means "you are at the root of a fresh graph the user called release" — and `pending_reaim`, a navigation the user requested during your turn that will be applied the moment it ends (so `active` is about to move). Nodes written before no-change turns stopped committing may be marked `collapsed:true` — byte-identical to their parent, hidden in the graph viewer. Each surviving node reports the run it stands for as `absorbed`/`absorbed_count`, and `display_parent` is the edge the user actually sees (`parent_id` is still the truth on disk). Reference a node by the label the user can see: a collapsed one is not on their screen.',
  inputSchema: { type: 'object', properties: {} },
  async handler() {
    return await client.get('/api/graph');
  },
};
