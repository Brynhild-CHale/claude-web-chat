// Bootstrap. Module scripts are deferred, so the DOM is parsed and
// window.__wcMount (mount-runtime.js, a classic script) is present by the time
// this runs. Init the subsystems, then connect the socket LAST so every WS
// handler's dependencies already exist.
import './store.js'; // establishes the store singleton + window.store
import { initMode } from './theme.js';
import { initTopbar } from './topbar.js';
import { initGraph } from './graph-view.js';
import { initGraphLog } from './graph-log.js';
import { initViewport } from './viewport.js';
import { initDrawer } from './drawer.js';
import { initComments } from './comments.js';
import { initShell } from './shell.js';
import { initVersion } from './version.js';
import { initBrand } from './brand.js';
import { initPaneHistory } from './pane-history.js';
import { connect } from './ws.js';

initMode();       // Earthy light (default) / dark before first paint
initViewport();   // <html class="phone"> before anything mounts (panes read it)
initTopbar();
initGraph();
initGraphLog();   // the phone's graph screen: a log with a computed fork gutter
initDrawer();
initComments();
initShell();
initVersion();    // update-available banner; re-checked on every WS (re)connect
initBrand();      // topbar logotype + Settings → Brand drop targets
initPaneHistory(); // a block's ◷ history popover (Make current)
connect();
