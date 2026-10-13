// One portfile reader/writer/discovery/probe engine. Depends DOWN on core/paths
// only (+ node http/fs) — imports nothing from lib/client or lib/util/daemon, so
// it is the dependency leaf that breaks the client->daemon->client cycle. The two
// HTTP probes MUST stay here (core may not import lib/client), which is why this
// file is a second allowed home for http.request in the conventions tripwire.
//
// Absorbs lib/util/portfile.js (whole) and the read/write/probe halves of
// lib/util/hub.js, plus the ~9 inline "env -> findProjectRoot -> readPortfile"
// discovery dances and the wait-for-portfile loops. Phase 6 finished the format
// merge: hub.json folded into the shared registry (lib/util/registry, a
// role:'hub' entry), so `server.json` is the only role-based portfile left here.
//
// It is also the one home of the facts about the process a pid names (the
// bottom of this file): is it alive, is it still the process that started at
// a given time, its CPU time and run state (sampleProcs), and its command line
// (processCommand).

const fs = require('fs');
const path = require('path');
const http = require('http');
const childProcess = require('child_process');
const { projectPaths } = require('./paths');
const { LOOPBACK } = require('./cors');

// Is a process with this pid alive? Without options this is the predicate it
// has always been: a number whose signal-0 probe succeeds, true or false.
//
// With `startedAt` it also asks whether it is still the SAME process: a pid
// read out of a file may have been reused since, and a start time cannot be.
// `startedAt` is epoch ms, or a `procStart` string (parseProcStart, below); the
// process must have started within PROC_START_TOLERANCE_MS of it. Its real
// start comes from `sample` when one is passed (a sampleProcs Map, or one
// entry of it; passing the key at all means nothing is spawned, so a caller
// that already sampled never blocks), and is otherwise read now, synchronously
// (`ps` on darwin, bounded by `timeoutMs`; /proc on linux). The answer then has
// a third value, the one a failed sample has:
//   true   alive, and the start matches
//   false  gone, or alive with another start (someone else's process now)
//   null   alive, but its start could not be read (a failed or missing
//          sample, an unparseable startedAt): no verdict, so never read as a
//          different process
function isPidAlive(pid, opts) {
  if (typeof pid !== 'number') return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (!opts || opts.startedAt == null) return true;
  return sameStart(pid, opts);
}

// --- file-level primitives ---

// checkLiveness:true (default) gates on a live pid (today's readPortfile /
// readHubPortfile); false skips the pid gate and tolerates a missing pid (the
// driver's readPortfileRaw). Normalizes url + started_at so all callers see one
// shape.
function readPortfileFile(filePath, { checkLiveness = true } = {}) {
  if (!fs.existsSync(filePath)) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
  if (!data || typeof data.port !== 'number') return null;
  if (checkLiveness && (typeof data.pid !== 'number' || !isPidAlive(data.pid))) return null;
  return {
    pid: data.pid,
    port: data.port,
    url: data.url || `http://localhost:${data.port}`,
    started_at: data.started_at || null,
  };
}

function writePortfileFile(filePath, { pid, port }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const data = { pid, port, url: `http://localhost:${port}`, started_at: Date.now() };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return data;
}

// The portfile is a single shared record — one note on the door — but more than
// one process can reach for it: a daemon shutting down, `ls --reap`, `doctor`
// clearing a stale file. Deleting it unconditionally means a departing process
// can tear down the LIVE daemon's record, leaving a running server that stop,
// status and doctor can no longer see. `pid` says whose record the caller
// believes this is:
//   undefined  unguarded (legacy callers)
//   <number>   mine — delete it, unless a different, still-live process has
//              since claimed the file
//   null       I own nothing — reap only if the process it names is gone
// A missing or unparseable record is always removed; it points at nobody.
// Returns whether the file was unlinked.
function deletePortfileFile(filePath, { pid } = {}) {
  if (pid !== undefined) {
    const rec = readPortfileFile(filePath, { checkLiveness: false });
    if (rec && rec.pid !== pid && isPidAlive(rec.pid)) return false;
  }
  try { fs.unlinkSync(filePath); return true; } catch { return false; }
}

