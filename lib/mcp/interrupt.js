// The Esc injector: the tier-1 interrupt's delivery (spec §15.2, ruling Q-B).
//
// Pressing Esc in Claude Code's terminal does what no hook can: it stops a
// streaming reply, kills the running tool's process tree, declines a pending
// permission prompt and keeps the partial output. Hooks cannot type it — every
// hook runs under setsid with no controlling terminal — but this process can:
// Claude Code spawns web-chat's stdio MCP server as a child in its own process
// group, holding its terminal. So when the daemon's control domain (U81)
// accepts a LOCAL interrupt for this session, it emits one main-bus event
//
//   { kind: 'control', op: 'interrupt', id, conversation_id, session_id,
//     via: 'tty', target_pid, expires_at }
//
// (target_pid the Claude Code pid, expires_at = epoch ms + 2000), and this
// module pushes exactly ONE byte, 0x1b, into the terminal's input queue.
//
// It is a terminal-input-injection primitive, so it is contained (control
// record §4):
//   * The only byte it can write is 0x1b. The write happens in ONE fixed perl
//     program, HELPER_SCRIPT below, run as `perl -e HELPER_SCRIPT <mode>` with
//     mode exactly 'probe' or 'inject'. No request data ever reaches the
//     helper's argv, environment or stdin; the program holds one ioctl call
//     whose only payload is pack('c', 27). The input-injection request's
//     name appears in this repository only inside HELPER_SCRIPT (a ratchet
//     row, §10.2).
//   * It acts only on a fresh event addressed to its own parent (target_pid ===
//     process.ppid), and only when every guard holds (guard(), below): the
//     event unexpired and not dated too far ahead, Claude Code still its parent,
//     no injection in the last 1.5 s (a second Esc 0.6–1.2 s after the first,
//     at idle, opens Rewind), no helper running. The helper's own last check is
//     that Claude Code's process group holds the terminal's foreground.
//   * One injection per accepted event, never a retry. Every refusal is named
//     on stderr: `[claude-web-chat] interrupt refused: <name>`.
//   * No helper outlives this process (stop() kills each through its handle),
//     and nothing here ever spawns a daemon: the event stream discovers a
//     running one, or backs off.
//
// It probes once at start whether this session CAN take an injected Esc, and
// writes the answer into its presence row (presence.setInterrupt: 'tty' or
// null), which the daemon reads as Conversation.process.interrupt to choose
// between this path and the hook halt ("Stop after this step"). The probe
// answers null, with a named reason, unless: the platform is darwin or linux;
// on linux the kernel still allows the injection (legacy setting not '0');
// THE PARENT IS CLAUDE CODE (argv0's basename is `claude`, or node running
// Claude Code's cli.js) — every test that launches the real MCP server runs
// under the test runner, which may sit in the developer's terminal as its
// foreground group, and must never be able to type into it; and the helper
// runs and reports that the group holds the terminal's foreground.
//
// A session that cannot inject opens no stream at all.

const path = require('path');

const MAX_AGE_MS = 2000;        // an event's useful life (U81 stamps now + 2000)
const INJECT_GAP_MS = 1500;     // the least time between two injections
const HELPER_TIMEOUT_MS = 1000; // a helper still running after this is killed
const EXPIRY_SLACK_MS = 500;    // clock skew allowed on expires_at's far side
const DEDUPE_IDS = 64;          // event ids remembered against a replay
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;

const HELPER_MODES = new Set(['probe', 'inject']);

// The helper. Exit codes: 0 done ('probe' prints "fg"), 2 the terminal would not
// open, 3 the process group is not the terminal's foreground, 4 an unknown
// platform, 5 the kernel refused the request, 6 an unknown mode.
const HELPER_SCRIPT = String.raw`use strict;
use POSIX ();
my $mode = defined $ARGV[0] ? $ARGV[0] : '';
exit 6 unless $mode eq 'probe' || $mode eq 'inject';
open(my $tty, '+<', '/dev/tty') or exit 2;
my $fg = POSIX::tcgetpgrp(fileno($tty));
exit 3 unless defined $fg && $fg > 0 && $fg == getpgrp();
if ($mode eq 'probe') { print "fg\n"; exit 0; }
my $TIOCSTI = $^O eq 'darwin' ? 0x80017472 : $^O eq 'linux' ? 0x5412 : 0;
exit 4 unless $TIOCSTI;
ioctl($tty, $TIOCSTI, pack('c', 27)) or exit 5;
exit 0;
`;

// The helper's argv, after the program name. Only the two fixed modes exist.
function helperArgv(mode) {
  if (!HELPER_MODES.has(mode)) throw new Error(`interrupt helper: unknown mode ${JSON.stringify(mode)}`);
  return ['-e', HELPER_SCRIPT, mode];
}

// The helper's spawn options: no stdin, and an environment that carries only
// PATH (perl's own switches, such as PERL5OPT, never ride along).
function helperOptions() {
  const env = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  return { stdio: ['ignore', 'pipe', 'pipe'], env };
}

