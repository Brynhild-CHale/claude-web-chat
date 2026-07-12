const client = require('../client');

module.exports = {
  name: 'inspect_capture',
  description: "Drill into a capture's RAW DOM — the on-demand tier of tab-stream storage. get_captures gives you the distilled summary; reach for this only when you need detail the profile dropped. Scope your read so you don't pull the whole page back into context: pass `selector` (CSS selector → matching elements), `query` (text → surrounding context windows), or `profile` (re-run a named profile, e.g. 'tables', over the raw). With no scope it returns the raw DOM (capped) — prefer scoping.",
  inputSchema: {
    type: 'object',
    properties: {
      capture_id: {
        type: 'string',
        description: "The capture id (e.g. 'cap3'), from get_captures or the tab_capture store key.",
      },
      selector: { type: 'string', description: 'CSS selector; returns matching elements (tag, text, html), capped.' },
      query: { type: 'string', description: 'Text to find; returns occurrences with surrounding context windows.' },
      profile: { type: 'string', description: 'Re-run a named profile over the raw DOM (e.g. tables).' },
      max: { type: 'number', description: 'Max matches/snippets to return (default 20).' },
      context: { type: 'number', description: 'Chars of context around each query hit (default 200).' },
    },
    required: ['capture_id'],
  },
  async handler({ capture_id, selector, query, profile, max, context } = {}) {
    if (!capture_id) throw new Error('capture_id is required');
    const params = [];
    if (selector) params.push(`selector=${encodeURIComponent(selector)}`);
    if (query) params.push(`query=${encodeURIComponent(query)}`);
    if (profile) params.push(`profile=${encodeURIComponent(profile)}`);
    if (max != null) params.push(`max=${encodeURIComponent(max)}`);
    if (context != null) params.push(`context=${encodeURIComponent(context)}`);
    const q = params.length ? `?${params.join('&')}` : '';
    return await client.get(`/api/captures/${encodeURIComponent(capture_id)}/raw${q}`);
  },
};
