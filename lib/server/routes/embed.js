// GET /api/embed-check — "will this page render inside an iframe?", asked by the
// `website` builtin before it points its frame somewhere.
//
// This route makes the DAEMON issue an outbound request to a URL the caller
// names, and hands the caller back the status and the final URL. Its only
// legitimate caller is itself a pane (templates/components/website/
// component.html), so the "no browsers" gate that protects /api/shutdown and the
// disk-writing export cannot be used here — a pane IS a browser, and every pane
// script in the surface already has this same reach (see the residual-risk
// header in routes/packs.js).
//
// So the gate is on the TARGET instead: the daemon will not be talked into
// reaching anything that is not a public http(s) host. Without it, any pane
// script — or any web page, since this is a simple GET — could port-scan
// loopback and the local network through us and read back a status and a final
// URL for each probe, and the loopback bind is no defence at all because WE are
// the one making the connection. Refused:
//
//   - anything that is not http:// or https://
//   - loopback, private, link-local, CGNAT, multicast and reserved literals, in
//     both address families (v4-mapped v6 included)
//   - a NAME that resolves to any of those — decided at DNS time, and enforced
//     by handing the socket only the addresses that survived, so a target whose
//     DNS is rebound between check and connect cannot slip through
//   - every redirect hop, re-checked from scratch; userinfo credentials are
//     stripped from the URL we follow and from the one we report back

const http = require('http');
const https = require('https');
const dns = require('dns');
const { URL } = require('url');

// --- the target fence --------------------------------------------------------

function ipv4Private(a, b) {
  return (
    a === 0                                  // "this network"
    || a === 10                              // RFC1918
    || a === 127                             // loopback
    || (a === 100 && b >= 64 && b <= 127)    // CGNAT
    || (a === 169 && b === 254)              // link-local
    || (a === 172 && b >= 16 && b <= 31)     // RFC1918
    || (a === 192 && b === 168)              // RFC1918
    || (a === 192 && b === 0)                // IETF protocol assignments
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || a >= 224                              // multicast, reserved, broadcast
  );
}

// Is this LITERAL address one the daemon must not be talked into reaching?
// Parses only — never resolves — so it is safe to call on a URL hostname and
// again on whatever DNS returned. Anything unparseable is refused (fail closed).
function isPrivateAddress(ip) {
  if (typeof ip !== 'string') return true;
  let s = ip.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return true;
    return ipv4Private(parts[0], parts[1]);
  }
  if (!s.includes(':')) return false; // a name, not a literal — DNS decides

  // EVERY v6 spelling is decided on the EXPANDED address, never on a prefix
  // match against the text, because one address has many spellings and only the
  // eight hextets are the same in all of them. `::ffff:127.0.0.1` is what a
  // human writes, but WHATWG URL re-serialises it as `::ffff:7f00:1` and
  // `0:0:0:0:0:0:0:1` is a legal way to write loopback — a `startsWith` table
  // sees neither. expandV6 folds a dotted v4 tail into its two hextets, so the
  // dotted spellings take this one path too rather than a shortcut of their own
  // that only fired when the dots survived to here.
  const g = expandV6(s);
  if (!g) return true;                            // unparseable — fail closed
  if (g.every((n) => n === 0)) return true;       // ::  unspecified
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true; // ::1
  // The three prefixes that EMBED a v4 address in their low 32 bits: the v4 is
  // what the socket ends up reaching, so it is what decides.
  //   ::ffff:a.b.c.d  v4-mapped
  //   ::a.b.c.d       v4-compatible (deprecated, still routable text)
  //   64:ff9b::/96    NAT64 well-known prefix (RFC 6052 §2.1) — only reachable
  //                   on a host with NAT64 connectivity, which is exactly the
  //                   host where it would otherwise be a way to say 127.0.0.1
  const embeddedV4 = () => ipv4Private(g[6] >> 8, g[6] & 0xff);
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return embeddedV4();
  if (g.slice(0, 6).every((n) => n === 0)) return embeddedV4();
  if (g[0] === 0x0064 && g[1] === 0xff9b) {
    // 64:ff9b::/96 carries the v4 in the low 32 bits. 64:ff9b:1::/48 (RFC 8215,
    // local-use) does not say WHERE in the remaining bits it sits — /48, /56,
    // /64 and /96 embeddings are all legal — so it is refused whole rather than
    // decoded at a guess. Fail closed, like every other address we cannot read.
    if (g.slice(2, 6).every((n) => n === 0)) return embeddedV4();
    return true;
  }
  const top = g[0] >> 8;
  if (top === 0xfc || top === 0xfd) return true;  // fc00::/7  unique-local
  if (g[0] >= 0xfe80 && g[0] <= 0xfebf) return true; // fe80::/10 link-local
  if (top === 0xff) return true;                  // ff00::/8  multicast
  return false;
}

