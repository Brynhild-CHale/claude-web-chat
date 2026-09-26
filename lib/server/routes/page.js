// HTTP routes for the page sequence — the markdown items between and around
// panes, and the browser copy of the one markdown renderer. The writes live in
// lib/server/domain/page (putMarkdown / removeMarkdown); this file is the HTTP
// shell over them.
//
//   POST /api/markdown        {id?, text, after?, force?}  put / replace by id
//                             {id, remove:true}            take one off the page
//   GET  /app/markdown.js     the renderer as an ES module (lib/core/markdown
//                             browserModuleSource) — beside the chrome's own
//                             modules, served from the SAME source the preview
//                             and the export render with.
//
// Removal is also reachable through POST /api/clear by id (and a page-wide bulk
// clear takes every markdown item) — the `clear` tool needs no second verb.
const page = require('../domain/page');
const { normalizeOwner, ownerReject } = require('../domain/mounts');
const { browserModuleSource } = require('../../core/markdown');

function mountPageRoutes(app, { state, bus }) {
  app.post('/api/markdown', (req, res) => {
    const body = req.body || {};
    const owner = body.owner;
    if (body.remove) {
      if (body.id == null || body.id === '') return res.status(400).json({ error: 'id required to remove' });
      const id = String(body.id);
      page.ensure(state);
      const rec = state.markdown.get(id);
      if (!rec) return res.json({ ok: true, removed: false, id });
      const who = normalizeOwner(owner);
      if (rec.owner && rec.owner !== who && !body.force) return res.json(ownerReject(id, rec.owner));
      page.removeMarkdown(state, bus, { id, source: who });
      return res.json({ ok: true, removed: true, id });
    }
    if (typeof body.text !== 'string') return res.status(400).json({ error: 'text required' });
    res.json(page.putMarkdown(state, bus, {
      id: body.id, text: body.text, after: body.after, owner, force: !!body.force,
    }));
  });

  app.get('/app/markdown.js', (req, res) => {
    res.type('text/javascript; charset=utf-8').send(browserModuleSource());
  });
}

module.exports = { mountPageRoutes };
