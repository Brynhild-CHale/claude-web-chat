// The connector (contract 06): the long-lived process `claude-web-chat connect
// run` that pairs this machine with one hub, keeps an outbound link to it and
// relays the hub's requests to the daemons it supervises. An ENTRY point
// (test/dependency-direction.test.js): its CLI face is
// lib/cli/commands/connect.js, and it reaches a daemon only through lib/client
// and lib/util/registry. Its record, unit texts and service-manager argv live
// in lib/setup/connector.js (shared with update, uninstall and status).
//
// What it exports is the dispatcher: main(args, deps) → exit code, over the
// subcommand table in ./cli.js, where every `connect` subcommand is one row.

const { main } = require('./cli');

module.exports = { main };
