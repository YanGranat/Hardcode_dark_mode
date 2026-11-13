import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { createBrowserHarness, decodePng } from "./support/browser.mjs";

const red = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>');
function assertPixels(actual, expected, message) {
  const signature = image => ({ width: image.width, height: image.height,
    sha256: createHash("sha256").update(Buffer.from(image.pixels)).digest("hex") });
  assert.deepEqual(signature(actual), signature(expected), message);
}
const documentFor = route => `<!doctype html><html><head><meta charset="utf-8"><title>Editor lifecycle</title><style>
  html,body{margin:0;font:16px sans-serif}body{background:white;color:black;min-height:1200px}
  #work{position:absolute;left:40px;top:500px;width:600px;height:280px;background:white}
  #keep{display:block;width:100px;height:50px;background:#123456}#other{margin:15px}
  #scroll{position:absolute;left:700px;top:480px;width:200px;height:240px;overflow:auto;background:#eee}
  #scroll>div{height:1200px}#host{position:absolute;top:500px;left:40px}
  dialog{position:fixed;left:100px;top:400px;margin:0;width:400px;height:160px;padding:0;border:0;background:white}
  dialog::backdrop{background:transparent}dialog img{position:absolute;left:30px;top:30px}
  #plain{position:absolute;left:600px;top:350px}
  </style></head><body>
  ${route === "/shadow" ? '<section id="host"></section><script>document.getElementById("host").attachShadow({mode:"open"}).innerHTML=\'<article class="tile" style="width:300px;height:180px;background:white"><span class="mark">mark</span></article>\';</script>'
    : route === "/dialog" ? `<div id="layer" style="background-image:linear-gradient(white,white)"><dialog id="dialog"><img src="${red}"></dialog></div><img id="plain" src="${red}">`
    : '<div id="work"><span id="keep">keep</span><button id="other">Page action</button></div><div id="scroll"><div>Scrollable area</div></div>'}
  <script>window.keyEvents=[];window.clicks=0;document.addEventListener("keydown",e=>window.keyEvents.push(e.key));document.addEventListener("keyup",e=>window.keyEvents.push(e.key));document.getElementById("other")?.addEventListener("click",()=>window.clicks++);</script>
  </body></html>`;
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(documentFor(request.url));
});
const harness = createBrowserHarness({ server, headless: true, viewport: { width: 1000, height: 900 }, timeout: 90000, name: "Editor lifecycle" });

