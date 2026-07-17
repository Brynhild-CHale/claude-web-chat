// The forked child harness for a service-backed component. The supervisor
// (lib/server/services.js) forks one of these per running service pane and drives
// it over IPC. This process loads the component's service.js, builds a driver
// bound to the daemon, and runs the service's start(ctx). It never touches the
// graph — a service is a passive store-writer (see docs/driving-the-surface.md).
//
// IPC contract (from the supervisor):
//   { type:'start', servicePath, mountId, name, owner, params, port, webChatDir }
//   { type:'stop' }
// Replies:  { type:'started', mountId }
// Also exits on SIGTERM (the supervisor's fallback kill).

const { createDriver } = require('../driver');
const { lineDiff } = require('./diff');

let svc = null;
let stopping = false;

process.on('message', async (msg) => {
  if (!msg) return;
  if (msg.type === 'start') {
    try {
      // Explicit port → no portfile discovery needed in the child.
      const driver = createDriver({ owner: msg.owner, port: msg.port });
      svc = require(msg.servicePath);
      const ctx = {
        driver,
        params: msg.params || {},
        mountId: msg.mountId,
        name: msg.name,
        log: (...a) => console.log(...a),
        // Reused engines/paths so services never hand-roll or hardcode:
        //   diff(a, b, opts?) → unified line-diff (lib/server/diff.js lineDiff).
        //   webChatDir → the project's .web-chat abs path for sidecar state.
        diff: (a, b, opts) => lineDiff(a, b, opts),
        webChatDir: msg.webChatDir || null,
      };
      if (svc && typeof svc.start === 'function') await svc.start(ctx);
      if (process.send) process.send({ type: 'started', mountId: msg.mountId });
    } catch (e) {
      console.error('service start failed:', e && e.stack ? e.stack : e);
      process.exit(1);
    }
  } else if (msg.type === 'stop') {
    await shutdown();
  }
});

process.on('SIGTERM', () => { shutdown(); });
// If the parent daemon goes away, the IPC channel disconnects — never orphan.
process.on('disconnect', () => { shutdown(); });

async function shutdown() {
  if (stopping) return;
  stopping = true;
  try { if (svc && typeof svc.stop === 'function') await svc.stop(); } catch {}
  process.exit(0);
}
