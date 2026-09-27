'use strict';
// The chrome's static files must never answer "304 Not Modified" to a browser
// holding a copy from another build. Release tarballs pin every file's mtime
// (reproducible builds), so express.static's default validators — a fixed
// Last-Modified and a weak size+mtime ETag — matched across versions and a
// phone kept running the previous build's chrome after `update`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { withServer } = require('../test-support/helpers');

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
  });
}

test('static: no Last-Modified, and a pinned-mtime If-Modified-Since never earns a 304', async (t) => {
  const { port } = await withServer(t);
  const first = await get(port, '/app/topbar.js');
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['last-modified'], undefined);
  assert.equal(first.headers['cache-control'], 'no-cache');
  const again = await get(port, '/app/topbar.js', { 'if-modified-since': 'Sat, 01 Jan 2000 00:00:00 GMT' });
  assert.equal(again.statusCode, 200, 'a date alone must not validate a cached copy');
});

test('static: the ETag names the build, so another build\'s copy does not validate', async (t) => {
  const { port } = await withServer(t);
  const res = await get(port, '/app/topbar.js');
  const etag = res.headers.etag;
  const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  assert.ok(etag && etag.includes(version), `ETag ${etag} carries the build ${version}`);
  assert.equal((await get(port, '/app/topbar.js', { 'if-none-match': etag })).statusCode, 304, 'same build still revalidates cheaply');
  const other = etag.replace(version, '0.0.0-other');
  assert.equal((await get(port, '/app/topbar.js', { 'if-none-match': other })).statusCode, 200);
});
