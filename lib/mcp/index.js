const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { resolve: resolveToggle } = require('../toggle/policy');
const { check: checkUpdates } = require('../update/check');
const { resolveRoot, isInstalled, inspect, driftLine } = require('../setup/registration');
const { MCP_SERVER_ENV } = require('../core/mcp-seen');
const { startPresence } = require('./presence');
const { unknownRouteError, createBuildNotice } = require('./skew');
const { channelProof, INITIALIZE_PROOF } = require('./channel-proof');
const { processCommand } = require('../core/portfiles');
const { LAUNCH_COMMAND } = require('../core/channels');

const tools = [
  require('./tools/render'),
  require('./tools/clear'),
  require('./tools/list_mounts'),
  require('./tools/save_component'),
  require('./tools/list_components'),
  require('./tools/get_component'),
  require('./tools/use_component'),
  require('./tools/get_store'),
  require('./tools/set_store'),
  require('./tools/get_events'),
  require('./tools/get_graph'),
  require('./tools/get_active'),
  require('./tools/diff_nodes'),
  require('./tools/get_comments'),
  require('./tools/reply_comment'),
  require('./tools/get_captures'),
  require('./tools/inspect_capture'),
  require('./tools/set_theme'),
  require('./tools/get_theme'),
  require('./tools/save_theme'),
  require('./tools/list_themes'),
  require('./tools/apply_theme'),
  require('./tools/export'),
  require('./tools/write_markdown'),
];

const pkg = require('../../package.json');