// The eight hextets of an IPv6 literal, or null if it is not one. `::` expands
// to however many zero groups are missing; a second `::`, a bad group or the
// wrong count is null, and every caller treats null as "refuse".
function expandV6(s) {
  // A trailing dotted quad is two hextets written in decimal (::ffff:127.0.0.1,
  // 64:ff9b::127.0.0.1). Fold it in first so the rest of this function — and
  // every caller — only ever deals with hex groups.
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const o = dotted.slice(2).map(Number);
    if (o.some((n) => n > 255)) return null;
    s = dotted[1]
      + ((o[0] << 8) | o[1]).toString(16) + ':'
      + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups;
  if (tail === null) {
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const out = groups.map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return out.some((n) => !Number.isInteger(n)) ? null : out;
}

// A hostname the URL parser has already normalised into an address literal.
// (WHATWG URL rewrites every legacy IPv4 spelling — 2130706433, 0177.0.0.1 —
// into dotted-quad, so this sees the canonical form.)
function isAddressLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');
}

// Loopback by definition, whatever a resolver claims. The optional trailing dot
// is the fully-qualified spelling (`localhost.`): a resolver treats it as the
// same name, so this layer has to as well — the DNS-time filter would catch the
// answer, but this one is the cheap resolver-independent first pass and is only
// worth having if it holds on its own.
const LOOPBACK_NAMES = /^(localhost|.*\.localhost)\.?$/;
const NOT_PUBLIC = 'target is not a public host';

// The one refusal the caller must be able to tell apart from the others.
// "I will not fetch that FOR you" is not "that page cannot be framed": the
// browser has no such restriction, and framing a local dev server is the whole
// point of the `website` builtin. The pane cannot work this out for itself —
// only the resolver knows what `myapp.test` or `foo.local` is — so the route
// labels this refusal and the pane skips the advisory pre-check for it. It
// leaks nothing the human `reason` did not already say, and the daemon still
// never dials the address.
const PRIVATE_TARGET = 'private-target';

// Refuse a target URL, or return null to allow it. The string is what the route
// reports, so a refusal reads as "unreachable, because…" in the pane.
function refuseTarget(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'unsupported protocol';
  const host = String(u.hostname || '').toLowerCase();
  if (!host) return 'no host';
  if (LOOPBACK_NAMES.test(host)) return NOT_PUBLIC;
  if (isAddressLiteral(host) && isPrivateAddress(host)) return NOT_PUBLIC;
  return null;
}

// The DNS half. Node hands the socket's address selection to `lookup`, so this
// filter is not advisory: the socket can only connect to what survives it.
function publicOnlyLookup(hostname, options, cb) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err);
    if (options && options.all) {
      const safe = (address || []).filter((a) => !isPrivateAddress(a && a.address));
      if (!safe.length) return cb(new Error(NOT_PUBLIC));
      return cb(null, safe);
    }
    if (isPrivateAddress(address)) return cb(new Error(NOT_PUBLIC));
    return cb(null, address, family);
  });
}

// The fence the route uses. A parameter rather than a hardcoded call so the
// redirect and HEAD-to-GET machinery can be exercised against a local
// http.createServer in tests; the route passes nothing but this, so the open
// behaviour is not reachable over HTTP.
const PUBLIC_ONLY = { refuse: refuseTarget, lookup: publicOnlyLookup };

// --- the requester -----------------------------------------------------------

function fetchHead(urlStr, method, redirectsLeft = 4, fence = PUBLIC_ONLY) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve({ error: 'invalid url' }); }
    const refused = fence.refuse(u);
    if (refused) return resolve({ error: refused });
    // Credentials are never forwarded (the request is built from the parts
    // below), and never echoed back or carried into a redirect either.
    u.username = '';
    u.password = '';
    const clean = u.toString();
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      lookup: fence.lookup,
      headers: {
        'user-agent': 'claude-web-chat embed-check/1.0',
        'accept': 'text/html,*/*;q=0.1',
      },
      timeout: 5000,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        let next = null;
        try { next = new URL(res.headers.location, clean).toString(); } catch {}
        res.resume();
        if (!next) return resolve({ error: 'invalid redirect' });
        // Re-enters the fence from the top: a public host that redirects to
        // 127.0.0.1 is refused on the hop rather than followed.
        return resolve(fetchHead(next, method, redirectsLeft - 1, fence));
      }
      // Drain body — we only care about headers.
      res.resume();
      resolve({
        status,
        finalUrl: clean,
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
      return res.json({
        ok: false,
        blocked: false,
        reachable: false,
        reason: r.error,
        // Both halves of the fence — the literal one and the resolver one —
        // refuse with NOT_PUBLIC, so one comparison covers a name too.
        code: r.error === NOT_PUBLIC ? PRIVATE_TARGET : null,
      });
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

module.exports = {
  mountEmbedRoutes, fetchHead, classify, refuseTarget, isPrivateAddress, publicOnlyLookup,
  PRIVATE_TARGET,
};
