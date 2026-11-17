importScripts("shared/runtime.js");
importScripts(...HdmRuntime.shared);

const UNIVERSAL_SITES_KEY = "universalSites";
const UNIVERSAL_CSS_FILES = HdmRuntime.css;
const UNIVERSAL_JS_FILES = HdmRuntime.content;
const PAGE_APPLY_TIMEOUT_MS = 3000;
const MAX_IMPORTED_SITES = 2000;
let operationQueue = Promise.resolve();
let applicationQueue = Promise.resolve();
const applicationRevisions = new Map();

function enqueue(operation) {
  const result = operationQueue.then(operation);
  operationQueue = result.catch(() => {});
  return result;
}

async function getUniversalSites() {
  const result = await chrome.storage.local.get({ [UNIVERSAL_SITES_KEY]: [] });
  return HdmSites.normalizeLibrary(result[UNIVERSAL_SITES_KEY]);
}

async function saveUniversalSites(sites) {
  await chrome.storage.local.set({
    [UNIVERSAL_SITES_KEY]: sites.map(({ origin, enabled, addedAt, mode, exclusions, inclusions, protections }) =>
      ({ origin, enabled, addedAt, mode: mode === "selected" ? "selected" : "page",
        exclusions: HdmRules.normalizeExclusions(exclusions), inclusions: HdmRules.normalizeInclusions(inclusions),
        protections: HdmRules.normalizeExclusions(protections) }))
  });
}

function registrationsFor(site) {
  const common = {
    matches: [site.matchPattern], runAt: "document_start", allFrames: true,
    matchOriginAsFallback: true, persistAcrossSessions: true
  };
  // A registered script runs only for an enabled site, so whole-page sites can turn
  // the filter on before their first paint instead of after a storage read.
  const boot = site.mode === "selected" ? [] : HdmRuntime.boot;
  return [
    { ...common, id: site.scriptId, css: UNIVERSAL_CSS_FILES, js: [...boot, ...UNIVERSAL_JS_FILES] },
    // "#" separates the shadow registration from host identifiers.
    { ...common, id: site.scriptId + "#shadow", js: HdmRuntime.shadow, world: "MAIN" }
  ];
}

function sitesWithAccess(sites) {
  return Promise.all(sites.map(async site => ({ ...site, enabled: site.enabled && await hasAccess(site) })));
}

async function syncRegistrations(sites) {
  const effective = await sitesWithAccess(sites);
  const desired = effective.filter((site) => site.enabled).flatMap(registrationsFor);
  const current = await chrome.scripting.getRegisteredContentScripts();
  const desiredIds = new Set(desired.map((script) => script.id));
  const currentIds = new Set(current.map((script) => script.id));
  const registered = new Map(current.map(script => [script.id, script]));
  const obsolete = current.filter((script) => HdmSites.ownsRegistration(script.id) &&
    !desiredIds.has(script.id)).map((script) => script.id);
  if (obsolete.length) await chrome.scripting.unregisterContentScripts({ ids: obsolete });
  const updates = desired.filter(script => currentIds.has(script.id) &&
    Object.entries(script).some(([key, value]) => JSON.stringify(registered.get(script.id)[key]) !== JSON.stringify(value)));
  const additions = desired.filter((script) => !currentIds.has(script.id));
  if (updates.length) await chrome.scripting.updateContentScripts(updates);
  if (additions.length) await chrome.scripting.registerContentScripts(additions);
  return effective;
}

// The probe finds a listed origin even inside an unlisted tab. Actual theme
// assets are subsequently injected only into matching, navigation-stable IDs.
function documentAddress(origins) {
  // Retire a stale themed controller before reinjection without dispatching a
  // page-visible event in ordinary unthemed documents.
  let address = "";
  if (/^https?:$/.test(location.protocol)) address = location.href;
  else if (/^(about:|blob:|data:)$/.test(location.protocol)) {
    address = location.origin !== "null" ? location.origin : location.ancestorOrigins[0] || "";
  }
  if (/^https?:\/\//.test(address) && document.documentElement?.classList.contains("dmx-site")) {
    const url = new URL(address);
    if (origins.includes(`${url.protocol}//${url.hostname.toLowerCase()}`)) document.dispatchEvent(new Event("hdm-controller-replace"));
  }
  return address;
}

function isDepartedDocument(error) {
  return /No tab with id|No frame with id|No document with id|Frame with ID .* removed|tab was closed|frame was removed/i.test(String(error?.message));
}

