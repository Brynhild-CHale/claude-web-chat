const fs = require('fs');
const path = require('path');
const portfiles = require('../../core/portfiles');
const { findProjectRoot } = require('../../util/root');
const client = require('../../client');

// claude-web-chat export [node] [--mode light|dark]
//   node: a hierarchical label ('n1.7'), a stored id, 'active' (default), or 'live'.
// Writes a self-contained .html under .web-chat/exports/ and prints its path.
// --mode draws any file this command writes (a page, a replay .html, a GIF or
// a video) in that mode of the theme; without it the file is light, whatever
// the browser shows — as the export tool and the routes do.
//
// claude-web-chat export [to] --replay|--gif|--mp4|--webm [--from <node>] [--hold <ms>] [--fade] [--width <px>]
//                        [--prompts|--no-prompts] [--captions on|none]
//   A REPLAY of one lineage, `from` an earlier node down to `to` (default: the
//   active node; `from` defaults to the nearest bookmark above it, else the
//   root): --replay writes it as a self-contained .html player, --gif as an
//   animated GIF drawn by a headless system Chrome, --mp4/--webm as a video
//   (drawn the same way, encoded by ffmpeg — the daemon says so when there is
//   none). Captions show Claude's reply and each node's label and time; the
//   user's prompts are left out unless --prompts puts them in (--no-prompts is
//   the default, spelled out), and --captions none drops the caption bar.
//
// claude-web-chat export --script <file.json> [--replay|--gif|--mp4|--webm|--open] [--hold …]
//   A replay SCRIPT (see the export MCP tool: {from, to, title?, default_hold_ms?,
//   include_prompts?, steps?:[{node | nodes, hold_ms?, caption?, transition?}]})
//   read from a JSON file: it names its own from/to, so no positional node and
//   no --from. Without a format flag it writes the .html player (--replay).
//   --open shows the replay (a script, or [to] --from) in the browser watching
//   the surface instead of writing a file.

const FORMAT_FLAGS = { '--replay': 'replay', '--gif': 'gif', '--mp4': 'mp4', '--webm': 'webm' };
const VALUE_FLAGS = { '--from': 'from', '--hold': 'hold_ms', '--width': 'width', '--captions': 'captions', '--mode': 'mode' };
// Only these mean anything to the player an --open shows (it keeps the
// viewer's own transition and caption choices).
const OPEN_KEYS = ['from', 'include_prompts'];
const CAPTIONS = ['on', 'none'];
const MODES = ['light', 'dark'];

