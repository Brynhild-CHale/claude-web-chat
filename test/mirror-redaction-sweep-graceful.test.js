// The chat mirror's redaction sweep, torn down by gracefulShutdown(). The
// scenario, the carriers and every clause are test-support/redaction-sweep.js's;
// the other teardown, srv.stop(), is test/mirror-redaction-sweep.test.js.
require('../test-support/redaction-sweep').sweep('graceful');