async function applyToOpenDocuments(sites, changedOrigins, isCurrent) {
  const deadline = Date.now() + PAGE_APPLY_TIMEOUT_MS;
  let expired = false;
  async function run(operation, origin) {
    const current = () => origin ? isCurrent(origin) : [...changedOrigins].some(isCurrent);
    if (!current()) throw new Error("apply_superseded");
    if (expired || Date.now() >= deadline) throw new Error("apply_timeout");
    let timer;
    try {
      const result = await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new Error("apply_timeout"));
          }, Math.max(0, deadline - Date.now()));
        })
      ]);
      if (!current()) throw new Error("apply_superseded");
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
  let incomplete = false;
  const entries = new Map(sites.map((site) => [site.origin, site]));
  const tabs = await run(() => chrome.tabs.query({}));
  async function applyToTab(tab, report) {
    // Existing controllers can still receive messages after scripting access is
    // withheld. Notify them before the document probe, which then cannot run.
    try {
      await run(() => chrome.tabs.sendMessage(tab.id, { type: "hdm-universal-refresh", origins: [...changedOrigins] }));
    } catch (error) {
      if (error.message === "apply_superseded") return;
    }
    let documents;
    try {
      documents = await run(() => chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true }, func: documentAddress,
        args: [[...changedOrigins]], injectImmediately: true
      }));
    } catch (error) {
      if (!isDepartedDocument(error) && !/Cannot access|Missing host permission|showing error page|apply_superseded/i.test(String(error.message))) report();
      return;
    }
    await Promise.all(documents.map(async (entry) => {
      const address = HdmSites.fromUrl(entry.result);
      if (!address.supported || !changedOrigins.has(address.origin)) return;
      if (!isCurrent(address.origin)) return;
      const target = { tabId: tab.id, documentIds: [entry.documentId] };
      const runForOrigin = operation => run(operation, address.origin);
      try {
        if (entries.get(address.origin)?.enabled) {
          // Avoid accumulating imperative stylesheet copies on repeated toggles.
          await runForOrigin(() => chrome.scripting.removeCSS({ target, files: UNIVERSAL_CSS_FILES }));
          await runForOrigin(() => chrome.scripting.insertCSS({ target, files: UNIVERSAL_CSS_FILES }));
          await runForOrigin(() => chrome.scripting.executeScript({ target, injectImmediately: true, world: "MAIN", files: HdmRuntime.shadow }));
          await runForOrigin(() => chrome.scripting.executeScript({ target, injectImmediately: true, files: UNIVERSAL_JS_FILES }));
        }
        try {
          await runForOrigin(() => chrome.tabs.sendMessage(tab.id, { type: "hdm-universal-refresh" }, { documentId: entry.documentId }));
        } catch (error) {
          if (!/Receiving end does not exist|Could not establish connection/i.test(String(error.message))) throw error;
        }
        if (!entries.get(address.origin)?.enabled) {
          await runForOrigin(() => chrome.scripting.removeCSS({ target, files: UNIVERSAL_CSS_FILES }));
        }
      } catch (error) {
        if (!isDepartedDocument(error) && error.message !== "apply_superseded") report();
      }
    }));
  }
  // A tab showing another site may embed a changed one, so it is still updated. But
  // if such a tab never answers, that must neither delay the reply nor ask the user
  // to reload a page that was applied correctly.
  const waited = [];
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id) || (tab.url && !HdmSites.fromUrl(tab.url).supported)) continue;
    const top = HdmSites.fromUrl(tab.url || "");
    if (top.supported && changedOrigins.has(top.origin)) waited.push(applyToTab(tab, () => { incomplete = true; }));
    else applyToTab(tab, () => {}).catch(() => {});
  }
  await Promise.all(waited);
  return incomplete ? "apply_incomplete" : null;
}

function scheduleApplication(sites, origins) {
  const revisions = new Map([...origins].map(origin => {
    const revision = (applicationRevisions.get(origin) || 0) + 1;
    applicationRevisions.set(origin, revision);
    return [origin, revision];
  }));
  const isCurrent = origin => applicationRevisions.get(origin) === revisions.get(origin);
  const application = applicationQueue.then(async () => {
    const currentOrigins = new Set([...origins].filter(isCurrent));
    if (!currentOrigins.size) return null;
    try {
      return await applyToOpenDocuments(sites, currentOrigins, isCurrent);
    } catch (error) {
      return error.message === "apply_superseded" ? null : "apply_incomplete";
    }
  });
  applicationQueue = application.catch(() => {});
  return application;
}

async function saveLibrary(previous, next) {
  try {
    const effective = await syncRegistrations(next);
    await saveUniversalSites(next);
    return effective;
  } catch (error) {
    try {
      await syncRegistrations(previous);
    } catch (rollbackError) {
      throw new Error("recovery_required");
    }
    throw new Error("save_failed");
  }
}

async function commitSites(previous, next, origins) {
  const effective = await saveLibrary(previous, next);
  return { sites: next, application: scheduleApplication(effective, origins) };
}

async function hasAccess(site) {
  return chrome.permissions.contains({ origins: [site.matchPattern] });
}

