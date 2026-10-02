'use strict';
// lib/core/brand-image.js's SMIL check must stay linear. Its old pattern put a
// bare \s* on both sides of an optional quote, so one long unquoted run of
// spaces after `attributeName=` could be split between them every possible way:
// 60 KB took 2.6 s and a 256 KB upload about 35 s, on the daemon's thread,
// reachable by any pane through PUT /api/brand/:slot (found by U18's review,
// 2026-10-02). The fix gives the quote its own trailing whitespace; these tests
// pin both the speed and the language it refuses.
const test = require('node:test');
const assert = require('node:assert');
const { svgRefusal, MAX_BYTES } = require('../lib/core/brand-image');

const SVG = (body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`);
const SMIL = 'an animation of an event handler or a link';

test('a near-limit run of spaces after attributeName= is judged in linear time', () => {
  const pad = ' '.repeat(MAX_BYTES - 200);
  const t0 = process.hrtime.bigint();
  const verdict = svgRefusal(SVG(`<set attributeName=${pad}x/>`));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(verdict, null);
  // Quadratic was ~35 s here; linear is a few ms. 2 s leaves room for a loaded CI box.
  assert.ok(ms < 2000, `svgRefusal took ${ms.toFixed(0)} ms on a ${MAX_BYTES - 200}-space run`);
});

test('many attributeName= openers, each followed by spaces, stay linear too', () => {
  const chunk = `<set attributeName=${' '.repeat(200)}x/>`;
  const body = chunk.repeat(Math.floor((MAX_BYTES - 200) / chunk.length));
  const t0 = process.hrtime.bigint();
  assert.equal(svgRefusal(SVG(body)), null);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 2000, `svgRefusal took ${ms.toFixed(0)} ms on repeated openers`);
});

test('the SMIL check still refuses every spelling it refused before', () => {
  for (const s of [
    '<set attributeName="onclick" to="x"/>',
    "<set attributeName=' href' to='#x'/>",
    '<set attributeName = xlink:href />',
    '<animate attributeName= " onload" />',
    '<set ATTRIBUTENAME="OnMouseOver"/>',
    '<set attributeName=\n"\thref"/>',
  ]) assert.equal(svgRefusal(SVG(s)), SMIL, s);
});

test('the SMIL check still passes animations of ordinary attributes', () => {
  for (const s of [
    '<set attributeName="fill" to="red"/>',
    '<animate attributeName="opacity" values="0;1"/>',
    "<set attributeName='stroke-width'/>",
  ]) assert.equal(svgRefusal(SVG(s)), null, s);
});