// --- webChatDir-based (backward-compatible with the old lib/util/portfile API) ---

const portfilePathAt = (webChatDir) => path.join(webChatDir, 'server.json');
const readPortfileAt = (webChatDir, opts) => readPortfileFile(portfilePathAt(webChatDir), opts);
const writePortfileAt = (webChatDir, rec) => writePortfileFile(portfilePathAt(webChatDir), rec);
const deletePortfileAt = (webChatDir, opts) => deletePortfileFile(portfilePathAt(webChatDir), opts);

// --- role-based (server -> <root>/.web-chat/server.json) ---
// `server` is the only role-based portfile now; the hub moved into the shared
// registry (lib/util/registry, a role:'hub' entry) in Phase 6. The role param is
// kept for signature stability across the 15+ readPortfile('server') call sites.

function portfilePathFor(role, root) {
  return projectPaths(root != null ? root : process.cwd()).serverJson;
}
const readPortfile = (role, { root, checkLiveness } = {}) => readPortfileFile(portfilePathFor(role, root), { checkLiveness });
const writePortfile = (role, { root, pid, port } = {}) => writePortfileFile(portfilePathFor(role, root), { pid, port });
const deletePortfile = (role, { root, pid } = {}) => deletePortfileFile(portfilePathFor(role, root), { pid });

// Resolve the port to talk to: explicit port -> env (opt-in) -> portfile (no
// liveness gate, matching the driver's discovery). Only the sites that honor
// WEB_CHAT_PORT today should pass env:true.
function discoverPort({ role = 'server', root, port, env = false } = {}) {
  if (port) return typeof port === 'string' ? parseInt(port, 10) : port;
  if (env && process.env.WEB_CHAT_PORT) return parseInt(process.env.WEB_CHAT_PORT, 10);
  const info = readPortfileFile(portfilePathFor(role, root), { checkLiveness: false });
  return info ? info.port : null;
}

// --- probes (the two http.request sites; cannot move to lib/client) ---

