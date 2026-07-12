const portfiles = require('../../core/portfiles');
const { findProjectRoot } = require('../../util/root');
const client = require('../../client');

// claude-web-chat export [node]
//   node: a hierarchical label ('n1.7'), a stored id, 'active' (default), or 'live'.
// Writes a self-contained .html under .web-chat/exports/ and prints its path.
async function exportCmd(args = []) {
  const ref = args.find((a) => !a.startsWith('-')) || 'active';
  const root = findProjectRoot(process.cwd());
  if (!root) {
    console.error('not a web-chat project (no .web-chat/) — run `claude-web-chat install` first');
    process.exit(1);
  }
  const info = portfiles.readPortfile('server', { root });
  if (!info) {
    console.error('no server running — run `claude-web-chat open` first');
    process.exit(1);
  }
  try {
    const r = await client.request(info.port, 'GET', '/api/export/' + encodeURIComponent(ref) + '?format=file');
    const j = r.body || {};
    if (r.status !== 200 || j.error) {
      console.error(`export failed: ${j.error || ('HTTP ' + r.status)}`);
      process.exit(1);
    }
    console.log(`exported ${j.label} → ${j.path}`);
  } catch (e) {
    console.error(`could not reach server at ${info.url}: ${e.message}`);
    process.exit(1);
  }
}

module.exports = exportCmd;
