import assert from "node:assert/strict";
import test from "node:test";
import { clone } from "../support/modules.mjs";
import { worker } from "../support/worker.mjs";
const add = url => ({ type: "hdm-universal-add-site", url });
const remove = origin => ({ type: "hdm-universal-remove-site", origin });
const toggle = (origin, enabled) => ({ type: "hdm-universal-set-enabled", origin, enabled });

test("document access reads bypass pending mutations and reject foreign senders", async () => {
  const h = worker();
  h.api.permissions.contains = async () => false;
  const message = { type: "hdm-document-access", origin: "https://parent.test" };
  const response = await new Promise(resolve => assert.equal(h.listener(message, { id: "test", tab: { id: 1 } }, resolve), true));
  assert.deepEqual(clone(response), { ok: true, allowed: false });
  assert.equal(h.listener(message, { id: "foreign", tab: { id: 1 } }, () => {}), false);
  assert.equal(h.listener({ ...message, origin: "chrome://settings" }, { id: "test", tab: { id: 1 } }, () => {}), false);
  let refreshed = false;
  h.api.tabs.sendMessage = async (_, value) => { refreshed ||= value.type === "hdm-universal-refresh" && value.origins.includes(message.origin); };
  h.api.scripting.executeScript = async () => { throw Error("Missing host permission"); };
  h.state.sites = [{ origin: message.origin, enabled: true }];
  await h.fire("removed"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshed, true, "controllers are notified even when the document probe is refused");
  assert.equal(h.state.sites[0].enabled, true);
});

test("registration reconciliation removes only owned scripts and retains the stable namespace", async () => {
  const h = worker();
  h.state.scripts = [{ id: "hdm-universal-obsolete" }, { id: "separate-feature" }];
  assert.equal((await h.send(add("https://parent.test"))).ok, true);
  assert.equal(h.state.scripts.some(script => script.id === "hdm-universal-obsolete"), false);
  assert.equal(h.state.scripts.some(script => script.id === "separate-feature"), true);
  const registered = h.state.scripts.filter(script => script.id !== "separate-feature");
  assert.equal(registered.length, 2);
  assert(registered.every(script => script.id.startsWith("hdm-universal-")));
});

