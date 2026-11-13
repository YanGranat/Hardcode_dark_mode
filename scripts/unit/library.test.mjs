import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { clone, load, read } from "../support/modules.mjs";
import { worker } from "../support/worker.mjs";
import { popupFixture } from "../support/popup.mjs";

const origin = "https://parent.test", other = "https://child.test";
const add = url => ({ type: "hdm-universal-add-site", url });
const remove = key => ({ type: "hdm-universal-remove-site", origin: key });
const toggle = (key, enabled) => ({ type: "hdm-universal-set-enabled", origin: key, enabled });
const mode = (key, value) => ({ type: "hdm-universal-set-mode", origin: key, mode: value });
const tick = () => new Promise(resolve => setImmediate(resolve));
const main = state => state.scripts.find(script => !script.id.endsWith("#shadow"));

test("rule labels distinguish structural targets without changing saved names or identity", () => {
  const context = load(vm.createContext({}), "shared/rules.js");
  const { displayLabel, identity } = context.HdmRules;
  const first = { path: ["#layout > div:nth-of-type(1)"], label: "div" };
  const second = { path: ["#layout > div:nth-of-type(2)"], label: "div" };
  assert.equal(displayLabel(first), first.path[0]);
  assert.equal(displayLabel(second), second.path[0]);
  assert.notEqual(displayLabel(first), displayLabel(second));
  assert.equal(displayLabel({ path: ["#host", "svg.slide"], label: "svg" }), "#host / svg.slide");
  assert.equal(displayLabel({ ...first, label: "Main panel" }), "Main panel");
  assert.equal(displayLabel({ ...first, label: "panel" }), "panel");
  assert.equal(displayLabel({ ...first, label: "div#layout" }), "div#layout");
  assert.equal(displayLabel({ path: ["#fallback"], label: "Element" }), "#fallback");
  const long = { path: [`#${"x".repeat(180)} > div:nth-of-type(2)`], label: "div" };
  assert.equal(displayLabel(long).length, 120);
  assert(displayLabel(long).endsWith("div:nth-of-type(2)"));
  const before = clone(first);
  displayLabel(first);
  assert.deepEqual(first, before);
  assert.equal(identity(first), identity({ ...first, label: "Other name" }));
});

test("only whole-page sites register the first-paint script, and a mode change re-registers without touching pages", async () => {
  const { state, send } = worker();
  await send(add(origin));
  assert.equal(main(state).js[0], "content/boot.js");
  assert.deepEqual(state.scripts.find(script => script.id.endsWith("#shadow")).js, ["content/shadow-bridge.js"]);
  const applied = state.inserted.length;
  assert.equal((await send(mode(origin, "selected"))).ok, true);
  assert.equal(main(state).js.includes("content/boot.js"), false, "a selected-block site must never start with the page filter");
  assert.equal(state.inserted.length, applied, "a mode change is delivered through storage, not by re-injecting pages");
  state.fail = "storage";
  assert.equal((await send(mode(origin, "page"))).ok, false);
  assert.equal(state.sites[0].mode, "selected");
  assert.equal(main(state).js.includes("content/boot.js"), false, "a failed mode change restores the registration");
  assert.equal((await send(mode(origin, "page"))).ok, true);
  assert.equal(main(state).js[0], "content/boot.js");
});

test("registration identifiers are the site addresses, so two sites can never share one", async () => {
  const { state, send } = worker();
  // The first two addresses collided under the former 32-bit hash.
  // The last two differ only by what used to be the suffix of the page-world script.
  const urls = ["https://s27542.test", "https://s232100.test", "https://aa.test", "https://ab.test", "http://build", "http://build-shadow", "http://build#shadow"];
  for (const url of urls) assert.equal((await send(add(url))).ok, true);
  assert.equal(state.sites.length, 6, "a fragment is not part of a site address");
  assert.equal(state.scripts.length, 12);
  assert.equal(new Set(state.scripts.map(script => script.id)).size, 12);
  assert(state.scripts.every(script => script.id.startsWith("hdm-universal-")));
});

