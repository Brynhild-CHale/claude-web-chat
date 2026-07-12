const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer } = require('../test-support/helpers');

test('draft: graceful shutdown writes draft, reboot restores mounts', async (t) => {
  const { api, root, webChatDir, graceful } = await withServer(t);

  await api.post('/api/render', { id: 'p1', html: '<div>hello</div>' });

  await graceful();

  const draftFile = path.join(webChatDir, 'draft.json');
  assert.ok(fs.existsSync(draftFile), 'draft.json should exist after shutdown');
  const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
  assert.equal(draft.schema_version, 1);
  assert.equal(draft.mounts.length, 1);
  assert.equal(draft.mounts[0].id, 'p1');

  const { api: api2 } = await withServer(t, { root });
  const { json } = await api2.get('/api/mounts');
  assert.equal(json.mounts.length, 1);
  assert.equal(json.mounts[0].id, 'p1');
});

test('draft: commit deletes draft', async (t) => {
  // Seed a draft.json by booting → render → shutdown
  const { api, root, webChatDir, graceful } = await withServer(t);
  await api.post('/api/render', { id: 'p1', html: '<div>hello</div>' });
  await graceful();
  const draftFile = path.join(webChatDir, 'draft.json');
  assert.ok(fs.existsSync(draftFile));

  // Reboot — draft restores; then commit
  const { api: api2 } = await withServer(t, { root });
  const r = await api2.post('/api/commit', { message: 'manual commit' });
  assert.equal(r.status, 200);
  assert.equal(fs.existsSync(draftFile), false, 'draft.json should be deleted on commit');
});

test('draft: empty state does not write draft', async (t) => {
  const { webChatDir, graceful } = await withServer(t);
  await graceful();
  const draftFile = path.join(webChatDir, 'draft.json');
  assert.equal(fs.existsSync(draftFile), false, 'no draft when nothing to save');
});

test('draft: discarded when base_active no longer matches', async (t) => {
  // Seed a draft tied to base_active 'n-bogus'
  const { api, webChatDir } = await withServer(t, {
    seed: ({ webChatDir }) => {
      fs.writeFileSync(path.join(webChatDir, 'draft.json'), JSON.stringify({
        schema_version: 1, saved_at: Date.now(), base_active: 'n-bogus',
        mounts: [{ id: 'ghost', html: '<i>x</i>' }], store: {},
      }));
    },
  });

  const { json } = await api.get('/api/mounts');
  assert.equal(json.mounts.length, 0, 'mismatched draft should be discarded');
  assert.equal(fs.existsSync(path.join(webChatDir, 'draft.json')), false);
});
