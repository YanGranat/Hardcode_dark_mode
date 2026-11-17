import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { createBrowserHarness, decodePng } from "./support/browser.mjs";
import { load } from "./support/modules.mjs";

const editorText = load(vm.createContext({}), "shared/languages.js", "editor/translations.js").HdmEditorText;

const slide = id => `<svg id="${id}" class="slide" width="240" height="140" viewBox="0 0 240 140"><rect width="240" height="140" fill="#092346"/><rect x="20" y="20" width="45" height="45" fill="#ffd144"/><rect x="90" y="20" width="45" height="45" fill="#27dfae"/></svg>`;
const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#eee;font:16px sans-serif}#workspace{margin:24px;padding:20px;width:720px;height:440px;background:white;box-sizing:border-box}
.slide{display:block;margin:12px}#outside{position:absolute;left:760px;top:60px}#moving{position:absolute;left:800px;top:300px;width:80px;height:70px;background:#fff;animation:travel 2s linear infinite alternate}
@keyframes travel{to{transform:translateY(100px)}}#shadow{margin:24px}.hidden{display:none}
</style></head><body><section id="workspace"><article id="stage">${slide("slide-a")}</article>${slide("slide-static")}</section>${slide("outside")}<aside id="moving"></aside><section id="shadow"></section><script>
window.replaceSlide=id=>document.querySelector('#stage').innerHTML=${JSON.stringify(slide("PLACEHOLDER"))}.replace('PLACEHOLDER',id);
document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<style>.area{padding:15px;background:white;width:280px}.slide{display:block}</style><article class="area">'+${JSON.stringify(slide("shadow-slide"))}+'</article>';
</script></body></html>`;
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(fixture);
});
const harness = createBrowserHarness({ server, headless: true, timeout: 90000, name: "Rule management" });
await harness.run(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const context = await harness.launch(); harness.deadline();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extension = new URL(worker.url()).host;
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const targetTab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), page.url());
  const popup = await context.newPage();
  await popup.addInitScript(tab => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = options => options.active ? Promise.resolve([tab]) : query(options);
    window.close = () => {};
  }, targetTab);
  await popup.goto(`chrome-extension://${extension}/popup/popup.html`);
  await popup.evaluate(() => chrome.storage.sync.set({ language: "en" }));
  const send = message => popup.evaluate(value => chrome.runtime.sendMessage(value), message);
  const origin = "http://127.0.0.1";
  const stored = () => popup.evaluate(async () => (await chrome.storage.local.get("universalSites")).universalSites[0]);
  const capture = async selector => decodePng(page, await page.locator(selector).screenshot());
  const samples = image => [[5, 5], [30, 30], [110, 30]].map(([x, y]) => image.pixels.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
  const original = samples(await capture("#slide-a"));
  const group = { path: [".slide"], label: "svg", matchAll: true, name: "Slide colors" };
  const parent = { path: ["#workspace"], label: "section", name: "Workspace", protections: [group] };
  assert.equal((await send({ type: "hdm-universal-add-site", url: page.url() })).ok, true);
  assert.equal((await send({ type: "hdm-universal-set-mode", origin, mode: "selected" })).ok, true);
  assert.equal((await send({ type: "hdm-inversion-save", origin, rule: parent })).ok, true);
  const ready = async () => {
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("data-hdm-cutout") === "mask");
  };
  await ready();
  assert.deepEqual(samples(await capture("#slide-a")), original, "a grouped exception preserves saturated slide pixels");
  for (const id of ["slide-b", "slide-a"]) {
    await page.evaluate(id => window.replaceSlide(id), id); await ready();
    await page.waitForFunction(id => document.querySelector(`#${id}`).getAttribute("data-hdm-excluded") !== "root", id);
    assert.deepEqual(samples(await capture(`#${id}`)), original, "replacement slides retain their original colors");
  }
  const metadata = async (kind, rule, changes, owner = null) => {
    const response = await send({ type: "hdm-rule-update", origin, kind, path: rule.path,
      matchAll: rule.matchAll === true, changes, ...(owner ? { parent: { path: owner.path, matchAll: owner.matchAll === true } } : {}) });
    assert.equal(response.ok, true, response.error);
  };
  await metadata("protection", group, { enabled: false }, parent);
  await page.waitForFunction(() => !document.querySelector("#workspace").hasAttribute("data-hdm-cutout"), null, { timeout: 1500 }).catch(() => {});
  assert.equal(await page.locator("#workspace").getAttribute("data-hdm-cutout"), null, "a paused local exception must release the parent's mask");
  assert.notDeepEqual(samples(await capture("#slide-a")), original, "pausing an exception resumes inversion without deleting it");
  await metadata("protection", group, { enabled: true, name: "Protected slides" }, parent); await ready();
  assert.deepEqual(samples(await capture("#slide-a")), original);
  await metadata("inversion", parent, { enabled: false });
  await page.waitForFunction(() => !document.querySelector("#workspace").hasAttribute("data-hdm-inverted"));
  assert.deepEqual(samples(await capture("#slide-a")), original, "pausing the parent restores its full subtree");
  assert.equal((await stored()).inclusions[0].protections[0].name, "Protected slides");
  await metadata("inversion", parent, { enabled: true, name: "Reading workspace" }); await ready();
  console.log("PASS grouped exceptions, replacement slides and independent rule pauses preserve pixel contracts");

  await popup.locator("#exclusion-details").evaluate(node => node.open = true);
  const firstRow = popup.locator("#exclusion-list > .exclusion-row").first();
  await firstRow.locator(":scope > .rule-settings-btn").click();
  const nameInput = firstRow.locator(":scope > .rule-settings > .rule-name-form > .rule-name");
  await nameInput.fill("Unsubmitted title");
  await popup.evaluate(() => chrome.storage.sync.set({ language: "ru" }));
  await popup.waitForFunction(() => document.documentElement.lang === "ru");
  assert.equal(await nameInput.inputValue(), "Unsubmitted title", "locale changes preserve an unsaved name draft");
  await metadata("protection", group, { name: "Chart graphics" }, parent);
  await popup.waitForFunction(() => [...document.querySelectorAll(".rule-child-list .rule-title")].some(node => node.textContent.includes("Chart graphics")));
  assert.equal(await nameInput.inputValue(), "Unsubmitted title", "a rendered storage change preserves an unsaved name draft");
  assert.equal(await nameInput.evaluate(node => node === document.activeElement), true, "storage updates retain input focus");
  await metadata("protection", group, { name: "Protected slides" }, parent);
  await popup.evaluate(() => chrome.storage.sync.set({ language: "en" }));
  await popup.waitForFunction(() => document.documentElement.lang === "en");
  await nameInput.fill("Reading desk");
  await firstRow.locator(":scope > .rule-settings > .rule-name-form > .rule-name-save").click();
  await popup.waitForFunction(async () => (await chrome.storage.local.get("universalSites")).universalSites[0].inclusions[0].name === "Reading desk");
  assert.match(await firstRow.locator(":scope > .rule-heading > .rule-title").textContent(), /Reading desk/);
  assert.equal(await nameInput.inputValue(), "Reading desk");
  const childToggle = firstRow.locator(".rule-child-list .rule-enabled");
  await childToggle.click();
  await page.waitForFunction(() => !document.querySelector("#workspace").hasAttribute("data-hdm-cutout"));
  assert.notDeepEqual(samples(await capture("#slide-a")), original);
  await childToggle.click(); await ready();
  const parentToggle = firstRow.locator(":scope > .rule-heading > .rule-enabled");
  await parentToggle.click();
  await page.waitForFunction(() => !document.querySelector("#workspace").hasAttribute("data-hdm-inverted"));
  assert.equal((await stored()).inclusions[0].protections[0].name, "Protected slides");
  await firstRow.locator(":scope > .rule-heading > .rule-edit").click();
  await page.bringToFront();
  const editor = page.locator('[data-hdm-picker]:not([data-hdm-matches])');
  await editor.waitFor();
  assert.match(await editor.locator(".root-context").textContent(), /Reading desk/);
  await editor.locator('[data-action="save"]').click();
  await editor.waitFor({ state: "detached" });
  assert.equal((await stored()).inclusions[0].enabled, false, "editing a paused rule does not silently enable it");
  assert.equal((await stored()).inclusions[0].name, "Reading desk", "editor saves retain a custom name");
  await parentToggle.click(); await ready();
  await nameInput.fill("Reading workspace");
  await firstRow.locator(":scope > .rule-settings > .rule-name-form > .rule-name-save").click();
  await popup.waitForFunction(async () => (await chrome.storage.local.get("universalSites")).universalSites[0].inclusions[0].name === "Reading workspace");
  console.log("PASS popup controls rename and independently pause nested and parent rules");

  const show = async (kind, rule, owner = null) => {
    const response = await popup.evaluate(({ tab, kind, rule, owner }) => chrome.tabs.sendMessage(tab, {
      type: "hdm-rule-show", language: "en", kind, path: rule.path, matchAll: rule.matchAll === true,
      ...(owner ? { parent: { path: owner.path, matchAll: owner.matchAll === true } } : {})
    }, { frameId: 0 }), { tab: targetTab.id, kind, rule, owner });
    assert.equal(response.ok, true, response.error);
    await page.bringToFront();
    await page.locator("[data-hdm-matches]").waitFor();
    return page.locator("[data-hdm-matches]");
  };
  const dismiss = async () => {
    await page.locator("[data-hdm-matches]").getByRole("button", { name: "Close", exact: true }).click();
    await page.locator("[data-hdm-matches]").waitFor({ state: "detached" });
  };
  const before = JSON.stringify(await stored());
  let viewer = await show("protection", group, parent);
  assert.match(await viewer.locator('[role="status"]').textContent(), /Matches: 2/);
  assert.equal(await viewer.locator(".outline").count(), 2, "only strict descendants of the parent are outlined");
  assert.deepEqual(samples(await capture("#slide-a")), original, "inspection does not change protected slide colors");
  const inspectionState = () => viewer.evaluate(host => ({
    status: host.shadowRoot.querySelector("p").textContent,
    boxes: [...host.shadowRoot.querySelectorAll(".outline")].map(box => {
      const rect = box.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height, box.className];
    })
  }));
  const inspection = await inspectionState();
  await viewer.getByRole("button", { name: "Move panel down", exact: true }).click();
  assert.equal(await viewer.locator(".panel").evaluate(panel => panel.getBoundingClientRect().bottom),
    (await page.evaluate(() => innerHeight)) - 12, "the lower panel remains reachable within the viewport");
  assert.deepEqual(await inspectionState(), inspection, "moving the panel retains match counts, outlines and current selection");
  assert.equal(JSON.stringify(await stored()), before, "panel placement never changes saved rules");
  await viewer.getByRole("button", { name: "Move panel up", exact: true }).click();
  assert.equal(await viewer.locator(".panel").evaluate(panel => panel.getBoundingClientRect().top), 12);
  assert.deepEqual(await inspectionState(), inspection, "moving back preserves the same inspection session");
  const currentMatch = () => viewer.evaluate(host => {
    const box = host.shadowRoot.querySelector(".outline.current").getBoundingClientRect();
    return [...document.querySelectorAll("#workspace .slide")].find(node => {
      const rect = node.getBoundingClientRect(); return Math.abs(rect.left - box.left) < 1 && Math.abs(rect.top - box.top) < 1;
    })?.id;
  });
  assert.equal(await currentMatch(), "slide-a");
  await viewer.getByRole("button", { name: "Next", exact: true }).click();
  assert.equal(await currentMatch(), "slide-static", "Next selects the following match");
  await viewer.getByRole("button", { name: "Next", exact: true }).click();
  assert.equal(await currentMatch(), "slide-a", "Next wraps after the last match");
  await viewer.getByRole("button", { name: "Previous", exact: true }).click();
  assert.equal(await currentMatch(), "slide-static", "Previous wraps before the first match");
  await viewer.getByRole("button", { name: "Previous", exact: true }).click();
  assert.equal(await currentMatch(), "slide-a", "Previous selects the preceding match");
  await dismiss();
  assert.equal(JSON.stringify(await stored()), before, "showing and navigating matches does not write settings");
  const moving = { path: ["#moving"], label: "aside" };
  assert.equal((await send({ type: "hdm-exclusion-add", origin, rule: moving })).ok, true);
  viewer = await show("exclusion", moving);
  await page.waitForFunction(() => {
    const item = document.querySelector("#moving").getBoundingClientRect();
    const outline = document.querySelector("[data-hdm-matches]").shadowRoot.querySelector(".outline").getBoundingClientRect();
    return Math.abs(item.top - outline.top) < 2;
  });
  const drift = await page.evaluate(async () => {
    const animation = document.querySelector("#moving").getAnimations()[0];
    animation.pause(); animation.currentTime = 1900;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return Math.abs(document.querySelector("#moving").getBoundingClientRect().top -
      document.querySelector("[data-hdm-matches]").shadowRoot.querySelector(".outline").getBoundingClientRect().top);
  });
  assert(drift < 2, `animated matches remain aligned with their outlines (${drift}px)`);
  await dismiss();
  console.log("PASS match inspection is non-persistent, parent-scoped and follows CSS-only motion");

  const shadowRule = { path: ["#shadow", ".area"], label: "article", name: "Shadow region", protections: [
    { path: ["#shadow", ".slide"], label: "svg", matchAll: true, name: "Shadow image" }
  ] };
  assert.equal((await send({ type: "hdm-inversion-save", origin, rule: shadowRule })).ok, true);
  viewer = await show("protection", shadowRule.protections[0], shadowRule);
  assert.match(await viewer.locator('[role="status"]').textContent(), /Matches: 1/); await dismiss();
  assert.equal((await send({ type: "hdm-universal-set-enabled", origin, enabled: false })).ok, true);
  await page.waitForFunction(() => !document.documentElement.classList.contains("dmx-on"));
  viewer = await show("protection", shadowRule.protections[0], shadowRule);
  await page.evaluate(async () => {
    const previous = document.querySelector("#shadow").shadowRoot.querySelector("svg");
    previous.replaceWith(previous.cloneNode(true));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.match(await viewer.locator('[role="status"]').textContent(), /Rendered: 1\/1/, "replaced shadow matches are resolved on paused sites");
  assert.equal(await viewer.locator(".outline").count(), 1, "paused sites still observe replaced shadow matches");
  await dismiss();
  assert.equal((await send({ type: "hdm-universal-set-enabled", origin, enabled: true })).ok, true);
  await page.reload(); await ready();
  assert.deepEqual(samples(await capture("#slide-a")), original, "saved grouped exceptions reapply after navigation");
  const saved = await stored();
  assert.equal(saved.inclusions[0].name, "Reading workspace");
  assert.equal(saved.inclusions[0].protections[0].name, "Protected slides");
  assert.equal((await send({ type: "hdm-universal-remove-site", origin })).ok, true);
  assert.equal((await send({ type: "hdm-library-import", sites: [saved] })).ok, true); await ready();
  assert.deepEqual((await stored()).inclusions, saved.inclusions, "backup import restores rule names and nested exceptions");
  console.log("PASS shadow matches, navigation and backup import preserve saved rule metadata");

  await page.evaluate(() => document.body.replaceChildren(document.createElement("div")));
  const single = { path: ["div"], label: "div" };
  assert.equal((await send({ type: "hdm-exclusion-add", origin, rule: single })).ok, true);
  viewer = await show("exclusion", single);
  assert.match(await viewer.locator('[role="status"]').textContent(), /Matches: 1/, "owned overlay hosts do not make an exact selector ambiguous");
  await dismiss();
  await page.evaluate(() => document.body.append(document.createElement("div")));
  viewer = await show("exclusion", single);
  assert.match(await viewer.locator('[role="status"]').textContent(), /No matches/, "two authored matches still invalidate an exact selector");
  assert.equal(await viewer.locator(".outline").count(), 0); await dismiss();
  await page.evaluate(() => { document.body.replaceChildren(...Array.from({ length: 500 }, () => document.createElement("div"))); });
  const all = { path: ["div"], label: "div", matchAll: true };
  assert.equal((await send({ type: "hdm-exclusion-add", origin, rule: all })).ok, true);
  viewer = await show("exclusion", all);
  assert.match(await viewer.locator('[role="status"]').textContent(), /Matches: 500/, "owned viewer nodes do not consume the authored match limit");
  await dismiss();
  await page.evaluate(() => document.body.append(document.createElement("div")));
  viewer = await show("exclusion", all);
  assert.match(await viewer.locator('[role="status"]').textContent(), /Too many matches/);
  assert.equal(await viewer.locator(".outline").count(), 0, "overflow never shows an incomplete group");
  await dismiss();
  const focused = locator => locator.evaluate(node => node === document.activeElement);
  const focusRules = ["alpha", "beta", "gamma"].map(value => ({ path: [`#${value}`], label: "section", name: value }));
  const replaceProfile = async fields => {
    assert.equal((await send({ type: "hdm-library-import", sites: [{ ...saved, exclusions: [], inclusions: [], protections: [], ...fields }] })).ok, true);
  };
  for (const [mode, field, prefix] of [["page", "exclusions", "exclusion"], ["selected", "inclusions", "exclusion"], ["selected", "protections", "protection"]]) {
    await replaceProfile({ mode, [field]: focusRules });
    const list = popup.locator(`#${prefix}-list`);
    await list.locator(":scope > .exclusion-row").last().waitFor({ state: "attached" });
    await popup.locator(`#${prefix}-details`).evaluate(node => node.open = true);
    const remove = () => list.locator(":scope > .exclusion-row > .rule-heading > .remove-site-btn");
    await remove().first().focus(); await remove().first().press("Enter");
    await popup.waitForFunction(id => document.getElementById(id).children.length === 2, `${prefix}-list`);
    assert.equal(await focused(remove().first()), true, `${field}: deleting the first row focuses the next remove action`);
    if (mode === "page" && process.env.HDM_SCREENSHOT_DIR) {
      await popup.locator("body").screenshot({ path: `${process.env.HDM_SCREENSHOT_DIR}/keyboard-focus.png` });
    }
    await remove().last().focus(); await remove().last().press("Enter");
    await popup.waitForFunction(id => document.getElementById(id).children.length === 1, `${prefix}-list`);
    assert.equal(await focused(remove().first()), true, `${field}: deleting the last row focuses the preceding remove action`);
    await remove().first().press("Enter");
    await popup.waitForFunction(id => document.getElementById(id).children.length === 0, `${prefix}-list`);
    assert.equal(await focused(popup.locator("#pick-element")), true, `${field}: an empty list returns focus to the picker`);
  }
  await replaceProfile({ mode: "selected", inclusions: [{ ...parent, protections: focusRules }] });
  const rootRow = popup.locator("#exclusion-list > .exclusion-row").first();
  await popup.locator("#exclusion-details").evaluate(node => node.open = true);
  const rootSettings = rootRow.locator(":scope > .rule-settings-btn");
  if (await rootSettings.getAttribute("aria-expanded") !== "true") await rootSettings.click();
  const childRows = rootRow.locator(".rule-child-list > .exclusion-row");
  await childRows.first().locator(":scope > .rule-settings-btn").click();
  await childRows.first().locator(".rule-name").fill("Temporary label");
  await replaceProfile({ mode: "selected", inclusions: [{ ...parent, protections: focusRules.slice(1) }] });
  await popup.waitForFunction(() => document.querySelector(".rule-child-list").children.length === 2);
  assert.equal(await focused(childRows.first().locator(":scope > .rule-settings-btn")), true, "removing a focused nested input selects a visible neighboring control");
  await childRows.first().locator(":scope > .rule-settings-btn").click();
  await childRows.first().locator(".rule-name").focus();
  await replaceProfile({ mode: "selected", inclusions: [{ ...parent, protections: [] }] });
  await popup.waitForFunction(() => document.querySelector(".rule-child-list").hidden);
  assert.equal(await focused(rootSettings), true, "removing every nested exception returns focus to its parent settings");
  await replaceProfile({ mode: "page", exclusions: focusRules });
  const languageButton = popup.locator('#language-select');
  await languageButton.focus();
  assert.equal((await send({ type: "hdm-exclusion-remove", origin, path: focusRules[0].path })).ok, true);
  await popup.waitForFunction(() => document.querySelector("#exclusion-list").children.length === 2);
  assert.equal(await focused(languageButton), true, "a background deletion does not steal focus from another control");
  await replaceProfile({ mode: "page", exclusions: focusRules });
  await popup.locator("#exclusion-details").evaluate(node => node.open = true);
  await popup.evaluate(() => {
    window.originalSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (...args) => {
      const reply = window.originalSend(...args);
      return args[0]?.type === "hdm-exclusion-remove"
        ? new Promise(resolve => { window.releaseDeletionReply = () => reply.then(resolve); }) : reply;
    };
  });
  const pendingRemove = popup.locator("#exclusion-list > .exclusion-row > .rule-heading > .remove-site-btn").first();
  await pendingRemove.focus(); await pendingRemove.press("Enter");
  await popup.waitForFunction(() => document.querySelector("#exclusion-list").children.length === 2);
  await languageButton.focus();
  await popup.evaluate(async () => {
    await window.releaseDeletionReply();
    await new Promise(resolve => requestAnimationFrame(resolve));
    chrome.runtime.sendMessage = window.originalSend;
    delete window.originalSend; delete window.releaseDeletionReply;
  });
  assert.equal(await focused(languageButton), true, "a late deletion reply does not steal a newly chosen focus target");
  await replaceProfile({ enabled: false, mode: "page", exclusions: [focusRules[0]] });
  const pausedRemove = popup.locator("#exclusion-list > .exclusion-row > .rule-heading > .remove-site-btn");
  await pausedRemove.focus(); await pausedRemove.press("Enter");
  await popup.waitForFunction(() => document.querySelector("#exclusion-list").children.length === 0);
  assert.equal(await focused(popup.locator('[data-mode="page"]')), true, "a paused site skips its disabled picker when the rule list empties");
  await replaceProfile({ enabled: true, mode: "selected", inclusions: [parent] });
  await popup.locator("#exclusion-details").evaluate(node => node.open = true);
  const disappearingRule = popup.locator("#exclusion-list > .exclusion-row");
  await disappearingRule.locator(":scope > .rule-settings-btn").click();
  await disappearingRule.locator(":scope > .rule-settings > .rule-name-form > .rule-name").focus();
  assert.equal((await send({ type: "hdm-universal-remove-site", origin })).ok, true);
  await popup.waitForFunction(() => document.querySelector("#exclusions").hidden);
  assert.equal(await focused(popup.locator("#current-site-action")), true, "removing the current profile elsewhere returns focus to Add site");
  assert.equal((await send({ type: "hdm-universal-add-site", url: page.url() })).ok, true);
  for (const url of ["https://alpha.test", "https://zulu.test"]) assert.equal((await send({ type: "hdm-universal-add-site", url })).ok, true);
  await popup.evaluate(() => chrome.storage.sync.set({ librarySort: "alphabetical" }));
  await popup.waitForFunction(() => document.querySelector("#library-list").children.length === 3);
  const libraryRemove = () => popup.locator("#library-list .remove-site-btn");
  await libraryRemove().first().focus(); await libraryRemove().first().press("Enter");
  await popup.waitForFunction(() => document.querySelector("#library-list").children.length === 2);
  assert.equal(await focused(libraryRemove().first()), true, "library deletion focuses the next remove action");
  await libraryRemove().last().focus(); await libraryRemove().last().press("Enter");
  await popup.waitForFunction(() => document.querySelector("#library-list").children.length === 1);
  assert.equal(await focused(libraryRemove().first()), true, "library deletion focuses the preceding remove action at the end");
  await libraryRemove().first().press("Enter");
  await popup.waitForFunction(() => document.querySelector("#library-list").children.length === 0);
  assert.equal(await focused(popup.locator("#library-sort")), true, "an empty library returns focus to its toolbar");
  console.log("PASS keyboard deletion retains neighboring focus across rule families, nested exceptions and the library");

  assert.equal((await send({ type: "hdm-universal-add-site", url: page.url() })).ok, true);
  assert.equal((await send({ type: "hdm-universal-set-mode", origin, mode: "selected" })).ok, true);
  assert.equal((await send({ type: "hdm-inversion-save", origin, rule: parent })).ok, true);
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extension}/options/options.html`);
  await optionsPage.evaluate(() => { HdmBackup.save = async () => { throw Error("export unavailable"); }; });
  await optionsPage.locator("#export").click();
  await optionsPage.locator("#status.error").waitFor();
  const languageTrigger = popup.locator("#language-select"), languageMenu = popup.locator("#language-menu");
  await languageTrigger.press("ArrowDown");
  await popup.keyboard.press("Home");
  await popup.keyboard.press("ArrowDown");
  await popup.keyboard.press("Enter");
  await popup.waitForFunction(() => document.documentElement.lang === "en");
  assert.equal(await languageTrigger.getAttribute("aria-expanded"), "false");
  for (const language of ["de", "en", "es", "ru", "uk"]) {
    harness.deadline();
    await languageTrigger.click();
    await languageMenu.locator(`[data-language="${language}"]`).click();
    await popup.waitForFunction(language => document.documentElement.lang === language, language);
    await optionsPage.waitForFunction(language => document.documentElement.lang === language, language);
    assert.equal(await languageTrigger.getAttribute("aria-expanded"), "false");
    assert.equal(await focused(languageTrigger), true);
    assert.equal(await popup.locator("#language-label").textContent(), language.toUpperCase());
    assert.deepEqual(await languageMenu.locator('[aria-checked="true"]').evaluateAll(rows => rows.map(row => row.dataset.language)), [language]);
    await languageTrigger.press("ArrowDown");
    assert.equal(await focused(languageMenu.locator(`[data-language="${language}"]`)), true);
    await popup.keyboard.press("Home");
    assert.equal(await focused(languageMenu.locator('[data-language="de"]')), true);
    await popup.keyboard.press("End");
    assert.equal(await focused(languageMenu.locator('[data-language="uk"]')), true);
    await popup.keyboard.press("ArrowDown");
    assert.equal(await focused(languageMenu.locator('[data-language="de"]')), true);
    await popup.keyboard.press("Escape");
    assert.equal(await focused(languageTrigger), true);
    assert.equal(await languageTrigger.evaluate(node => node.value), language, "navigation must not commit a language");
    await languageTrigger.press("Space");
    await popup.keyboard.press("Tab");
    assert.equal(await languageTrigger.getAttribute("aria-expanded"), "false");
    assert.equal(await focused(popup.locator("#current-site-enabled")), true, "Tab resumes at the next page control");
    await languageTrigger.click();
    await popup.locator("#library-sort").click();
    assert.equal(await languageTrigger.getAttribute("aria-expanded"), "false");
    assert.equal(await popup.locator("#library-sort").getAttribute("aria-expanded"), "true");
    await popup.keyboard.press("Escape");
    const expected = await popup.evaluate(language => ({ popup: HdmPopupText.messages[language] }), language);
    assert.equal(await optionsPage.locator("#export").textContent(), expected.popup.backupExport);
    assert.equal(await optionsPage.locator("#status").textContent(), expected.popup.backupExportFailed);
    for (const mode of ["page", "selected"]) {
      assert.equal((await send({ type: "hdm-universal-set-mode", origin, mode })).ok, true);
      await popup.waitForFunction(mode => document.querySelector(`[data-mode="${mode}"]`).getAttribute("aria-pressed") === "true", mode);
      await popup.locator("#pick-element").click();
      const picker = page.locator('[data-hdm-picker=""]');
      await picker.waitFor();
      assert.equal(await picker.getAttribute("lang"), language);
      const text = editorText.picker(language, mode === "selected");
      assert.equal(await picker.locator(".title").textContent(), text.title);
      assert.equal(await picker.locator("#picker-status").textContent(), text.hint);
      await picker.getByRole("button", { name: text.cancel, exact: true }).click();
      await picker.waitFor({ state: "detached" });
    }
    await popup.evaluate(({ rule, language }) => model.showRule("inversion", rule, language), { rule: parent, language });
    const viewer = page.locator("[data-hdm-matches]");
    await viewer.waitFor();
    assert.equal(await viewer.getAttribute("lang"), language);
    const matchText = editorText.matches(language);
    assert.equal(await viewer.getByRole("button", { name: matchText.previous, exact: true }).count(), 1);
    await viewer.getByRole("button", { name: matchText.close, exact: true }).click();
    await viewer.waitFor({ state: "detached" });
    await popup.reload();
    await popup.waitForFunction(language => document.documentElement.lang === language, language);
    assert.equal(await popup.locator("#language-select").evaluate(node => node.value), language);
  }
  await optionsPage.evaluate(() => { HdmBackup.save = async () => 7; });
  await optionsPage.locator("#export").click();
  await optionsPage.waitForFunction(() => !document.getElementById("status").classList.contains("error"));
  await popup.locator("#current-site-action").click();
  await popup.locator("#toast-action").waitFor({ state: "visible" });
  const undoTimer = await popup.evaluate(() => toastTimer);
  for (const language of ["de", "en", "es", "ru", "uk"]) {
    await popup.evaluate(language => chrome.storage.sync.set({ language }), language);
    await popup.waitForFunction(language => document.documentElement.lang === language, language);
    await optionsPage.waitForFunction(language => document.documentElement.lang === language, language);
    const text = await popup.evaluate(() => ({ removed: translate("siteRemoved"), undo: translate("undo"),
      exported: translate("backupExported", { count: 7 }) }));
    assert.equal(await popup.locator("#toast-text").textContent(), text.removed);
    assert.equal(await popup.locator("#toast-action").textContent(), text.undo);
    assert.equal(await popup.evaluate(() => toastTimer), undoTimer, "translation does not extend the Undo deadline");
    assert.equal(await optionsPage.locator("#status").textContent(), text.exported);
  }
  await popup.locator("#toast-action").click();
  await popup.waitForFunction(() => document.getElementById("toast-text").textContent === translate("siteRestored"));
  assert.equal((await stored()).inclusions[0].path[0], "#workspace", "translated Undo retains its original action");
  if (!await popup.locator("#exclusion-details").evaluate(node => node.open)) {
    await popup.locator("#exclusion-details > summary").click();
  }
  const row = popup.locator("#exclusion-list > .exclusion-row").first();
  if (await row.locator(":scope > .rule-settings-btn").getAttribute("aria-expanded") !== "true") {
    await row.locator(":scope > .rule-settings-btn").click();
  }
  await popup.evaluate(() => { window.originalShowRule = model.showRule; model.showRule = async () => { throw Error("settings_changed"); }; });
  try {
    await row.locator(":scope > .rule-settings > .rule-show").click();
    await popup.waitForFunction(() => document.getElementById("toast-text").textContent === translate("matchesFailed"));
    for (const language of ["de", "en", "es", "ru", "uk"]) {
      await popup.evaluate(language => chrome.storage.sync.set({ language }), language);
      await popup.waitForFunction(language => document.documentElement.lang === language, language);
      assert.equal(await popup.locator("#toast-text").textContent(), await popup.evaluate(() => translate("matchesFailed")));
    }
  } finally { await popup.evaluate(() => { model.showRule = window.originalShowRule; delete window.originalShowRule; }); }
  console.log("PASS localized errors, result counts and Undo retain their meaning and lifetime across language changes");
  await optionsPage.close();
  const earlyPopup = await context.newPage();
  await earlyPopup.addInitScript(() => {
    const read = chrome.storage.sync.get.bind(chrome.storage.sync);
    chrome.storage.sync.get = async defaults => {
      const saved = await read(defaults);
      await new Promise(resolve => { window.releaseInitialSettings = resolve; });
      return saved;
    };
  });
  await earlyPopup.goto(`chrome-extension://${extension}/popup/popup.html`);
  await earlyPopup.waitForFunction(() => Boolean(window.releaseInitialSettings));
  await earlyPopup.locator("#language-select").click();
  await earlyPopup.locator('[data-language="de"]').click();
  await earlyPopup.waitForFunction(() => document.documentElement.lang === "de");
  await earlyPopup.evaluate(() => window.releaseInitialSettings());
  await earlyPopup.waitForFunction(() => document.getElementById("current-site-status").textContent !== HdmPopupText.translate("de", "loading"));
  assert.equal(await earlyPopup.locator("#language-select").evaluate(node => node.value), "de");
  await earlyPopup.close();
  console.log("PASS five-language menu navigation, dismissal, persisted choice, options, editor and match viewer");
  assert.deepEqual(errors, [], "rule management produces no page errors");
  console.log("PASS exact match-budget boundary excludes owned nodes and fails closed on authored overflow");
});
