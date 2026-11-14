import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { load } from "../support/modules.mjs";

function options(browserLanguage = "en") {
  let resolve, reject, change;
  const initial = new Promise((yes, no) => { resolve = yes; reject = no; });
  const elements = new Map(["export", "import", "file", "status"].map(id => [id, {
    dataset: { i18n: id === "export" ? "backupExport" : "backupImport" },
    addEventListener() {}, classList: { toggle() {} }
  }]));
  const document = { documentElement: {}, getElementById: id => elements.get(id),
    querySelectorAll: () => [elements.get("export"), elements.get("import")] };
  const chrome = { i18n: { getUILanguage: () => browserLanguage }, storage: {
    sync: { get: () => initial }, onChanged: { addListener: listener => { change = listener; } }
  } };
  const context = vm.createContext({ document, chrome });
  load(context, "shared/languages.js", "popup/translations.js", "options/options.js");
  return { document, elements, context, resolve, reject, change,
    settle: () => new Promise(done => setImmediate(done)) };
}

test("options applies saved language after browser-language initialization", async () => {
  const h = options("en-US");
  assert.equal(h.document.documentElement.lang, "en");
  h.resolve({ language: "ru" }); await h.settle();
  assert.equal(h.document.documentElement.lang, "ru");
  assert.equal(h.elements.get("export").textContent, h.context.HdmPopupText.translate("ru", "backupExport"));
});

test("options preserves the latest language event over an older initial read", async () => {
  const h = options();
  h.change({ language: { newValue: "ru" } }, "sync");
  h.resolve({ language: "en" }); await h.settle();
  assert.equal(h.document.documentElement.lang, "ru");
  assert.equal(h.elements.get("import").textContent, h.context.HdmPopupText.translate("ru", "backupImport"));
});

test("options keeps successive language changes while initialization is pending", async () => {
  const h = options();
  for (const language of ["ru", "en"]) h.change({ language: { newValue: language } }, "sync");
  h.resolve({ language: "ru" }); await h.settle();
  assert.equal(h.document.documentElement.lang, "en");
});

test("unrelated storage events do not invalidate the initial language read", async () => {
  const h = options();
  h.change({ language: { newValue: "en" } }, "local");
  h.change({ librarySort: { newValue: "newest" } }, "sync");
  h.resolve({ language: "ru" }); await h.settle();
  assert.equal(h.document.documentElement.lang, "ru");
});

test("options retains browser fallback after a failed read and handles later removal", async () => {
  const h = options("ru-RU");
  h.reject(Error("unavailable")); await h.settle();
  assert.equal(h.document.documentElement.lang, "ru");
  h.change({ language: {} }, "sync");
  assert.equal(h.document.documentElement.lang, "ru");
});

test("options detects every added browser locale and applies saved language changes", async () => {
  for (const [tag, expected] of [["de-CH", "de"], ["es-AR", "es"], ["uk-UA", "uk"], ["fr-FR", "en"]]) {
    const h = options(tag);
    assert.equal(h.document.documentElement.lang, expected);
    h.resolve({ language: "es" }); await h.settle();
    assert.equal(h.document.documentElement.lang, "es");
    h.change({ language: { newValue: "uk" } }, "sync");
    assert.equal(h.document.documentElement.lang, "uk");
    h.change({ language: {} }, "sync");
    assert.equal(h.document.documentElement.lang, expected);
  }
});
