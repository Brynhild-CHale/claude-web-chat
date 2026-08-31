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
    let r;
    try {
      r = await client.get('/api/export/' + encodeURIComponent(ref) + '?format=file');
    } catch (e) {
      // The route answers an unknown ref with 404 {error}, and client.get turns
      // any >= 400 into a throw — so the `if (r.error)` branch this replaces was
      // unreachable and an unknown label reached Claude as a raw transport error
      // (isError: true). The tool's documented contract is a plain {error, ref}
      // result, so translate the one status that means "the ref is wrong" and
      // let every other failure stay a failure.
      if (e instanceof client.HttpError && e.status === 404) {
        const msg = (e.body && typeof e.body === 'object' && e.body.error) || 'node not found';
        return { error: msg, ref };
      }
      throw e;
    }
    return { ok: true, path: r.path, label: r.label, hint: `Exported ${r.label} → ${r.path}. Attach this .html file to share the page.` };
  },
};
