import vm from "node:vm";
import { read, clone } from "./modules.mjs";

export function worker(applyTimeout = 30, now = () => Date.now(), session = {}) {
  const state = { sites: session.sites || [], documentsRestored: session.documentsRestored ?? true,
    scripts: [], fail: null, inserted: [], removed: [], executed: [] };
  let listener;
  const events = new Map();
  const event = name => ({ addListener(listener) { events.set(name, listener); } });
  const api = {
    runtime: {
      id: "test", getURL: part => `chrome-extension://test/${part}`,
      onMessage: { addListener(fn) { listener = fn; } }, onInstalled: event("installed"), onStartup: event("startup")
    },
    permissions: { contains: async () => true, onRemoved: event("removed"), onAdded: event("added") },
    storage: { local: {
      get: async () => ({ universalSites: clone(state.sites) }),
      set: async value => {
        if (state.fail === "storage") { state.fail = null; throw Error("disk failure"); }
        state.sites = clone(value.universalSites);
      }
    }, session: {
      get: async () => ({ documentsRestored: state.documentsRestored }),
      set: async value => { state.documentsRestored = value.documentsRestored; }
    } },
    tabs: { query: async () => [{ id: 1, url: "https://parent.test" }], sendMessage: async () => ({}) },
    scripting: {
      getRegisteredContentScripts: async () => clone(state.scripts),
      registerContentScripts: async scripts => {
        if (state.fail === "registration") { state.fail = null; throw Error("registration failure"); }
        state.scripts.push(...clone(scripts));
      },
      updateContentScripts: async scripts => {
        for (const script of scripts) state.scripts[state.scripts.findIndex(s => s.id === script.id)] = clone(script);
      },
      unregisterContentScripts: async ({ ids }) => { state.scripts = state.scripts.filter(s => !ids.includes(s.id)); },
      insertCSS: async arg => {
        if (state.fail === "injection") throw Error("unexpected insertion failure");
        state.inserted.push(arg);
      },
      removeCSS: async arg => { state.removed.push(arg); },
      executeScript: async arg => {
        if (!arg.func) { state.executed.push(arg); return []; }
        return [
          { documentId: "parent", result: "https://parent.test" },
          { documentId: "child", result: "https://child.test" },
          { documentId: "unrelated", result: "https://unrelated.test" }
        ];
      }
    }
  };
  const context = vm.createContext({ chrome: api, URL, console, Date: class extends Date { static now() { return now(); } },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, applyTimeout)), clearTimeout });
  context.importScripts = (...names) => names.forEach(name => vm.runInContext(read(name), context));
  vm.runInContext(read("service_worker.js"), context);
  const sender = { id: "test", url: "chrome-extension://test/popup/popup.html" };
  const send = message => new Promise(resolve => listener(message, sender, resolve));
  return { state, send, listener, api, ready: vm.runInContext("sessionRestoration", context),
    fire: name => events.get(name)?.() };
}
