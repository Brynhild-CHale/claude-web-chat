# Remote access — your surfaces from anywhere

`claude-web-chat tunnel` puts the web-chat surfaces running on this machine
behind a Cloudflare tunnel, so you can open them from your phone or another
computer — signed in through Cloudflare Access (an emailed code plus your
device's biometrics by default, or Google), and only as an account you allowlisted.

Nothing about the local setup changes. Every daemon still binds loopback only;
what the tunnel reaches is a separate process, the **portal**, which checks
every request before it forwards anything to a daemon.

```
browser ──https──▶ Cloudflare Access ──▶ tunnel ──▶ cloudflared ──▶ portal ──▶ daemon
                   (emailed PIN +                   (this machine)  127.0.0.1  127.0.0.1
                    biometrics, or Google;                          :5171      :5173+
                    your email policy)
```

## Quick start — one API token

1. In the Cloudflare dashboard, once: **turn on Zero Trust** (pick a team name,
   Free plan) and **create an API token** with five permissions — Cloudflare
   Tunnel, Access: Apps and Policies, Access: Organizations, Identity Providers,
   and Groups (all Account › Edit), Account Settings (Account › Read) and DNS
   (Zone › Edit). Details below.
2. `brew install cloudflared` (or see *What you need*).
3. On this machine:

   ```sh
   claude-web-chat tunnel setup --api-token-file cf-token.txt \
     --hostname wc.example.com --email you@example.com
   claude-web-chat tunnel up
   ```

4. Open `https://wc.example.com/`, enter the code Cloudflare emails you, then
   Face ID / Touch ID / Windows Hello.

Setup does the rest of the Cloudflare side itself — tunnel, DNS, login method,
Access policy and application — and stops, with nothing changed, rather than
replace a DNS record or a tunnel of yours. Doing it by hand in the dashboard
instead is the *Manual walkthrough* further down. If something stops it, see
*Troubleshooting*.

## Or set it up from the browser — ⌘K

On the surface (on this computer), press ⌘K and choose **Set up remote access…**
(or ⋯ → **Set up remote access…**). A setup page opens in a new tab and walks the
same one-token setup without a terminal:

1. **You need** a domain on Cloudflare and Zero Trust turned on (a link takes you there).
2. **Create an API token** — the page lists the exact permissions and links to
   the token page.
3. **Run setup** — paste the token, enter the picker hostname and your email, pick
   the sign-in (emailed PIN + Face ID / Touch ID, or the PIN alone), and press
   **Show the plan**: the same plan `tunnel setup --dry-run` prints, with nothing
   changed. **Apply** is offered for exactly that input; its progress is the
   lines the CLI prints. A token that sees several Cloudflare accounts gets a
   picker. Google sign-in needs an OAuth client first, so it stays in the
   terminal (`tunnel setup --signin google`).
4. **Bring it up** — the same as `claude-web-chat tunnel up`.
5. **On your phone** — open the picker link and sign in; enrol Face ID when Access offers.

A live checklist at the top ticks itself — setup done, portal running,
connector ready, sign-in, picker — and on a machine already set up it shows that
summary, a *restart needed* warning when there is one, and a hint that running
setup again converges rather than duplicating anything. The terminal commands
are on the page too, with copy buttons, for the manual path.

**Why a new tab, and why its address is `127.0.0.1:<some port>`.** The page takes
the API token that decides where your surfaces are published, and every pane on
the surface runs code in the surface's own origin. So the page is served from a
different origin that no pane can script: a separate listener on `127.0.0.1` at
a port of its own (not the surface's port — the replay renderer draws pane code
under `127.0.0.1:<surface port>`). It serves this page only, answers a setup call
only from its own exact origin carrying the nonce minted into that page load, as
JSON (a cross-origin call must be preflighted, and the preflight is refused with
no CORS allowance), cannot be framed, and closes after 30 idle minutes or when
the surface's daemon stops — an old tab then says it has expired; open it again
from ⌘K. The API token is used for the one step that carries it and is never
logged, stored or shown back. None of this is reachable through the tunnel, and
the menu item is not offered to a remote viewer.

## What you need

- **A domain on Cloudflare** (its DNS managed there). The free plan is enough.
- **Cloudflare Zero Trust**, free plan — that is where the tunnel and the Access
  application live. Your *team name* is the `<team>` in `<team>.cloudflareaccess.com`.
- For the manual path only: a login method in Zero Trust (Google: Settings →
  Authentication → Login methods → Add → Google). The one-token setup adds
  Cloudflare's One-time PIN itself.
- **cloudflared** on this machine, 2024.1.0 or newer. web-chat never installs it:
  - macOS: `brew install cloudflared`
  - Linux: Cloudflare's package repository, https://pkg.cloudflare.com/ (Debian/Ubuntu:
    add the apt source, then `sudo apt install cloudflared`)
  - Windows: inside WSL2, install the **Linux** build in the distro. A Windows
    `cloudflared.exe` cannot reach the portal on WSL's loopback.

