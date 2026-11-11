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
//
// The rows also get `deps.ask`: U731's askConnector bound to the one hub's
// local socket — the CLI end of connector.leave and connector.release-all,
// which U727's disconnect row asks the running connector through
// (lib/setup/connector viaConnectorSocket; U727-U731@via-connector-socket-op
// (a), U790). No connector answering rejects ENOCONNECTOR, and the
// disconnect takes its direct path.

const { createPrompt } = require('../prompt');

function askConnector(request) {
  const setup = require('../../setup/connector');
  const { userPaths } = require('../../core/paths');
  const sole = setup.soleHub();
  if (!sole.ok) return Promise.reject(Object.assign(new Error('no connector record'), { code: 'ENOCONNECTOR' }));
  return require('../../connector/local-socket').askConnector({ path: userPaths().connectorSocket(sole.hubId), request });
}

module.exports = async (args, deps = {}) => {
  const prompt = deps.prompt || createPrompt();
  try {
    process.exitCode = await require('../../connector').main(args, { prompt, ask: askConnector, ...deps });
  } finally {
    if (!deps.prompt) prompt.close();
  }
};