// → { format, ref, body, scriptFile?, open? } | { error }
function parseExportArgs(args = []) {
  let format = 'html';
  let ref = null;
  let scriptFile = null;
  let open = false;
  const body = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--script') {
      const v = args[++i];
      if (v == null || v.startsWith('--')) return { error: '--script needs a file (a replay script as JSON)' };
      scriptFile = v;
    } else if (a === '--open') {
      open = true;
    } else if (FORMAT_FLAGS[a]) {
      if (format !== 'html' && format !== FORMAT_FLAGS[a]) return { error: `pick one of ${Object.keys(FORMAT_FLAGS).join(' / ')}` };
      format = FORMAT_FLAGS[a];
    } else if (a === '--fade') {
      body.transition = 'fade';
    } else if (a === '--prompts' || a === '--no-prompts') {
      if (body.include_prompts === (a === '--no-prompts')) return { error: 'pick one of --prompts / --no-prompts' };
      body.include_prompts = a === '--prompts';
    } else if (VALUE_FLAGS[a]) {
      const v = args[++i];
      if (v == null || v.startsWith('--')) return { error: `${a} needs a value` };
      if (a === '--captions' && !CAPTIONS.includes(v)) {
        return { error: `--captions takes ${CAPTIONS.join(' or ')}${v === 'prompt' ? ' (for prompts in the captions, pass --prompts)' : ''}` };
      }
      if (a === '--mode' && !MODES.includes(v)) return { error: `--mode takes ${MODES.join(' or ')}` };
      body[VALUE_FLAGS[a]] = (a === '--hold' || a === '--width') ? Number(v) : v;
    } else if (a.startsWith('-')) {
      return { error: `unknown option ${a}` };
    } else if (ref == null) {
      ref = a;
    } else {
      return { error: `unexpected argument ${a}` };
    }
  }
  if (scriptFile && (ref || body.from)) return { error: '--script names its own from and to — drop the node argument and --from' };
  if (open) {
    if (format !== 'html') return { error: '--open shows the replay in the browser and writes no file — drop the format flag' };
    const extra = Object.keys(body).filter((k) => !OPEN_KEYS.includes(k));
    if (extra.length) return { error: '--open takes --script, or a node with --from and --prompts' };
    if (ref && ref !== 'active') body.to = ref;
    return { format: 'open', ref, body, ...(scriptFile ? { scriptFile } : {}), open: true };
  }
  if (scriptFile && format === 'html') format = 'replay';
  if (format === 'html') {
    const { mode, ...replayOnly } = body;
    if (Object.keys(replayOnly).length) return { error: '--from/--hold/--fade/--width/--captions/--prompts need --replay, --gif, --mp4 or --webm' };
    return { format, ref: ref || 'active', ...(mode ? { mode } : {}) };
  }
  if (scriptFile) return { format, ref: null, body: { ...body, format }, scriptFile };
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
  let body = parsed.body;
  if (parsed.scriptFile) {
    const script = readScript(parsed.scriptFile);
    if (script.error) {
      console.error(`export: ${script.error}`);
      process.exit(1);
    }
    body = { ...body, script: script.script };
  }
  const page = parsed.format === 'html';
  if (!page && !parsed.open && parsed.format !== 'replay') console.log('rendering the replay in a headless Chrome — this can take a minute…');
  try {
    // ONE low-level call for every shape: this command relays the daemon's own
    // status and error text rather than acting on either.
    const r = await client.request(info.port,
      page ? 'GET' : 'POST',
      page ? '/api/export/' + encodeURIComponent(parsed.ref) + '?format=file' + (parsed.mode ? '&mode=' + encodeURIComponent(parsed.mode) : '')
        : parsed.open ? '/api/replay/open' : '/api/replay/render',
      page ? undefined : body);
    const j = (r.body && typeof r.body === 'object') ? r.body : {};
    if (r.status !== 200 || j.error) {
      console.error(`export failed: ${j.error || ('HTTP ' + r.status)}`);
      if (j.hint) console.error(`  ${j.hint}`);
      process.exit(1);
    }
    if (page) console.log(`exported ${j.label} → ${j.path}`);
    else if (parsed.open) {
      const range = j.from.label === j.to.label ? j.from.label : `${j.from.label} → ${j.to.label}`;
      console.log(`opened the replay ${range} (${j.steps} step${j.steps === 1 ? '' : 's'}) in the player — nothing written`);
      if (j.hint) console.log(`  ${j.hint}`);
    } else {
      console.log(`exported ${j.label} (${j.format}, ${j.frames} frame${j.frames === 1 ? '' : 's'}, ${j.bytes} bytes) → ${j.path}`);
      if (j.include_prompts) console.log('  its captions include your prompts');
    }
  } catch (e) {
    console.error(`could not reach server at ${info.url}: ${e.message}`);
    process.exit(1);
  }
}

// A replay script from a JSON file. → { script } | { error }
function readScript(file) {
  let text;
  try { text = fs.readFileSync(path.resolve(file), 'utf8'); } catch (e) {
    return { error: `cannot read the script ${file}: ${e.code === 'ENOENT' ? 'no such file' : e.message}` };
  }
  try { return { script: JSON.parse(text) }; } catch (e) {
    return { error: `the script ${file} is not JSON: ${e.message}` };
  }
}

module.exports = exportCmd;
module.exports.parseExportArgs = parseExportArgs;
module.exports.readScript = readScript;
