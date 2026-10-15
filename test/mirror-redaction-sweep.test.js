// The chat mirror's redaction sweep, torn down by srv.stop(). The scenario, the
// carriers and every clause are test-support/redaction-sweep.js's; the other
// teardown, gracefulShutdown(), is test/mirror-redaction-sweep-graceful.test.js.
require('../test-support/redaction-sweep').sweep('stop');
