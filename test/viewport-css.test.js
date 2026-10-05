'use strict';
// Phones: the chrome must size to the VISIBLE viewport. 100vh is the height with
// the browser toolbars retracted, so the stage ran under Safari's and Chrome's
// bottom toolbar (hiding the bottom bar), and the overflow let Safari scroll the
// topbar up under the status bar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');
const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8');

test('the stage is sized by dvh (100vh only as the fallback before it)', () => {
  const stage = css.slice(css.indexOf('#stage {'), css.indexOf('}', css.indexOf('#stage {')));
  assert.match(stage, /height:\s*100vh;\s*height:\s*100dvh;/);
  assert.match(stage, /env\(safe-area-inset-top\)/);
});

test('the viewport covers the notch so the safe-area insets are real', () => {
  assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover/);
});

test('the bottom bar clears the home indicator on narrow screens and phones, through --bb-h', () => {
  // One structural property, --bb-h, is the bar's height, and what rides the
  // bar's top edge (the phone pull, design spec §8.2) reads the same number.
  // 0 where there is no bar; 52px + the home-indicator inset narrow; 60px + it
  // on a phone (<html class="phone">), today's numbers, unchanged.
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const decls = (sel, block) => [...block.matchAll(new RegExp(`(?:^|[}\\s])${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))]
    .map((m) => m[1]);
  const topLevel = flat.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const narrow = [...flat.matchAll(/@media\s*\(max-width:\s*759px\)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g)].map((m) => m[1]).join('\n');
  const bbH = (block, sel) => decls(sel, block).map((d) => (/--bb-h:\s*([^;]+);/.exec(d) || [])[1]).filter(Boolean);
  assert.deepEqual(bbH(topLevel, ':root'), ['0px'], 'no bottom bar at 760px and up');
  assert.deepEqual(bbH(narrow, ':root'), ['calc(52px + env(safe-area-inset-bottom))'], 'the narrow bar');
  assert.deepEqual(bbH(narrow, ':root.phone'), ['calc(60px + env(safe-area-inset-bottom))'], 'the phone\'s taller bar');
  assert.equal((flat.match(/--bb-h\s*:/g) || []).length, 3, '--bb-h is declared in those three places only');
  assert.doesNotMatch(flat, /--wc-bb-h/, 'structure, not a theme token');

  const heights = (block, sel) => decls(sel, block).map((d) => (/(?:^|;)\s*height:\s*([^;]+);/.exec(d) || [])[1]).filter(Boolean);
  assert.deepEqual(heights(narrow, '.bottombar'), ['var(--bb-h)'], 'the narrow bar reads it');
  assert.deepEqual(heights(topLevel, '.phone .bottombar'), ['var(--bb-h)'], 'and so does the phone\'s');
  // Their padding (the inset itself, under the buttons) is the bars' own.
  assert.match(decls('.bottombar', narrow).join(';'), /padding:\s*0 10px env\(safe-area-inset-bottom\)/);
  assert.match(decls('.phone .bottombar', topLevel).join(';'), /padding:\s*0 12px env\(safe-area-inset-bottom\)/);
});

test('no chrome rule sizes itself by 100vh alone', () => {
  const lines = css.split('\n').filter((l) => /100vh/.test(l) && !/^\s*\/\*|^\s*\*|^\s+100vh stays/.test(l));
  for (const l of lines) assert.match(l, /100dvh/, `a 100vh with no dvh override: ${l.trim()}`);
});
