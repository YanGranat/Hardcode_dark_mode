const toastEl = document.getElementById("toast");
const toastTextEl = document.getElementById("toast-text");
const toastActionEl = document.getElementById("toast-action");
const currentSiteNameEl = document.getElementById("current-site-name");
const currentSiteStatusEl = document.getElementById("current-site-status");
const currentSiteActionEl = document.getElementById("current-site-action");
const currentSiteSwitchEl = document.getElementById("current-site-switch");
const currentSiteEnabledEl = document.getElementById("current-site-enabled");
const libraryCountEl = document.getElementById("library-count");
const libraryEmptyEl = document.getElementById("library-empty");
const libraryListEl = document.getElementById("library-list");
const librarySortEl = document.getElementById("library-sort");
const librarySortMenuEl = document.getElementById("library-sort-menu");
const librarySortOptions = [...librarySortMenuEl.querySelectorAll("[data-sort]")];
const libraryBackupEl = document.getElementById("library-backup");
const libraryBackupMenuEl = document.getElementById("library-backup-menu");
const backupFileEl = document.getElementById("backup-file");
const exclusionsEl = document.getElementById("exclusions");
const pickElement = document.getElementById("pick-element");
const languageButtons = Array.from(document.querySelectorAll(".language-btn"));
const modeButtons = [...document.querySelectorAll("[data-mode]")];

let currentLanguage = "en", pickerPending = false, toastTimer = null;
const model = HdmPopupState.create(chrome, next => {
  state = next;
  applyLanguage(state.settings.language);
  renderCurrentSite();
  renderLibrary();
}, (key, detail) => showToast(translate(key), detail?.removed
  ? { label: translate("undo"), run: () => model.restore(detail.removed) } : null));
let state = model.snapshot();

function translate(key, values) { return HdmPopupText.translate(currentLanguage, key, values); }

