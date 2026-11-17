import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createBrowserHarness, decodePng } from "./support/browser.mjs";

// Browser checks for editor persistence, top-layer rendering and library operations.
const red = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="rgb(255,0,0)"/></svg>');
const head = extra => `<!doctype html><html><head><title>Regression</title><style>html,body{margin:0}body{background:#fff;color:#000;font:16px sans-serif}${extra || ""}</style></head>`;
const rows = count => Array.from({ length: count }, (_, i) => `<div class="row"><span>Row ${i}</span><p>Readable text ${i}</p></div>`).join("");
const topLayer = `<dialog id="d" style="position:fixed;left:200px;top:200px;margin:0;width:300px;height:200px;padding:0;border:0;background:#fff;color:#000">
  <img id="dimg" style="position:absolute;left:20px;top:20px" width="80" height="80" src="${red}"></dialog>
  <div id="pop" popover="manual" style="inset:auto;position:fixed;left:600px;top:200px;margin:0;width:200px;height:100px;padding:0;border:0;background:#fff;color:#000"></div>`;
const pages = {
  "/plain": () => `${head()}<body><p>plain</p></body></html>`,
  "/large": () => `${head(".row{padding:4px;border-bottom:1px solid #ccc}")}<body><h1>Large page</h1>${rows(4000)}</body></html>`,
  "/bare": () => `<!doctype html><html><head><title>Bare</title></head><body><h1>No background at all</h1>${rows(1500)}</body></html>`,
  "/tinted": () => `<!doctype html><html><head><title>Tinted</title><style>html{background:rgb(238,238,238)}</style></head><body><h1>Root background</h1>${rows(1500)}</body></html>`,
  "/dialog": () => `${head()}<body>${topLayer}<img id="plain" style="position:absolute;left:20px;top:500px" width="80" height="80" src="${red}"></body></html>`,
  "/dialog-block": () => `${head("#area{position:absolute;left:20px;top:20px;width:860px;height:560px;background:#fff;border:1px solid #888}#keep{position:absolute;left:150px;top:150px;width:200px;height:150px;background:rgb(17,34,68)}dialog::backdrop{background:transparent}")}<body><div id="area"><div id="keep"></div>${topLayer}</div></body></html>`,
  "/cards": () => `${head(".card{width:160px;height:90px;margin:8px;padding:20px;display:inline-block;background:#fff;border:1px solid #888}.tag{background:#124;color:#fff;padding:2px 6px}#grid{margin-top:440px}")}<body>
    <div id="grid"><div class="card" id="c1"><span class="tag">a</span></div><div class="card" id="c2"><span class="tag">b</span></div><div class="card" id="c3"><span class="tag">c</span></div></div></body></html>`,
  "/blocks": () => `${head("#block,#other,#banner{position:absolute;left:40px;width:300px;height:90px;background:#fff;border:1px solid #888}#banner{top:440px;background:#124;color:#fff}#block{top:560px}#other{top:680px}#chip,#chip2{display:inline-block;margin:20px 6px 20px 20px;padding:8px;background:#124;color:#fff}")}<body>
    <div id="wrap"><div id="banner">banner</div><div id="block"><span id="chip">chip</span><span id="chip2">more</span></div><div id="other">other</div></div></body></html>`,
  "/shadow": () => `${head("#host{margin-top:440px}")}<body><div id="host"></div><script>
    document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
      '<div style="width:300px;height:80px;background:#fff;border:1px solid #888;margin:8px">first</div>' +
      '<div style="width:300px;height:80px;background:#fff;border:1px solid #888;margin:8px">second</div>';
  </script></body></html>`,
  "/conflict": () => `${head("#a,#b,#c{width:300px;height:110px;margin:12px;background:#fff;border:1px solid #888;position:relative}#bex{position:absolute;left:20px;top:20px;width:120px;height:60px;background:#124}#bimg{position:absolute;left:60px;top:30px}#c{margin-top:200px}")}<body>
    <div id="a">A</div><div id="b"><div id="bex"></div><img id="bimg" width="80" height="40" src="${red}"></div><div id="c">C</div></body></html>`
};
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
  res.end((pages[req.url] || pages["/plain"])());
});
const harness = createBrowserHarness({ server, viewport: { width: 1000, height: 900 }, timeout: 90000, name: "Regression" });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const near = (actual, expected, tolerance, label) => actual.forEach((value, index) =>
  assert(Math.abs(value - expected[index]) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`));

await harness.run(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port, origin = "http://127.0.0.1", base = `http://127.0.0.1:${port}`;
  const context = await harness.launch();
  harness.deadline();
  console.log("Chromium", context.browser().version());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  const send = message => popup.evaluate(async msg => {
    const started = performance.now(), reply = await chrome.runtime.sendMessage(msg);
    return { ...reply, sites: undefined, ms: Math.round(performance.now() - started) };
  }, message);
  const ok = async message => { const reply = await send(message); assert.equal(reply?.ok, true, JSON.stringify(reply)); return reply; };
  const stored = () => popup.evaluate(async key => (await chrome.storage.local.get("universalSites")).universalSites.find(site => site.origin === key), origin);
  const pick = (url, mode, rule = null) => popup.evaluate(async ({ url, mode, rule }) => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
    return chrome.tabs.sendMessage(tab.id, { type: "hdm-exclusion-pick", language: "en", rule, mode }, { frameId: 0 });
  }, { url, mode, rule });
  async function fresh(route, mode = "page") {
    const page = await context.newPage();
    await page.goto(base + route); await page.bringToFront();
    await ok({ type: "hdm-universal-add-site", url: base + route });
    if (mode === "selected") await ok({ type: "hdm-universal-set-mode", origin, mode });
    await page.waitForFunction(wanted => document.documentElement.classList.contains("dmx-on") &&
      document.documentElement.classList.contains("dmx-mode-selected") === wanted, mode === "selected");
    return page;
  }
  const done = async page => { await page.close(); await ok({ type: "hdm-universal-remove-site", origin }); };
  async function colors(page, points) {
    const image = await decodePng(popup, await page.screenshot());
    return points.map(([x, y]) => image.pixels.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3));
  }
  const panel = page => page.evaluate(() => {
    const root = document.querySelector("[data-hdm-picker]")?.shadowRoot;
    return root && { status: root.querySelector(".status").textContent, saveDisabled: root.querySelector('button[data-action="save"]').disabled,
      matches: root.querySelector(".match-count").textContent, context: root.querySelector(".root-context").textContent };
  });
  const clickAt = async (page, selector, dx = 6, dy = 6) => {
    const box = await page.locator(selector).boundingBox();
    await page.mouse.move(box.x + dx, box.y + dy); await page.mouse.click(box.x + dx, box.y + dy);
  };
  const save = async page => {
    await page.locator('button[data-action="save"]').click();
    await page.waitForFunction(() => !document.querySelector("[data-hdm-picker]"));
  };
  const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  // 1. A visible notice keeps its own text when the popup re-renders.
  {
    harness.deadline();
    await popup.evaluate(() => chrome.storage.sync.set({ language: "en" }));
    await popup.waitForFunction(() => document.documentElement.lang === "en");
    const failed = await popup.evaluate(() => { showToast("operationFailed"); return translate("operationFailed"); });
    await popup.evaluate(() => chrome.storage.sync.set({ librarySort: "newest" }));
    await popup.waitForFunction(() => document.getElementById("library-sort").value === "newest");
    assert.equal(await popup.locator("#toast").textContent(), failed);
    assert.equal(await popup.locator("#toast").evaluate(element => element.classList.contains("show")), true);
    await popup.locator('#language-select').click();
    await popup.locator('[data-language="ru"]').click();
    await popup.waitForFunction(() => model.snapshot().settings.language === "ru");
    assert.equal(await popup.locator("#toast").textContent(), await popup.evaluate(() => translate("operationFailed")));
    await popup.locator("#toast").evaluate(element => element.classList.remove("show"));
    await popup.locator('#language-select').click();
    await popup.locator('[data-language="en"]').click();
    await popup.waitForFunction(() => model.snapshot().settings.language === "en");
    assert.equal(await popup.locator("#toast").evaluate(element => element.classList.contains("show")), false);
    await popup.evaluate(() => chrome.storage.sync.set({ librarySort: "alphabetical" }));
    await popup.waitForFunction(() => document.getElementById("library-sort").value === "alphabetical");
    console.log("PASS a notice is not replaced by the default text on re-render");
    const paths = ["#layout > div:nth-of-type(1)", "#layout > div:nth-of-type(2)"];
    await popup.evaluate(paths => renderRules(paths.map(path => ({ path: [path], label: "div" })), "exclusion", "inversion"), paths);
    const labels = await popup.locator("#exclusion-list .rule-edit").allTextContents();
    for (const [index, path] of paths.entries()) assert(labels[index].startsWith(path), labels[index]);
    assert.notEqual(labels[0], labels[1]);
    console.log("PASS persisted tag-only rules have distinct structural labels in the popup");
  }

  // 2. Top-layer content and printing in whole-page mode.
  {
    harness.deadline();
    const page = await fresh("/dialog");
    const [background, plainImage] = await colors(page, [[900, 800], [60, 540]]);
    await page.evaluate(() => { document.getElementById("d").showModal(); document.getElementById("pop").showPopover(); });
    await frames(page);
    const [dialog, dialogImage, popover] = await colors(page, [[450, 380], [260, 260], [700, 250]]);
    near(dialog, background, 2, "modal dialog background"); near(popover, background, 2, "popover background");
    near(dialogImage, plainImage, 2, "image inside a modal dialog");
    await page.evaluate(() => { document.getElementById("d").close(); document.getElementById("pop").hidePopover(); });
    await page.emulateMedia({ media: "print" });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).filter), "none");
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("plain")).filter), "none");
    await page.emulateMedia({ media: null });
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).filter), "none");
    await done(page);
    console.log("PASS whole-page mode darkens modal dialogs and popovers and leaves printing alone");
  }

  // 3. Top-layer content inside an inverted block, and printing, in selected-block mode.
  {
    harness.deadline();
    const page = await fresh("/dialog-block", "selected");
    await ok({ type: "hdm-inversion-save", origin, rule: { path: ["#area"], label: "div#area", protections: [{ path: ["#keep"], label: "div#keep" }] } });
    await page.waitForFunction(() => document.getElementById("area").getAttribute("data-hdm-cutout") === "mask");
    await frames(page);
    const [block, kept] = await colors(page, [[820, 100], [185, 185]]);
    near(kept, [17, 34, 68], 2, "protected area");
    await page.evaluate(() => document.getElementById("d").showModal());
    await frames(page); await frames(page);
    const [dialog, keptBesideDialog, blockBesideDialog] = await colors(page, [[450, 380], [185, 185], [820, 100]]);
    near(dialog, block, 2, "modal dialog inside an inverted block");
    near(keptBesideDialog, kept, 2, "protected area next to an open dialog"); near(blockBesideDialog, block, 2, "block behind an open dialog");
    assert.equal(await page.evaluate(() => document.getElementById("area").getAttribute("data-hdm-cutout")), "mask", "a dialog over a protected area must not suspend the block");
    await page.evaluate(() => { document.getElementById("d").close(); document.getElementById("pop").showPopover(); });
    await frames(page);
    near((await colors(page, [[700, 250]]))[0], block, 2, "popover inside an inverted block");
    await page.evaluate(() => document.getElementById("pop").hidePopover());
    await page.emulateMedia({ media: "print" });
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("area")).filter), "none");
    await page.emulateMedia({ media: null });
    await done(page);
    console.log("PASS selected-block mode darkens dialogs and popovers of an inverted block");
  }

  // 4. Looking at "Similar elements" must not overwrite the saved group.
  {
    harness.deadline();
    const page = await fresh("/cards", "selected");
    await ok({ type: "hdm-inversion-save", origin, rule: { path: ["div.card"], matchAll: true, label: "div.card",
      protections: [{ path: ["span.tag"], matchAll: true, label: "span.tag" }] } });
    await page.waitForFunction(() => document.getElementById("c3").getAttribute("data-hdm-inverted") === "root");
    await pick(base + "/cards", "selected");
    await clickAt(page, "#c1", 150, 80);
    await page.locator('button[data-action="similar"]').click();
    assert.equal((await panel(page)).context, "Block: div.card");
    await page.locator('button[data-action="one"]').click();
    assert.equal((await panel(page)).context, "Block: div#c1");
    await save(page);
    await sleep(200);
    const rules = (await stored()).inclusions.map(rule => [rule.path.join(" "), rule.matchAll === true, rule.protections?.length || 0]);
    assert.deepEqual(rules, [["div.card", true, 1], ["#c1", false, 0]]);
    assert.deepEqual(await page.evaluate(() => ["c2", "c3"].map(key => document.getElementById(key).getAttribute("data-hdm-inverted"))), ["root", "root"]);
    await done(page);
    console.log("PASS previewing a group and returning to one element keeps the saved group");
  }

  // 5. A saved block that leaves the page and returns is rebound, whatever the pointer does.
  {
    harness.deadline();
    const page = await fresh("/blocks", "selected");
    await ok({ type: "hdm-inversion-save", origin, rule: { path: ["#block"], label: "div#block" } });
    await page.waitForFunction(() => document.getElementById("block").getAttribute("data-hdm-inverted") === "root");
    await pick(base + "/blocks", "selected", (await stored()).inclusions[0]);
    await page.evaluate(() => { window.__block = document.getElementById("block"); window.__block.remove(); });
    await frames(page);
    assert.equal((await panel(page)).saveDisabled, true);
    await page.mouse.move(100, 700); await page.mouse.move(110, 710); await page.mouse.click(110, 710);
    await frames(page);
    assert.equal((await panel(page)).context, "Block: div#block", "a click while the block is away must not retarget the rule");
    await page.evaluate(() => document.getElementById("wrap").append(window.__block));
    await frames(page); await frames(page);
    assert.deepEqual(await panel(page), { status: "Check the result, then save the rule.", saveDisabled: false, matches: "Matches: 1", context: "Block: div#block" });
    await page.mouse.click(110, 710);
    assert.equal((await panel(page)).context, "Block: div#block", "a saved block opened from the popup is not moved by a click");
    await save(page);
    assert.deepEqual((await stored()).inclusions.map(rule => rule.path), [["#block"]]);
    // The block returns while one of its exceptions is open; picking must still work afterwards.
    await ok({ type: "hdm-inversion-save", origin, previousRule: (await stored()).inclusions[0],
      rule: { path: ["#block"], label: "div#block", protections: [{ path: ["#chip"], label: "span#chip" }] } });
    await pick(base + "/blocks", "selected", (await stored()).inclusions[0]);
    await page.evaluate(() => { window.__block = document.getElementById("block"); window.__block.remove(); });
    await frames(page);
    await page.locator('button[data-action="editException"]').click();
    await page.evaluate(() => document.getElementById("wrap").append(window.__block));
    await frames(page); await frames(page);
    await clickAt(page, "#chip2", 4, 4);
    await frames(page);
    assert.equal(await page.locator('button[data-action="applyException"]').isEnabled(), true, "pointer selection stayed disabled inside the exception view");
    await page.keyboard.press("Escape");
    await page.locator('button[data-action="addException"]').click();
    await clickAt(page, "#chip2", 4, 4);
    await frames(page);
    assert.equal(await page.locator('button[data-action="applyException"]').isEnabled(), true, "pointer selection of an exception stayed disabled");
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-hdm-picker]"));
    await done(page);
    console.log("PASS an unmounted saved block is rebound and cannot be replaced by a stray click");
  }

  // 6. A second click corrects the first; collected exceptions pin the block.
  {
    harness.deadline();
    const page = await fresh("/blocks");
    await pick(base + "/blocks", "page");
    await clickAt(page, "#banner");
    await page.waitForFunction(() => document.getElementById("banner").getAttribute("data-hdm-excluded") === "root");
    await clickAt(page, "#other");
    await page.waitForFunction(() => document.getElementById("other").getAttribute("data-hdm-excluded") === "root" &&
      !document.getElementById("banner").hasAttribute("data-hdm-excluded"));
    await page.keyboard.press("Escape");
    await ok({ type: "hdm-universal-set-mode", origin, mode: "selected" });
    await page.waitForFunction(() => document.documentElement.classList.contains("dmx-mode-selected"));
    await pick(base + "/blocks", "selected");
    await clickAt(page, "#other");
    assert.equal((await panel(page)).context, "Block: div#other");
    await clickAt(page, "#block", 250, 70);
    assert.equal((await panel(page)).context, "Block: div#block");
    await page.locator('button[data-action="addException"]').click();
    await clickAt(page, "#chip", 4, 4);
    await page.locator('button[data-action="applyException"]').click();
    await clickAt(page, "#other");
    assert.equal((await panel(page)).context, "Block: div#block", "a block with collected exceptions is not moved by a click");
    await save(page);
    await pick(base + "/blocks", "selected");
    await clickAt(page, "#block", 250, 70);
    await page.locator('button[data-action="removeException"]').click();
    await clickAt(page, "#other");
    assert.equal((await panel(page)).context, "Block: div#block", "an exception removed from a matched saved block is an edit a click must not discard");
    await page.keyboard.press("Escape");
    await done(page);
    console.log("PASS a second click re-selects, except where it would move a draft with exceptions");
  }

  // 7. The saved rule stays applied on every frame across Save.
  for (const [mode, selector, attribute] of [["selected", "#block", "data-hdm-inverted"], ["page", "#banner", "data-hdm-excluded"]]) {
    harness.deadline();
    const page = await fresh("/blocks", mode);
    for (let round = 0; round < 8; round++) {
      await pick(base + "/blocks", mode);
      await clickAt(page, selector, 250, 70);
      await page.waitForFunction(({ selector, attribute }) => document.querySelector(selector).getAttribute(attribute) === "root", { selector, attribute });
      await page.evaluate(({ selector, attribute }) => {
        const element = document.querySelector(selector), log = window.__log = [];
        window.__stop = false;
        new MutationObserver(() => log.push(element.getAttribute(attribute))).observe(element, { attributes: true, attributeFilter: [attribute] });
        (function frame() { log.push(element.getAttribute(attribute)); if (!window.__stop) requestAnimationFrame(frame); })();
      }, { selector, attribute });
      await save(page);
      await sleep(250);
      const log = await page.evaluate(() => { window.__stop = true; return window.__log; });
      assert(log.length > 5 && log.every(value => value === "root"), `${mode} save ${round}: the rule was dropped for a moment (${log.filter(value => value !== "root").length} samples)`);
      const site = await stored();
      for (const rule of site.exclusions) await ok({ type: "hdm-exclusion-remove", origin, path: rule.path, matchAll: rule.matchAll === true });
      for (const rule of site.inclusions) await ok({ type: "hdm-inversion-remove", origin, path: rule.path, matchAll: rule.matchAll === true });
      await page.waitForFunction(({ selector, attribute }) => !document.querySelector(selector).hasAttribute(attribute), { selector, attribute });
    }
    await done(page);
  }
  console.log("PASS saving a rule never shows a frame without it, in both modes");

  // 8. Same-tag siblings at the top of an open shadow root are selectable.
  {
    harness.deadline();
    const page = await fresh("/shadow");
    await pick(base + "/shadow", "page");
    const host = await page.locator("#host").boundingBox();
    await page.mouse.move(host.x + 40, host.y + 126); await page.mouse.click(host.x + 40, host.y + 126);
    await frames(page);
    assert.equal((await panel(page)).saveDisabled, false, JSON.stringify(await panel(page)));
    await save(page);
    const marked = () => page.evaluate(() => [...document.getElementById("host").shadowRoot.children].filter(node => node.localName === "div").map(node => node.getAttribute("data-hdm-excluded")));
    await page.waitForFunction(() => document.getElementById("host").shadowRoot.querySelector("[data-hdm-excluded]"));
    assert.deepEqual(await marked(), [null, "root"]);
    await page.reload();
    await page.waitForFunction(() => document.getElementById("host").shadowRoot?.querySelector("[data-hdm-excluded]"));
    assert.deepEqual(await marked(), [null, "root"]);
    await done(page);
    console.log("PASS a top-level shadow-root sibling can be selected and survives reload");
  }

  // 9. A layering conflict suspends its own block only.
  {
    harness.deadline();
    const page = await fresh("/conflict", "selected");
    await ok({ type: "hdm-inversion-save", origin, rule: { path: ["#a"], label: "div#a" } });
    await ok({ type: "hdm-inversion-save", origin, rule: { path: ["#b"], label: "div#b", protections: [{ path: ["#bex"], label: "div#bex" }] } });
    await page.waitForFunction(() => document.getElementById("b").getAttribute("data-hdm-cutout") === "blocked");
    await frames(page);
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("a")).filter), "invert(0.9) hue-rotate(180deg)");
    assert.equal(await page.evaluate(() => document.getElementById("a").getAttribute("data-hdm-cutout")), null);
    await pick(base + "/conflict", "selected");
    await clickAt(page, "#c", 20, 20);
    await frames(page);
    assert.deepEqual(await panel(page), { status: "Check the result, then save the rule.", saveDisabled: false, matches: "Matches: 1", context: "Block: div#c" });
    await page.keyboard.press("Escape");
    await done(page);
    console.log("PASS a conflict in one block neither suspends nor blocks saving an unrelated block");
  }

  // 10. Tabs that cannot answer do not delay a change or ask for a reload.
  {
    harness.deadline();
    const page = await fresh("/plain");
    const errorTab = await context.newPage();
    await errorTab.goto("http://127.0.0.1:1/").catch(() => {});
    const alertTab = await context.newPage();
    let dialog; alertTab.on("dialog", value => { dialog = value; });
    await alertTab.goto(`http://localhost:${port}/plain`);
    await alertTab.evaluate(() => { setTimeout(() => alert("hold"), 0); });
    for (let attempt = 0; attempt < 50 && !dialog; attempt++) await sleep(100);
    assert(dialog, "the blocking dialog did not open");
    await page.bringToFront();
    for (const enabled of [false, true, false, true]) {
      const reply = await ok({ type: "hdm-universal-set-enabled", origin, enabled });
      assert.equal(reply.warning ?? null, null);
      assert(reply.ms < 1500, `a silent unrelated tab delayed the reply by ${reply.ms} ms`);
      await page.waitForFunction(wanted => (getComputedStyle(document.documentElement).filter !== "none") === wanted, enabled);
    }
    await dialog.dismiss().catch(() => {});
    await alertTab.close(); await errorTab.close();
    await done(page);
    console.log("PASS error pages and unresponsive tabs of other sites cause no delay and no warning");
  }

  // 11. A saved block absent from this page is reported as such.
  {
    harness.deadline();
    const page = await fresh("/blocks", "selected");
    await ok({ type: "hdm-inversion-save", origin, rule: { path: ["#block"], label: "div#block" } });
    const rule = (await stored()).inclusions[0];
    await page.goto(base + "/plain");
    await page.waitForFunction(() => document.documentElement.classList.contains("dmx-on"));
    assert.deepEqual(await pick(base + "/plain", "selected", rule), { ok: false, error: "selector_unavailable" });
    assert.notEqual(await popup.evaluate(() => translate("ruleNotOnPage")), "ruleNotOnPage");
    await done(page);
    console.log("PASS a block missing from the current page has its own answer");
  }

  // 12. Whole-page sites are dark from their first frame; selected-block sites never get the page filter.
  {
    harness.deadline();
    const page = await context.newPage();
    await page.addInitScript(() => {
      const record = window.__load = [];
      new MutationObserver((records, observer) => {
        const root = document.documentElement;
        if (!root) return;
        observer.disconnect();
        const marked = { on: root.classList.contains("dmx-on"), boot: root.classList.contains("dmx-boot") };
        // The stylesheet of the same injection arrives within this task; look as soon as it has ended.
        setTimeout(() => { window.__first = { ...marked, filter: getComputedStyle(root).filter, canvas: getComputedStyle(root).backgroundColor }; }, 0);
      }).observe(document, { childList: true });
      (function frame() {
        // This script starts before the root element exists; nothing can be drawn until it does.
        const root = document.documentElement;
        if (root) record.push({ on: root.classList.contains("dmx-on"), filter: getComputedStyle(root).filter, canvas: getComputedStyle(root).backgroundColor });
        if (record.length < 30) requestAnimationFrame(frame);
      })();
    });
    await page.goto(base + "/large"); await page.bringToFront();
    await ok({ type: "hdm-universal-add-site", url: base + "/large" });
    const scripts = () => popup.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).find(script => !script.id.endsWith("#shadow")).js);
    assert((await scripts()).includes("content/boot.js"));
    for (let load = 0; load < 8; load++) {
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(() => window.__load.length >= 10 && window.__first);
      const record = await page.evaluate(() => window.__load);
      assert(record.every(frame => frame.on && frame.filter !== "none"), `load ${load}: ${record.filter(frame => !frame.on).length} frames were drawn before the theme`);
      const first = await page.evaluate(() => window.__first);
      assert(first.on && first.boot && first.filter !== "none", `load ${load}: the root element started without the theme (${JSON.stringify(first)})`);
    }
    // Without any background the canvas itself must be painted, or the first frames show light text on white.
    for (const [route, canvas] of [["/bare", "rgb(255, 255, 255)"], ["/tinted", "rgb(238, 238, 238)"]]) {
      for (let load = 0; load < 4; load++) {
        await page.goto(base + route, { waitUntil: "load" });
        await page.waitForFunction(() => window.__load.length >= 10 && window.__first);
        const record = await page.evaluate(() => window.__load);
        assert(record.every(frame => frame.on && frame.canvas === canvas), `${route} load ${load}: canvas was ${[...new Set(record.map(frame => frame.canvas))]}`);
        // Usually before the controller has read the library, and possibly before the page's own style is parsed.
        const first = await page.evaluate(() => window.__first);
        assert(first.boot && ["rgb(255, 255, 255)", canvas].includes(first.canvas), `${route} load ${load}: the canvas was not painted at the start (${JSON.stringify(first)})`);
      }
      // The provisional rule itself: it paints the canvas while present and yields to the site's own background.
      const provisional = await page.evaluate(() => {
        const root = document.documentElement, shim = document.querySelector("[data-hdm-universal-body-style]");
        shim?.remove(); root.classList.add("dmx-boot");
        const withBoot = getComputedStyle(root).backgroundColor;
        root.classList.remove("dmx-boot");
        const withoutBoot = getComputedStyle(root).backgroundColor;
        if (shim) document.head.append(shim);
        return [withBoot, withoutBoot];
      });
      assert.deepEqual(provisional, route === "/bare" ? ["rgb(255, 255, 255)", "rgba(0, 0, 0, 0)"] : [canvas, canvas]);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dmx-boot")), false, "the provisional canvas ends once the page is examined");
    }
    await page.goto(base + "/large", { waitUntil: "load" });
    await ok({ type: "hdm-universal-set-mode", origin, mode: "selected" });
    assert(!(await scripts()).includes("content/boot.js"));
    for (let load = 0; load < 5; load++) {
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(() => window.__load.length >= 10 && window.__first && document.documentElement.classList.contains("dmx-mode-selected"));
      const record = await page.evaluate(() => window.__load);
      assert(record.every(frame => frame.filter === "none"), `selected-block load ${load} flashed the page filter`);
      const first = await page.evaluate(() => window.__first);
      assert(!first.boot && first.filter === "none", `selected-block load ${load} started with the page filter (${JSON.stringify(first)})`);
    }
    await ok({ type: "hdm-universal-set-mode", origin, mode: "page" });
    assert((await scripts()).includes("content/boot.js"));
    await done(page);
    console.log("PASS the page filter is present from the first frame, and only in whole-page mode");
  }

  // 13. Removing a site can be undone with everything it had.
  {
    harness.deadline();
    const page = await fresh("/blocks", "selected");
    await ok({ type: "hdm-inversion-save", origin, rule: { path: ["#block"], label: "div#block", protections: [{ path: ["#chip"], label: "span#chip" }] } });
    await ok({ type: "hdm-exclusion-add", origin, rule: { path: ["#banner"], label: "div#banner" } });
    const before = await stored();
    await popup.bringToFront();
    await popup.locator(`.site-entry[data-origin="${origin}"] .remove-site-btn`).click();
    await popup.locator("#toast-action").waitFor({ state: "visible" });
    assert.equal(await stored(), undefined);
    await page.waitForFunction(() => !document.documentElement.classList.contains("dmx-on"));
    await popup.locator("#toast-action").click();
    await popup.waitForFunction(text => document.getElementById("toast-text").textContent === text, await popup.evaluate(() => translate("siteRestored")));
    assert.deepEqual(await stored(), before);
    assert.equal(await popup.locator("#toast-action").isVisible(), false);
    await page.bringToFront();
    await page.waitForFunction(() => document.getElementById("block").getAttribute("data-hdm-inverted") === "root");
    await done(page);
    console.log("PASS a removed site returns with its mode, rules, exceptions and date");
  }

  // 14. Settings survive an export and import through the options page.
  {
    harness.deadline();
    const page = await fresh("/blocks", "selected");
    await ok({ type: "hdm-inversion-save", origin, rule: { path: ["#block"], label: "div#block", protections: [{ path: ["#chip"], label: "span#chip" }] } });
    const before = await stored();
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options/options.html`);
    const [download] = await Promise.all([options.waitForEvent("download"), options.locator("#export").click()]);
    const file = path.join(harness.scratch, "exported.json");
    await download.saveAs(file);
    const exported = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(exported.format, "custom-dark-mode-settings");
    assert.deepEqual(exported.sites.find(site => site.origin === origin), before);
    await ok({ type: "hdm-universal-remove-site", origin });
    const invalid = path.join(harness.scratch, "invalid.json");
    fs.writeFileSync(invalid, JSON.stringify({ sites: exported.sites }));
    await options.locator("#file").setInputFiles(invalid);
    await options.locator("#status.error").waitFor();
    assert.equal(await stored(), undefined, "a foreign file must not change the library");
    await options.locator("#file").setInputFiles(file);
    await options.waitForFunction(() => document.getElementById("status").textContent && !document.getElementById("status").classList.contains("error"));
    assert.deepEqual(await stored(), before);
    await page.bringToFront();
    await page.waitForFunction(() => document.getElementById("block").getAttribute("data-hdm-inverted") === "root");
    const empty = path.join(harness.scratch, "empty.json");
    fs.writeFileSync(empty, JSON.stringify({ format: "custom-dark-mode-settings", version: 1, sites: [], settings: { librarySort: "oldest" } }));
    await options.locator("#file").setInputFiles(empty);
    await options.waitForFunction(async () => (await chrome.storage.sync.get("librarySort")).librarySort === "oldest");
    assert.equal(await options.locator("#status").evaluate(element => element.classList.contains("error")), false);
    assert.deepEqual(await stored(), before, "an empty backup changes no site");
    await options.evaluate(() => chrome.storage.sync.set({ librarySort: "alphabetical" }));
    await options.close();
    await done(page);
    console.log("PASS export and import restore the library through the options page");
  }

  // 15. The same two actions in the popup, in a menu beside the sort order.
  {
    harness.deadline();
    const page = await fresh("/blocks", "selected");
    await ok({ type: "hdm-inversion-save", origin, rule: { path: ["#block"], label: "div#block", protections: [{ path: ["#chip"], label: "span#chip" }] } });
    const before = await stored();
    await popup.bringToFront();
    const menu = () => popup.evaluate(() => {
      const box = element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }; };
      const trigger = document.getElementById("library-backup"), list = document.getElementById("library-backup-menu");
      return { hidden: list.hidden, expanded: trigger.getAttribute("aria-expanded"), focused: document.activeElement?.dataset.backup || document.activeElement?.id,
        trigger: box(trigger), list: box(list), sort: box(document.getElementById("library-sort")), title: trigger.title, label: trigger.getAttribute("aria-label") };
    });
    const closed = await menu();
    assert.deepEqual([closed.hidden, closed.expanded], [true, "false"]);
    assert.equal(closed.trigger.height, closed.sort.height); assert.equal(closed.trigger.top, closed.sort.top);
    assert(Math.abs(closed.sort.left - closed.trigger.right - 6) < 0.5, "the gap matches the one between a row's switch and its remove button");
    assert.equal(closed.title, await popup.evaluate(() => translate("backupTitle"))); assert.equal(closed.label, closed.title);
    await popup.locator("#library-backup").focus();
    await popup.keyboard.press("ArrowDown");
    const opened = await menu();
    assert.deepEqual([opened.hidden, opened.expanded, opened.focused], [false, "true", "export"]);
    assert(Math.abs(opened.list.right - opened.trigger.right) < 0.5 && opened.list.left >= 8, "the menu hangs from its button inside the popup");
    assert(opened.list.width >= 140 && Math.abs(opened.list.top - opened.trigger.bottom - 6) < 0.5);
    await popup.keyboard.press("ArrowDown");
    assert.equal((await menu()).focused, "import");
    await popup.keyboard.press("Escape");
    assert.deepEqual([(await menu()).hidden, (await menu()).focused], [true, "library-backup"]);
    await popup.locator("#library-backup").click();
    await popup.locator("#library-sort").click();
    assert.equal((await menu()).hidden, true, "opening the other menu closes this one");
    await popup.keyboard.press("Escape");

    await popup.locator("#library-backup").click();
    const [download] = await Promise.all([popup.waitForEvent("download"), popup.locator('[data-backup="export"]').click()]);
    const file = path.join(harness.scratch, "popup-export.json");
    await download.saveAs(file);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).sites.find(site => site.origin === origin), before);
    await popup.waitForFunction(text => document.getElementById("toast-text").textContent === text, await popup.evaluate(() => translate("backupExported", { count: 1 })));
    await ok({ type: "hdm-universal-remove-site", origin });
    await popup.waitForFunction(() => document.querySelectorAll(".site-entry").length === 0);
    const choose = async source => {
      await popup.locator("#library-backup").click();
      const [chooser] = await Promise.all([popup.waitForEvent("filechooser"), popup.locator('[data-backup="import"]').click()]);
      await chooser.setFiles(source);
    };
    const foreign = path.join(harness.scratch, "popup-foreign.json");
    fs.writeFileSync(foreign, JSON.stringify({ sites: [before] }));
    await choose(foreign);
    await popup.waitForFunction(text => document.getElementById("toast-text").textContent === text, await popup.evaluate(() => translate("backupInvalid")));
    assert.equal(await stored(), undefined, "a foreign file must not change the library");
    await choose(file);
    await popup.waitForFunction(text => document.getElementById("toast-text").textContent === text, await popup.evaluate(() => translate("backupImported", { count: 1 })));
    assert.deepEqual(await stored(), before);
    await popup.waitForFunction(key => document.querySelectorAll(`.site-entry[data-origin="${key}"]`).length === 1, origin);
    await page.bringToFront();
    await page.waitForFunction(() => document.getElementById("block").getAttribute("data-hdm-inverted") === "root");
    await done(page);
    console.log("PASS the popup exports and imports settings from a menu beside the sort order");
  }
});
