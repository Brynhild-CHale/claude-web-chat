# claude-web-chat

A live page in your browser that Claude Code draws on while you talk in the terminal. Diagrams, forms, comparisons, and working mockups land on the page and stay interactive, with short headings and prose between them so a page reads top to bottom. What you click and type there flows back to Claude as data, and every turn becomes a node in a graph you can walk back through and branch.

![One web-chat cycle: Claude renders a question on the surface, the user answers in the page, and the answer flows back to Claude](.github/media/flow.gif)

## Quickstart

You'll need **Node 22+** and **Claude Code**, on **macOS or Linux** (on Windows, use WSL2 — see [platform support](docs/platform-support.md)).

**1. Install.** No npm, no sudo. The release is checksum-verified and unpacked under `~/.web-chat/`, with the command linked into `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/Brynhild-CHale/claude-web-chat/main/install.sh | sh
```

**2. Set up a project.** web-chat is opt-in per project. `init` lists what it will write, asks once, and installs:

```sh
cd ~/Dev/my-project
claude-web-chat init
```

**3. Restart Claude Code** in that project, and approve the new `web-chat` MCP server when it asks.

**4. Open the surface:**

```sh
claude-web-chat open
```

**5. Start.** In Claude Code, type `/web-chat` for a guided first pane, or just ask:

> Sketch this project's architecture as a diagram on the surface.

## History is a graph

Every turn that changes the surface is saved as a node. Preview any earlier state (read-only), set it active on the graph screen, and your next message branches from there, so trying a different direction never loses the first one. Replay plays a stretch of history forward node by node, and exports it as an offline page, a GIF or (with ffmpeg) a video.

![The graph viewer: every turn is a node, and earlier states can be previewed and branched from](.github/media/graph.gif)

## Components

Claude saves panes worth keeping to the project's component library and reuses them. Component packs install a whole set at once, plus a skill that tells Claude when to use them. Install one from the topbar's **＋ → Manage**, or from the terminal:

```sh
claude-web-chat pack get https://github.com/acme/ops-pack    # download and review first; installs nothing
```

![Installing a component pack from a GitHub URL through the topbar's ＋ → Manage panel](.github/media/component-install.gif)

## Documentation

| | |
| --- | --- |
| [Using web-chat](docs/guide.md) | everyday use, service components and `trust`, packs, channels, the browser extension, the command line, security, troubleshooting |
| [Installing and updating](docs/install.md) | what `install.sh` and `init` do, updates and rollback, turning it off, what it writes to your machine |
| [Component packs](docs/component-packs.md) · [Service components](docs/service-components.md) | building and shipping your own components |
| [Channels](docs/channels-dev.md) · [Driving the surface](docs/driving-the-surface.md) · [Exporting pages](docs/export-pages.md) | the wake path, external processes, self-contained `.html` exports and replays |
| [Themes](docs/themes.md) | the builtin packs (Earthy, Paper, Georgetown Blue), light and dark modes, the design tokens, brand images |
| [Remote access](docs/remote-access.md) | `claude-web-chat tunnel`: your surfaces from a phone or another computer, behind Cloudflare Access |
| [Capture profiles](docs/capture-profiles-and-panes.md) | how the browser extension distils a captured page, and the pane it lands in |
| [Platform support](docs/platform-support.md) | macOS, Linux, and WSL2 |
| [Contributing](docs/extending.md) | development setup and architecture (also [`CLAUDE.md`](CLAUDE.md)); run the tests with `npm test` |

Every doc is also readable from the terminal with `claude-web-chat docs <name>`.

## License

[MIT](LICENSE). See [`CHANGELOG.md`](CHANGELOG.md) for what's landed.
