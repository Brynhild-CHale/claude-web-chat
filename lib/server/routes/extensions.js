// The front door for the two bundled browser extensions.
//
// Sideloading an unpacked extension needs one thing the README cannot supply:
// the absolute path to the folder ON THIS MACHINE. The daemon knows it
// (paths.EXTENSIONS_DIR), so the daemon is where the install instructions
// belong — `/extensions` lists what ships, `/extensions/<name>` walks through
// loading one and prints the path to copy.
//
// This is the ONE extension-page engine. `/embed-helper` (the original, embed-
// helper-only page) is kept as a redirect so old links still land somewhere.
const fs = require('fs');
const path = require('path');
const express = require('express');
const { escapeHtml } = require('../util/html');
const { hubPort } = require('../../util/hub');
const { writeZipStore } = require('../../core/zip');

// What each bundled extension is, in the words the install page needs. `probe`
// names the <meta> the extension injects into localhost pages, when it has one:
// that is how the page can tell the user it is actually loaded rather than
// asking them to guess.
const EXTENSIONS = {
  'tab-stream': {
    title: 'tab stream',
    tagline: 'Send a snapshot of any browser tab into this conversation.',
    what: 'Adds a toolbar button and a right-click item. Both grab the current tab\'s rendered DOM ' +
      'and POST it to the local capture hub, which forwards it to the web-chat project you pick. ' +
      'Nothing is sent anywhere but your own machine.',
    probe: null,
    verify: 'hub',
  },
  'embed-helper': {
    title: 'embed helper',
    tagline: 'Let the website component embed sites that refuse to be framed.',
    what: 'Removes X-Frame-Options and Content-Security-Policy response headers — but only on iframe ' +
      'sub-resource loads whose embedding page is on localhost. Other tabs and other browsing are untouched.',
    probe: 'claude-web-chat-embed-helper',
    verify: 'probe',
  },
};

const CSS = `
  :root { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; color: #1f2328; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fafafa; }
  main { max-width: 720px; margin: 30px auto; padding: 24px; background: #fff;
    border: 1px solid #e3e3e3; border-radius: 8px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .lede { color: #57606a; font-size: 13.5px; margin-bottom: 18px; }
  h2 { margin: 22px 0 8px; font-size: 15px; border-bottom: 1px solid #eaeef2; padding-bottom: 4px; }
  ol { padding-left: 22px; line-height: 1.55; }
  li { margin: 5px 0; }
  p { line-height: 1.55; }
  code, kbd { font-family: ui-monospace, Menlo, monospace; background: #f6f8fa;
    padding: 1px 5px; border-radius: 3px; font-size: 12.5px; }
  .path { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px;
    background: #f6f8fa; padding: 6px 10px; border-radius: 4px;
    border: 1px solid #eaeef2; word-break: break-all; user-select: all; }
  .copy { float: right; font-size: 11px; padding: 2px 8px; border: 1px solid #d0d7de;
    background: #fff; border-radius: 3px; cursor: pointer; margin-left: 6px; }
  .copy:hover { background: #f6f8fa; }
  .btn { display: inline-block; margin: 8px 6px 8px 0; padding: 6px 12px;
    background: #0969da; color: #fff; border-radius: 4px; text-decoration: none;
    font-size: 13px; }
  .btn:hover { background: #0550ae; }
  .btn.sec { background: #fff; color: #1f2328; border: 1px solid #d0d7de; }
  .btn.sec:hover { background: #f6f8fa; }
  .note { font-size: 12px; color: #57606a; margin-top: 6px; }
  .status { padding: 8px 12px; border-radius: 4px; font-size: 13px; margin-bottom: 16px; }
  .status.ok { background: #dafbe1; color: #1a7f37; border: 1px solid #1a7f37; }
  .status.bad { background: #fff8c5; color: #9a6700; border: 1px solid #d4a72c; }
  .card { display: block; padding: 14px 16px; margin: 10px 0; border: 1px solid #d0d7de;
    border-radius: 6px; text-decoration: none; color: inherit; }
  .card:hover { background: #f6f8fa; border-color: #0969da; }
  .card h3 { margin: 0 0 4px; font-size: 14px; color: #0969da; }
  .card .d { font-size: 12.5px; color: #57606a; }
  .icon { width: 32px; height: 32px; vertical-align: middle; margin-right: 10px; float: left; }
`;

