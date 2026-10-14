// Our own guard on the mod's hooks module (templates/claude-mod/hooks/
// register.js, U88c): Claude Code 2.1.296 scans a mod's hooks module before it
// loads it and refuses the whole mod at the first construct its rules do not
// allow — which no fake `claude` in this suite can see. So this file holds
// register.js to those rules itself, read from the refusal texts Claude Code
// prints (never from its code), with a small tokenizer written here:
//
//   • `$` lives only under the name `$`: a plain parameter (no default, rest
//     or pattern) of a function declared at the top of the file (a function
//     declaration, or a const bound to one) or of a hook literal handed to
//     on(); it is never declared any other way, and never shadowed;
//   • every use of `$` is a call spelled $.<noun>.<event>(…), or `$` passed as
//     an argument to a function declared at the top of the file, in a call
//     with no spread argument, landing on that function's plain `$`
//     parameter — never stored (st.$, `= $`, an object key), destructured,
//     returned, spread or read any other way;
//   • every on( is on('<literal>', <function literal>) whose parameters are
//     plain names, the first one `$`;
//   • `arguments` is never read, there is no dynamic import(), next.to is only
//     next.to(e, '<tier>'), and no top-level function handed `$` shares its
//     name with another declaration in the file.
//
// What it does NOT express (only the real validator, run by hand with
// `claude plugin validate` on a staged copy, can): the scan's nesting-depth
// limit; its `$.state` / engine.create / telemetry / Client rules (the mod uses
// none); a parameter named like a top-level function shadowing it; and any
// rule Claude Code adds after 2.1.296.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REGISTER = path.join(__dirname, '..', 'templates', 'claude-mod', 'hooks', 'register.js');

// ── a tokenizer, enough for this file's JavaScript ──────────────────────────

const PUNCT = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '**', '++', '--', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~',
  '?', ':', '=', '.', '@', '#',
];
const BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

function tokenize(src) {
  const toks = [];
  let i = 0;
  let line = 1;
  const braces = []; // per open `{`: true when it opened a template substitution
  const push = (type, value, at) => toks.push({ type, value, line: at });
  const regexAllowed = () => {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (p.type === 'ident') return BEFORE_REGEX.has(p.value);
    if (p.type === 'num' || p.type === 'str' || p.type === 'regex') return false;
    if (p.type === 'tmpl') return p.value === '${';
    return !(p.value === ')' || p.value === ']' || p.value === '}');
  };
  // A template's text from `i` (just past a ` or a closing }) to its end or
  // its next ${.
  const templateText = () => {
    const at = line;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') line += 1;
      if (c === '`') { i += 1; push('tmpl', '`', at); return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; braces.push(true); push('tmpl', '${', at); return; }
      i += 1;
    }
    throw new Error(`unterminated template from line ${at}`);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error(`unterminated comment at line ${line}`);
      line += (src.slice(i, end).match(/\n/g) || []).length;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const at = line;
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j += 1;
        if (src[j] === '\n') throw new Error(`newline in a string at line ${at}`);
        j += 1;
      }
      push('str', src.slice(i + 1, j), at);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const at = line;
      const start = i;
      const before = toks.length;
      push('tmpl', '`', at);
      i += 1;
      templateText();
      // A template with no substitution is one string token.
      if (toks.length === before + 2 && toks[before + 1].value === '`') {
        toks.length = before;
        push('str', src.slice(start + 1, i - 1), at);
      }
      continue;
    }
    if (c === '}' && braces.length && braces[braces.length - 1] === true) {
      braces.pop();
      push('tmpl', '}', line);
      i += 1;
      templateText();
      continue;
    }
    if (c === '/' && regexAllowed()) {
      const at = line;
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') throw new Error(`newline in a regex at line ${at}`);
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j += 1;
      }
      j += 1;
      while (j < src.length && /[a-z]/.test(src[j])) j += 1;
      push('regex', src.slice(i, j), at);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9A-Za-z_.]/.test(src[j])) j += 1;
      push('num', src.slice(i, j), line);
      i = j;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < src.length && IDENT_PART.test(src[j])) j += 1;
      push('ident', src.slice(i, j), line);
      i = j;
      continue;
    }
    const p = PUNCT.find((x) => src.startsWith(x, i));
    if (!p) throw new Error(`unexpected ${JSON.stringify(c)} at line ${line}`);
    if (p === '{') braces.push(false);
    if (p === '}') braces.pop();
    push('punct', p, line);
    i += p.length;
  }
  return toks;
}

// ── the check ───────────────────────────────────────────────────────────────

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
const DECLARE = new Set(['const', 'let', 'var', 'function', 'class']);

