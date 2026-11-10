// The start rate limit: how often one project's daemon may be started on a
// remote viewer's behalf, and how long a start waits for it to answer. The
// portal's picker start (lib/portal/start.js, which re-exports both) and 06's
// connector supervisor (C-06.19, C-05.26) keep the same numbers. They live here
// because the connector cannot require lib/portal (entry → entry).

// One start per id per START_EVERY_MS, counted from the attempt.
const START_EVERY_MS = 10_000;
// How long a start waits for the daemon to answer before it is reported down.
const START_WAIT_MS = 15_000;

module.exports = { START_EVERY_MS, START_WAIT_MS };
