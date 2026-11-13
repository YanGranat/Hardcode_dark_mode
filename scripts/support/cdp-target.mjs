export function createTargetTransport(cdp, { sessionId, targetId, timeout = 10000 }) {
  if (typeof sessionId !== "string" || !sessionId || typeof targetId !== "string" || !targetId ||
      !Number.isFinite(timeout) || timeout <= 0) throw Error("Invalid CDP target configuration");
  let nextId = 0, closed = null;
  const pending = new Map();
  const listeners = [
    ["Target.receivedMessageFromTarget", receive],
    ["Target.detachedFromTarget", event => { if (event.sessionId === sessionId) dispose(Error("CDP target detached")); }],
    ["Target.targetDestroyed", event => { if (event.targetId === targetId) dispose(Error("CDP target closed")); }],
    ["close", () => dispose(Error("CDP connection closed"))]
  ];
  for (const [event, listener] of listeners) cdp.on(event, listener);
  function finish(id, error, reply) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id); clearTimeout(request.timer);
    if (error) request.reject(error); else request.resolve(reply);
  }
  function dispose(error = Error("CDP target transport disposed")) {
    if (closed) return;
    closed = error instanceof Error ? error : Error(String(error));
    for (const [event, listener] of listeners) cdp.off(event, listener);
    for (const id of pending.keys()) finish(id, closed);
  }
  function receive(event) {
    if (event.sessionId !== sessionId) return;
    let reply;
    try { reply = JSON.parse(event.message); }
    catch { dispose(Error("Invalid CDP target response")); return; }
    if (!reply || typeof reply !== "object" || !pending.has(reply.id)) return;
    finish(reply.id, reply.error ? Error(`CDP command failed: ${reply.error.message || "Protocol error"}`) : null, reply);
  }
  function command(method, params) {
    if (closed) return Promise.reject(closed);
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const message = JSON.stringify({ id, method, params });
      const timer = setTimeout(() => dispose(Error(`CDP command timed out: ${method}`)), timeout);
      pending.set(id, { resolve, reject, timer });
      try {
        Promise.resolve(cdp.send("Target.sendMessageToTarget", { sessionId, message })).catch(dispose);
      } catch (error) { dispose(error); }
    });
  }
  return { command, dispose };
}
