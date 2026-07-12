const fs = require('fs');
const path = require('path');

function uninstall() {
  const root = process.cwd();
  const claudeDir = path.join(root, '.claude');

  // 1. Strip hook entries
  const settingsPath = path.join(claudeDir, 'settings.json');
  let removedHooks = 0;
  if (fs.existsSync(settingsPath)) {
    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      console.error(`error parsing ${settingsPath}: ${e.message}`);
      process.exit(1);
    }
    if (settings.hooks) {
      for (const event of Object.keys(settings.hooks)) {
        const before = settings.hooks[event].length;
        settings.hooks[event] = settings.hooks[event].filter(h => {
          const isOurs = h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('claude-web-chat-hook'));
          return !isOurs;
        });
        removedHooks += before - settings.hooks[event].length;
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
  }

  // 2. Remove rules + slash command files
  function rm(p) {
    if (fs.existsSync(p)) { fs.unlinkSync(p); return 'removed'; }
    return 'not present';
  }
  const rulesStatus = rm(path.join(claudeDir, 'rules', 'web-chat.md'));
  const cmdStatus = rm(path.join(claudeDir, 'commands', 'web-chat.md'));

  // 3. Strip web-chat entry from .mcp.json
  const mcpPath = path.join(root, '.mcp.json');
  let mcpStatus = 'not present';
  if (fs.existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      if (mcp.mcpServers && mcp.mcpServers['web-chat']) {
        delete mcp.mcpServers['web-chat'];
        if (Object.keys(mcp.mcpServers).length === 0) delete mcp.mcpServers;
        if (Object.keys(mcp).length === 0) {
          fs.unlinkSync(mcpPath);
          mcpStatus = 'removed (file empty)';
        } else {
          fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
          mcpStatus = 'web-chat entry removed';
        }
      } else {
        mcpStatus = 'no web-chat entry';
      }
    } catch (e) {
      mcpStatus = `error parsing (${e.message})`;
    }
  }

  console.log(`web-chat uninstalled from ${root}`);
  console.log(`  .claude/settings.json               ${removedHooks} hook entrie${removedHooks === 1 ? '' : 's'} removed`);
  console.log(`  .claude/rules/web-chat.md           ${rulesStatus}`);
  console.log(`  .claude/commands/web-chat.md        ${cmdStatus}`);
  console.log(`  .mcp.json                           ${mcpStatus}`);
  console.log(`  .web-chat/                          preserved (delete manually if no longer needed)`);
}

module.exports = uninstall;