async function handleMessage(message) {
  if (!message || typeof message.type !== "string") throw new Error("invalid_message");
  const previous = await getUniversalSites();
  const next = previous.map((site) => ({ ...site }));
  if (message.type === "hdm-universal-add-site") {
    const site = HdmSites.fromUrl(message.url);
    if (!site.supported) throw new Error("unsupported_site");
    if (!(await hasAccess(site))) throw new Error("permission_required");
    const existing = next.find((entry) => entry.origin === site.origin);
    if (existing) existing.enabled = true;
    else next.push({ ...site, enabled: true, addedAt: Date.now(), mode: "page", exclusions: [], inclusions: [], protections: [] });
    return commitSites(previous, next, new Set([site.origin]));
  }
  if (message.type === "hdm-universal-restore-site") {
    const site = HdmSites.normalizeStoredSite(message.site);
    if (!site) throw new Error("invalid_message");
    if (next.some((entry) => entry.origin === site.origin)) throw new Error("site_exists");
    next.push(site);
    return commitSites(previous, next, new Set([site.origin]));
  }
  if (message.type === "hdm-library-import") {
    if (!Array.isArray(message.sites) || message.sites.length > MAX_IMPORTED_SITES) throw new Error("invalid_message");
    const imported = HdmSites.normalizeLibrary(message.sites);
    if (!imported.length) throw new Error("nothing_to_import");
    const incoming = new Map(imported.map((site) => [site.origin, site]));
    const merged = next.map((site) => incoming.get(site.origin) || site);
    const known = new Set(next.map((site) => site.origin));
    merged.push(...imported.filter((site) => !known.has(site.origin)));
    return { ...(await commitSites(previous, merged, new Set(incoming.keys()))), imported: imported.length };
  }
  if (typeof message.origin !== "string") throw new Error("invalid_message");
  const index = next.findIndex((site) => site.origin === message.origin);
  if (message.type === "hdm-rule-update") {
    if (index < 0) throw Error("site_not_found");
    const fields = { exclusion: "exclusions", inversion: "inclusions", protection: "protections" };
    const field = Object.hasOwn(fields, message.kind) ? fields[message.kind] : null;
    if (!field || !HdmRules.normalizeExclusions([message]).length ||
        (message.matchAll !== undefined && typeof message.matchAll !== "boolean")) throw Error("invalid_message");
    let owner = next[index];
    if (message.parent !== undefined) {
      if (message.kind !== "protection" || !HdmRules.normalizeExclusions([message.parent]).length ||
          (message.parent.matchAll !== undefined && typeof message.parent.matchAll !== "boolean")) throw Error("invalid_message");
      const parentIndex = owner.inclusions.findIndex(rule => HdmRules.identity(rule) === HdmRules.identity(message.parent));
      if (parentIndex < 0) throw Error("rule_not_found");
      owner.inclusions = owner.inclusions.map((rule, index) => index === parentIndex ? { ...rule } : rule);
      owner = owner.inclusions[parentIndex];
    }
    const rules = owner[field] || [];
    const position = rules.findIndex(rule => HdmRules.identity(rule) === HdmRules.identity(message));
    if (position < 0) throw Error("rule_not_found");
    const updated = HdmRules.updateMetadata(rules[position], message.changes);
    owner[field] = rules.map((rule, index) => index === position ? updated : rule);
    await saveUniversalSites(next);
    return { sites: next };
  }
  if (message.type === "hdm-universal-set-mode") {
    if (!["page", "selected"].includes(message.mode)) throw new Error("invalid_message");
    if (index < 0) throw new Error("site_not_found");
    next[index].mode = message.mode;
    await saveLibrary(previous, next);
    return { sites: next };
  }
  if (message.type === "hdm-inversion-save") {
    if (index < 0) throw new Error("site_not_found");
    if (!next[index].enabled) throw new Error("site_paused");
    if (next[index].mode !== "selected") throw new Error("settings_changed");
    const rule = HdmRules.validateInclusion(message.rule);
    const removals = HdmRules.validateLegacyRemovals(message.removeLegacyProtections);
    const rules = next[index].inclusions || [];
    const identity = HdmRules.identity;
    const legacy = next[index].protections || [];
    for (const snapshot of removals) {
      const existing = legacy.find(value => identity(value) === identity(snapshot));
      if (!existing || JSON.stringify(existing) !== JSON.stringify(snapshot)) throw new Error("rule_conflict");
    }
    if (removals.length) {
      const removed = new Set(removals.map(identity));
      next[index].protections = legacy.filter(value => !removed.has(identity(value)));
    }
    const collision = rules.findIndex(existing => identity(existing) === identity(rule));
    if (message.previousRule !== undefined) {
      const snapshot = HdmRules.validateInclusion(message.previousRule);
      const original = rules.findIndex(existing => identity(existing) === identity(snapshot));
      if (original < 0 || JSON.stringify(rules[original]) !== JSON.stringify(snapshot) ||
          (collision >= 0 && collision !== original)) throw new Error("rule_conflict");
      if (JSON.stringify(rules[original]) === JSON.stringify(rule) && !removals.length) return { sites: previous };
      next[index].inclusions = rules.map((existing, position) => position === original ? rule : existing);
    } else {
      if (collision >= 0) throw new Error("rule_conflict");
      if (rules.length >= HdmRules.MAX_RULES) throw new Error("too_many_rules");
      next[index].inclusions = [...rules, rule];
    }
    await saveUniversalSites(next);
    return { sites: next };
  }
  if (["hdm-exclusion-add", "hdm-exclusion-remove", "hdm-inversion-remove", "hdm-protection-remove"].includes(message.type)) {
    if (index < 0) throw new Error("site_not_found");
    const list = message.type.startsWith("hdm-inversion-") ? "inclusions" : message.type.startsWith("hdm-protection-") ? "protections" : "exclusions";
    const rules = next[index][list] || [];
    if (message.type.endsWith("-add")) {
      if (!next[index].enabled) throw new Error("site_paused");
      const [rule] = HdmRules.normalizeExclusions([message.rule]);
      if (!rule) throw new Error("invalid_rule");
      if (rules.some(existing => HdmRules.identity(existing) === HdmRules.identity(rule))) return { sites: previous };
      if (rules.length >= HdmRules.MAX_RULES) throw new Error("too_many_rules");
      next[index][list] = HdmRules.normalizeExclusions([...rules, rule]);
    } else {
      const key = HdmRules.identity(message);
      next[index][list] = rules.filter(rule => HdmRules.identity(rule) !== key);
    }
    await saveUniversalSites(next);
    return { sites: next };
  } else if (message.type === "hdm-universal-remove-site") {
    if (index < 0) return { sites: previous };
    next.splice(index, 1);
  } else if (message.type === "hdm-universal-set-enabled") {
    if (typeof message.enabled !== "boolean") throw new Error("invalid_message");
    if (index < 0) throw new Error("site_not_found");
    if (message.enabled && !(await hasAccess(next[index]))) throw new Error("permission_required");
    next[index].enabled = message.enabled;
  } else {
    throw new Error("invalid_message");
  }
  return commitSites(previous, next, new Set([message.origin]));
}

