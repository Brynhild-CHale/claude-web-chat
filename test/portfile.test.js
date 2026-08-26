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

// --- the pid guard (an orphaned daemon must not unlink the live one's record) ---

const DEAD_PID = 999999; // essentially guaranteed not to exist

test('portfile: delete with a matching pid removes the file', () => {
  const dir = tmpDir();
  writePortfile(dir, { pid: process.pid, port: 5173 });
  assert.equal(deletePortfile(dir, { pid: process.pid }), true);
  assert.equal(fs.existsSync(path.join(dir, 'server.json')), false);
});

test("portfile: delete refuses to unlink another LIVE process's record", () => {
  const dir = tmpDir();
  // The live daemon has claimed the file; a different, departing process asks
  // to delete it. This is the orphaned-second-daemon case.
  writePortfile(dir, { pid: process.pid, port: 5179 });
  assert.equal(deletePortfile(dir, { pid: DEAD_PID }), false);
  const info = readPortfile(dir);
  assert.ok(info, 'the live record survives');
  assert.equal(info.pid, process.pid);
  assert.equal(info.port, 5179);
});

test('portfile: delete reaps a record whose process is gone', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ pid: DEAD_PID, port: 5173 }));
  // pid:null — "I own nothing, reap it only if nobody live does" (doctor's case).
  assert.equal(deletePortfile(dir, { pid: null }), true);
  assert.equal(fs.existsSync(path.join(dir, 'server.json')), false);
});

test('portfile: pid:null leaves a live record alone', () => {
  const dir = tmpDir();
  writePortfile(dir, { pid: process.pid, port: 5173 });
  assert.equal(deletePortfile(dir, { pid: null }), false);
  assert.ok(readPortfile(dir), 'a daemon that started since the read keeps its record');
});

test('portfile: an unparseable record is removed by a guarded delete', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'server.json'), 'not json');
  assert.equal(deletePortfile(dir, { pid: null }), true);
  assert.equal(fs.existsSync(path.join(dir, 'server.json')), false);
});

test('portfile: an unguarded delete is still unconditional (legacy callers)', () => {
  const dir = tmpDir();
  writePortfile(dir, { pid: process.pid, port: 5173 });
  assert.equal(deletePortfile(dir), true);
  assert.equal(fs.existsSync(path.join(dir, 'server.json')), false);
});

test('portfile: deleting a file that is not there reports false', () => {
  assert.equal(deletePortfile(tmpDir(), { pid: process.pid }), false);
});