test("rapid saves finish while the previous page request is still pending", { timeout: 1000 }, async () => {
  const { state, send, api } = worker(500);
  await send(add("https://parent.test"));
  await send(add("https://child.test"));
  let releaseProbe;
  const execute = api.scripting.executeScript;
  api.scripting.executeScript = arg => {
    if (!arg.func) return execute(arg);
    api.scripting.executeScript = execute;
    return new Promise(resolve => { releaseProbe = resolve; });
  };
  let replied = false;
  const first = send(toggle("https://parent.test", false)).then(result => { replied = true; return result; });
  while (!releaseProbe) await new Promise(resolve => setImmediate(resolve));
  const later = [send(toggle("https://parent.test", true)), send(toggle("https://parent.test", false)), send(remove("https://child.test"))];
  for (let n = 0; n < 20; n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(replied, false);
  assert.deepEqual(state.sites.map(({ origin, enabled }) => ({ origin, enabled })), [{ origin: "https://parent.test", enabled: false }]);
  assert.equal(state.scripts.length, 0);
  state.inserted.length = 0;
  releaseProbe([{ documentId: "parent", result: "https://parent.test" }]);
  assert((await Promise.all([first, ...later])).every(result => result.ok));
  assert.equal(state.inserted.length, 0, "superseded enable must never inject");
});

test("a stalled document probe cannot block library reads or later mutations", { timeout: 800 }, async () => {
  const { state, send, api } = worker();
  let releaseProbe;
  const execute = api.scripting.executeScript;
  api.scripting.executeScript = arg => arg.func
    ? new Promise(resolve => { releaseProbe = resolve; }) : execute(arg);
  const adding = send(add("https://parent.test"));
  while (!releaseProbe) await new Promise(resolve => setImmediate(resolve));
  const snapshot = await send({ type: "hdm-universal-get-sites" });
  assert.equal(snapshot.sites.length, 1);
  const result = await adding;
  assert.equal(result.ok, true);
  assert.equal(result.warning, "apply_incomplete");
  api.scripting.executeScript = execute;
  assert.equal((await send(remove("https://parent.test"))).ok, true);
  releaseProbe([{ documentId: "parent", result: "https://parent.test" }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.sites.length, 0);
  assert.equal(state.scripts.length, 0);
  assert.equal(state.inserted.length, 0, "expired probe must not start a late injection");
});

test("a stalled injection returns a warning and stops its remaining stages", { timeout: 800 }, async () => {
  const { state, send, api } = worker();
  let releaseInsert;
  let scriptCalls = 0;
  const execute = api.scripting.executeScript;
  api.scripting.executeScript = arg => { if (!arg.func) scriptCalls++; return execute(arg); };
  api.scripting.insertCSS = () => new Promise(resolve => { releaseInsert = resolve; });
  const result = await send(add("https://parent.test"));
  assert.equal(result.ok, true);
  assert.equal(result.warning, "apply_incomplete");
  assert.equal((await send(remove("https://parent.test"))).ok, true);
  releaseInsert();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scriptCalls, 0);
  assert.equal(state.sites.length, 0);
});

for (const stage of ["tabs", "removeCSS", "refresh"]) {
  test(`stalled ${stage} cannot keep the mutation queue locked`, { timeout: 800 }, async () => {
    const { send, api, state } = worker();
    await send(add("https://parent.test"));
    const owner = stage === "removeCSS" ? api.scripting : api.tabs;
    const key = stage === "tabs" ? "query" : stage === "refresh" ? "sendMessage" : "removeCSS";
    const original = owner[key];
    owner[key] = () => new Promise(() => {});
    const response = await send(toggle("https://parent.test", false));
    assert.equal(response.ok, true);
    assert.equal(response.warning, "apply_incomplete");
    assert.equal(state.sites[0].enabled, false);
    owner[key] = original;
    assert.equal((await send(remove("https://parent.test"))).ok, true);
  });
}

test("parallel library additions retain both entries and scoped registrations", async () => {
  const { state, send } = worker();
  const results = await Promise.all([send(add("https://parent.test/a")), send(add("https://child.test/b"))]);
  assert(results.every((r) => r.ok));
  assert.equal(state.sites.length, 2);
  assert.equal(state.scripts.length, 4);
  for (const script of state.scripts) {
    assert.equal(script.matches.length, 1);
    assert.equal(script.allFrames, true);
    assert(!JSON.stringify(script).includes("theme-deep"));
  }
});

test("imperative injection and removal target only matching documents, including embedded origins", async () => {
  const { state, send } = worker();
  // The site is only embedded in a tab showing another site: it is updated in the
  // background, after the reply.
  const settled = async () => { for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve)); };
  assert.equal((await send(add("https://child.test"))).warning, null);
  await settled();
  assert.deepEqual(state.inserted.map((x) => clone(x.target.documentIds)), [["child"]]);
  state.removed.length = 0;
  await send(remove("https://child.test"));
  await settled();
  assert.deepEqual(state.removed.map((x) => clone(x.target.documentIds)), [["child"]]);
  assert.equal(state.scripts.length, 0);
});

test("a tab showing another site can neither delay a change nor raise a reload warning", { timeout: 1500 }, async () => {
  const { send, state, api } = worker(1000);
  const origin = "https://parent.test";
  const documents = api.scripting.executeScript;
  api.tabs.query = async () => [{ id: 1, url: origin }, { id: 2, url: "https://elsewhere.test/" }, { id: 3 }];
  let stalled = 0;
  api.scripting.executeScript = arg => {
    if (arg.target.tabId === 1) return documents(arg);
    stalled++;
    return arg.target.tabId === 2 ? new Promise(() => {}) : Promise.reject(Error("unexpected renderer failure"));
  };
  const reply = await send(add(origin));
  assert.equal(reply.ok, true); assert.equal(reply.warning, null);
  assert.equal(stalled, 2, "other tabs are still probed for embedded copies of the site");
  assert.deepEqual(state.inserted.map((x) => clone(x.target.documentIds)), [["parent"]]);
  assert.equal((await send(toggle(origin, false))).warning, null, "a following change is not queued behind the silent tab");
});