## Hostnames

You pick one hostname for the **picker** — the page listing your projects —
for example `wc.example.com`. It shows the same picture as `claude-web-chat ls
--all`, in two sections. **Active**: each running surface (viewers, the active
node, a turn in progress) and whether a Claude Code session is attached (`×N`,
channel on/off, when it last called a tool) — click to open it. **Inactive**:
projects whose surface is stopped. Clicking a stopped project that is **known on
this machine** (its surface has booted here before; `~/.web-chat/projects.json`)
asks *Start <project> on <host>?*, and on confirm the portal starts that
project's daemon — the same detached start `claude-web-chat open` uses — waits
for it to answer, and takes you there. The start names the project by its id
only, never a path; a hidden project (below) is never listed or started; one
start per project per 10 seconds; and every start is a line in the remote access
log. A project that has never run a surface here can only be started on the host
with `claude-web-chat open`. Each row also shows the web-chat release its surface
and its Claude sessions run, with a ⚠ restart hint when they differ (a release
is not a host path, so it is shown remotely). The picker wears the Georgetown Blue theme, light or
dark with your device. Each project then gets its own
hostname, derived from its instance id (eight hex characters, stable per
project directory):

| style | picker | a project | certificate |
| --- | --- | --- | --- |
| **flat** (default) | `wc.example.com` | `wc-0a1b2c3d.example.com` | covered by the free Universal SSL certificate (`*.example.com`) |
| nested | `wc.example.com` | `0a1b2c3d.wc.example.com` | needs a certificate for `*.wc.example.com` (Advanced Certificate Manager) |

Each project on its own hostname means each is its own browser origin: a page
in one project cannot read another's.

## One-token setup (recommended)

`tunnel setup` can do the whole Cloudflare side itself from one API token. What
you do in the dashboard, once:

