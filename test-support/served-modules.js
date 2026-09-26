// Module hooks for the chrome tests (registered by test-support/sandbox.js).
//
// A few of the chrome's ES modules are not files: the daemon SERVES them, built
// from host source so there is no second copy to drift — /app/markdown.js is
// lib/core/markdown's browserModuleSource(). A real browser fetches them from the
// daemon; the jsdom tests import public/app/*.js straight off the disk, where
// `import … from './markdown.js'` would find nothing. These hooks answer that
// one path with the same source the route serves, and leave everything else to
// the default resolver. Synchronous, so they serve module.registerHooks (Node
// 22.15+) and, as a fallback, module.register alike.
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');
const SERVED = new Map([
  [pathToFileURL(path.join(REPO, 'public/app/markdown.js')).href,
    () => require(path.join(REPO, 'lib/core/markdown.js')).browserModuleSource()],
]);

exports.resolve = function resolve(specifier, context, next) {
  if (context && context.parentURL && /^\.{1,2}\//.test(specifier)) {
    const url = new URL(specifier, context.parentURL).href;
    if (SERVED.has(url)) return { url, format: 'module', shortCircuit: true };
  }
  return next(specifier, context);
};

exports.load = function load(url, context, next) {
  const src = SERVED.get(url);
  if (src) return { format: 'module', source: src(), shortCircuit: true };
  return next(url, context);
};