test("a removed site is restored with its rules, mode and date; duplicates and page senders are refused", async () => {
  const { state, send, listener } = worker();
  await send(add(origin));
  await send({ type: "hdm-exclusion-add", origin, rule: { path: ["#banner"], label: "div#banner" } });
  await send(mode(origin, "selected"));
  await send({ type: "hdm-inversion-save", origin, rule: { path: ["#work"], label: "div#work", protections: [{ path: ["#slide"], label: "svg#slide" }] } });
  const removed = clone(state.sites[0]);
  await send(remove(origin));
  assert.equal(state.sites.length, 0); assert.equal(state.scripts.length, 0);
  const restore = { type: "hdm-universal-restore-site", site: removed };
  const fromPage = listener(restore, { id: "test", url: `${origin}/page`, tab: { id: 1 } }, () => {});
  assert.equal(fromPage, false, "only the extension's own pages may restore a site");
  assert.equal((await send(restore)).ok, true);
  assert.deepEqual(state.sites, [removed]);
  assert.equal(state.scripts.length, 2);
  assert.deepEqual(clone(await send(restore)), { ok: false, error: "site_exists" });
  assert.equal((await send({ type: "hdm-universal-restore-site", site: { origin: "chrome://settings" } })).error, "invalid_message");
  assert.deepEqual(state.sites, [removed]);
});

test("import replaces matching sites, keeps the rest, drops invalid entries and reports the count", async () => {
  const { state, send, listener } = worker();
  await send(add(origin)); await send(add(other));
  await send({ type: "hdm-exclusion-add", origin: other, rule: { path: ["#keep"], label: "div#keep" } });
  const untouched = clone(state.sites.find(site => site.origin === other));
  const sites = [
    { origin, enabled: false, addedAt: 5, mode: "selected", inclusions: [{ path: ["#work"], label: "div#work" }] },
    { origin: "https://new.test/some/path", addedAt: 7 }, { origin: "chrome://settings" }, null, { enabled: true }
  ];
  const reply = await send({ type: "hdm-library-import", sites });
  assert.equal(reply.ok, true); assert.equal(reply.imported, 2);
  assert.deepEqual(state.sites.map(site => site.origin), [origin, other, "https://new.test"]);
  assert.deepEqual(state.sites[1], untouched);
  assert.deepEqual([state.sites[0].enabled, state.sites[0].mode, state.sites[0].addedAt, state.sites[0].inclusions.length], [false, "selected", 5, 1]);
  assert.deepEqual(state.scripts.map(script => script.matches[0]).sort(), ["https://child.test/*", "https://child.test/*", "https://new.test/*", "https://new.test/*"]);
  const before = clone(state.sites);
  assert.equal((await send({ type: "hdm-library-import", sites: "no" })).error, "invalid_message");
  assert.equal((await send({ type: "hdm-library-import", sites: [{ origin: "about:blank" }] })).error, "nothing_to_import");
  assert.deepEqual(state.sites, before);
  const fromOptions = await new Promise(resolve => listener({ type: "hdm-library-import", sites: [{ origin }] },
    { id: "test", url: "chrome-extension://test/options/options.html" }, resolve));
  assert.equal(fromOptions.ok, true);
  assert.equal(state.sites[0].mode, "page");
});

test("wildcard hosts and oversized files are refused by import and restore", async () => {
  const { state, send } = worker();
  for (const pattern of ["https://*", "http://*.example.com", "https://exa*mple.com/path"]) {
    assert.equal((await send({ type: "hdm-library-import", sites: [{ origin: pattern }] })).error, "nothing_to_import", pattern);
    assert.equal((await send({ type: "hdm-universal-restore-site", site: { origin: pattern } })).error, "invalid_message", pattern);
    assert.equal((await send(add(pattern))).ok, false, pattern);
  }
  const many = Array.from({ length: 2001 }, (_, index) => ({ origin: `https://site-${index}.test` }));
  assert.equal((await send({ type: "hdm-library-import", sites: many })).error, "invalid_message");
  assert.equal(state.sites.length, 0); assert.equal(state.scripts.length, 0);
});

