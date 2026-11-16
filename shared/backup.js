(function exposeBackup(global) {
  const FORMAT = "custom-dark-mode-settings", VERSION = 1, MAX_FILE_BYTES = 20 * 1024 * 1024;
  const PREFERENCES = { language: HdmLanguages.codes, librarySort: ["alphabetical", "newest", "oldest"] };

  // The file holds stored fields only: everything else is derived from a site's address.
  async function snapshot(chrome, language) {
    const [{ universalSites }, settings] = await Promise.all([
      chrome.storage.local.get({ universalSites: [] }),
      chrome.storage.sync.get({ language, librarySort: PREFERENCES.librarySort[0] })
    ]);
    const sites = HdmSites.normalizeLibrary(universalSites).map(({ origin, enabled, addedAt, mode, exclusions, inclusions, protections }) =>
      ({ origin, enabled, addedAt, mode, exclusions, inclusions, protections }));
    return { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), settings, sites };
  }

  // Starts a download from an extension page and resolves with the number of saved sites.
  async function save(chrome, document, language) {
    const data = await snapshot(chrome, language);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    link.download = `hardcode-dark-mode-settings-${data.exportedAt.slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    return data.sites.length;
  }

  // Applies a settings file and resolves with the number of sites taken from it.
  async function load(chrome, file) {
    let data;
    try {
      if (file.size > MAX_FILE_BYTES) throw Error("too_large");
      data = JSON.parse(await file.text());
    } catch { data = null; }
    if (data?.format !== FORMAT || (data.version !== undefined && data.version !== VERSION) ||
        !Array.isArray(data.sites)) throw Error("invalid_file");
    // A backup of an empty library still carries the preferences.
    const response = data.sites.length
      ? await HdmRequests.send(() => chrome.runtime.sendMessage({ type: "hdm-library-import", sites: data.sites }), 15000, "request_timeout")
      : { imported: 0 };
    const settings = Object.fromEntries(Object.entries(PREFERENCES)
      .filter(([key, allowed]) => allowed.includes(data.settings?.[key])).map(([key]) => [key, data.settings[key]]));
    if (Object.keys(settings).length) await chrome.storage.sync.set(settings);
    return response.imported;
  }

  global.HdmBackup = { snapshot, save, load };
})(globalThis);
