const http = require('http');
const https = require('https');
const { URL } = require('url');

function fetchHead(urlStr, method, redirectsLeft = 4) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve({ error: 'invalid url' }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return resolve({ error: 'unsupported protocol' });
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'user-agent': 'claude-web-chat embed-check/1.0',
        'accept': 'text/html,*/*;q=0.1',
      },
      timeout: 5000,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        const next = new URL(res.headers.location, urlStr).toString();
        res.resume();
        return resolve(fetchHead(next, method, redirectsLeft - 1));
      }
      // Drain body — we only care about headers.
      res.resume();
      resolve({
        status,
        finalUrl: urlStr,
        headers: res.headers,
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

function classify(headers) {
  const xfo = String(headers['x-frame-options'] || '').toLowerCase();
  const csp = String(headers['content-security-policy'] || '');
  if (xfo === 'deny') return { blocked: true, reason: 'X-Frame-Options: DENY' };
  if (xfo.startsWith('sameorigin')) return { blocked: true, reason: 'X-Frame-Options: SAMEORIGIN' };
  if (xfo.startsWith('allow-from')) return { blocked: true, reason: 'X-Frame-Options: ' + headers['x-frame-options'] };
  const fa = csp.split(/;\s*/).find(d => /^frame-ancestors\s/i.test(d));
  if (fa) {
    const sources = fa.replace(/^frame-ancestors\s+/i, '').trim().toLowerCase();
    if (sources === "'none'" || sources === 'none') {
      return { blocked: true, reason: "CSP frame-ancestors 'none'" };
    }
    // Anything other than '*' is restrictive; the iframe is unlikely to render
    // from our origin unless localhost is explicitly listed.
    if (sources !== '*' && !/\blocalhost\b/.test(sources)) {
      return { blocked: true, reason: 'CSP frame-ancestors: ' + sources };
    }
  }
  return { blocked: false };
}

function mountEmbedRoutes(app) {
  app.get('/api/embed-check', async (req, res) => {
    const url = req.query.url;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url required' });
    }
    // Try HEAD first; some servers don't allow HEAD, fall back to GET.
    let r = await fetchHead(url, 'HEAD');
    if (!r || r.error || (r.status && (r.status === 405 || r.status === 501))) {
      const fallback = await fetchHead(url, 'GET');
      if (!fallback.error) r = fallback;
    }
    if (r.error) {
      return res.json({ ok: false, blocked: false, reachable: false, reason: r.error });
    }
    const verdict = classify(r.headers || {});
    res.json({
      ok: true,
      reachable: true,
      status: r.status,
      finalUrl: r.finalUrl,
      blocked: verdict.blocked,
      reason: verdict.reason || null,
    });
  });
}

module.exports = { mountEmbedRoutes };
