const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer } = require('../test-support/helpers');

test('locked pane: render returns rejection envelope (HTTP 200)', async (t) => {
  const { api, root, stop } = await withServer(t);

  // initial render
  await api.post('/api/render', { id: 'p1', html: '<div>a</div>' });
  // Fresh installs now start blank (no auto n0). Commit the live state so a
  // node + _meta.json exist for the seed-and-reboot below.
  await api.post('/api/commit', { message: 'seed' });

  // Direct approach: stop server, write a graph node with locked pane_state, reboot.
  await stop();

  const { resolvePaths } = require('../lib/server/paths');
  const paths = resolvePaths(root);
  // overwrite the committed node to seed a locked mount
  const meta = JSON.parse(fs.readFileSync(paths.META_PATH, 'utf8'));
  const node = JSON.parse(fs.readFileSync(path.join(paths.GRAPH_DIR, meta.active + '.json'), 'utf8'));
  node.mounts = [{ id: 'p1', html: '<div>a</div>', target: 'main', pane_state: { locked: true } }];
  fs.writeFileSync(path.join(paths.GRAPH_DIR, meta.active + '.json'), JSON.stringify(node, null, 2));

  const { api: api2 } = await withServer(t, { root });

  const { status, json } = await api2.post('/api/render', { id: 'p1', html: '<div>b</div>' });
  assert.equal(status, 200);
  assert.equal(json.ok, false);
  assert.equal(json.rejected, true);
  assert.equal(json.locked, true);
  assert.match(json.hint, /locked/);
});