await harness.run(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`, origin = "http://127.0.0.1";
  const context = await harness.launch();
  context.setDefaultTimeout(5000);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extension = `chrome-extension://${new URL(worker.url()).host}`;
  const popup = await context.newPage();
  await popup.addInitScript(base => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = options => options.active
      ? query({}).then(tabs => tabs.filter(tab => tab.url?.startsWith(base + "/")).slice(0, 1))
      : query(options);
  }, base);
  await popup.goto(`${extension}/popup/popup.html`);
  const send = async message => {
    const response = await popup.evaluate(message => chrome.runtime.sendMessage(message), message);
    assert.equal(response?.ok, true, response?.error);
    return response;
  };
  const stored = () => popup.evaluate(async origin => (await chrome.storage.local.get("universalSites")).universalSites.find(site => site.origin === origin), origin);
  const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const pick = (page, mode, rule = null) => popup.evaluate(async ({ url, mode, rule }) => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
    return chrome.tabs.sendMessage(tab.id, { type: "hdm-exclusion-pick", mode, language: "en", rule }, { frameId: 0 });
  }, { url: page.url(), mode, rule });
  const click = async (page, selector, dx = 10, dy = 10) => {
    const box = await page.locator(selector).boundingBox();
    await page.mouse.click(box.x + dx, box.y + dy);
  };
  const save = async page => {
    await page.locator('button[data-action="save"]').click();
    await page.waitForFunction(() => !document.querySelector("[data-hdm-picker]"), null, { timeout: 5000 });
  };
  const openModal = async (page, shadow) => {
    await page.evaluate(shadow => {
      const modal = document.getElementById("dialog");
      if (shadow) {
        const host = document.createElement("section"); host.id = "modal-host";
        document.body.append(host); host.attachShadow({ mode: "open" }).append(modal);
      }
      Object.assign(modal.style, { position: "fixed", inset: "0", width: "100vw", height: "100vh", maxWidth: "none", maxHeight: "none", margin: "0", padding: "0", border: "0", background: "white" });
      const button = document.createElement("button"); button.id = "modal-action"; button.textContent = "Page action";
      button.style.cssText = "position:absolute;top:400px;left:200px";
      button.addEventListener("click", () => window.clicks++); modal.append(button);
      modal.showModal();
    }, shadow);
    await frames(page);
  };
  const failures = [];
  async function scenario(name, run, mode = "selected", route = "/plain") {
    harness.deadline();
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    try {
      await page.goto(base + route);
      await send({ type: "hdm-universal-add-site", url: page.url() });
      await send({ type: "hdm-universal-set-mode", origin, mode });
      await page.waitForFunction(mode => document.documentElement.classList.contains("dmx-on") &&
        document.documentElement.classList.contains("dmx-mode-selected") === (mode === "selected"), mode, { timeout: 5000 });
      await popup.reload();
      await popup.waitForFunction(() => document.getElementById("current-site-name").textContent === "127.0.0.1");
      await run(page);
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.error(`FAIL ${name}: ${error.message.slice(0, 500)}`);
      if (pageErrors.length) console.error("Page errors:", pageErrors.map(message => message.slice(0, 300)));
      console.error(error.stack?.split("\n").slice(1, 4).join("\n"));
    } finally {
      await page.close();
      await send({ type: "hdm-universal-remove-site", origin });
    }
  }

  for (const mode of ["page", "selected"]) await scenario(`${mode} editing resolves an existing shadow rule without duplicating it`, async page => {
    const rule = { path: ["#host", "article"], label: "article", ...(mode === "selected" ? { protections: [{ path: ["#host", "span"], label: "span" }] } : {}) };
    await send({ type: mode === "selected" ? "hdm-inversion-save" : "hdm-exclusion-add", origin, rule });
    await frames(page);
    assert.equal((await pick(page, mode)).ok, true);
    await click(page, "#host article", 230, 130);
    await save(page);
    const rules = (await stored())[mode === "selected" ? "inclusions" : "exclusions"];
    assert.equal(rules.length, 1, "selecting the same resolved element must edit the saved rule");
    if (mode === "selected") assert.equal(rules[0].protections.length, 1, "saved local exceptions remain attached");
  }, mode, "/shadow");

  await scenario("a dialog's media compensation does not inherit a background outside its top layer", async page => {
    const original = await decodePng(popup, await page.locator("#plain").screenshot());
    await page.evaluate(() => document.getElementById("dialog").showModal());
    await frames(page);
    const actual = await decodePng(popup, await page.locator("dialog img").screenshot());
    assertPixels(actual, original);
  }, "page", "/dialog");

  for (const shadow of [false, true]) await scenario(`nested modal media starts compensation in its own ${shadow ? "shadow" : "document"} layer`, async page => {
    const reference = await decodePng(popup, await page.locator("#plain").screenshot());
    await page.evaluate(({ shadow, red }) => {
      const outer = document.getElementById("dialog");
      if (shadow) {
        const host = document.createElement("section"); host.id = "modal-host";
        document.body.append(host); host.attachShadow({ mode: "open" }).append(outer);
      }
      Object.assign(outer.style, { position: "fixed", left: "100px", top: "400px", width: "400px", height: "300px", padding: "0", margin: "0", border: "0", background: "white" });
      const background = document.createElement("div"), inner = document.createElement("dialog"), image = document.createElement("img");
      background.style.backgroundImage = "linear-gradient(white,white)";
      inner.id = "inner-modal";
      Object.assign(inner.style, { position: "fixed", left: "550px", top: "500px", width: "200px", height: "120px", padding: "0", margin: "0", border: "0", background: "white" });
      image.id = "inner-image"; image.src = red;
      Object.assign(image.style, { position: "absolute", left: "30px", top: "30px", width: "40px", height: "40px" });
      inner.append(image); background.append(inner); outer.append(background);
      outer.showModal(); inner.showModal();
    }, { shadow, red });
    await page.locator("#inner-image").evaluate(image => image.decode());
    await frames(page);
    const actual = await decodePng(popup, await page.locator("#inner-image").screenshot());
    assertPixels(actual, reference, "an outer background must not change an independent modal's media colors");
  }, "page", "/dialog");

  await scenario("ordinary background-image media retains its single compensation boundary", async page => {
    await page.evaluate(red => {
      const image = document.createElement("img"); image.id = "background-image"; image.src = red;
      document.getElementById("layer").append(image);
    }, red);
    await page.locator("#background-image").evaluate(image => image.decode());
    await frames(page);
    assert.equal(await page.locator("#background-image").evaluate(image => getComputedStyle(image).filter), "none");
  }, "page", "/dialog");

  await scenario("an image that is itself a popover retains its original pixels", async page => {
    await send({ type: "hdm-universal-set-enabled", origin, enabled: false });
    const original = await decodePng(popup, await page.locator("#plain").screenshot());
    await send({ type: "hdm-universal-set-enabled", origin, enabled: true });
    await page.locator("#plain").evaluate(image => {
      image.setAttribute("popover", "manual");
      Object.assign(image.style, { margin: "0", padding: "0", border: "0", width: "40px", height: "40px" });
      image.showPopover();
    });
    await frames(page);
    const actual = await decodePng(popup, await page.locator("#plain").screenshot());
    assertPixels(actual, original);
  }, "page", "/dialog");

  await scenario("fullscreen media compensation does not inherit an outside background", async page => {
    const reference = await decodePng(popup, await page.locator("#plain").screenshot());
    await page.evaluate(red => {
      const root = document.createElement("section"), image = document.createElement("img"), enter = document.createElement("button");
      root.id = "fullscreen-root"; root.style.cssText = "background:white;width:100vw;height:100vh";
      image.id = "fullscreen-image"; image.src = red; image.style.cssText = "position:absolute;left:30px;top:30px;width:40px;height:40px";
      enter.id = "enter-fullscreen"; enter.textContent = "Fullscreen"; enter.style.cssText = "position:fixed;left:40px;top:400px";
      enter.addEventListener("click", () => root.requestFullscreen());
      root.append(image); document.getElementById("layer").append(root); document.body.append(enter);
    }, red);
    await page.locator("#fullscreen-image").evaluate(image => image.decode());
    await page.bringToFront();
    await page.locator("#enter-fullscreen").click();
    await page.waitForFunction(() => document.fullscreenElement?.id === "fullscreen-root");
    await frames(page);
    const actual = await decodePng(popup, await page.locator("#fullscreen-image").screenshot());
    assertPixels(actual, reference, "fullscreen starts its own media compensation rather than reusing the outside background's reset");
    await page.evaluate(() => document.exitFullscreen());
  }, "page", "/dialog");

  await scenario("a page exclusion preserves a shadow modal's authored backdrop", async page => {
    await page.evaluate(() => {
      const modal = document.getElementById("dialog"), host = document.createElement("section"), style = document.createElement("style");
      host.id = "excluded-host"; document.body.append(host);
      const shadow = host.attachShadow({ mode: "open" });
      style.textContent = "dialog::backdrop{background:white}";
      Object.assign(modal.style, { position: "fixed", left: "400px", top: "400px", width: "300px", height: "150px", margin: "0", padding: "0", border: "0", background: "white" });
      shadow.append(style, modal);
    });
    await send({ type: "hdm-exclusion-add", origin, rule: { path: ["#excluded-host"], label: "section#excluded-host" } });
    await page.locator("#dialog").evaluate(dialog => dialog.showModal());
    await frames(page);
    assert.equal(await page.locator("#dialog").evaluate(dialog => getComputedStyle(dialog, "::backdrop").filter), "none");
    const actual = await decodePng(popup, await page.screenshot({ clip: { x: 900, y: 800, width: 1, height: 1 } }));
    assert.deepEqual(actual.pixels.slice(0, 3), [255, 255, 255], "the excluded shadow subtree does not darken its authored white backdrop");
  }, "page", "/dialog");

  for (const shadow of [false, true]) await scenario(`the editor remains reachable above a ${shadow ? "shadow" : "document"} modal`, async page => {
    await openModal(page, shadow);
    assert.equal((await pick(page, "page")).ok, true);
    const cancel = page.locator('[data-hdm-picker] button[data-action="cancel"]');
    await cancel.focus();
    assert.equal(await cancel.evaluate(button => button.getRootNode().activeElement === button), true, "the active site modal must not make editor controls inert");
    await cancel.click({ timeout: 2500 });
    assert.equal(await page.locator("[data-hdm-picker]").count(), 0, "the visible cancel action remains clickable");
  }, "page", "/dialog");

  for (const shadow of [false, true]) for (const ancestor of [false, true]) await scenario(`removing the ${ancestor ? "modal ancestor" : "editor host"} in a ${shadow ? "shadow" : "document"} tree releases input`, async page => {
    await openModal(page, shadow);
    assert.equal((await pick(page, "selected")).ok, true);
    await page.locator(ancestor ? "#dialog" : "[data-hdm-picker]").evaluate(element => element.remove());
    await frames(page);
    await page.keyboard.press("k");
    assert.deepEqual(await page.evaluate(() => window.keyEvents), ["k", "k"], "removal releases keyboard interception without another editor request");
    if (!ancestor) {
      await page.locator("#modal-action").click({ timeout: 2500 });
      assert.equal(await page.evaluate(() => window.clicks), 1, "removal releases pointer interception too");
    }
    assert.equal((await pick(page, "selected")).ok, true, "a removed editor does not leave a stale open-session lock");
    await page.locator('button[data-action="cancel"]').click({ timeout: 2500 });
  }, "selected", "/dialog");

  await scenario("native host access suspends and restores a saved configuration", async page => {
    await send({ type: "hdm-inversion-save", origin, rule: { path: ["#work"], label: "work", protections: [{ path: ["#keep"], label: "keep" }] } });
    const original = await stored();
    assert.equal((await pick(page, "selected")).ok, true);
    const detail = await context.newPage();
    try {
      await detail.goto(`chrome://extensions/?id=${new URL(worker.url()).host}`);
      const access = detail.locator("#hostAccess");
      await access.selectOption("ON_CLICK");
      await popup.waitForFunction(async origin => !(await chrome.permissions.contains({ origins: [`${origin}/*`] })), origin);
      await page.waitForFunction(() => !document.documentElement.classList.contains("dmx-on") && !document.querySelector("[data-hdm-picker]"));
      await popup.waitForFunction(async () => (await chrome.scripting.getRegisteredContentScripts()).length === 0);
      assert.deepEqual(await stored(), original, "withholding access does not edit the user's rules or enabled preference");
      await access.selectOption("ON_ALL_SITES");
      await popup.waitForFunction(async origin => await chrome.permissions.contains({ origins: [`${origin}/*`] }), origin);
      await page.waitForFunction(() => document.documentElement.classList.contains("dmx-on"));
      await popup.waitForFunction(async () => (await chrome.scripting.getRegisteredContentScripts()).length === 2);
      assert.deepEqual(await stored(), original);
      await send({ type: "hdm-universal-set-enabled", origin, enabled: false });
      const paused = await stored();
      await access.selectOption("ON_CLICK");
      await popup.waitForFunction(async origin => !(await chrome.permissions.contains({ origins: [`${origin}/*`] })), origin);
      await access.selectOption("ON_ALL_SITES");
      await popup.waitForFunction(async origin => await chrome.permissions.contains({ origins: [`${origin}/*`] }), origin);
      assert.deepEqual(await stored(), paused, "returning access does not enable a user-paused site");
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dmx-on")), false);
      assert.equal(await popup.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length), 0);
    } finally {
      await detail.locator("#hostAccess").selectOption("ON_ALL_SITES");
      await detail.close();
    }
  });

  for (const mode of ["page", "selected"]) await scenario(`${mode} dialog backdrops darken light surfaces without making black scrims white`, async page => {
    if (mode === "selected") await send({ type: "hdm-inversion-save", origin, rule: { path: ["#layer"], label: "layer" } });
    await page.evaluate(() => document.getElementById("dialog").showModal());
    for (const [color, expected] of [["white", 25], ["black", 0]]) {
      await page.evaluate(color => {
        let style = document.getElementById("backdrop-style");
        if (!style) { style = document.createElement("style"); style.id = "backdrop-style"; document.head.append(style); }
        style.textContent = `dialog::backdrop { background: ${color}; }`;
      }, color);
      await frames(page);
      const image = await decodePng(popup, await page.screenshot({ clip: { x: 900, y: 800, width: 1, height: 1 } }));
      assert(image.pixels.slice(0, 3).every(channel => Math.abs(channel - expected) <= 2), `backdrop ${color}: ${image.pixels.slice(0, 3)}`);
    }
    await page.emulateMedia({ media: "print" });
    assert.equal(await page.locator("#dialog").evaluate(element => getComputedStyle(element, "::backdrop").filter), "none");
  }, mode, "/dialog");

  await scenario("the old-exceptions disclosure is reachable by Tab and retains native activation", async page => {
    await popup.evaluate(async origin => {
      const { universalSites } = await chrome.storage.local.get("universalSites");
      universalSites.find(site => site.origin === origin).protections = [{ path: ["#keep"], label: "keep" }];
      await chrome.storage.local.set({ universalSites });
    }, origin);
    await send({ type: "hdm-inversion-save", origin, rule: { path: ["#work"], label: "work" } });
    assert.equal((await pick(page, "selected", (await stored()).inclusions[0])).ok, true);
    let reached = false;
    for (let count = 0; count < 20; count++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => document.querySelector("[data-hdm-picker]").shadowRoot.activeElement?.localName === "summary");
      if (reached) break;
    }
    assert(reached, "Tab must reach the old-exceptions summary");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("[data-hdm-picker] details").evaluate(element => element.open), true);
  });

  await scenario("page keyboard shortcuts stay inactive while the editor is open", async page => {
    assert.equal((await pick(page, "selected")).ok, true);
    await page.keyboard.press("k");
    await page.keyboard.press("Space");
    assert.deepEqual(await page.evaluate(() => window.keyEvents), []);
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.keyEvents = []; });
    await page.keyboard.press("k");
    assert.deepEqual(await page.evaluate(() => window.keyEvents), ["k", "k"], "closing restores page keyboard interaction");
  });

  await scenario("the picker can scroll an inner page viewport without activating its content", async page => {
    assert.equal((await pick(page, "selected")).ok, true);
    await page.mouse.move(800, 600);
    await page.mouse.wheel(0, 300);
    await page.waitForFunction(() => document.getElementById("scroll").scrollTop > 0, null, { timeout: 1500 });
    assert.equal(await page.evaluate(() => scrollY), 0, "the inner viewport consumes the wheel before the document");
    assert.equal(await page.evaluate(() => window.clicks), 0);
  });

  await scenario("removing the editor host releases page input and permits a new session", async page => {
    assert.equal((await pick(page, "selected")).ok, true);
    await page.evaluate(() => document.querySelector("[data-hdm-picker]").remove());
    await frames(page);
    await click(page, "#other");
    assert.equal(await page.evaluate(() => window.clicks), 1);
    assert.equal((await pick(page, "selected")).ok, true);
    await page.locator('button[data-action="cancel"]').click();
  });

  await scenario("hiding the native editor popover releases input and permits a new session", async page => {
    assert.equal((await pick(page, "selected")).ok, true);
    const visibility = await page.locator("[data-hdm-picker]").evaluate(host => {
      const before = host.matches(":popover-open");
      host.hidePopover();
      return { before, after: host.matches(":popover-open") };
    });
    assert.deepEqual(visibility, { before: true, after: false }, "the browser closes the native popover without a picker action");
    await frames(page);
    await page.keyboard.press("k");
    assert.deepEqual(await page.evaluate(() => window.keyEvents), ["k", "k"], "a hidden editor no longer intercepts keyboard input");
    await click(page, "#other");
    assert.equal(await page.evaluate(() => window.clicks), 1, "a hidden editor no longer intercepts page clicks");
    assert.equal((await pick(page, "selected")).ok, true, "native hiding clears the old editor session");
    await page.locator('button[data-action="cancel"]').click();
  });

  await scenario("a rules-list re-render preserves the focused rule action", async page => {
    await send({ type: "hdm-inversion-save", origin, rule: { path: ["#work"], label: "work" } });
    await popup.locator("#exclusion-details").evaluate(element => { element.open = true; });
    await popup.locator(".rule-edit").focus();
    await popup.evaluate(() => chrome.storage.sync.set({ librarySort: "newest" }));
    await popup.waitForFunction(() => document.getElementById("library-sort").value === "newest");
    assert.equal(await popup.locator(".rule-edit").evaluate(element => element === document.activeElement), true);
  });

  if (failures.length) throw new AggregateError(failures.map(({ name, error }) => new Error(`${name}: ${error.message.slice(0, 500)}`)), `${failures.length} editor lifecycle contracts failed`);
});
