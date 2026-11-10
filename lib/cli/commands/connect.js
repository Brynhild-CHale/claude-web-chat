// `claude-web-chat connect …` — the CLI face of the connector (contract 06
// C-06.1). Thin: every subcommand is a row of lib/connector/cli.js's table,
// and the exit code is the dispatcher's. lib/connector is required here and
// nowhere else in lib/cli, and only when the command runs, so the rest of the
// CLI never loads it.
//
// The rows get lib/cli/prompt's engine as `deps.prompt` (lib/connector may not
// require lib/cli): `connect open|shell|code` with no <chat> read a number
// through it, and it asks nothing without a terminal. It opens no readline
// until a row asks, and is closed here.

const { createPrompt } = require('../prompt');

module.exports = async (args, deps = {}) => {
  const prompt = deps.prompt || createPrompt();
  try {
    process.exitCode = await require('../../connector').main(args, { prompt, ...deps });
  } finally {
    if (!deps.prompt) prompt.close();
  }
};