1. **Turn on Zero Trust** (https://one.dash.cloudflare.com): pick a team name
   and the Free plan. That is all — no login method, tunnel or application.
2. **Create an API token** (https://dash.cloudflare.com/profile/api-tokens →
   Create Token → Create Custom Token) with these permissions:

   | | permission | newer dashboards call it |
   | --- | --- | --- |
   | Account | Account Settings — Read | |
   | Account | Cloudflare Tunnel — Edit | Cloudflare One Connector: cloudflared — Edit |
   | Account | Access: Apps and Policies — Edit | … — Write |
   | Account | Access: Organizations, Identity Providers, and Groups — Edit | … — Write |
   | Zone | DNS — Edit | DNS — Write |

   Account Resources: your account. Zone Resources: the zone your hostname is in.

   Cloudflare has been renaming these; the form shows one name or the other.
   **Account Settings — Read** is the only read-only one: it lets the token list
   its account. Without it Cloudflare answers that list *empty* (not with an
   error), so setup finds the account through the zone your hostname is in, or
   takes `--account <id>` (dashboard → Account home → ⋯ → Copy account ID)
   directly — it works either way, the permission just makes it the plain path.

Then, on this machine:

```sh
claude-web-chat tunnel setup --api-token-file ~/Downloads/cf-token.txt \
  --hostname wc.example.com --email you@example.com
# or just `claude-web-chat tunnel setup` and paste the token when asked
claude-web-chat tunnel up
```

A pasted token is **shown as you paste it** — the terminal prompt does not hide
what you type — and stays in the scrollback. Where the screen is shared or
recorded, prefer `--api-token-file` (and delete the file afterwards). The same
goes for the connector token and the Google client secret when setup asks for
them.

Setup reads your account first, prints its plan, and only then changes
anything. It creates — or finds, so a re-run changes nothing — a remotely
managed tunnel named `web-chat` (`--name` for another), routed to the portal
(`wc.example.com` and `*.example.com` → `http://127.0.0.1:5171`; a route you
added to that tunnel yourself is kept); proxied DNS records for those two names;
Cloudflare's **One-time PIN** login method; an Access allow policy for your
email(s); and a self-hosted Access application covering `wc.example.com` and
`wc-*.example.com` with a 30-day session (`--session`). It reads back the team
name and the application's AUD tag, writes `tunnel.json` and the connector token
(0600) as the manual path does, and **does not keep the API token** — delete it
in the dashboard afterwards if you like. `--dry-run` prints the plan and changes
nothing.

It stops, with nothing changed and the reason printed, when a DNS record
already sits on one of those names (it never replaces a record you made), when a
tunnel of that name exists but is managed from a local config file, or when an
Access application of another type already covers the hostname. A refusal from
Cloudflare that means the token lacks a permission names the permission, under
both its names.

In the default flat style the wildcard DNS record sits on the zone apex
(`*.example.com`), and the plan says so with one `⚠` line: it catches every
subdomain of the zone you have not defined yourself. The portal refuses any
hostname that is not a web-chat one (421), but those requests still reach this
machine. That is a warning, not a stop — `--style nested` (which needs its own
certificate, see *Hostnames*) or a domain of its own avoids it.

**How you sign in.** By default: the emailed one-time PIN, **then Face ID /
Touch ID / Windows Hello** (or a security key) — Cloudflare Access *independent
MFA*. Setup turns independent MFA on for your Zero Trust organization if it is
off (without requiring it for any other application) and requires it on this
application, remembered for 30 days (`--mfa-session`). After the emailed code,
Access asks for the second factor; register your device's biometrics when it
offers to, or beforehand in the App Launcher at `https://<team>.cloudflareaccess.com`.
To turn it on, setup reads the organization and writes it back whole with only
the MFA settings changed — the organization endpoint replaces everything it is
sent, so nothing else of yours is lost. If Cloudflare still refuses the
organization, setup asks for MFA on the web-chat application alone (the least
invasive place for it; it works when independent MFA is already on for the
organization in the dashboard) and says so. If Cloudflare will not take it
there either, setup falls back to the emailed PIN alone, with the long session,
and gives both reasons. The result is
recorded in `tunnel.json` as `"signin": "pin+biometric"`, `"pin"` or `"google"`.

- `--signin pin` — the emailed PIN alone, on purpose.
- `--signin google` — Google login instead. Setup prints the Google Cloud steps
  with your values filled in (Authorized JavaScript origin
  `https://<team>.cloudflareaccess.com`, Authorized redirect URI
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`), then asks for
  the OAuth Client ID and secret (`--google-client-id`,
  `--google-client-secret-file`) and creates the Google login method. A passkey
  on that Google account is Google's own setting (Google Account → Security →
  Passkeys), not something setup or Cloudflare configures.

A token that sees more than one account asks which (or `--account <id>`).

**Running it again is safe.** Every step finds what is already there before it
creates anything, so a second run — to add an `--email`, to switch `--signin`,
or to finish a run that stopped half way — changes only what differs and never
makes a second tunnel, record, policy or application. The application keeps its
AUD tag, so `tunnel.json` stays valid.

## Manual walkthrough

The same result, by hand in the dashboard.

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
   put it in your shell history — only a file to read it from, or a paste (which
   the terminal shows as you paste it, so prefer the file on a shared screen).
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
   pick a project. A running one opens; a stopped one this machine already
   knows is started after you confirm. A project that has never run here is
   started on this machine with `claude-web-chat open`.

## Troubleshooting

**One-token setup.** Setup reads everything before it writes anything, so a run
that stops at a read has changed nothing; just fix the cause and run it again.

| setup says | what to do |
| --- | --- |
| `Cloudflare did not accept the API token` | Paste the whole token (it is shown once, when you create it). It must be an **API token**, not the Global API Key and not a tunnel's connector token, and not expired or rolled. |
| `the API token is missing a permission: …` | Edit the token in the dashboard (My Profile → API Tokens → ⋯ → Edit), add the permission it names, save, and run setup again with the same token. Your form may show the newer name the message gives in brackets — a refused `POST …/cfd_tunnel` with `Authentication error (10000)` is Cloudflare Tunnel — Edit, listed in newer dashboards as *Cloudflare One Connector: cloudflared — Edit*. |
| `the API token can see no Cloudflare account` | The token can neither list accounts nor see a zone. Add **Account Settings — Read**, or pass `--account <id>`; and check its Account and Zone Resources include your account and zone. |
| `the API token cannot reach account "…"` | The `--account` id is wrong or outside the token's Account Resources. The message lists the accounts it does see. |
| `no zone on account "…" holds wc.example.com` | The domain is not on this Cloudflare account, or the token's **Zone Resources** leave that zone out. |
| `Zero Trust is not turned on for this account yet` | Open https://one.dash.cloudflare.com once, pick a team name and the Free plan. |
| `the token sees 2 accounts — pick one with --account` | Pass `--account <id>` (the ids are in the message), or run setup in a terminal and pick. |
| `setup stopped before changing anything: a conflict` | Each `✗` line above it says what is in the way. A **DNS record** on the picker or the wildcard name: delete it (DNS → Records) or choose another `--hostname` — setup never replaces a record you made. A **tunnel of that name managed from a config file**: `--name <other>`, or keep that tunnel on the manual path (`--kind local`). An **Access application of another type** on the hostname: remove it or choose another hostname. `--dry-run` shows the same list without the rest of the run. |
| `rate limited (HTTP 429)` | Cloudflare throttled the token. Setup already waited and retried; wait a minute and run it again. |
| `Cloudflare API … (HTTP 5xx)` or a network error part way | Run setup again: it picks up from what the first run made. |
| `Authentication error (10000)` on a write (e.g. `POST …/cfd_tunnel`) | The token is missing the permission that write needs; setup names it (above). Nothing after the refused write was made — add the permission and run setup again. |
| `access.api.error.invalid_org_config (12062)` on `PUT …/access/organizations` | Cloudflare refused the organization body that turns independent MFA on. Setup sends the organization back whole, without its read-only fields (`created_at`, `updated_at`) or unset (`""`) ones — the likely causes — and, if it is still refused, asks for MFA on the web-chat application alone. If the result is `required on this application only`, you have the PIN + biometrics already. To have it for the organization, turn on independent MFA once in the Zero Trust dashboard (its Access settings, "Independent MFA") and run setup again: it keeps what is on. |
| `Sign-in: emailed one-time PIN + biometrics (independent MFA) — required on this application only; …` | The organization refused independent MFA (the reason follows), but the web-chat application took it: sign-in is PIN + biometrics for this application, and your other Access apps are unchanged. A re-run tries the organization again. |
| `Sign-in: emailed one-time PIN — Cloudflare would not turn on independent MFA …` | Both the organization and the application refused independent MFA (the message gives both reasons); you have the emailed PIN with a long session instead. Once it can be had (your plan gains it, or you turn it on for the organization in the dashboard), run setup again — it turns it on and upgrades the same application in place, creating nothing (`--signin pin` asks for the PIN alone on purpose). |
| `the Access signing keys for team "…" did not answer yet` | A brand-new Zero Trust organization can take a minute to publish them. `tunnel up` works once they answer. |

**Signing in.**

- *No code arrives.* Cloudflare only emails a code to an address the Access
  policy allows — use exactly the `--email` you gave setup, and check spam.
- *No biometric prompt.* Access asks for the second factor after the emailed
  code; if your device offers no registration there, register Face ID / Touch ID
  / Windows Hello (or a security key) in the App Launcher,
  `https://<team>.cloudflareaccess.com`, then sign in again.
- *"this account is not allowed to reach this machine's surfaces"* (403). You
  signed in to Cloudflare as an address that is not on `tunnel.json`'s
  allowlist. The portal checks its own list, not the dashboard's policy; add it
  with `tunnel setup --email …` (or edit `allow.emails`).
- *"sign in through Cloudflare Access"* (401). The request reached the portal
  without an Access token — typically a hostname that is not covered by the
  Access application. `tunnel status` lists the hostnames it expects.

**The tunnel.** `claude-web-chat tunnel status` says whether the connector is
ready; `claude-web-chat tunnel logs --cloudflared` shows why not. `tunnel up`
refuses, with the reason, when something would make the tunnel unsafe or broken
(see *Manual walkthrough*, step 5).

## Commands

```
tunnel setup       with an API token (--api-token-file, or paste): create the
                   tunnel, DNS and Access app, then write config (--dry-run: plan only)
                   manual (--team/--aud/--kind): ask for (or take as flags) the
                   hostname, style, Access team, AUD tag, allowed email(s) and
                   the tunnel; verify; write config
                   (an existing tunnel.json it cannot read is moved aside to
                   tunnel.json.corrupt-<time> and named, never overwritten)
tunnel up          preflight, then start the portal (port 5171 —
                   WEB_CHAT_PORTAL_PORT to move it) which runs cloudflared;
                   a portal left running by an older build, or enforcing an
                   older tunnel.json, is restarted
tunnel down        stop the portal; cloudflared stops with it (waits until
                   both have exited; a connector of that portal's still
                   running after 10s is stopped too)
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
reboot. `claude-web-chat update` (and `update --to <version>`) restarts a
running portal on the build it just activated, so that build's remote policy is
in force at once; it prints one line saying so, and remote viewers reconnect.
If that restart fails — a `tunnel.json` or token `up` would refuse, say — it says
so, the update itself still succeeds, and `claude-web-chat tunnel up` is the fix.
With no portal running, `update` leaves the tunnel alone. (`up` also restarts a
portal it finds from an older build.) A rollback to a build with no `tunnel`
command (0.7.6) cannot restart it, and could not stop it afterwards either, so
`update --to` stops the portal first, with the running build's `tunnel down`, and
says remote access is off until a build that has the command is back; if the
portal will not stop, nothing is rolled back.

**The portal follows `tunnel.json` while it runs.** It watches the file (and
polls it every two seconds, in case the watch misses a save) and applies a
valid edit at once:

- `allow` — an email added gets in on its next request; an email **revoked**
  is refused on its next request, and any live socket it has open is closed
  within a second (code 4403 — the page's reconnect then meets the refusal).
- `access` (team, AUD), `expose.exclude`, `remote.allowDestructive`,
  `showRoots` — in force from the next request; a newly excluded project's
  open sockets are closed the same way, and a new team or AUD — how you revoke
  every outstanding sign-in — closes every open socket at once (code 4401,
  *sign in again*), so each reconnect meets the new check.
- `hostname`, `style`, `tunnel` — **not** applied live: they name what
  cloudflared routes, so they need a new connector. The portal keeps serving
  the hostnames it started with (the rest of the same edit still applies), its
  log says `restart needed`, and `tunnel status` says which sections changed
  and to run `claude-web-chat tunnel up`, which restarts it.

**A broken `tunnel.json` fails closed.** If the file goes missing, stops
parsing, or no longer validates (an empty allowlist, say), the portal does not
keep the last good copy: it answers every request except its own loopback
health check with 503, closes every live socket (code 4503), and logs
`FAILING CLOSED` with the reason; `tunnel status` says so too. Fix the file and
the portal resumes within seconds, on its own. (`tunnel setup` over an
unreadable file still moves it aside and writes a fresh one.)

The connector token (`~/.web-chat/tunnel/token`) is watched too, but never
applied live: it is cloudflared's credential, handed over when the connector
starts. When the file holds a different token (a re-run `tunnel setup`) or
none, the portal logs `restart needed`, its health reports it, and `tunnel
status` says **restart needed (connector token changed)**; `claude-web-chat
tunnel up` restarts the portal and cloudflared on the token in the file. (The
per-project `no-remote` marker is read live too, see below.)

## Keeping a project off the tunnel

Every running project is reachable by default. Two ways to take one off —
either makes the project vanish from the picker **and** refuses its hostname
with the same "not running" page a stopped project gets:

- **From the project:** create `.web-chat/no-remote` in it
  (`touch .web-chat/no-remote`). Delete the file to put it back; the portal
  notices within a second — including a viewer who already has the surface
  open: their live socket is closed (code 4403) and reconnecting finds nothing.
  A repository can ship this marker — it only ever narrows what you expose.
- **From `tunnel.json`:** list it under `expose.exclude`, by instance id (what
  `tunnel status` prints) or by absolute directory — a directory hides every
  project under it:

  ```json
  "expose": { "exclude": ["0a1b2c3d", "/Users/me/work/client-x"] }
  ```

  The running portal picks the edit up within a couple of seconds (see *The
  portal follows `tunnel.json` while it runs*) and closes any open socket into
  a project it now hides. No restart needed.

`claude-web-chat tunnel status` lists hidden projects separately, with which of
the two hid them.

`claude-web-chat off` is **not** a third way. It silences web-chat's hooks and
tools in the project, but the project stays on the picker — and one that has
booted here before can still be started from it. To keep a project off the
tunnel, use `no-remote`.

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
drops any copy a viewer sends). Adding a block from the ＋ drawer works, but
the page cannot use it to declare a wake signal or take a pane over: `signals`
in its params are stripped and `force` is ignored, from any browser, remote or
not. A Push made remotely is marked
`origin=remote` (and `device=mobile` from a phone) in what Claude receives, so
it answers on the surface rather than asking you to run a command — see
[channels-dev](channels-dev.md), "Push provenance". A replay Claude opens for
you (`export` with `open: true`) opens in every browser watching the surface,
a remote viewer's phone included. The player plays as it does locally, but its
**↧ GIF**, **↧ MP4** and **↧ WebM** are disabled up front, with the reason: a
render starts Chrome and ffmpeg on the host, which a remote viewer may not. The ⋯ → **Sessions** panel says to run
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
   graph, comments, the queue and Push, picking and applying a theme, exports as
   a download, the replay player. Refused, with a hint naming what to run on the
   host instead: installing or removing packs, approving services, saving
   components or themes from outside (a saved theme's raw CSS reaches the
   chrome, and a system default reaches every project), the turn/hook
   internals and Claude's own write paths (`render`, `write_markdown`), the
   machine-wide Sessions list (it names every project on the machine), a pane
   spawning raw HTML, shutting a daemon down, captures from the browser
   extension, setting brand images, writing export files to disk, rendering a
   replay to a GIF or video, wiping the graph or starting a new one (unless you
   opt in with `"remote": {"allowDestructive": true}` in `tunnel.json`), and
   clearing the whole page at once — a remote viewer closes panes one at a
   time (×).
4. **Cross-site requests.** A request that changes anything, and the live socket,
   must come from the project's own page (an exact `Origin` match); requests
   from another site — or another project's hostname, or the picker — are
   refused except a plain link to a project's front page.
5. **Headers.** Only an allowlist of request headers reaches a daemon. Cookies,
   Cloudflare's headers, and the headers a daemon trusts because only local
   programs send them (the capture token, the shutdown header, the MCP-sighting
   headers) never do. API responses and the framed documents (node and pane
   previews, the replay player) are marked no-store; nothing is framable by
   other sites, and everything is no-referrer; the daemon cannot set a cookie
   through the portal. The few readable routes that would name where things
   live on the host — the service-approval list, the pack listings, the replay
   capabilities — answer a remote viewer with the project root as `<project>`,
   your home as `~`, and only *whether* Chrome and ffmpeg are installed.
6. **The project behind the hostname.** A registry entry names a port, and a
   port is not a project: a stopped project's port is the first one the next
   daemon takes. So before it proxies a request or relays a socket, the portal
   asks the daemon on that port for its `/api/health` and goes on only if it
   answers as the entry's own process — asked afresh for every socket,
   remembered for a second for plain requests. Anything else is answered as a
   stopped project; a daemon that does not answer within 5 seconds gets a 502.
7. **Expiry and hiding.** The live socket is closed when your sign-in token
   expires or `tunnel.json`'s Access team or AUD changes (code 4401) — the page
   reconnects, which needs a token the current check accepts — and when its
   project is hidden or stops (code 4403).
8. **Setting up is the host's.** The ⌘K setup page (*Or set it up from the
   browser*) runs on its own loopback origin, refuses any call that is not from
   that page with its per-load nonce, and is refused through the tunnel; no
   pane can reach it.
9. **The tunnel's own credential** (the connector token) lives in a 0600 file and
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
- **Your sign-in becomes a key to this machine.** With the default sign-in that
  is your email inbox plus your device's biometrics (or, if independent MFA was
  refused, your inbox alone — protect it); with `--signin google`, your Google
  account — use 2-step verification or a passkey on it. Anyone who can sign in as
  you, can get in.
- **Pane scripts run in your remote browser as they do locally.** A component
  from an untrusted source is untrusted code in either place.
- **Cloudflare sees the traffic** (TLS terminates at its edge). That is how every
  Cloudflare tunnel works.
- **Every project that has run here is listed** to an allowlisted account —
  running ones to open, stopped ones to start — unless you hid it (see *Keeping
  a project off the tunnel*). Hiding is opt-out, not opt-in, and switching
  web-chat off in a project (`claude-web-chat off`) does not hide it.
- **A portal killed with `SIGKILL`** cannot stop its cloudflared; the orphaned
  connector answers visitors with an error until something stops it. The next
  `tunnel up` does: the portal records its connector's pid, and a new portal
  stops one whose portal is gone (after checking it is still that cloudflared).
  A connector it has no record of (one from before this was recorded) is not
  signalled — `tunnel up` refuses while it holds the metrics port and says how
  to find it.

## Files

| file | what |
| --- | --- |
| `~/.web-chat/tunnel/tunnel.json` | the config (0600) — hostname, style, Access team + AUD, allowlist, the tunnel, and the sign-in the one-token setup configured |
| `~/.web-chat/tunnel/token` | the connector token (0600), token tunnels only |
| `~/.web-chat/tunnel/cloudflared.yml` | the generated ingress, local tunnels only — rewritten on every start |
| `~/.web-chat/tunnel/portal.log`, `cloudflared.log` | what `tunnel logs` prints |
| `~/.web-chat/tunnel/cloudflared.pid.json` | the connector the portal runs — how the next portal recognises one a killed portal left behind |
| `~/.web-chat/tunnel/remote-access.log` (+ `.1`) | one line per remote write / socket, 0600, capped at 1 MB |
| `~/.web-chat/projects.json` | every project whose surface has booted on this machine — the picker's Inactive list, and the only projects it can start |
| `<project>/.web-chat/no-remote` | this project is never served through the tunnel |
