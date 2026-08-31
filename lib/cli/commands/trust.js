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
//
// Which is exactly why `trust <name>` REFUSES when the name matches more than one
// pending request: the daemon went to the trouble of keeping the fenced and the
// unfenced `file-editor` apart, and a by-name approval that wrote both decisions
// at once — printing neither params set and asking nothing — handed that
// distinction back. A pane can mount the same component a second time with any
// params it likes before the user walks to the terminal. So an ambiguous name
// prints every waiting request and makes the user pick one with `--params-fp`
// (the fingerprint, or the full trust key, from the listing) or take all of them
// deliberately with `--all`.

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

// ONE way a waiting request is described, so the no-argument listing, `--all`
// and the ambiguity refusal all show the same three lines — including the
// fingerprint, which is the selector the refusal tells the user to pass back.
function printRequest(p, out = console.log) {
  out(`  ${p.name}`);
  out(`    service.js sha256: ${String(p.hash).slice(0, 16)}…`);
  out(`    params:            ${describeParams(p.params)}`);
  out(`    params fingerprint: ${p.params_fp || '(unknown)'}`);
}

// Flags-aware, because `--params-fp <fp> <name>` must not read the fingerprint as
// the name. Only the first bare token is the name; everything else is a flag or
// a flag's value.
function parseArgs(args) {
  const out = { deny: false, all: false, name: null, select: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--deny') out.deny = true;
    else if (a === '--all') out.all = true;
    else if (a === '--params-fp' || a === '--key') out.select = args[++i] || null;
    else if (a.startsWith('--params-fp=')) out.select = a.slice('--params-fp='.length);
    else if (a.startsWith('--key=')) out.select = a.slice('--key='.length);
    else if (a.startsWith('-')) continue;
    else if (!out.name) out.name = a;
  }
  return out;
}

// The selector matches either half of what the listing prints: the params
// fingerprint or the full trust key. Both name the same identity; asking the
// user to know which one we wanted would be a trap.
function selects(p, sel) {
  const s = String(sel).trim().toLowerCase();
  return String(p.params_fp || '').toLowerCase() === s || String(p.key || '').toLowerCase() === s;
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

function printGrant(file, deny, what, requests = []) {
  console.log(deny
    ? `Denied ${what}. It will not run, and you will not be asked again for this exact request.`
    : `Approved ${what} for this project.`);
  // Name the params that were decided. A by-name approval used to print the
  // component name alone, so the user never saw WHICH shape they had granted —
  // and params are what `unfenced:true` changes.
  for (const p of requests) console.log(`  ${p.name} — ${describeParams(p.params)}`);
  if (deny) return;
  console.log(`Recorded in ${file}`);
  console.log('It will start as soon as its pane is on screen. Editing the service, opening it');
  console.log('in another project, or spawning it with different params will ask again.');
}

async function trust(args = []) {
  const root = findProjectRoot(process.cwd()) || process.cwd();
  const file = userPaths().trustedServices;
  const { deny, all, name, select } = parseArgs(args);

  const res = await fetchPending(root);
  if (!res.ok) {
    console.error(`${res.reason}.`);
    console.error('Start it with `claude-web-chat open`, then open a pane that uses the service.');
    process.exit(1);
  }

  if (all) {
    // `--all` with a name is "all the variants of THIS component", not "every
    // service on the machine": the flag is how a user answers an ambiguous name
    // deliberately, and it must not quietly widen to requests they never asked
    // about.
    const scope = name ? res.pending.filter((p) => p.name === name) : res.pending;
    if (!scope.length) {
      console.log(name
        ? `No services named "${name}" are waiting for approval.`
        : 'No services are waiting for approval.');
      return;
    }
    console.log(`${scope.length} service${scope.length === 1 ? '' : 's'} waiting for approval in ${res.root}:`);
    console.log();
    for (const p of scope) printRequest(p);
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
        deny ? `Deny all ${scope.length}?` : `Approve all ${scope.length}?`,
        { def: false },
      );
    } finally { prompt.close(); }

    if (!ok) { console.log('Nothing was changed.'); return; }

    record(file, scope, { root: res.root, deny });
    await nudge(root);
    printGrant(file, deny, `${scope.length} service${scope.length === 1 ? '' : 's'}`, scope);
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
    for (const p of res.pending) printRequest(p);
    console.log();
    console.log('Approve one with `claude-web-chat trust <name>` (or `--deny` to refuse).');
    console.log('Two requests for one component differ only in their params: pick one with');
    console.log('`claude-web-chat trust <name> --params-fp <fingerprint>`.');
    if (res.pending.length > 1) {
      console.log(`Approve all ${res.pending.length} with \`claude-web-chat trust --all\`.`);
    }
    console.log('An approved service runs as a process on your machine with your permissions.');
    return;
  }

  const byName = res.pending.filter((p) => p.name === name);
  if (!byName.length) {
    console.error(`no pending approval for a service named "${name}".`);
    if (res.pending.length) console.error(`waiting: ${res.pending.map((p) => p.name).join(', ')}`);
    else console.error('nothing is waiting for approval right now.');
    process.exit(1);
  }

  const match = select ? byName.filter((p) => selects(p, select)) : byName;
  if (select && !match.length) {
    console.error(`no pending request for "${name}" with params fingerprint "${select}".`);
    console.error(`waiting for "${name}": ${byName.map((p) => p.params_fp).join(', ')}`);
    process.exit(1);
  }

  // More than one waiting request under this name means the panes asked for
  // DIFFERENT params, which is the one distinction the trust key exists to keep.
  // Deciding them in a batch the user never saw is the whole finding this
  // refusal closes — a pane can mount `file-editor` a second time with
  // `unfenced:true` and inherit the fenced approval the user was about to give.
  if (match.length > 1) {
    console.error(`"${name}" has ${match.length} requests waiting, and they differ in their params:`);
    console.error('');
    for (const p of match) printRequest(p, console.error);
    console.error('');
    console.error(`${deny ? 'Denying' : 'Approving'} one of these must not decide the others, so nothing was written.`);
    console.error(`Pick one:  claude-web-chat trust ${name} --params-fp <fingerprint>${deny ? ' --deny' : ''}`);
    console.error(`Or all ${match.length}: claude-web-chat trust ${name} --all${deny ? ' --deny' : ''}`);
    process.exit(1);
  }

  record(file, match, { root: res.root, deny });
  await nudge(root);
  printGrant(file, deny, `"${name}"`, match);
}

module.exports = trust;
