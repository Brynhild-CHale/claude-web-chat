// The OS opener: which program hands a URL (or a file) to the desktop's
// default handler on each platform. ONE mapping, read by two callers that may
// not require each other (an entry point never reaches into another's
// internals): `claude-web-chat open`'s browser launch (lib/cli/commands/open.js)
// and the connector's `connect code` (lib/connector/exec.js, contract 06
// C-06.26a: "the OS opener (`open` on macOS, `xdg-open` on Linux)").
//
//   openerCommand(platform) → { cmd, args }
//     `cmd` is a bare program name (resolved on a PATH by the caller) and
//     `args` the arguments that go before the URL. A fresh object each call.
//
// Windows is `cmd /c start ""` for `open` alone; the connector supports macOS
// and Linux only (Windows means WSL2) and refuses any other platform itself.

function openerCommand(platform = process.platform) {
  if (platform === 'darwin') return { cmd: 'open', args: [] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', ''] };
  return { cmd: 'xdg-open', args: [] };
}

module.exports = { openerCommand };
