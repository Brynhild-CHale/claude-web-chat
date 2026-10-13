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

// --- whose record it is (U112) ---
//
// A 0.8.5 daemon writes its root (where the file is: the parent of its
// .web-chat directory), its instance id and, for its own pid, its process
// start. A reader at another root treats the record as absent; a guarded
// delete removes such a copy.

const portfiles = require('../lib/core/portfiles');
const registry = require('../lib/util/registry');
const { spawn } = require('child_process');

// <tmp>/<name>/.web-chat — a project root with its state directory.
function projectDir(name, base = tmpDir()) {
  const root = path.join(base, name);
  const webChat = path.join(root, '.web-chat');
  fs.mkdirSync(webChat, { recursive: true });
  return { root, webChat, file: path.join(webChat, 'server.json') };
}

test('portfile: the write carries root, instance and (for the writer\'s own pid only) proc_start', () => {
  const a = projectDir('a');
  const before = Date.now() - process.uptime() * 1000;
  const rec = writePortfile(a.webChat, { pid: process.pid, port: 5173 });
  const onDisk = JSON.parse(fs.readFileSync(a.file, 'utf8'));
  assert.equal(onDisk.root, path.resolve(a.root));
  assert.equal(onDisk.instance, registry.instanceId(a.root));
  assert.equal(onDisk.instance, portfiles.instanceId(a.root));
  assert.ok(Number.isInteger(onDisk.proc_start), 'own pid: proc_start stamped');
  assert.ok(Math.abs(onDisk.proc_start - before) < 1000, 'it is this process\'s start, not the write time');
  assert.equal(portfiles.isPidAlive(process.pid, { startedAt: onDisk.proc_start }), true, 'and sampleProcs reads it back');
  assert.deepEqual(rec, onDisk);
  // A re-write keeps the same start (started_at would not): computed once per
  // process, so exactly the same value (test/instance-id-canonical moves the clocks).
  const again = writePortfile(a.webChat, { pid: process.pid, port: 5173 });
  assert.equal(again.proc_start, onDisk.proc_start);

  const other = writePortfile(a.webChat, { pid: 999999, port: 5174 });
  assert.equal('proc_start' in other, false, 'another pid gets no proc_start');
  const info = readPortfile(a.webChat, { checkLiveness: false });
  assert.deepEqual([info.root, info.instance, info.proc_start], [path.resolve(a.root), registry.instanceId(a.root), null]);
});

test('portfile: a guarded delete removes a copy of another project\'s record and keeps a live own record', () => {
  const base = tmpDir();
  const a = projectDir('a', base);
  const b = projectDir('b', base);
  writePortfile(a.webChat, { pid: process.pid, port: 5173 });
  fs.copyFileSync(a.file, b.file);
  assert.equal(readPortfile(b.webChat), null, 'the copy reads as no record');
  assert.equal(readPortfile(b.webChat, { includeForeign: true }).foreign, path.resolve(a.root));
  // pid:null (doctor) and a number (a departing daemon) both remove the copy,
  // though the pid it names is alive.
  assert.equal(deletePortfile(b.webChat, { pid: null }), true);
  fs.copyFileSync(a.file, b.file);
  assert.equal(deletePortfile(b.webChat, { pid: 999999 }), true);
  // A's own record, naming a live pid, is kept by both.
  assert.equal(deletePortfile(a.webChat, { pid: null }), false);
  assert.equal(deletePortfile(a.webChat, { pid: 999999 }), false);
  assert.ok(readPortfile(a.webChat));
});

test('portfile: a guarded delete removes a record whose live pid started at another time (a reused pid)', async (t) => {
  const a = projectDir('a');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const real = (await portfiles.sampleProcs([child.pid])).get(child.pid);
  assert.equal(real.alive, true);
  const write = (procStart) => fs.writeFileSync(a.file, JSON.stringify({
    pid: child.pid, port: 5173, root: path.resolve(a.root), instance: portfiles.instanceId(a.root), proc_start: procStart,
  }));
  write(real.startedAt);
  assert.equal(deletePortfile(a.webChat, { pid: null }), false, 'its real start: the process that wrote it, kept');
  write(real.startedAt - 3_600_000);
  assert.equal(deletePortfile(a.webChat, { pid: null }), true, 'another start: a reused pid, removed');
});
