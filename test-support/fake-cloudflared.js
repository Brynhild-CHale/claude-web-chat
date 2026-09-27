#!/usr/bin/env node
// A stand-in for the `cloudflared` binary, for test/tunnel-cli.test.js and
// test/tunnel-supervisor.test.js — the fake-gh.js pattern: a real file, put on
// PATH behind a shim named exactly `cloudflared`, so the real spawn happens.
//
//   --version            prints `cloudflared version $FAKE_CF_VERSION (…)`.
//   anything else        appends {argv, token, pid, config} to $FAKE_CF_CALLS —
//                        `token` is the TUNNEL_TOKEN it was handed (null if
//                        none), `config` the text of any --config file — then:
//                          FAKE_CF_EXIT=<n>  exits <n> at once (a crash loop);
//                          otherwise serves `--metrics host:port` with /ready
//                          → 200 {readyConnections: 4} until SIGTERM, which
//                          it obeys after $FAKE_CF_LINGER_MS (a slow shutdown,
//                          serving meanwhile) — or never, with
//                          FAKE_CF_IGNORE_TERM=1 (only SIGKILL ends it).
//
// It never touches the network beyond that loopback metrics port.

const fs = require('fs');
const http = require('http');

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  process.stdout.write(`cloudflared version ${process.env.FAKE_CF_VERSION || '2025.8.1'} (built 2025-08-01-0000 UTC)\n`);
  process.exit(0);
}

const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

let config = null;
const configFile = flag('--config');
if (configFile) { try { config = fs.readFileSync(configFile, 'utf8'); } catch {} }

if (process.env.FAKE_CF_CALLS) {
  fs.appendFileSync(process.env.FAKE_CF_CALLS, JSON.stringify({
    argv, token: process.env.TUNNEL_TOKEN == null ? null : process.env.TUNNEL_TOKEN, pid: process.pid, config,
  }) + '\n');
}

if (process.env.FAKE_CF_EXIT) process.exit(Number(process.env.FAKE_CF_EXIT));

const metrics = flag('--metrics');
const server = http.createServer((req, res) => {
  if (req.url === '/ready') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 200, readyConnections: 4, connectorId: 'fake' }));
    return;
  }
  res.writeHead(404);
  res.end();
});
// The supervisor always asks for 127.0.0.1:<port>; bind exactly that (never
// the wildcard) and say so if it ever asks for anything else.
if (metrics) {
  const i = metrics.lastIndexOf(':');
  if (metrics.slice(0, i) !== '127.0.0.1') {
    process.stderr.write(`fake cloudflared: refusing --metrics ${metrics} (not loopback)\n`);
    process.exit(2);
  }
  server.listen(Number(metrics.slice(i + 1)), '127.0.0.1');
}
const bye = () => { server.close(); process.exit(0); };
const linger = Number(process.env.FAKE_CF_LINGER_MS) || 0;
process.on('SIGTERM', () => {
  if (process.env.FAKE_CF_IGNORE_TERM) return;
  if (linger > 0) setTimeout(bye, linger); else bye();
});
process.on('SIGINT', bye);
// Stay alive even with no metrics server.
setInterval(() => {}, 1 << 30);
