const { readPortfile } = require('../../core/portfiles');
const { findProjectRoot } = require('../../core/paths');
const client = require('../../client');

async function unlock() {
  const root = findProjectRoot(process.cwd());
  if (!root) {
    console.log('(no server running)');
    return;
  }
  const info = readPortfile('server', { root });
  if (!info) {
    console.log('(no server running)');
    return;
  }
  // client.post, not the low-level client.request: request() never throws on an
  // HTTP status, so a 404 (a daemon predating the route) or a 500 parsed to a
  // string body and this printed the reassuring "no lock was set" for a lock it
  // had not touched. post() throws a typed HttpError instead — reported as the
  // failure it is, and distinguished from a daemon that could not be reached at
  // all, which is a different thing to tell the user. noSpawn: `unlock` names a
  // running daemon's lock; there is nothing to clear in one it just started.
  try {
    const body = await client.post('/api/unlock', {}, { port: info.port, root, noSpawn: true });
    const r = body && typeof body === 'object' ? body : {};
    console.log(r.cleared ? `lock cleared (server ${info.url})` : `no lock was set (server ${info.url})`);
  } catch (e) {
    if (e instanceof client.HttpError) console.error(`unlock failed (server ${info.url}): ${e.message}`);
    else console.error(`could not reach server at ${info.url}: ${e.message}`);
    process.exit(1);
  }
}

module.exports = unlock;
