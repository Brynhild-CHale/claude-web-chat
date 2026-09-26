# Remote access — your surfaces from anywhere

`claude-web-chat tunnel` puts the web-chat surfaces running on this machine
behind a Cloudflare tunnel, so you can open them from your phone or another
computer — signed in with Google, and only as an account you allowlisted.

Nothing about the local setup changes. Every daemon still binds loopback only;
what the tunnel reaches is a separate process, the **portal**, which checks
every request before it forwards anything to a daemon.

```
browser ──https──▶ Cloudflare Access ──▶ tunnel ──▶ cloudflared ──▶ portal ──▶ daemon
                   (Google sign-in,                 (this machine)  127.0.0.1  127.0.0.1
                    your email policy)                              :5171      :5173+
```

## What you need

- **A domain on Cloudflare** (its DNS managed there). The free plan is enough.
- **Cloudflare Zero Trust**, free plan — that is where the tunnel and the Access
  application live. Your *team name* is the `<team>` in `<team>.cloudflareaccess.com`.
- **Google** set up as a login method in Zero Trust (Settings → Authentication →
  Login methods → Add → Google).
- **cloudflared** on this machine, 2024.1.0 or newer. web-chat never installs it:
  - macOS: `brew install cloudflared`
  - Linux: Cloudflare's package repository, https://pkg.cloudflare.com/ (Debian/Ubuntu:
    add the apt source, then `sudo apt install cloudflared`)
  - Windows: inside WSL2, install the **Linux** build in the distro. A Windows
    `cloudflared.exe` cannot reach the portal on WSL's loopback.

## Hostnames

You pick one hostname for the **picker** — the page listing your running
projects — for example `wc.example.com`. It shows the same live picture as
`claude-web-chat ls`: each running surface (viewers, the active node, a turn in
progress) and whether a Claude Code session is attached (`×N`, channel on/off,
when it last called a tool). A project with Claude attached but no surface
running is listed as *Claude attached · surface stopped*, without a link — the
portal never starts a surface; run `claude-web-chat open` on the host. Each project then gets its own
hostname, derived from its instance id (eight hex characters, stable per
project directory):

| style | picker | a project | certificate |
| --- | --- | --- | --- |
| **flat** (default) | `wc.example.com` | `wc-0a1b2c3d.example.com` | covered by the free Universal SSL certificate (`*.example.com`) |
| nested | `wc.example.com` | `0a1b2c3d.wc.example.com` | needs a certificate for `*.wc.example.com` (Advanced Certificate Manager) |

Each project on its own hostname means each is its own browser origin: a page
in one project cannot read another's.

## Walkthrough

1. **Create the tunnel.** Either:
   - **token** (dashboard-managed, simplest): Zero Trust → Networks → Tunnels →
     Create a tunnel → Cloudflared. Copy the connector token (the long string
     after `--token` in the install command it shows). **Don't** run that
     install command — `tunnel up` runs cloudflared for you.
   - **local**: `cloudflared tunnel login`, then `cloudflared tunnel create wc-home`.
     web-chat generates the ingress file on every `tunnel up`.
2. **Create the Access application.** Zero Trust → Access → Applications →
   Add an application → Self-hosted. Cover both the picker and the project
   hostnames (`wc.example.com` and `wc-*.example.com`; for nested,
   `*.wc.example.com`). Login method: Google. Policy: Allow → Include →
   Emails → your address. Open the application and copy its **Application
   Audience (AUD) Tag**.
3. **Run setup** on this machine and answer its questions (or pass them as flags):

   ```sh
   claude-web-chat tunnel setup
   # non-interactive:
   claude-web-chat tunnel setup --hostname wc.example.com --team myteam \
     --aud <AUD tag> --email you@gmail.com --kind token --token-file ~/Downloads/token.txt
   ```

   Setup fetches your team's Access signing keys to prove the team name, writes
   `~/.web-chat/tunnel/tunnel.json` (mode 0600) and the connector token to
   `~/.web-chat/tunnel/token` (0600), and prints the remaining dashboard steps
   with your hostnames filled in. The token is never a flag *value* — that would
   put it in your shell history — only a file to read it from, or a paste.
