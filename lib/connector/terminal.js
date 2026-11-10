// `claude-web-chat connect ls|open|shell|code` (tranche 6, U731; contract 06
// C-06.26a, R23, ruled SW3; 10 C-10.14a): a chat on any machine the hub knows,
// in a terminal, a shell or VS Code, from this machine's CLI.
//
// THE READS. The CLI holds no credential: it asks this machine's running
// connector over its local socket (./local-socket askConnector), which
// forwards exactly ListMachines, ListChats and GetChatAttach to the hub and
// answers as received. Nothing from an answer is written anywhere (no tailnet
// name, login, path or command); nothing is cached between runs.
//
//   connect ls                ListMachines, then ListChats: a numbered pick list,
//                             one row per chat — number, title, machine name,
//                             chat label, state. Plain text.
//   connect open  [<chat>]    the chat's live Claude Code session
//   connect shell [<chat>]    a login shell in the chat's root
//   connect code  [<chat>]    the chat's root in VS Code
//
// <chat> is the chat label (the cht_ id without its prefix), the cht_ id, or a
// unique prefix of either; an ambiguous prefix prints the matching rows and
// exits non-zero. Omitted, the pick list is printed and a number read through
// deps.prompt (lib/cli/prompt's engine, handed in by the CLI); with no
// terminal to ask, it refuses with a hint to name the chat.
//
// WHERE. The GetChatAttach result's machine.id against this machine's paired
// record's machine.id: equal is this machine (never ssh to itself).
//
// WHAT RUNS (C-06.26a "What runs"; lib/connector/exec.js builds and runs every
// plan, an argument list, never a shell on this machine):
//   open   live session here     tmux attach-session -t =<session.name> (the
//                                tmux on the record's service.path_env)
//          live session elsewhere ssh -t <login>@<tailnet> tmux attach-session -t '=<name>'
//          no live session, launch manual (or connector with a terminal
//          command and no session: needs-trust, no-tmux, home-launch-off)
//                                here: the table's `attach` row with the label,
//                                in this process; elsewhere: ssh -t <target>
//                                claude-web-chat connect attach <label>
//          start-first           say the chat must be started from the hub; 1
//          launch none, or no tailnet name on another machine: say so; 1
//          Never `tmux new -A` (10 C-10.14a).
//   shell  here: $SHELL -l in the record's chats[].root (an owned root
//          included); elsewhere: ssh -t <target> claude-web-chat connect shell
//          <label>, so no path crosses
//   code   here: the opener with vscode://file<root>, percent-encoded only where
//          RFC 3986 requires; elsewhere: commands.code, only when it starts with
//          vscode://vscode-remote/ssh-remote+, as the opener's one argument; a
//          null code is reported with its reason, never guessed
//
// commands.terminal and commands.shell are the hub page's Copy text and are
// never run; commands.code is the one hub-composed value passed on. Every ssh
// target is `<login>@<tailnet_name>` from machine.login (the bare host when
// login is null), each checked against a host-name and login grammar first so
// no hub value can become an ssh option; every remote word is quoted by
// C-10.14a's rule (exec.js quoteRemoteWord).

const fs = require('fs');
const path = require('path');
const { stripControls } = require('../core/text');
const { userPaths } = require('../core/paths');
const setup = require('../setup/connector');
const exec = require('./exec');
const localSocket = require('./local-socket');

const clean = (v) => stripControls(String(v));
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const LABEL_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;
const CHAT_ID_RE = /^cht_[0-9a-hjkmnp-tv-z]{26}$/;
// 10's session name is wc-<chat label>; any shorter Crockford tail is taken
// too (a test's fixture), never anything else.
const SESSION_RE = /^wc-[0-9a-hjkmnp-tv-z]{1,64}$/;
// A DNS name (MagicDNS), no trailing dot, never starting with '-'.
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
// A Unix login, never starting with '-' and never holding '@'.
const LOGIN_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,255}$/;
const REMOTE_CODE_PREFIX = 'vscode://vscode-remote/ssh-remote+';
const CLI = 'claude-web-chat';

