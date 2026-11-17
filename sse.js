// Slow consumers reconnect and receive a fresh snapshot; never queue more frames.
const connections = new WeakMap();
const blocked = new WeakMap();
function clearBackpressure(response) {
  const pending = blocked.get(response);
  if (!pending) return;
  clearTimeout(pending.timer);
  response.off('drain', pending.drained);
  blocked.delete(response);
}
function destroyEvents(response) {
  clearBackpressure(response);
  connections.get(response)?.();
  response.destroy();
}
export function closeEvents(response) {
  clearBackpressure(response);
  connections.get(response)?.();
  if (!response.destroyed && !response.writableEnded) {
    try { response.end(); } catch { response.destroy(); }
  }
}
export function writeEvent(response, frame) {
  if (response.destroyed || response.writableEnded) { closeEvents(response); return false; }
  if (blocked.has(response)) { destroyEvents(response); return false; }
  try {
    if (!response.write(frame)) {
      // A large frame can exceed the high-water mark even on a healthy socket.
      // Allow that single frame to drain, but never append another while blocked.
      const drained = () => clearBackpressure(response);
      const timer = setTimeout(() => destroyEvents(response), 15000);
      timer.unref?.();
      blocked.set(response, { drained, timer });
      response.once('drain', drained);
    }
    return true;
  } catch {
    destroyEvents(response);
    return false;
  }
}
export function openEvents(runtime, response, valid, interval = 10000) {
  let timer;
  const cleanup = () => {
    clearBackpressure(response);
    clearInterval(timer);
    runtime.clients.delete(response);
    connections.delete(response);
    response.off('close', cleanup);
    response.off('finish', cleanup);
  };
  connections.set(response, cleanup);
  // Keep the error handler after finish/close: write errors can arrive next tick.
  response.on('error', () => { cleanup(); response.destroy(); });
  response.once('close', cleanup);
  response.once('finish', cleanup);
  runtime.clients.set(response, valid);
  timer = setInterval(() => {
    if (!valid()) { writeEvent(response, 'event: revoked\ndata: {}\n\n'); closeEvents(response); return; }
    writeEvent(response, 'event: heartbeat\ndata: {}\n\n');
  }, interval);
  timer.unref?.();
  try {
    if (!valid()) { closeEvents(response); return; }
    writeEvent(response, `retry: 3000\ndata: ${JSON.stringify(runtime.snapshot(response.workspaceRole))}\n\n`);
  } catch (error) { closeEvents(response); throw error; }
}
