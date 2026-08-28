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
const { safeParse, loadBundle, CTX_HELPERS } = require('../../capture/profiles');
const { defaultReduce, renderProfilePane } = require('../../capture/pane');
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

// Load a bundle through the DAEMON's loader, print its verdict, exit 1 if the
// daemon would refuse it. This command used to be a second loader with its own
// acceptance rules, and the two disagreed three ways — it failed a bundle with
// no `name` that the daemon accepts, passed one named `default` that the daemon
// skips, and rejected an unknown matcher `type` the daemon tolerated. The whole
// point of "offline-test a bundle before saving" is that this verdict IS the
// daemon's.
function loadOrExit(dir) {
  const bundle = loadBundle(dir);
  if (bundle.errors.length) {
    for (const e of bundle.errors) console.error(`✗ ${e}`);
    process.exit(1);
  }
  return bundle;
}

function captureHtml(captureId) {
  const p = path.join(projectPaths(process.cwd()).captures, `${captureId}.html`);
  if (!fs.existsSync(p)) throw new Error(`capture sidecar not found: ${p} (capture from this project first)`);
  return fs.readFileSync(p, 'utf8');
}

function validate(dir) {
  const { meta, name, pane } = loadOrExit(dir);
  console.log(`✓ ${name} valid — ${((meta && meta.matchers) || []).length} matcher(s), pane: ${pane ? 'yes' : 'no'}`);
}

function dryRun(dir, opts) {
  if (!opts.capture) { console.error('dry-run requires --capture <id>'); process.exit(1); }
  const html = captureHtml(String(opts.capture));
  const url = opts.url ? String(opts.url) : '';
  const root = safeParse(html);
  const { name, extract, pane } = loadOrExit(dir);
  // The helper kit rides the ctx, so an extractor that destructures `esc` /
  // `collapse` / `safeHref` — which every bundled one does, and which the skill
  // tells authors to do — only works if the dry-run spreads the SAME helpers the
  // daemon's runProfile spreads. Calling extract with a bare { url, html, root }
  // here would make the offline check fail on exactly the profiles the online
  // path runs fine.
  const distilled = extract({ url, html, root, ...CTX_HELPERS });
  console.log('--- distilled ---');
  console.log(JSON.stringify(distilled, null, 2));

  if (pane) {
    const mode = opts.mode === 'expanded' ? 'expanded' : 'reduced';
    // The reduced payload is shown for its own sake; the render below goes
    // through renderProfilePane — the SAME function the surface calls — so the
    // preview carries the mode wrapper and the reduce fallback rather than a
    // hand-rolled imitation of them.
    console.log('--- reduce ---');
    console.log(JSON.stringify(pane.reduce ? pane.reduce(distilled) : defaultReduce(distilled), null, 2));
    console.log(`--- render (mode: ${mode}) ---`);
    console.log(renderProfilePane(
      { name, pane },
      distilled,
      { mode, mount_id: 'dry-run', profile: name },
    ));
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
