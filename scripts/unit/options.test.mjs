import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { load } from "../support/modules.mjs";

function options(browserLanguage = "en") {
  let resolve, reject, change;
  const initial = new Promise((yes, no) => { resolve = yes; reject = no; });
  const elements = new Map(["export", "import", "file", "status"].map(id => [id, {
    dataset: { i18n: id === "export" ? "backupExport" : "backupImport" },
    handlers: new Map(), classes: new Set(),
    addEventListener(type, handler) { this.handlers.set(type, handler); },
    classList: { toggle() {} }
  }]));
  const document = { documentElement: {}, getElementById: id => elements.get(id),
    querySelectorAll: () => [elements.get("export"), elements.get("import")] };
  const chrome = { i18n: { getUILanguage: () => browserLanguage }, storage: {
    sync: { get: () => initial }, onChanged: { addListener: listener => { change = listener; } }
  } };
  const context = vm.createContext({ document, chrome });
  for (const element of elements.values()) element.classList = {
    toggle(name, enabled) { if (enabled) element.classes.add(name); else element.classes.delete(name); }
  };
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

test("visible backup errors retain their meaning and severity through language changes", async () => {
  const h = options(); h.resolve({ language: "en" }); await h.settle();
  h.context.HdmBackup = { save: async () => { throw Error("failed"); }, load: async () => { throw Error("invalid_file"); } };
  await h.elements.get("export").handlers.get("click")();
  const status = h.elements.get("status");
  for (const code of ["de", "en", "es", "ru", "uk"]) {
    h.change({ language: { newValue: code } }, "sync");
    assert.equal(status.textContent, h.context.HdmPopupText.translate(code, "backupExportFailed"));
    assert.equal(status.classes.has("error"), true);
  }
  h.elements.get("file").files = [{}];
  h.elements.get("file").handlers.get("change")(); await h.settle();
  h.change({ language: { newValue: "de" } }, "sync");
  assert.equal(status.textContent, h.context.HdmPopupText.translate("de", "backupInvalid"));
  await h.elements.get("export").handlers.get("click")();
  h.change({ language: { newValue: "es" } }, "sync");
  assert.equal(status.textContent, h.context.HdmPopupText.translate("es", "backupExportFailed"), "a newer failure replaces the translation key");
});

test("visible backup results retain counts after language changes and clear prior errors", async () => {
  const h = options(); h.resolve({ language: "en" }); await h.settle();
  h.context.HdmBackup = { save: async () => { throw Error("failed"); } };
  await h.elements.get("export").handlers.get("click")();
  for (const count of [0, 1, 2, 5, 21]) {
    h.context.HdmBackup.save = async () => count;
    await h.elements.get("export").handlers.get("click")();
    for (const code of ["de", "en", "es", "ru", "uk"]) {
      h.change({ language: { newValue: code } }, "sync");
      assert.equal(h.elements.get("status").textContent, h.context.HdmPopupText.translate(code, "backupExported", { count }));
      assert.equal(h.elements.get("status").classes.has("error"), false);
    }
  }
});
