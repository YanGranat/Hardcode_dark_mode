import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createTargetTransport } from "../support/cdp-target.mjs";

function fixture(t, timeout = 1000) {
  const cdp = new EventEmitter(), sent = [];
  cdp.send = async (method, params) => { sent.push({ method, ...params }); };
  const transport = createTargetTransport(cdp, { sessionId: "session-a", targetId: "target-a", timeout });
  t.after(() => transport.dispose());
  const reply = (id, result, sessionId = "session-a") => cdp.emit("Target.receivedMessageFromTarget", {
    sessionId, message: JSON.stringify({ id, result })
  });
  return { cdp, sent, ...transport, reply };
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise.then(value => ({ state: "resolved", value }), error => ({ state: "rejected", error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ state: "pending" }), 150); })
    ]);
  } finally { clearTimeout(timer); }
}

test("target replies are correlated by session and request while events and late replies are ignored", async t => {
  const h = fixture(t);
  const first = h.command("Runtime.evaluate", { expression: "1" }), second = h.command("Page.getLayoutMetrics");
  assert.deepEqual(h.sent.map(message => message.method), ["Target.sendMessageToTarget", "Target.sendMessageToTarget"]);
  assert.deepEqual(h.sent.map(message => JSON.parse(message.message).id), [1, 2]);
  h.reply(1, { wrong: true }, "session-b");
  h.cdp.emit("Target.detachedFromTarget", { sessionId: "session-b" });
  h.cdp.emit("Target.targetDestroyed", { targetId: "target-b" });
  h.cdp.emit("Target.receivedMessageFromTarget", { sessionId: "session-a", message: JSON.stringify({ method: "Page.loadEventFired" }) });
  h.reply(99, {}); h.reply(2, { width: 320 }); h.reply(1, { value: 1 });
  assert.deepEqual(await first, { id: 1, result: { value: 1 } });
  assert.deepEqual(await second, { id: 2, result: { width: 320 } });
  h.reply(1, { stale: true });
  const third = h.command("Page.getLayoutMetrics"); h.reply(3, { width: 640 });
  assert.equal((await third).result.width, 640);
});

test("a missing target reply rejects within its command deadline and retires the transport", async t => {
  const h = fixture(t, 20), result = await bounded(h.command("Runtime.evaluate"));
  assert.equal(result.state, "rejected", "a delivered command without a reply must not stay pending");
  assert.match(result.error.message, /timed out/);
  assert.equal(h.cdp.eventNames().length, 0);
  await assert.rejects(h.command("Page.getLayoutMetrics"), /timed out/);
});

for (const sync of [false, true]) test(`${sync ? "synchronous" : "asynchronous"} send failures reject every pending command`, async t => {
  const h = fixture(t), failure = Error("Delivery failed");
  let fail;
  h.cdp.send = () => sync ? (() => { throw failure; })() : new Promise((resolve, reject) => { fail = reject; });
  const result = bounded(h.command("Runtime.evaluate")), second = bounded(h.command("Page.getLayoutMetrics"));
  if (!sync) fail(failure);
  const outcome = await result;
  assert.equal(outcome.state, "rejected"); assert.equal(outcome.error, failure);
  const other = await second; assert.equal(other.state, "rejected"); assert.equal(other.error, failure);
  await assert.rejects(h.command("Runtime.evaluate"), error => error === failure);
  assert.equal(h.cdp.eventNames().length, 0);
});

for (const [event, params] of [["Target.detachedFromTarget", { sessionId: "session-a" }],
  ["Target.targetDestroyed", { targetId: "target-a" }], ["close", {}]]) {
  test(`${event} rejects outstanding commands and releases owned listeners`, async t => {
    const h = fixture(t), first = bounded(h.command("Runtime.evaluate")), second = bounded(h.command("Page.getLayoutMetrics"));
    h.cdp.emit(event, params);
    for (const result of await Promise.all([first, second])) {
      assert.equal(result.state, "rejected", "closing the target must settle every outstanding command");
      assert.match(result.error.message, /detached|closed/);
    }
    assert.equal(h.cdp.eventNames().length, 0);
    await assert.rejects(h.command("Runtime.evaluate"), /detached|closed/);
  });
}

test("dispose rejects pending work once, removes only owned listeners and ignores late replies", async t => {
  const h = fixture(t), observer = () => {};
  h.cdp.on("Target.receivedMessageFromTarget", observer);
  const first = bounded(h.command("Runtime.evaluate")), second = bounded(h.command("Page.getLayoutMetrics"));
  h.dispose(); h.dispose(); h.reply(1, { late: true });
  assert((await Promise.all([first, second])).every(result => result.state === "rejected" && /disposed/.test(result.error.message)));
  assert.deepEqual(h.cdp.listeners("Target.receivedMessageFromTarget"), [observer]);
  await assert.rejects(h.command("Runtime.evaluate"), /disposed/);
});

test("protocol failures reject their command and malformed session responses retire pending work", async t => {
  const h = fixture(t), failure = bounded(h.command("Unknown.method"));
  h.cdp.emit("Target.receivedMessageFromTarget", { sessionId: "session-a", message: JSON.stringify({ id: 1, error: { message: "Unknown method" } }) });
  const outcome = await failure; assert.equal(outcome.state, "rejected"); assert.match(outcome.error.message, /Unknown method/);
  const pending = bounded(h.command("Runtime.evaluate"));
  h.cdp.emit("Target.receivedMessageFromTarget", { sessionId: "session-b", message: "invalid" });
  h.cdp.emit("Target.receivedMessageFromTarget", { sessionId: "session-a", message: "invalid" });
  const result = await pending; assert.equal(result.state, "rejected"); assert.match(result.error.message, /Invalid CDP/);
  assert.equal(h.cdp.eventNames().length, 0);
});

test("successful replies and disposal clear their request deadlines", async t => {
  const active = new Set(), schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    const timer = schedule(() => { active.delete(timer); callback(...args); }, delay);
    active.add(timer); return timer;
  });
  t.mock.method(globalThis, "clearTimeout", timer => { active.delete(timer); cancel(timer); });
  t.after(() => { for (const timer of active) cancel(timer); });
  const h = fixture(t), first = h.command("Runtime.evaluate");
  assert.equal(active.size, 1); h.reply(1, {}); await first;
  assert.equal(active.size, 0, "a completed command must not retain its deadline");
  const rejected = assert.rejects(h.command("Runtime.evaluate"), /disposed/);
  assert.equal(active.size, 1); h.dispose(); await rejected;
  assert.equal(active.size, 0, "disposing the target must clear outstanding deadlines");
});

test("invalid configuration and unserializable commands cannot create dangling work", async t => {
  for (const timeout of [0, -1, Infinity, "100"]) assert.throws(() => createTargetTransport(new EventEmitter(), {
    sessionId: "session-a", targetId: "target-a", timeout
  }), /Invalid CDP/);
  const h = fixture(t), params = {}; params.self = params;
  await assert.rejects(h.command("Runtime.evaluate", params), /circular/i);
  assert.equal(h.sent.length, 0);
  h.cdp.send = () => Promise.reject(null);
  const outcome = await bounded(h.command("Runtime.evaluate"));
  assert.equal(outcome.state, "rejected"); assert.equal(outcome.error.message, "null");
});
