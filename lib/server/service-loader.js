// Loads a component's service.js for the forked runner (lib/server/
// service-runner.js) from ONE read, and only when that read is the code the
// user approved.
//
// The supervisor keys an approval on the sha256 of the bytes IT read
// (serviceInfo, at reconcile); the child starts tens of milliseconds later. A
// `require(servicePath)` in the child read the file a second time, so bytes
// written in between — POST /api/components rewrites a non-builtin's
// service.js for any caller — ran under the approved key. So: read once, hash
// that buffer, refuse on a mismatch, and compile exactly the bytes that were
// hashed.
//
// They are compiled the way require() compiles a `.js` file: Module#_compile,
// the CommonJS loader's own step, on a Module made for the file. That is what
// keeps a service.js behaving as it did under require():
//   * CommonJS — module.exports, exports, __dirname, a `#!` line, and a
//     `require('./helper')` that resolves next to the file;
//   * `import()` — through the loader's own dynamic-import callback (a bare
//     vm.compileFunction has none, and every `import()` threw);
//   * an ES module (`export async function start`) — detected from its syntax
//     and linked from THESE bytes, never re-read from disk, with its static
//     imports resolved next to the file. As under require(), it cannot use
//     top-level await.
// One difference from require(), deliberately: the format comes from the
// syntax alone, not from the nearest package.json. Under require(), a project
// whose package.json says "type": "module" made every CommonJS service.js in
// its .web-chat/components/ — the builtins included — an ES module, and it
// failed to start ("module is not defined in ES module scope").
//
// The modules service.js requires or imports load from disk as usual: the
// approval covers service.js, not its imports (the docs say so).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { realpath } = require('../core/paths');

// `readFile` is a test seam: it lets a test land a write on the file between
// this read and the compile, which is the race this module exists to close.
function loadApproved(file, approved, { readFile = fs.readFileSync } = {}) {
  if (!approved) throw new Error('no approved sha256 came with the start message — not running service.js');
  const bytes = readFile(file);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== approved) {
    throw new Error(`service.js is not the code that was approved (sha256 ${actual.slice(0, 16)}…, approved ${String(approved).slice(0, 16)}…) — not running it`);
  }
  return compile(file, Buffer.from(bytes).toString('utf8'));
}

function compile(file, text) {
  // A BOM is dropped, so a `#!` line after one still reads as the comment V8
  // takes it for at the start of a file. Nothing else is touched.
  const source = text.replace(/^\uFEFF/, '');
  // The module is named by its REAL path, as require() names one: that is what
  // __filename, __dirname and import.meta.url say, what a relative require or
  // import resolves from, and where the node_modules walk starts — so a
  // component directory reached through a symlink resolves its dependencies
  // from where it really lives, as it did under require(). (Only the name: the
  // bytes are the ones read and hashed above.)
  const filename = realpath(file) || path.resolve(file);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  // Cached under that path, as require() would cache it, so a later require()
  // of it (a helper that requires its parent) is handed this module — never a
  // fresh read of the file.
  require.cache[filename] = mod;
  try {
    // No format argument: the loader detects it from the source, CommonJS
    // unless the syntax is an ES module's.
    mod._compile(source, filename);
  } catch (e) {
    delete require.cache[filename];
    throw e;
  }
  mod.loaded = true;
  return mod.exports;
}

module.exports = { loadApproved };