function applyLanguage(language) {
  currentLanguage = HdmPopupText.normalizeLanguage(language);
  document.documentElement.lang = currentLanguage;

  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = translate(element.dataset.i18n);
  });

  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", translate(element.dataset.i18nAriaLabel));
  });

  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    element.title = translate(element.dataset.i18nTitle);
  });

  languageButtons.forEach((button) => {
    const isActive = button.dataset.language === currentLanguage;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function hideToast() {
  clearTimeout(toastTimer);
  toastEl.classList.remove("show", "has-action");
  toastActionEl.hidden = true;
  toastActionEl.onclick = null;
}

// The toast owns its text: nothing else may rewrite it while it is visible.
function showToast(message, action = null) {
  toastTextEl.textContent = message;
  toastActionEl.hidden = !action;
  toastActionEl.textContent = action ? action.label : "";
  toastActionEl.onclick = action ? () => { hideToast(); action.run(); } : null;
  toastEl.classList.toggle("has-action", Boolean(action));
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  // Longer messages stay long enough to be read; an offered action stays longer.
  toastTimer = setTimeout(hideToast, action ? 6000 : Math.max(1800, Math.min(7000, message.length * 60)));
}

function canPickElement() {
  return !pickerPending && model.canPick();
}

function renderCurrentSite() {
  const focusedRule = exclusionsEl.contains(document.activeElement);
  renderExclusions();
  currentSiteActionEl.classList.remove("danger");
  const entry = state.currentSite.supported ? model.site(state.currentSite.origin) : null;
  currentSiteSwitchEl.hidden = !entry;
  currentSiteEnabledEl.disabled = !entry;
  currentSiteEnabledEl.checked = entry?.enabled === true;
  currentSiteEnabledEl.setAttribute("aria-label", entry
    ? translate("enableSite", { site: state.currentSite.label }) : translate("currentSiteTheme"));

  if (!state.currentSite.supported) {
    currentSiteNameEl.textContent = translate("unsupportedTitle");
    currentSiteNameEl.removeAttribute("title");
    currentSiteStatusEl.textContent = translate("unsupportedPage");
    currentSiteActionEl.textContent = translate("addSite");
    currentSiteActionEl.disabled = true;
    return;
  }

  currentSiteNameEl.textContent = state.currentSite.label;
  currentSiteNameEl.title = state.currentSite.label;
  if (!entry) {
    currentSiteStatusEl.textContent = translate("notInLibrary");
    currentSiteActionEl.textContent = translate("addSite");
    currentSiteActionEl.disabled = false;
    if (focusedRule && document.activeElement === document.body) currentSiteActionEl.focus();
    return;
  }

  currentSiteStatusEl.textContent = translate(entry.enabled ? state.currentAccess === false ? "accessWithheld" : "enabledInLibrary" : "pausedInLibrary");
  currentSiteActionEl.textContent = translate("removeSite");
  currentSiteActionEl.classList.add("danger");
  currentSiteActionEl.disabled = false;
}

function renderExclusions() {
  const site = state.currentSite.supported ? model.site(state.currentSite.origin) : null;
  exclusionsEl.hidden = !site;
  pickElement.disabled = !canPickElement();
  const selected = site?.mode === "selected";
  for (const button of modeButtons) button.setAttribute("aria-pressed", String(button.dataset.mode === (selected ? "selected" : "page")));
  pickElement.textContent = translate(selected ? "invertElement" : "pickElement");
  document.querySelector('#exclusion-details [data-i18n]').textContent = translate(selected ? "inversions" : "exclusions");
  renderRules(site?.[selected ? "inclusions" : "exclusions"] || [], "exclusion", selected ? "inversion" : "exclusion");
  renderRules(selected ? site?.protections || [] : [], "protection", "protection");
}

const ruleLists = new WeakMap();
let nextRuleControl = 0;
function renderRules(rules, prefix, action) {
  document.getElementById(`${prefix}-count`).textContent = String(rules.length);
  renderRuleList(document.getElementById(`${prefix}-list`), rules, action);
  document.getElementById(`${prefix}-details`).hidden = !rules.length;
}

function keepListFocus(list, fallback) {
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const index = [...list.children].findIndex(row => row.contains(focused));
  const role = ["remove-site-btn", "rule-name", "rule-name-save", "rule-show", "rule-settings-btn", "rule-edit"]
    .find(name => focused?.classList.contains(name));
  const selector = role ? `.${role}` : "input";
  const usable = node => node && !node.disabled && node.getClientRects().length;
  return () => {
    if (!focused || (document.activeElement !== focused && document.activeElement !== document.body)) return;
    if (usable(focused)) {
      if (document.activeElement !== focused) focused.focus({ preventScroll: true });
      return;
    }
    const row = list.children[Math.min(index, list.children.length - 1)];
    const next = [row?.querySelector(selector), row?.querySelector(".rule-settings-btn"), fallback,
      ...modeButtons, currentSiteActionEl].find(usable);
    next?.focus();
  };
}

function renderRuleList(list, rules, kind, parent = null) {
  let rows = ruleLists.get(list);
  if (!rows) { rows = new Map(); ruleLists.set(list, rows); }
  const fallback = list.closest(".exclusion-row")?.querySelector(":scope > .rule-settings-btn") || pickElement;
  const restoreFocus = keepListFocus(list, fallback);
  const viewKey = rule => JSON.stringify([state.currentSite.origin, kind, HdmRules.identity(rule)]);
  const keys = new Set(rules.map(viewKey));
  for (const [key, row] of rows) if (!keys.has(key)) { row.remove(); rows.delete(key); }
  rules.forEach((rule, index) => {
    const key = viewKey(rule);
    const row = rows.get(key) || createRuleRow(kind);
    rows.set(key, row);
    row.rule = rule; row.parentRule = parent;
    row.dataset.rule = HdmRules.identity(rule);
    const name = HdmRules.displayLabel(rule);
    const label = row.querySelector(".rule-title");
    label.textContent = name + (rule.matchAll ? ` (${translate("similarRule")})` : "") +
      (kind === "inversion" ? ` · ${translate("exceptionCount", { count: rule.protections?.length || 0 })}` : "");
    label.title = rule.path.join(" → ");
    if (kind === "inversion") {
      label.disabled = !canPickElement();
      label.setAttribute("aria-label", translate("editRule", { element: name }));
    }
    const toggle = row.querySelector(".rule-enabled input");
    toggle.checked = rule.enabled !== false;
    toggle.setAttribute("aria-label", translate("enableRule", { element: name }));
    row.classList.toggle("rule-paused", rule.enabled === false);
    const remove = row.querySelector(".remove-site-btn");
    remove.hidden = Boolean(parent);
    remove.setAttribute("aria-label", translate("removeExclusion", { element: name }));
    const settings = row.querySelector(".rule-settings-btn");
    settings.querySelector("span").textContent = translate("ruleSettings");
    row.querySelector(".rule-name-label").textContent = translate("ruleName");
    const input = row.querySelector(".rule-name");
    input.setAttribute("aria-label", translate("ruleName"));
    input.placeholder = HdmRules.displayLabel({ ...rule, name: undefined });
    if (!row.dirty) input.value = rule.name || "";
    const save = row.querySelector(".rule-name-save");
    save.textContent = translate("saveName");
    save.disabled = Boolean(row.saving) || !row.dirty;
    const show = row.querySelector(".rule-show");
    show.textContent = translate("showMatches");
    show.disabled = !state.currentAccess || Boolean(row.showing) || model.isPending(state.currentSite.origin);
    row.querySelector(".rule-children-title").textContent = translate("protectionsInBlock");
    const children = row.querySelector(".rule-child-list");
    const hasChildren = kind === "inversion" && Boolean(rule.protections?.length);
    row.querySelector(".rule-children-title").hidden = !hasChildren;
    if (row.open) renderRuleList(children, hasChildren ? rule.protections : [], "protection", rule);
    children.hidden = !hasChildren;
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
  });
  restoreFocus();
}
function createRuleRow(kind) {
  const row = document.createElement("div"); row.className = "exclusion-row";
  const heading = document.createElement("div"); heading.className = "rule-heading";
  const label = document.createElement(kind === "inversion" ? "button" : "span");
  label.className = kind === "inversion" ? "rule-title rule-edit" : "rule-title";
  if (kind === "inversion") { label.type = "button"; label.addEventListener("click", () => startPicker(row.rule)); }
  const toggle = document.createElement("label"); toggle.className = "switch compact rule-enabled";
  toggle.innerHTML = '<input type="checkbox"><span class="slider"></span>';
  toggle.querySelector("input").addEventListener("change", event => {
    model.updateRule(kind, row.rule, { enabled: event.target.checked }, row.parentRule);
  });
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "remove-site-btn";
  remove.innerHTML = createRemoveIcon();
  remove.addEventListener("click", async () => {
    const restoreFocus = keepListFocus(row.parentElement, pickElement);
    remove.disabled = true;
    try {
      await model.removeRule(kind, row.rule);
      showToast(translate("exclusionRemoved"));
    }
    catch { showToast(translate("operationFailed")); }
    finally { remove.disabled = false; restoreFocus(); }
  });
  heading.append(label, toggle, remove);
  const settings = document.createElement("button"); settings.type = "button"; settings.className = "rule-settings-btn";
  settings.setAttribute("aria-expanded", "false");
  settings.append(document.createElement("span"), librarySortEl.querySelector("svg").cloneNode(true));
  const options = document.createElement("div"); options.className = "rule-settings"; options.hidden = true;
  const control = ++nextRuleControl;
  options.id = `rule-settings-${control}`; settings.setAttribute("aria-controls", options.id);
  const form = document.createElement("form"); form.className = "rule-name-form";
  const nameLabel = document.createElement("label"); nameLabel.className = "rule-name-label";
  const input = document.createElement("input"); input.className = "rule-name"; input.type = "text"; input.maxLength = 80;
  input.id = `rule-name-${control}`; nameLabel.htmlFor = input.id;
  input.autocomplete = "off"; input.spellcheck = false;
  const save = document.createElement("button"); save.className = "rule-name-save"; save.type = "submit";
  form.append(nameLabel, input, save);
  input.addEventListener("input", () => { row.dirty = true; save.disabled = Boolean(row.saving); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (row.saving || !row.dirty) return;
    const submitted = input.value;
    row.saving = true; save.disabled = true;
    try {
      await model.updateRule(kind, row.rule, { name: submitted }, row.parentRule);
      if ((row.rule.name || "") === submitted.trim() && input.value === submitted) row.dirty = false;
    } catch { showToast(translate("operationFailed")); }
    finally { row.saving = false; renderExclusions(); }
  });
  const show = document.createElement("button"); show.type = "button"; show.className = "rule-show";
  show.addEventListener("click", async () => {
    if (row.showing) return;
    row.showing = true; show.disabled = true;
    try { await model.showRule(kind, row.rule, currentLanguage, row.parentRule); window.close(); }
    catch (error) { showToast(translate(error.message === "editor_open" ? "editorOpen" : "pickerFailed")); }
    finally { row.showing = false; show.disabled = !state.currentAccess || model.isPending(state.currentSite.origin); }
  });
  const childTitle = document.createElement("div"); childTitle.className = "rule-children-title";
  const children = document.createElement("div"); children.className = "rule-child-list";
  options.append(form, show, childTitle, children);
  settings.addEventListener("click", () => {
    row.open = !row.open; options.hidden = !row.open;
    settings.setAttribute("aria-expanded", String(Boolean(row.open)));
    renderExclusions(); fitLibrary();
  });
  row.append(heading, settings, options); return row;
}

function createRemoveIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"/>
    </svg>
  `;
}

function createLibraryRow(site) {
  const row = document.createElement("div");
  row.className = "site-entry";
  row.dataset.origin = site.origin;

  const copy = document.createElement("div");
  copy.className = "site-copy";
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = site.label;
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = site.origin;
  copy.append(label, hint);

  const actions = document.createElement("div");
  actions.className = "site-entry-actions";

  const switchLabel = document.createElement("label");
  switchLabel.className = "switch compact";
  const input = document.createElement("input");
  input.type = "checkbox";
  const slider = document.createElement("span");
  slider.className = "slider";
  switchLabel.append(input, slider);

  input.addEventListener("change", () => model.setEnabled(site.origin, input.checked));

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "remove-site-btn";
  removeButton.innerHTML = createRemoveIcon();
  removeButton.addEventListener("click", () => model.remove(site.origin));

  actions.append(switchLabel, removeButton);
  row.append(copy, actions);
  return row;
}

function renderLibrary() {
  const order = state.sort;
  librarySortEl.value = order;
  for (const option of librarySortOptions) option.setAttribute("aria-checked", String(option.dataset.sort === order));
  const sortLabel = librarySortOptions.find(option => option.dataset.sort === order).textContent;
  document.getElementById("library-sort-label").textContent = sortLabel;
  librarySortEl.setAttribute("aria-label", `${translate("sortLibrary")}: ${sortLabel}`);
  const sortedSites = HdmPopupState.sortSites(state.sites, order);
  const restoreFocus = keepListFocus(libraryListEl, librarySortEl);
  libraryCountEl.textContent = String(sortedSites.length);
  libraryEmptyEl.hidden = sortedSites.length > 0;
  const rows = new Map([...libraryListEl.children].map(row => [row.dataset.origin, row]));
  const origins = new Set(sortedSites.map(site => site.origin));
  for (const [origin, row] of rows) {
    if (!origins.has(origin)) row.remove();
  }
  sortedSites.forEach((site, index) => {
    const row = rows.get(site.origin) || createLibraryRow(site);
    row.querySelector("input").checked = site.enabled;
    row.querySelector("input").setAttribute("aria-label", translate("enableSite", { site: site.label }));
    const removeButton = row.querySelector("button");
    removeButton.title = translate("removeSiteLabel", { site: site.label });
    removeButton.setAttribute("aria-label", removeButton.title);
    if (libraryListEl.children[index] !== row) {
      libraryListEl.insertBefore(row, libraryListEl.children[index] || null);
    }
  });
  restoreFocus();
  fitLibrary();
}

function fitLibrary() {
  const listHeight = libraryListEl.getBoundingClientRect().height;
  const chromeHeight = document.body.getBoundingClientRect().height - listHeight;
  const capacity = Math.max(1, Math.min(6, Math.floor((600 - chromeHeight) / 48)));
  if (libraryListEl.style.getPropertyValue("--library-rows") !== String(capacity)) libraryListEl.style.setProperty("--library-rows", String(capacity));
  libraryListEl.classList.toggle("overflowing", libraryListEl.children.length > capacity);
}

languageButtons.forEach((button) => {
  button.addEventListener("click", () => {
    model.saveSettings({ language: button.dataset.language });
  });
});

modeButtons.forEach(button => button.addEventListener("click", () => model.setMode(button.dataset.mode)));
document.querySelector('.theme-mode').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? modeButtons[0] : event.key === 'End' ? modeButtons[1]
    : modeButtons[(modeButtons.indexOf(document.activeElement) + 1) % 2];
  next.focus(); next.click();
});

// One behaviour for every dropdown of the popup: the sort order and the backup actions.
function createMenu(trigger, menu, initialItem = () => null) {
  const items = [...menu.querySelectorAll("button")], root = trigger.parentElement;
  function close(restoreFocus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }
  function open() {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    const anchor = trigger.getBoundingClientRect(), box = menu.getBoundingClientRect();
    const top = anchor.bottom + 6 + box.height <= innerHeight - 8
      ? anchor.bottom + 6 : anchor.top - box.height - 6;
    menu.style.left = `${Math.max(8, Math.min(anchor.right - box.width, document.documentElement.clientWidth - box.width - 8))}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    (initialItem() || items[0]).focus({ preventScroll: true });
  }
  trigger.addEventListener("click", () => {
    if (menu.hidden) open();
    else close();
  });
  trigger.addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    open();
  });
  menu.addEventListener("keydown", event => {
    const index = items.indexOf(document.activeElement);
    let next;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    if (event.key === "ArrowUp") next = (index + items.length - 1) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (next !== undefined) { event.preventDefault(); items[next].focus({ preventScroll: true }); }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    // Resume normal tab order from the trigger, without trapping focus in the menu.
    if (event.key === "Tab") close(true);
  });
  menu.addEventListener("pointermove", event => {
    const item = event.target.closest("button");
    if (item && document.activeElement !== item) item.focus({ preventScroll: true });
  });
  document.addEventListener("pointerdown", event => {
    if (!root.contains(event.target)) close();
  });
  document.addEventListener("focusin", event => {
    if (!root.contains(event.target)) close();
  });
  document.addEventListener("scroll", () => close(menu.contains(document.activeElement)), true);
  window.addEventListener("resize", () => close(menu.contains(document.activeElement)));
  return { close };
}

