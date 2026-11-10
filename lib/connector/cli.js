// `claude-web-chat connect …` — the connector's subcommand table (contract 06
// C-06.1; CLI@subcommand-table). lib/cli/commands/connect.js is a thin shim
// over main() here; every connect subcommand is ONE row of ROWS below, and a
// later unit adds its subcommand by appending exactly one row that lazily
// requires its own module (offer/withdraw/folders, <hub-url> and run,
// disconnect/ceiling/cap/pause/resume, ls/open/shell/code, attach). A second
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
