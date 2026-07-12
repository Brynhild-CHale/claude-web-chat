# web-chat embed helper

Tiny browser extension that strips `X-Frame-Options` and `Content-Security-Policy` headers from iframe responses initiated by `localhost`. With it installed, `claude-web-chat`'s `website` component can embed any URL (subject to the site's other defenses), with your real browser cookies — i.e. logged-in views work.

**Scope is narrow on purpose**: rules apply only to `sub_frame` requests with initiator domain `localhost` or `127.0.0.1`. Top-level page loads, cross-site iframes initiated by other pages, etc. are unaffected.

## Install

### Chromium browsers (Chrome / Edge / Brave / Arc)

1. Open `chrome://extensions/` (or `edge://extensions/`, `brave://extensions/`, `arc://extensions/`).
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select this folder (`extensions/embed-helper`).
4. The extension stays installed across browser restarts.

### Firefox-based browsers (Zen / Firefox / LibreWolf / Waterfox)

Stock Firefox requires extensions to be signed for permanent install. For local dev there are two paths:

**Temporary (no signing, but removed on browser restart):**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**
3. Pick `manifest.json` inside this folder.
4. The extension is active until you quit the browser; reload it the same way next time.

**Permanent (one-time relaxation, where allowed):**

Some Firefox forks (LibreWolf, dev/nightly editions) let you disable signature enforcement. In `about:config`:

```
xpinstall.signatures.required = false
```

If your browser allows that pref to be changed, you can then drag `manifest.json` (or a packaged `.xpi`) into the browser to install permanently. Zen's policy on this varies by version — try the temporary install first; if you find yourself reloading it daily, check whether your Zen build allows the relaxation pref.

## Verifying it works

1. Open `http://localhost:5173/` and load the **embed helper status** component (or any `website` component).
2. If the helper is active, the website component skips the server-side embed-check and loads URLs directly with your browser session.
3. Without the helper, you'll get the friendly "this site refuses to be embedded" panel for sites that set `X-Frame-Options` or restrictive CSP.

## What about my privacy / security?

The extension does one thing: removes two response headers, only when the response is loading into an iframe whose embedding page is on `localhost`. It does not modify request headers, does not exfiltrate anything, has no remote server, no telemetry. Source is in this folder — read `rules.json` and `sentinel.js` (the sentinel is a single `<meta>` tag added to localhost pages so the UI can detect that the helper is loaded).

The security tradeoff you accept: pages embedded in iframes lose their CSP protections inside the frame. Combined with `sandbox="allow-scripts allow-same-origin"` on our iframe, this means embedded sites can read their own cookies from inside the frame — same as if you'd opened them in a tab. The helper doesn't grant any new origins access to anything; it only relaxes the embedded page's *own* defenses against being framed.