test("the options page uses only messages that exist in both languages", () => {
  const h = popupFixture();
  const keys = [...read("options/options.html").matchAll(/data-i18n="([^"]+)"/g), ...read("options/options.js").matchAll(/"(backup[A-Za-z]+)"/g),
    ...read("popup/popup.js").matchAll(/"(backup[A-Za-z]+)"/g), ...read("popup/popup.html").matchAll(/data-i18n-title="([^"]+)"/g)].map(match => match[1]);
  assert(keys.length >= 8);
  for (const language of ["en", "ru"]) for (const key of keys) {
    assert.notEqual(h.text.translate(language, key, { count: 1 }), key, `${language}: ${key}`);
  }
});

test("import retains the saved preference but does not register a site with withheld access", async () => {
  const { state, send, api } = worker();
  api.permissions.contains = async ({ origins }) => origins[0] !== "https://blocked.test/*";
  await send({ type: "hdm-library-import", sites: [{ origin: "https://blocked.test" }, { origin: "https://open.test" }] });
  assert.deepEqual(state.sites.map(site => [site.origin, site.enabled]), [["https://blocked.test", true], ["https://open.test", true]]);
  assert.deepEqual(state.scripts.map(script => script.matches[0]), ["https://open.test/*", "https://open.test/*"]);
});

test("withheld host access suspends registrations without erasing the saved preference", async () => {
  const { state, send, api, fire } = worker();
  await send(add(origin)); await send(add(other));
  const before = clone(state.sites);
  api.permissions.contains = async ({ origins }) => origins[0] !== "https://parent.test/*";
  await fire("removed"); await tick();
  assert.deepEqual(state.sites, before, "a browser permission is not a user pause action");
  assert.deepEqual(state.scripts.map(script => script.matches[0]), ["https://child.test/*", "https://child.test/*"]);
  api.permissions.contains = async () => true;
  await fire("added"); await tick();
  assert.deepEqual(state.sites, before);
  assert.equal(state.scripts.length, 4, "returning access restores only sites already enabled by the user");
  await send(toggle(other, false));
  await fire("added"); await tick();
  assert.equal(state.sites.find(site => site.origin === other).enabled, false);
  assert.equal(state.scripts.length, 2);
});

test("a full rule list refuses the next rule instead of silently dropping it", async () => {
  const { state, send } = worker();
  await send(add(origin));
  for (let index = 0; index < 100; index++) {
    assert.equal((await send({ type: "hdm-exclusion-add", origin, rule: { path: [`#item-${index}`] } })).ok, true);
  }
  assert.deepEqual(clone(await send({ type: "hdm-exclusion-add", origin, rule: { path: ["#one-too-many"] } })), { ok: false, error: "too_many_rules" });
  assert.equal(state.sites[0].exclusions.length, 100);
});

test("withheld site access and malformed switch values are refused for listed sites", async () => {
  const { state, send, api } = worker();
  await send(add(origin));
  assert.deepEqual(clone(await send(toggle(origin, "yes"))), { ok: false, error: "invalid_message" });
  await send(toggle(origin, false));
  api.permissions.contains = async () => false;
  assert.deepEqual(clone(await send(toggle(origin, true))), { ok: false, error: "permission_required" });
  assert.deepEqual(clone(await send(add(other))), { ok: false, error: "permission_required" });
  assert.deepEqual(state.sites.map(site => [site.origin, site.enabled]), [[origin, false]]);
});

