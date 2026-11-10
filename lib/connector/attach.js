// `claude-web-chat connect attach <chat-label>` — manual mode (contract 06
// C-06.26, the manual row): start the chat's Claude Code session here, at the
// machine, in the chat's root, with web-chat's channel.
//
// It finds the chat in the paired connector record (listRecords; one paired
// record in v1) by its label, the chat_id the hub assigned; checks the root is
// still a folder; builds lib/core/claude-cli's interactive session command
// (sessionCommand: the findClaude binary, the channel flag, WEB_CHAT_CHANNEL=1
// and WEB_CHAT_SUPERVISED=<root>, cwd the root) and runs it with the terminal
// inherited (runSession), answering the session's own exit code as connect's.
//
// The FIRST attach in a chat is recorded as its manual_attach_at (through
// lib/setup/connector updateRecord, under the record's lock), and later ones
// keep it: a manual session is where the user answers Claude Code's workspace
// trust dialog, so it is the only thing that clears connector mode's
// `needs-trust` (C-06.26).
//
// What it never does: type into the session or answer its prompts (C-06.26),
// start a daemon (the session's MCP server waits for the connector's daemon
// under WEB_CHAT_SUPERVISED, 10 C-10.5), set WEB_CHAT_PORT, edit Claude Code's
// config (C-06.25), or name a tmux session (connector mode, the tmux launcher,
// is alpha.8's: REQ@connector-mode).

const fs = require('fs');
const { stripControls } = require('../core/text');
const claudeCli = require('../core/claude-cli');
const setup = require('../setup/connector');

const USAGE = 'usage: claude-web-chat connect attach <chat-label>';
const clean = (v) => stripControls(String(v));

function withDefaults(deps = {}) {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    listRecords: setup.listRecords,
    updateRecord: setup.updateRecord,
    sessionCommand: claudeCli.sessionCommand,
    runSession: claudeCli.runSession,
    env: process.env,
    stdio: 'inherit',
    now: Date.now,
    ...deps,
  };
}

function isFolder(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// The paired record holding the chat whose chat_id is `label`, as
// { hubId, chat }, or null.
function findChat(records, label) {
  for (const { hubId, read } of records) {
    if (!read || !read.ok) continue;
    const r = read.value;
    if (!r.credential || r.credential.state !== 'paired') continue;
    const chat = r.chats.find((c) => c.chat_id === label);
    if (chat) return { hubId, chat };
  }
  return null;
}

async function attach(label, deps) {
  const d = withDefaults(deps);
  if (typeof label !== 'string' || !label) {
    d.err(USAGE);
    return 1;
  }
  const records = d.listRecords();
  if (!records.some((x) => x.read && x.read.ok && x.read.value.credential.state === 'paired')) {
    d.err('connect attach: this machine is not paired with a hub (see claude-web-chat connect status)');
    return 1;
  }
  const found = findChat(records, label);
  if (!found) {
    d.err(`connect attach: no chat ${clean(label)} on this machine (see claude-web-chat connect status)`);
    return 1;
  }
  const { hubId, chat } = found;
  if (!isFolder(chat.root)) {
    d.err(`connect attach: the folder of chat ${chat.chat_id} is not there any more: ${clean(chat.root)}`);
    return 1;
  }
  const cmd = d.sessionCommand({ root: chat.root, env: d.env });
  if (!cmd.exe) {
    d.err(`connect attach: ${claudeCli.NOT_FOUND}; install Claude Code, or put it on PATH`);
    return 1;
  }

  // The first manual attach, kept thereafter (C-06.26's needs-trust gate).
  let still = true;
  try {
    d.updateRecord(hubId, (rec) => {
      const c = rec && rec.chats.find((x) => x.chat_id === chat.chat_id);
      if (!c) { still = false; return null; }
      if (typeof c.manual_attach_at === 'number') return null;
      c.manual_attach_at = d.now();
      return rec;
    });
  } catch (e) {
    const why = e && e.code === 'ERECORD' ? e.message : 'it could not be written';
    d.err(`connect attach: the connector record was not updated: ${clean(why)}`);
    return 1;
  }
  if (!still) {
    d.err(`connect attach: no chat ${chat.chat_id} on this machine any more (see claude-web-chat connect status)`);
    return 1;
  }

  try {
    return await d.runSession(cmd, { stdio: d.stdio });
  } catch (e) {
    d.err(`connect attach: Claude Code could not be started${e && e.code ? ` (${clean(e.code)})` : ''}`);
    return 1;
  }
}

// The table's row: exactly one argument, the chat's label.
function run(args, deps) {
  if (!Array.isArray(args) || args.length !== 1) {
    (deps && deps.err ? deps.err : (line) => console.error(line))(USAGE);
    return Promise.resolve(1);
  }
  return attach(args[0], deps);
}

module.exports = { attach, run, USAGE };
