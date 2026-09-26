const { patchStore } = require('../domain/store');

function mountStoreRoutes(app, { state, bus }) {
  app.get('/api/store', (req, res) => {
    const keys = req.query.keys ? String(req.query.keys).split(',') : null;
    if (!keys) return res.json(state.store);
    const out = {};
    for (const k of keys) if (k in state.store) out[k] = state.store[k];
    res.json(out);
  });

  app.post('/api/store', (req, res) => {
    patchStore(state, bus, req.body?.patch || {}, { source: 'server' });
    res.json({ ok: true, store: state.store });
  });
}

module.exports = { mountStoreRoutes };