test("the popup names withheld access and unfinished page updates", async () => {
  const h = popupFixture(); await h.init();
  const enabling = h.model.setEnabled(origin, false);
  h.requests[0].reject(Error("permission_required")); await enabling;
  assert.equal(h.notices.at(-1), "permissionRequired");
  const pausing = h.model.setEnabled(origin, false);
  h.requests[1].resolve({ warning: "apply_incomplete" }); await pausing;
  assert.equal(h.notices.at(-1), "applyIncomplete");
  assert.notEqual(h.text.translate("en", "permissionRequired"), "permissionRequired");
  assert.notEqual(h.text.translate("ru", "permissionRequired"), "permissionRequired");
});

test("a removal notice carries the removed record and restoring sends it back unchanged", async () => {
  const sites = [{ origin, enabled: true, addedAt: 11, mode: "selected", exclusions: [{ path: ["#banner"], label: "div#banner" }],
    inclusions: [{ path: ["#work"], label: "div#work", protections: [{ path: ["#slide"], label: "svg#slide" }] }] }, { origin: other, enabled: true }];
  const h = popupFixture({ sites }); await h.init();
  const removing = h.model.remove(origin);
  h.save(sites.slice(1)); h.requests[0].resolve({}); await removing;
  assert.equal(h.notices.at(-1), "siteRemoved");
  const removed = h.details.at(-1).removed;
  assert.equal(removed.origin, origin);
  const restoring = h.model.restore(removed);
  await tick();
  const message = h.requests[1].message;
  assert.equal(message.type, "hdm-universal-restore-site");
  assert.deepEqual(clone(message.site), { origin, enabled: true, addedAt: 11, mode: "selected",
    exclusions: sites[0].exclusions, inclusions: sites[0].inclusions, protections: [] });
  h.save(sites); h.requests[1].resolve({}); await restoring;
  assert.equal(h.notices.at(-1), "siteRestored");
  assert.equal(h.details.at(-1), null, "only a removal offers an undo");
  assert.equal(h.model.restore(removed), undefined, "a site already back in the library is not restored twice");
  assert.equal(h.requests.length, 2);
  const failing = h.model.remove(other);
  h.requests[2].resolve({ warning: "apply_incomplete" }); await failing;
  assert.equal(h.details.at(-1), null, "a removal that ended with a warning shows the warning instead");
});

test("interpolated values are inserted literally", () => {
  const h = popupFixture();
  assert.equal(h.text.translate("en", "removeExclusion", { element: "div#price$&total" }), "Remove rule: div#price$&total");
});

test("Chrome Web Store pages are not offered for the library", () => {
  const context = vm.createContext({ URL });
  load(context, "shared/rules.js", "shared/site-utils.js");
  const supported = url => context.HdmSites.fromUrl(url).supported;
  assert.equal(supported("https://chromewebstore.google.com/detail/example"), false);
  assert.equal(supported("https://chrome.google.com/webstore/detail/example"), false);
  assert.equal(supported("https://chrome.google.com/other"), true);
  assert.equal(supported("https://example.com/webstore"), true);
});

test("same-tag siblings at the top of a shadow root get a positional selector", () => {
  const document = { querySelectorAll: selector => selector === "#host" ? [host] : [] };
  const element = (localName, id, root) => ({ localName, id, classList: [], parentElement: null, isConnected: true,
    matches: selector => selector === localName, getRootNode: () => root });
  const shadow = { nodeType: 11, children: [] };
  const host = element("section", "host", document);
  shadow.host = host; host.shadowRoot = shadow;
  const first = element("div", "", shadow), second = element("div", "", shadow);
  first.parentNode = second.parentNode = shadow; host.parentNode = { nodeType: 1 };
  shadow.children.push(first, second);
  shadow.querySelectorAll = selector => ({ div: [first, second], "div:nth-of-type(1)": [first], "div:nth-of-type(2)": [second] })[selector] || [];
  const context = vm.createContext({ document, CSS: { escape: value => value }, Element: Object });
  load(context, "shared/rules.js", "content/selectors.js");
  const rule = context.HdmSelectors.ruleFor(second);
  assert.deepEqual(clone(rule.path), ["#host", "div:nth-of-type(2)"]);
  assert.equal(context.HdmSelectors.resolveRule(rule), second);
  assert.deepEqual(clone(context.HdmSelectors.ruleFor(first).path), ["#host", "div:nth-of-type(1)"]);
});

