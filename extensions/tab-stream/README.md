# web-chat tab stream (browser extension)

Click a button in any tab to send a snapshot of that page into your web-chat
conversation. The page's rendered DOM is POSTed to the web-chat **hub** — a
fixed-port router — which forwards it to the web-chat **instance you pick**. That
instance runs a **profile** to distill it into something compact, folds it into
the turn graph, and signals Claude on the `tab_capture` store key.

Because every web-chat server registers with the hub on start, the popup shows a
dropdown of all running instances (projects), so one extension can feed any of
your conversations.

This is the tab-streaming feature's browser end. The profiles that distill
captured pages — and the panes they render into — are documented in
[`docs/capture-profiles-and-panes.md`](../../docs/capture-profiles-and-panes.md).

## Install (unpacked, for development)

1. Make sure web-chat is running: `claude-web-chat open`. The server starts the
   capture **hub** automatically on `http://localhost:5170` (override with
   `WEB_CHAT_HUB_PORT`). Run `claude-web-chat hub status` to check it.
2. Chrome/Edge → `chrome://extensions` → enable **Developer mode** → **Load
   unpacked** → select this `extensions/tab-stream/` folder.
3. (Optional) Open the extension's **Options** to point at a non-default hub
   endpoint, set a capture token, or force a profile.

## Use

- Click the toolbar icon → **Capture & send**, or right-click a page → **Send tab
  to web-chat**.
- The capture lands as a card on the surface (owner `service:tab-stream`) and as
  a `tab_capture` signal. Tell Claude to `wait_for` it, or just mention it on your
  next prompt and Claude reads it with `get_captures`.

## How it talks to the hub

- `GET {hub}/api/instances` → the list of running web-chat instances for the
  popup dropdown (`{ id, title, port, url }` each).
- `POST {hub}/api/capture` with `{ url, title, html, instance, profile? }` and an
  optional `X-WC-Token` header. The hub resolves `instance` (an id from the list;
  omitted = the lone instance, or `409` if several are running), then forwards
  the body to that instance's own `/api/capture`. That instance:
  - picks a profile (by `profile` hint, else URL/content match, else `default`),
  - distills the DOM → the **agent-visible** tier (`get_captures`),
  - stores the raw DOM as a sidecar file → the **on-demand** tier
    (`inspect_capture`), never loaded into Claude's context unless it drills in.

The popup remembers your last-used instance; the right-click menu reuses it
(no picker there).

## Config

| Field | Default | Notes |
|---|---|---|
| Hub endpoint | `http://localhost:5170` | The router the extension talks to. For a non-local host, also add it to `host_permissions` in `manifest.json`. |
| Token | _(blank)_ | Required only if the server sets `WEB_CHAT_CAPTURE_TOKEN` or `.web-chat/capture-token`. |
| Profile | _(blank)_ | Force a profile (e.g. `tables`); blank = server auto-selects. |

## Notes / limits

- Browser-internal pages (`chrome://`, `about:`, the extensions page) can't be
  captured.
- Captures the **DOM** — pages that render to `<canvas>` (e.g. some grid apps)
  won't expose their content this way; those need a profile with an in-page
  extractor (a later phase).
- Max body size is the server's JSON limit (5 MB today); very large pages may be
  rejected until that's raised.