function probeOnce(port, pathStr, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: LOOPBACK, port, path: pathStr, method: 'HEAD', timeout: timeoutMs }, (res) => {
      res.resume();
      // 404 => a server answered but predates this route; report "not found here"
      // so the caller can fall back, but any other 2xx-4xx still proves it's alive.
      if (res.statusCode === 404) return resolve('notfound');
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Prefer /api/health; fall back to /api/graph so older daemons still validate.
async function probeReachable(port, timeoutMs = 500) {
  const r = await probeOnce(port, '/api/health', timeoutMs);
  if (r === 'notfound') return (await probeOnce(port, '/api/graph', timeoutMs)) === true;
  return r === true;
}

// Parsed /api/health JSON (or null) — exposes role + version for hub self-heal.
function probeHealth(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: LOOPBACK, port, path: '/api/health', method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function probeHub(port, timeoutMs = 400) {
  return probeHealth(port, timeoutMs).then((h) => !!(h && h.role === 'hub'));
}

// --- wait loops ---

// Poll until the portfile appears AND the bound port answers. The raw
// primitive, for a caller that does not need to know whose daemon answers; the
// wait for THIS root's daemon (verified by /api/health) is lib/util/daemon
// waitForDaemon.
async function waitUntilReachable({ role = 'server', root, maxMs = 8000 } = {}) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const info = readPortfile(role, { root });
    if (info && (await probeReachable(info.port, 250))) return info;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

// Poll until the portfile is gone (a stopped/restarting daemon).
async function waitUntilGone({ role = 'server', root, maxMs = 8000 } = {}) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!readPortfile(role, { root, checkLiveness: false })) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// ── process facts ───────────────────────────────────────────────────────────
// What the chat mirror knows about a Claude Code process between hook fires:
// that it is alive, that it is the process that started when its sessions file
// says (procStart), how much CPU it has used and whether it is stopped
// (Ctrl-Z). One sample per call, for every pid at once.
//
// A FAILED SAMPLE IS NO VERDICT. A loaded machine stalls (0.8–25 s has been
// measured), `ps` can fail to spawn (EAGAIN), time out or be killed, and none
// of that says anything about the processes asked about. So only an answer
// that IS a verdict reports a pid alive:false; anything else is
// {alive: null} for every pid, and a caller never moves a state on null.

// ±2 s: procStart and lstart have one-second resolution, and on linux the boot
// time they are counted from is itself rounded to the second.
const PROC_START_TOLERANCE_MS = 2000;
const SAMPLE_TIMEOUT_MS = 2000;
// macOS pids run 1..99999. `ps -p` refuses a larger one on stderr and exits —
// no verdict for EVERY pid in the call — so one bogus pid out of a file is
// never put on the command line beside the real ones.
const DARWIN_PID_MAX = 99999;
// /proc counts clock ticks in USER_HZ, which is 100 on every architecture Node
// runs on. Node cannot read sysconf(_SC_CLK_TCK), and nothing is spawned on
// linux to ask getconf.
const USER_HZ = 100;
// `ps` prints about 60 bytes a pid; output far past that is not ps answering.
const PS_OUTPUT_MAX = 1024 * 1024;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LSTART_RE = new RegExp(`^(${DAY_NAMES.join('|')}) (${MONTH_NAMES.join('|')}) (\\d{1,2}) (\\d{2}):(\\d{2}):(\\d{2}) (\\d{4})$`);

// A process start time as `ps -o lstart` prints it in the C locale with TZ=UTC
// ("Fri Oct  2 08:50:32 2026"), which is the `procStart` Claude Code writes
// into ~/.claude/sessions/<pid>.json → epoch ms, or null. The text is read as
// UTC. Anything else is null: another locale's day and month names, a date
// that does not exist, a weekday that does not match its date. A null start is
// no verdict, never a different process (isPidAlive above).
function parseProcStart(s) {
  if (typeof s !== 'string') return null;
  const m = LSTART_RE.exec(s.trim().replace(/\s+/g, ' '));
  if (!m) return null;
  const [day, hour, min, sec] = [m[3], m[4], m[5], m[6]].map(Number);
  if (day < 1 || hour > 23 || min > 59 || sec > 59) return null;
  const ms = Date.UTC(Number(m[7]), MONTH_NAMES.indexOf(m[2]), day, hour, min, sec);
  const d = new Date(ms);
  if (d.getUTCDate() !== day || DAY_NAMES[d.getUTCDay()] !== m[1]) return null;
  return ms;
}

// The inverse: epoch ms → the procStart text for that second, in UTC, the day
// of the month padded to two places with a space as ps pads it. For whatever
// has to WRITE a procStart (a test's fake sessions file), so the format lives
// in one place.
function formatProcStart(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${DAY_NAMES[d.getUTCDay()]} ${MONTH_NAMES[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} `
    + `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

// `ps -o time` → ms, or null. macOS prints total minutes ("123:03.91"); procps
// prints [dd-]hh:mm:ss. Both read.
function parseCpuTime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})(?:[.,](\d+))?$/.exec(String(s).trim());
  if (!m) return null;
  const [days, hours, mins, secs] = [m[1], m[2], m[3], m[4]].map((v) => Number(v || 0));
  const frac = m[5] ? Number(`0.${m[5]}`) : 0;
  return Math.round((((days * 24 + hours) * 60 + mins) * 60 + secs + frac) * 1000);
}

const noVerdict = () => ({ alive: null, startedAt: null, cpuMs: null, state: null });
const absent = () => ({ alive: false, startedAt: null, cpuMs: null, state: null });

function isSamplePid(pid, platform) {
  return Number.isSafeInteger(pid) && pid > 0 && (platform !== 'darwin' || pid <= DARWIN_PID_MAX);
}

// ── darwin: one `ps` for every pid ──

const PS_LINE_RE = new RegExp(`^\\s*(\\d+)\\s+((?:${DAY_NAMES.join('|')})\\s+[A-Z][a-z]{2}\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4})\\s+(\\S+)\\s+(\\S+)\\s*$`);

function psArgs(pids) {
  return ['-o', 'pid=,lstart=,time=,stat=', '-p', pids.join(',')];
}