async function main() {
  // Mark this process as the MCP server Claude Code spawned at session start.
  // lib/mcp/client reads the flag and stamps every daemon request with this
  // process's start time; the daemon records it so `doctor`/`status` can prove
  // whether Claude Code has been restarted since `install` rewrote .mcp.json
  // (it reads that file only at startup). See lib/core/mcp-seen.js.
  process.env[MCP_SERVER_ENV] = '1';

  // Say "a Claude Code session is attached to this project" in the machine
  // registry for exactly as long as this process lives — before anything else,
  // and without a daemon (see lib/mcp/presence.js). The row goes when stdin
  // closes (Claude Code hung up), on SIGTERM/SIGINT, or at exit. Signals need an
  // explicit exit: a listener replaces Node's default terminate-on-signal, and a
  // signal-killed process never runs 'exit' handlers, so without one the row
  // would outlive every session Claude Code ends with a SIGTERM. The listeners
  // are armed BEFORE the row is written: a signal landing between the two would
  // otherwise take the default action and orphan the row. (A listener runs on
  // the event loop, after this block, so `presence` is set by then.)
  const leave = () => presence.stop();
  process.once('SIGTERM', () => { leave(); process.exit(143); });
  process.once('SIGINT', () => { leave(); process.exit(130); });
  const presence = startPresence({ root: resolveRoot(process.cwd(), { mode: 'install' }).root });
  process.on('exit', leave);
  process.stdin.on('end', leave);
  process.stdin.on('close', leave);

  // Fire-and-forget throttled update check. Notice (if any) prints to stderr,
  // which Claude Code surfaces in MCP server logs. Never blocks tool calls.
  checkUpdates({ currentVersion: pkg.version, packageName: pkg.name }).catch(() => {});

  // An update installed since this session started: this process keeps the
  // tools it loaded until Claude Code is reopened. Said to Claude once, on the
  // next tool result, not on stderr, which Claude never reads (lib/mcp/skew).
  const buildNotice = createBuildNotice({ running: pkg.version });

  // Once-per-session drift nudge: if managed template files are out of date
  // (a shipped update hasn't been synced, or a conflict is waiting to be
  // announced), or this project's Claude Code hooks are missing, unrunnable or
  // older than the template (an update reaches the hook CODE at once, through
  // ~/.web-chat/current, but the registration only when `install` runs here),
  // print one stderr line naming them. Local fs only — no network, no throttle
  // needed (one MCP process per session). Never throws into startup.
  //
  // The line is registration's driftLine, from the same inspect() read doctor
  // and status report on. A `pending` managed row — an unmerged `.new` the user
  // has already been told about — deliberately does NOT nudge: the line says
  // "run `claude-web-chat install`", and install cannot merge anything for you.
  // `status` and `init`, which the user asks for, still report it.
  try {
    const root = resolveRoot(process.cwd(), { mode: 'optional' }).root;
    if (root) {
      const line = driftLine(inspect(root));
      if (line) process.stderr.write(`[claude-web-chat] ${line}\n`);
    }
  } catch {}

  // Channels (research preview) are opt-in via WEB_CHAT_CHANNEL=1 so a normal
  // session is byte-identical (no experimental capability, no bridge started).
  // When on, we declare the experimental channel capability, which grants this
  // MCP server the right to PUSH notifications/claude/channel (the inbound edge
  // MCP never gave us). See docs/channels-dev.md. The env is enough to DECLARE
  // (it has to be, before connect), never to start the bridge: that waits on
  // the channel-liveness proof after connect (./channel-proof, spec §6.7).
  const channelEnabled = process.env.WEB_CHAT_CHANNEL === '1';
  const capabilities = { tools: {} };
  if (channelEnabled) capabilities.experimental = { 'claude/channel': {} };

  const server = new Server(
    { name: pkg.name, version: pkg.version },
    { capabilities },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    presence.touch();

    // Session scope can't be enforced here (Claude Code doesn't pass session_id
    // to MCP subprocesses), so MCP only checks user + project.
    const cwd = process.cwd();
    const decision = resolveToggle({ cwd, scopes: ['user', 'project'] });
    if (!decision.enabled) {
      // The project scope deliberately conflates "no .web-chat/" with
      // "disabled" — correct for the hooks, which exit silently. Turned into a
      // user-facing instruction it was wrong: every tool told the user to run
      // `claude-web-chat on`, which answers "web-chat is not disabled for this
      // project" and changes nothing. Ask the registration engine which of the
      // two this is, and name the command that would actually help.
      const root = resolveRoot(cwd, { mode: 'install' }).root;
      // isInstalled, not inspect(): this runs on every tool call in a disabled
      // project, and the question is one existsSync.
      const notInstalled = decision.by === 'project' && !isInstalled(root);
      const flag = decision.by === 'project' ? '' : ` --${decision.by}`;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            disabled: true,
            scope: decision.by,
            reason: notInstalled ? 'not-installed' : 'marker',
            hint: notInstalled
              ? `web-chat is not installed in this project (no .web-chat/ in ${root}) — run \`claude-web-chat init\`.`
              : `web-chat is disabled at the ${decision.by} scope. Run \`claude-web-chat on${flag}\` to re-enable.`,
          }, null, 2),
        }],
        isError: true,
      };
    }

    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    // The newer-build notice leads the result as its own text item, so the
    // tool's payload stays the item after it, byte-identical.
    const notice = buildNotice.take();
    const withNotice = (res) => (notice ? { ...res, content: [{ type: 'text', text: notice }, ...res.content] } : res);
    try {
      const result = await tool.handler(args || {});
      return withNotice({
        content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      // A 404 on a route the daemon has never heard of means it runs an older
      // build than these tools; say that and name the fix, not the HTML page.
      return withNotice({
        content: [{ type: 'text', text: unknownRouteError(e) || `Error: ${e.message}` }],
        isError: true,
      });
    }
  });

  // Start the channel bridge AFTER connect (so server.notification can send).
  // The bridge is the only long-lived logic in the MCP process: it taps the
  // daemon's `wake` feed over SSE and fires one notifications/claude/channel per
  // wake. `notify` adapts the two-arg bridge call to the SDK's single-object
  // notification. Lazy-required so a normal session doesn't even load the
  // channel modules.
  //
  // ...and only in a session that loaded the channel (spec §6.7). An inherited
  // WEB_CHAT_CHANNEL=1 in a session started without the flag would otherwise
  // run a bridge that drains the park on connect and acks writes nobody reads
  // (V11). The proof reads the parent's command line ONCE (a `ps` bounded at
  // 3 s); without a proof the bridge stays off, the presence row's channel
  // stays false, one stderr line says why, and a Push parks for the next
  // message.
  const startBridge = () => {
    const { startChannelBridge } = require('../channel/bridge');
    const root = resolveRoot(process.cwd(), { mode: 'install' }).root;
    const logChannel = (m) => { try { process.stderr.write(`[claude-web-chat] ${m}\n`); } catch {} };
    // Returns the SDK's promise UNSWALLOWED: Protocol.notification is async, so a
    // closed transport or a failed write rejects rather than throwing, and the
    // bridge needs that outcome — it is what decides whether the wake gets acked
    // (an ack clears the daemon's retained batch). The bridge logs and contains
    // the rejection, so a wire hiccup still cannot crash this process.
    const notify = (method, params) => server.notification({ method, params });
    const bridge = startChannelBridge({ notify, root, log: logChannel, onConnection: (up) => presence.setChannel(up) });
    const stopBridge = () => { try { bridge.stop(); } catch {} };
    process.on('SIGTERM', stopBridge);
    process.on('SIGINT', stopBridge);
    process.on('exit', stopBridge);
  };
  let decided = false;
  const decideChannel = () => {
    if (decided) return;
    decided = true;
    let proof;
    try {
      proof = channelProof({
        clientCapabilities: server.getClientCapabilities(),
        parentCommand: processCommand(process.ppid),
        env: process.env,
      });
    } catch (e) {
      proof = { start: false, by: null, why: `the proof failed: ${e && e.message}` };
    }
    if (proof.start) { startBridge(); return; }
    try {
      process.stderr.write(`[claude-web-chat] channel: WEB_CHAT_CHANNEL is set, but this Claude Code session did not load the web-chat channel, so the bridge is off and a Push parks for your next message. Start Claude Code with: ${LAUNCH_COMMAND} (or set WEB_CHAT_CHANNEL_FORCE=1).\n`);
    } catch {}
  };
  // Rule (a) reads the client's initialize capabilities, which exist only once
  // the client has initialized; while V26 has not switched it on, nothing waits
  // for them and the proof runs right after connect.
  if (channelEnabled && INITIALIZE_PROOF) server.oninitialized = decideChannel;

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (channelEnabled && !INITIALIZE_PROOF) decideChannel();

  // ── end of start-up ─────────────────────────────────────────────────────
  // The connected server's last step. Anything that must run after connect and
  // after the channel decision (U82's interrupt injector, if it needs either)
  // goes here; what needs neither starts beside startPresence above.
}

main().catch((e) => {
  console.error(`[claude-web-chat-mcp] fatal: ${e.message}`);
  process.exit(1);
});