test("an error page in the site's own tab is not reported as an unfinished change", async () => {
  const { send, api } = worker();
  api.scripting.executeScript = async () => { throw Error("Frame with ID 0 is showing error page"); };
  assert.equal((await send(add("https://parent.test"))).warning, null);
  api.scripting.executeScript = async () => { throw Error("unexpected renderer failure"); };
  assert.equal((await send(toggle("https://parent.test", false))).warning, "apply_incomplete");
});

test("pause, remove and add are serialized without reviving deleted entries", async () => {
  const { state, send } = worker();
  await send(add("https://parent.test"));
  await Promise.all([send(toggle("https://parent.test", false)), send(remove("https://parent.test")), send(add("https://child.test"))]);
  assert.deepEqual(state.sites.map((s) => s.origin), ["https://child.test"]);
  assert.equal(state.scripts.length, 2);
});

for (const failure of ["registration", "storage"]) {
  test(`${failure} failure restores previous registration and library state`, async () => {
    const { state, send } = worker();
    await send(add("https://parent.test"));
    state.fail = failure;
    assert.equal((await send(add("https://child.test"))).ok, false);
    assert.deepEqual(state.sites.map((s) => s.origin), ["https://parent.test"]);
    assert.equal(state.scripts.length, 2);
    assert(state.scripts.every((s) => s.matches[0] === "https://parent.test/*"));
    assert.equal((await send(add("https://child.test"))).ok, true);
  });
}

test("failed removal storage write restores registration", async () => {
  const { state, send } = worker();
  await send(add("https://parent.test"));
  state.fail = "storage";
  assert.equal((await send(remove("https://parent.test"))).ok, false);
  assert.equal(state.scripts.length, 2);
  assert.equal(state.sites.length, 1);
});

test("injection failure reports a saved but unapplied change", async () => {
  const { state, send } = worker();
  state.fail = "injection";
  const response = await send(add("https://parent.test"));
  assert.equal(response.ok, true);
  assert.equal(response.warning, "apply_incomplete");
  assert.equal(state.sites.length, 1);
});

test("invalid messages and content-script senders cannot mutate the library", async () => {
  const { state, send, listener } = worker();
  assert.equal((await send(add("chrome://settings"))).ok, false);
  assert.equal((await send(toggle("https://parent.test", "false"))).ok, false);
  assert.equal(listener(add("https://parent.test"), { id: "test", tab: { id: 1 } }, () => assert.fail()), false);
  assert.equal(state.sites.length, 0);
});

test("site creation dates survive edits and are renewed only after removal and re-addition", async () => {
  let now = 1000;
  const { send, state } = worker(30, () => now);
  const origin = "https://parent.test";
  assert.equal((await send(add(origin))).ok, true);
  assert.equal(state.sites[0].addedAt, 1000);
  now = 2000;
  for (const message of [toggle(origin, false), toggle(origin, true), add(origin),
    { type: "hdm-exclusion-add", origin, rule: { path: ["#banner"], label: "Banner" } },
    { type: "hdm-exclusion-remove", origin, path: ["#banner"] }]) {
    assert.equal((await send(message)).ok, true);
    assert.equal(state.sites[0].addedAt, 1000);
  }
  delete state.sites[0].addedAt;
  assert.equal((await send(toggle(origin, false))).ok, true);
  assert.equal(state.sites[0].addedAt, 0);
  assert.equal((await send(remove(origin))).ok, true);
  assert.equal(state.sites.length, 0);
  now = 3000;
  assert.equal((await send(add(origin))).ok, true);
  assert.equal(state.sites[0].addedAt, 3000);
});

