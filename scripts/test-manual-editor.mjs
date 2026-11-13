import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createBrowserHarness, decodePng } from "./support/browser.mjs";
const graphic = id => `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" class="slide-surface" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#061e47"/><text x="20" y="90" font-family="monospace" font-size="48" fill="white">SLIDE</text><rect x="240" y="25" width="45" height="45" fill="#ffd144"/></svg>`;
const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;color:black;font:16px sans-serif}
body{min-height:1100px}main{padding:20px;width:700px}
.editor-toolbar{background:#fff;color:#111;padding:15px;height:70px;box-sizing:border-box;margin-bottom:30px}
svg{display:block}.viewer{width:320px;height:180px}.editor-shadow{margin-top:35px}
.probes{margin-top:25px;display:flex;gap:10px}.probes svg{width:30px;height:30px}
</style></head><body><main><div id="toolbar-1" class="editor-toolbar"><button id="page-action">Action</button> Editor controls</div>
<div id="stage" class="viewer">${graphic("slide-a")}</div><div id="shadow-fixture" class="editor-shadow"></div>
<div class="probes"><svg class="ambiguous-surface"><rect width="30" height="30" fill="white"/></svg><svg class="ambiguous-surface"><rect width="30" height="30" fill="white"/></svg><div id="reused-graphic">Different kind</div><svg class="replacement-surface"><rect width="30" height="30" fill="white"/></svg></div>
</main><script>
window.pageClicks=0;document.querySelector('#page-action').onclick=()=>window.pageClicks++;
document.querySelector('#shadow-fixture').attachShadow({mode:'open'}).innerHTML='<style>.shadow-toolbar{background:white;color:black;width:320px;height:60px;padding:15px;box-sizing:border-box}</style><div id="shadow-toolbar-1" class="shadow-toolbar">Shadow controls</div>';
window.replaceSlide=id=>{document.querySelector('#stage').innerHTML=${JSON.stringify(graphic("PLACEHOLDER"))}.replace('PLACEHOLDER',id)};
window.replaceToolbar=id=>{const old=document.querySelector('.editor-toolbar');const next=document.createElement('div');next.id=id;next.className=old.className;next.innerHTML=old.innerHTML;old.replaceWith(next)};
</script></body></html>`;
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(fixture);
});
let context;
const harness = createBrowserHarness({ server, timeout: 45000, name: "Manual editor" });
const { deadline } = harness;
await harness.run(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  context = await harness.launch();
  deadline();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const tab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), page.url());
  const popup = await context.newPage();
  // Only substitute the active-tab lookup. Storage, messaging, controls and
  // content-script selection remain real extension behavior.
  await popup.addInitScript(targetTab => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = options => options.active ? Promise.resolve([targetTab]) : query(options);
    window.close = () => {};
  }, tab);
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  await popup.locator('#current-site-action:not([disabled])').waitFor();
  const send = message => popup.evaluate(message => chrome.runtime.sendMessage(message), message);
  const origin = "http://127.0.0.1";
  const stored = () => popup.evaluate(async () => (await chrome.storage.local.get('universalSites')).universalSites[0]);
  const settle = () => popup.waitForFunction(() => !model.isPending());
  const mode = async value => {
    await popup.locator(`[data-mode="${value}"]`).click();
    await settle();
    assert.equal((await stored()).mode, value);
    await page.waitForFunction(value => document.documentElement.classList.contains('dmx-mode-selected') === (value === 'selected'), value);
  };
  const capture = async selector => {
    const png = await page.locator(selector).screenshot();
    return decodePng(page, png);
  };
  const samePixels = (actual, expected, message) => {
    assert.equal(actual.width, expected.width, message); assert.equal(actual.height, expected.height, message);
    const mismatch = actual.pixels.findIndex((value, index) => value !== expected.pixels[index]);
    assert.equal(mismatch, -1, `${message}; first different byte ${mismatch}, actual ${actual.pixels.slice(Math.max(0, mismatch - mismatch % 4), mismatch - mismatch % 4 + 4)}, expected ${expected.pixels.slice(Math.max(0, mismatch - mismatch % 4), mismatch - mismatch % 4 + 4)}`);
  };
  // Different layout positions can put image edges on half physical pixels at
  // Windows scaling. Compare the opaque interior across positions, without a
  // color tolerance. Same-position slide/restoration checks retain every pixel.
  const mediaInterior = buffer => {
    const pixels = [];
    for (let y = 2; y < buffer.height - 2; y++) pixels.push(...buffer.pixels.slice((y * buffer.width + 2) * 4, (y * buffer.width + buffer.width - 2) * 4));
    return { width: buffer.width - 4, height: buffer.height - 4, pixels };
  };
  const surfaces = () => page.evaluate(() => [document.documentElement, document.body].map(node => {
    const style = getComputedStyle(node); return { background: style.backgroundColor, filter: style.filter };
  }));
  const originalSlide = await capture('.slide-surface'), originalToolbar = await capture('.editor-toolbar');
  const originalSurfaces = await surfaces();
  assert(originalSurfaces.every(surface => surface.background === 'rgba(0, 0, 0, 0)' && surface.filter === 'none'));
  await popup.locator('#current-site-action').click(); await settle();
  await page.waitForFunction(() => document.documentElement.classList.contains('dmx-on'));
  await popup.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = message => message.type === 'hdm-universal-set-mode'
      ? new Promise(resolve => { globalThis.releaseModeSave = async () => {
        chrome.runtime.sendMessage = send; resolve(await send(message)); delete globalThis.releaseModeSave;
      }; }) : send(message);
    document.querySelector('[data-mode="selected"]').click();
  });
  assert.equal(await popup.locator('#pick-element').isDisabled(), true, 'Selection must wait for the current site mode to commit');
  assert.equal(await popup.locator('[data-mode="page"]').isEnabled(), true, 'Mode controls must stay responsive during a save');
  assert.equal(await popup.locator('#library-list input').first().isEnabled(), true, 'Mode saving must not lock the library');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dmx-mode-selected')), false);
  await popup.evaluate(() => globalThis.releaseModeSave());
  await mode('selected');
  assert.equal(await popup.locator('#pick-element').isEnabled(), true);
  assert.deepEqual(await surfaces(), originalSurfaces, 'Manual mode must not add a root filter or opaque background');
  samePixels(await capture('.slide-surface'), originalSlide, 'Unselected slide must retain exact original colors');

  const panel = page.locator('[data-hdm-picker]');
  const pendingLanguage = await popup.evaluate(async () => {
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    globalThis.pickerRequests = 0;
    chrome.tabs.sendMessage = (...args) => {
      globalThis.pickerRequests++;
      return new Promise(resolve => { globalThis.releasePicker = async () => {
        chrome.tabs.sendMessage = send; resolve(await send(...args)); delete globalThis.releasePicker;
      }; });
    };
    document.getElementById('pick-element').click();
    const language = document.documentElement.lang === 'en' ? 'ru' : 'en';
    await chrome.storage.sync.set({ language }); return language;
  });
  await popup.waitForFunction(language => document.documentElement.lang === language, pendingLanguage);
  assert.equal(await popup.locator('#pick-element').isDisabled(), true, 'A storage-driven rerender must not unlock a pending picker request');
  assert.equal(await popup.evaluate(() => {
    document.getElementById('pick-element').dispatchEvent(new MouseEvent('click'));
    return globalThis.pickerRequests;
  }), 1, 'Repeated selection must not dispatch overlapping requests');
  await popup.evaluate(() => globalThis.releasePicker());
  await page.bringToFront(); await panel.waitFor();
  await panel.locator('[data-action="cancel"]').click();
  await panel.waitFor({ state: 'detached' });
  await popup.waitForFunction(() => !pickerPending);
  const pickAndSave = async selector => {
    await popup.locator('#pick-element').click();
    await page.bringToFront(); await panel.waitFor();
    await panel.locator('[data-action="move"]').click();
    const bounds = await page.locator(selector).boundingBox();
    await page.mouse.move(bounds.x + 7, bounds.y + 7); await page.mouse.click(bounds.x + 7, bounds.y + 7);
    await panel.locator('[data-action="save"]').click(); await panel.waitFor({ state: 'detached' });
  };
  await pickAndSave('.editor-toolbar');
  await page.waitForFunction(() => document.querySelector('.editor-toolbar').hasAttribute('data-hdm-inverted'));
  let state = await stored();
  assert.equal(state.inclusions.length, 1); assert.equal(state.exclusions.length, 0);
  assert.deepEqual(state.inclusions[0].path, ['#toolbar-1']);
  assert(state.inclusions[0].fallbackPath.length > 0 && state.inclusions[0].fallbackPath.every(part => !part.includes('#toolbar-1')));
  const toolbarDark = await capture('.editor-toolbar');
  assert(!Buffer.from(toolbarDark.pixels).equals(Buffer.from(originalToolbar.pixels)), 'Selected toolbar must actually change pixels');
  assert(toolbarDark.pixels.slice((5 * toolbarDark.width + 5) * 4, (5 * toolbarDark.width + 5) * 4 + 3).every(channel => channel < 60));
  samePixels(await capture('.slide-surface'), originalSlide, 'Toolbar inversion must not change slide pixels');
  assert.deepEqual(await surfaces(), originalSurfaces);
  assert.equal(await page.evaluate(() => window.pageClicks), 0);
  for (const slideId of ['slide-next', 'slide-return']) {
    await page.evaluate(id => window.replaceSlide(id), slideId);
    samePixels(await capture('.slide-surface'), originalSlide, 'Navigation must preserve unselected original pixels');
  }
  await page.evaluate(() => window.replaceToolbar('toolbar-return'));
  await page.waitForFunction(() => document.querySelector('#toolbar-return').hasAttribute('data-hdm-inverted'));
  samePixels(await capture('.editor-toolbar'), toolbarDark, 'Structural fallback must reconnect a replacement toolbar without copied markers');
  console.log('PASS real popup manual mode, original slide pixels, selected toolbar and structural replacement');

  deadline();
  await pickAndSave('.shadow-toolbar');
  await page.waitForFunction(() => document.querySelector('#shadow-fixture').shadowRoot.querySelector('.shadow-toolbar').hasAttribute('data-hdm-inverted'));
  state = await stored(); assert.equal(state.inclusions.length, 2);
  assert.equal(state.inclusions[1].path.length, 2); assert.equal(state.inclusions[1].fallbackPath.length, 2);
  const savedInclusions = state.inclusions;
  await mode('page');
  await page.waitForFunction(() => !document.querySelector('[data-hdm-inverted]'));
  assert.equal(await page.locator('.shadow-toolbar').getAttribute('data-hdm-inverted'), null);
  await pickAndSave('.slide-surface');
  await page.waitForFunction(() => document.querySelector('.slide-surface').hasAttribute('data-hdm-excluded'));
  state = await stored(); assert.equal(state.exclusions.length, 1); assert.deepEqual(state.inclusions, savedInclusions);
  assert.deepEqual(state.exclusions[0].path, ['#slide-return']);
  for (const slideId of ['slide-forward-again', 'slide-back-again']) {
    await page.evaluate(id => window.replaceSlide(id), slideId);
    await page.waitForFunction(() => document.querySelector('.slide-surface').hasAttribute('data-hdm-excluded'));
    assert.equal(await page.locator('.slide-surface').getAttribute('id'), slideId);
  }
  await mode('selected');
  samePixels(await capture('.slide-surface'), originalSlide, 'Manual mode must disable retained page exclusions');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.editor-toolbar').hasAttribute('data-hdm-inverted'));
  assert.deepEqual(await surfaces(), originalSurfaces);
  samePixels(await capture('.slide-surface'), originalSlide, 'Reload must retain original unselected pixels');
  await popup.reload(); await popup.waitForFunction(() => document.querySelector('[data-mode="selected"]').getAttribute('aria-pressed') === 'true');
  assert.equal(await popup.locator('#exclusion-count').textContent(), '2');
  await mode('page');
  assert.equal(await popup.locator('#exclusion-count').textContent(), '1');
  await page.waitForFunction(() => document.querySelector('#slide-a').hasAttribute('data-hdm-excluded'));
  await mode('selected');
  console.log('PASS independent rule lists, Shadow DOM, slide next/back fallback and persistence after reload');

  const conflictRules = [
    { path: ['#missing-graphic'], fallbackPath: ['svg.ambiguous-surface'], label: 'Ambiguous' },
    { path: ['#reused-graphic'], fallbackPath: ['svg.replacement-surface'], label: 'Wrong kind' },
    { path: ['svg.ambiguous-surface'], fallbackPath: ['svg.replacement-surface'], label: 'Ambiguous primary' }
  ];
  for (const rule of conflictRules) assert.equal((await send({ type: 'hdm-inversion-save', origin, rule })).ok, true);
  const resolved = await popup.evaluate(async ({ tabId, rules }) => {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, args: [rules],
      func: rules => rules.map(rule => globalThis.HdmSelectors.resolveRule(rule)?.localName || null) });
    return result.result;
  }, { tabId: tab.id, rules: conflictRules });
  assert.deepEqual(resolved, [null, null, null], 'Both ambiguous paths and a primary type conflict must resolve to nothing');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.probes [data-hdm-inverted]').count(), 0, 'Ambiguity and reused IDs of the wrong tag must not redirect rules');
  for (const rule of conflictRules) assert.equal((await send({ type: 'hdm-inversion-remove', origin, path: rule.path })).ok, true);
  const snapshots = await stored();
  await popup.evaluate(() => {
    for (const value of ['page', 'selected', 'page', 'selected']) document.querySelector(`[data-mode="${value}"]`).click();
    if (document.querySelector('[data-mode="selected"]').getAttribute('aria-pressed') !== 'true') throw Error('Latest intent was not immediate');
  });
  await settle(); assert.equal((await stored()).mode, 'selected');
  assert.deepEqual((await stored()).inclusions, snapshots.inclusions); assert.deepEqual((await stored()).exclusions, snapshots.exclusions);
  await page.waitForFunction(() => document.documentElement.classList.contains('dmx-mode-selected'));
  samePixels(await capture('.slide-surface'), originalSlide, 'Rapid mode changes must finish with original slide colors');

  let referenceHeights;
  for (const language of ['en', 'ru']) {
    await popup.locator(`[data-language="${language}"]`).click();
    await popup.waitForFunction(language => document.documentElement.lang === language, language);
    for (const value of ['page', 'selected']) {
      await mode(value);
      const geometry = await popup.locator('.theme-mode').evaluate(group => [...group.children].map(button => {
        const rect = button.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(button);
        const text = range.getBoundingClientRect();
        return { height: rect.height, width: rect.width, fits: text.width <= button.clientWidth && text.height <= button.clientHeight };
      }));
      assert(geometry.every(button => button.fits), 'Real EN/RU mode labels must fit their buttons');
      assert(Math.abs(geometry[0].height - geometry[1].height) < .1 && Math.abs(geometry[0].width - geometry[1].width) < .1);
      if (referenceHeights) assert(geometry.every((button, index) => Math.abs(button.height - referenceHeights[index]) < .1));
      else referenceHeights = geometry.map(button => button.height);
    }
  }
  console.log('PASS ambiguous and conflicting selectors fail closed, rapid mode intent and EN/RU control geometry');
  deadline();
  await page.evaluate(() => {
    const fixture = document.createElement('section'); fixture.id = 'media-fixture';
    fixture.style.cssText = 'position:absolute;top:520px;left:20px;display:flex;gap:10px;flex-wrap:wrap;width:650px;background:white';
    const source = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='30'%3E%3Crect width='30' height='30' fill='%23e04070'/%3E%3C/svg%3E";
    const image = id => `<img id="${id}" src="${source}" width="30" height="30">`;
    const background = 'style="background-image:linear-gradient(white,white)"';
    fixture.innerHTML = `<div id="reference-region"><div id="reference-background" ${background}>${image('reference-image')}<div id="background-fullscreen" style="background:white;width:60px;height:60px">Full screen${image('background-fullscreen-image')}</div></div><div id="light-fullscreen" style="background:white;width:60px;height:60px">Full screen${image('light-fullscreen-image')}</div></div>
      <div id="shadow-region"></div><div id="cross-region"><div id="cross-background" ${background}><div id="cross-host"></div></div></div>
      ${image('direct-image')}<canvas id="direct-canvas" width="30" height="30"></canvas><div id="direct-background" ${background}>${image('direct-nested-image')}</div>
      <div id="slot-host">${image('slotted-image')}</div><div id="dynamic-region"><div id="dynamic-background">${image('dynamic-image')}</div></div>${image('untouched-image')}`;
    document.body.appendChild(fixture);
    fixture.querySelector('#shadow-region').attachShadow({ mode: 'open' }).innerHTML = `<div id="shadow-background" ${background}>${image('shadow-image')}</div><div id="shadow-fullscreen" style="background:white;width:60px;height:60px">Full screen${image('shadow-fullscreen-image')}</div>`;
    fixture.querySelector('#cross-host').attachShadow({ mode: 'open' }).innerHTML = image('cross-image');
    fixture.querySelector('#slot-host').attachShadow({ mode: 'open' }).innerHTML = '<div id="selected-slot-wrapper" style="background:white"><slot></slot></div>';
    const canvas = fixture.querySelector('#direct-canvas').getContext('2d'); canvas.fillStyle = 'white'; canvas.fillRect(0, 0, 30, 30);
  });
  await page.locator('#untouched-image').evaluate(image => image.decode());
  const untouchedMedia = await capture('#untouched-image');
  const imagePaths = ['reference-region', 'reference-background', 'shadow-region', 'cross-region', 'direct-image', 'direct-canvas', 'direct-background', 'dynamic-region'].map(id => [`#${id}`]);
  imagePaths.push(['#slot-host', '#selected-slot-wrapper']);
  for (const rulePath of imagePaths) assert.equal((await send({ type: 'hdm-inversion-save', origin, rule: { path: rulePath, label: 'Media fixture' } })).ok, true);
  const filter = selector => page.locator(selector).evaluate(node => getComputedStyle(node).filter);
  const inverse = 'invert(0.9) hue-rotate(180deg)', counter = 'invert(1) hue-rotate(180deg)';
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#reference-region')).filter === 'invert(0.9) hue-rotate(180deg)');
  for (const selector of ['#reference-region', '#shadow-region', '#cross-region', '#direct-image', '#direct-canvas', '#direct-background', '#selected-slot-wrapper']) {
    assert.equal(await filter(selector), inverse, `Explicit selection must own one inversion: ${selector}`);
  }
  for (const selector of ['#reference-background', '#shadow-background', '#cross-background', '#direct-nested-image', '#slotted-image', '#dynamic-image']) {
    assert.equal(await filter(selector), counter, `First media boundary must receive one compensation: ${selector}`);
  }
  for (const selector of ['#reference-image', '#shadow-image', '#cross-image']) {
    assert.equal(await filter(selector), 'none', `A media ancestor already compensates this branch: ${selector}`);
  }
  const referenceMedia = await capture('#reference-image');
  for (const selector of ['#shadow-image', '#cross-image', '#direct-nested-image', '#slotted-image']) {
    samePixels(mediaInterior(await capture(selector)), mediaInterior(referenceMedia), `Composed media compensation must match the light-DOM reference: ${selector}`);
  }
  samePixels(await capture('#untouched-image'), untouchedMedia, 'Media outside selected regions must retain original pixels');
  await page.evaluate(() => document.querySelector('#dynamic-background').style.backgroundImage = 'linear-gradient(white,white)');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#dynamic-image')).filter === 'none');
  samePixels(mediaInterior(await capture('#dynamic-image')), mediaInterior(referenceMedia), 'Changing inline backgrounds must not add double compensation');
  await page.evaluate(() => document.querySelector('#dynamic-background').style.removeProperty('background-image'));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#dynamic-image')).filter === 'invert(1) hue-rotate(180deg)');
  assert.equal(await filter('#dynamic-background'), 'none');
  console.log('PASS selected media, nested rules, shadow and slot ownership, live background changes and untouched pixels');

  for (const [selector, expected] of [
    ['#light-fullscreen', inverse], ['#shadow-fullscreen', inverse], ['#background-fullscreen', inverse],
    ['#shadow-fullscreen-image', 'none'], ['#direct-image', inverse], ['#direct-canvas', inverse]
  ]) {
    await page.bringToFront();
    await page.locator(selector).evaluate(node => node.requestFullscreen());
    await page.locator(selector).evaluate(node => new Promise(resolve => {
      if (node.matches(':fullscreen')) resolve(); else document.addEventListener('fullscreenchange', resolve, { once: true });
    }));
    await page.waitForFunction(({ id, expected }) => {
      const scopes = [document];
      for (const scope of scopes) {
        const node = scope.getElementById(id);
        if (node) return getComputedStyle(node).filter === expected;
        for (const element of scope.querySelectorAll('*')) if (element.shadowRoot) scopes.push(element.shadowRoot);
      }
      return false;
    }, { id: selector.slice(1), expected });
    assert.equal(await filter(selector), expected, `Fullscreen must retain selected ownership without a stale ancestor counter-filter: ${selector}`);
    if (selector === '#shadow-fullscreen') assert.equal(await filter('#shadow-fullscreen-image'), counter);
    if (selector === '#background-fullscreen') assert.equal(await filter('#background-fullscreen-image'), counter, 'Media outside the fullscreen boundary must not suppress its inner compensation');
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => !document.fullscreenElement);
  }
  assert.equal(await filter('#shadow-fullscreen-image'), counter, 'Leaving fullscreen must restore media compensation');
  for (const rulePath of imagePaths) assert.equal((await send({ type: 'hdm-inversion-remove', origin, path: rulePath })).ok, true);
  await page.evaluate(() => document.querySelector('#media-fixture').remove());
  await page.evaluate(() => scrollTo(0, 0));
  samePixels(await capture('.slide-surface'), originalSlide, 'Media boundary tests must not affect the unselected slide');
  console.log('PASS light/shadow fullscreen descendants and explicitly selected image/canvas');
  if (process.env.HDM_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.HDM_SCREENSHOT_DIR, { recursive: true });
    await popup.screenshot({ path: path.join(process.env.HDM_SCREENSHOT_DIR, 'manual-editor-popup.png') });
    await page.screenshot({ path: path.join(process.env.HDM_SCREENSHOT_DIR, 'manual-editor-page.png') });
  }
  assert.equal((await send({ type: 'hdm-universal-set-enabled', origin, enabled: false })).ok, true);
  await page.waitForFunction(() => !document.documentElement.classList.contains('dmx-on'));
  samePixels(await capture('.slide-surface'), originalSlide, 'Pause must restore original slide');
  samePixels(await capture('.editor-toolbar'), originalToolbar, 'Pause must restore original toolbar');
  assert.deepEqual(await surfaces(), originalSurfaces);
  assert.equal((await send({ type: 'hdm-universal-remove-site', origin })).ok, true);
  assert.equal(await page.locator('[data-hdm-inverted], [data-hdm-excluded]').count(), 0);
  console.log('PASS pause/remove cleanup and original page surfaces');
});
