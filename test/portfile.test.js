const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
// The util/portfile module was absorbed into lib/core/portfiles in Phase 1; these
// exercise the webChatDir-based low-level variants (the old API's direct equivalents).
const { readPortfileAt: readPortfile, writePortfileAt: writePortfile, deletePortfileAt: deletePortfile } = require('../lib/core/portfiles');

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-portfile-'));
  return dir;
}

test('portfile: write → read round-trip', () => {
  const dir = tmpDir();
  writePortfile(dir, { pid: process.pid, port: 5173 });
  const info = readPortfile(dir);
  assert.ok(info, 'should read back');
  assert.equal(info.pid, process.pid);
  assert.equal(info.port, 5173);
  assert.equal(info.url, 'http://localhost:5173');
});

test('portfile: missing file returns null', () => {
  const dir = tmpDir();
  assert.equal(readPortfile(dir), null);
});

test('portfile: stale pid returns null', () => {
  const dir = tmpDir();
  // PID 999999 is essentially guaranteed not to exist
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ pid: 999999, port: 5173 }));
  assert.equal(readPortfile(dir), null);
});

test('portfile: unparseable file returns null', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'server.json'), 'not json');
  assert.equal(readPortfile(dir), null);
});

test('portfile: delete removes file', () => {
  const dir = tmpDir();
  writePortfile(dir, { pid: process.pid, port: 5173 });
  deletePortfile(dir);
  assert.equal(fs.existsSync(path.join(dir, 'server.json')), false);
});