test("exclusions persist through site toggles; deletion and concurrent saves preserve other rules", async () => {
  const { send, state } = worker();
  const origin = "https://parent.test";
  await send(add(origin));
  await Promise.all(["#banner", "#logo"].map(selector => send({
    type: "hdm-exclusion-add", origin, rule: { path: [selector], label: selector }
  })));
  assert.equal(state.sites[0].exclusions.length, 2);
  await send(toggle(origin, false)); await send(toggle(origin, true));
  assert.equal(state.sites[0].exclusions.length, 2);
  await send({ type: "hdm-exclusion-add", origin, rule: { path: ["#banner"], label: "banner" } });
  assert.equal(state.sites[0].exclusions.length, 2);
  await send({ type: "hdm-exclusion-remove", origin, path: ["#banner"] });
  assert.deepEqual(state.sites[0].exclusions.map(rule => rule.path), [["#logo"]]);
  state.fail = "storage";
  assert.equal((await send({ type: "hdm-exclusion-remove", origin, path: ["#logo"] })).ok, false);
  assert.equal(state.sites[0].exclusions.length, 1);
  await send(remove(origin)); assert.equal(state.sites.length, 0);
});

test("picker writes are limited to their sender origin and cannot mutate other site settings", async () => {
  const { send, listener, state } = worker();
  const origin = "https://parent.test";
  await send(add(origin));
  const message = { type: "hdm-exclusion-add", origin, rule: { path: ["#banner"], label: "banner" } };
  const sender = { id: "test", tab: { id: 1 }, url: origin + "/page" };
  assert.equal(listener(message, { ...sender, url: "https://other.test" }, () => assert.fail()), false);
  assert.equal(listener(toggle(origin, false), sender, () => assert.fail()), false);
  assert.equal((await new Promise(resolve => listener(message, sender, resolve))).ok, true);
  assert.equal(state.sites[0].exclusions.length, 1);
  await send(toggle(origin, false));
  assert.equal((await new Promise(resolve => listener(message, sender, resolve))).ok, false);
  assert.equal((await send({ ...message, rule: { path: ["x".repeat(2049)] } })).ok, false);
});

test("legacy global protections remain independent, readable, removable and rollback-safe", async () => {
  const h = worker(), origin = "https://parent.test";
  await h.send(add(origin));
  const rule = { path: ["svg.slide"], matchAll: true, label: "Slides" };
  h.state.sites[0].protections = [rule];
  await h.send({ type: "hdm-universal-set-mode", origin, mode: "selected" });
  await h.send({ type: "hdm-inversion-save", origin, rule });
  assert.deepEqual(h.state.sites[0].protections, [rule]);
  assert.deepEqual(h.state.sites[0].inclusions, [rule]);
  h.state.fail = "storage";
  assert.equal((await h.send({ type: "hdm-protection-remove", origin, path: rule.path, matchAll: true })).ok, false);
  assert.deepEqual(h.state.sites[0].protections, [rule]);
  await h.send(toggle(origin, false));
  assert.deepEqual(h.state.sites[0].protections, [rule]);
  await h.send({ type: "hdm-protection-remove", origin, path: rule.path, matchAll: true });
  assert.deepEqual(h.state.sites[0].protections, []);
  assert.deepEqual(h.state.sites[0].inclusions, [rule]);
});

