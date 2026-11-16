import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createBrowserHarness } from "./support/browser.mjs";
import { createTargetTransport } from "./support/cdp-target.mjs";
const fixture = `<!doctype html><html><head><style>
body{margin:0;background:white;color:black;font:18px system-ui;height:1800px}
footer{position:fixed;bottom:0;left:0;right:0;height:90px;background:rgb(30,30,30);color:white;display:flex;align-items:center;gap:20px;padding:10px}
button{background:#555;color:white}img{width:32px;height:32px}
#shadow-host{margin-top:200px}
</style></head><body><h1>Light page</h1><div id="shadow-host"></div>
<footer id="subscribe"><span id="caption">Weekly newsletter</span><button id="subscribe-button">Subscribe</button>
<img id="logo" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' fill='red'/%3E%3C/svg%3E"></footer>
<script>window.clicked=0;document.getElementById('subscribe-button').onclick=()=>window.clicked++;
document.getElementById('shadow-host').attachShadow({mode:'open'}).innerHTML='<div id="dark-box" style="background:#222;color:white;width:200px;height:100px">Shadow panel</div>';</script>
</body></html>`;
const server = http.createServer((req, res) => { res.setHeader("Content-Type", "text/html"); res.end(fixture); });
let context;
const harness = createBrowserHarness({ server, viewport: { width: 1000, height: 700 }, timeout: 45000 });
const { deadline } = harness;
await harness.run(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  context = await harness.launch();
  deadline();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const send = message => popup.evaluate(msg => chrome.runtime.sendMessage(msg), message);
  assert.equal((await send({ type: "hdm-universal-add-site", url: page.url() })).ok, true);
  await page.waitForFunction(() => document.documentElement.classList.contains("dmx-on"));
  const tab = await popup.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), page.url());
  const pick = async (language = "ru") => {
    assert.equal((await popup.evaluate(({ tabId, language }) => chrome.tabs.sendMessage(tabId, { type: "hdm-exclusion-pick", language, mode: "page" }, { frameId: 0 }), { tabId: tab.id, language })).ok, true);
    await page.bringToFront();
    await page.locator("[data-hdm-picker]").waitFor();
  };
  const panel = page.locator("[data-hdm-picker]");
  const hover = async selector => {
    const rect = await page.locator(selector).boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  };
  const clickTarget = async selector => {
    await hover(selector);
    await page.mouse.down(); await page.mouse.up();
  };
  const pixel = async () => {
    const height = (await page.viewportSize()).height;
    const image = await page.screenshot({ clip: { x: 900, y: height - 35, width: 1, height: 1 } });
    return page.evaluate(async data => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    }, image.toString("base64"));
  };
  const before = await pixel(); assert(before[0] > 180, `Expected inverted bright banner: ${before}`);
  for (const language of ["ru", "en"]) {
    for (const width of [1000, 375, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate(() => {
        const root = document.querySelector('#shadow-host').shadowRoot;
        let input = root.querySelector('#focus-probe');
        if (!input) { input = document.createElement('input'); input.id = 'focus-probe'; root.append(input); }
        input.focus();
      });
      await pick(language);
      assert.equal(await panel.locator('[data-action="save"]').isDisabled(), true);
      for (const action of ['addException', 'applyException', 'back']) assert.equal(await panel.locator(`[data-action="${action}"]`).isVisible(), false, 'Block-only controls must remain hidden in the whole-page picker');
      const bounds = await panel.locator('.panel').evaluate(node => {
        const rect = node.getBoundingClientRect();
        const buttons = [...node.querySelectorAll('button')].filter(button => button.getClientRects().length).map(button => {
          const b = button.getBoundingClientRect();
          return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, icon: !!button.querySelector('svg'), label: button.getAttribute('aria-label') };
        });
        return { left: rect.left, right: rect.right, height: rect.height, scopeHeight: node.querySelector('.scope-controls').getBoundingClientRect().height, scroll: node.scrollWidth, client: node.clientWidth, buttons };
      });
      assert(bounds.left >= 11 && bounds.right <= width - 11 && bounds.height < 200 + bounds.scopeHeight + 12, JSON.stringify(bounds));
      assert(bounds.scroll <= bounds.client);
      for (const button of bounds.buttons) assert(button.left >= bounds.left && button.right <= bounds.right);
      for (let i = 0; i < bounds.buttons.length; i++) for (let j = i + 1; j < bounds.buttons.length; j++) {
        const a = bounds.buttons[i], b = bounds.buttons[j];
        assert(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, "Picker actions overlap");
      }
      assert(bounds.buttons.slice(0, 2).every(button => button.icon && button.label));
      await page.keyboard.press('Tab');
      assert.equal(await panel.evaluate(node => node.shadowRoot.activeElement.dataset.action), 'move');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await panel.evaluate(node => node.shadowRoot.activeElement.dataset.action), 'cancel');
      if (process.env.HDM_SCREENSHOT_DIR) await panel.locator('.panel').screenshot({ path: path.join(process.env.HDM_SCREENSHOT_DIR, `picker-${language}-${width}.png`) });
      await panel.locator('[data-action="move"]').click();
      const moved = await panel.locator('.panel').boundingBox();
      assert(Math.abs(moved.y + moved.height - 688) < 1, 'Toolbar moves to the opposite viewport edge');
      await panel.locator('[data-action="move"]').click();
      assert(Math.abs((await panel.locator('.panel').boundingBox()).y - 12) < 1);
      await panel.locator('[data-action="cancel"]').click();
      await panel.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => document.querySelector('#shadow-host').shadowRoot.activeElement?.id), 'focus-probe');
    }
  }
  await page.setViewportSize({ width: 1000, height: 700 });
  console.log('PASS picker layout, SVG controls, move, keyboard focus and cancellation in EN/RU at 1000/375/320px');
  deadline();
  await page.evaluate(() => {
    const target = document.createElement('div'); target.id = 'dynamic-choice';
    target.style.cssText = 'position:fixed;left:400px;top:400px;width:160px;height:60px;background:#222';
    target.textContent = 'Temporary element'; document.body.append(target);
  });
  await pick(); await clickTarget('#dynamic-choice');
  assert.equal(await panel.locator('[data-action="save"]').isEnabled(), true);
  await page.evaluate(() => document.querySelector('#dynamic-choice').remove());
  await page.waitForFunction(() => document.querySelector('[data-hdm-picker]').shadowRoot.querySelector('[data-action="save"]').disabled);
  await clickTarget('#caption');
  assert.equal(await panel.locator('[data-action="save"]').isEnabled(), true);
  assert.equal(await page.locator('#caption').getAttribute('data-hdm-excluded'), 'root');
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
  console.log('PASS disappearing selection resets preview and allows another choice');
  await pick();
  await clickTarget("#subscribe-button");
  assert.equal(await page.evaluate(() => window.clicked), 0, "picker must swallow the site's button action");
  await panel.locator('[data-action="larger"]').click();
  await page.waitForFunction(() => document.querySelector("#subscribe").hasAttribute("data-hdm-excluded"));
  await panel.locator('[data-action="smaller"]').click();
  await page.waitForFunction(() => document.querySelector("#subscribe-button").hasAttribute("data-hdm-excluded"));
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => document.querySelector("#subscribe").hasAttribute("data-hdm-excluded"));
  if (process.env.HDM_SCREENSHOT_DIR) await panel.locator('.panel').screenshot({ path: path.join(process.env.HDM_SCREENSHOT_DIR, 'picker-selected.png') });
  assert.equal(await page.locator("#logo").evaluate(node => getComputedStyle(node).filter), "none");
  const preview = await pixel(); assert(preview[0] < 90, `Preview must restore a dark banner: ${preview}`);
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
  assert.equal(await page.locator("#subscribe").getAttribute("data-hdm-excluded"), null);
  await pick(); await clickTarget('#caption');
  await popup.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = message => {
      if (message.type !== 'hdm-exclusion-add') return original.call(chrome.runtime, message);
      return new Promise(resolve => {
        globalThis.releaseTestSave = () => {
          chrome.runtime.sendMessage = original; delete globalThis.releaseTestSave;
          resolve({ ok: false, error: 'save_failed' });
        };
      });
    };
  } }), tab.id);
  await panel.locator('[data-action="save"]').click();
  assert.equal(await panel.locator('[data-action="save"]').isDisabled(), true);
  assert.equal(await panel.locator('[data-action="cancel"]').isDisabled(), true);
  assert.match(await panel.locator('[role="status"]').textContent(), /Сохранение/);
  await page.keyboard.press('Escape');
  assert.equal(await panel.count(), 1, 'An in-flight save cannot be dismissed as cancelled');
  await popup.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.releaseTestSave() }), tab.id);
  await page.waitForFunction(() => document.querySelector('[data-hdm-picker]').shadowRoot.querySelector('[role="status"]').textContent.includes('Не удалось'));
  assert.equal(await panel.locator('[data-action="save"]').isEnabled(), true);
  assert.equal(await panel.locator('[data-action="cancel"]').isEnabled(), true);
  if (process.env.HDM_SCREENSHOT_DIR) await panel.locator('.panel').screenshot({ path: path.join(process.env.HDM_SCREENSHOT_DIR, 'picker-error.png') });
  await panel.locator('[data-action="cancel"]').click();
  assert.equal(await page.locator('#caption').getAttribute('data-hdm-excluded'), null);
  console.log('PASS pending save controls, failure feedback, retry availability and cancel cleanup');
  await pick(); await clickTarget("#caption");
  await panel.locator('[data-action="larger"]').click();
  await panel.locator('[data-action="save"]').click();
  await panel.waitFor({ state: "detached" });
  let saved = (await send({ type: "hdm-universal-get-sites" })).sites[0];
  assert.deepEqual(saved.exclusions[0].path, ["#subscribe"]);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#subscribe").hasAttribute("data-hdm-excluded"));
  assert((await pixel())[0] < 90);
  await page.evaluate(() => {
    const node = document.querySelector("#subscribe"), replacement = node.cloneNode(true);
    replacement.removeAttribute("data-hdm-excluded"); node.replaceWith(replacement);
  });
  await page.waitForFunction(() => document.querySelector("#subscribe").getAttribute("data-hdm-excluded") === "root");
  await send({ type: "hdm-universal-set-enabled", origin: "http://127.0.0.1", enabled: false });
  await page.waitForFunction(() => !document.querySelector("#subscribe").hasAttribute("data-hdm-excluded"));
  await send({ type: "hdm-universal-set-enabled", origin: "http://127.0.0.1", enabled: true });
  await page.waitForFunction(() => document.querySelector("#subscribe").hasAttribute("data-hdm-excluded"));
  if (process.env.HDM_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.HDM_SCREENSHOT_DIR, "page.png") });
  console.log("PASS banner pixels, nested media, blocked page click, preview/cancel/save, reload/replacement/pause/resume", before, preview);

  deadline();
  await pick(); await clickTarget("#dark-box");
  await panel.locator('[data-action="save"]').click(); await panel.waitFor({ state: "detached" });
  saved = (await send({ type: "hdm-universal-get-sites" })).sites[0];
  assert(saved.exclusions.some(rule => rule.path.length === 2));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#shadow-host").shadowRoot.querySelector("#dark-box").hasAttribute("data-hdm-excluded"));
  console.log("PASS selection inside open Shadow DOM persists across reload");

  await popup.addInitScript(tab => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = options => options.active ? Promise.resolve([tab]) : query(options);
  }, tab);
  await popup.reload();
  await popup.locator("#exclusion-details").click();
  await popup.locator("#exclusion-list button").first().click();
  await page.waitForFunction(() => !document.querySelector("#subscribe").hasAttribute("data-hdm-excluded"));
  assert((await pixel())[0] > 180);
  console.log("PASS popup lists and removes saved exclusions");

  deadline();
  const originalSites = await popup.evaluate(async () => (await chrome.storage.local.get('universalSites')).universalSites);
  const sortSites = [
    { ...originalSites[0], addedAt: 200 },
    { origin: 'https://zulu.test', enabled: false, addedAt: 100 },
    { origin: 'https://alpha.test', enabled: false, addedAt: 300 },
    { origin: 'https://legacy.test', enabled: false }
  ];
  await popup.evaluate(async sites => {
    await chrome.storage.local.set({ universalSites: sites });
    await chrome.storage.sync.set({ librarySort: 'alphabetical', language: 'ru' });
  }, sortSites);
  await popup.waitForFunction(() => document.querySelectorAll('#library-list .site-entry').length === 4);
  const sortControl = popup.locator('#library-sort');
  const chooseSort = async order => {
    await sortControl.click();
    await popup.locator(`#library-sort-menu [data-sort="${order}"]`).click();
  };
  const displayed = () => popup.locator('#library-list .site-entry').evaluateAll(rows => rows.map(row => new URL(row.dataset.origin).hostname));
  const expectedSort = {
    alphabetical: ['127.0.0.1', 'alpha.test', 'legacy.test', 'zulu.test'],
    newest: ['alpha.test', '127.0.0.1', 'zulu.test', 'legacy.test'],
    oldest: ['zulu.test', '127.0.0.1', 'alpha.test', 'legacy.test']
  };
  await popup.evaluate(() => { globalThis.originalSortRow = document.querySelector('[data-origin="https://alpha.test"]'); });
  for (const order of ['newest', 'oldest', 'alphabetical']) {
    await chooseSort(order);
    await popup.waitForFunction(order => model.snapshot().settings.librarySort === order &&
      document.getElementById('library-sort').value === order, order);
    assert.deepEqual(await displayed(), expectedSort[order]);
    assert.equal(await popup.evaluate(() => globalThis.originalSortRow === document.querySelector('[data-origin="https://alpha.test"]')), true);
  }
  assert.deepEqual(await popup.evaluate(async () => (await chrome.storage.local.get('universalSites')).universalSites), sortSites, 'Sorting must not rewrite the library');
  await popup.locator('[data-origin="https://alpha.test"] input').focus();
  await popup.evaluate(() => chrome.storage.sync.set({ librarySort: 'oldest' }));
  await popup.waitForFunction(() => document.getElementById('library-sort').value === 'oldest');
  assert.equal(await popup.evaluate(() => document.activeElement.closest('.site-entry')?.dataset.origin), 'https://alpha.test');
  assert.deepEqual(await displayed(), expectedSort.oldest);
  await popup.reload();
  await popup.waitForFunction(() => document.getElementById('library-sort').value === 'oldest');
  assert.deepEqual(await displayed(), expectedSort.oldest);

  await popup.evaluate(() => {
    globalThis.sortWrites = [];
    globalThis.originalSettingsWrite = chrome.storage.sync.set.bind(chrome.storage.sync);
    chrome.storage.sync.set = value => new Promise((resolve, reject) => {
      sortWrites.push({ commit: async () => { await originalSettingsWrite(value); resolve(); }, reject });
    });
  });
  await chooseSort('alphabetical');
  await popup.waitForFunction(() => sortWrites.length === 1);
  await chooseSort('newest');
  await chooseSort('oldest');
  assert.deepEqual(await displayed(), expectedSort.oldest);
  assert.equal(await sortControl.isEnabled(), true);
  await popup.locator('[data-origin="https://zulu.test"] .switch').click();
  await popup.waitForFunction(() => !model.isPending());
  const toggled = await popup.evaluate(async () => (await chrome.storage.local.get('universalSites')).universalSites.find(site => site.origin === 'https://zulu.test'));
  assert.equal(toggled.enabled, true); assert.equal(toggled.addedAt, 100);
  for (let i = 0; i < 2; i++) {
    await popup.evaluate(index => sortWrites[index].commit(), i);
    await popup.waitForFunction(length => sortWrites.length === length, i + 2);
    assert.deepEqual(await displayed(), expectedSort.oldest);
  }
  await popup.evaluate(() => sortWrites[2].reject(Error('simulated settings failure')));
  await popup.waitForFunction(() => model.snapshot().settings.librarySort === 'newest' &&
    document.getElementById('library-sort').value === 'newest');
  assert.deepEqual(await displayed(), expectedSort.newest);
  assert.equal(await sortControl.evaluate(el => el.value), 'newest');
  await popup.evaluate(() => { chrome.storage.sync.set = originalSettingsWrite; delete globalThis.sortWrites; delete globalThis.originalSettingsWrite; });
  await popup.evaluate(() => chrome.storage.sync.set({ librarySort: 'invalid-setting' }));
  await popup.waitForFunction(() => document.getElementById('library-sort').value === 'alphabetical');
  assert.deepEqual(await displayed(), expectedSort.alphabetical);
  await popup.locator('#language-select').click();
  await popup.locator('[data-language="en"]').click();
  await popup.waitForFunction(() => document.documentElement.lang === 'en');
  assert.deepEqual(await popup.locator('#library-sort-menu [data-i18n]').allTextContents(), ['Alphabetical', 'Newest added', 'Oldest added']);
  await popup.evaluate(async sites => {
    await chrome.storage.local.set({ universalSites: sites });
    await chrome.storage.sync.set({ librarySort: 'alphabetical', language: 'ru' });
  }, originalSites);
  await popup.waitForFunction(() => document.getElementById('library-count').textContent === '1');
  assert.deepEqual(await popup.locator('#library-sort-menu [data-i18n]').allTextContents(), ['По алфавиту', 'Сначала новые', 'Сначала старые']);
  deadline();
  await sortControl.focus();
  await popup.keyboard.press('ArrowDown');
  assert.equal(await popup.locator('#library-sort-menu [data-sort="alphabetical"]').evaluate(el => el === document.activeElement), true);
  await popup.keyboard.press('End');
  await popup.keyboard.press('Home');
  await popup.keyboard.press('ArrowUp');
  assert.equal(await popup.locator('#library-sort-menu [data-sort="oldest"]').evaluate(el => el === document.activeElement), true);
  await popup.locator('#library-sort-menu [data-sort="newest"]').hover();
  assert.equal(await popup.locator('#library-sort-menu [data-sort="newest"]').evaluate(el => el === document.activeElement), true);
  assert.equal(await popup.locator('#library-sort-menu button').evaluateAll(rows => rows.filter(row => getComputedStyle(row).backgroundColor !== 'rgba(0, 0, 0, 0)').length), 1, 'Mixed pointer/keyboard input must highlight only one row');
  await popup.keyboard.press('ArrowDown');
  assert.equal(await popup.locator('#library-sort-menu [data-sort="oldest"]').evaluate(el => el === document.activeElement), true);
  await popup.keyboard.press('Escape');
  assert.equal(await sortControl.evaluate(el => el === document.activeElement), true);
  assert.equal(await sortControl.getAttribute('aria-expanded'), 'false');
  assert.equal(await sortControl.evaluate(el => el.value), 'alphabetical', 'Navigation and Escape must not commit');
  await popup.keyboard.press('Space');
  await popup.keyboard.press('ArrowDown');
  await popup.keyboard.press('Enter');
  await popup.waitForFunction(() => model.snapshot().settings.librarySort === 'newest' &&
    document.getElementById('library-sort').value === 'newest');
  assert.equal(await sortControl.evaluate(el => el.value), 'newest');
  await sortControl.click();
  await popup.keyboard.press('Tab');
  assert.equal(await sortControl.getAttribute('aria-expanded'), 'false');
  assert.equal(await popup.locator('#library-list input').first().evaluate(el => el === document.activeElement), true);
  await sortControl.click();
  await popup.keyboard.press('Shift+Tab');
  assert.equal(await sortControl.getAttribute('aria-expanded'), 'false');
  assert.equal(await popup.locator('#library-backup').evaluate(el => el === document.activeElement), true);
  await popup.keyboard.press('Shift+Tab');
  assert.equal(await popup.locator('#exclusion-details summary').evaluate(el => el === document.activeElement), true);
  await sortControl.click();
  await popup.locator('#language-select').click();
  assert.equal(await sortControl.getAttribute('aria-expanded'), 'false');
  await popup.keyboard.press('Escape');
  assert.equal(await popup.locator('#language-select').evaluate(el => el === document.activeElement), true);
  await popup.locator('#language-select').click();
  await popup.locator('[data-language="ru"]').click();
  await chooseSort('alphabetical');
  await popup.waitForFunction(() => model.snapshot().settings.librarySort === 'alphabetical' &&
    document.getElementById('library-sort').value === 'alphabetical');
  await popup.keyboard.press('Tab');
  await popup.keyboard.press('Tab');
  assert.equal(await popup.locator('#library-list .remove-site-btn').first().evaluate(el => el === document.activeElement), true);
  assert.equal(await popup.locator('#library-list .remove-site-btn').first().evaluate(el => {
    const style = getComputedStyle(el);
    return parseFloat(style.outlineWidth) > 0 && parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth) <= 0;
  }), true, 'Focus ring must remain visible inside the list clipping edge at fractional display scales');
  console.log('PASS library sort modes, unknown dates, row/focus reuse, reload, rapid saves/failure and concurrent toggles');

  deadline();
  await popup.evaluate(async () => {
    const { universalSites } = await chrome.storage.local.get("universalSites");
    for (let i = 0; i < 12; i++) universalSites.push({ origin: `https://fixture${i}.test`, enabled: false });
    await chrome.storage.local.set({ universalSites });
  });
  await page.bringToFront();
  const cdp = await context.browser().newBrowserCDPSession();
  const previousTargets = new Set((await cdp.send("Target.getTargets")).targetInfos.map(target => target.targetId));
  await worker.evaluate(() => chrome.action.openPopup());
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    const targets = (await cdp.send("Target.getTargets")).targetInfos;
    target = targets.find(target => target.url.endsWith("/popup/popup.html") && !previousTargets.has(target.targetId));
    if (!target) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(target, "Actual action popup target must exist");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
  const transport = createTargetTransport(cdp, { sessionId, targetId: target.targetId });
  try {
    const command = transport.command;
    const measured = await command("Runtime.evaluate", { expression: `(async () => {
      const deadline = Date.now() + 3000;
      while (document.getElementById('library-count')?.textContent !== '13' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.scrollTo(0, document.documentElement.scrollHeight);
      const body = document.body, style = getComputedStyle(body);
      const list = document.getElementById('library-list');
      list.scrollTop = list.scrollHeight;
      return { name: chrome.i18n.getMessage('extensionName'), title: document.title, brand: document.querySelector('.title').textContent,
        count: document.getElementById('library-count').textContent, height: body.offsetHeight, content: body.scrollHeight, repeat: style.backgroundRepeat,
        libraryScroll: list.scrollTop, scrollbar: getComputedStyle(list, '::-webkit-scrollbar').width,
        scrollbarButton: getComputedStyle(list, '::-webkit-scrollbar-button').display,
        width: innerWidth, maxWidth: document.documentElement.scrollWidth, viewport: innerHeight, scroll: scrollY };
    })()`, returnByValue: true, awaitPromise: true });
    const geometry = measured.result.result.value;
    assert.equal(geometry.name, "Hardcode Dark Mode");
    assert.equal(geometry.title, geometry.name);
    assert.equal(geometry.brand, geometry.name);
    assert.equal(geometry.count, "13");
    assert.equal(geometry.scrollbar, "6px");
    assert.equal(geometry.scrollbarButton, "none");
    assert(geometry.libraryScroll > 0);
    assert(geometry.height < 600 && geometry.height >= geometry.content);
    assert(geometry.repeat.split(",").every(value => value.trim() === "no-repeat"));
    assert(geometry.scroll < 1 && geometry.maxWidth <= geometry.width, JSON.stringify(geometry));
    const layouts = await command("Runtime.evaluate", { expression: `(async () => {
      const saved = (await chrome.storage.local.get('universalSites')).universalSites;
      const results = [];
      async function setSites(sites) {
        await chrome.storage.local.set({ universalSites: sites });
        const until = Date.now() + 3000;
        while (document.querySelectorAll('#library-list .site-entry').length !== sites.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 30));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      for (const count of [0, 1, 3, 5, 6, 7, 13, 6, 5]) {
        const sites = saved.slice(0, count).map((site, index) => index === count - 1
          ? { ...site, origin: 'https://a-very-long-library-hostname-for-layout-checks.example.test', enabled: false } : site);
        await setSites(sites);
        const list = document.getElementById('library-list'); list.scrollTop = 0;
        const bounds = list.getBoundingClientRect();
        const rows = [...list.children];
        document.getElementById('library-sort').click();
        const menu = document.getElementById('library-sort-menu').getBoundingClientRect();
        const menuFits = menu.top >= 8 && menu.bottom <= innerHeight - 8 && menu.left >= 8 && menu.right <= innerWidth - 8;
        document.getElementById('library-sort').click();
        const currentEntry = model.site(model.snapshot().currentSite.origin), toggle = document.getElementById('current-site-enabled');
        const switchBounds = document.getElementById('current-site-switch').getBoundingClientRect();
        const copyBounds = document.querySelector('.current-site-row .site-copy').getBoundingClientRect();
        const actionBounds = document.getElementById('current-site-action').getBoundingClientRect();
        results.push({ count, capacity: Number(list.style.getPropertyValue('--library-rows')) || 6, menuFits, height: list.clientHeight, scrollHeight: list.scrollHeight,
          currentToggle: { listed: Boolean(currentEntry), visible: switchBounds.width > 0, checked: toggle.checked, enabled: !toggle.disabled,
            expectedChecked: currentEntry?.enabled === true, width: switchBounds.width, height: switchBounds.height,
            textGap: switchBounds.left - copyBounds.right, actionGap: actionBounds.left - switchBounds.right,
            centerGap: Math.abs((switchBounds.top + switchBounds.bottom - actionBounds.top - actionBounds.bottom) / 2) },
          popupHeight: document.body.offsetHeight, viewportHeight: innerHeight,
          sortGap: document.getElementById('library-sort').getBoundingClientRect().left - document.querySelector('.library-caption').getBoundingClientRect().right,
          width: innerWidth, contentWidth: document.documentElement.scrollWidth,
          sortRight: document.getElementById('library-sort').getBoundingClientRect().right,
          listRight: bounds.right,
          actionRight: document.getElementById('current-site-action').getBoundingClientRect().right,
          headerGap: bounds.top - document.querySelector('.library-heading').getBoundingClientRect().bottom,
          rows: rows.map(row => {
            const rect = row.getBoundingClientRect();
            const copy = row.querySelector('.site-copy').getBoundingClientRect();
            const actions = row.querySelector('.site-entry-actions').getBoundingClientRect();
            return { height: rect.height, top: rect.top - bounds.top, bottom: rect.bottom - bounds.top,
              right: actions.right, textGap: actions.left - copy.right, gutter: bounds.left + list.clientWidth - actions.right };
          }) });
      }
      await setSites(saved);
      return results;
    })()`, returnByValue: true, awaitPromise: true });
    for (const layout of layouts.result.result.value) {
      console.log('Library layout', JSON.stringify(layout));
      assert(layout.capacity >= 5 && layout.capacity <= 6, 'The editor must leave room for at least five complete library rows');
      assert.equal(layout.height, Math.min(layout.count, layout.capacity) * 48);
      assert(layout.popupHeight <= 600 && layout.popupHeight <= layout.viewportHeight + 1);
      assert(layout.sortGap >= 7.5);
      assert(layout.menuFits, 'Expanded sort menu must fit even in a short empty popup');
      assert(layout.width <= geometry.width + .5 && layout.contentWidth <= layout.width, JSON.stringify(layout));
      assert.equal(layout.currentToggle.visible, layout.currentToggle.listed);
      assert.equal(layout.currentToggle.enabled, layout.currentToggle.listed);
      assert.equal(layout.currentToggle.checked, layout.currentToggle.expectedChecked);
      if (layout.currentToggle.listed) {
        assert.equal(layout.currentToggle.width, 42);
        assert.equal(layout.currentToggle.height, 26);
        assert(layout.currentToggle.textGap >= 9.5);
        assert(Math.abs(layout.currentToggle.actionGap - 6) < .02);
        assert(layout.currentToggle.centerGap < .02);
      }
      if (!layout.count) continue;
      assert(layout.headerGap >= 7.5);
      for (const row of layout.rows) {
        assert.equal(row.height, 48);
        assert(row.textGap >= 9.5);
        if (layout.count > layout.capacity) assert(row.gutter >= 7.5);
        else {
          assert(Math.abs(row.right - layout.listRight) < .02);
          assert(Math.abs(row.right - layout.sortRight) < .02);
          assert(Math.abs(row.right - layout.actionRight) < .02);
        }
      }
      if (layout.count <= layout.capacity) assert.equal(layout.scrollHeight, layout.height, 'Small libraries must fit without scrolling');
      else {
        assert(layout.scrollHeight > layout.height);
        assert(Math.abs(layout.rows[layout.capacity - 1].bottom - layout.height) < .01);
        assert(Math.abs(layout.rows[layout.capacity].top - layout.height) < .01);
      }
    }
    deadline();
    const languageLayouts = await command('Runtime.evaluate', { expression: `(async () => {
      const saved = (await chrome.storage.local.get('universalSites')).universalSites;
      const previousLanguage = document.documentElement.lang, results = [];
      try {
        for (const count of [0, 6]) {
          await chrome.storage.local.set({ universalSites: saved.slice(0, count) });
          for (const language of ['de', 'en', 'es', 'ru', 'uk']) {
            await chrome.storage.sync.set({ language });
            const until = Date.now() + 3000;
            while ((document.documentElement.lang !== language || document.querySelectorAll('#library-list .site-entry').length !== count) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const trigger = document.getElementById('language-select'), menu = document.getElementById('language-menu');
            trigger.click();
            const bounds = menu.getBoundingClientRect(), anchor = trigger.getBoundingClientRect(), brand = document.querySelector('.brand').getBoundingClientRect();
            results.push({ language, count, label: document.getElementById('language-label').textContent,
              checked: [...menu.querySelectorAll('[aria-checked=true]')].map(row => row.dataset.language),
              width: innerWidth, contentWidth: document.documentElement.scrollWidth,
              headerGap: anchor.left - brand.right, edgeGap: innerWidth - bounds.right,
              anchorGap: bounds.top - anchor.bottom, rightGap: Math.abs(bounds.right - anchor.right),
              fits: bounds.top >= 8 && bounds.bottom <= innerHeight - 8 && bounds.left >= 8 && bounds.right <= innerWidth - 8,
              rows: [...menu.children].map(row => {
                const rect = row.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(row.querySelector('span'));
                const text = range.getBoundingClientRect();
                return { height: rect.height, textHeight: text.height, fits: text.width <= row.querySelector('span').clientWidth + .1 };
              }) });
            trigger.click();
          }
        }
      } finally { await chrome.storage.sync.set({ language: previousLanguage }); await chrome.storage.local.set({ universalSites: saved }); }
      return results;
    })()`, awaitPromise: true, returnByValue: true });
    assert.equal(languageLayouts.result.result.value.length, 10);
    for (const layout of languageLayouts.result.result.value) {
      assert.equal(layout.label, layout.language.toUpperCase());
      assert.deepEqual(layout.checked, [layout.language]);
      assert.equal(layout.fits, true, JSON.stringify(layout));
      assert(layout.headerGap >= 11.5 && layout.rightGap < .1 && layout.anchorGap >= 5.5);
      assert(layout.contentWidth <= layout.width && layout.width <= 360);
      assert.equal(layout.rows.length, 5);
      assert(layout.rows.every(row => row.height === 32 && row.textHeight <= 16.1 && row.fits));
    }
    console.log('PASS native language dropdown alignment, first/last rows and all five choices in short and full popups');
    deadline();
    const currentControls = await command('Runtime.evaluate', { expression: `(async () => {
      const results = [], current = document.getElementById('current-site-enabled');
      for (const language of ['en', 'ru']) {
        await chrome.storage.sync.set({ language });
        while (document.documentElement.lang !== language || model.isPending()) await new Promise(resolve => setTimeout(resolve, 20));
        for (const enabled of [false, true]) {
          if (current.checked !== enabled) current.click();
          const row = [...document.querySelectorAll('#library-list .site-entry')].find(row => row.dataset.origin === model.snapshot().currentSite.origin);
          results.push({ language, enabled, checked: current.checked, libraryChecked: row.querySelector('input').checked,
            disabled: current.disabled, label: current.getAttribute('aria-label'), status: document.getElementById('current-site-status').textContent });
          while (model.isPending()) await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      const query = chrome.tabs.query.bind(chrome.tabs), savedTab = model.snapshot().tab;
      const savedLibrary = (await chrome.storage.local.get('universalSites')).universalSites;
      try {
        chrome.tabs.query = options => options.active ? Promise.resolve([{ ...savedTab, url: 'chrome://settings' }]) : query(options);
        await model.init();
        results.push({ unavailable: true, hidden: !document.getElementById('current-site-switch').getClientRects().length, disabled: current.disabled });
        const longUrl = 'https://' + 'long-subdomain.'.repeat(10) + 'example.test';
        const longSite = HdmSites.fromUrl(longUrl);
        chrome.tabs.query = options => options.active ? Promise.resolve([{ ...savedTab, url: longUrl }]) : query(options);
        await chrome.storage.local.set({ universalSites: [{ origin: longSite.origin, enabled: true }] });
        await model.init();
        const until = Date.now() + 3000;
        while (document.querySelector('#library-list .site-entry')?.dataset.origin !== longSite.origin && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const name = document.getElementById('current-site-name'), copy = document.querySelector('.current-site-row .site-copy').getBoundingClientRect();
        const bounds = document.getElementById('current-site-switch').getBoundingClientRect();
        results.push({ longHost: true, label: name.textContent, title: name.title, expected: longSite.label,
          checked: current.checked, visible: bounds.width > 0, textGap: bounds.left - copy.right,
          width: innerWidth, contentWidth: document.documentElement.scrollWidth });
      } finally {
        chrome.tabs.query = query;
        await chrome.storage.local.set({ universalSites: savedLibrary });
        await model.init();
        while (document.querySelectorAll('#library-list .site-entry').length !== savedLibrary.length) await new Promise(resolve => setTimeout(resolve, 20));
      }
      return results;
    })()`, awaitPromise: true, returnByValue: true });
    for (const state of currentControls.result.result.value) {
      if (state.unavailable) { assert.equal(state.hidden, true); assert.equal(state.disabled, true); continue; }
      if (state.longHost) {
        assert.equal(state.label, state.expected); assert.equal(state.title, state.expected);
        assert.equal(state.visible, true); assert.equal(state.checked, true);
        assert(state.textGap >= 9.5 && state.contentWidth <= state.width && state.width <= 360);
        continue;
      }
      assert.equal(state.checked, state.enabled); assert.equal(state.libraryChecked, state.enabled); assert.equal(state.disabled, false);
      assert.match(state.label, state.language === 'ru' ? /Включить тёмную тему/ : /Enable dark theme/);
      assert.match(state.status, state.enabled ? /Enabled|Включён/ : /Paused|Приостановлен/);
    }
    console.log('PASS action popup current-site switch state, localization, library synchronization and unsupported pages');
    const sortLayouts = await command("Runtime.evaluate", { expression: `(async () => {
      const results = [];
      const rect = el => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height }; };
      for (const language of ['ru', 'en', 'uk', 'de', 'es']) {
        for (const order of ['alphabetical', 'newest', 'oldest']) {
          await chrome.storage.sync.set({ language, librarySort: order });
          const until = Date.now() + 3000;
          while ((document.documentElement.lang !== language || document.getElementById('library-sort').value !== order) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
          document.getElementById('library-sort').click();
          const trigger = document.getElementById('library-sort'), menu = document.getElementById('library-sort-menu');
          const triggerStyle = getComputedStyle(trigger);
          results.push({ language, order, trigger: rect(trigger), menu: rect(menu), label: rect(trigger.querySelector('span')), icon: rect(trigger.querySelector('svg')),
            font: [triggerStyle.fontFamily, triggerStyle.fontSize, triggerStyle.fontWeight, triggerStyle.lineHeight],
            rows: [...menu.children].map(row => {
              const style = getComputedStyle(row), text = row.querySelector('span');
              return { bounds: rect(row), text: rect(text), icon: rect(row.querySelector('svg')),
                font: [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight],
                textFits: text.scrollWidth <= text.clientWidth, selected: row.getAttribute('aria-checked') === 'true' };
            }) });
          document.getElementById('library-sort').click();
        }
      }
      await chrome.storage.sync.set({ language: 'ru', librarySort: 'alphabetical' });
      return results;
    })()`, returnByValue: true, awaitPromise: true });
    for (const layout of sortLayouts.result.result.value) {
      const center = rect => rect.top + rect.height / 2;
      const near = (a, b) => assert(Math.abs(a - b) < .02, `${layout.language}/${layout.order}: ${a} != ${b}`);
      near(layout.trigger.width, layout.menu.width);
      near(layout.trigger.left, layout.menu.left);
      assert.equal(layout.trigger.height, 26);
      assert.deepEqual(layout.font.slice(1), ['12px', '400', '16px']);
      near(layout.label.height, 16);
      assert.equal(layout.rows.filter(row => row.selected).length, 1);
      for (const [index, row] of layout.rows.entries()) {
        assert.equal(row.bounds.height, 32);
        assert.deepEqual(row.font, layout.font);
        assert(row.textFits, 'Localized label must fit without wrapping or truncation');
        near(row.text.height, 16);
        near(row.text.left, layout.label.left);
        near(row.icon.left, layout.icon.left);
        near(center(row.text), center(row.bounds));
        near(center(row.icon), center(row.bounds));
        if (index) near(row.bounds.top - layout.rows[index - 1].bounds.top - layout.rows[index - 1].bounds.height, 2);
      }
    }
    console.log('PASS real sort menu shared width, text/icon columns, uniform type/rows and vertical centering for every locale');
    for (const language of ['en', 'ru']) {
      await command('Runtime.evaluate', { expression: `(async () => {
        await chrome.storage.sync.set({ language: '${language}' });
        document.querySelector('[data-mode="selected"]').click();
        while (model.isPending() || document.documentElement.lang !== '${language}') await new Promise(resolve => setTimeout(resolve, 20));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`, awaitPromise: true });
      const modeLayout = await command('Runtime.evaluate', { expression: `(() => {
        const group = document.querySelector('.theme-mode'), picker = document.getElementById('pick-element');
        return { height: document.body.offsetHeight, width: innerWidth,
          groupRight: group.getBoundingClientRect().right, pickerRight: picker.getBoundingClientRect().right,
          buttons: [...group.children].map(button => {
            const b = button.getBoundingClientRect(), r = document.createRange(); r.selectNodeContents(button);
            const text = r.getBoundingClientRect();
            return { width: b.width, height: b.height, centerGap: Math.abs((text.top + text.bottom - b.top - b.bottom) / 2), fits: text.width <= button.clientWidth };
          }), active: group.querySelector('[aria-pressed="true"]').dataset.mode };
      })()`, returnByValue: true });
      const value = modeLayout.result.result.value;
      assert.equal(value.active, 'selected'); assert(value.height <= 600 && value.width <= 360);
      assert(Math.abs(value.groupRight - value.pickerRight) < .02);
      assert(Math.abs(value.buttons[0].width - value.buttons[1].width) < .02);
      assert(value.buttons.every(button => button.height === 30 && button.fits && button.centerGap < 1));
      if (process.env.HDM_SCREENSHOT_DIR) {
        const shot = await command('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(process.env.HDM_SCREENSHOT_DIR, `popup-selected-${language}.png`), Buffer.from(shot.result.data, 'base64'));
      }
      await command('Runtime.evaluate', { expression: `document.querySelector('[data-mode="selected"]').focus()` });
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft' });
      await command('Runtime.evaluate', { expression: `(async () => {
        while (model.isPending()) await new Promise(resolve => setTimeout(resolve, 20));
      })()`, awaitPromise: true });
      const activeMode = await command('Runtime.evaluate', { expression: `document.activeElement.dataset.mode + ':' + document.querySelector('.theme-mode [aria-pressed="true"]').dataset.mode`, returnByValue: true });
      assert.equal(activeMode.result.result.value, 'page:page');
    }
    console.log('PASS actual action popup selected-mode layout, EN/RU labels and keyboard mode changes');
    if (process.env.HDM_SCREENSHOT_DIR) {
      await command('Runtime.evaluate', { expression: `(async () => {
        globalThis.screenshotSites = (await chrome.storage.local.get('universalSites')).universalSites;
        await chrome.storage.local.set({ universalSites: screenshotSites.slice(0, 5) });
        while (document.querySelectorAll('#library-list .site-entry').length !== 5) await new Promise(resolve => setTimeout(resolve, 20));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`, awaitPromise: true });
      const shortShot = await command('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(process.env.HDM_SCREENSHOT_DIR, 'popup-five-sites.png'), Buffer.from(shortShot.result.data, 'base64'));
      await command('Runtime.evaluate', { expression: `(async () => {
        await chrome.storage.local.set({ universalSites: screenshotSites });
        while (document.querySelectorAll('#library-list .site-entry').length !== screenshotSites.length) await new Promise(resolve => setTimeout(resolve, 20));
        delete globalThis.screenshotSites;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`, awaitPromise: true });
      const shot = await command("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(process.env.HDM_SCREENSHOT_DIR, "popup.png"), Buffer.from(shot.result.data, "base64"));
      await command("Runtime.evaluate", { expression: "document.getElementById('library-sort').click()" });
      const menuShot = await command("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(process.env.HDM_SCREENSHOT_DIR, "popup-sort-open.png"), Buffer.from(menuShot.result.data, "base64"));
      for (const language of ['ru', 'en']) {
        await command('Runtime.evaluate', { expression: `(async () => { await chrome.storage.sync.set({ language: '${language}' }); })()`, awaitPromise: true });
        const points = await command('Runtime.evaluate', { expression: `(() => [...document.querySelectorAll('#library-sort-menu button')].map(row => { const b = row.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }))()`, returnByValue: true });
        for (const [index, point] of points.result.result.value.entries()) {
          await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
          const hoverShot = await command('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(path.join(process.env.HDM_SCREENSHOT_DIR, `sort-${language}-hover-${index}.png`), Buffer.from(hoverShot.result.data, 'base64'));
        }
      }
      await command('Runtime.evaluate', { expression: "chrome.storage.sync.set({ language: 'ru' })", awaitPromise: true });
      await command("Runtime.evaluate", { expression: "document.getElementById('library-sort').click(); document.getElementById('library-sort').focus()" });
    }
    const expanded = await command("Runtime.evaluate", { expression: `(async () => {
      const saved = (await chrome.storage.local.get('universalSites')).universalSites;
      const expanded = saved.map(site => site.origin === 'http://127.0.0.1' ? { ...site, exclusions: Array.from({ length: 25 }, (_, i) => ({ path: ['#missing-' + i], label: 'Sample excluded element ' + i })) } : site);
      await chrome.storage.local.set({ universalSites: expanded });
      const until = Date.now() + 3000;
      while (document.querySelectorAll('#exclusion-list .exclusion-row').length !== 25 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 30));
      document.getElementById('exclusion-details').open = true;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.scrollTo(0, document.documentElement.scrollHeight);
      const result = { height: document.body.offsetHeight, content: document.body.scrollHeight, scroll: scrollY,
        width: innerWidth, contentWidth: document.documentElement.scrollWidth, repeat: getComputedStyle(document.body).backgroundRepeat };
      await chrome.storage.local.set({ universalSites: saved });
      document.getElementById('exclusion-details').open = false;
      return result;
    })()`, returnByValue: true, awaitPromise: true });
    const overflow = expanded.result.result.value;
    assert(overflow.height > 600 && overflow.height >= overflow.content && overflow.scroll > 0, JSON.stringify(overflow));
    assert(overflow.contentWidth <= overflow.width && overflow.repeat.split(',').every(value => value.trim() === 'no-repeat'));
    await command("Runtime.evaluate", { expression: "document.getElementById('pick-element').click()" });
    await panel.waitFor();
    await send({ type: "hdm-universal-set-enabled", origin: "http://127.0.0.1", enabled: false });
    await panel.waitFor({ state: "detached" });
    assert.equal(await page.locator("[data-hdm-excluded]").count(), 0);
    await cdp.detach();
    console.log("PASS actual compact/scrolled toolbar popup background and width", geometry, overflow);
    console.log("PASS actual popup starts picker; pausing cleans picker and exception styles");
  } finally { transport.dispose(); }
});
