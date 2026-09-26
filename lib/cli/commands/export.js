const portfiles = require('../../core/portfiles');
const { findProjectRoot } = require('../../util/root');
const client = require('../../client');

// claude-web-chat export [node]
//   node: a hierarchical label ('n1.7'), a stored id, 'active' (default), or 'live'.
// Writes a self-contained .html under .web-chat/exports/ and prints its path.
//
// claude-web-chat export [to] --replay|--gif|--mp4|--webm [--from <node>] [--hold <ms>] [--fade] [--width <px>]
//   A REPLAY of one lineage, `from` an earlier node down to `to` (default: the
//   active node; `from` defaults to the nearest bookmark above it, else the
//   root): --replay writes it as a self-contained .html player, --gif as an
//   animated GIF drawn by a headless system Chrome, --mp4/--webm as a video
//   (drawn the same way, encoded by ffmpeg — the daemon says so when there is
//   none). Captions are the prompt summary; --captions prompt|none overrides.

const FORMAT_FLAGS = { '--replay': 'replay', '--gif': 'gif', '--mp4': 'mp4', '--webm': 'webm' };
const VALUE_FLAGS = { '--from': 'from', '--hold': 'hold_ms', '--width': 'width', '--captions': 'captions' };

// → { format, ref, body } | { error }
function parseExportArgs(args = []) {
  let format = 'html';
  let ref = null;
  const body = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (FORMAT_FLAGS[a]) {
      if (format !== 'html' && format !== FORMAT_FLAGS[a]) return { error: `pick one of ${Object.keys(FORMAT_FLAGS).join(' / ')}` };
      format = FORMAT_FLAGS[a];
    } else if (a === '--fade') {
      body.transition = 'fade';
    } else if (VALUE_FLAGS[a]) {
      const v = args[++i];
      if (v == null || v.startsWith('--')) return { error: `${a} needs a value` };
      body[VALUE_FLAGS[a]] = (a === '--hold' || a === '--width') ? Number(v) : v;
    } else if (a.startsWith('-')) {
      return { error: `unknown option ${a}` };
    } else if (ref == null) {
      ref = a;
    } else {
      return { error: `unexpected argument ${a}` };
    }
  }
  if (format === 'html') {
    if (Object.keys(body).length) return { error: '--from/--hold/--fade/--width/--captions need --replay, --gif, --mp4 or --webm' };
    return { format, ref: ref || 'active' };
  }
  if (ref && ref !== 'active') body.to = ref;
  body.format = format;
  return { format, ref, body };
}

async function exportCmd(args = []) {
  const parsed = parseExportArgs(args);
  if (parsed.error) {
    console.error(`export: ${parsed.error}`);
    process.exit(1);
  }
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
  const page = parsed.format === 'html';
  if (!page && parsed.format !== 'replay') console.log('rendering the replay in a headless Chrome — this can take a minute…');
  try {
    // ONE low-level call for both shapes: this command relays the daemon's own
    // status and error text rather than acting on either.
    const r = await client.request(info.port,
      page ? 'GET' : 'POST',
      page ? '/api/export/' + encodeURIComponent(parsed.ref) + '?format=file' : '/api/replay/render',
      page ? undefined : parsed.body);
    const j = (r.body && typeof r.body === 'object') ? r.body : {};
    if (r.status !== 200 || j.error) {
      console.error(`export failed: ${j.error || ('HTTP ' + r.status)}`);
      if (j.hint) console.error(`  ${j.hint}`);
      process.exit(1);
    }
    if (page) console.log(`exported ${j.label} → ${j.path}`);
    else console.log(`exported ${j.label} (${j.format}, ${j.frames} frame${j.frames === 1 ? '' : 's'}, ${j.bytes} bytes) → ${j.path}`);
  } catch (e) {
    console.error(`could not reach server at ${info.url}: ${e.message}`);
    process.exit(1);
  }
}

module.exports = exportCmd;
module.exports.parseExportArgs = parseExportArgs;