function scan(src) {
  const toks = tokenize(src);
  const is = (k, value) => toks[k] && toks[k].type === 'punct' && toks[k].value === value;
  const isId = (k, value) => toks[k] && toks[k].type === 'ident' && (value === undefined || toks[k].value === value);

  // Matching brackets, and how deep each token sits.
  const match = new Map();
  const depth = [];
  const opener = []; // innermost open bracket around each token
  const stack = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const open = t.type === 'punct' && (t.value === '(' || t.value === '[' || t.value === '{');
    const close = t.type === 'punct' && (t.value === ')' || t.value === ']' || t.value === '}');
    const tmplOpen = t.type === 'tmpl' && t.value === '${';
    const tmplClose = t.type === 'tmpl' && t.value === '}';
    if (close || tmplClose) { const o = stack.pop(); match.set(o, k); match.set(k, o); }
    depth[k] = stack.length;
    opener[k] = stack.length ? stack[stack.length - 1] : -1;
    if (open || tmplOpen) stack.push(k);
  }
  if (stack.length) throw new Error('unbalanced brackets');

  const errors = [];
  const fail = (k, msg) => errors.push(`register.js:${toks[k] ? toks[k].line : '?'}: ${msg}`);

  // The parameters of the list opening at `o`, each { name, plain, at }.
  function params(o) {
    const c = match.get(o);
    const out = [];
    let k = o + 1;
    while (k < c) {
      const start = k;
      while (k < c && !(is(k, ',') && depth[k] === depth[o] + 1)) k++;
      const plain = k - start === 1 && isId(start);
      out.push({ name: plain ? toks[start].value : null, plain, at: start });
      k++;
    }
    return out;
  }

  // Is the ( at `o` a parameter list?
  function isParamList(o) {
    const c = match.get(o);
    if (is(c + 1, '=>')) return true;
    if (!is(c + 1, '{')) return false;
    const b = toks[o - 1];
    if (!b) return false;
    if (b.type === 'ident') return !CONTROL.has(b.value);
    return b.type === 'punct' && b.value === ']';
  }

  // The top-level functions: `function NAME(` (async, export and * allowed)
  // or `const NAME = <function>` at depth 0 → the ( of its parameter list.
  const top = new Map();
  for (let k = 0; k < toks.length; k++) {
    if (depth[k] !== 0) continue;
    if (isId(k, 'function')) {
      let n = k + 1;
      if (is(n, '*')) n++;
      if (isId(n) && is(n + 1, '(')) top.set(toks[n].value, n + 1);
    } else if (isId(k, 'const') && isId(k + 1) && is(k + 2, '=')) {
      let n = k + 3;
      if (isId(n, 'async')) n++;
      if (isId(n, 'function')) { n++; if (is(n, '*')) n++; if (isId(n)) n++; }
      if (is(n, '(') && isParamList(n)) top.set(toks[k + 1].value, n);
    }
  }
  const topParamLists = new Set(top.values());

  // on(...): the hook literals' parameter lists, checked as they are found.
  const hookParamLists = new Set();
  for (let k = 0; k < toks.length; k++) {
    if (!isId(k, 'on') || is(k - 1, '.') || is(k - 1, '?.')) continue;
    // register(on) itself.
    if (is(k - 1, '(') && isId(k - 2, 'register') && is(k + 1, ')')) continue;
    if (!is(k + 1, '(')) { fail(k, 'on is used other than as on("<event>", hook)'); continue; }
    const close = match.get(k + 1);
    const ev = toks[k + 2];
    if (!ev || ev.type !== 'str' || !is(k + 3, ',')) { fail(k, 'on( does not name its event as a string literal'); continue; }
    let n = k + 4;
    const commas = [];
    for (let m = k + 2; m < close; m++) if (is(m, ',') && depth[m] === depth[k + 1] + 1) commas.push(m);
    if (commas.length !== 1) { fail(k, `on("${ev.value}", …) takes exactly (event, hook)`); continue; }
    if (isId(n, 'async')) n++;
    let list = -1;
    if (isId(n, 'function')) {
      n++;
      if (is(n, '*')) n++;
      if (isId(n)) n++;
      if (is(n, '(')) list = n;
    } else if (is(n, '(') && is(match.get(n) + 1, '=>')) list = n;
    if (list < 0) { fail(k, `on("${ev.value}", …): the hook is not a function literal with a parameter list`); continue; }
    hookParamLists.add(list);
    const ps = params(list);
    if (!ps.length || ps.some((p) => !p.plain)) fail(list, `on("${ev.value}", …): a hook parameter is not a plain name (a default, a rest or a pattern)`);
    else if (ps[0].name !== '$') fail(list, `on("${ev.value}", …): the hook's first parameter is not named $`);
  }

  // Every $.
  const handedTo = new Set();
  for (let k = 0; k < toks.length; k++) {
    if (!isId(k, '$')) continue;
    if (is(k - 1, '.') || is(k - 1, '?.')) { fail(k, '$ is read or stored as a property (st.$)'); continue; }
    if (is(k + 1, '.') || is(k + 1, '?.') || is(k + 1, '[')) {
      if (is(k + 1, '.') && isId(k + 2) && is(k + 3, '.') && isId(k + 4) && is(k + 5, '(')) continue;
      fail(k, '$ is not spelled $.noun.event(...) here');
      continue;
    }
    if ((is(k - 1, '(') || is(k - 1, ',')) && (is(k + 1, ',') || is(k + 1, ')'))) {
      const o = opener[k];
      if (!is(o, '(')) { fail(k, '$ is used as a value (in a list that is no call)'); continue; }
      if (isParamList(o)) {
        if (!topParamLists.has(o) && !hookParamLists.has(o)) fail(k, '$ is a parameter of a function that is neither declared at the top of this file nor a hook (it shadows $)');
        continue;
      }
      const callee = toks[o - 1];
      if (callee && callee.type === 'ident' && (CONTROL.has(callee.value) || BEFORE_REGEX.has(callee.value))) {
        fail(k, '$ is used as a value (a condition or an operand)');
        continue;
      }
      if (!callee || callee.type !== 'ident' || is(o - 2, '.') || is(o - 2, '?.') || isId(o - 2, 'new')) {
        fail(k, '$ is passed to something other than a function named at the top of this file');
        continue;
      }
      if (!top.has(callee.value)) { fail(k, `$ is passed to "${callee.value}", which is not a function declared at the top of this file`); continue; }
      let spread = false;
      for (let m = o + 1; m < match.get(o); m++) if (is(m, '...') && depth[m] === depth[o] + 1) spread = true;
      if (spread) { fail(k, `$ is passed to "${callee.value}" in a call with a spread argument`); continue; }
      const index = params(o).findIndex((p) => p.at === k);
      const target = params(top.get(callee.value))[index];
      if (!target || !target.plain || target.name !== '$') { fail(k, `$ lands on a parameter of "${callee.value}" that is not a plain one named $`); continue; }
      handedTo.add(callee.value);
      continue;
    }
    if (is(k + 1, '=>')) { fail(k, '$ is the bare parameter of an arrow function'); continue; }
    fail(k, '$ is used as a value (bound, stored, destructured, returned, spread or read)');
  }

  for (let k = 0; k < toks.length; k++) {
    if (isId(k, 'arguments') && !is(k - 1, '.')) fail(k, '"arguments" is read');
    if (isId(k, 'import') && is(k + 1, '(')) fail(k, 'a dynamic import()');
    if (isId(k, 'next') && (is(k + 1, '.') || is(k + 1, '?.')) && isId(k + 2, 'to')) {
      if (!(is(k + 1, '.') && is(k + 3, '(') && isId(k + 4) && is(k + 5, ',') && toks[k + 6] && toks[k + 6].type === 'str' && is(k + 7, ')'))) {
        fail(k, 'next.to is not called as next.to(e, "<tier>")');
      }
    }
  }
  // A function handed $ declared twice: the other declaration hides it where
  // it is used.
  for (const name of handedTo) {
    let n = 0;
    for (let k = 0; k + 1 < toks.length; k++) {
      if (!(toks[k].type === 'ident' && DECLARE.has(toks[k].value))) continue;
      const at = toks[k].value === 'function' && is(k + 1, '*') ? k + 2 : k + 1;
      if (isId(at, name)) n += 1;
    }
    if (n > 1) errors.push(`register.js: "${name}" (handed $) is declared more than once in this file`);
  }
  return { errors, top: [...top.keys()], handedTo: [...handedTo] };
}

