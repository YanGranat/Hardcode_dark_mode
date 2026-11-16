import assert from "node:assert/strict";
import http from "node:http";
import { createBrowserHarness } from "./support/browser.mjs";

const server = http.createServer((_, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end('<!doctype html><html><head><style>html,body{margin:0}body{min-height:100vh}iframe{width:100px;height:100px;border:0}</style></head><body><div id="work" style="width:400px;height:200px;background:white"><span id="keep">keep</span></div><iframe src="about:blank"></iframe></body></html>');
});
const harness = createBrowserHarness({ server, headless: true, name: "Document lifecycle", timeout: 60000 });
await harness.run(async () => {
  harness.deadline();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const context = await harness.launch();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  let popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  // The same server under another host name is a site that is never added to the library.
  // It is opened first: the themed page must stay the foreground tab, or its frames slow down.
  const outsider = await context.newPage();
  await outsider.goto(`http://localhost:${server.address().port}`);
  await outsider.evaluate(() => {
    window.extensionTraces = [];
    for (const type of ["hdm-controller-replace", "hdm-shadow-root", "hdm-shadow-enable", "hdm-shadow-disable"]) {
      document.addEventListener(type, () => window.extensionTraces.push(type), true);
    }
    new MutationObserver(records => window.extensionTraces.push(...records.map(record => record.type)))
      .observe(document, { subtree: true, childList: true, attributes: true });
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const send = async message => {
    const response = await popup.evaluate(message => chrome.runtime.sendMessage(message), message);
    assert.equal(response.ok, true, response.error);
  };
  await send({ type: "hdm-universal-add-site", url: page.url() });
  await page.waitForFunction(() => document.documentElement.classList.contains("dmx-on"));
  const shim = '[data-hdm-universal-body-style]';
  assert.equal(await page.locator(shim).count(), 1);
  const blank = page.frames().find(frame => frame.url() === "about:blank");
  await blank.waitForFunction(() => document.documentElement.classList.contains("dmx-on"));
  assert.equal(await blank.locator(shim).count(), 0, "transparent embedded frames retain their canvas");
  for (const target of ["body", "html"]) {
    await page.evaluate(target => document.querySelector(target).style.backgroundColor = "rgb(12, 34, 56)", target);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator(shim).count(), 0, "a site-owned background replaces the provisional canvas");
    assert.equal(await page.locator(target).evaluate(element => getComputedStyle(element).backgroundColor), "rgb(12, 34, 56)");
    await page.evaluate(target => document.querySelector(target).style.removeProperty("background-color"), target);
    await page.waitForFunction(() => !!document.querySelector('[data-hdm-universal-body-style]'));
    await page.evaluate(target => document.querySelector(target).style.backgroundColor = "color(srgb .1 .2 .3 / 0)", target);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator(shim).count(), 1, "zero-alpha colors retain the transparent canvas fallback");
    await page.evaluate(target => document.querySelector(target).style.removeProperty("background-color"), target);
  }
  await page.evaluate(() => {
    const style = document.createElement("style"); style.id = "late-theme";
    style.textContent = "body{background:#123456}"; document.head.append(style);
  });
  await page.waitForFunction(() => !document.querySelector('[data-hdm-universal-body-style]'));
  await page.locator("#late-theme").evaluate(element => element.remove());
  await page.waitForFunction(() => !!document.querySelector('[data-hdm-universal-body-style]'));
  console.log("PASS late site backgrounds and transparent embedded canvases");
  await page.emulateMedia({ media: "print" });
  assert.equal(await page.locator("html").evaluate(element => getComputedStyle(element).filter), "none");
  assert.equal(await page.locator("html").evaluate(element => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)");
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => {
    const root = document.createElement("html");
    root.innerHTML = '<head><style>html,body{margin:0}body{min-height:100vh}</style></head><body><div id="work" style="width:400px;height:200px;background:white"><span id="keep">keep</span></div></body>';
    document.replaceChild(root, document.documentElement);
  });
  await page.waitForFunction(() => document.documentElement.classList.contains("dmx-on"));
  await page.evaluate(() => { document.documentElement.className = "site-restored"; document.body.style.backgroundColor = "#123456"; });
  await page.waitForFunction(() => document.documentElement.classList.contains("dmx-on") && !document.querySelector('[data-hdm-universal-body-style]'));
  console.log("PASS root replacement rebinds marker and background observers");

  const tabId = await popup.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, page.url());
  await popup.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId }, func: () => {
    globalThis.__hdmMediaQueries = [];
    for (const type of [Document, Element, ShadowRoot]) {
      const query = type.prototype.querySelectorAll;
      type.prototype.querySelectorAll = function(selector) {
        if (selector === 'img, video, iframe, [style*="background-image"]') globalThis.__hdmMediaQueries.push(this === document ? "document" : this.id || this.host?.id || this.localName);
        return query.call(this, selector);
      };
    }
  } }), tabId);

  await send({ type: "hdm-universal-set-mode", origin: "http://127.0.0.1", mode: "selected" });
  await send({ type: "hdm-inversion-save", origin: "http://127.0.0.1", rule: { path: ["#work"], label: "work", protections: [{ path: ["#keep"], label: "keep" }] } });
  await page.waitForFunction(() => document.getElementById("work").hasAttribute("data-hdm-cutout"));
  const queries = () => popup.evaluate(async tabId => (await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__hdmMediaQueries }))[0].result, tabId);
  assert((await queries()).includes("work"));
  assert(!(await queries()).includes("document"), "selected media searches stay inside selected branches");
  const before = (await queries()).length;
  await page.evaluate(() => { const node = document.createElement("div"); node.id = "unrelated"; document.body.append(node); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const afterInsert = (await queries()).length;
  assert(afterInsert >= before);
  await page.evaluate(() => document.getElementById("unrelated").classList.toggle("unrelated-state"));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal((await queries()).length, afterInsert, "ID-only rules do not repaint for unrelated class changes");
  console.log("PASS selected media traversal and selector-dependent invalidation");
  // Count owned DOM writes over real rendering frames, not just the final state.
  await page.evaluate(() => { window.ownedWrites = 0; window.probe = new MutationObserver(records => { window.ownedWrites += records.filter(record => record.target.closest?.('[data-hdm-filter-resources]') || record.attributeName?.startsWith('data-hdm-')).length; }); window.probe.observe(document, { subtree: true, attributes: true, childList: true }); });
  await page.evaluate(() => new Promise(resolve => { let frames = 0; function next() { if (++frames === 12) resolve(); else requestAnimationFrame(next); } requestAnimationFrame(next); }));
  assert.equal(await page.evaluate(() => { window.probe.disconnect(); return window.ownedWrites; }), 0);
  console.log("PASS unchanged protected geometry performs no DOM writes");

  for (const [attribute, path, value] of [
    ["class", '[cl\\61 ss~="enabled"]', "enabled"],
    ["id", '[i\\64="identified"]', "identified"],
    ["data-state", '[data-state="ready"]', "ready"],
    ["title", '[ti\\74 le="ready"]', "ready"],
    ["style", '[style*="outline-color"]', "width:100px;height:100px;background:white;outline-color:red"],
  ]) {
    await page.evaluate(() => { const node = document.createElement("section"); node.id = "dependency"; node.style.cssText = "width:100px;height:100px;background:white"; document.body.append(node); });
    const target = await page.locator("#dependency").elementHandle();
    await send({ type: "hdm-inversion-save", origin: "http://127.0.0.1", rule: { path: [path], label: "section" } });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator("#dependency").evaluate((node, { attribute, value }) => node.setAttribute(attribute, value), { attribute, value });
    assert.equal(await page.locator(path).count(), 1, `native selector must match after changing ${attribute}: ${path}`);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator(path).getAttribute("data-hdm-inverted"), "root", `attribute changes update a saved selector's match: ${path}`);
    await page.locator(path).evaluate((node, attribute) => node.removeAttribute(attribute), attribute);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await target.getAttribute("data-hdm-inverted"), null,
      "a nonmatching attribute must release the selected rule");
    await target.evaluate(node => node.remove());
    await target.dispose();
    await send({ type: "hdm-inversion-remove", origin: "http://127.0.0.1", path: [path] });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  const current = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "hdm-universal-get-sites" }));
  const previousRule = current.sites.find(site => site.origin === "http://127.0.0.1").inclusions.find(rule => rule.path[0] === "#work");
  await send({ type: "hdm-inversion-save", origin: "http://127.0.0.1", previousRule,
    rule: { ...previousRule, protections: [{ path: ['[data-original="yes"]'] }] } });
  await page.waitForFunction(() => !document.getElementById("work").hasAttribute("data-hdm-cutout"));
  await page.evaluate(() => document.getElementById("keep").setAttribute("data-original", "yes"));
  await page.waitForFunction(() => document.getElementById("work").getAttribute("data-hdm-cutout") === "mask");
  await page.evaluate(() => document.getElementById("keep").removeAttribute("data-original"));
  await page.waitForFunction(() => !document.getElementById("work").hasAttribute("data-hdm-cutout"));
  await send({ type: "hdm-universal-set-mode", origin: "http://127.0.0.1", mode: "page" });
  await send({ type: "hdm-exclusion-add", origin: "http://127.0.0.1", rule: { path: ['[data-exempt="yes"]'] } });
  await page.evaluate(() => document.getElementById("keep").setAttribute("data-exempt", "yes"));
  await page.waitForFunction(() => document.getElementById("keep").getAttribute("data-hdm-excluded") === "root");
  await page.evaluate(() => document.getElementById("keep").removeAttribute("data-exempt"));
  await page.waitForFunction(() => !document.getElementById("keep").hasAttribute("data-hdm-excluded"));
  await send({ type: "hdm-universal-set-mode", origin: "http://127.0.0.1", mode: "selected" });
  console.log("PASS attribute and inline-style selectors update and release matches in both modes");

  await page.evaluate(() => { window.documentToken = crypto.randomUUID(); });
  const token = await page.evaluate(() => window.documentToken);
  const extension = `chrome-extension://${new URL(worker.url()).host}`;
  const detail = await context.newPage();
  await detail.goto(`chrome://extensions/?id=${new URL(worker.url()).host}`);
  const developer = detail.locator("#devMode");
  if (!(await developer.evaluate(element => element.checked))) await developer.click();
  await detail.locator("extensions-detail-view #dev-reload-button").click({ timeout: 5000 });
  popup = await context.newPage();
  const retryUntil = Date.now() + 5000;
  while (true) {
    try { await popup.goto(`${extension}/popup/popup.html`); break; }
    catch (error) {
      const unavailable = error.message.includes("ERR_BLOCKED_BY_CLIENT") ||
        error.message.includes('is interrupted by another navigation to "chrome-error://chromewebdata/"');
      if (Date.now() >= retryUntil || !unavailable) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  await send({ type: "hdm-universal-set-enabled", origin: "http://127.0.0.1", enabled: false });
  await page.waitForFunction(() => !document.documentElement.classList.contains("dmx-on") && !document.querySelector("[data-hdm-cutout]"));
  await page.evaluate(() => { document.documentElement.classList.add("site-update"); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dmx-on")), false);
  assert.equal(await page.evaluate(() => window.documentToken), token, "extension replacement does not navigate the page");
  assert.deepEqual(pageErrors, [], "document lifecycle changes do not throw into the page");
  console.log("PASS native extension reload retires stale controllers before later toggles");
  assert.deepEqual(await outsider.evaluate(() => window.extensionTraces), [],
    "library changes and an extension reload send no event to a site outside the library and leave its page untouched");
  console.log("PASS a site outside the library observes nothing");
});