async function reconcileUniversalSites() {
  const sites = await getUniversalSites();
  const effective = await syncRegistrations(sites);
  return { sites, application: scheduleApplication(effective, new Set(sites.map(site => site.origin))) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === "hdm-document-access" && sender.tab) {
    const site = HdmSites.fromUrl(message.origin);
    if (!site.supported || site.origin !== message.origin) return false;
    hasAccess(site).then(allowed => sendResponse({ ok: true, allowed }), () => sendResponse({ ok: false }));
    return true;
  }
  const popup = ["popup/", "options/"].some((directory) => sender.url?.startsWith(chrome.runtime.getURL(directory)));
  const picker = ["hdm-exclusion-add", "hdm-inversion-save"].includes(message?.type) && sender.tab &&
    HdmSites.fromUrl(sender.url || "").origin === message.origin;
  if (!popup && !picker) return false;
  const result = message?.type === "hdm-universal-get-sites"
    ? getUniversalSites().then(sites => ({ sites }))
    : enqueue(() => handleMessage(message));
  result
    .then(async ({ application, ...result }) => {
      const reply = popup ? result : { ...result, sites: result.sites?.filter(site => site.origin === message.origin) };
      sendResponse({ ok: true, ...reply, warning: await application });
    })
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

function scheduleReconciliation() {
  return enqueue(reconcileUniversalSites).catch(() => {
    // Never log addresses, page text or arbitrary browser error messages.
    console.warn("Hardcode Dark Mode: could not reconcile site settings.");
  });
}

// Session state survives worker suspension, but is cleared when the extension
// is disabled or reloaded. Existing documents then need their controller back.
const sessionRestoration = enqueue(async () => {
  const { documentsRestored } = await chrome.storage.session.get({ documentsRestored: false });
  if (documentsRestored) return;
  const sites = await getUniversalSites();
  const effective = await sitesWithAccess(sites);
  const result = { application: scheduleApplication(effective, new Set(sites.map(site => site.origin))) };
  await chrome.storage.session.set({ documentsRestored: true });
  return result;
}).then(result => result?.application).catch(() => {
  console.warn("Hardcode Dark Mode: could not restore open documents.");
});

chrome.runtime.onInstalled.addListener(scheduleReconciliation);
chrome.runtime.onStartup.addListener(scheduleReconciliation);
chrome.permissions.onRemoved.addListener(scheduleReconciliation);
chrome.permissions.onAdded.addListener(scheduleReconciliation);