function page(title, body, script) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS}</style>
</head>
<body>
<main>
${body}
</main>
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;
}

// The clipboard + status wiring shared by every install page. Kept out of the
// template strings so no page-specific value is ever concatenated into script
// source (all dynamic values arrive as escaped HTML text nodes instead).
const PAGE_SCRIPT = `
  const st = document.getElementById('status');
  if (st) {
    const probe = st.dataset.probe;
    if (probe) {
      const meta = document.querySelector('meta[name="' + probe + '"]');
      if (meta) { st.className = 'status ok'; st.textContent = '\\u2713 installed and active (v' + meta.content + ')'; }
      else { st.textContent = '\\u2717 not detected in this browser \\u2014 follow the steps below'; }
    } else if (st.dataset.hub) {
      st.textContent = 'checking the capture hub\\u2026';
      fetch(st.dataset.hub + '/api/instances')
        .then((r) => r.json())
        .then((j) => {
          const n = (j.instances || []).length;
          st.className = 'status ok';
          st.textContent = '\\u2713 capture hub is running \\u2014 ' + n + ' web-chat project' + (n === 1 ? '' : 's') + ' available to capture into';
        })
        .catch(() => {
          st.className = 'status bad';
          st.textContent = '\\u2717 capture hub not reachable at ' + st.dataset.hub + ' \\u2014 run: claude-web-chat open';
        });
    }
  }
  for (const btn of document.querySelectorAll('.copy')) {
    btn.addEventListener('click', async () => {
      const target = document.getElementById(btn.dataset.target);
      try {
        await navigator.clipboard.writeText(target.firstChild.textContent.trim());
        btn.textContent = 'copied';
        setTimeout(() => { btn.textContent = 'copy'; }, 1500);
      } catch {}
    });
  }
`;

function indexPage(extDirFor) {
  const cards = Object.entries(EXTENSIONS).map(([name, meta]) => `
  <a class="card" href="/extensions/${escapeHtml(name)}">
    <img class="icon" src="/extensions/${escapeHtml(name)}/files/icons/icon48.png" alt="">
    <h3>web-chat ${escapeHtml(meta.title)}</h3>
    <div class="d">${escapeHtml(meta.tagline)}</div>
  </a>`).join('\n');
  return page('web-chat — browser extensions', `
  <h1>Browser extensions</h1>
  <div class="lede">Two optional, local-only extensions ship with web-chat. Each page below prints the
    exact folder to load on <strong>this machine</strong>.</div>
  ${cards}
  <div class="note">Both are unpacked/dev-mode loads: nothing is fetched from a web store, and the
    source is right here under <code>${escapeHtml(extDirFor(''))}</code>.</div>
`, PAGE_SCRIPT);
}