test("a settings file round-trips the library and preferences; foreign, oversized and refused files change nothing", async () => {
  const sent = [], synced = [], blobs = [];
  const library = [{ origin: "https://parent.test/path", enabled: true, addedAt: 3, mode: "selected", inclusions: [{ path: ["#work"], label: "div#work" }], junk: 1 }];
  const chrome = {
    storage: { local: { get: async () => ({ universalSites: clone(library) }) },
      sync: { get: async defaults => ({ ...defaults, librarySort: "newest" }), set: async value => { synced.push(clone(value)); } } },
    runtime: { sendMessage: async message => { sent.push(clone(message)); return { ok: true, imported: message.sites.length }; } }
  };
  const address = function (...parts) { return new URL(...parts); };
  address.createObjectURL = blob => { blobs.push(blob); return "blob:settings"; };
  address.revokeObjectURL = () => {};
  const context = vm.createContext({ URL: address, Blob: class { constructor(parts) { this.text = parts.join(""); } }, setTimeout, clearTimeout });
  load(context, "shared/rules.js", "shared/site-utils.js", "shared/requests.js", "shared/backup.js");
  const backup = context.HdmBackup, link = { click() { this.clicked = true; } };
  assert.equal(await backup.save(chrome, { createElement: () => link }, "ru"), 1);
  assert.equal(link.clicked, true); assert.equal(link.href, "blob:settings");
  assert.match(link.download, /^custom-dark-mode-settings-\d{4}-\d{2}-\d{2}\.json$/);
  const file = JSON.parse(blobs[0].text);
  assert.equal(file.format, "custom-dark-mode-settings");
  assert.deepEqual(file.settings, { language: "ru", librarySort: "newest" }, "preferences are written even when they were never stored");
  assert.deepEqual(file.sites, [{ origin: "https://parent.test", enabled: true, addedAt: 3, mode: "selected", exclusions: [],
    inclusions: [{ path: ["#work"], label: "div#work" }], protections: [] }], "only stored, normalized fields are written");
  const asFile = text => ({ size: text.length, text: async () => text });
  assert.equal(await backup.load(chrome, asFile(blobs[0].text)), 1);
  assert.deepEqual(sent, [{ type: "hdm-library-import", sites: file.sites }]);
  assert.deepEqual(synced, [{ language: "ru", librarySort: "newest" }]);
  const empty = JSON.stringify({ format: file.format, sites: [], settings: { librarySort: "oldest", language: "de" } });
  assert.equal(await backup.load(chrome, asFile(empty)), 0, "a backup of an empty library still restores preferences");
  assert.equal(sent.length, 1); assert.deepEqual(synced.at(-1), { librarySort: "oldest" });
  for (const foreign of ["not json", JSON.stringify({ sites: [] }), JSON.stringify({ format: file.format, sites: "all" })]) {
    await assert.rejects(backup.load(chrome, asFile(foreign)), /invalid_file/);
  }
  await assert.rejects(backup.load(chrome, { size: 21 * 1024 * 1024, text: async () => blobs[0].text }), /invalid_file/);
  chrome.runtime.sendMessage = async () => ({ ok: false, error: "nothing_to_import" });
  await assert.rejects(backup.load(chrome, asFile(blobs[0].text)), /nothing_to_import/);
  assert.equal(sent.length, 1); assert.equal(synced.length, 2, "a refused file must not change the preferences either");
});