4. **Route the hostnames to the portal.**
   - token tunnel: in the tunnel's Public Hostnames, add `wc.example.com` and
     `*.example.com` (or one per project — `claude-web-chat tunnel status` lists
     them), each with service `http://127.0.0.1:5171`.
   - local tunnel: `cloudflared tunnel route dns wc-home wc.example.com` and
     `cloudflared tunnel route dns wc-home '*.example.com'` (or one per project).
5. **Start it:** `claude-web-chat tunnel up`. It refuses, with the reason, if the
   config is missing or invalid, the allowlist is empty, the tunnel is a quick
   tunnel, `WEB_CHAT_HOST` has moved your daemons off loopback, cloudflared is
   missing or too old, or the token is missing.
6. **Open** `https://wc.example.com/` from anywhere, sign in with Google, and
   pick a project. Only projects whose surface is **running** are listed; the
   portal never starts a daemon. Start one on this machine with `claude-web-chat open`.

## Commands

```
tunnel setup       ask for (or take as flags) the hostname, style, Access team,
                   AUD tag, allowed email(s) and the tunnel; verify; write config
tunnel up          preflight, then start the portal (port 5171 —
                   WEB_CHAT_PORTAL_PORT to move it) which runs cloudflared;
                   a portal left running by an older build is restarted
tunnel down        stop the portal; cloudflared stops with it
tunnel status      config, portal pid, whether the connector is READY, when the
                   Access keys were last refreshed, every exposed project, and
                   every hidden one with the reason
tunnel logs        the portal, cloudflared and remote access logs (--follow,
                   --portal, --cloudflared, --access, --lines <n>)
```

`claude-web-chat doctor` has a tunnel section once setup has run.

The portal restarts cloudflared if it exits (waiting 1s, then 2s, 4s … up to a
minute; a run that lasted five minutes starts the ladder again) and stops it
when the portal stops. Nothing starts at login — run `tunnel up` again after a
reboot. After `claude-web-chat update`, run `tunnel up` too: a portal still
running from the previous build keeps enforcing that build's rules until it is
restarted, and `up` restarts one it finds older (nothing restarts it behind your
back).

## Keeping a project off the tunnel

Every running project is reachable by default. Two ways to take one off —
either makes the project vanish from the picker **and** refuses its hostname
with the same "not running" page a stopped project gets:

- **From the project:** create `.web-chat/no-remote` in it
  (`touch .web-chat/no-remote`). Delete the file to put it back; the portal
  notices within a second. A repository can ship this marker — it only ever
  narrows what you expose.
- **From `tunnel.json`:** list it under `expose.exclude`, by instance id (what
  `tunnel status` prints) or by absolute directory — a directory hides every
  project under it:

  ```json
  "expose": { "exclude": ["0a1b2c3d", "/Users/me/work/client-x"] }
  ```

`claude-web-chat tunnel status` lists hidden projects separately, with which of
the two hid them.

## What a remote viewer sees

The surface looks and works the same, except where an action is host-only. The
**Manage** tab of the ＋ drawer says packs are managed on the host (with the
command) instead of showing the install form, and its Install / Discard /
Remove buttons are disabled; a service waiting for approval says to run
`claude-web-chat trust` on the machine running web-chat, not on the device in
your hand. The page learns it is remote from the daemon's `/api/health`
(`remote: true`), which the portal arranges by adding an `X-WC-Remote: 1`
header to everything it forwards. That is a label for the page, never a
permission — what a remote viewer may do is decided in the portal. It narrows
one thing: a pane can still spawn a saved component remotely, but not a pane of
raw HTML — that would be markup the remote viewer's page wrote, landing in your
surface — so such a spawn is refused (the portal always sets the header and
drops any copy a viewer sends). The ⋯ → **Sessions** panel says to run
`claude-web-chat ls` on the host instead of listing anything: it names every
project on the machine, so it is host-only.

## The remote access log

`~/.web-chat/tunnel/remote-access.log` (0600) gets one JSON line for every
remote request that could change something — every write, and every live-socket
connection — from a signed-in account, whether it was let through or refused:

```json
{"ts":"2026-09-26T08:14:03.120Z","email":"you@gmail.com","instance":"0a1b2c3d","method":"POST","path":"/api/store","status":200}
```

Reads are not logged (a page load is dozens of them), and the path is logged
without its query string. The file is capped at 1 MB: past that it moves to
`remote-access.log.1`, replacing the previous one, and a new file starts.
`claude-web-chat tunnel logs --access` prints it.

