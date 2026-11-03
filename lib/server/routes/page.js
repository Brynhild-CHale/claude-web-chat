// HTTP routes for the page sequence — the markdown items between and around
// panes, and the browser copy of the one markdown renderer. The writes live in
// lib/server/domain/page (putMarkdown / removeMarkdown); this file is the HTTP
// shell over them.
//
//   POST /api/markdown        {id?, text, after?, force?}  put / replace by id
//                             {id, remove:true}            take one off the page
//   POST /api/page/reset-layout {run_anchor}               ↺ Claude's layout for one run
//   POST /api/page/run        {anchor, stacks}             a run's narrow-screen flag
//   POST /api/page/move       {id, after}                  a USER move in the sequence
//   GET  /app/markdown.js     the renderer as an ES module (lib/core/markdown
//                             browserModuleSource) — beside the chrome's own
//                             modules, served from the SAME source the preview
//                             and the export render with.
//   GET  /app/anchors.js      the anchor resolver as an ES module (lib/core/anchors browserModuleSource).
//   GET  /app/tier-merge.js   the per-key tier merge as an ES module (lib/core/tier-merge browserModuleSource).
//   GET  /app/element-assets.js  an element type's file grammar, mediaOf, as an ES module
//                             (lib/core/element-assets browserModuleSource; U512's asset(rel)).
//
// Removal is also reachable through POST /api/clear by id (and a page-wide bulk
// clear takes every markdown item) — the `clear` tool needs no second verb.
const page = require('../domain/page');
const { normalizeOwner, ownerReject } = require('../domain/mounts');
const { browserModuleSource } = require('../../core/markdown');
const { browserModuleSource: anchorsModuleSource } = require('../../core/anchors');
const { browserModuleSource: tierMergeModuleSource } = require('../../core/tier-merge');
const { browserModuleSource: strokesModuleSource } = require('../../core/strokes');
const { browserModuleSource: elementAssetsModuleSource } = require('../../core/element-assets');

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

  // The three layout routes are the USER's (the chrome's ↺, its per-run toggle
  // and its drag-reorder): they move `order` and pane_state, never Claude's
  // baseline, and a locked pane refuses a move (domain/page resetLayout /
  // setRunFlag / moveItem). Soft refusals, like every other write.
  app.post('/api/page/reset-layout', (req, res) => {
    const body = req.body || {};
    const anchor = body.run_anchor ?? body.anchor;
    if (anchor == null || anchor === '') return res.status(400).json({ error: 'run_anchor required' });
    res.json(page.resetLayout(state, bus, { anchor: String(anchor) }));
  });

  app.post('/api/page/run', (req, res) => {
    const body = req.body || {};
    if (body.anchor == null || body.anchor === '') return res.status(400).json({ error: 'anchor required' });
    if (typeof body.stacks !== 'boolean') return res.status(400).json({ error: 'stacks (boolean) required' });
    res.json(page.setRunFlag(state, bus, { anchor: String(body.anchor), stacks: body.stacks }));
  });

  app.post('/api/page/move', (req, res) => {
    const body = req.body || {};
    if (body.id == null || body.id === '') return res.status(400).json({ error: 'id required' });
    if (body.after == null || body.after === '') return res.status(400).json({ error: 'after required' });
    res.json(page.moveItem(state, bus, { id: body.id, after: body.after }));
  });

  app.get('/app/markdown.js', (req, res) => {
    res.type('text/javascript; charset=utf-8').send(browserModuleSource());
  });

  app.get('/app/anchors.js', (req, res) => {
    res.type('text/javascript; charset=utf-8').send(anchorsModuleSource());
  });

  app.get('/app/tier-merge.js', (req, res) => {
    res.type('text/javascript; charset=utf-8').send(tierMergeModuleSource());
  });

  app.get('/app/strokes.js', (req, res) => {
    res.type('text/javascript; charset=utf-8').send(strokesModuleSource());
  });

  app.get('/app/element-assets.js', (req, res) => {
    res.type('text/javascript; charset=utf-8').send(elementAssetsModuleSource());
  });
}

module.exports = { mountPageRoutes };