// Is this command line Claude Code's? `ps -o command=` text: argv0's basename
// `claude`, or a node running @anthropic-ai/claude-code's cli.js.
function isClaudeCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  const line = cmd.trim();
  if (!line) return false;
  const argv0 = path.basename(line.split(/\s+/)[0]);
  if (argv0 === 'claude') return true;
  return /^node(?:js)?(?:[\d.]*)$/.test(argv0)
    && /(?:^|[\s/])@anthropic-ai\/claude-code\/cli\.m?js(?:\s|$)/.test(line);
}

// Run the helper once. → Promise<{code, stdout, error, timedOut}>; never rejects.
// It settles on the helper's exit, a spawn error, or HELPER_TIMEOUT_MS, when the
// helper is killed. `track(child, cancel)`/`untrack(child)` see the child from
// its spawn to its real exit (which, for a helper that ignores the kill, is
// later than the timeout), so a stop() can kill whatever is still alive and
// `cancel()` its timer (the run then settles as timed out).
function runHelper(mode, { spawn, track = () => {}, untrack = () => {}, timeoutMs = HELPER_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('perl', helperArgv(mode), helperOptions());
    } catch (error) {
      resolve({ code: null, stdout: '', error, timedOut: false });
      return;
    }
    let stdout = '';
    let settled = false;
    let gone = false;
    const leave = () => { if (!gone) { gone = true; untrack(child); } };
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    };
    // Ref'd on purpose: it lives only as long as a helper does (at most a
    // second), and the helper is a child that holds the loop anyway.
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ code: null, stdout, error: null, timedOut: true });
    }, timeoutMs);
    track(child, () => finish({ code: null, stdout, error: null, timedOut: true }));
    if (child.stdout) { child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { if (stdout.length < 64) stdout += d; }); }
    if (child.stderr) child.stderr.resume();
    child.on('error', (error) => { leave(); finish({ code: null, stdout, error, timedOut: false }); });
    child.on('exit', (code) => { leave(); finish({ code, stdout, error: null, timedOut: false }); });
  });
}

// Can this session take an injected Esc? → Promise<{interrupt: 'tty'|null, reason}>.
// The checks run cheapest first, and the first that fails names the answer.
async function probeInterrupt({
  platform = process.platform,
  readFile = (f) => require('fs').readFileSync(f, 'utf8'),
  processCommand = require('../core/portfiles').processCommand,
  ppid = () => process.ppid,
  spawn = require('child_process').spawn,
  track,
  untrack,
  timeoutMs = HELPER_TIMEOUT_MS,
} = {}) {
  const no = (reason) => ({ interrupt: null, reason });
  if (platform !== 'darwin' && platform !== 'linux') return no('platform');
  if (platform === 'linux') {
    // Linux 6.2+ can refuse the request outright (dev.tty.legacy_tiocsti=0); a
    // kernel without the setting allows it.
    let v = null;
    try { v = String(readFile('/proc/sys/dev/tty/legacy_tiocsti')).trim(); } catch {}
    if (v === '0') return no('tiocsti-off');
  }
  let cmd = null;
  try { cmd = processCommand(ppid()); } catch {}
  if (!isClaudeCommand(cmd)) return no('not-claude');
  const r = await runHelper('probe', { spawn, track, untrack, timeoutMs });
  if (r.error) return no('no-helper');
  if (r.code === 2) return no('no-tty');
  if (r.code === 3) return no('not-foreground');
  if (r.code !== 0 || String(r.stdout).trim() !== 'fg') return no('no-helper');
  return { interrupt: 'tty', reason: 'ok' };
}

// Is this event an interrupt for THIS session's Claude Code? Anything else is
// someone else's, and ignored without a word.
function addressed(event, ppid) {
  return Boolean(event)
    && event.kind === 'control'
    && event.op === 'interrupt'
    && event.via === 'tty'
    && (typeof event.id === 'string' || typeof event.id === 'number')
    && event.target_pid === ppid;
}

// The guards on an addressed event. Pure. → null (inject) | a refusal name.
// state: { now, startPpid, ppid, lastInjectAt, inFlight }.
function guard(event, state) {
  const { now, startPpid, ppid, lastInjectAt = -Infinity, inFlight = false } = state || {};
  const exp = event && event.expires_at;
  // Expired, or dated further ahead than U81 ever stamps one (a stale request
  // was once served late after a suspend and `fg`).
  if (!Number.isFinite(exp) || now >= exp || exp > now + MAX_AGE_MS + EXPIRY_SLACK_MS) return 'expired';
  if (ppid !== startPpid) return 'not-parent';
  if (now - lastInjectAt < INJECT_GAP_MS) return 'rate';
  if (inFlight) return 'in-flight';
  return null;
}

const defaultLog = (m) => { try { process.stderr.write(`[claude-web-chat] ${m}\n`); } catch {} };

