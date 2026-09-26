// The throwaway directories a render works in, under .web-chat/tmp/ — and the
// sweep that removes the ones a dead daemon left behind.
//
// A render makes two: Chrome's profile (lib/replay/chrome launchChrome) and,
// on the ffmpeg path, the frame directory (lib/replay/encode). Each is named
// `<kind>-<pid>-<hex>` for the process that made it, and removed by that
// process when the render ends — close() / dispose(), or its 'exit' hook. A
// daemon that dies outright (SIGKILL, a crash, the power) runs none of those,
// so its directories stay: a whole Chrome user-data dir each, per project,
// with nothing to ever remove them.
//
// sweepStaleTmp removes an entry only when its name is one this module made
// AND the pid in it is no longer alive (lib/core/portfiles isPidAlive). A live
// pid — this daemon, or another process mid-render — is never touched; a name
// that is not ours is never touched. The daemon sweeps at boot (routes/replay)
// and before every render (replay/render), best effort: a sweep never fails
// either.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isPidAlive } = require('../core/portfiles');

const KINDS = Object.freeze(['chrome', 'frames']);
const NAME_RE = new RegExp(`^(${KINDS.join('|')})-(\\d+)-[0-9a-f]{8}$`);

// Make a fresh `<kind>-<pid>-<hex>` directory under `tmpDir`. → its path
function makeTmpDir(tmpDir, kind) {
  if (!KINDS.includes(kind)) throw new Error(`unknown tmp kind '${kind}'`);
  const dir = path.join(tmpDir, `${kind}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); return true; } catch { return false; }
}

// Remove every render directory under `tmpDir` whose owning pid is dead.
// `isAlive` is injectable for a test. → the names removed
function sweepStaleTmp(tmpDir, { isAlive = isPidAlive } = {}) {
  let names;
  try { names = fs.readdirSync(tmpDir); } catch { return []; }
  const removed = [];
  for (const name of names) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    const pid = Number(m[2]);
    if (pid === process.pid || isAlive(pid)) continue;
    const dir = path.join(tmpDir, name);
    let st;
    try { st = fs.lstatSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (removeDir(dir)) removed.push(name);
  }
  return removed;
}

module.exports = { makeTmpDir, sweepStaleTmp, removeDir, KINDS };