// ── register.js ─────────────────────────────────────────────────────────────

test('register.js passes our check of the 2.1.296 scan\'s rules for $, on and next.to', () => {
  const r = scan(fs.readFileSync(REGISTER, 'utf8'));
  assert.deepEqual(r.errors, []);
  assert.ok(r.handedTo.includes('runLoop'), 'the op loop is a top-level function handed $');
  assert.ok(r.handedTo.includes('begin'), 'begin is a top-level function handed $');
  assert.ok(r.top.includes('register'));
});

test('register.js never keeps $: no st.$, no $ key, no binding of $ but a parameter', () => {
  const src = fs.readFileSync(REGISTER, 'utf8');
  const toks = tokenize(src);
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].type !== 'ident' || toks[k].value !== '$') continue;
    const prev = toks[k - 1];
    const next = toks[k + 1];
    assert.ok(!(prev.type === 'punct' && prev.value === '.'), `line ${toks[k].line}: st.$`);
    assert.ok(!(next.type === 'punct' && (next.value === ':' || next.value === '=')), `line ${toks[k].line}: $ stored`);
    assert.ok(!(prev.type === 'ident' && DECLARE.has(prev.value)), `line ${toks[k].line}: $ declared`);
  }
});

// ── the check itself, on the constructs the scan refuses ────────────────────

