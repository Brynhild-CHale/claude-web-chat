// A plug-in element type's draw.js, as the module contract names it (ruling
// U512-U522@draw-module-contract a; annotation engine tranche 4, U512): the
// default export is the function draw; create, move, glyph, sourceGlyph and
// targets are optional NAMED exports. test/element-loader-chrome.test.js
// writes this file as a .mjs under a temp dir and imports it by its file://
// URL, so the chrome loader (public/app/element-types.js loadPluginTypes) is
// held to the contract over a real ES module, not a stub object. It is the
// one draw.js the repository tracks (test/stale-references.test.js (a): a
// bare <name>.js named in public/ must be a tracked file). Never loaded by
// node --test itself: test-support/ is outside the runner's discovery.
export default function draw(group) { group.container.textContent = 'x'; }
export function create() { return 'made'; }
export const glyph = { dx: -8, dy: -8, w: 16, h: 16 };
