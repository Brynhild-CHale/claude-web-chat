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
// The consent record is keyed per (project root, code, params), so a different
// project, an edited service, or different params each re-ask. That is what
// stops one `file-editor` approval becoming a machine-wide grant a cloned repo
// can inherit — and stops a fenced approval covering `unfenced:true`. A param
// the component marked in its params_schema (`x-trust`: `display`, or
// `project-path` while the value is a path inside the project) is left out of
// the key; the listing prints what each request covers that way.
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
//
// `--pack <name>` approves ahead of time, with no pane open: every service
// component the named pack installed, at its current code, for the panes that
// pass it no exact-valued param (only display-only values and paths inside the
// project). The daemon mints those keys (GET /api/services/pack/:name, read-only)
// and this command writes them, as for every other grant. It never includes a
// pending request for anything wider — an `unfenced:true` file-editor or a path
// outside the project keeps its own key and `trust <name> --params-fp`. It asks
// once, and like `--all` it has no `--yes`.

const fs = require('fs');
const path = require('path');
const { userPaths, findProjectRoot } = require('../../core/paths');
const { describeCovers, describeExact, coversProjectPath, pathReach } = require('../../core/trust-marks');
const { createPrompt } = require('../prompt');
const portfiles = require('../../core/portfiles');
const client = require('../../client');
const { provenance, tierWord } = require('./pack');

function readTrusted(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeTrusted(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// What this command prints that the user did not type came from a pane's params,
// a component's params_schema or a pack record — values a pane script or a
// repository controls. Printed raw, an escape sequence in any of them could
// repaint the very listing the user is about to approve, so control characters
// (C0, DEL, C1) print as `?`. Values already go through JSON.stringify; names do
// not, which is what this is for.
// eslint-disable-next-line no-control-regex
const safe = (s) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f-\x9f]/g, '?');

function describeParams(params) {
  const keys = Object.keys(params || {});
  if (!keys.length) return 'no params';
  return safe(keys.map((k) => `${k}=${JSON.stringify(params[k])}`).join(' '));
}

const coversText = (covers) => safe(describeCovers(covers));
const exactText = (exact) => safe(describeExact(exact));

// ONE way a waiting request is described, so the no-argument listing, `--all`
// and the ambiguity refusal all show the same lines — including the
// fingerprint, which is the selector the refusal tells the user to pass back.
// The sha256 shown is of service.js itself (what the user can check the file
// against); a daemon older than x-trust sends only `hash`, which was the same
// thing. `covers` and `exact` are THIS request's, as the daemon minted them.
function printRequest(p, out = console.log) {
  out(`  ${safe(p.name)}`);
  out(`    service.js sha256: ${safe(String(p.source_hash || p.hash).slice(0, 16))}…`);
  out(`    params:            ${describeParams(p.params)}`);
  const covers = coversText(p.covers);
  if (covers) out(`    covers:            ${covers}`);
  const exact = exactText(p.exact);
  if (exact) out(`    exact:             ${exact}`);
  out(`    params fingerprint: ${safe(p.params_fp || '(unknown)')}`);
}

