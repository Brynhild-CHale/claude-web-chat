// `claude-web-chat trust` — the ONLY thing that can approve a component's
// host-side service.js.
//
// Why this is a CLI command and not a button on the surface: pane scripts are
// compiled with `new Function` and run in the surface's own window realm, with
// `document`, `fetch` and `WebSocket`, and no CSP is served. A pane can
// synthesise a click on any chrome button, open its own same-origin socket and
// read anything broadcast to the shell, and call any localhost endpoint — so
// nothing in the browser, and no HTTP endpoint, can gate the very code that is
// asking for the grant. The filesystem can: only a real shell writes here.
//
// The consent record is keyed per (project root, service.js hash, params shape),
// so a different project, an edited service, or different params each re-ask.
// That is what stops one `file-editor` approval becoming a machine-wide grant a
// cloned repo can inherit — and stops a fenced approval covering `unfenced:true`.

const fs = require('fs');
const path = require('path');
const { userPaths, findProjectRoot } = require('../../core/paths');
const { createPrompt } = require('../prompt');
const portfiles = require('../../core/portfiles');
const client = require('../../client');

function readTrusted(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeTrusted(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function describeParams(params) {
  const keys = Object.keys(params || {});
  if (!keys.length) return 'no params';
  return keys.map((k) => `${k}=${JSON.stringify(params[k])}`).join(' ');
}

// noSpawn throughout: approving trust must never be the thing that starts a
// daemon. If nothing is running there is nothing pending, and we say so.
async function fetchPending(root) {
  const info = portfiles.readPortfile('server', { root });
  if (!info) return { ok: false, reason: 'no running web-chat server for this project' };
  try {
    const body = await client.get('/api/services/pending', { port: info.port, root, noSpawn: true });
    if (!body || !body.ok) return { ok: false, reason: 'server did not report pending requests' };
    return { ok: true, pending: body.pending || [], root: body.root || root };
  } catch (e) {
    return { ok: false, reason: `could not reach the server: ${e.message}` };
  }
}

async function nudge(root) {
  const info = portfiles.readPortfile('server', { root });
  if (!info) return;
  try { await client.post('/api/services/refresh-trust', {}, { port: info.port, root, noSpawn: true }); }
  catch { /* best effort — the supervisor re-reads the file on its next reconcile anyway */ }
}

// Write one decision per pending request.
function record(file, requests, { root, deny }) {
  const data = readTrusted(file);
  for (const p of requests) {
    data[p.key] = {
      name: p.name,
      hash: p.hash,
      root,
      params: p.params || {},
      approved: !deny,
      [deny ? 'denied_at' : 'approved_at']: Date.now(),
    };
  }
  writeTrusted(file, data);
  return data;
}

function printGrant(file, deny, what) {
  if (deny) {
    console.log(`Denied ${what}. It will not run, and you will not be asked again for this exact request.`);
    return;
  }
  console.log(`Approved ${what} for this project.`);
  console.log(`Recorded in ${file}`);
  console.log('It will start as soon as its pane is on screen. Editing the service, opening it');
  console.log('in another project, or spawning it with different params will ask again.');
}

async function trust(args = []) {
  const root = findProjectRoot(process.cwd()) || process.cwd();
  const file = userPaths().trustedServices;
  const deny = args.includes('--deny');
  const all = args.includes('--all');
  const name = args.find((a) => !a.startsWith('-'));

  const res = await fetchPending(root);
  if (!res.ok) {
    console.error(`${res.reason}.`);
    console.error('Start it with `claude-web-chat open`, then open a pane that uses the service.');
    process.exit(1);
  }

  if (all) {
    if (!res.pending.length) {
      console.log('No services are waiting for approval.');
      return;
    }
    console.log(`${res.pending.length} service${res.pending.length === 1 ? '' : 's'} waiting for approval in ${res.root}:`);
    console.log();
    for (const p of res.pending) {
      console.log(`  ${p.name}`);
      console.log(`    service.js sha256: ${String(p.hash).slice(0, 16)}…`);
      console.log(`    params:            ${describeParams(p.params)}`);
    }
    console.log();
    console.log(deny
      ? 'Denying all of these means none will run, and you will not be asked again for these exact requests.'
      : 'Each one runs as a process on your machine, with your permissions.');
    console.log();

    // Deliberately NO --yes escape here. `pack install --yes` has one because
    // writing files is recoverable; approving host execution is not, so there is
    // no non-interactive path to a grant. In CI, a pipe or a hook the shared
    // prompt engine resolves this to its printed default — No — and says so.
    const prompt = createPrompt();
    let ok;
    try {
      ok = await prompt.confirm(
        deny ? `Deny all ${res.pending.length}?` : `Approve all ${res.pending.length}?`,
        { def: false },
      );
    } finally { prompt.close(); }

    if (!ok) { console.log('Nothing was changed.'); return; }

    record(file, res.pending, { root: res.root, deny });
    await nudge(root);
    printGrant(file, deny, `${res.pending.length} service${res.pending.length === 1 ? '' : 's'}`);
    return;
  }

  if (!name) {
    if (!res.pending.length) {
      console.log('No services are waiting for approval.');
      console.log();
      console.log('A request appears when a pane whose component ships a service.js is opened');
      console.log('for the first time in this project.');
      return;
    }
    console.log(`Waiting for approval in ${res.root}:`);
    console.log();
    for (const p of res.pending) {
      console.log(`  ${p.name}`);
      console.log(`    service.js sha256: ${String(p.hash).slice(0, 16)}…`);
      console.log(`    params:            ${describeParams(p.params)}`);
    }
    console.log();
    console.log('Approve one with `claude-web-chat trust <name>` (or `--deny` to refuse).');
    if (res.pending.length > 1) {
      console.log(`Approve all ${res.pending.length} with \`claude-web-chat trust --all\`.`);
    }
    console.log('An approved service runs as a process on your machine with your permissions.');
    return;
  }

  const match = res.pending.filter((p) => p.name === name);
  if (!match.length) {
    console.error(`no pending approval for a service named "${name}".`);
    if (res.pending.length) console.error(`waiting: ${res.pending.map((p) => p.name).join(', ')}`);
    else console.error('nothing is waiting for approval right now.');
    process.exit(1);
  }

  record(file, match, { root: res.root, deny });
  await nudge(root);
  printGrant(file, deny, match.length > 1 ? `${match.length} requests for "${name}"` : `"${name}"`);
}

module.exports = trust;
