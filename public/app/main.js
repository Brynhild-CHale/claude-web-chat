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
import { initPullStub } from './chat-pull-stub.js';
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
// every hello), then what draws from it — the desktop status bar and, on a
// phone, the grip tab's "Under development" stand-in until the real pull lands.
initChatState({ onFrame, onHello, conn: view.conn });
initChatBar();
initPullStub();
connect();
