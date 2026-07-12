// Bootstrap. Module scripts are deferred, so the DOM is parsed and
// window.__wcMount (mount-runtime.js, a classic script) is present by the time
// this runs. Init the subsystems, then connect the socket LAST so every WS
// handler's dependencies already exist.
import './store.js'; // establishes the store singleton + window.store
import { initMode } from './theme.js';
import { initTopbar } from './topbar.js';
import { initGraph } from './graph-view.js';
import { initDrawer } from './drawer.js';
import { initComments } from './comments.js';
import { initShell } from './shell.js';
import { connect } from './ws.js';

initMode();       // Earthy dark/light before first paint
initTopbar();
initGraph();
initDrawer();
initComments();
initShell();
connect();