function extensionPage(name, meta, extDir, hub) {
  const statusAttrs = meta.probe
    ? ` data-probe="${escapeHtml(meta.probe)}"`
    : ` data-hub="${escapeHtml(hub)}"`;
  return page(`web-chat — install ${meta.title}`, `
  <div class="note"><a href="/extensions">&larr; all extensions</a></div>
  <h1>
    <img class="icon" src="/extensions/${escapeHtml(name)}/files/icons/icon48.png" alt="">
    web-chat ${escapeHtml(meta.title)}
  </h1>
  <div class="lede">${escapeHtml(meta.tagline)}</div>

  <div id="status" class="status bad"${statusAttrs}>checking… (open this page in the browser you want to install into)</div>

  <h2>1. The folder to load</h2>
  <div class="path" id="extpath">${escapeHtml(extDir)}<button class="copy" data-target="extpath">copy</button></div>
  <div class="note">Or download a zip: <a href="/extensions/${escapeHtml(name)}/download" class="btn sec">${escapeHtml(name)}.zip</a>
    &mdash; unzip it first; browsers load a <em>folder</em>, not the archive.</div>

  <h2>2. Chromium browsers (Chrome / Edge / Brave / Arc)</h2>
  <ol>
    <li>Open <code>chrome://extensions</code> (Edge: <code>edge://extensions</code>; Arc: <code>arc://extensions</code>).</li>
    <li>Toggle <strong>Developer mode</strong> in the top-right.</li>
    <li>Click <strong>Load unpacked</strong> and select the folder above.</li>
    <li>Reload this page &mdash; the banner at the top should turn green.</li>
  </ol>

  <h2>2b. Firefox-based browsers (Zen / Firefox / LibreWolf / Waterfox)</h2>
  <ol>
    <li>Open <code>about:debugging#/runtime/this-firefox</code>.</li>
    <li>Click <strong>Load Temporary Add-on&hellip;</strong>.</li>
    <li>Select the <code>manifest.json</code> file inside the folder above.</li>
    <li>Reload this page &mdash; the banner should turn green.</li>
  </ol>
  <div class="note">Temporary add-ons are removed when the browser restarts. See the
    <a href="/extensions/${escapeHtml(name)}/files/README.md">README</a> for the permanent-install notes.</div>

  <h2>3. What it does</h2>
  <p>${escapeHtml(meta.what)}</p>
  <p class="note">Read the source before you trust it:
    <a href="/extensions/${escapeHtml(name)}/files/manifest.json">manifest.json</a>,
    <a href="/extensions/${escapeHtml(name)}/files/README.md">README.md</a>.</p>
`, PAGE_SCRIPT);
}

function mountExtensionRoutes(app, { paths }) {
  const dirFor = (name) => path.join(paths.EXTENSIONS_DIR, name);
  const hubOrigin = () => `http://localhost:${hubPort()}`;

  app.get('/extensions', (req, res) => {
    res.type('text/html').send(indexPage(dirFor));
  });

  // Static file trees, one per known extension. Registered from the registry —
  // never from the request path — so `:name` can't reach outside EXTENSIONS_DIR.
  for (const name of Object.keys(EXTENSIONS)) {
    app.use(`/extensions/${name}/files`, express.static(dirFor(name), { fallthrough: false }));
  }

  app.get('/extensions/:name/download', (req, res) => {
    const meta = EXTENSIONS[req.params.name];
    const dir = meta && dirFor(req.params.name);
    if (!meta || !fs.existsSync(dir)) return res.status(404).send('extension not found');
    res.type('application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="claude-web-chat-${req.params.name}.zip"`);
    res.send(writeZipStore(dir));
  });

  app.get('/extensions/:name', (req, res) => {
    const meta = EXTENSIONS[req.params.name];
    if (!meta) return res.status(404).type('text/html').send(page('web-chat — unknown extension',
      `<h1>No such extension</h1><p><a href="/extensions">See what ships with web-chat</a>.</p>`));
    res.type('text/html').send(extensionPage(req.params.name, meta, dirFor(req.params.name), hubOrigin()));
  });

  // Legacy paths from when this served only the embed helper. Redirect rather
  // than duplicate: one page engine, one set of instructions to keep correct.
  app.get('/embed-helper', (req, res) => res.redirect(302, '/extensions/embed-helper'));
  app.get('/embed-helper/download', (req, res) => res.redirect(302, '/extensions/embed-helper/download'));
  app.use('/embed-helper/files', express.static(dirFor('embed-helper'), { fallthrough: false }));
}

module.exports = { mountExtensionRoutes, EXTENSIONS };