const OK_HOOK = "export function register(on) {\n  on('session.start', async ($, e, next) => next(e));\n}\n";

for (const [what, src, re] of [
  ['$ handed to a function nested in register() (wc085/int\'s register.js:902, begin)',
    "export function register(on) {\n  function begin($, e) { return $.session.id(); }\n  on('session.start', async ($, e, next) => { const r = await next(e); begin($, e); return r; });\n}\n",
    /:3: \$ is passed to "begin", which is not a function declared at the top/],
  ['$ stored on the state (st.$ = $)',
    "function keep($, st) { st.$ = $; }\nexport function register(on) {\n  on('session.start', ($, e, next) => { keep($, {}); return next(e); });\n}\n",
    /:1: \$ is used as a value/],
  ['$ read back off the state',
    "function go(st) { return st.$.session.id(); }\nexport function register(on) {\n  on('session.start', ($, e, next) => next(e));\n}\n",
    /:1: \$ is read or stored as a property/],
  ['$ as an object key', "function mk($) { return { $: $ }; }\n" + OK_HOOK, /:1: \$ is used as a value/],
  ['$ destructured', "function mk($) { const { fs } = $; return fs; }\n" + OK_HOOK, /:1: \$ is used as a value/],
  ['a computed member of $', "function mk($, kind) { return $.clock[kind](1, () => {}); }\n" + OK_HOOK, /:1: \$ is not spelled/],
  ['a noun of $ read as a value', "function mk($) { const c = $.clock; return c; }\n" + OK_HOOK, /:1: \$ is not spelled/],
  ['$ passed with a spread argument', "function mk($, a) { return a; }\nfunction go($, xs) { return mk($, ...xs); }\n" + OK_HOOK, /:2: \$ is passed to "mk" in a call with a spread/],
  ['$ passed to a method', "function go($, o) { return o.run($); }\n" + OK_HOOK, /:1: \$ is passed to something other than a function named/],
  ['$ landing on a defaulted parameter', "function mk($ = null) { return 1; }\nfunction go($) { return mk($); }\n" + OK_HOOK, /:2: \$ lands on a parameter/],
  ['a closure taking $ (it shadows)', "function go(xs) { return xs.map(($) => 1); }\n" + OK_HOOK, /:1: \$ is a parameter of a function that is neither/],
  ['a hook with a defaulted parameter', "export function register(on) {\n  on('turn.start', ($, e = {}, next) => next(e));\n}\n", /not a plain name/],
  ['a hook taking a rest', "export function register(on) {\n  on('turn.start', ($, ...rest) => rest[1](rest[0]));\n}\n", /not a plain name/],
  ['an event that is no literal', "const EV = 'turn.start';\nexport function register(on) {\n  on(EV, ($, e, next) => next(e));\n}\n", /string literal/],
  ['on handed on', "function hook(on) { return on; }\nexport function register(on) {\n  hook(on);\n}\n", /on is used other than/],
  ['a function handed $ declared again inside another',
    "function mk($) { return 1; }\nfunction go() { const mk = 2; return mk; }\nfunction run($) { return mk($); }\n" + OK_HOOK,
    /"mk" \(handed \$\) is declared more than once/],
  ['"arguments" read', "function go($) { return arguments.length; }\n" + OK_HOOK, /"arguments" is read/],
  ['a dynamic import()', "async function go() { return import('./x.js'); }\n" + OK_HOOK, /dynamic import/],
  ['next.to bound', "export function register(on) {\n  on('turn.start', ($, e, next) => { const to = next.to; return to(e, 'x'); });\n}\n", /next\.to is not called/],
]) {
  test(`the check refuses ${what}`, () => {
    const { errors } = scan(src);
    assert.ok(errors.some((e) => re.test(e)), `expected ${re}, got ${JSON.stringify(errors)}`);
  });
}

test('the check passes what the scan allows: $ in a closure, in a template, handed on, and next.to(e, "<tier>")', () => {
  const src = [
    'function tick($, st) { return $.ui.status(`n=${st.n} at ${$.clock.now()}`); }',
    'function arm($, st) { return $.clock.every(1000, () => tick($, st)); }',
    'const each = async ($, st) => arm($, st);',
    'const RE = /^[$a-z]+$/;',
    'export function register(on) {',
    '  const st = { n: 0 };',
    "  on('session.start', async ($, e, next) => { const r = await next(e); void each($, st); return r; });",
    "  on('tool.call', ($, e, next) => (RE.test(e.tool) ? next.to(e, 'engine') : next(e)));",
    "  on('turn.step', async function* turnStep($, e, next) { return yield* next(e); });",
    '}',
    '',
  ].join('\n');
  assert.deepEqual(scan(src).errors, []);
});
