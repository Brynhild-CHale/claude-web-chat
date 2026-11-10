// `claude-web-chat connect …` — the CLI face of the connector (contract 06
// C-06.1). Thin: every subcommand is a row of lib/connector/cli.js's table,
// and the exit code is the dispatcher's. lib/connector is required here and
// nowhere else in lib/cli, and only when the command runs, so the rest of the
// CLI never loads it.

module.exports = async (args, deps) => {
  process.exitCode = await require('../../connector').main(args, deps);
};
