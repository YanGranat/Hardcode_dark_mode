import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { clone, load, read } from "../support/modules.mjs";

function catalogs() {
  return load(vm.createContext({}), "shared/languages.js", "popup/translations.js", "editor/translations.js");
}

test("language registry distinguishes stored choices from regional browser preferences", () => {
  const { HdmLanguages: languages } = catalogs();
  assert.deepEqual(clone(languages.options), [
    { code: "de", label: "Deutsch" }, { code: "en", label: "English" },
    { code: "es", label: "Español" }, { code: "ru", label: "Русский" }, { code: "uk", label: "Українська" }
  ]);
  for (const [tag, code] of [["de-DE", "de"], ["es-MX", "es"], ["UK-ua", "uk"], ["ru_RU", "ru"], ["en-GB", "en"], ["fr-FR", "en"], [null, "en"]]) {
    assert.equal(languages.detect(tag), code);
  }
  for (const value of ["DE", "de-DE", "unknown", "__proto__", null, {}, []]) assert.equal(languages.normalize(value), "en");
  for (const code of languages.codes) assert.equal(languages.normalize(code), code);
});

test("all UI catalogs have complete keys and unchanged interpolation contracts", () => {
  const { HdmLanguages: languages, HdmPopupText: popup, HdmEditorText: editor } = catalogs();
  const groups = [code => popup.messages[code], ...["picker", "invert", "matches"].map(group => code => editor.messages[code][group])];
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const group of groups) {
    const english = group("en");
    for (const code of languages.codes) {
      const messages = group(code);
      assert.deepEqual(Object.keys(messages).sort(), Object.keys(english).sort(), code);
      for (const [key, value] of Object.entries(messages)) {
        assert.equal(typeof value, "string", `${code}/${key}`);
        assert(value.trim(), `${code}/${key} is empty`);
        assert.deepEqual(placeholders(value), placeholders(english[key]), `${code}/${key}`);
      }
    }
  }
  for (const code of languages.codes) {
    const manifestMessages = JSON.parse(read(`_locales/${code}/messages.json`));
    for (const [, key] of read("manifest.json").matchAll(/__MSG_(\w+)__/g)) assert(manifestMessages[key]?.message, `${code}/${key}`);
    for (const file of ["popup/popup.html", "options/options.html"]) {
      for (const [, key] of read(file).matchAll(/data-i18n(?:-aria-label|-title)?="([^"]+)"/g)) assert(popup.messages[code][key], `${code}/${key}`);
    }
  }
  assert.equal(popup.translate("es", "enableSite", { site: "{site}" }).includes("{site}"), true);
  assert.equal(editor.picker("de", false).title, "Element ausschließen");
  assert.equal(editor.picker("es", true).title, "Configurar bloque");
  assert.equal(editor.picker("uk", true).title, "Налаштувати блок");
});

test("editor text is isolated per instance and unsupported languages use English", () => {
  const { HdmEditorText: editor, HdmPopupText: popup } = catalogs();
  const first = editor.picker("en", false), original = first.title;
  first.title = "Changed";
  assert.equal(editor.picker("en", false).title, original);
  assert.notEqual(editor.picker("en", true).title, original);
  assert.deepEqual(clone(editor.picker("unsupported", false)), clone(editor.picker("en", false)));
  assert.deepEqual(clone(editor.matches("unsupported")), clone(editor.matches("en")));
  assert.equal(popup.translate("unsupported", "library"), "Library");
});

test("settings export and import retain each supported language", async () => {
  const context = load(vm.createContext({ URL, setTimeout, clearTimeout }),
    "shared/rules.js", "shared/site-utils.js", "shared/languages.js", "shared/requests.js", "shared/backup.js");
  const writes = [], api = { storage: {
    local: { get: async () => ({ universalSites: [] }) },
    sync: { get: async defaults => defaults, set: async settings => writes.push(clone(settings)) }
  } };
  for (const code of context.HdmLanguages.codes) {
    const data = await context.HdmBackup.snapshot(api, code);
    assert.equal(data.settings.language, code);
    const text = JSON.stringify(data);
    assert.equal(await context.HdmBackup.load(api, { size: text.length, text: async () => text }), 0);
    assert.equal(writes.at(-1).language, code);
  }
});
