import vm from "node:vm";
import { clone, load } from "./modules.mjs";

export function popupFixture({ sites = [{ origin: "https://parent.test", enabled: true }, { origin: "https://child.test", enabled: true }],
  settings = { language: "en", librarySort: "alphabetical" }, url = "https://parent.test/page", timers = {} } = {}) {
  const requests = [], notices = [], details = [], renders = [], writes = [];
  let saved = clone(sites), savedSettings = { ...settings }, changed;
  const api = {
    i18n: { getUILanguage: () => "en-US" },
    permissions: { contains: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
    tabs: { query: async () => [{ id: 1, url }], sendMessage: () => Promise.resolve({ ok: true }) },
    runtime: { sendMessage: message => new Promise((resolve, reject) => requests.push({ message,
      resolve: result => resolve({ ok: true, ...result }), reject })) },
    storage: {
      local: { get: async () => ({ universalSites: clone(saved) }) },
      sync: { get: async () => ({ ...savedSettings }), set: async partial => {
        writes.push(clone(partial)); Object.assign(savedSettings, partial);
      } },
      onChanged: { addListener(listener) { changed = listener; } }
    }
  };
  const context = vm.createContext({ URL, chrome: api, setTimeout, clearTimeout, ...timers });
  load(context, "shared/rules.js", "shared/site-utils.js", "shared/requests.js", "popup/state.js", "popup/translations.js");
  const model = context.HdmPopupState.create(api, value => renders.push(clone(value)),
    (key, detail) => { notices.push(key); details.push(detail ? clone(detail) : null); });
  return { model, api, requests, notices, details, renders, writes, text: context.HdmPopupText, sorting: context.HdmPopupState,
    init: () => model.init(), save: value => { saved = clone(value); },
    change: value => changed({ universalSites: { newValue: clone(value) } }, "local"),
    sync: value => changed(value, "sync"), settings: () => ({ ...savedSettings }) };
}
