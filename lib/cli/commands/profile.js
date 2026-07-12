// `claude-web-chat profile …` — offline authoring helpers for capture profiles.
// Used by the /capture-profile skill to dry-run and validate a DRAFT bundle
// before it is saved into .web-chat/profiles (project) or ~/.web-chat/profiles
// (global). Runs without the daemon — reads bundle files + capture sidecars
// directly. (CLI edits need no restart.)
//
// Subcommands:
//   validate <dir>                         check profile.json + require extract.js/pane.js
//   dry-run  <dir> --capture <id> [--mode reduced|expanded] [--url <url>]
//                                          run extract (+ pane render/reduce) over a captured DOM
//   reload                                 hot-reload profiles into the running daemon (no restart)
//
// `compile` (materialize interact.js from interact.steps) lands with the
// interaction slice; it's intentionally absent here.

const fs = require('fs');
const path = require('path');
const { safeParse } = require('../../capture/profiles');
const { defaultReduce } = require('../../server/routes/capture');
const { projectPaths, findProjectRoot } = require('../../core/paths');
const { discoverPort } = require('../../core/portfiles');
const client = require('../../client');

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) { out[a.slice(2)] = (args[i + 1] && !args[i + 1].startsWith('--')) ? args[++i] : true; }
    else out._.push(a);
  }
  return out;
}

function readMeta(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8'));
}

function loadExtract(dir) {
  const em = require(path.resolve(dir, 'extract.js'));
  const fn = typeof em === 'function' ? em : (em && em.extract);
  if (typeof fn !== 'function') throw new Error('extract.js must export a function or { extract }');
  return fn;
}

function loadPane(dir) {
  const p = path.resolve(dir, 'pane.js');
  if (!fs.existsSync(p)) return null;
  const pane = require(p);
  if (!pane || typeof pane.render !== 'function') throw new Error('pane.js must export { render }');
  return pane;
}

function captureHtml(captureId) {
  const p = path.join(projectPaths(process.cwd()).captures, `${captureId}.html`);
  if (!fs.existsSync(p)) throw new Error(`capture sidecar not found: ${p} (capture from this project first)`);
  return fs.readFileSync(p, 'utf8');
}

function validate(dir) {
  const errors = [];
  let meta;
  try { meta = readMeta(dir); } catch (e) { console.error(`✗ profile.json: ${e.message}`); process.exit(1); }
  if (!meta.name) errors.push('profile.json: missing "name"');
  if (meta.matchers && !Array.isArray(meta.matchers)) errors.push('profile.json: "matchers" must be an array');
  for (const m of (meta.matchers || [])) {
    if (!m || (m.type !== 'domain' && m.type !== 'regex')) errors.push(`matcher: type must be 'domain' or 'regex' (got ${JSON.stringify(m && m.type)})`);
    else if (!m.value) errors.push(`matcher: missing value for ${m.type} matcher`);
    else if (m.type === 'regex') { try { new RegExp(m.value); } catch (e) { errors.push(`matcher: bad regex /${m.value}/: ${e.message}`); } }
  }
  try { loadExtract(dir); } catch (e) { errors.push(`extract.js: ${e.message}`); }
  try { loadPane(dir); } catch (e) { errors.push(`pane.js: ${e.message}`); }

  if (errors.length) { for (const e of errors) console.error(`✗ ${e}`); process.exit(1); }
  console.log(`✓ ${meta.name} valid — ${(meta.matchers || []).length} matcher(s), pane: ${loadPane(dir) ? 'yes' : 'no'}`);
}

function dryRun(dir, opts) {
  if (!opts.capture) { console.error('dry-run requires --capture <id>'); process.exit(1); }
  const html = captureHtml(String(opts.capture));
  const url = opts.url ? String(opts.url) : '';
  const root = safeParse(html);
  const extract = loadExtract(dir);
  const distilled = extract({ url, html, root });
  console.log('--- distilled ---');
  console.log(JSON.stringify(distilled, null, 2));

  const pane = loadPane(dir);
  if (pane) {
    const mode = opts.mode === 'expanded' ? 'expanded' : 'reduced';
    // Mirror production: a pane with no reduce() still gets defaultReduce, so the
    // dry-run preview matches what the surface will actually render.
    const reduced = pane.reduce ? pane.reduce(distilled) : defaultReduce(distilled);
    console.log('--- reduce ---');
    console.log(JSON.stringify(reduced, null, 2));
    console.log(`--- render (mode: ${mode}) ---`);
    console.log(pane.render(distilled, { mode, reduced, mount_id: 'dry-run', profile: readMeta(dir).name }));
  }
}

// Hot-reload profiles into the running daemon (no restart). Discover the port the
// same way the MCP client / restart do: WEB_CHAT_PORT, else the project portfile.
async function reload() {
  const root = findProjectRoot(process.cwd()) || process.cwd();
  const port = discoverPort({ role: 'server', root, env: true });
  if (!port) { console.log('no running daemon — profiles load at next server boot'); return; }
  let res;
  try { res = await client.request(port, 'POST', '/api/profiles/reload', {}, { timeout: 5000 }); }
  catch (e) { console.error(`reload failed: ${e.message}`); process.exit(1); }
  console.log(`✓ reloaded ${res.body.count} user profile(s) — live now, no restart`);
}

function profile(args) {
  const sub = args[0];
  const opts = flags(args.slice(1));
  if (sub === 'reload') return reload();

  const dir = opts._[0];
  if (!sub || !dir) {
    console.error('usage: claude-web-chat profile <validate|dry-run|reload> <dir> [--capture <id>] [--mode reduced|expanded] [--url <url>]');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(dir, 'profile.json'))) {
    console.error(`no profile.json in ${dir}`);
    process.exit(1);
  }
  if (sub === 'validate') return validate(dir);
  if (sub === 'dry-run') return dryRun(dir, opts);
  console.error(`unknown profile subcommand: ${sub} (use validate|dry-run|reload)`);
  process.exit(1);
}

module.exports = profile;
