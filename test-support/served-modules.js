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
  // /app/anchors.js, the anchor resolver main.js imports and installs
  // (lib/server/routes/page.js serves lib/core/anchors' browserModuleSource()).
  [pathToFileURL(path.join(REPO, 'public/app/anchors.js')).href,
    () => require(path.join(REPO, 'lib/core/anchors.js')).browserModuleSource()],
  // /app/tier-merge.js, the per-key tier merge the toolbar's records go through
  // (lib/server/routes/page.js serves lib/core/tier-merge's browserModuleSource()).
  [pathToFileURL(path.join(REPO, 'public/app/tier-merge.js')).href,
    () => require(path.join(REPO, 'lib/core/tier-merge.js')).browserModuleSource()],
  // /app/strokes.js, the stroke record target-frame.js commits (lib/core/strokes).
  [pathToFileURL(path.join(REPO, 'public/app/strokes.js')).href,
    () => require(path.join(REPO, 'lib/core/strokes.js')).browserModuleSource()],
  // /app/element-assets.js, the element type file grammar asset(rel) asks
  // (lib/server/routes/page.js serves lib/core/element-assets' browserModuleSource()).
  [pathToFileURL(path.join(REPO, 'public/app/element-assets.js')).href,
    () => require(path.join(REPO, 'lib/core/element-assets.js')).browserModuleSource()],
]);

exports.resolve = function resolve(specifier, context, next) {
  if (context && context.parentURL && /^\.{1,2}\//.test(specifier)) {
    const url = new URL(specifier, context.parentURL).href;
    if (SERVED.has(url)) return { url, format: 'module', shortCircuit: true };
  }
  // The file URL itself: chrome-shell's importApp('anchors.js') hands one in,
  // and gets the same module instance the chrome's own import resolved to.
  if (SERVED.has(specifier)) return { url: specifier, format: 'module', shortCircuit: true };
  return next(specifier, context);
};

exports.load = function load(url, context, next) {
  const src = SERVED.get(url);
  if (src) return { format: 'module', source: src(), shortCircuit: true };
  return next(url, context);
};
