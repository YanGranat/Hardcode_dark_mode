import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createBrowserHarness, decodePng } from "./support/browser.mjs";
const graphic = id => `<svg xmlns="http://www.w3.org/2000/svg" class="slide" id="${id}" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#061e47"/><rect x="25" y="25" width="45" height="45" fill="#ffd144"/><rect x="100" y="25" width="45" height="45" fill="#28e4bc"/><text x="20" y="135" font-family="sans-serif" font-size="35" fill="white">Slide</text></svg>`;
const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:16px sans-serif;background:#ddd}#workspace{margin:30px;width:700px;height:520px;background:white;padding:40px;box-sizing:border-box}
.slide{display:block}#other{position:absolute;left:410px;top:70px;width:160px;height:90px}#clipped{width:220px;height:100px;overflow:hidden;margin-top:30px}.slide-copy{transform:scale(.5);transform-origin:top left}
#counter{margin-top:10px;background-image:linear-gradient(white,white);padding:10px;width:320px}#shadow{margin:30px}#clip-note{background:white}
</style></head><body><div id="workspace"><div id="stage">${graphic("slide-a")}</div>${graphic("other")}<div id="counter">${graphic("nested")}</div></div><div id="shadow" class="shadow-container"></div><script>
window.replaceSlide=id=>{document.querySelector('#stage').innerHTML=${JSON.stringify(graphic("PLACEHOLDER"))}.replace('PLACEHOLDER',id)};
document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<style>.area{width:400px;height:240px;background:white;padding:20px;box-sizing:border-box}svg{display:block}</style><div class="area">'+${JSON.stringify(graphic("shadow-slide"))}+'</div>';
</script></body></html>`;
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  // No network-backed filter resources are permitted. Page fixture script/style
  // are explicit exceptions; the extension runs in its isolated world.
  response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:");
  response.end(fixture);
});
let context;
const harness = createBrowserHarness({ server, timeout: 90000, name: "Region" });
await harness.run(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  context = await harness.launch();
  harness.deadline();
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
  const send = message => popup.evaluate(message => chrome.runtime.sendMessage(message), message);
  const origin = "http://127.0.0.1";
  const stored = () => popup.evaluate(async () => (await chrome.storage.local.get('universalSites')).universalSites[0]);
  const capture = async selector => {
    const png = await page.locator(selector).screenshot();
    return decodePng(page, png);
  };
  const sameColors = (actual, expected, message) => {
    assert.equal(actual.width, expected.width, message); assert.equal(actual.height, expected.height, message);
    // Compare opaque color patches, not LCD font antialiasing after compositing.
    for (const [x, y] of [[10, 10], [35, 35], [115, 35], [300, 165]]) {
      const offset = (Math.floor(y * actual.height / 180) * actual.width + Math.floor(x * actual.width / 320)) * 4;
      assert.deepEqual(actual.pixels.slice(offset, offset + 4), expected.pixels.slice(offset, offset + 4), message);
    }
  };
  const original = await capture('#slide-a'), nested = await capture('#nested'), other = await capture('#other');
  await send({ type: 'hdm-universal-add-site', url: page.url() });
  await send({ type: 'hdm-universal-set-mode', origin, mode: 'selected' });
  await page.waitForFunction(() => document.documentElement.classList.contains('dmx-mode-selected'));
  const panel = page.locator('[data-hdm-picker]');
  await popup.evaluate(() => chrome.storage.sync.set({ language: 'ru' }));
  await popup.waitForFunction(() => document.documentElement.lang === 'ru');
  const choose = async selector => {
    const rect = await page.locator(selector).boundingBox();
    await page.mouse.move(rect.x + 6, rect.y + 6); await page.mouse.click(rect.x + 6, rect.y + 6);
  };
  const createWorkspace = async () => {
    await popup.locator('#pick-element:not([disabled])').click(); await page.bringToFront(); await panel.waitFor();
    await panel.locator('[data-action="move"]').click(); await choose('#workspace');
  };
  const addException = async (selector, similar = false) => {
    await panel.locator('[data-action="addException"]').click(); await choose(selector);
    if (similar) await panel.locator('[data-action="similar"]').click();
    await panel.locator('[data-action="applyException"]').click();
  };
  const editWorkspace = async () => {
    await popup.locator('#exclusion-details').evaluate(node => node.open = true);
    await popup.locator('#exclusion-list .rule-edit').first().click(); await page.bringToFront(); await panel.waitFor();
    await panel.locator('[data-action="move"]').click();
  };
  const structuralPaths = ["#repeated > div:nth-of-type(1)", "#repeated > div:nth-of-type(2)"];
  await page.evaluate(() => {
    const container = document.createElement("section");
    container.id = "repeated";
    container.style.cssText = "margin:20px;display:flex;gap:12px";
    container.innerHTML = '<div style="width:100px;height:60px;background:white">One</div><div style="width:100px;height:60px;background:white">Two</div>';
    document.body.append(container);
  });
  for (const path of structuralPaths) assert.equal((await send({ type: "hdm-inversion-save", origin,
    rule: { path: [path], label: "div", protections: [] } })).ok, true);
  await popup.locator('#exclusion-details').evaluate(node => node.open = true);
  await popup.waitForFunction(() => document.querySelectorAll("#exclusion-list .rule-edit").length === 2);
  await popup.setViewportSize({ width: 360, height: 850 });
  const names = await popup.locator("#exclusion-list .rule-edit").allTextContents();
  for (const [index, path] of structuralPaths.entries()) assert(names[index].startsWith(path));
  const rowsFit = await popup.locator("#exclusion-list").evaluate(list => [...list.children].every(row => {
    const label = row.querySelector(".rule-edit").getBoundingClientRect();
    const remove = row.querySelector(".remove-site-btn").getBoundingClientRect();
    return label.right <= remove.left && remove.right <= document.documentElement.clientWidth;
  }));
  assert.equal(rowsFit, true, "structural labels leave space for their remove buttons");
  if (process.env.HDM_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.HDM_SCREENSHOT_DIR, { recursive: true });
    await popup.screenshot({ path: path.join(process.env.HDM_SCREENSHOT_DIR, "structural-rule-labels.png") });
  }
  await popup.locator('#exclusion-list .rule-edit').first().click();
  await page.bringToFront(); await panel.waitFor();
  assert((await panel.locator('.root-context').textContent()).includes(structuralPaths[0]));
  await panel.locator('[data-action="cancel"]').click(); await panel.waitFor({ state: 'detached' });
  for (const path of structuralPaths) await send({ type: "hdm-inversion-remove", origin, path: [path] });
  await page.evaluate(() => document.getElementById("repeated").remove());
  await popup.setViewportSize({ width: 1000, height: 850 });
  console.log("PASS persisted structural labels remain distinct, fit the popup and identify the edited block");
  await createWorkspace();
  await addException('#slide-a'); await addException('#nested');
  await popup.locator('#pick-element:not([disabled])').click();
  await popup.locator('#toast').filter({ hasText: 'уже открыт' }).waitFor();
  await page.bringToFront();
  assert.equal(await page.locator('[data-hdm-picker]').count(), 1);
  assert.equal(await panel.locator('[data-action="removeException"]').count(), 2, 'Repeated opening must retain the existing draft');
  await panel.locator('[data-action="addException"]').click();
  await choose('#workspace');
  assert.equal(await panel.locator('[data-action="applyException"]').isDisabled(), true, 'The parent itself cannot become its own exception');
  await choose('#shadow-slide');
  assert.equal(await panel.locator('[data-action="applyException"]').isDisabled(), true, 'An exception must stay inside its parent');
  await page.keyboard.press('Escape');
  assert.equal(await panel.locator('.exception-row').count(), 2, 'Escape discards only the unfinished exception');
  assert.equal(await panel.locator('[data-action="save"]').isVisible(), true);
  assert.equal((await stored()).inclusions.length, 0, 'Draft exceptions must not save the parent or children prematurely');
  await panel.locator('[data-action="cancel"]').click(); await panel.waitFor({ state: 'detached' });
  sameColors(await capture('#slide-a'), original, 'Cancel restores original pixels and discards the entire draft');
  const cancelledWorkspace = await capture('#workspace');
  const cancelledBackground = (10 * cancelledWorkspace.width + 10) * 4;
  assert(cancelledWorkspace.pixels.slice(cancelledBackground, cancelledBackground + 3).every(channel => channel > 240), 'Cancel must also remove the parent inversion, not merely preserve its protected children');
  assert.equal((await stored()).inclusions.length, 0);
  await createWorkspace(); await addException('#slide-a'); await addException('#nested');
  if (process.env.HDM_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.HDM_SCREENSHOT_DIR, { recursive: true });
    await page.mouse.move(0, 0); await new Promise(resolve => setTimeout(resolve, 200));
    await panel.locator('.panel').screenshot({ path: path.join(process.env.HDM_SCREENSHOT_DIR, 'inline-overview-ru.png') });
  }
  await panel.locator('[data-action="save"]').click(); await panel.waitFor({ state: 'detached' });
  assert.equal((await stored()).inclusions[0].protections.length, 2);
  assert.equal((await stored()).protections.length, 0, 'Block exceptions must not create site-level protections');
  assert.equal(await popup.locator('#protect-element').count(), 0, 'Selected-block exceptions are configured inside the block editor');
  await page.waitForFunction(() => document.querySelector('#workspace').getAttribute('data-hdm-cutout') === 'mask', null, { timeout: 5000 }).catch(async error => {
    console.error('Cutout diagnostics', await page.evaluate(() => ({ owner: document.querySelector('#workspace').outerHTML.slice(0, 400), filters: document.querySelectorAll('filter').length })), errors);
    throw error;
  });
  sameColors(await capture('#slide-a'), original, 'A protected slide must keep original saturated colors');
  sameColors(await capture('#nested'), nested, 'Protection must cut through an automatic media counter-filter too');
  const workspace = await capture('#workspace');
  assert(workspace.pixels.slice((10 * workspace.width + 10) * 4, (10 * workspace.width + 10) * 4 + 3).every(channel => channel < 60), 'The surrounding white workspace must become dark');
  const otherDark = await capture('#other');
  assert.notDeepEqual(otherDark.pixels.slice(0, 4), other.pixels.slice(0, 4), 'Unprotected slide must still be inverted');
  console.log('PASS strict-CSP original pixels, workspace background and crossing media filter');
  harness.deadline();

  const beforeQueuedClose = await stored();
  await editWorkspace();
  while (await panel.locator('[data-action="removeException"]').count()) {
    await panel.locator('[data-action="removeException"]').last().click();
  }
  await panel.locator('[data-action="addException"]').click();
  await choose('#slide-a');
  await page.evaluate(() => {
    const target = document.querySelector('#slide-a'), replacement = target.cloneNode(true);
    for (const node of [replacement, ...replacement.querySelectorAll('*')]) {
      for (const name of node.getAttributeNames()) if (name.startsWith('data-hdm-')) node.removeAttribute(name);
      node.style?.removeProperty('--hdm-cutout-filter');
    }
    const host = document.querySelector('[data-hdm-picker]');
    target.remove();
    window.dispatchEvent(new Event('scroll'));
    host.shadowRoot.querySelector('[data-action="cancel"]').click();
    document.querySelector('#stage').append(replacement);
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('[data-hdm-picker]').count(), 0);
  assert.deepEqual(await stored(), beforeQueuedClose, 'A queued redraw after cancellation must not commit or replace the persisted bundle');
  sameColors(await capture('#slide-a'), original, 'Closing before a queued redraw restores persisted slide protection after remount');
  sameColors(await capture('#nested'), nested, 'A closed draft cannot revive removed exceptions or replace the persisted preview');
  await editWorkspace();
  assert.equal(await panel.locator('[data-action="removeException"]').count(), 2, 'A fresh editor must start from the persisted bundle, not a closed draft');
  await panel.locator('[data-action="cancel"]').click(); await panel.waitFor({ state: 'detached' });
  console.log('PASS queued redraw cancellation, remount and subsequent editor isolation');
  harness.deadline();

  await editWorkspace();
  assert.match(await panel.locator('#picker-status').textContent(), /Проверьте результат/);
  await panel.locator('[data-action="addException"]').click();
  const bounds = await page.locator('#other').boundingBox();
  await page.mouse.click(bounds.x + 10, bounds.y + 10);
  await panel.locator('[data-action="similar"]').click();
  assert.equal(await panel.locator('[data-action="similar"]').getAttribute('aria-pressed'), 'true');
  assert.match(await panel.locator('.match-count').textContent(), /3/);
  const size = await panel.locator('.scope-controls button').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
  assert.equal(size[0].width, size[1].width); assert.equal(size[0].height, size[1].height);
  const scopeColors = await panel.locator('.scope-controls button').evaluateAll(nodes => nodes.map(node => ({ pressed: node.getAttribute('aria-pressed'), color: getComputedStyle(node).color })));
  assert.deepEqual(scopeColors.map(node => node.pressed), ['false', 'true']);
  assert.notEqual(scopeColors[0].color, scopeColors[1].color, 'The selected group must retain a visible active state');
  if (process.env.HDM_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.HDM_SCREENSHOT_DIR, { recursive: true });
    await page.mouse.move(0, 0); await new Promise(resolve => setTimeout(resolve, 200));
    await page.screenshot({ path: path.join(process.env.HDM_SCREENSHOT_DIR, 'similar-regions-ru.png') });
  }
  await panel.locator('[data-action="applyException"]').click();
  await panel.locator('[data-action="save"]').click(); await panel.waitFor({ state: 'detached' });
  assert((await stored()).inclusions[0].protections.some(rule => rule.matchAll && rule.path[0] === 'svg.slide'));
  sameColors(await capture('#other'), other, 'Group preview/save must protect all matching slide surfaces');
  await page.evaluate(() => replaceSlide('slide-next'));
  await page.waitForFunction(() => document.querySelector('#workspace').getAttribute('data-hdm-cutout') === 'mask');
  sameColors(await capture('#slide-next'), original, 'New slide instances must inherit the explicit group protection');
  await page.evaluate(() => replaceSlide('slide-back'));
  sameColors(await capture('#slide-back'), original, 'Returning to a recreated slide must retain group protection');
  console.log('PASS group picker preview, saved classes, forward/back replacement');
  harness.deadline();

  await popup.locator('#pick-element:not([disabled])').click(); await page.bringToFront(); await panel.waitFor();
  await panel.locator('[data-action="move"]').click(); await choose('#other');
  assert.equal(await panel.locator('[data-action="save"]').isDisabled(), true, 'An exception owned by another block cannot silently cancel a new inversion');
  assert.match(await panel.locator('#picker-status').textContent(), /исключён/);
  await panel.locator('[data-action="cancel"]').click(); await panel.waitFor({ state: 'detached' });

  await page.evaluate(() => {
    const block = document.createElement('div'); block.id = 'independent-block';
    block.style.cssText = 'position:fixed;left:800px;top:420px;width:150px;height:180px;background:white';
    block.innerHTML = '<div id="independent-protected" style="width:100px;height:100px;background:blue;transform:rotate(5deg)"></div>';
    document.body.append(block);
  });
  await send({ type: 'hdm-inversion-save', origin, rule: { path: ['#independent-block'], label: 'Independent block', protections: [{ path: ['#independent-protected'] }] } });
  await page.waitForFunction(() => document.querySelector('#independent-block').getAttribute('data-hdm-cutout') === 'blocked');
  const beforeRemount = await stored();
  await editWorkspace();
  assert.equal(await panel.locator('[data-action="save"]').isDisabled(), false, 'An unrelated unsupported block must not disable this editor');
  await page.evaluate(() => { globalThis.detachedWorkspace = document.querySelector('#workspace'); detachedWorkspace.remove(); });
  await panel.locator('[data-action="save"][disabled]').waitFor();
  const missingIdle = await panel.evaluate(async host => {
    let changes = 0; const observer = new MutationObserver(records => changes += records.length);
    observer.observe(host.shadowRoot, { childList: true, subtree: true });
    await new Promise(resolve => setTimeout(resolve, 120)); observer.disconnect(); return changes;
  });
  assert.equal(missingIdle, 0, 'Missing-parent status must not fight an unrelated blocked-root warning');
  await page.evaluate(() => {
    const clone = detachedWorkspace.cloneNode(true);
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      for (const name of node.getAttributeNames()) if (name.startsWith('data-hdm-')) node.removeAttribute(name);
      node.style?.removeProperty('--hdm-cutout-filter');
    }
    document.body.prepend(clone); delete globalThis.detachedWorkspace;
  });
  await panel.locator('[data-action="save"]:not([disabled])').waitFor();
  assert.equal(await panel.locator('[data-action="removeException"]').count(), 3, 'A delayed parent remount must retain the whole draft');
  await panel.locator('[data-action="removeException"]').all().then(async buttons => {
    for (let i = buttons.length - 1; i >= 0; i--) await panel.locator('[data-action="removeException"]').last().click();
  });
  assert.equal((await stored()).inclusions[0].protections.length, 3, 'Editing removals remain unsaved');
  await panel.locator('[data-action="cancel"]').click(); await panel.waitFor({ state: 'detached' });
  assert.deepEqual(await stored(), beforeRemount);
  await send({ type: 'hdm-inversion-remove', origin, path: ['#independent-block'] });
  await page.evaluate(() => document.querySelector('#independent-block').remove());
  sameColors(await capture('#slide-back'), original, 'Cancelling exception removals restores persisted protection');
  console.log('PASS delayed parent remount and cancellation of edited exceptions');
  harness.deadline();

  await popup.evaluate(async () => {
    const { universalSites } = await chrome.storage.local.get('universalSites');
    universalSites[0].protections = [{ path: ['#workspace'], label: 'Old workspace exception' }];
    await chrome.storage.local.set({ universalSites });
  });
  await editWorkspace();
  await panel.locator('[data-action="save"][disabled]').waitFor();
  await panel.locator('[data-action="removeLegacy"]').click();
  assert.equal(await panel.locator('[data-action="save"]').isDisabled(), false);
  assert.equal((await stored()).protections.length, 1, 'Legacy removal must wait for the same Save transaction');
  await panel.locator('[data-action="cancel"]').click(); await panel.waitFor({ state: 'detached' });
  assert.equal((await stored()).protections.length, 1);
  await editWorkspace(); await panel.locator('[data-action="removeLegacy"]').click();
  await panel.locator('[data-action="save"]').click(); await panel.waitFor({ state: 'detached' });
  assert.equal((await stored()).protections.length, 0);
  sameColors(await capture('#slide-back'), original, 'Repairing an oversized old exclusion retains local exceptions');
  console.log('PASS visible legacy conflict, preview repair, cancel and atomic cleanup');
  harness.deadline();

  async function checkToolbar(width, label) {
    await page.setViewportSize({ width, height: 850 });
    const layout = await panel.locator('.panel').evaluate(node => {
      const rect = node.getBoundingClientRect();
      const buttons = [...node.querySelectorAll('button')].filter(button => button.getClientRects().length).map(button => {
        const box = button.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      });
      return { left: rect.left, right: rect.right, scroll: node.scrollWidth, client: node.clientWidth, buttons };
    });
    assert(layout.left >= 11 && layout.right <= width - 11 && layout.scroll <= layout.client, `${label}: ${JSON.stringify(layout)}`);
    for (const button of layout.buttons) assert(button.left >= layout.left && button.right <= layout.right, label);
    for (let i = 0; i < layout.buttons.length; i++) for (let j = i + 1; j < layout.buttons.length; j++) {
      const a = layout.buttons[i], b = layout.buttons[j];
      assert(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, `${label}: controls overlap`);
    }
    if (process.env.HDM_SCREENSHOT_DIR && width === 320) await panel.locator('.panel').screenshot({ path: path.join(process.env.HDM_SCREENSHOT_DIR, label + '.png') });
  }
  for (const language of ['en', 'ru']) {
    await popup.evaluate(language => chrome.storage.sync.set({ language }), language);
    await popup.waitForFunction(language => document.documentElement.lang === language, language);
    await editWorkspace();
    for (const width of [375, 320, 1000]) await checkToolbar(width, `inline-overview-${language}-${width}`);
    await panel.locator('[data-action="addException"]').click();
    for (const width of [375, 320, 1000]) await checkToolbar(width, `inline-select-${language}-${width}`);
    await page.keyboard.press('Escape');
    assert.equal(await panel.locator('[data-action="addException"]').isVisible(), true);
    await panel.locator('[data-action="cancel"]').click(); await panel.waitFor({ state: 'detached' });
  }
  console.log('PASS complete inline editor layout and phase cancellation at 320/375/1000px in EN/RU');
  harness.deadline();

  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) {
      const card = document.createElement('div'); card.id = `card-${i}`; card.className = 'group-card' + (i < 2 ? ' active' : '');
      card.style.cssText = `position:fixed;left:800px;top:${70 + i * 70}px;width:150px;height:50px;background:white`;
      document.body.append(card);
    }
  });
  await popup.locator('#pick-element:not([disabled])').click();
  await page.bringToFront(); await panel.waitFor(); await panel.locator('[data-action="move"]').click();
  await page.mouse.click(810, 80); await panel.locator('[data-action="similar"]').click();
  assert.match(await panel.locator('.match-count').textContent(), /2/);
  await page.evaluate(() => document.querySelector('#card-0').classList.remove('active'));
  await panel.locator('.match-count').filter({ hasText: '1' }).waitFor();
  await page.evaluate(() => document.querySelector('#card-1').classList.remove('active'));
  await panel.locator('[data-action="save"][disabled]').waitFor();
  assert.match(await panel.locator('#picker-status').textContent(), /не найден/);
  await page.evaluate(() => document.querySelector('#card-1').classList.add('active'));
  await panel.locator('[data-action="save"]:not([disabled])').waitFor();
  assert.doesNotMatch(await panel.locator('#picker-status').textContent(), /не найден/);
  const previewColor = async selector => { const image = await capture(selector); return image.pixels.slice((5 * image.width + 5) * 4, (5 * image.width + 5) * 4 + 3); };
  assert((await previewColor('#card-0')).every(channel => channel > 240), 'A class change must remove the card from the fixed preview group');
  assert((await previewColor('#card-1')).every(channel => channel < 60), 'The original class group must remain inverted');
  assert((await previewColor('#card-2')).every(channel => channel > 240), 'Preview must not silently broaden when the picked element loses a class');
  await panel.locator('[data-action="save"]').click(); await panel.waitFor({ state: 'detached' });
  const fixedGroup = (await stored()).inclusions.find(rule => rule.matchAll);
  assert.deepEqual(fixedGroup.path, ['div.active.group-card']);
  await page.evaluate(() => { const card = document.querySelector('#card-1').cloneNode(); card.removeAttribute('data-hdm-inverted'); card.id = 'card-future'; card.style.top = '280px'; document.body.append(card); });
  await page.waitForFunction(() => document.querySelector('#card-future').hasAttribute('data-hdm-inverted'));
  assert((await previewColor('#card-future')).every(channel => channel < 60), 'New matching instances must inherit an inversion group too');
  await send({ type: 'hdm-inversion-remove', origin, path: fixedGroup.path, matchAll: true });
  await page.evaluate(() => document.querySelectorAll('.group-card').forEach(card => card.remove()));
  console.log('PASS inversion groups and canonical preview/save while site classes change');
  harness.deadline();

  await page.evaluate(() => {
    const stage = document.querySelector('#stage'); stage.style.transform = 'translate(37.5px, 6.5px) scale(.8)'; stage.style.transformOrigin = 'top left';
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  const scaledOriginal = await capture('#slide-back');
  await send({ type: 'hdm-universal-set-enabled', origin, enabled: false });
  await page.waitForFunction(() => !document.documentElement.classList.contains('dmx-on'));
  sameColors(scaledOriginal, await capture('#slide-back'), 'Fractional translation and scaling must keep original colors');
  await send({ type: 'hdm-universal-set-enabled', origin, enabled: true });
  await page.waitForFunction(() => document.querySelector('#workspace').hasAttribute('data-hdm-cutout'));
  await page.evaluate(() => document.querySelector('#stage').style.transform = 'rotate(5deg)');
  await page.waitForFunction(() => document.querySelector('#workspace').getAttribute('data-hdm-cutout') === 'blocked');
  await editWorkspace(); await panel.locator('[data-action="addException"]').click();
  const rotated = await page.locator('#slide-back').boundingBox();
  await page.mouse.click(rotated.x + rotated.width / 2, rotated.y + rotated.height / 2);
  await panel.locator('#picker-status').filter({ hasText: 'исходные цвета' }).waitFor();
  assert.equal(await panel.locator('[data-action="applyException"]').isDisabled(), true, 'Unsupported protection cannot be saved as a successful exclusion');
  await page.evaluate(async () => {
    globalThis.restoreGeometry = document.querySelector('#stage').animate([{ transform: 'rotate(5deg)' }, { transform: 'rotate(0deg)' }], { duration: 160, fill: 'forwards' });
    await restoreGeometry.finished;
  });
  await panel.locator('[data-action="applyException"]:not([disabled])').waitFor({ timeout: 5000 });
  await page.evaluate(() => { restoreGeometry.cancel(); delete globalThis.restoreGeometry; });
  await panel.locator('[data-action="applyException"][disabled]').waitFor();
  await new Promise(resolve => setTimeout(resolve, 100));
  const pickerIdleWrites = await panel.evaluate(async host => {
    let count = 0; const observer = new MutationObserver(records => count += records.length);
    observer.observe(host.shadowRoot, { childList: true, subtree: true });
    await new Promise(resolve => setTimeout(resolve, 150)); observer.disconnect(); return count;
  });
  assert.equal(pickerIdleWrites, 0, 'Blocked preview status/count must not create a redraw feedback loop');
  await panel.locator('[data-action="cancel"]').click(); await panel.waitFor({ state: 'detached' });
  await page.evaluate(() => document.querySelector('#stage').style.transform = 'none');
  await page.waitForFunction(() => document.querySelector('#workspace').getAttribute('data-hdm-cutout') === 'mask');
  console.log('PASS fractional geometry and safe unsupported-transform behavior');
  harness.deadline();

  await page.evaluate(() => {
    const root = document.createElement('div'); root.id = 'motion-root';
    root.style.cssText = 'position:absolute;left:780px;top:30px;width:160px;height:160px;overflow:hidden;background:white';
    root.innerHTML = '<div id="motion-child" style="width:80px;height:80px;transform:rotate(5deg);background:#061e47"></div>';
    document.body.append(root);
  });
  await send({ type: 'hdm-inversion-save', origin, rule: { path: ['#motion-root'], label: 'Motion-only block', protections: [{ path: ['#motion-child'] }] } });
  await page.waitForFunction(() => document.querySelector('#motion-root').getAttribute('data-hdm-cutout') === 'blocked');
  await popup.locator('#exclusion-list .rule-edit').filter({ hasText: 'Motion-only block' }).click();
  await page.bringToFront(); await panel.waitFor();
  assert.equal(await panel.locator('[data-action="save"]').isDisabled(), true);
  await page.evaluate(async () => {
    globalThis.cutoutMotion = document.querySelector('#motion-child').animate([{ translate: '0px' }, { translate: '300px' }], { duration: 160, fill: 'forwards' });
    await cutoutMotion.finished;
  });
  await page.waitForFunction(() => !document.querySelector('#motion-root').hasAttribute('data-hdm-cutout'));
  await panel.locator('[data-action="save"]:not([disabled])').waitFor({ timeout: 5000 });
  await page.evaluate(async () => { cutoutMotion.reverse(); await cutoutMotion.finished; });
  await page.waitForFunction(() => document.querySelector('#motion-root').getAttribute('data-hdm-cutout') === 'blocked');
  await panel.locator('[data-action="save"][disabled]').waitFor({ timeout: 5000 });
  await panel.locator('[data-action="cancel"]').click(); await panel.waitFor({ state: 'detached' });
  await send({ type: 'hdm-inversion-remove', origin, path: ['#motion-root'] });
  await page.evaluate(() => { cutoutMotion.cancel(); delete globalThis.cutoutMotion; document.querySelector('#motion-root').remove(); });
  console.log('PASS motion-only blocked/absent transitions update editor controls without filter-tree mutations');
  harness.deadline();

  const shadowOriginal = await capture('#shadow-slide');
  assert.equal((await send({ type: 'hdm-inversion-save', origin, rule: {
    path: ['#shadow', '.area'], label: 'Shadow area', protections: [{ path: ['#shadow', '#shadow-slide'], label: 'Shadow slide' }]
  } })).ok, true);
  await page.waitForFunction(() => document.querySelector('#shadow').shadowRoot.querySelector('.area').getAttribute('data-hdm-cutout') === 'mask');
  sameColors(await capture('#shadow-slide'), shadowOriginal, 'Local filter definitions must work inside open Shadow DOM');
  await send({ type: 'hdm-inversion-remove', origin, path: ['#shadow', '.area'] });

  const pixelAt = async (x, y) => {
    const image = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
    return page.evaluate(async encoded => {
      const img = new Image(); img.src = 'data:image/png;base64,' + encoded; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    }, image.toString('base64'));
  };
  await page.evaluate(() => {
    const stage = document.querySelector('#stage'); stage.style.cssText = 'width:160px;height:80px;overflow:auto';
    stage.scrollLeft = 50; stage.scrollTop = 30;
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  const clippedPixel = await pixelAt(320, 100);
  assert(clippedPixel.slice(0, 3).every(value => value < 60), `A clipped slide must not protect white pixels outside its visible scroll area: ${clippedPixel}`);
  await page.evaluate(() => document.querySelector('#stage').removeAttribute('style'));
  await page.evaluate(async () => {
    const animation = document.querySelector('#stage').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(50px)' }], { duration: 180, fill: 'forwards' });
    globalThis.regionMotion = animation; await animation.finished;
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert((await pixelAt(80, 80)).slice(0, 3).every(value => value < 60), 'Geometry must follow CSS motion without leaving an old protected hole');
  assert.deepEqual(await pixelAt(130, 80), [6, 30, 71, 255], 'Moved protected slide must retain the original navy color');
  await page.evaluate(() => globalThis.regionMotion.cancel());
  await new Promise(resolve => setTimeout(resolve, 100));
  const idleWrites = await page.evaluate(async () => {
    let count = 0; const observer = new MutationObserver(records => count += records.length);
    observer.observe(document, { subtree: true, childList: true, attributes: true });
    await new Promise(resolve => setTimeout(resolve, 150)); observer.disconnect(); return count;
  });
  assert.equal(idleWrites, 0, 'Stable cutouts must not repeatedly mutate DOM or recreate filters');
  await page.evaluate(() => { const base = document.createElement('base'); base.href = '/different/base/'; document.head.append(base); });
  await new Promise(resolve => setTimeout(resolve, 50));
  sameColors(await capture('#slide-back'), original, 'A page base URL must not redirect local filter definitions');
  assert((await pixelAt(40, 40)).slice(0, 3).every(value => value < 60), 'The outer filter must still work with a base URL');
  await page.evaluate(() => document.querySelector('base').remove());
  console.log('PASS Shadow DOM, scroll clipping, CSS motion, idle idempotence and base URL');
  harness.deadline();

  await page.evaluate(() => document.querySelector('#workspace').requestFullscreen());
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  sameColors(await capture('#slide-back'), original, 'Fullscreen must preserve the protected slide');
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.fullscreenElement);
  console.log('PASS protected workspace fullscreen');
  harness.deadline();

  const overlapPosition = await page.evaluate(async () => {
    const image = document.createElement('img'); image.id = 'overlapping-media';
    image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>');
    image.style.cssText = 'position:absolute;left:340px;top:70px;width:100px;height:100px';
    document.querySelector('#workspace').append(image); await image.decode();
    const rect = image.getBoundingClientRect(); return { x: rect.x, y: rect.y };
  });
  await page.waitForFunction(() => document.querySelector('#workspace').getAttribute('data-hdm-cutout') === 'blocked');
  assert((await pixelAt(40, 40)).slice(0, 3).every(value => value > 240), 'Unsupported overlapping filter layers must suspend inversion instead of damaging protected colors');
  const overlapAfter = await page.locator('#overlapping-media').boundingBox();
  assert.equal(overlapAfter.x, overlapPosition.x); assert.equal(overlapAfter.y, overlapPosition.y, 'Suspension must retain the filter-created containing block');
  const overlapPixels = await capture('#overlapping-media');
  const overlapInterior = (5 * overlapPixels.width + 5) * 4;
  assert.deepEqual(overlapPixels.pixels.slice(overlapInterior, overlapInterior + 4), [255, 0, 0, 255]);
  await page.evaluate(() => document.querySelector('#overlapping-media').remove());
  await page.waitForFunction(() => document.querySelector('#workspace').getAttribute('data-hdm-cutout') === 'mask');
  console.log('PASS overlapping media fail-safe keeps original colors and positioned layout');
  harness.deadline();

  await page.evaluate(() => {
    const extra = document.createElement('div'); extra.id = 'group-overflow';
    extra.innerHTML = '<svg class="slide" width="1" height="1"></svg>'.repeat(498); document.body.append(extra);
  });
  await page.waitForFunction(() => document.querySelector('#workspace').getAttribute('data-hdm-cutout') === 'blocked');
  sameColors(await capture('#slide-back'), original, 'Group overflow must stop inversion rather than discard protection');
  sameColors(await capture('#nested'), nested, 'Group overflow must also stop nested media compensation');
  await page.evaluate(() => document.querySelector('#group-overflow').remove());
  await page.waitForFunction(() => document.querySelector('#workspace').getAttribute('data-hdm-cutout') === 'mask');
  console.log('PASS group growth beyond limit fails safely and recovers');
  harness.deadline();

  const state = await stored();
  await popup.reload(); await popup.waitForFunction(() => document.querySelector('#exclusion-count').textContent === '1');
  await page.reload(); await page.waitForFunction(() => document.querySelector('#workspace').getAttribute('data-hdm-cutout') === 'mask');
  sameColors(await capture('#slide-a'), original, 'Protected group must survive page reload');
  for (const language of ['en', 'ru']) {
    await popup.evaluate(language => chrome.storage.sync.set({ language }), language);
    await popup.waitForFunction(language => document.documentElement.lang === language, language);
    await popup.locator('#exclusion-details').evaluate(node => node.open = true);
    if (process.env.HDM_SCREENSHOT_DIR) await popup.screenshot({ path: path.join(process.env.HDM_SCREENSHOT_DIR, `region-popup-${language}.png`) });
  }
  await editWorkspace();
  await panel.locator('[data-action="removeException"]').last().click();
  await panel.locator('[data-action="save"]').click(); await panel.waitFor({ state: 'detached' });
  assert.equal((await stored()).inclusions[0].protections.length, 2);
  assert.equal((await stored()).inclusions.length, state.inclusions.length, 'Removing protection must preserve inclusion rules');
  await send({ type: 'hdm-universal-remove-site', origin });
  await page.waitForFunction(() => !document.documentElement.classList.contains('dmx-on'));
  assert.equal(await page.locator('[data-hdm-cutout]').count(), 0);
  sameColors(await capture('#slide-a'), original, 'Removing site restores original colors');
  assert.deepEqual(errors, []);
  console.log('PASS reload, EN/RU popup, independent removal and cleanup');
});
