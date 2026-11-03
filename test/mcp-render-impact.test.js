// The render-impact answer through the MCP tools (annotation engine PLAN.md
// 4F.2; ruling U563-U580@catalogue-tool-edits (a)): `render`, `use_component`
// and `clear` relay the daemon's answer unchanged, so the `annotations` result
// field reaches Claude with no tool file, description or inputSchema edited
// (catalogue 1.0.0 stays). A stub daemon answers each route with the field;
// each handler must hand back exactly what it answered, and the bodies they
// post are the ones they always posted.

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { LISTEN_HOST } = require('../lib/core/cors');

const IMPACT = Object.freeze({ item: 'm1', total: 4, by_type: { comment: 1, highlight: 3 }, shared: 3, private: 1 });
const BULK = Object.freeze({ items: ['m1', 'm2'], total: 5, by_type: { comment: 1, highlight: 4 }, shared: 4, private: 1 });

async function stubDaemon(t) {
  const seen = [];
  const app = express();
  app.use(express.json());
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.post('/api/render', (req, res) => { seen.push(['render', req.body]); res.json({ ok: true, id: req.body.id, owner: 'claude', annotations: IMPACT }); });
  app.post('/api/components/:name/use', (req, res) => {
    seen.push(['use', req.params.name, req.body]);
    res.json({ ok: true, id: req.body.id, owner: 'claude', warning: 'w', annotations: IMPACT });
  });
  app.post('/api/clear', (req, res) => {
    seen.push(['clear', req.body]);
    res.json(req.body.id ? { ok: true, annotations: IMPACT } : { ok: true, kept: ['m3'], annotations: BULK });
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, LISTEN_HOST, () => resolve(s)); });
  const saved = { port: process.env.WEB_CHAT_PORT, mcp: process.env.WEB_CHAT_MCP_SERVER };
  process.env.WEB_CHAT_PORT = String(server.address().port);
  delete process.env.WEB_CHAT_MCP_SERVER;
  t.after(() => new Promise((resolve) => {
    for (const [k, v] of [['WEB_CHAT_PORT', saved.port], ['WEB_CHAT_MCP_SERVER', saved.mcp]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  return seen;
}

test('render, use_component and clear relay the annotations field unchanged (a stub daemon)', async (t) => {
  const seen = await stubDaemon(t);
  const render = require('../lib/mcp/tools/render');
  const use = require('../lib/mcp/tools/use_component');
  const clear = require('../lib/mcp/tools/clear');

  assert.deepStrictEqual(await render.handler({ id: 'm1', html: '<p>x</p>' }), { ok: true, id: 'm1', owner: 'claude', annotations: IMPACT });
  assert.deepStrictEqual(await use.handler({ name: 'w', id: 'm1' }), { ok: true, id: 'm1', owner: 'claude', warning: 'w', annotations: IMPACT });
  assert.deepStrictEqual(await clear.handler({ id: 'm1' }), { ok: true, annotations: IMPACT });
  assert.deepStrictEqual(await clear.handler({}), { ok: true, kept: ['m3'], annotations: BULK });

  // What each tool posted is what it always posted: no new argument.
  assert.deepStrictEqual(seen[0], ['render', { id: 'm1', html: '<p>x</p>' }]);
  assert.deepStrictEqual(seen[1], ['use', 'w', { id: 'm1' }]);
  assert.deepStrictEqual(seen[2], ['clear', { id: 'm1' }]);
  assert.deepStrictEqual(seen[3], ['clear', {}]);
});

test('no tool\'s description or inputSchema names the field (U563-U580@catalogue-tool-edits (a): a result field, the rules text tells Claude)', () => {
  for (const name of ['render', 'use_component', 'clear']) {
    const tool = require(`../lib/mcp/tools/${name}`);
    const text = JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema });
    assert.ok(!/annotations/.test(text), `${name}: the catalogue entry is unchanged`);
  }
});
