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
  try {
    const { body } = await client.request(info.port, 'POST', '/api/unlock', '{}');
    const r = body && typeof body === 'object' ? body : {};
    console.log(r.cleared ? `lock cleared (server ${info.url})` : `no lock was set (server ${info.url})`);
  } catch (e) {
    console.error(`could not reach server at ${info.url}: ${e.message}`);
    process.exit(1);
  }
}

module.exports = unlock;
