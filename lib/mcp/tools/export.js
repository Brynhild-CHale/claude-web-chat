const client = require('../client');

module.exports = {
  name: 'export',
  description: "Export a rendered page (a graph node) to a self-contained, interactive .html file the user can attach to a message or email. The file inlines every pane's HTML/JS, the store snapshot, and the resolved theme — it opens in any browser with no server and no network. Pass `node` as a hierarchical label (e.g. n1.7), a stored id, 'active' (default — where the next turn commits), or 'live' (the current uncommitted surface). Returns the absolute path of the written file (under .web-chat/exports/). Use when the user wants to share, save, or send a page you've rendered.",
  inputSchema: {
    type: 'object',
    properties: {
      node: {
        type: 'string',
        description: "Which node to export: a hierarchical label ('n1.7'), a stored id, 'active' (default), or 'live'.",
      },
    },
  },
  async handler(args) {
    const ref = (args && args.node) || 'active';
    const r = await client.get('/api/export/' + encodeURIComponent(ref) + '?format=file');
    if (r && r.error) return { error: r.error };
    return { ok: true, path: r.path, label: r.label, hint: `Exported ${r.label} → ${r.path}. Attach this .html file to share the page.` };
  },
};