// Probe, publish the answer, and (only when it is 'tty') follow the daemon's
// control events. → { stop() }. Never throws; a failure is logged.
function startInterrupt({
  root,
  presence,
  subscribeSSE,
  spawn = require('child_process').spawn,
  processCommand,
  platform,
  readFile,
  now = Date.now,
  ppid = () => process.ppid,
  log = defaultLog,
} = {}) {
  const sse = subscribeSSE || require('../client').subscribeSSE;
  const startPpid = ppid();
  const helpers = new Map(); // child → cancel its timer
  const track = (c, cancel) => helpers.set(c, cancel);
  const untrack = (c) => helpers.delete(c);

  let stopped = false;
  let probeTimer = null;
  let reconnectTimer = null;
  let handle = null;
  let backoff = BACKOFF_MIN_MS;
  let lastSeq = null;
  let lastInjectAt = -Infinity;
  let inFlight = false;
  const seen = [];

  const say = (m) => { try { log(m); } catch {} };

  // One helper run per accepted event; never a retry. `inFlight` holds from the
  // spawn to the helper's real exit, past a timeout's kill.
  function inject() {
    inFlight = true;
    lastInjectAt = now();
    const done = () => { inFlight = false; };
    runHelper('inject', {
      spawn,
      track,
      untrack: (c) => { untrack(c); done(); },
    }).then((r) => {
      if (r.error) done(); // a spawn that threw never tracked a child
      if (stopped) return;
      if (r.timedOut) say('interrupt refused: helper-timeout');
      else if (r.error) say('interrupt refused: helper-failed');
      else if (r.code === 0) say('interrupt: Esc sent');
      else if (r.code === 2) say('interrupt refused: no-tty');
      else if (r.code === 3) say('interrupt refused: not-foreground');
      else say('interrupt refused: helper-failed');
    });
  }

  function onEvent(e) {
    if (stopped || !e) return;
    if (Number.isFinite(e.seq)) lastSeq = lastSeq == null ? e.seq : Math.max(lastSeq, e.seq);
    if (!addressed(e, ppid())) return;
    const key = `${typeof e.id}:${e.id}`;
    if (seen.includes(key)) return;
    seen.push(key);
    if (seen.length > DEDUPE_IDS) seen.shift();
    const refused = guard(e, { now: now(), startPpid, ppid: ppid(), lastInjectAt, inFlight });
    if (refused) { say(`interrupt refused: ${refused}`); return; }
    inject();
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function connect() {
    if (stopped) return;
    const state = { closed: false };
    let mine = null;
    try {
      mine = sse({
        root,
        kinds: ['control'],
        // The first connect is live-only: an interrupt from before this session
        // started is never anybody's to act on. A reconnect resumes from the
        // last seq seen (the expiry and the id dedupe absorb a replay).
        ...(lastSeq != null ? { since: lastSeq } : {}),
        onOpen: () => { backoff = BACKOFF_MIN_MS; say('interrupt: following control events'); },
        onEvent,
        onError: () => {},
        onClose: () => {
          state.closed = true;
          if (handle && handle === mine) handle = null;
          if (!stopped) scheduleReconnect();
        },
      });
    } catch (e) {
      say(`interrupt: event stream failed: ${(e && e.message) || e}`);
      scheduleReconnect();
      return;
    }
    // subscribeSSE answers a missing daemon by closing before it returns (and
    // a reconnect is already scheduled); only a stream still open is kept.
    if (!state.closed) handle = mine;
  }

  async function run() {
    let answer;
    try {
      answer = await probeInterrupt({ platform, readFile, processCommand, ppid, spawn, track, untrack });
    } catch (e) {
      answer = { interrupt: null, reason: `probe failed: ${(e && e.message) || e}` };
    }
    if (stopped) return;
    try { if (presence && presence.setInterrupt) presence.setInterrupt(answer.interrupt); } catch {}
    say(answer.interrupt ? 'interrupt: tty' : `interrupt: off (${answer.reason})`);
    if (answer.interrupt === 'tty') connect();
  }

  // Deferred: the parent check reads `ps` synchronously, and start-up (the MCP
  // connect) must never wait on it.
  probeTimer = setImmediate(() => { probeTimer = null; run().catch(() => {}); });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (probeTimer) { clearImmediate(probeTimer); probeTimer = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (handle) { const h = handle; handle = null; try { h.close(); } catch {} }
      for (const [c, cancel] of helpers) {
        try { c.kill('SIGKILL'); } catch {}
        try { cancel(); } catch {}
      }
      helpers.clear();
    },
  };
}

module.exports = {
  HELPER_SCRIPT,
  helperArgv,
  probeInterrupt,
  guard,
  addressed,
  isClaudeCommand,
  startInterrupt,
  MAX_AGE_MS,
  INJECT_GAP_MS,
  HELPER_TIMEOUT_MS,
  EXPIRY_SLACK_MS,
  BACKOFF_MIN_MS,
  BACKOFF_MAX_MS,
};
