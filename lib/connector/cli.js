// `claude-web-chat connect …` — the connector's subcommand table (contract 06
// C-06.1; CLI@subcommand-table). lib/cli/commands/connect.js is a thin shim
// over main() here; every connect subcommand is ONE row of ROWS below, and a
// later unit adds its subcommand by appending exactly one row that lazily
// requires its own module (offer/withdraw/folders, <hub-url> and run,
// disconnect/ceiling/cap, ls/open/shell/code, attach; no pause/resume —
// pause is the hub's machine setting, 05 C-05.19). A second
// dispatcher, or a subcommand parsed anywhere but through this table, is the
// defect the table exists to prevent.
//
// A row is
//   { name, usage, summary, match?(arg) → boolean, run(args, deps) → Promise<exit code> }
//   * name    — the word that selects it (`connect status`);
//   * usage   — its usage line, without the `claude-web-chat ` prefix;
//   * summary — one short sentence for the usage block;
//   * match   — optional: a row with no fixed word (the hub URL) says whether
//               it takes the first argument, asked only when no row's name is
//               that argument, rows in table order;
//   * run     — selected by name it gets the arguments AFTER the name; selected
//               by match() it gets them all (the matched argument is its input).
//               It answers the process exit code.
//
// `connect` with no arguments, or with one no row takes, prints the usage to
// stderr and answers 1; `connect help` prints it to stdout and answers 0.
// Neither dials, writes or runs anything (the alpha smoke's line, REQ@alpha7-
// checks): nothing is created under ~/.web-chat, not even the connector
// directory.
//
// `connect status` is read-only too: it reads the records through
// lib/setup/connector.js (the one record reader) and the registry's
// connector row, and prints what they say — never the key's content, a secret
// or a token, none of which a record holds or this file opens.

const { stripControls } = require('../core/text');
const { userPaths } = require('../core/paths');
const setup = require('../setup/connector');
const registry = require('../util/registry');

const PREFIX = 'claude-web-chat ';

// Text that came out of a record (a machine or folder name the hub or the user
// chose) is printed clean of control, bidi and invisible characters.
const clean = (v) => stripControls(String(v));
const yesNo = (b) => (b ? 'yes' : 'no');

// The connector's registry row when its process is alive, else null. Read-only:
// readRoleEntry would prune dead rows (a registry write), and `status` writes
// nothing, so the live test is the registry's own isLive over the raw rows.
function liveConnectorRow() {
  return registry.readAllEntries().find((e) => e.role === 'connector' && registry.isLive(e)) || null;
}