const USAGE = {
  ls: 'usage: claude-web-chat connect ls',
  open: 'usage: claude-web-chat connect open [<chat>]',
  shell: 'usage: claude-web-chat connect shell [<chat>]',
  code: 'usage: claude-web-chat connect code [<chat>]',
};

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };

function withDefaults(deps = {}) {
  const d = {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    listRecords: setup.listRecords,
    env: process.env,
    platform: process.platform,
    prompt: null,
    ...deps,
  };
  if (typeof d.ask !== 'function') d.ask = (request, socketPath) => localSocket.askConnector({ path: socketPath, request });
  if (typeof d.runPlan !== 'function') d.runPlan = (plan) => exec.runPlan(plan, { env: d.env, platform: d.platform });
  if (typeof d.dispatch !== 'function') d.dispatch = (args) => require('./cli').main(args, deps);
  return d;
}

// This machine's paired record ({hubId, record}), or a refusal.
function pairedRecord(d) {
  for (const { hubId, read } of d.listRecords()) {
    if (!read || !read.ok) continue;
    const r = read.value;
    if (r.credential && r.credential.state === 'paired' && r.machine) return { hubId, record: r };
  }
  return refuse('this machine is not paired with a hub (see claude-web-chat connect status)');
}

// RFC 3986 path characters stay; every other byte of the UTF-8 is %XX.
const PATH_SAFE = /[A-Za-z0-9\-._~!$&'()*+,;=:@/]/;
function encodePath(p) {
  let out = '';
  for (const ch of p) {
    if (PATH_SAFE.test(ch)) { out += ch; continue; }
    for (const b of Buffer.from(ch, 'utf8')) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function sshTarget(machine) {
  if (typeof machine.tailnet_name !== 'string' || !machine.tailnet_name) return null;
  if (!HOST_RE.test(machine.tailnet_name)) refuse('the hub\'s tailnet name for the chat\'s machine is not a host name ssh can take');
  if (machine.login == null) return machine.tailnet_name;
  if (typeof machine.login !== 'string' || !LOGIN_RE.test(machine.login)) refuse('the hub\'s login for the chat\'s machine is not a login ssh can take');
  return `${machine.login}@${machine.tailnet_name}`;
}

function labelOf(chatId) {
  return typeof chatId === 'string' && CHAT_ID_RE.test(chatId) ? chatId.slice(4) : null;
}

// ── the hub reads ──────────────────────────────────────────────────────────

async function read(d, socketPath, type, params) {
  let answer;
  try {
    answer = await d.ask({ type, params }, socketPath);
  } catch (e) {
    return refuse(e && e.message ? e.message : localSocket.NO_CONNECTOR);
  }
  if (!isPlainObject(answer)) return refuse('the connector\'s answer is not an object');
  if (answer.ok === true && isPlainObject(answer.result)) return answer.result;
  if (answer.local) return refuse(clean(answer.error || 'the connector refused the request'));
  const err = isPlainObject(answer.error) ? answer.error : {};
  const msg = err.message ? clean(err.message) : `the hub refused ${type}${err.code ? ` (${clean(err.code)})` : ''}`;
  return refuse(err.hint ? `${msg} ${clean(err.hint)}` : msg);
}

async function chatsAndMachines(d, socketPath) {
  const machines = (await read(d, socketPath, 'ListMachines', {})).machines;
  const chats = (await read(d, socketPath, 'ListChats', {})).chats;
  if (!Array.isArray(machines) || !Array.isArray(chats)) refuse('the hub\'s answer is not a list');
  const names = new Map();
  for (const m of machines) if (isPlainObject(m) && typeof m.machine_id === 'string') names.set(m.machine_id, m.name);
  const rows = chats.filter((c) => isPlainObject(c) && labelOf(c.chat_id));
  return { rows, names };
}

function rowLine(n, width, chat, names) {
  const machine = chat.machine_id != null && names.has(chat.machine_id) ? names.get(chat.machine_id) : '-';
  return `${String(n).padStart(width)}  ${clean(chat.title || '')}  ${clean(machine)}  ${labelOf(chat.chat_id)}  ${clean(chat.state || '')}`;
}

function printRows(d, rows, names, out = d.out) {
  const width = String(rows.length).length;
  rows.forEach((c, i) => out(rowLine(i + 1, width, c, names)));
}

// <chat> → one chat row, or a refusal (an ambiguous prefix prints its rows).
function resolveChat(d, rows, names, wanted) {
  const q = String(wanted).toLowerCase();
  const exact = rows.filter((c) => c.chat_id === q || labelOf(c.chat_id) === q);
  if (exact.length === 1) return exact[0];
  const hits = rows.filter((c) => c.chat_id.startsWith(q) || labelOf(c.chat_id).startsWith(q));
  if (hits.length === 1) return hits[0];
  if (!hits.length) return refuse(`no chat matches ${clean(wanted)} (see claude-web-chat connect ls)`);
  d.err(`${clean(wanted)} matches ${hits.length} chats:`);
  printRows(d, hits, names, d.err);
  return refuse('name the chat by more of its label');
}

async function pickChat(d, socketPath, wanted, verb) {
  const { rows, names } = await chatsAndMachines(d, socketPath);
  if (wanted != null) return resolveChat(d, rows, names, wanted);
  if (!rows.length) return refuse('the hub lists no chats for you');
  printRows(d, rows, names);
  const prompt = d.prompt;
  if (!prompt || prompt.interactive !== true || typeof prompt.line !== 'function') {
    return refuse(`no terminal to ask: name the chat, e.g. claude-web-chat connect ${verb} <chat-label>`);
  }
  const raw = await prompt.line(`Chat number (1-${rows.length}):`);
  const n = /^[0-9]{1,6}$/.test(String(raw).trim()) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > rows.length) return refuse(`not a number from 1 to ${rows.length}`);
  return rows[n - 1];
}

// ── the subcommands ────────────────────────────────────────────────────────

async function ls(args, deps) {
  const d = withDefaults(deps);
  return guarded(d, 'ls', async () => {
    if (args.length) { d.err(USAGE.ls); return 1; }
    const { hubId } = pairedRecord(d);
    const { rows, names } = await chatsAndMachines(d, userPaths().connectorSocket(hubId));
    if (!rows.length) { d.out('No chats.'); return 0; }
    printRows(d, rows, names);
    return 0;
  });
}

// The chat, its GetChatAttach result and where it runs.
async function attachDetails(d, args, verb) {
  if (args.length > 1) return { usage: true };
  const { hubId, record } = pairedRecord(d);
  const socketPath = userPaths().connectorSocket(hubId);
  const chat = await pickChat(d, socketPath, args[0], verb);
  const result = await read(d, socketPath, 'GetChatAttach', { chat_id: chat.chat_id });
  const label = labelOf(result.chat_id);
  if (!label || !isPlainObject(result.machine) || typeof result.machine.id !== 'string' || !isPlainObject(result.commands)) {
    refuse('the hub\'s answer is not a GetChatAttach result');
  }
  if (result.chat_id !== chat.chat_id) refuse('the hub answered for another chat');
  const here = result.machine.id === record.machine.id;
  return { record, result, label, here };
}

function localChat(record, label) {
  const c = record.chats.find((x) => x.chat_id === label);
  if (!c) refuse(`chat ${label} is on this machine but not in its connector record (see claude-web-chat connect status)`);
  if (typeof c.root !== 'string' || !path.isAbsolute(c.root)) refuse(`chat ${label} has no folder in the connector record`);
  return c;
}

function noTailnet(result) {
  return refuse(`the chat's machine ${clean(result.machine.name || '')} reports no tailnet name, so it cannot be reached from here; `
    + 'run the command on that machine');
}

async function run(d, plan, verb) {
  const r = await d.runPlan(plan);
  if (r && r.reason) {
    const what = plan.program === 'shell' ? 'your login shell ($SHELL)' : plan.program === 'opener' ? 'the URL opener' : plan.program;
    d.err(`connect ${verb}: ${what} could not be run${r.reason === 'not-found' ? ' (not found)' : r.reason === 'platform' ? ' (not on this platform)' : ''}`);
    return 1;
  }
  return r && Number.isInteger(r.code) ? r.code : 1;
}

async function open(args, deps) {
  const d = withDefaults(deps);
  return guarded(d, 'open', async () => {
    const got = await attachDetails(d, args, 'open');
    if (got.usage) { d.err(USAGE.open); return 1; }
    const { record, result, label, here } = got;
    const { commands, machine, session } = result;
    const unavailable = isPlainObject(commands.unavailable) ? commands.unavailable : {};
    if (result.launch === 'none') refuse(`chat ${label} has no agent on its machine (launch none)`);
    if (isPlainObject(session)) {
      if (session.multiplexer !== 'tmux' || typeof session.name !== 'string' || !SESSION_RE.test(session.name)) {
        refuse('the hub\'s session for the chat is not a tmux session name');
      }
      if (here) {
        const pathEnv = record.service && typeof record.service.path_env === 'string' ? record.service.path_env : null;
        return run(d, exec.tmuxAttachPlan(session.name, pathEnv), 'open');
      }
      const target = sshTarget(machine);
      if (!target) return noTailnet(result);
      return run(d, exec.sshPlan(target, ['tmux', 'attach-session', '-t', `=${session.name}`]), 'open');
    }
    if (unavailable.terminal === 'start-first') {
      refuse(`chat ${label} has no live session: start it from the hub first, then run this again`);
    }
    const manualArm = result.launch === 'manual'
      || (result.launch === 'connector' && typeof commands.terminal === 'string' && commands.terminal);
    if (!manualArm) {
      if (here) refuse(`chat ${label} has no live session; to start it here, run claude-web-chat connect attach ${label}`);
      if (!sshTarget(machine)) return noTailnet(result);
      refuse(`chat ${label} has no live session to open`);
    }
    if (here) return d.dispatch(['attach', label]);
    const target = sshTarget(machine);
    if (!target) return noTailnet(result);
    return run(d, exec.sshPlan(target, [CLI, 'connect', 'attach', label]), 'open');
  });
}

async function shell(args, deps) {
  const d = withDefaults(deps);
  return guarded(d, 'shell', async () => {
    const got = await attachDetails(d, args, 'shell');
    if (got.usage) { d.err(USAGE.shell); return 1; }
    const { record, result, label, here } = got;
    if (here) {
      const c = localChat(record, label);
      let isDir = false;
      try { isDir = fs.statSync(c.root).isDirectory(); } catch { isDir = false; }
      if (!isDir) refuse(`the folder of chat ${label} is not there any more: ${clean(c.root)}`);
      return run(d, exec.loginShellPlan(c.root), 'shell');
    }
    const target = sshTarget(result.machine);
    if (!target) return noTailnet(result);
    return run(d, exec.sshPlan(target, [CLI, 'connect', 'shell', label]), 'shell');
  });
}

async function code(args, deps) {
  const d = withDefaults(deps);
  return guarded(d, 'code', async () => {
    const got = await attachDetails(d, args, 'code');
    if (got.usage) { d.err(USAGE.code); return 1; }
    const { record, result, label, here } = got;
    if (here) {
      const c = localChat(record, label);
      return run(d, exec.openerPlan(`vscode://file${encodePath(c.root)}`), 'code');
    }
    const url = result.commands.code;
    if (url == null) {
      const why = isPlainObject(result.commands.unavailable) ? result.commands.unavailable.code : null;
      const reason = why === 'owned-root' ? 'its root is the connector\'s own folder, which VS Code cannot reach by ssh-remote'
        : why === 'no-tailnet' ? 'its machine reports no tailnet name'
          : 'the hub gave no VS Code link';
      refuse(`chat ${label} cannot be opened in VS Code from here: ${reason}`);
    }
    if (typeof url !== 'string' || !url.startsWith(REMOTE_CODE_PREFIX) || /[\s\0-\x1f\x7f]/.test(url)) {
      refuse('the hub\'s VS Code link is not a vscode-remote ssh-remote URL; nothing was opened');
    }
    return run(d, exec.openerPlan(url), 'code');
  });
}

// A refusal prints `connect <verb>: <message>` and answers 1.
async function guarded(d, verb, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    d.err(`connect ${verb}: ${e.message}`);
    return 1;
  }
}

module.exports = {
  ls, open, shell, code, encodePath, resolveChat, USAGE, REMOTE_CODE_PREFIX,
};
