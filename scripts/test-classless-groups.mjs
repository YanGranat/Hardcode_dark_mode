import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createBrowserHarness } from "./support/browser.mjs";
const graphic = id => `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" width="200" height="120" viewBox="0 0 200 120"><g id="drawing-${id}"><rect width="200" height="120" fill="#061e47"/><rect x="20" y="20" width="35" height="35" fill="#28e4bc"/></g></svg>`;
const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:white;font:16px sans-serif}#workspace{position:relative;margin:30px;width:650px;height:520px;background:white;padding:30px;box-sizing:border-box}
.slide-host,.other-host{width:200px;height:120px;margin-bottom:35px}svg{display:block}section{width:200px;height:120px}
#outside{position:absolute;left:750px;top:60px}#deep{position:absolute;left:350px;top:30px}
</style></head><body><div id="workspace"><div class="slide-host" id="first"><section>${graphic("slide-a")}</section></div><div class="slide-host" id="second"><section>${graphic("slide-b")}</section></div><div class="other-host" id="unrelated"><section>${graphic("unrelated-svg")}</section></div><div class="slide-host" id="deep"><section><div>${graphic("deeper-svg")}</div></section></div></div><div class="slide-host" id="outside"><section>${graphic("outside-svg")}</section></div><script>
window.makeGraphic=id=>${JSON.stringify(graphic("PLACEHOLDER"))}.replaceAll('PLACEHOLDER',id);
window.replaceSlides=suffix=>{for(const [host,prefix] of [['first','a'],['second','b']])document.querySelector('#'+host+' section').innerHTML=makeGraphic(prefix+'-'+suffix)};
</script></body></html>`;
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(fixture);
});
let context;
const harness = createBrowserHarness({ server, timeout: 45000, name: "Classless group", viewport: { width: 1100, height: 850 }, deviceScaleFactor: 1 });
const { deadline } = harness;
await harness.run(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  context = await harness.launch();
  deadline();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const tab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), page.url());
  const popup = await context.newPage();
  await popup.addInitScript(targetTab => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = options => options.active ? Promise.resolve([targetTab]) : query(options);
    window.close = () => {};
  }, tab);
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  await popup.evaluate(() => chrome.storage.sync.set({ language: "en" }));
  await popup.waitForFunction(() => document.documentElement.lang === "en");
  const send = message => popup.evaluate(message => chrome.runtime.sendMessage(message), message);
  const origin = "http://127.0.0.1";
  const stored = () => popup.evaluate(async () => (await chrome.storage.local.get("universalSites")).universalSites[0]);
  const panel = page.locator("[data-hdm-picker]");
  const choose = async selector => {
    const rect = await page.locator(selector).boundingBox();
    assert(rect, `Missing fixture target ${selector}`);
    await page.mouse.move(rect.x + 8, rect.y + 8); await page.mouse.click(rect.x + 8, rect.y + 8);
  };
  const pick = async () => {
    await popup.locator("#pick-element:not([disabled])").click(); await page.bringToFront(); await panel.waitFor();
    await panel.locator('[data-action="move"]').click();
  };
  const capture = async selector => {
    const png = await page.locator(selector).screenshot();
    return page.evaluate(async encoded => {
      const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
      return [[10, 10], [35, 35], [180, 100]].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
    }, png.toString("base64"));
  };
  const save = async () => { await panel.locator('[data-action="save"]').click(); await panel.waitFor({ state: "detached" }); };
  const similar = async expected => {
    assert.equal(await panel.locator('[data-action="similar"]').isDisabled(), false, "Classless SVG/groups need an explicit ancestor-anchored group");
    await panel.locator('[data-action="similar"]').click();
    assert.equal(await panel.locator('[data-action="similar"]').getAttribute("aria-pressed"), "true");
    assert.equal(await panel.locator(".match-count").textContent(), `Matches: ${expected}`);
  };
  const screenshot = async name => {
    if (!process.env.HDM_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.HDM_SCREENSHOT_DIR, { recursive: true });
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => {
      const buttons = [...document.querySelector("[data-hdm-picker]").shadowRoot.querySelectorAll(".scope-controls button")];
      return buttons.every(button => getComputedStyle(button).backgroundColor ===
        (button.getAttribute("aria-pressed") === "true" ? "rgb(27, 35, 51)" : "rgba(0, 0, 0, 0)"));
    }, null, { timeout: 3000 }).catch(async error => {
      console.error("Unsettled scope controls", await panel.locator(".scope-controls button").evaluateAll(buttons => buttons.map(button => ({
        action: button.dataset.action, pressed: button.getAttribute("aria-pressed"), background: getComputedStyle(button).backgroundColor,
        transition: getComputedStyle(button).transition
      }))));
      throw error;
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(process.env.HDM_SCREENSHOT_DIR, `classless-${name}.png`) });
  };
  const original = await capture("#first svg");
  const sameInversion = (actual, expected, message) => {
    // SVG filter primitives and CSS filter functions can round by one channel
    // value. This tolerance is never used for original-color protections.
    actual.forEach((pixel, index) => {
      assert.equal(pixel[3], 255, message);
      pixel.slice(0, 3).forEach((channel, color) => assert(Math.abs(channel - expected[index][color]) <= 1, message));
    });
  };
  assert.deepEqual(original[0], [6, 30, 71, 255]); assert.deepEqual(original[1], [40, 228, 188, 255]);
  assert.equal((await send({ type: "hdm-universal-add-site", url: page.url() })).ok, true);
  await page.waitForFunction(() => document.documentElement.classList.contains("dmx-on"));
  const inverted = await capture("#second svg");
  assert.notDeepEqual(inverted, original);
  assert.equal((await send({ type: "hdm-exclusion-add", origin, rule: { path: ["#slide-a"], label: "svg" } })).ok, true);
  await page.locator('#slide-a[data-hdm-excluded="root"]').waitFor();
  const approximate = await capture("#first svg");
  assert.notDeepEqual(approximate, original, "Whole-page exclusions retain their documented approximate colors");
  assert.notDeepEqual(approximate, inverted);
  assert(approximate[0].slice(0, 3).every(value => value < 110));
  assert.deepEqual(await capture("#second svg"), inverted, "An old exact rule must not silently expand");
  await pick(); await choose("#first svg"); await similar(3); await screenshot("page-group"); await save();
  const pageGroup = (await stored()).exclusions.find(rule => rule.matchAll);
  assert.deepEqual(pageGroup.path, ["div.slide-host > section > svg"]);
  assert.equal((await stored()).exclusions.length, 2, "The existing exact rule remains separate");
  assert.deepEqual(await capture("#second svg"), approximate);
  assert.deepEqual(await capture("#outside svg"), approximate, "Whole-page groups include all matching containers");
  assert.deepEqual(await capture("#unrelated svg"), inverted, "Unrelated classless SVG must not join the group");
  assert.deepEqual(await capture("#deep svg"), inverted, "An extra wrapper must not match the direct-child group path");
  await page.evaluate(() => {
    const old = document.querySelector("#first svg"); old.style.display = "none"; old.setAttribute("data-cached", "");
    old.parentElement.insertAdjacentHTML("beforeend", makeGraphic("cached-next"));
  });
  await page.locator('#cached-next[data-hdm-excluded="root"]').waitFor();
  assert.deepEqual(await capture("#cached-next"), approximate, "A hidden cached slide must not prevent matching the new visible slide");
  assert.equal(await page.locator("#first svg").count(), 2);
  await page.evaluate(() => { document.querySelector("#cached-next").remove(); document.querySelector("#first [data-cached]").style.display = ""; });
  assert.deepEqual(await capture("#first svg"), approximate);
  for (const step of ["next", "back"]) {
    await page.evaluate(step => replaceSlides(step), step);
    await page.locator(`#a-${step}[data-hdm-excluded="root"]`).waitFor();
    await page.locator(`#b-${step}[data-hdm-excluded="root"]`).waitFor();
    assert.deepEqual(await capture("#first svg"), approximate);
    assert.deepEqual(await capture("#second svg"), approximate);
  }
  await page.evaluate(async () => {
    const target = document.querySelector("#first section"); target.replaceChildren();
    await new Promise(resolve => setTimeout(resolve, 100)); replaceSlides("remounted");
  });
  await page.locator('#a-remounted[data-hdm-excluded="root"]').waitFor();
  assert.deepEqual(await capture("#first svg"), approximate);
  await page.reload(); await page.locator('#slide-b[data-hdm-excluded="root"]').waitFor();
  assert.deepEqual(await capture("#second svg"), approximate);
  await popup.locator("#exclusion-details").evaluate(node => node.open = true);
  await popup.locator("#exclusion-list .remove-site-btn").last().click();
  await page.waitForFunction(() => !document.querySelector("#slide-b").hasAttribute("data-hdm-excluded"));
  assert.deepEqual(await capture("#second svg"), inverted);
  assert.deepEqual(await capture("#first svg"), approximate, "Removing the group preserves the old exact rule");
  assert.equal((await stored()).exclusions.length, 1);
  assert.equal((await stored()).exclusions[0].matchAll, undefined);
  console.log("PASS whole-page classless group picker, wrappers, replacements, reload, removal and exact-rule independence");

  deadline();
  await popup.locator('[data-mode="selected"]').click();
  await page.waitForFunction(() => document.documentElement.classList.contains("dmx-mode-selected"));
  assert.deepEqual(await capture("#first svg"), original);
  await pick(); await choose("#workspace");
  await panel.locator('[data-action="addException"]').click(); await choose("#first svg"); await similar(2);
  await panel.locator('[data-action="applyException"]').click(); await screenshot("selected-svg"); await save();
  assert.deepEqual((await stored()).inclusions[0].protections[0].path, ["div.slide-host > section > svg"]);
  assert.equal((await stored()).inclusions[0].protections[0].matchAll, true);
  for (const selector of ["#first svg", "#second svg", "#outside svg"]) assert.deepEqual(await capture(selector), original, "Selected mode preserves protected and unselected original colors");
  sameInversion(await capture("#unrelated svg"), inverted, "Unprotected workspace graphics remain inverted");
  sameInversion(await capture("#deep svg"), inverted, "Selected-mode groups preserve the direct-child boundary");
  const workspace = await capture("#workspace"); assert(workspace[0].slice(0, 3).every(value => value < 40));
  await page.evaluate(() => replaceSlides("selected-next"));
  assert.deepEqual(await capture("#first svg"), original);
  await page.evaluate(() => replaceSlides("selected-back"));
  assert.deepEqual(await capture("#second svg"), original);

  await popup.locator("#exclusion-details").evaluate(node => node.open = true);
  await popup.locator("#exclusion-list .rule-edit").click(); await page.bringToFront(); await panel.waitFor();
  await panel.locator('[data-action="move"]').click();
  await panel.locator('[data-action="removeException"]').click();
  await panel.locator('[data-action="addException"]').click(); await choose("#first svg");
  await panel.locator('[data-action="smaller"]').click();
  assert.equal(await panel.locator('[data-action="one"]').getAttribute("aria-pressed"), "true");
  await panel.locator('[data-action="applyException"]').click(); await save();
  const exactDrawing = (await stored()).inclusions[0].protections[0];
  assert.deepEqual(exactDrawing.path, ["#drawing-a-selected-back"]);
  assert.equal(exactDrawing.matchAll, undefined, "A previously saved exact drawing must remain exact until the user changes it");
  assert.deepEqual(await capture("#first svg"), original);
  sameInversion(await capture("#second svg"), inverted, "Saving one exact g must not protect the other drawing");
  await popup.locator("#exclusion-details").evaluate(node => node.open = true);
  await popup.locator("#exclusion-list .rule-edit").click(); await page.bringToFront(); await panel.waitFor();
  await panel.locator('[data-action="move"]').click();
  await panel.locator('[data-action="editException"]').click();
  assert.equal(await panel.locator('[data-action="one"]').getAttribute("aria-pressed"), "true");
  await similar(2);
  assert.equal(await panel.locator('[data-action="one"]').getAttribute("aria-pressed"), "false");
  assert.equal(await panel.locator('[data-action="similar"]').getAttribute("aria-pressed"), "true");
  await screenshot("convert-exact-g");
  await panel.locator('[data-action="applyException"]').click(); await screenshot("selected-g"); await save();
  assert.equal((await stored()).inclusions[0].protections.length, 1, "Editing replaces the exact rule instead of appending a duplicate");
  const groupRule = (await stored()).inclusions[0].protections[0];
  assert.deepEqual(groupRule.path, ["div.slide-host > section > svg > g"]);
  assert.equal(groupRule.matchAll, true, "The chosen classless drawing group must remain a group in nested storage");
  assert(!groupRule.path[0].includes("#"), "Transient group IDs cannot own the rule");
  await page.evaluate(() => {
    const old = document.querySelector("#first svg"); old.style.display = "none"; old.setAttribute("data-cached", "");
    old.parentElement.insertAdjacentHTML("beforeend", makeGraphic("drawing-cached-next"));
  });
  assert.deepEqual(await capture("#drawing-cached-next"), original, "A classless g group must protect the new slide while the old one remains cached");
  await page.evaluate(() => { document.querySelector("#drawing-cached-next").remove(); document.querySelector("#first [data-cached]").style.display = ""; });
  assert.deepEqual(await capture("#first svg"), original);
  for (const step of ["drawing-next", "drawing-back"]) {
    await page.evaluate(step => replaceSlides(step), step);
    assert.deepEqual(await capture("#first svg"), original);
    assert.deepEqual(await capture("#second svg"), original);
    assert.deepEqual(await capture("#outside svg"), original);
    sameInversion(await capture("#unrelated svg"), inverted, "Unrelated graphics remain inverted after replacement");
  }
  await page.reload(); await page.locator('#workspace[data-hdm-cutout="mask"]').waitFor();
  assert.deepEqual(await capture("#second svg"), original);
  assert.equal((await stored()).exclusions.length, 1, "Mode changes preserve the independent whole-page rules");
  await popup.locator("#exclusion-details").evaluate(node => node.open = true);
  await popup.locator("#exclusion-list .remove-site-btn").click();
  await page.waitForFunction(() => !document.querySelector("#workspace").hasAttribute("data-hdm-inverted"));
  for (const selector of ["#first svg", "#second svg", "#unrelated svg", "#outside svg", "#deep svg"]) assert.deepEqual(await capture(selector), original);
  assert.equal(await page.locator("[data-hdm-cutout]").count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS selected-block SVG/g group exceptions, transient IDs, scoped matches, exact pixels, reload and cleanup");
});