const sortMenu = createMenu(librarySortEl, librarySortMenuEl,
  () => librarySortOptions.find(option => option.dataset.sort === librarySortEl.value));
librarySortOptions.forEach(option => option.addEventListener("click", async () => {
  sortMenu.close(true);
  const saved = model.setSort(option.dataset.sort);
  libraryListEl.scrollTop = 0;
  await saved;
}));

const backupMenu = createMenu(libraryBackupEl, libraryBackupMenuEl);
async function runBackup(operation, success, failure) {
  try { showToast(translate(success, { count: await operation() })); }
  catch (error) { showToast(translate(error.message === "invalid_file" ? "backupInvalid" : failure)); }
}
libraryBackupMenuEl.addEventListener("click", event => {
  const action = event.target.closest("[data-backup]")?.dataset.backup;
  if (!action) return;
  backupMenu.close(true);
  if (action === "export") runBackup(() => HdmBackup.save(chrome, document, currentLanguage), "backupExported", "backupExportFailed");
  else backupFileEl.click();
});
backupFileEl.addEventListener("change", () => {
  const [file] = backupFileEl.files;
  backupFileEl.value = "";
  if (file) runBackup(() => HdmBackup.load(chrome, file), "backupImported", "backupImportFailed");
});

currentSiteActionEl.addEventListener("click", () => model.toggleMembership());
currentSiteEnabledEl.addEventListener("change", () => {
  if (state.currentSite.supported) model.setEnabled(state.currentSite.origin, currentSiteEnabledEl.checked);
});
async function startPicker(rule = null) {
  if (!state.tab || !canPickElement()) return;
  pickerPending = true;
  pickElement.disabled = true;
  document.querySelectorAll('.rule-edit').forEach(button => button.disabled = true);
  try {
    await model.pick(rule, currentLanguage);
    window.close();
  } catch (error) {
    showToast(translate({ editor_open: "editorOpen", selector_unavailable: "ruleNotOnPage" }[error.message] || "pickerFailed"));
  }
  finally { pickerPending = false; pickElement.disabled = !canPickElement(); document.querySelectorAll('.rule-edit').forEach(button => button.disabled = !canPickElement()); }
}
pickElement.addEventListener("click", () => startPicker());

new ResizeObserver(fitLibrary).observe(document.body);

applyLanguage(state.settings.language);
currentSiteStatusEl.textContent = translate("loading");
currentSiteActionEl.textContent = translate("addSite");
model.init();
