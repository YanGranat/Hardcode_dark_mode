import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createBrowserHarness, decodePng } from "./support/browser.mjs";
const svg = id => `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" width="320" height="180" viewBox="0 0 320 180">
  <g id="${id}-drawing"><rect id="${id}-background" width="320" height="180" fill="#061e47"/>
  <text x="20" y="90" font-family="monospace" font-weight="bold" font-size="48" fill="white">SLIDE</text>
  <rect x="240" y="25" width="45" height="45" fill="#ffd144"/></g></svg>`;
const fixture = `<!doctype html><html><head><style>
body{margin:0;background:white;color:black;font:18px system-ui;min-height:1400px}
main{display:grid;grid-template-columns:320px 320px;gap:20px;padding:20px}
svg,canvas{display:block}#covered{background-image:linear-gradient(white,white)}
</style></head><body><main>${svg("slide")}${svg("other")}
<svg id="outer" width="320" height="180"><rect width="320" height="180" fill="white"/>
  <svg id="inner" x="20" y="20" width="120" height="100"><g><rect id="inner-background" width="120" height="100" fill="#061e47"/></g></svg>
  <foreignObject x="150" y="20" width="150" height="100"><div xmlns="http://www.w3.org/1999/xhtml"><button id="html-in-svg">HTML control</button></div></foreignObject>
</svg><canvas id="canvas" width="320" height="180"></canvas>
<div id="shadow"></div><div id="covered" style="background-image:linear-gradient(white,white)">${svg("covered-svg")}</div>
</main><script>
window.clicked=0;document.querySelector('#slide').onclick=()=>window.clicked++;
const context=document.querySelector('#canvas').getContext('2d');
context.fillStyle='#061e47';context.fillRect(0,0,320,180);
context.fillStyle='white';context.font='bold 48px monospace';context.fillText('SLIDE',20,90);
document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML=${JSON.stringify(svg("shadow-svg"))};
</script></body></html>`;
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(fixture);
});
let context;
const harness = createBrowserHarness({ server, timeout: 30000, name: "Graphics" });
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
  const send = message => popup.evaluate(message => chrome.runtime.sendMessage(message), message);
  const origin = "http://127.0.0.1";
  const capture = async (selector, label) => {
    await page.evaluate(() => {
      const outline = document.querySelector('[data-hdm-picker]')?.shadowRoot.querySelector('.outline');
      if (outline) outline.style.visibility = 'hidden';
    });
    let png;
    try { png = await page.locator(selector).screenshot(); }
    finally {
      await page.evaluate(() => {
        const outline = document.querySelector('[data-hdm-picker]')?.shadowRoot.querySelector('.outline');
        if (outline) outline.style.visibility = '';
      });
    }
    assert(png.readUInt32BE(16) <= 1000 && png.readUInt32BE(20) <= 1000, `Unexpected graphic capture size for ${selector}`);
    if (label && process.env.HDM_SCREENSHOT_DIR) fs.writeFileSync(path.join(process.env.HDM_SCREENSHOT_DIR, `${label}.png`), png);
    return decodePng(page, png);
  };
  const samePixels = (actual, expected, label) => {
    assert.equal(actual.width, expected.width, label);
    assert.equal(Buffer.from(actual.pixels).equals(Buffer.from(expected.pixels)), true, label);
  };
  const original = await capture('#slide', 'slide-original');
  const originalCanvas = await capture('#canvas');
  const textPixels = image => {
    const points = [];
    for (let y = 45; y < 95; y++) for (let x = 15; x < 200; x++) {
      const offset = (y * image.width + x) * 4;
      if (image.pixels.slice(offset, offset + 3).every(channel => channel > 245)) points.push(offset);
    }
    return points;
  };
  const text = textPixels(original), canvasText = textPixels(originalCanvas);
  assert(text.length > 300 && canvasText.length > 300, 'Fixture must contain real white glyph pixels');
  const brightFraction = (image, points) => points.filter(offset => image.pixels.slice(offset, offset + 3).every(channel => channel > 180)).length / points.length;
  const background = image => image.pixels.slice((10 * image.width + 10) * 4, (10 * image.width + 10) * 4 + 3);
  assert.equal((await send({ type: 'hdm-universal-add-site', url: page.url() })).ok, true);
  await page.waitForFunction(() => document.documentElement.classList.contains('dmx-on'));
  assert(brightFraction(await capture('#slide'), text) < .05);
  const unchanged = await capture('#other');
  const tab = await popup.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), page.url());
  const panel = page.locator('[data-hdm-picker]');
  const pick = async () => {
    assert.equal((await popup.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: 'hdm-exclusion-pick', language: 'en', mode: 'page' }, { frameId: 0 }), tab.id)).ok, true);
    await page.bringToFront(); await panel.waitFor();
    await panel.locator('[data-action="move"]').click();
  };
  const clickBackground = async selector => {
    const bounds = await page.locator(selector).boundingBox();
    await page.mouse.move(bounds.x + 10, bounds.y + 10); await page.mouse.click(bounds.x + 10, bounds.y + 10);
  };
  const marked = () => page.locator('[data-hdm-excluded]').evaluateAll(nodes => nodes.map(node => node.id));
  const clearRules = async () => popup.evaluate(async () => {
    const { universalSites } = await chrome.storage.local.get('universalSites');
    await chrome.storage.local.set({ universalSites: universalSites.map(site => ({ ...site, exclusions: [] })) });
  });
  await pick(); await clickBackground('#slide');
  console.log('PASS graphic background initially selects whole SVG');
  assert.deepEqual(await marked(), ['slide'], 'A graphic background hit must initially select the whole SVG');
  assert.equal(await page.evaluate(() => window.clicked), 0);
  assert.equal(await panel.locator('[data-action="smaller"]').isEnabled(), true);
  await panel.locator('[data-action="smaller"]').click();
  assert.deepEqual(await marked(), ['slide-drawing']);
  await panel.locator('[data-action="smaller"]').click();
  assert.deepEqual(await marked(), ['slide-background']);
  const partial = await capture('#slide', 'slide-background-only');
  assert(brightFraction(partial, text) < .05, 'Excluding only the background leaves sibling glyphs transformed');
  await panel.locator('[data-action="larger"]').click();
  await panel.locator('[data-action="larger"]').click();
  assert.deepEqual(await marked(), ['slide']);
  const excluded = await capture('#slide', 'slide-whole-object');
  assert(brightFraction(excluded, text) > .95, 'Whole-object exclusion must recover light glyphs');
  assert(background(excluded).every(channel => channel < 120), `Expected dark slide: ${background(excluded)}`);
  console.log('Slide pixel comparison', {
    originalBackground: background(original), excludedBackground: background(excluded),
    originalGlyph: original.pixels.slice(text[0], text[0] + 3), excludedGlyph: excluded.pixels.slice(text[0], text[0] + 3),
    recoveredBrightGlyphFraction: brightFraction(excluded, text)
  });
  samePixels(await capture('#other'), unchanged, 'Unselected sibling must not change');
  await panel.locator('[data-action="save"]').click(); await panel.waitFor({ state: 'detached' });
  const saved = await popup.evaluate(async () => (await chrome.storage.local.get('universalSites')).universalSites[0].exclusions);
  assert.deepEqual(saved[0].path, ['#slide']);
  await page.reload(); await page.waitForFunction(() => document.querySelector('#slide').hasAttribute('data-hdm-excluded'));
  assert(brightFraction(await capture('#slide'), text) > .95);
  await page.evaluate(() => {
    const old = document.querySelector('#slide'), replacement = old.cloneNode(true);
    replacement.removeAttribute('data-hdm-excluded'); old.replaceWith(replacement);
  });
  await page.waitForFunction(() => document.querySelector('#slide').hasAttribute('data-hdm-excluded'));
  assert(brightFraction(await capture('#slide'), text) > .95);
  console.log('PASS layered SVG selection, whole-object preview/save/reload/replacement, glyph pixels and unchanged sibling');

  deadline();
  await clearRules(); await page.waitForFunction(() => !document.querySelector('[data-hdm-excluded]'));
  // Touch/pen input may begin with pointerdown without a prior hover event.
  await pick();
  await page.evaluate(() => {
    const bounds = document.querySelector('#slide').getBoundingClientRect();
    const init = { clientX: bounds.left + 10, clientY: bounds.top + 10, bubbles: true, composed: true };
    document.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'touch' }));
    document.dispatchEvent(new MouseEvent('click', init));
  });
  assert.deepEqual(await marked(), ['slide']);
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
  for (const [selector, expected] of [['#inner', 'inner'], ['#html-in-svg', 'html-in-svg'], ['#shadow-svg', 'shadow-svg'], ['#canvas', 'canvas'], ['#covered-svg', 'covered-svg']]) {
    const coveredBefore = selector === '#covered-svg' ? await capture(selector) : null;
    await pick(); await clickBackground(selector);
    assert.deepEqual(await marked(), [expected]);
    if (selector === '#canvas') assert(brightFraction(await capture('#canvas'), canvasText) > .95);
    if (selector === '#covered-svg') {
      assert.equal(await page.locator(selector).evaluate(el => el.getAttribute('data-hdm-excluded')), 'inside');
      samePixels(await capture(selector), coveredBefore, 'Already compensated SVG must not change');
    }
    await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
    await page.waitForFunction(() => !document.querySelector('[data-hdm-excluded]'));
  }
  console.log('PASS nearest SVG boundary, HTML foreignObject, Shadow DOM, whole canvas, existing media compensation and cancellation');
  assert.equal((await send({ type: 'hdm-exclusion-add', origin, rule: { path: ['#slide-background'], label: 'rect#slide-background' } })).ok, true);
  await page.waitForFunction(() => document.querySelector('#slide-background').hasAttribute('data-hdm-excluded'));
  assert.deepEqual(await marked(), ['slide-background']);
  assert(brightFraction(await capture('#slide'), text) < .05);
  await send({ type: 'hdm-universal-set-enabled', origin, enabled: false });
  await page.waitForFunction(() => !document.documentElement.classList.contains('dmx-on'));
  samePixels(await capture('#slide'), original, 'Pausing must restore original SVG pixels');
  samePixels(await capture('#canvas'), originalCanvas, 'Pausing must restore original canvas pixels');
  await send({ type: 'hdm-universal-set-enabled', origin, enabled: true });
  await page.waitForFunction(() => document.querySelector('#slide-background').hasAttribute('data-hdm-excluded'));
  assert.equal((await send({ type: 'hdm-universal-remove-site', origin })).ok, true);
  await page.waitForFunction(() => !document.querySelector('[data-hdm-excluded]'));
  samePixels(await capture('#slide'), original, 'Removing the site must restore original SVG pixels');
  console.log('PASS precise legacy rules, pause/resume/remove and original pixel restoration while off');
  if (process.env.HDM_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.HDM_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.HDM_SCREENSHOT_DIR, 'graphics-original.png') });
  }
});