test("mode and both rule lists persist independently through concurrent edits, toggles and failed writes", async () => {
  const { send, state } = worker(30, () => 1000);
  const origin = "https://parent.test";
  assert.equal((await send(add(origin))).ok, true);
  assert.equal(state.sites[0].mode, "page");
  assert.deepEqual(state.sites[0].inclusions, []);
  const exclusion = { path: ["#slide"], fallbackPath: [".viewer > svg"], label: "Slide" };
  const inclusion = { path: ["#toolbar"], fallbackPath: [".toolbar"], label: "Toolbar" };
  const mode = value => ({ type: "hdm-universal-set-mode", origin, mode: value });
  const replies = await Promise.all([
    send(mode("selected")),
    send({ type: "hdm-exclusion-add", origin, rule: exclusion }),
    send({ type: "hdm-inversion-save", origin, rule: inclusion })
  ]);
  assert(replies.every(reply => reply.ok));
  const expected = clone(state.sites[0]);
  assert.equal(expected.mode, "selected");
  assert.deepEqual(expected.exclusions, [exclusion]); assert.deepEqual(expected.inclusions, [inclusion]);
  for (const message of [toggle(origin, false), toggle(origin, true), add(origin)]) {
    assert.equal((await send(message)).ok, true);
    assert.deepEqual(state.sites[0], { ...expected, enabled: message.enabled !== false });
  }
  assert.equal((await send(mode("page"))).ok, true);
  assert.deepEqual(state.sites[0], { ...expected, mode: "page" });
  for (const value of [undefined, null, "invalid", true, {}]) {
    const response = await send(mode(value));
    assert.equal(response.ok, false); assert.equal(response.error, "invalid_message");
    assert.equal(state.sites[0].mode, "page");
  }
  await send(mode("selected"));
  const beforeFailure = clone(state.sites), registrations = clone(state.scripts);
  for (const message of [mode("page"),
    { type: "hdm-inversion-save", origin, rule: { path: ["#other"] } },
    { type: "hdm-inversion-remove", origin, path: inclusion.path },
    { type: "hdm-exclusion-remove", origin, path: exclusion.path }]) {
    state.fail = "storage";
    assert.equal((await send(message)).ok, false);
    assert.deepEqual(state.sites, beforeFailure); assert.deepEqual(state.scripts, registrations);
  }
  assert.equal((await send({ type: "hdm-inversion-remove", origin, path: inclusion.path })).ok, true);
  assert.deepEqual(state.sites[0].inclusions, []); assert.deepEqual(state.sites[0].exclusions, [exclusion]);
  assert.equal(state.sites[0].addedAt, 1000);
  await send(remove(origin)); await send(add(origin));
  assert.equal(state.sites[0].mode, "page"); assert.deepEqual(state.sites[0].inclusions, []); assert.deepEqual(state.sites[0].exclusions, []);
});

test("inversion rules enforce per-list limits, collision safety and own-origin picker authorization", async () => {
  const { send, listener, state } = worker();
  const origin = "https://parent.test", other = "https://child.test";
  await send(add(origin)); await send(add(other));
  await send({ type: "hdm-universal-set-mode", origin, mode: "selected" });
  const sender = { id: "test", tab: { id: 1 }, url: origin + "/page" };
  const rule = { path: ["#one"], fallbackPath: [".one"], label: "One" };
  const message = { type: "hdm-inversion-save", origin, rule };
  const fromPicker = value => new Promise(resolve => listener(value, sender, resolve));
  for (const forbidden of [{ ...message, origin: other },
    { type: "hdm-inversion-remove", origin, path: rule.path },
    { type: "hdm-universal-set-mode", origin, mode: "selected" }, toggle(origin, false)]) {
    assert.equal(listener(forbidden, sender, () => assert.fail("unauthorized sender received mutation access")), false);
  }
  assert.equal(listener(message, { ...sender, id: "foreign-extension" }, () => assert.fail()), false);
  assert.equal((await fromPicker(message)).ok, true);
  assert.deepEqual(state.sites[0].inclusions, [rule]); assert.deepEqual(state.sites[1].inclusions, []);
  assert.equal((await fromPicker({ ...message, rule: { ...rule, label: "Duplicate", fallbackPath: [".different"] } })).error, "rule_conflict");
  assert.deepEqual(state.sites[0].inclusions, [rule]);
  assert.equal((await fromPicker({ ...message, rule: { path: ["x".repeat(2049)] } })).error, "invalid_rule");
  state.sites[0].inclusions = Array.from({ length: 100 }, (_, index) => ({ path: [`#item-${index}`], label: "Item" }));
  assert.equal((await fromPicker(message)).error, "too_many_rules");
  assert.equal((await fromPicker({ ...message, rule: state.sites[0].inclusions[0], previousRule: state.sites[0].inclusions[0] })).ok, true);
  assert.equal((await send({ type: "hdm-exclusion-add", origin, rule })).ok, true, "inclusion capacity must not consume exclusion capacity");
  await send(toggle(origin, false));
  assert.equal((await fromPicker(message)).error, "site_paused");
  assert.equal((await send({ type: "hdm-universal-set-mode", origin, mode: "selected" })).ok, true, "paused sites may retain a new mode without enabling");
  assert.equal(state.sites[0].enabled, false);
  assert.equal((await send({ type: "hdm-inversion-remove", origin, path: ["#item-0"] })).ok, true);
  assert.equal(state.sites[0].inclusions.length, 99);
  assert.equal((await send({ type: "hdm-universal-set-mode", origin: "https://missing.test", mode: "selected" })).error, "site_not_found");
});

