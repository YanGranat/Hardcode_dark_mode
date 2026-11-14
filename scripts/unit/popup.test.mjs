import assert from "node:assert/strict";
import test from "node:test";
import { popupFixture } from "../support/popup.mjs";
import { clone, read } from "../support/modules.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const origin = "https://parent.test", child = "https://child.test";
const toggle = (origin, enabled) => ({ type: "hdm-universal-set-enabled", origin, enabled });

test("withheld access disables the picker without discarding the saved preference", async () => {
  const h = popupFixture();
  h.api.permissions.contains = async () => false;
  await h.init();
  assert.equal(h.model.snapshot().currentAccess, false);
  assert.equal(h.model.canPick(), false);
  assert.equal(h.model.site(origin).enabled, true);
  h.api.permissions.contains = async () => true;
  await h.init();
  assert.equal(h.model.canPick(), true);
});

test("picker eligibility waits only for the current site's committed edit", async () => {
  const h = popupFixture(); await h.init();
  assert.equal(h.model.canPick(), true);
  const other = h.model.setEnabled(child, false);
  assert.equal(h.model.canPick(), true);
  const own = h.model.setMode("selected");
  assert.equal(h.model.site(origin).mode, "selected");
  assert.equal(h.model.canPick(), false);
  assert.throws(() => h.model.pick(null, "en"), /settings_changed/);
  h.save([{ origin, enabled: true, mode: "selected" }, { origin: child, enabled: false }]);
  h.requests[1].resolve(); await own;
  assert.equal(h.model.canPick(), true);
  h.requests[0].resolve(); await other;
  h.change([{ origin, enabled: false }]); assert.equal(h.model.canPick(), false);
  h.change([]); assert.equal(h.model.canPick(), false);
  const adding = h.model.toggleMembership();
  assert.equal(h.model.canPick(), false);
  h.requests[2].resolve(); await adding;
  h.api.tabs.query = async () => [{ url: "chrome://settings" }]; await h.init();
  assert.equal(h.model.canPick(), false);
});

test("site switches preserve the complete record, latest intent and rollback", async () => {
  const site = { origin, enabled: true, mode: "selected", addedAt: 1234,
    exclusions: [{ path: ["#banner"], label: "Banner" }],
    inclusions: [{ path: ["#content"], label: "Content", protections: [{ path: ["svg"], label: "Graphic" }] }] };
  const h = popupFixture({ sites: [site] }); await h.init();
  const before = clone(h.model.site(origin));
  const first = h.model.setEnabled(origin, false);
  assert.deepEqual(clone(h.model.site(origin)), { ...before, enabled: false });
  const second = h.model.setEnabled(origin, true);
  assert.deepEqual(clone(h.requests.map(request => request.message)), [toggle(origin, false), toggle(origin, true)]);
  h.requests[0].reject(Error("failed")); await first;
  assert.equal(h.model.site(origin).enabled, true);
  h.requests[1].reject(Error("failed")); await second;
  assert.deepEqual(clone(h.model.site(origin)), before);
  assert.equal(h.model.isPending(), false);
  assert.equal(h.model.setEnabled("https://missing.test", true), undefined);
  assert.equal(h.requests.length, 2);
});

test("last click survives old storage, reverse replies and independent site removal", async () => {
  const h = popupFixture(); await h.init();
  const first = h.model.setEnabled(origin, false), second = h.model.setEnabled(origin, true);
  const third = h.model.setEnabled(origin, false), other = h.model.remove(child);
  assert.equal(h.model.snapshot().sites.length, 1);
  assert.equal(h.model.site(origin).enabled, false);
  h.change([{ origin, enabled: true }, { origin: child, enabled: true }]);
  h.requests[1].resolve({ sites: [{ origin, enabled: true }] }); h.requests[0].reject(Error("save_failed"));
  await Promise.all([first, second]);
  assert.equal(h.model.site(origin).enabled, false); assert.equal(h.notices.length, 0);
  h.save([{ origin, enabled: false }]); h.requests[3].resolve(); h.requests[2].resolve();
  await Promise.all([third, other]);
  assert.equal(h.model.isPending(), false); assert.equal(h.model.site(origin).enabled, false);
  assert.equal(h.model.site(child), null);
});

