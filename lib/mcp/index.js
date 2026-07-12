const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { resolve: resolveToggle } = require('../toggle/policy');
const { check: checkUpdates } = require('../update/check');
const { findProjectRoot } = require('../util/root');
const { reconcileManagedFiles } = require('../update/managed-files');

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
  // Fire-and-forget throttled update check. Notice (if any) prints to stderr,
  // which Claude Code surfaces in MCP server logs. Never blocks tool calls.
  checkUpdates({ currentVersion: pkg.version, packageName: pkg.name }).catch(() => {});

  // Once-per-session drift nudge: if managed template files are out of date
  // (a shipped update hasn't been synced, or a conflict is pending), print one
  // stderr line. Local fs only — no network, no throttle needed (one MCP
  // process per session). Never throws into startup.
  try {
    const root = findProjectRoot(process.cwd());
    if (root) {
      const results = reconcileManagedFiles(root, { dryRun: true });
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
    const decision = resolveToggle({ scopes: ['user', 'project'] });
    if (!decision.enabled) {
      const flag = decision.by === 'project' ? '' : ` --${decision.by}`;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            disabled: true,
            scope: decision.by,
            hint: `web-chat is disabled at the ${decision.by} scope. Run \`claude-web-chat on${flag}\` to re-enable.`,
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
  // notification and swallows async rejects (the method is experimental — never
  // let a wire hiccup crash the process). Lazy-required so a normal session
  // doesn't even load the channel modules.
  if (channelEnabled) {
    const { startChannelBridge } = require('../channel/bridge');
    const root = findProjectRoot(process.cwd()) || process.cwd();
    const logChannel = (m) => { try { process.stderr.write(`[claude-web-chat] ${m}\n`); } catch {} };
    const notify = (method, params) => {
      try {
        const p = server.notification({ method, params });
        if (p && typeof p.catch === 'function') p.catch((e) => logChannel(`channel notify failed: ${(e && e.message) || e}`));
      } catch (e) {
        logChannel(`channel notify failed: ${(e && e.message) || e}`);
      }
    };
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