// TZ=UTC makes lstart the procStart text exactly (time zones and DST drop
// out); LC_ALL=C keeps the day and month names, and time's decimal point, the
// ones parseProcStart and parseCpuTime read (ps formats both by the locale).
function psEnv() {
  return { ...process.env, TZ: 'UTC', LC_ALL: 'C' };
}

// One finished `ps` run → Map<pid, entry> when it is a verdict, else null.
// Exactly two outcomes are verdicts: exit 0 with nothing on stderr, listing the
// live pids (one readable line each, every one of them asked about), and exit
// 1 with empty stdout and stderr — none of them exists. A signal, another exit
// code, anything on stderr or a line this cannot read is no verdict for all.
function psVerdict({ code, signal, stdout, stderr }, pids) {
  const out = String(stdout || '');
  if (signal || String(stderr || '').length) return null;
  if (code === 1) return out.length ? null : new Map(pids.map((pid) => [pid, absent()]));
  if (code !== 0) return null;
  const lines = out.split('\n').filter((line) => line.trim());
  if (!lines.length) return null;
  const asked = new Set(pids);
  const listed = new Map();
  for (const line of lines) {
    const m = PS_LINE_RE.exec(line);
    const pid = m ? Number(m[1]) : null;
    if (!m || !asked.has(pid) || listed.has(pid)) return null;
    listed.set(pid, { alive: true, startedAt: parseProcStart(m[2]), cpuMs: parseCpuTime(m[3]), state: m[4] });
  }
  return new Map(pids.map((pid) => [pid, listed.get(pid) || absent()]));
}

// The async run. Settles exactly once, and within `timeoutMs`: a ps still
// running then is killed and whatever it says after is ignored.
function psSample(pids, { spawn, timeoutMs }) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let child = null;
    let stdout = '';
    let stderr = '';
    const settle = (verdict) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(verdict);
    };
    const abandon = () => {
      try { if (child) child.kill('SIGKILL'); } catch {}
      settle(null);
    };
    try {
      child = spawn('ps', psArgs(pids), { env: psEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      timer = setTimeout(abandon, timeoutMs);
      child.on('error', () => settle(null));
      child.on('close', (code, signal) => settle(psVerdict({ code, signal, stdout, stderr }, pids)));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c) => { stdout += c; if (stdout.length > PS_OUTPUT_MAX) abandon(); });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => { stderr += c; });
    } catch {
      abandon();
    }
  });
}

// ── linux: /proc, nothing spawned ──

