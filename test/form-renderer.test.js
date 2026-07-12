const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer } = require('../test-support/helpers');

test('form-renderer is seeded into .web-chat/components on boot', async (t) => {
  const { root } = await withServer(t);

  const formDir = path.join(root, '.web-chat', 'components', 'form-renderer');
  assert.ok(fs.existsSync(path.join(formDir, 'component.html')));
  assert.ok(fs.existsSync(path.join(formDir, 'meta.json')));
  const meta = JSON.parse(fs.readFileSync(path.join(formDir, 'meta.json'), 'utf8'));
  assert.equal(meta.name, 'form-renderer');
  assert.equal(meta.builtin, true);
});

test('GET /api/components lists form-renderer with has_seed=false', async (t) => {
  const { api } = await withServer(t);
  const { json } = await api.get('/api/components');
  const { components } = json;
  const fr = components.find((c) => c.name === 'form-renderer');
  assert.ok(fr, 'form-renderer should be present');
  assert.equal(fr.has_seed, false);
});