// Flags-aware, because `--params-fp <fp> <name>` must not read the fingerprint as
// the name. Only the first bare token is the name; everything else is a flag or
// a flag's value. `--pack` takes the next token only when it is not a flag, so
// `--pack --deny` is a missing name rather than a pack called "--deny".
function parseArgs(args) {
  const out = { deny: false, all: false, name: null, select: null, pack: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--deny') out.deny = true;
    else if (a === '--all') out.all = true;
    else if (a === '--params-fp' || a === '--key') out.select = args[++i] || null;
    else if (a.startsWith('--params-fp=')) out.select = a.slice('--params-fp='.length);
    else if (a.startsWith('--key=')) out.select = a.slice('--key='.length);
    else if (a === '--pack') {
      const v = args[i + 1];
      if (v && !v.startsWith('-')) { out.pack = v; i++; } else out.pack = '';
    } else if (a.startsWith('--pack=')) out.pack = a.slice('--pack='.length);
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

// The keys a pack approval would write — minted by the daemon, never here.
// `hint` is the line to print under a failure's reason.
async function fetchPackRequests(root, name) {
  const info = portfiles.readPortfile('server', { root });
  if (!info) {
    return {
      ok: false,
      reason: 'no running web-chat server for this project',
      hint: 'Start it with `claude-web-chat open`: the server works out what a pack approval covers. No pane needs to be open.',
    };
  }
  try {
    const body = await client.get(`/api/services/pack/${encodeURIComponent(name)}`, { port: info.port, root, noSpawn: true });
    if (!body || !body.ok) return { ok: false, reason: 'the server did not report what the pack installed' };
    return { ok: true, pack: body.pack || null, requests: body.requests || [], skipped: body.skipped || [], root: body.root || root };
  } catch (e) {
    if (e && e.status === 404) {
      return {
        ok: false,
        reason: 'the server running for this project predates `trust --pack`',
        hint: 'Restart it on this build with `claude-web-chat restart`, then run this again.',
      };
    }
    return { ok: false, reason: `could not reach the server: ${e.message}` };
  }
}

async function nudge(root) {
  const info = portfiles.readPortfile('server', { root });
  if (!info) return;
  try { await client.post('/api/services/refresh-trust', {}, { port: info.port, root, noSpawn: true }); }
  catch { /* best effort — the supervisor re-reads the file on its next reconcile anyway */ }
}

// Write one decision per request, under the key the daemon minted. `covers`
// rides along when the request has one, so the record says what the approval
// spans beyond its params, and `exact` when it holds a marked param to one
// value; `pack` names the pack a `--pack` decision was made for. All three are
// notes for a person reading the file — the key is the decision.
function record(file, requests, { root, deny, pack = null }) {
  const data = readTrusted(file);
  for (const p of requests) {
    data[p.key] = {
      name: p.name,
      hash: p.hash,
      root,
      params: p.params || {},
      ...(p.covers && Object.keys(p.covers).length ? { covers: p.covers } : {}),
      ...(p.exact && Object.keys(p.exact).length ? { exact: p.exact } : {}),
      ...(pack ? { pack } : {}),
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
  // and params are what `unfenced:true` changes. What the decision covers beyond
  // those values is named too, and so is what it holds to one value.
  for (const p of requests) {
    const covers = coversText(p.covers);
    const exact = exactText(p.exact);
    console.log(`  ${safe(p.name)} — ${describeParams(p.params)}${covers ? `; covers ${covers}` : ''}${exact ? `; exact ${exact}` : ''}`);
  }
  if (deny) return;
  // The by-name path writes without asking (it always has — and the surface's
  // notice names the range before the command is typed), so this is where the
  // terminal says what an approval of a project path lets a pane do.
  const reach = requests.filter((p) => coversProjectPath(p.covers)).map((p) => p.name);
  if (reach.length) console.log(safe(pathReach([...new Set(reach)].join(', '))));
  console.log(`Recorded in ${file}`);
  console.log('It will start as soon as its pane is on screen. Editing the service, opening it');
  console.log('in another project, or spawning it with a different value for a param it does');
  console.log('not cover will ask again.');
}

// Ask once. Deliberately NO --yes escape: `pack install --yes` has one because
// writing files is recoverable; approving host execution is not, so there is no
// non-interactive path to a grant. In CI, a pipe or a hook the shared prompt
// engine resolves this to its printed default — No — and says so.
async function confirmOnce(question, deps) {
  const prompt = deps.prompt || createPrompt();
  try {
    return await prompt.confirm(question, { def: false });
  } finally { if (typeof prompt.close === 'function') prompt.close(); }
}

// Where a pack is installed, and from where: `1.2.0 · installed for this project
// · tarball @ a1b2c3d`. A pack can be in both tiers; each install is named. The
// version and the source come from the pack record, which for a project install
// is a file a repository can commit.
function describeInstalls(installs) {
  return safe((installs || []).map((i) => [
    i.version || null,
    `installed for ${tierWord(i.tier)}`,
    provenance(i.source),
  ].filter(Boolean).join(' · ')).join('; '));
}

function printPackRequest(p, deny) {
  console.log(`  ${safe(p.name)}`);
  console.log(`    service.js sha256: ${safe(String(p.source_hash || p.hash).slice(0, 16))}…`);
  const covers = coversText(p.covers);
  console.log(`    covers:            ${covers || 'a pane with no params only (it declares no x-trust)'}`);
  const note = p.decision === 'approved' ? (deny ? 'approved earlier — denying changes that' : 'already approved')
    : p.decision === 'denied' ? (deny ? 'already denied' : 'denied earlier — approving changes that')
      : null;
  if (note) console.log(`    ${note}`);
}

async function trustPack(opts, { root, file, deps }) {
  const { pack: name, deny } = opts;
  if (opts.all || opts.name || opts.select) {
    console.error('--pack decides the services one pack installed; it does not combine with a component name, --all or --params-fp.');
    process.exit(1);
  }
  if (!name) {
    console.error('--pack needs the name of an installed pack: claude-web-chat trust --pack <name>');
    console.error('`claude-web-chat pack list` shows what is installed.');
    process.exit(1);
  }

  const res = await fetchPackRequests(root, name);
  if (!res.ok) {
    console.error(`${res.reason}.`);
    if (res.hint) console.error(res.hint);
    process.exit(1);
  }
  if (!res.pack) {
    console.error(`no pack named "${name}" is installed in this project or for all projects.`);
    console.error('`claude-web-chat pack list` shows what is installed.');
    process.exit(1);
  }

  const where = describeInstalls(res.pack.installs);
  if (!res.requests.length && !res.skipped.length) {
    console.log(`Pack "${name}" (${where}) installs no service components. There is nothing to approve.`);
    return;
  }

  console.log(`Pack "${name}" — ${where}`);
  console.log(`Its service components, for ${res.root}:`);
  console.log();
  for (const p of res.requests) printPackRequest(p, deny);
  if (res.skipped.length) {
    console.log();
    console.log('Not included:');
    for (const s of res.skipped) {
      console.log(`  ${safe(s.name)} — ${safe(s.reason)}. Decide it per pane: claude-web-chat trust ${safe(s.name)}`);
    }
  }
  console.log();
  if (!res.requests.length) {
    console.log('Nothing was changed.');
    return;
  }

  const n = res.requests.length;
  const target = deny ? 'denied' : 'approved';
  if (res.requests.every((p) => p.decision === target)) {
    console.log(`${n === 1 ? 'It is' : `All ${n} are`} already ${target}. Nothing was changed.`);
    return;
  }
  if (deny) {
    console.log('Denying means none of these runs for a pane that passes it no param but those');
    console.log('listed under covers, and you will not be asked again for those panes.');
  } else {
    console.log('Approving covers each service for a pane that passes it no param but those listed');
    console.log('under covers. A pane that passes anything else (unfenced:true, a path outside the');
    console.log('project) still asks: decide that one with');
    console.log('`claude-web-chat trust <name> --params-fp <fingerprint>`.');
    const reach = res.requests.filter((p) => coversProjectPath(p.covers)).map((p) => p.name);
    if (reach.length) console.log(safe(pathReach(reach.join(', '))));
    console.log('Each runs as a process on your machine, with your permissions. An update of the');
    console.log('pack, or an edit to a service.js, asks again.');
  }
  console.log();

  const ok = await confirmOnce(
    deny ? `Deny ${n === 1 ? 'it' : `all ${n}`}?` : `Approve ${n === 1 ? 'it' : `all ${n}`}?`,
    deps,
  );
  if (!ok) { console.log('Nothing was changed.'); return; }

  record(file, res.requests, { root: res.root, deny, pack: name });
  await nudge(root);
  printGrant(file, deny, `${n} service${n === 1 ? '' : 's'} from pack "${name}"`, res.requests);
}

// deps (test seams; the CLI passes none):
//   cwd    — where to look for the project (default process.cwd())
//   prompt — a lib/cli/prompt engine to confirm through (default a fresh one)
async function trust(args = [], deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const root = findProjectRoot(cwd) || cwd;
  const file = userPaths().trustedServices;
  const opts = parseArgs(args);
  if (opts.pack !== null) return trustPack(opts, { root, file, deps });
  const { deny, all, name, select } = opts;

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

    const ok = await confirmOnce(
      deny ? `Deny all ${scope.length}?` : `Approve all ${scope.length}?`,
      deps,
    );
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
      console.log('for the first time in this project. To approve the services a pack installed');
      console.log('before opening any of them: `claude-web-chat trust --pack <name>`.');
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
    if (res.pending.some((p) => describeCovers(p.covers) || describeExact(p.exact))) {
      console.log('`covers` names what an approval spans beyond the values shown: a display param');
      console.log('whatever its value, a project-path param while its value stays inside this');
      console.log('project. Changing one of those does not ask again; `exact` names a path param');
      console.log('held to the one value shown, and any other value asks again.');
    }
    console.log('An approved service runs as a process on your machine with your permissions.');
    return;
  }

  const byName = res.pending.filter((p) => p.name === name);
  if (!byName.length) {
    console.error(`no pending approval for a service named "${name}".`);
    if (res.pending.length) console.error(`waiting: ${safe(res.pending.map((p) => p.name).join(', '))}`);
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