## The security model

The portal is **access control**, so every step fails closed:

1. **Host.** Only the picker hostname and project hostnames are answered;
   anything else is refused (421).
2. **Your sign-in, checked locally.** Cloudflare Access puts a signed token on
   every request. The portal verifies it **itself** — it does not trust that
   Cloudflare's check happened: RS256 only (an unsigned token or an HMAC trick is
   refused before any key is touched), signed by a key from your team's
   published set, issued by your team, for your application's AUD, not expired.
   The token must carry an email, and that email must be on the allowlist in
   `tunnel.json` — which no dashboard setting can widen. If the keys cannot be
   fetched at all, requests are refused (503), not waved through. A client
   (the address Cloudflare saw) that fails this check 20 times inside a minute
   is answered 429 for the next minute without being checked at all.
3. **What a remote viewer may reach** is a fixed, default-deny list of daemon
   routes. The surface the browser drives works — panes, the store, forms, the
   graph, comments, the queue and Push, themes, exports as a download. Refused,
   with a hint naming what to run on the host instead: installing or removing
   packs, approving services, saving components from outside, the turn/hook
   internals and Claude's own write paths (`render`, `write_markdown`), the
   machine-wide Sessions list (it names every project on the machine), a pane
   spawning raw HTML, shutting a daemon down, captures from the browser
   extension, setting brand images, writing export files to disk, and wiping
   the graph (unless you opt in with
   `"remote": {"allowDestructive": true}` in `tunnel.json`).
4. **Cross-site requests.** A request that changes anything, and the live socket,
   must come from the project's own page (an exact `Origin` match); requests
   from another site — or another project's hostname, or the picker — are
   refused except a plain link to a project's front page.
5. **Headers.** Only an allowlist of request headers reaches a daemon. Cookies,
   Cloudflare's headers, and the headers a daemon trusts because only local
   programs send them (the capture token, the shutdown header, the MCP-sighting
   headers) never do. Responses are marked no-store, not framable by other
   sites, and no-referrer; the daemon cannot set a cookie through the portal.
6. **Expiry.** The live socket is closed when your sign-in token expires; the
   page reconnects, which needs a fresh one.
7. **The tunnel's own credential** (the connector token) lives in a 0600 file and
   is handed to cloudflared in its environment, never on its command line.
   A local tunnel's generated config also makes cloudflared itself require a
   valid Access token for your AUD, so there are two independent checks.

**Quick tunnels (`trycloudflare.com`) are refused.** They cannot sit behind
Access, so nothing would check who is signing in.

## Residual risk — read this

- **An allowlisted account can act as you.** Through the surface it can drive
  every pane — including panes of service components you trusted, which run
  host code under your user account, and a file editor pane edits files. Pack
  installs and service approval stay host-only, but treat each allowlisted
  address as someone you would hand a shell to. One address, your own, is the
  intended setup; setup warns loudly if you add more.
- **Your Google account becomes a key to this machine.** Use 2-step verification
  on it. Anyone who can sign in as you, can get in.
- **Pane scripts run in your remote browser as they do locally.** A component
  from an untrusted source is untrusted code in either place.
- **Cloudflare sees the traffic** (TLS terminates at its edge). That is how every
  Cloudflare tunnel works.
- **Every running project is listed** to an allowlisted account unless you hid
  it (see *Keeping a project off the tunnel*) — hiding is opt-out, not opt-in.
- **A portal killed with `SIGKILL`** cannot stop its cloudflared; the orphaned
  connector answers visitors with an error until you stop it (`tunnel status`
  shows the portal as down; check for a stray `cloudflared` process).

## Files

| file | what |
| --- | --- |
| `~/.web-chat/tunnel/tunnel.json` | the config (0600) — hostname, style, Access team + AUD, allowlist, the tunnel |
| `~/.web-chat/tunnel/token` | the connector token (0600), token tunnels only |
| `~/.web-chat/tunnel/cloudflared.yml` | the generated ingress, local tunnels only — rewritten on every start |
| `~/.web-chat/tunnel/portal.log`, `cloudflared.log` | what `tunnel logs` prints |
| `~/.web-chat/tunnel/remote-access.log` (+ `.1`) | one line per remote write / socket, 0600, capped at 1 MB |
| `<project>/.web-chat/no-remote` | this project is never served through the tunnel |
