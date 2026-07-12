const client = require('../client');

module.exports = {
  name: 'diff_nodes',
  description: 'Diff two graph states instead of pulling both full snapshots into context and comparing by hand. Each of `a` and `b` is a node reference: a hierarchical label (e.g. `n1.2`), an opaque id (`n3`), the keyword `active` (the current commit point), or `live` (the uncommitted live surface — use this to see what the current turn has changed vs a prior node). Returns a token-cheap structural diff: `mounts` ({added, removed, changed, unchanged}) where each changed mount reports only the fields that differ — html as a truncated unified-diff (hunks + added/removed line counts), other fields as {from,to}; `store` ({added, removed, changed, unchanged}); and node-level `theme` token/css deltas. Unchanged content is listed by id/key only, never echoed. Optional `context` sets html hunk context lines (default 2).',
  inputSchema: {
    type: 'object',
    properties: {
      a: { type: 'string', description: 'First node: hierarchical label (n1.2), opaque id (n3), `active`, or `live`.' },
      b: { type: 'string', description: 'Second node: same forms as `a`.' },
      context: { type: 'number', description: 'Context lines around each html diff hunk. Default 2.' },
    },
    required: ['a', 'b'],
  },
  async handler({ a, b, context }) {
    const qs = new URLSearchParams({ a: String(a), b: String(b) });
    if (context != null) qs.set('context', String(context));
    return await client.get('/api/graph/diff?' + qs.toString());
  },
};