test("latest failure rolls back only its site and a stale failed read cannot erase a new click", async () => {
  const h = popupFixture(); await h.init();
  const first = h.model.setEnabled(origin, false); h.requests[0].reject(Error("save_failed")); await first;
  assert.equal(h.model.site(origin).enabled, true);
  let rejectRead;
  h.api.storage.local.get = () => new Promise((_, reject) => { rejectRead = reject; });
  const second = h.model.setEnabled(origin, false); h.requests[1].resolve();
  while (!rejectRead) await tick();
  const third = h.model.setEnabled(origin, true); rejectRead(Error("read failed")); await second;
  assert.equal(h.model.site(origin).enabled, true); assert.equal(h.model.isPending(origin), true);
  h.api.storage.local.get = async () => ({ universalSites: [{ origin, enabled: true }] });
  h.requests[2].resolve(); await third; assert.equal(h.model.isPending(), false);
});

test("a storage event newer than reconciliation wins over its old read", async () => {
  const h = popupFixture(); await h.init();
  let finishRead;
  h.api.storage.local.get = () => new Promise(resolve => { finishRead = resolve; });
  const changing = h.model.setEnabled(origin, false); h.requests[0].resolve();
  while (!finishRead) await tick();
  h.change([{ origin, enabled: true }, { origin: "https://new.test", enabled: true }]);
  finishRead({ universalSites: [{ origin, enabled: false }] }); await changing;
  assert.equal(h.model.site(origin).enabled, true); assert.equal(h.model.site("https://new.test").enabled, true);
});

test("initialization reads storage and the active tab without contacting a busy worker", async () => {
  const h = popupFixture({ sites: [{ origin, enabled: true }], settings: { language: "ru" } });
  h.api.runtime.sendMessage = () => assert.fail("initialization must not contact the worker");
  await h.init();
  assert.equal(h.model.snapshot().settings.language, "ru");
  assert.equal(h.model.site(origin).label, "parent.test");
  assert.equal(h.model.snapshot().currentSite.origin, origin);
});

test("events during initialization remain newer than its storage snapshots", async () => {
  const h = popupFixture();
  let settings, library;
  h.api.storage.sync.get = () => new Promise(resolve => { settings = resolve; });
  h.api.storage.local.get = () => new Promise(resolve => { library = resolve; });
  const loading = h.init();
  h.sync({ language: { newValue: "ru" } }); h.change([{ origin, enabled: false }]);
  settings({ language: "en" }); library({ universalSites: [{ origin, enabled: true }] }); await loading;
  assert.equal(h.model.snapshot().settings.language, "ru"); assert.equal(h.model.site(origin).enabled, false);
});

test("request timeout releases its command, rolls back and clears its timer", async () => {
  let fireTimeout, cleared = false;
  const h = popupFixture({ timers: { setTimeout(fn) { fireTimeout = fn; return 1; }, clearTimeout() { cleared = true; } } });
  await h.init(); const changing = h.model.setEnabled(origin, false); fireTimeout(); await changing;
  assert.equal(cleared, true); assert.equal(h.model.isPending(), false);
  assert.equal(h.model.site(origin).enabled, true); assert.equal(h.notices.at(-1), "requestTimedOut");
});

test("language saves keep input order and recover after quota rejection", async () => {
  const h = popupFixture(); await h.init();
  await Promise.all([h.model.saveSettings({ language: "ru" }), h.model.saveSettings({ language: "en" })]);
  assert.equal(h.model.snapshot().settings.language, "en");
  assert.deepEqual(h.writes, [{ language: "ru" }, { language: "en" }]);
  assert.deepEqual(h.notices, [], "successful language changes need no confirmation notice");
  const save = h.api.storage.sync.set;
  h.api.storage.sync.set = async () => { throw Error("quota"); };
  await h.model.saveSettings({ language: "ru" }); assert.equal(h.model.snapshot().settings.language, "en");
  assert.equal(h.notices.at(-1), "settingsFailed");
  h.api.storage.sync.set = save;
  await h.model.saveSettings({ language: "ru" }); assert.equal(h.model.snapshot().settings.language, "ru");
  await h.model.setSort("newest");
  assert.deepEqual(h.notices, ["settingsFailed"], "preference saves must not replace an existing error or Undo notice");
});