// "<pid> (<comm>) <state> … utime stime … starttime …" → the fields read, or
// null. comm may hold spaces and parentheses, so the fields after it are
// counted from the LAST ") ".
function parseProcStat(text, pid) {
  const s = String(text);
  const open = s.indexOf(' (');
  const close = s.lastIndexOf(') ');
  if (open < 0 || close < open || Number(s.slice(0, open)) !== pid) return null;
  const f = s.slice(close + 2).trim().split(/\s+/); // f[0] is field 3, so field n is f[n - 3]
  const state = f[0];
  const [utime, stime, starttime] = [f[11], f[12], f[19]].map(Number);
  if (!/^[A-Za-z]$/.test(state || '')) return null;
  if (![utime, stime, starttime].every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
  return { state, utime, stime, starttime };
}

// Map<pid, entry> when every read is a verdict, else null. A missing
// /proc/<pid> (ENOENT) is "not alive"; any other failure to read one, or to
// read the boot time, is no verdict for all.
function procSample(pids, readFile) {
  let btime = null;
  try {
    const m = /^btime\s+(\d+)\s*$/m.exec(String(readFile('/proc/stat', 'utf8')));
    btime = m ? Number(m[1]) : null;
  } catch { return null; }
  if (btime == null) return null;
  const got = new Map();
  for (const pid of pids) {
    let text;
    try {
      text = readFile(`/proc/${pid}/stat`, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') { got.set(pid, absent()); continue; }
      return null;
    }
    const f = parseProcStat(text, pid);
    if (!f) return null;
    got.set(pid, {
      alive: true,
      // Whole seconds, as procps computes lstart: the boot time plus the
      // whole seconds since.
      startedAt: (btime + Math.floor(f.starttime / USER_HZ)) * 1000,
      cpuMs: Math.round(((f.utime + f.stime) * 1000) / USER_HZ),
      state: f.state,
    });
  }
  return got;
}

// Sample every pid at once → Promise<Map<pid, {alive, startedAt, cpuMs, state}>>,
// one entry per distinct pid asked about. `alive` is true (listed: `startedAt`
// in epoch ms, `cpuMs` the user+system CPU time used, `state` the run state as
// the platform spells it: `ps`'s stat on darwin, e.g. "Ss" or "T+", /proc's one
// letter on linux; a T is stopped, a Z a zombie not yet reaped), false (a
// verdict says it is not there) or null (no verdict, every other field null
// too). darwin: ONE async `ps -o pid=,lstart=,time=,stat= -p <pids>`, bounded
// by `timeoutMs`. linux: /proc/<pid>/stat and /proc/stat's btime, nothing
// spawned. Any other platform, and anything that is not a usable pid: null.
// Never rejects. `platform`, `spawn` and `readFile` are test seams.
async function sampleProcs(pids, {
  platform = process.platform,
  spawn = childProcess.spawn,
  readFile = fs.readFileSync,
  timeoutMs = SAMPLE_TIMEOUT_MS,
} = {}) {
  const asked = [...new Set(Array.from(pids || []))];
  const out = new Map(asked.map((pid) => [pid, noVerdict()]));
  const usable = asked.filter((pid) => isSamplePid(pid, platform));
  if (!usable.length) return out;
  let got = null;
  if (platform === 'darwin') got = await psSample(usable, { spawn, timeoutMs });
  else if (platform === 'linux') got = procSample(usable, readFile);
  if (got) for (const [pid, entry] of got) out.set(pid, entry);
  return out;
}

// One pid, now, synchronously: isPidAlive's start check with no sample passed.
function sampleNow(pid, timeoutMs = SAMPLE_TIMEOUT_MS) {
  if (!isSamplePid(pid, process.platform)) return null;
  let got = null;
  if (process.platform === 'linux') {
    got = procSample([pid], fs.readFileSync);
  } else if (process.platform === 'darwin') {
    const r = childProcess.spawnSync('ps', psArgs([pid]), { env: psEnv(), encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!r.error) got = psVerdict({ code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr }, [pid]);
  }
  return got ? got.get(pid) : null;
}

// isPidAlive's start check, once kill 0 has said the pid is alive.
function sameStart(pid, opts) {
  const expected = typeof opts.startedAt === 'string' ? parseProcStart(opts.startedAt) : opts.startedAt;
  if (!Number.isFinite(expected)) return null;
  let entry;
  if ('sample' in opts) entry = opts.sample instanceof Map ? opts.sample.get(pid) : opts.sample;
  else entry = sampleNow(pid, opts.timeoutMs);
  if (!entry || typeof entry.alive !== 'boolean') return null;
  if (!entry.alive) return false;
  if (!Number.isFinite(entry.startedAt)) return null;
  return Math.abs(entry.startedAt - expected) <= PROC_START_TOLERANCE_MS;
}

// The command line of a running process, or null (gone, or `ps` would not
// say). One positive integer pid only: a pid read out of a file is never
// widened into a list (`-p 1,2`) or an option. The tunnel's pid-reuse check
// (lib/tunnel/cloudflared) reads it, and so does the channel-liveness proof
// (the MCP server's parent's argv).
function processCommand(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const r = childProcess.spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || '').trim() || null;
}

module.exports = {
  isPidAlive,
  readPortfileFile, writePortfileFile, deletePortfileFile,
  portfilePathAt, readPortfileAt, writePortfileAt, deletePortfileAt,
  portfilePathFor, readPortfile, writePortfile, deletePortfile,
  discoverPort,
  probeReachable, probeHealth, probeHub,
  waitUntilReachable, waitUntilGone,
  sampleProcs, parseProcStart, formatProcStart, processCommand,
  PROC_START_TOLERANCE_MS, SAMPLE_TIMEOUT_MS,
};
