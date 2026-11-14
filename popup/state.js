(function exposePopupState(global) {
  const normalizeSort = value => ["alphabetical", "newest", "oldest"].includes(value) ? value : "alphabetical";

  function sortSites(sites, order) {
    const mode = normalizeSort(order);
    const timestamp = site => Number.isFinite(site.addedAt) && site.addedAt > 0 ? site.addedAt : 0;
    return [...sites].sort((a, b) => {
      if (mode !== "alphabetical") {
        const first = timestamp(a), second = timestamp(b);
        if (Boolean(first) !== Boolean(second)) return first ? -1 : 1;
        if (first !== second) return mode === "newest" ? second - first : first - second;
      }
      return a.label.localeCompare(b.label, "en") || a.origin.localeCompare(b.origin, "en");
    });
  }

  function create(chrome, changed, notice) {
    const defaults = { librarySort: "alphabetical", language: HdmLanguages.detect(chrome.i18n.getUILanguage()) };
    let settings = { ...defaults }, sites = [], tab = null, currentSite = { supported: false };
    let settingsQueue = Promise.resolve(), initializing = true, libraryRevision = 0, accessRevision = 0, currentAccess = null;
    const initialSettingsChanges = {}, settingsRevisions = {}, pending = new Map();
    let initialLibraryChanged = false, nextRequest = 0, sortRequest = 0, pendingSort = null;
    const visibleSites = () => {
      const visible = new Map(sites.map(site => [site.origin, site]));
      for (const [origin, operation] of pending) {
        if (operation.site) visible.set(origin, operation.site);
        else visible.delete(origin);
      }
      return [...visible.values()];
    };
    const site = origin => visibleSites().find(site => site.origin === origin) || null;
    const canPick = () => Boolean(currentAccess && currentSite.supported && site(currentSite.origin)?.enabled && !pending.has(currentSite.origin));
    const snapshot = () => ({ settings: { ...settings }, sites: visibleSites(), tab, currentSite, currentAccess,
      sort: normalizeSort(pendingSort ?? settings.librarySort) });
    const emit = () => changed(snapshot());
    const worker = message => HdmRequests.send(() => chrome.runtime.sendMessage(message), 15000, "request_timeout");
    async function checkAccess() {
      const request = ++accessRevision;
      currentAccess = null; emit();
      let allowed = false;
      try { allowed = currentSite.supported && await chrome.permissions.contains({ origins: [currentSite.matchPattern] }); } catch {}
      if (request === accessRevision) { currentAccess = allowed; emit(); }
    }
    chrome.permissions.onAdded.addListener(checkAccess);
    chrome.permissions.onRemoved.addListener(checkAccess);

    async function changeSite(origin, value, message, successKey, removed = null) {
      const id = ++nextRequest;
      pending.set(origin, { id, site: value }); emit();
      let result = successKey;
      try {
        const response = await worker(message);
        if (response.warning) result = "applyIncomplete";
      } catch (error) {
        result = { request_timeout: "requestTimedOut", permission_required: "permissionRequired" }[error.message] || "operationFailed";
      }
      if (pending.get(origin)?.id !== id) return;
      try {
        const revision = libraryRevision;
        const stored = await chrome.storage.local.get({ universalSites: [] });
        if (pending.get(origin)?.id !== id) return;
        if (libraryRevision === revision) sites = HdmSites.normalizeLibrary(stored.universalSites);
      } catch { result = "operationFailed"; }
      if (pending.get(origin)?.id !== id) return;
      pending.delete(origin); emit();
      // A finished removal can be taken back while its notice is shown.
      if (result) notice(result, removed && result === successKey ? { removed } : undefined);
    }
    const removeSite = origin => {
      const existing = site(origin);
      return changeSite(origin, null, { type: "hdm-universal-remove-site", origin }, "siteRemoved", existing);
    };

    function saveSettings(partial) {
      const result = settingsQueue.then(async () => {
        const revisions = Object.fromEntries(Object.keys(partial).map(key => [key, settingsRevisions[key] || 0]));
        await chrome.storage.sync.set(partial);
        const unchanged = Object.fromEntries(Object.entries(partial).filter(([key]) => revisions[key] === (settingsRevisions[key] || 0)));
        settings = { ...settings, ...unchanged }; emit();
      });
      settingsQueue = result.catch(() => { emit(); notice("settingsFailed"); });
      return settingsQueue;
    }

    async function init() {
      if (!initializing) {
        initializing = true;
        initialLibraryChanged = false;
        for (const key of Object.keys(initialSettingsChanges)) delete initialSettingsChanges[key];
      }
      try {
        const [storedSettings, tabs, stored] = await Promise.all([
          chrome.storage.sync.get(defaults), chrome.tabs.query({ active: true, currentWindow: true }),
          chrome.storage.local.get({ universalSites: [] })
        ]);
        tab = tabs[0] || null;
        currentSite = HdmSites.fromUrl(tab?.url || "");
        if (!initialLibraryChanged) sites = HdmSites.normalizeLibrary(stored.universalSites);
        settings = { ...settings, ...storedSettings, ...initialSettingsChanges }; emit();
        await checkAccess();
      } catch { currentSite = { supported: false }; emit(); notice("operationFailed"); }
      finally { initializing = false; }
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync") {
        const patch = {};
        for (const key of Object.keys(defaults)) if (changes[key]) {
          patch[key] = changes[key].newValue ?? defaults[key];
          settingsRevisions[key] = (settingsRevisions[key] || 0) + 1;
        }
        if (initializing) Object.assign(initialSettingsChanges, patch);
        settings = { ...settings, ...patch }; emit();
      }
      if (area === "local" && changes.universalSites) {
        libraryRevision++;
        if (initializing) initialLibraryChanged = true;
        sites = HdmSites.normalizeLibrary(changes.universalSites.newValue); emit();
      }
    });

    return {
      init, snapshot, site, saveSettings, canPick, isPending: origin => origin === undefined ? pending.size > 0 : pending.has(origin),
      remove: removeSite,
      restore(removed) {
        if (site(removed.origin)) return;
        const { origin, enabled, addedAt, mode, exclusions, inclusions, protections } = removed;
        return changeSite(origin, removed, { type: "hdm-universal-restore-site",
          site: { origin, enabled, addedAt, mode, exclusions, inclusions, protections } }, "siteRestored");
      },
      setEnabled(origin, enabled) {
        const existing = site(origin);
        if (!existing) return;
        return changeSite(origin, { ...existing, enabled }, { type: "hdm-universal-set-enabled", origin, enabled }, enabled ? "siteEnabled" : "siteDisabled");
      },
      setMode(mode) {
        if (!currentSite.supported) return;
        const existing = site(currentSite.origin);
        if (!existing || existing.mode === mode) return;
        return changeSite(existing.origin, { ...existing, mode }, { type: "hdm-universal-set-mode", origin: existing.origin, mode }, "saved");
      },
      toggleMembership() {
        if (!currentSite.supported) return;
        const existing = site(currentSite.origin);
        if (existing) return removeSite(existing.origin);
        return changeSite(currentSite.origin, { ...currentSite, enabled: true, addedAt: Date.now() },
          { type: "hdm-universal-add-site", url: tab.url }, "siteAdded");
      },
      async setSort(value) {
        const id = ++sortRequest;
        pendingSort = normalizeSort(value); emit();
        await saveSettings({ librarySort: pendingSort });
        if (id !== sortRequest) return;
        pendingSort = null; emit();
      },
      removeRule(action, rule) {
        return worker({ type: `hdm-${action}-remove`, origin: currentSite.origin, path: rule.path, matchAll: rule.matchAll === true });
      },
      updateRule(kind, rule, changes, parent = null) {
        const existing = site(currentSite.origin);
        if (!existing) return;
        const field = { exclusion: "exclusions", inversion: "inclusions", protection: "protections" }[kind];
        const updated = { ...existing };
        const patch = rules => (rules || []).map(value => HdmRules.identity(value) === HdmRules.identity(rule)
          ? HdmRules.updateMetadata(value, changes) : value);
        if (parent) updated.inclusions = existing.inclusions.map(value => HdmRules.identity(value) === HdmRules.identity(parent)
          ? { ...value, protections: patch(value.protections) } : value);
        else updated[field] = patch(existing[field]);
        return changeSite(existing.origin, updated, { type: "hdm-rule-update", origin: existing.origin, kind,
          path: rule.path, matchAll: rule.matchAll === true, changes,
          ...(parent ? { parent: { path: parent.path, matchAll: parent.matchAll === true } } : {}) }, null);
      },
      showRule(kind, rule, language, parent = null) {
        if (!currentAccess || !currentSite.supported || pending.has(currentSite.origin)) throw Error("settings_changed");
        return HdmRequests.send(() => chrome.tabs.sendMessage(tab.id, { type: "hdm-rule-show", language, kind,
          path: rule.path, matchAll: rule.matchAll === true,
          ...(parent ? { parent: { path: parent.path, matchAll: parent.matchAll === true } } : {}) }, { frameId: 0 }), 3000, "timeout");
      },
      pick(rule, language) {
        if (!canPick()) throw Error("settings_changed");
        return HdmRequests.send(() => chrome.tabs.sendMessage(tab.id, { type: "hdm-exclusion-pick", language, rule,
          mode: site(currentSite.origin)?.mode || "page" }, { frameId: 0 }), 3000, "timeout");
      }
    };
  }
  global.HdmPopupState = { create, sortSites };
})(globalThis);
