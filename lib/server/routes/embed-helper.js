const fs = require('fs');
const path = require('path');
const express = require('express');

const HELP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>web-chat — install embed helper</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
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
</style>
</head>
<body>
<main>
  <h1>web-chat embed helper</h1>
  <div class="lede">A tiny browser extension that lets the <code>website</code> component embed sites that would otherwise refuse to be framed.</div>

  <div id="status" class="status bad">checking… (open this page in the same browser where you want to use the embed)</div>

  <h2>Path to the extension folder</h2>
  <div class="path" id="extpath">__EXTENSION_PATH__<button class="copy" id="copy">copy</button></div>
  <div class="note">Or download a zip: <a href="/embed-helper/download" class="btn sec">embed-helper.zip</a></div>

  <h2>Chromium browsers (Chrome / Edge / Brave / Arc)</h2>
  <ol>
    <li>Open <code>chrome://extensions</code> (Edge: <code>edge://extensions</code>; Arc: <code>arc://extensions</code>).</li>
    <li>Toggle <strong>Developer mode</strong> in the top-right.</li>
    <li>Click <strong>Load unpacked</strong> and select the folder above.</li>
    <li>Reload this page — the banner above should turn green.</li>
  </ol>

  <h2>Firefox-based browsers (Zen / Firefox / LibreWolf / Waterfox)</h2>
  <ol>
    <li>Open <code>about:debugging#/runtime/this-firefox</code>.</li>
    <li>Click <strong>Load Temporary Add-on…</strong>.</li>
    <li>Select the <code>manifest.json</code> file inside the folder above.</li>
    <li>Reload this page — the banner should turn green.</li>
  </ol>
  <div class="note">Temporary add-ons are removed when the browser restarts. For a permanent install on Zen, see the extension's <a href="/embed-helper/files/README.md">README</a> for the signing-relaxation workaround.</div>

  <h2>What it does</h2>
  <p>The extension removes <code>X-Frame-Options</code> and <code>Content-Security-Policy</code> response headers — but <strong>only</strong> on iframe sub-resource loads where the embedding page's origin is <code>localhost</code>. Other tabs and other browsing are untouched. Source: <a href="/embed-helper/files/rules.json">rules.json</a>, <a href="/embed-helper/files/sentinel.js">sentinel.js</a>, <a href="/embed-helper/files/manifest.json">manifest.json</a>.</p>
</main>
<script>
  const meta = document.querySelector('meta[name="claude-web-chat-embed-helper"]');
  const st = document.getElementById('status');
  if (meta) {
    st.className = 'status ok';
    st.textContent = '✓ embed helper is active (v' + meta.content + ')';
  } else {
    st.textContent = '✗ embed helper not detected — follow the steps below for your browser';
  }
  document.getElementById('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById('extpath').firstChild.textContent.trim());
      document.getElementById('copy').textContent = 'copied';
      setTimeout(() => { document.getElementById('copy').textContent = 'copy'; }, 1500);
    } catch {}
  });
</script>
</body>
</html>`;

function zipDir(srcDir) {
  // Minimal zip writer (store-only, no compression). Avoids adding a dependency.
  const entries = [];
  function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) entries.push({ name: r, data: fs.readFileSync(abs) });
    }
  }
  walk(srcDir, '');

  function crc32(buf) {
    let c, crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) {
      c = (crc ^ buf[i]) & 0xff;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ (-1)) >>> 0;
  }

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const size = e.data.length;
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);     // local file header signature
    local.writeUInt16LE(20, 4);             // version needed
    local.writeUInt16LE(0, 6);              // flags
    local.writeUInt16LE(0, 8);              // method = store
    local.writeUInt16LE(0, 10);             // time
    local.writeUInt16LE(0, 12);             // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);          // compressed size
    local.writeUInt32LE(size, 22);          // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);             // extra length
    nameBuf.copy(local, 30);
    localChunks.push(local, e.data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);   // central directory signature
    central.writeUInt16LE(20, 4);           // version made by
    central.writeUInt16LE(20, 6);           // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);           // extra length
    central.writeUInt16LE(0, 32);           // comment length
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centralChunks.push(central);

    offset += local.length + e.data.length;
  }
  const centralBuf = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, centralBuf, end]);
}

function mountEmbedHelperRoutes(app, { paths }) {
  const extDir = path.join(paths.EXTENSIONS_DIR, 'embed-helper');

  app.get('/embed-helper', (req, res) => {
    const html = HELP_PAGE.replace('__EXTENSION_PATH__', extDir);
    res.type('text/html').send(html);
  });

  app.use('/embed-helper/files', express.static(extDir, { fallthrough: false }));

  app.get('/embed-helper/download', (req, res) => {
    if (!fs.existsSync(extDir)) {
      return res.status(404).send('extension not found');
    }
    const buf = zipDir(extDir);
    res.type('application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="claude-web-chat-embed-helper.zip"');
    res.send(buf);
  });
}

module.exports = { mountEmbedHelperRoutes };
