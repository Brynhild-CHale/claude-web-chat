// Claude's writer token — the credential that tells the daemon a write is
// Claude's (PLAN 1B.4, DECISIONS A1: identity first). The one home of the
// writer-identity header names, the token file's read and write, and the
// timing-safe compare every token check in the daemon uses
// (test/conventions.test.js ratchets the header names to this file).
//
// Why a token and not "is it a browser": Node's own global `fetch` sends fetch
// metadata (`sec-fetch-mode: cors`), so lib/core/cors isBrowserRequest is true
// for any WHATWG-fetch client — the test harness's makeApi among them. Nothing
// a request's headers say about itself tells Claude's MCP server from a pane
// script's same-origin fetch; a secret only the MCP server can read does.
//
// The life of a token:
//   * the daemon mints one per boot (lib/server/domain/writers createWriters),
//     writes it to .web-chat/writer-token with mode 0600 and teaches the
//     redactor its value, so it is masked in every text the daemon keeps or
//     answers. No route serves the file and no accessor hands it to a route.
//   * the MCP server (and only it — lib/mcp/client, WEB_CHAT_MCP_SERVER=1)
//     reads the file and sends the value as WRITER_HEADER on every call.
//   * a value that matches nothing (an earlier boot's) is `stale`: the route
//     answers 401 and the client re-reads the file once.
//
// lib/core: requires nothing outside lib/core.

const crypto = require('crypto');
const fs = require('fs');
const { projectPaths } = require('./paths');
const { writeFileAtomic } = require('./fsjson');

// The header Claude's MCP server sends its token in.
const WRITER_HEADER = 'X-WC-Writer';
// Reserved for pane attribution (U214c): the realm stamps a pane script's
// same-origin fetch with its mount id. Declared here so the name has one home.
const PANE_HEADER = 'X-WC-Pane';

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[0-9a-f]{64}$/;

// A fresh token: 32 random bytes as 64 lowercase hex characters.
function mintToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

// Write `token` to the project's writer-token file, mode 0600, atomically
// (lib/core/fsjson writeFileAtomic: an exclusive temp create, then a rename).
// `mkdir: false` — a daemon never creates its project directory, so a missing
// .web-chat/ is the caller's ENOENT to handle. Throws on failure; returns the
// path.
function writeWriterToken(root, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new TypeError('writeWriterToken: not a writer token');
  return writeFileAtomic(projectPaths(root).writerToken, `${token}\n`, { mkdir: false, mode: 0o600 });
}

// The project's current writer token, or null (no file, an unreadable one, or
// content that is not a token). Never throws.
function readWriterToken(root) {
  try {
    const raw = fs.readFileSync(projectPaths(root).writerToken, 'utf8').trim();
    return TOKEN_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

// Timing-safe equality over two strings (compared as utf8 bytes) or two
// Buffers. A length difference answers false at once — the length of a token
// is no secret. Anything else answers false. Never throws.
function safeEqual(a, b) {
  const ba = typeof a === 'string' ? Buffer.from(a, 'utf8') : a;
  const bb = typeof b === 'string' ? Buffer.from(b, 'utf8') : b;
  if (!Buffer.isBuffer(ba) || !Buffer.isBuffer(bb)) return false;
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  WRITER_HEADER,
  PANE_HEADER,
  TOKEN_RE,
  mintToken,
  writeWriterToken,
  readWriterToken,
  safeEqual,
};