function processLine(row) {
  if (!row) return 'Connector process: not running';
  // The connector has no port (C-06.3): a null port prints as nothing.
  const bits = [];
  if (Number.isInteger(row.pid)) bits.push(`pid ${row.pid}`);
  if (Number.isInteger(row.port)) bits.push(`port ${row.port}`);
  return `Connector process: running${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

function recordLines(read) {
  const r = read.value;
  const lines = [];
  const hubName = r.hub.name ? ` "${clean(r.hub.name)}"` : '';
  lines.push(`Connector: hub ${r.hub.id}${hubName} at ${r.hub.origin}`);
  const cred = r.credential;
  lines.push(`  credential: ${cred.state}${cred.fingerprint ? ` · fingerprint ${cred.fingerprint}` : ''}`);
  if (cred.state === 'revoked') lines.push(revokedLine(r));
  lines.push(`  machine: ${r.machine ? `${clean(r.machine.name)} (${r.machine.id})` : 'none yet'}`);
  lines.push(`  ceiling: ${setup.ceilingOf(read)}`);
  const s = r.settings;
  lines.push(`  settings: paused ${yesNo(s.paused)} · agents at once ${s.agents_at_once}`
    + ` · local cap ${Number.isInteger(s.local_cap) ? s.local_cap : 'none'}`
    + ` · accept new chats ${yesNo(s.accept_new_chats)}`);
  lines.push(`  folders: ${r.folders.length}`);
  for (const f of r.folders) {
    lines.push(`    ${clean(f.display)}${f.label ? ` "${clean(f.label)}"` : ''} (${f.id})`);
  }
  lines.push(`  chats: ${r.chats.length}`);
  for (const c of r.chats) lines.push(`    ${c.chat_id} · ${c.scope_kind} · ${c.desired}`);
  const lr = r.last_reported;
  if (lr) {
    lines.push(`  last reported: connector ${lr.connector_version ? clean(lr.connector_version) : 'unknown'}`
      + ` · install ${lr.install_kind || 'unknown'}`
      + ` · Claude Code ${lr.claude_code_version ? clean(lr.claude_code_version) : 'unknown'}`);
  } else {
    lines.push('  last reported: nothing yet');
  }
  lines.push(`  service: ${r.service ? `${r.service.kind} ${clean(r.service.unit_path)}` : 'foreground only'}`);
  return lines;
}

// A revoked record's one line (U726b), from the record alone: the hub's hint
// is never stored (the record is closed); `connect run` printed it into the
// connector's log, so the line says where it is and how to pair again.
function revokedLine(r) {
  const at = Number.isFinite(r.credential.revoked_at)
    ? new Date(r.credential.revoked_at).toISOString() : 'at a time the record does not hold';
  return `  revoked: ${at}; the hub's message, if it sent one, is in the connector's log (${userPaths().connectorLog}, `
    + `or the terminal of a foreground \`connect run\`); pair again with \`${require('./run').pairAgain(r.hub.origin)}\``;
}

async function status(args, deps) {
  const records = deps.listRecords();
  if (!records.length) {
    deps.out('Connector: not paired');
    return 0;
  }
  let code = 0;
  for (const { file, read } of records) {
    if (read.ok) {
      for (const line of recordLines(read)) deps.out(line);
    } else if (read.corrupt) {
      deps.err(`Connector: the record ${file} is unreadable (not JSON, or it cannot be opened)`);
      code = 1;
    } else if (read.invalid) {
      // readRecord's error names a JSON pointer and a rule, never a value.
      const why = read.error && read.error.code === 'EBADRECORD' ? ` (${read.error.message})` : '';
      deps.err(`Connector: the record ${file} is not a connector record${why}`);
      code = 1;
    }
    // absent: removed between the listing and the read — nothing to say.
  }
  deps.out(processLine(deps.connectorRow()));
  return code;
}

// THE TABLE. Append one row per subcommand; keep `status` first.
const ROWS = [
  {
    name: 'status',
    usage: 'connect status',
    summary: 'Show this machine\'s pairing: the hub, the credential, the ceiling, the settings, the folders, the chats and the service',
    run: status,
  },
  {
    name: 'offer',
    usage: 'connect offer <path> [--label <text>]',
    summary: 'Offer a folder to the hub (runs claude-web-chat init there first when it has no .web-chat/)',
    run: (args, deps) => require('./folders').offerCommand(args, deps),
  },
  {
    name: 'withdraw',
    usage: 'connect withdraw <path|id>',
    summary: 'Withdraw an offered folder; its chat is refused and its daemon released',
    run: (args, deps) => require('./folders').withdrawCommand(args, deps),
  },
  {
    name: 'folders',
    usage: 'connect folders',
    summary: 'List the offered folders: id, display path and label',
    run: (args, deps) => require('./folders').foldersCommand(args, deps),
  },
  {
    name: 'attach',
    usage: 'connect attach <chat-label>',
    summary: 'Start the chat\'s Claude Code session here, in its folder, with the web-chat channel (manual mode)',
    run: (args, deps) => require('./attach').run(args, deps),
  },
  {
    name: 'disconnect',
    usage: 'connect disconnect',
    summary: 'Disconnect this machine: release every hold, stop the connector\'s daemons, delete the key, mark the record revoked and remove the unit (chat roots stay)',
    run: (args, deps) => setup.disconnectCommand(args, deps),
  },
  {
    name: 'ceiling',
    usage: 'connect ceiling [read|full]',
    summary: 'Show, or set at this machine, the most any hub principal reaches here; running daemons follow it at once',
    run: (args, deps) => setup.ceilingCommand(args, deps),
  },
  {
    name: 'cap',
    usage: 'connect cap <n>',
    summary: 'Set the local cap on agents at once (0 to 64); it lowers the hub\'s cap, never raises it',
    run: (args, deps) => setup.capCommand(args, deps),
  },
  {
    name: 'ls',
    usage: 'connect ls',
    summary: 'List your chats on every machine the hub knows, numbered (asked through this machine\'s connector)',
    run: (args, deps) => require('./terminal').ls(args, deps),
  },
  {
    name: 'open',
    usage: 'connect open [<chat>]',
    summary: 'Open the chat\'s live Claude Code session in this terminal, here or over ssh',
    run: (args, deps) => require('./terminal').open(args, deps),
  },
  {
    name: 'shell',
    usage: 'connect shell [<chat>]',
    summary: 'Open a login shell in the chat\'s folder, here or over ssh',
    run: (args, deps) => require('./terminal').shell(args, deps),
  },
  {
    name: 'code',
    usage: 'connect code [<chat>]',
    summary: 'Open the chat\'s folder in VS Code, here or over ssh-remote',
    run: (args, deps) => require('./terminal').code(args, deps),
  },
  {
    // Taken by name (`connect pair <hub-url>`) or by match(): a hub address
    // typed as the first word (an https URL or a bare host name; an http URL
    // and a unix: address too, which the row refuses with its own sentence).
    name: 'pair',
    usage: 'connect <hub-url> [--workdir <dir>] [--re-pair] [--json] [--insecure-loopback] [--pair-only]',
    summary: 'Pair this machine with a hub when it is not paired, then write and start the start-at-login service and wait for its first hello (--insecure-loopback: a plain-http hub on this machine\'s loopback only; --pair-only: pair, then stop with no service written or started)',
    match: (arg) => require('./install').looksLikeHub(arg),
    run: (args, deps) => require('./install').install(args, deps),
  },
  {
    name: 'run',
    usage: 'connect run [--insecure-loopback]',
    summary: 'Run the connector in the foreground: what the start-at-login service runs (it never pairs)',
    run: (args, deps) => require('./run').run(args, deps),
  },
  {
    name: 'rotate',
    usage: 'connect rotate [--no-wait]',
    summary: 'Rotate this machine\'s key now: the running connector offers the hub a new key and prints the old and new key ids',
    run: (args, deps) => require('./run').rotate(args, deps),
  },
];

function usageText(rows = ROWS) {
  const lines = [`usage: ${PREFIX}connect <subcommand>`];
  const all = [...rows, { usage: 'connect help', summary: 'Show this message' }];
  for (const row of all) {
    lines.push(`  ${PREFIX}${row.usage}`);
    lines.push(`      ${row.summary}`);
  }
  return lines.join('\n');
}

function withDefaults(deps = {}) {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    listRecords: setup.listRecords,
    connectorRow: liveConnectorRow,
    ...deps,
  };
}

// Pick the row args[0] names, else the first row whose match() takes it.
function pick(args, rows = ROWS) {
  const first = args[0];
  if (typeof first !== 'string' || !first) return null;
  const named = rows.find((r) => r.name === first);
  if (named) return { row: named, args: args.slice(1) };
  const matched = rows.find((r) => typeof r.match === 'function' && r.match(first));
  if (matched) return { row: matched, args: args.slice() };
  return null;
}

async function main(args = [], deps) {
  const d = withDefaults(deps);
  const first = args[0];
  if (first === 'help' || first === '--help' || first === '-h') {
    d.out(usageText());
    return 0;
  }
  const chosen = pick(args);
  if (!chosen) {
    if (first) d.err(`connect: unknown subcommand: ${clean(first)}`);
    d.err(usageText());
    return 1;
  }
  const code = await chosen.row.run(chosen.args, d);
  return Number.isInteger(code) ? code : 0;
}

module.exports = { ROWS, main, pick, usageText, status, liveConnectorRow };