test("mode and rule writes finish without scanning or waiting for a stalled page application", { timeout: 1500 }, async () => {
  const { send, state, api } = worker(1000);
  const origin = "https://parent.test";
  await send(add(origin));
  let releaseProbe;
  api.scripting.executeScript = () => new Promise(resolve => { releaseProbe = resolve; });
  const applying = send(toggle(origin, true));
  while (!releaseProbe) await new Promise(resolve => setImmediate(resolve));
  let pageCalls = 0, registrationCalls = 0;
  api.tabs.query = async () => { pageCalls++; return []; };
  api.scripting.getRegisteredContentScripts = async () => { registrationCalls++; return clone(state.scripts); };
  let completed = false;
  const edits = Promise.all([
    send({ type: "hdm-universal-set-mode", origin, mode: "selected" }),
    send({ type: "hdm-inversion-save", origin, rule: { path: ["#toolbar"] } }),
    send({ type: "hdm-exclusion-add", origin, rule: { path: ["#slide"] } }),
    send({ type: "hdm-inversion-remove", origin, path: ["#toolbar"] })
  ]).then(replies => { assert(replies.every(reply => reply.ok && !reply.warning)); completed = true; });
  try {
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, true, "durable mode/rule edits must complete before the renderer responds");
    assert.equal(pageCalls, 0);
    assert.equal(registrationCalls, 1, "only the mode change touches registrations; rule edits do not");
    assert.equal(state.sites[0].mode, "selected");
    assert.deepEqual(state.sites[0].inclusions, []); assert.equal(state.sites[0].exclusions.length, 1);
  } finally {
    releaseProbe([]); await applying; await edits;
  }
});

test("DeepL library entries are saved and immediately applied to matching documents", async () => {
  const { send, state, api } = worker();
  api.tabs.query = async () => [{ id: 1, url: "https://www.deepl.com/translator" }];
  api.scripting.executeScript = async arg => arg.func ? [
    { documentId: "deepl", result: "https://www.deepl.com/translator" }
  ] : [];
  assert.equal((await send(add("https://www.deepl.com/translator"))).ok, true);
  assert.equal(state.sites[0].origin, "https://www.deepl.com");
  assert.equal(state.inserted.length, 1);
  assert.deepEqual(clone(state.inserted[0].target.documentIds), ["deepl"]);
  assert.equal((await send({ type: "hdm-universal-get-sites" })).sites.length, 1);
  await send(toggle("https://www.deepl.com", false));
  assert.equal(state.sites[0].enabled, false);
  assert.equal(state.scripts.length, 0);
});

test("an open page receives the shadow bridge in the page world before the controller files", async () => {
  const { state, send } = worker();
  await send(add("https://parent.test"));
  assert.deepEqual(state.executed.map(call => [call.world || "ISOLATED", clone(call.target.documentIds), call.files[0], call.files.at(-1)]),
    [["MAIN", ["parent"], "content/shadow-bridge.js", "content/shadow-bridge.js"], ["ISOLATED", ["parent"], "shared/rules.js", "content/start.js"]]);
  assert.equal(state.executed[1].files.includes("content/boot.js"), false, "an open page is marked by its controller, not by the first-paint script");
});
