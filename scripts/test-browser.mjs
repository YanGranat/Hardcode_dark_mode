import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createBrowserHarness } from "./support/browser.mjs";
let context;
let port;
const fixture = (parent) => `<!doctype html><html><head><title>Dark mode test</title>
<style>body{font:20px sans-serif;background:white;color:black;margin:24px}canvas,video{width:200px;height:100px}#long{height:1400px}</style></head><body>
<h1>Dark mode test</h1><p>Readable text and ordinary controls</p><input value="Native input"><canvas id="canvas" width="200" height="100"></canvas>
<img id="image" width="80" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='80' height='80' fill='red'/%3E%3C/svg%3E">
<div id="background" style="background-image:linear-gradient(red,red)"><img id="nested" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='red'/%3E%3C/svg%3E"></div>
<video id="video" muted autoplay></video><button id="fullscreen">Fullscreen</button><div id="shadow"></div>
${parent ? `<iframe id="child" src="http://localhost:${port}/child"></iframe><iframe id="blank" src="about:blank"></iframe>` : ""}
<div id="long"></div><script>
const canvas=document.getElementById('canvas'), ctx=canvas.getContext('2d');
ctx.fillStyle='red';ctx.fillRect(0,0,200,100);ctx.fillStyle='black';ctx.fillRect(10,10,40,40);
const video=document.getElementById('video');video.srcObject=canvas.captureStream(10);video.play();
document.getElementById('fullscreen').onclick=()=>video.requestFullscreen();
</script></body></html>`;
const server = http.createServer((req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(fixture(req.url === "/")); });
const harness = createBrowserHarness({ server, viewport: { width: 1000, height: 800 }, timeout: 90000 });
const state = (page) => page.evaluate(() => ({
  filter: getComputedStyle(document.documentElement).filter,
  scheme: getComputedStyle(document.documentElement).colorScheme,
  classes: document.documentElement.className
}));
const dark = async (page, expected = true) => {
  await page.waitForFunction((wanted) => (getComputedStyle(document.documentElement).filter !== "none") === wanted, expected);
};
await harness.run(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  context = await harness.launch();
  harness.deadline();
  console.log("Chromium", context.browser().version());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(worker.url()).host;
  let popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  const send = async (message) => {
    const result = await popup.evaluate((msg) => chrome.runtime.sendMessage(msg), message);
    assert.equal(result?.ok, true, JSON.stringify(result));
    assert.equal(result.warning ?? null, null);
    return result;
  };
  const add = (url) => send({ type: "hdm-universal-add-site", url });
  const remove = (origin) => send({ type: "hdm-universal-remove-site", origin });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  let child = page.frames().find((frame) => frame.url().includes("localhost"));
  await add(page.url());
  await dark(page); await dark(child, false);
  const blank = page.frames().find((frame) => frame.url() === "about:blank");
  await dark(blank);
  await page.reload();
  await dark(page);
  child = page.frames().find((frame) => frame.url().includes("localhost"));
  await dark(child, false);
  await dark(page.frames().find((frame) => frame.url() === "about:blank"));
  console.log("PASS immediate/reload frame scope, including related about:blank");
  harness.deadline();

  await add(`http://localhost:${port}/child`);
  await dark(child);
  await remove("http://127.0.0.1");
  await dark(page, false); await dark(child);
  await remove("http://localhost");
  await dark(child, false);
  console.log("PASS independently enabled child survives parent removal; embedded removal applies immediately");
  harness.deadline();

  await add(page.url());
  await page.evaluate(() => { document.documentElement.className = "site-replaced-root"; });
  await dark(page);
  assert.equal(await page.locator("#canvas").evaluate((el) => getComputedStyle(el).filter), "none");
  assert.equal(await page.locator("#nested").evaluate((el) => getComputedStyle(el).filter), "none");
  await page.evaluate(() => {
    const root = document.getElementById("shadow").attachShadow({ mode: "open" });
    root.innerHTML = '<img id="late" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"><div id="inner"></div>';
  });
  await page.locator("#late").waitFor();
  await page.waitForFunction(() => getComputedStyle(document.getElementById("shadow").shadowRoot.querySelector("img")).filter !== "none");
  await page.evaluate(() => {
    document.getElementById("shadow").shadowRoot.getElementById("inner").attachShadow({ mode: "open" }).innerHTML = '<img id="deeper">';
  });
  await page.waitForFunction(() => getComputedStyle(document.getElementById("shadow").shadowRoot.getElementById("inner").shadowRoot.querySelector("img")).filter !== "none");
  console.log("PASS root replacement, canvas, nested media, late/nested open Shadow DOM");
  harness.deadline();

  await page.bringToFront();
  await page.locator("#fullscreen").click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  assert.equal(await page.locator("#video").evaluate((el) => getComputedStyle(el).filter), "none");
  await page.screenshot({ path: path.join(harness.scratch, "fullscreen.png") });
  if (process.env.HDM_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.HDM_SCREENSHOT_DIR, { recursive: true });
    fs.copyFileSync(path.join(harness.scratch, "fullscreen.png"), path.join(process.env.HDM_SCREENSHOT_DIR, "fullscreen.png"));
  }
  await page.evaluate(() => document.exitFullscreen());
  await page.evaluate(() => window.scrollTo(0, 500));
  assert.equal(await page.evaluate(() => scrollY), 500);
  assert.equal(await page.locator("#video").evaluate((el) => el.paused), false);
  console.log("PASS fullscreen video filter, playback and scrolling");
  harness.deadline();

  await page.evaluate(() => { document.documentElement.style.background = 'rgb(200, 100, 50)'; document.body.style.background = 'transparent'; });
  await remove("http://127.0.0.1"); await add(page.url());
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), "rgb(200, 100, 50)");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgba(0, 0, 0, 0)");
  console.log("PASS transparent body preserves existing html background");
  harness.deadline();

  await popup.locator('#language-select').click();
  await popup.locator('[data-language="ru"]').click();
  await popup.waitForFunction(() => document.documentElement.lang === "ru");
  await popup.evaluate(async () => {
    const pending = [], save = model.saveSettings;
    model.saveSettings = patch => { const result = save(patch); pending.push(result); return result; };
    try {
      document.querySelector('[data-language="en"]').click();
      document.querySelector('[data-language="ru"]').click();
      await Promise.all(pending);
    } finally { model.saveSettings = save; }
  });
  await popup.waitForFunction(async () => (await chrome.storage.sync.get("language")).language === "ru");
  assert.equal((await state(page)).filter, "invert(0.9) hue-rotate(180deg)");
  await popup.reload();
  await popup.waitForFunction(() => document.documentElement.lang === "ru");
  assert.equal(await popup.locator('[data-language="ru"]').getAttribute("aria-checked"), "true");
  assert.equal(await popup.locator('#toggle-deepl, #toggle-google, [data-theme]').count(), 0);
  console.log("PASS popup language persistence, rapid changes and library-only theme controls");
  harness.deadline();

  assert.equal(await worker.evaluate(() => (chrome.runtime.getManifest().content_scripts || []).length), 0);
  const universalFilter = "invert(0.9) hue-rotate(180deg)";
  for (const url of ["https://www.deepl.com/translator", "https://translate.google.com/"]) {
    harness.deadline();
    const origin = new URL(url).origin;
    const pattern = origin + "/**";
    await context.route(pattern, route => route.fulfill({ contentType: "text/html", body: fixture(false) }));
    await popup.evaluate(() => chrome.storage.sync.set({ deepl: true, googleTranslate: true, theme: "soft" }));
    const retired = await context.newPage();
    await retired.goto(url);
    await dark(retired, false);
    assert.equal((await state(retired)).classes, "");
    assert.notEqual((await state(retired)).scheme, "dark");

    // Substitute only the active-tab lookup; storage, runtime messages,
    // registrations and page application remain the real extension APIs.
    const tab = await popup.evaluate(async currentUrl => (await chrome.tabs.query({})).find(entry => entry.url === currentUrl), url);
    const sitePopup = await context.newPage();
    await sitePopup.addInitScript(currentTab => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = options => options.active ? Promise.resolve([currentTab]) : query(options);
    }, tab);
    await sitePopup.goto(`chrome-extension://${id}/popup/popup.html`);
    await sitePopup.locator("#current-site-action").click();
    await dark(retired);
    await sitePopup.waitForFunction(() => !model.isPending());
    await sitePopup.waitForFunction(() => !document.getElementById("pick-element").disabled && !document.getElementById("exclusions").hidden);
    assert.equal((await state(retired)).filter, universalFilter);
    assert.equal(await retired.locator("#canvas").evaluate(el => getComputedStyle(el).filter), "none");
    assert.equal(await retired.locator("body").evaluate(el => getComputedStyle(el).scrollbarColor), "auto");
    await retired.reload(); await dark(retired);
    assert.equal((await state(retired)).filter, universalFilter);
    await popup.evaluate(() => chrome.storage.sync.set({ deepl: false, googleTranslate: false, theme: "deep" }));
    await retired.evaluate(() => { document.documentElement.className = "site-hydration"; });
    await dark(retired);
    assert.equal((await state(retired)).filter, universalFilter);
    assert.doesNotMatch((await state(retired)).classes, /dmx-hardcoded|dmx-theme-/);

    const siteSwitch = sitePopup.locator(`#library-list [data-origin="${origin}"] .switch`);
    await siteSwitch.click();
    await dark(retired, false);
    await sitePopup.waitForFunction(() => !model.isPending());
    await popup.evaluate(() => chrome.storage.sync.set({ deepl: true, googleTranslate: true }));
    await retired.reload(); await dark(retired, false);
    await siteSwitch.click();
    await dark(retired);
    await sitePopup.waitForFunction(() => !model.isPending());
    await sitePopup.locator("#current-site-action").click();
    await dark(retired, false);
    await sitePopup.waitForFunction(() => !model.isPending());
    await retired.reload(); await dark(retired, false);
    assert.equal((await state(retired)).classes, "");
    await sitePopup.close(); await retired.close();
    await context.unroute(pattern);
  }
  console.log("PASS legacy settings do not enable automatic themes; popup Add/exclusions/Pause/Enable/Remove and reload");
  harness.deadline();

  if (process.env.HDM_LIVE === "1") {
    for (const url of ["https://www.deepl.com/translator", "https://translate.google.com/"]) {
      harness.deadline();
      const live = await context.newPage();
      await live.goto(url, { waitUntil: "domcontentloaded" });
      await live.waitForTimeout(1500);
      assert.doesNotMatch((await state(live)).classes, /dmx-/);
      await add(url);
      await live.waitForFunction(() => document.documentElement.classList.contains("dmx-site-universal"));
      assert.equal((await state(live)).filter, universalFilter);
      await remove(new URL(url).origin);
      await live.waitForFunction(() => !document.documentElement.classList.contains("dmx-site-universal"));
      await live.close();
    }
    console.log("PASS live manual activation and removal");
  }
  await context.close();
  context = await harness.launch();
  harness.deadline();
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  const reopened = await context.newPage();
  await reopened.goto(`http://127.0.0.1:${port}/`);
  await dark(reopened);
  await send({ type: "hdm-universal-set-enabled", origin: "http://127.0.0.1", enabled: false });
  await dark(reopened, false);
  await reopened.reload(); await dark(reopened, false);
  await remove("http://127.0.0.1");
  assert.equal((await send({ type: "hdm-universal-get-sites" })).sites.length, 0);
  console.log("PASS browser restart, pause/reload/remove");
  harness.deadline();

  // Normal-tab UI exercise: substitute only which tab the popup considers
  // current. Runtime messages, storage and page application remain real.
  const tab = await popup.evaluate(async (url) => (await chrome.tabs.query({})).find((entry) => entry.url === url), reopened.url());
  await popup.addInitScript((currentTab) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (options) => options.active ? Promise.resolve([currentTab]) : query(options);
  }, tab);
  await popup.reload();
  assert.equal(await popup.locator('#current-site-switch').isVisible(), false);
  await popup.locator("#current-site-action").click();
  await dark(reopened);
  assert.equal(await popup.locator('#current-site-enabled').isChecked(), true);
  await popup.locator('#current-site-switch').click();
  await dark(reopened, false);
  assert.equal(await popup.locator('#library-list input').isChecked(), false);
  await popup.locator('#current-site-enabled').focus();
  await popup.keyboard.press('Space');
  await dark(reopened);
  assert.equal(await popup.locator('#library-list input').isChecked(), true);
  await popup.locator("#library-list .switch").click();
  await dark(reopened, false);
  assert.equal(await popup.locator('#current-site-enabled').isChecked(), false);
  await popup.locator("#library-list .switch").click();
  await dark(reopened);
  assert.equal(await popup.locator('#current-site-enabled').isChecked(), true);
  await popup.locator("#current-site-action").click();
  await dark(reopened, false);
  await popup.waitForFunction(() => document.getElementById("library-count").textContent === "0");
  assert.equal(await popup.locator('#current-site-switch').isVisible(), false);
  console.log("PASS popup Add / Pause / Enable / Remove with real worker and page updates");
  harness.deadline();

  await add(reopened.url());
  await add(`http://localhost:${port}/child`);
  await popup.waitForFunction(() => document.getElementById("library-count").textContent === "2");
  const responsiveWorker = context.serviceWorkers()[0];
  await responsiveWorker.evaluate(() => {
    const execute = chrome.scripting.executeScript.bind(chrome.scripting);
    chrome.scripting.executeScript = args => {
      if (!args.func) return execute(args);
      chrome.scripting.executeScript = execute;
      return new Promise(resolve => { globalThis.__hdmSlowToggle = resolve; });
    };
  });
  const inputResponse = await popup.evaluate(() => {
    const row = document.querySelector('[data-origin="http://127.0.0.1"]');
    const input = row.querySelector("input");
    input.focus();
    const started = performance.now();
    input.click();
    const afterFirst = input.checked;
    const current = document.getElementById("current-site-enabled");
    const mirroredFirst = current.checked === input.checked;
    const controlsActive = [...document.querySelectorAll("#library-list input, #library-list button, #current-site-action, #current-site-enabled")]
      .every(element => !element.disabled && getComputedStyle(element).pointerEvents !== "none");
    current.click(); current.click();
    document.querySelector('[data-origin="http://localhost"] button').click();
    return { afterFirst, finalChecked: input.checked, controlsActive, mirroredFirst, mirroredFinal: current.checked === input.checked,
      sameInput: row.querySelector("input") === input,
      focused: document.activeElement === input, count: document.getElementById("library-count").textContent,
      elapsed: performance.now() - started };
  });
  assert.equal(inputResponse.afterFirst, false);
  assert.equal(inputResponse.finalChecked, false);
  assert.equal(inputResponse.controlsActive, true);
  assert.equal(inputResponse.mirroredFirst, true);
  assert.equal(inputResponse.mirroredFinal, true);
  assert.equal(inputResponse.sameInput, true);
  assert.equal(inputResponse.focused, true);
  assert.equal(inputResponse.count, "1");
  await popup.waitForFunction(async () => {
    const { universalSites } = await chrome.storage.local.get("universalSites");
    return universalSites.length === 1 && universalSites[0].enabled === false;
  }, null, { timeout: 1000 });
  await dark(reopened, false);
  await responsiveWorker.evaluate(() => {
    if (!globalThis.__hdmSlowToggle) throw Error("Expected an outstanding renderer probe");
    globalThis.__hdmSlowToggle([]);
    delete globalThis.__hdmSlowToggle;
  });
  await popup.waitForFunction(() => !model.isPending());
  assert.equal(await popup.locator('#library-list input').isChecked(), false);
  await popup.locator("#current-site-action").click();
  await popup.waitForFunction(() => !model.isPending());
  console.log(`PASS immediate toggles/independent removal/focus: four actions in ${inputResponse.elapsed.toFixed(1)}ms; saves before slow renderer reply`);
  harness.deadline();

  const activeWorker = context.serviceWorkers()[0];
  await activeWorker.evaluate(() => {
    const execute = chrome.scripting.executeScript.bind(chrome.scripting);
    chrome.scripting.executeScript = (args) => {
      if (args.func) {
        chrome.scripting.executeScript = execute;
        return new Promise(resolve => { globalThis.__hdmReleaseProbe = resolve; });
      }
      return execute(args);
    };
  });
  await popup.locator("#current-site-action").click();
  await popup.waitForFunction(async () => (await chrome.storage.local.get("universalSites")).universalSites.length === 1);
  await popup.reload();
  await popup.waitForFunction(() => document.getElementById("library-count").textContent === "1");
  assert.equal(await popup.locator("#current-site-action").isEnabled(), true);
  assert.equal(await popup.locator('[data-language="ru"]').getAttribute("aria-checked"), "true");
  await popup.locator("#current-site-action").click();
  await popup.waitForFunction(async () => (await chrome.storage.local.get("universalSites")).universalSites.length === 0, null, { timeout: 1000 });
  await activeWorker.evaluate(() => {
    globalThis.__hdmReleaseProbe([{ documentId: "expired-test-document", result: "http://127.0.0.1/" }]);
    delete globalThis.__hdmReleaseProbe;
  });
  await popup.reload();
  await popup.waitForFunction(() => !document.getElementById("current-site-action").disabled);
  assert.equal(await popup.locator("#library-count").textContent(), "0");
  await dark(reopened, false);
  await popup.locator("#current-site-action").click();
  await dark(reopened);
  await popup.locator("#current-site-action").click();
  await dark(reopened, false);
  console.log("PASS stalled renderer: reopen popup, saved settings/library, remove, late result and subsequent add/remove");
  harness.deadline();

  await popup.waitForFunction(() => !model.isPending());
  await popup.evaluate(() => {
    chrome.runtime.sendMessage = () => new Promise(() => {});
  });
  await popup.locator("#current-site-action").click();
  assert.equal(await popup.locator("#current-site-action").isEnabled(), true);
  await popup.locator("#current-site-action").click();
  assert.equal(await popup.locator("#current-site-action").isEnabled(), true);
  await popup.waitForFunction(() => !model.isPending(), null, { timeout: 18000 });
  assert.match(await popup.locator("#toast").textContent(), /Ответ не получен|No response yet/);
  await popup.reload();
  await popup.waitForFunction(() => !document.getElementById("current-site-action").disabled);
  assert.equal(await popup.locator("#library-count").textContent(), "0");
  console.log("PASS lost runtime response leaves controls responsive and reconciles unconfirmed changes");
});
