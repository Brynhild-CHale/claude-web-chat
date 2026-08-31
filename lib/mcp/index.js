const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { resolve: resolveToggle } = require('../toggle/policy');
const { check: checkUpdates } = require('../update/check');
const { resolveRoot, isInstalled, inspect } = require('../setup/registration');
const { MCP_SERVER_ENV } = require('../core/mcp-seen');

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
];

const pkg = require('../../package.json');

async function main() {
  // Mark this process as the MCP server Claude Code spawned at session start.
  // lib/mcp/client reads the flag and stamps every daemon request with this
  // process's start time; the daemon records it so `doctor`/`status` can prove
  // whether Claude Code has been restarted since `install` rewrote .mcp.json
  // (it reads that file only at startup). See lib/core/mcp-seen.js.
  process.env[MCP_SERVER_ENV] = '1';

  // Fire-and-forget throttled update check. Notice (if any) prints to stderr,
  // which Claude Code surfaces in MCP server logs. Never blocks tool calls.
  checkUpdates({ currentVersion: pkg.version, packageName: pkg.name }).catch(() => {});

  // Once-per-session drift nudge: if managed template files are out of date
  // (a shipped update hasn't been synced, or a conflict is waiting to be
  // announced), print one stderr line. Local fs only — no network, no throttle
  // needed (one MCP process per session). Never throws into startup.
  //
  // A `pending` row — an unmerged `.new` beside a file the user has already been
  // told about — deliberately does NOT nudge. The line it would print says "run
  // `claude-web-chat install`", and install cannot merge anything for you: the
  // resolution is by hand, so nudging once per session would be an unactionable
  // reminder repeated for as long as the user takes to get to it. `status` and
  // `init`, which the user asks for, still report it.
  try {
    const root = resolveRoot(process.cwd(), { mode: 'optional' }).root;
    if (root) {
      const results = inspect(root).managed;
      const drift = results.some(r => r.action === 'updated' || r.action === 'conflict' || r.action === 'differs');
      if (drift) {
        process.stderr.write('[claude-web-chat] managed files out of date — run `claude-web-chat install`\n');
      }
    }
  } catch {}

  // Channels (research preview) are opt-in via WEB_CHAT_CHANNEL=1 so a normal
  // session is byte-identical (no experimental capability, no bridge started).
  // When on, we declare the experimental channel capability, which grants this
  // MCP server the right to PUSH notifications/claude/channel (the inbound edge
  // MCP never gave us). See docs/channels-dev.md.
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
    try {
      const result = await tool.handler(args || {});
      return {
        content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start the channel bridge AFTER connect (so server.notification can send).
  // The bridge is the only long-lived logic in the MCP process: it taps the
  // daemon's `wake` feed over SSE and fires one notifications/claude/channel per
  // wake. `notify` adapts the two-arg bridge call to the SDK's single-object
  // notification. Lazy-required so a normal session doesn't even load the
  // channel modules.
  if (channelEnabled) {
    const { startChannelBridge } = require('../channel/bridge');
    const root = resolveRoot(process.cwd(), { mode: 'install' }).root;
    const logChannel = (m) => { try { process.stderr.write(`[claude-web-chat] ${m}\n`); } catch {} };
    // Returns the SDK's promise UNSWALLOWED: Protocol.notification is async, so a
    // closed transport or a failed write rejects rather than throwing, and the
    // bridge needs that outcome — it is what decides whether the wake gets acked
    // (an ack clears the daemon's retained batch). The bridge logs and contains
    // the rejection, so a wire hiccup still cannot crash this process.
    const notify = (method, params) => server.notification({ method, params });
    const bridge = startChannelBridge({ notify, root, log: logChannel });
    const stopBridge = () => { try { bridge.stop(); } catch {} };
    process.on('SIGTERM', stopBridge);
    process.on('SIGINT', stopBridge);
    process.on('exit', stopBridge);
  }
}

main().catch((e) => {
  console.error(`[claude-web-chat-mcp] fatal: ${e.message}`);
  process.exit(1);
});
