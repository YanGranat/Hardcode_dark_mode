import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { load } from "../support/modules.mjs";

test("repeated injection refreshes one controller instead of registering another", () => {
  let instances = 0, refreshes = 0;
  const context = vm.createContext({ HdmThemeController: { create() {
    instances++;
    return { refresh() { refreshes++; } };
  } } });
  load(context, "content/start.js", "content/start.js");
  assert.equal(instances, 1);
  assert.equal(refreshes, 2);
});

test("picker starts only after its own current settings read applies successfully", { timeout: 1000 }, async () => {
  const origin = "https://editor.test", reads = [], starts = [], applied = [], classes = new Set();
  let listener, changed;
  const document = {
    querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    documentElement: { classList: { contains: name => classes.has(name), add: name => classes.add(name),
      remove: (...names) => names.forEach(name => classes.delete(name)), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) } }
  };
  const window = { addEventListener() {}, removeEventListener() {} }; window.top = window;
  const context = vm.createContext({ URL, document, window, setTimeout, clearTimeout, Event: class {}, Node: { ELEMENT_NODE: 1 },
    HdmSelectors: { owned: () => false },
    location: { href: origin, protocol: "https:" }, MutationObserver: class { observe() {} disconnect() {} },
    HdmRulePainter: { create(roots, kind = "exclude") { return {
      schedule() {}, set(rules, enabled) { applied.push({ kind, rules, enabled }); },
      start(language, page) { starts.push({ kind, language, page }); }
    }; } },
    chrome: {
      storage: { local: { get: () => new Promise((resolve, reject) => reads.push({ resolve, reject })) },
        onChanged: { addListener(fn) { changed = fn; }, removeListener() {} } },
      runtime: { id: "test", sendMessage: async () => ({ ok: true, allowed: true }), onMessage: { addListener(fn) { listener = fn; }, removeListener() {} } }
    }
  });
  load(context, "shared/requests.js", "shared/rules.js", "shared/site-utils.js", "content/controller.js");
  const controller = context.HdmThemeController.create();
  const pick = action => new Promise(resolve => {
    assert.equal(listener({ type: "hdm-exclusion-pick", language: "en", action, mode: "selected" }, { id: "test" }, resolve), true);
  });
  const stored = mode => ({ universalSites: [{ origin, enabled: true, mode, exclusions: [], inclusions: [] }] });
  const first = pick(); changed({ universalSites: {} }, "local");
  assert.equal(reads.length, 2); reads[0].resolve(stored("page"));
  assert.equal((await first).ok, false); assert.deepEqual(starts, []); assert.deepEqual(applied, []);
  reads[1].resolve(stored("selected")); await new Promise(resolve => setImmediate(resolve));
  assert.equal(classes.has("dmx-mode-selected"), true); assert.deepEqual(starts, []);
  const fresh = pick(); reads[2].resolve(stored("selected"));
  assert.equal((await fresh).ok, true); assert.deepEqual(starts, [{ kind: "invert", language: "en", page: origin }]);
  const failed = pick(); reads[3].reject(Error("storage unavailable"));
  assert.equal((await failed).ok, false); assert.equal(classes.has("dmx-on"), false); assert.equal(starts.length, 1);
  const staleProtection = pick("protect"); reads[4].resolve(stored("page"));
  assert.equal((await staleProtection).ok, false); assert.equal(starts.length, 1);
  const staleNewDraft = pick(); reads[5].resolve(stored("page"));
  assert.equal((await staleNewDraft).ok, false); assert.equal(starts.length, 1);
  context.chrome.runtime.sendMessage = async () => ({ ok: true, allowed: false });
  const withheld = controller.refresh(); reads[6].resolve(stored("selected")); await withheld;
  assert.equal(classes.has("dmx-on"), false, "stored preference cannot bypass native host access");
  context.chrome.runtime.sendMessage = async () => ({ ok: true, allowed: true });
  const granted = controller.refresh(); reads[7].resolve(stored("selected")); await granted;
  assert.equal(classes.has("dmx-on"), true);
  const pending = controller.refresh();
  context.chrome.runtime.id = undefined;
  assert.equal(await controller.refresh(), false);
  reads[8].resolve(stored("selected"));
  assert.equal(await pending, false);
  assert.equal(classes.has("dmx-on"), false, "an invalidated controller cannot revive after a pending read");
});
