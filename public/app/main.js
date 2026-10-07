// Bootstrap. Module scripts are deferred, so the DOM is parsed and
// window.__wcMount (mount-runtime.js, a classic script) is present by the time
// this runs. Init the subsystems, then connect the socket LAST so every WS
// handler's dependencies already exist.
import './store.js'; // establishes the store singleton + window.store
import { view } from './state.js';
import { initMode } from './theme.js';
import { initTopbar } from './topbar.js';
import { initGraph, forwardEscapeFrom } from './graph-view.js';
import { initGraphLog } from './graph-log.js';
import { initViewport } from './viewport.js';
import { initDrawer } from './drawer.js';
import { initComments } from './comments.js';
import { initShell } from './shell.js';
import { initVersion } from './version.js';
import { initBrand } from './brand.js';
import { initProject } from './project.js';
import { initCobrand } from './cobrand.js';
import { initPaneHistory } from './pane-history.js';
import { initChatState } from './chat-state.js';
import { initChatBar } from './chat-bar.js';
import { initChatDock } from './chat-dock.js';
import { initChatPanel } from './chat-panel.js';
import { initChatStream } from './chat-stream.js';
import { initChatTools } from './chat-tools.js';
import { initFavicon } from './favicon.js';
import { initPullStub } from './chat-pull-stub.js';
import { initChatTrays } from './chat-trays.js';
import { initChatDetail } from './chat-detail.js';
import { initGraphTurns } from './graph-turns.js';
import { initAsks } from './asks.js';
import { initChatComposer } from './chat-composer.js';
import { initSessionControl } from './session-control.js';
import { initTurnActions } from './turn-actions.js';
import { connect, onFrame, onHello } from './ws.js';

initMode();       // Earthy light (default) / dark before first paint
initViewport();   // <html class="phone"> before anything mounts (panes read it)
initTopbar();
initGraph();
initGraphLog();   // the phone's graph screen: a log with a computed fork gutter
initDrawer();
initComments();
initShell();
initVersion();    // update-available banner; re-checked on every WS (re)connect
initBrand();      // Settings → Brand drop targets; the slots the lockup draws
// The project's identity: its `project` frame, and a re-read after every
// hello. project.js is the tab title's one writer — the project's name and
// nothing else (spec §9.4, ruling N1).
initProject({ onFrame, onHello });
initCobrand();    // the topbar's co-brand lockup: the theme's company image │ the project
initPaneHistory({ forwardEscapeFrom }); // a block's ◷ history popover (Make current)
// The chat mirror: its one store (the mirror:* frames, and GET /api/mirror after
// every hello), then what draws from it — the desktop status bar; the chat
// itself (the dock it opens in, the panel inside it, the stream of turns and
// the tool cards the stream draws with); the tab's icon, which reads the
// project's identity and the mirror's waiting state, so it comes after both;
// and, on a phone, the grip tab's "Under development" stand-in until the real
// pull lands. Each init is idempotent.
initChatState({ onFrame, onHello, conn: view.conn });
initChatBar();
initChatDock();   // the desktop drawer / window: chat:open shows it
initChatPanel();  // header, state strip, meta line, awaiting card, #chat-stream
initChatStream(); // the turns, grouped, rewind-aware
initChatTools();  // the tool cards (setToolRenderer)
initFavicon();    // the tab icon (light and dark) and its waiting badge
initPullStub();
// Tranche 3, after the chat above and after initGraph: the bar's chips and
// their trays (shells, monitors, agents, workflows, the queue — they take over
// the bar's stand-in chips), the detail views the chat pushes (a task's output,
// an agent followed live, a workflow, a turn's code changes: View changes),
// and a node's turns and rewind marks in the graph inspector. Each idempotent.
initChatTrays();
initChatDetail();
initGraphTurns();
// Tranche 4, after the chat, its trays and the graph's turns: the asks (the
// answer frames on the answer origin; registering the approvals retires the
// bar's and the card's "answering … is under development" stand-ins once the
// first answer-surface port is known), the composer (it takes over the
// panel's note; after initChatStream), the Stop control on the bar and the
// panel (control frames, after initAsks), and the turn actions — Restore
// files and Fork from here (after initSessionControl, whose frames they
// mount). Each idempotent; the composer's promise is fire-and-forget.
initAsks({ onFrame, onHello });
initChatComposer();
initSessionControl();
initTurnActions();
connect();
