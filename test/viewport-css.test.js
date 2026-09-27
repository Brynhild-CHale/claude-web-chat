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

test('the bottom bar clears the home indicator on narrow screens and phones', () => {
  const rules = css.match(/\.bottombar \{[^}]*\}/g).join('\n') + (css.match(/\.phone \.bottombar \{[^}]*\}/) || [''])[0];
  assert.match(rules, /calc\(52px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(rules, /calc\(60px \+ env\(safe-area-inset-bottom\)\)/);
});

test('no chrome rule sizes itself by 100vh alone', () => {
  const lines = css.split('\n').filter((l) => /100vh/.test(l) && !/^\s*\/\*|^\s*\*|^\s+100vh stays/.test(l));
  for (const l of lines) assert.match(l, /100dvh/, `a 100vh with no dvh override: ${l.trim()}`);
});