test("late settings writes preserve newer events per key and failed final saves retain prior success", async () => {
  const h = popupFixture(); await h.init(); const writes = [];
  h.api.storage.sync.set = partial => new Promise((resolve, reject) => writes.push({ partial: clone(partial), resolve, reject }));
  const first = h.model.saveSettings({ librarySort: "newest", language: "ru" }); await tick();
  assert.equal(writes.length, 1); h.sync({ librarySort: { newValue: "oldest" } }); writes[0].resolve(); await first;
  assert.deepEqual(clone(h.model.snapshot().settings), { language: "ru", librarySort: "oldest" });
  const second = h.model.saveSettings({ librarySort: "newest" }), third = h.model.saveSettings({ librarySort: "alphabetical" });
  await tick(); assert.equal(writes.length, 2);
  h.sync({ language: { newValue: "en" } }); writes[1].resolve(); await second; await tick();
  assert.deepEqual(clone(h.model.snapshot().settings), { language: "en", librarySort: "newest" });
  assert.equal(writes.length, 3); writes[2].reject(Error("quota")); await third;
  assert.equal(h.model.snapshot().settings.librarySort, "newest");
  h.sync({ librarySort: {} }); assert.equal(h.model.snapshot().settings.librarySort, "alphabetical");
});

test("sort controls retain their latest optimistic selection through failures", async () => {
  const h = popupFixture(); await h.init(); const writes = [];
  h.api.storage.sync.set = partial => new Promise((resolve, reject) => writes.push({ partial, resolve, reject }));
  const first = h.model.setSort("newest"), second = h.model.setSort("oldest");
  assert.equal(h.model.snapshot().sort, "oldest"); await tick(); writes[0].resolve(); await first; await tick();
  assert.equal(h.model.snapshot().sort, "oldest"); writes[1].reject(Error("quota")); await second;
  assert.equal(h.model.snapshot().sort, "newest");
});

test("library sorting keeps independent date, tie and unknown-date contracts", () => {
  const { sorting } = popupFixture();
  const sites = Object.freeze([
    { label: "z.test", origin: "https://z.test", addedAt: 200 },
    { label: "a.test", origin: "https://a.test", addedAt: 100 },
    { label: "a.test", origin: "http://a.test", addedAt: 100 },
    ...[undefined, 0, -1, NaN, Infinity, "300"].map((addedAt, index) => ({ label: `${index}.test`, origin: `https://${index}.test`, addedAt }))
  ].map(Object.freeze));
  const sorted = order => Array.from(sorting.sortSites(sites, order), site => site.origin);
  const dated = ["http://a.test", "https://a.test", "https://z.test"], unknown = Array.from({ length: 6 }, (_, index) => `https://${index}.test`);
  assert.deepEqual(sorted("oldest"), [...dated, ...unknown]);
  assert.deepEqual(sorted("newest"), [dated[2], dated[0], dated[1], ...unknown]);
  const alphabetical = [...unknown, ...dated];
  assert.deepEqual(sorted("alphabetical"), alphabetical);
  for (const invalid of [undefined, null, "", "NEWEST", "invalid", {}, 1]) {
    assert.deepEqual(sorted(invalid), alphabetical);
  }
  for (const order of ["alphabetical", "newest", "oldest"]) {
    const result = sorting.sortSites(sites, order);
    assert.notEqual(result, sites); assert(result.every(site => sites.includes(site)));
  }
  assert.equal(sites[0].origin, "https://z.test"); assert.deepEqual(Array.from(sorting.sortSites([], "newest")), []);
});

test("translations cover every language, HTML references and interpolation", () => {
  const { text } = popupFixture();
  const keys = Object.keys(text.messages.en).sort();
  for (const language of ["en", "ru", "uk", "de", "es"]) {
    assert.deepEqual(keys, Object.keys(text.messages[language]).sort());
    for (const match of read("popup/popup.html").matchAll(/data-i18n(?:-aria-label|-title)?="([^"]+)"/g)) {
      assert.notEqual(text.translate(language, match[1]), match[1]);
    }
  }
  assert.equal(text.translate("en", "enableSite", { site: "example.test" }), "Enable dark theme for example.test");
  assert.equal(text.normalizeLanguage("unsupported"), "en");
});

test("popup detects regional browser languages but keeps the stored choice", async () => {
  for (const [browserLanguage, expected] of [["uk-UA", "uk"], ["de-CH", "de"], ["es-MX", "es"], ["fr-FR", "en"]]) {
    const detected = popupFixture({ browserLanguage, settings: {} });
    await detected.init();
    assert.equal(detected.model.snapshot().settings.language, expected);
    const saved = popupFixture({ browserLanguage, settings: { language: "ru" } });
    await saved.init();
    assert.equal(saved.model.snapshot().settings.language, "ru");
  }
});
