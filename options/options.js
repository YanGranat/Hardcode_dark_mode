// The same two actions as the popup's backup menu, on a page of their own for systems
// where a toolbar popup closes as soon as a file dialog opens.
const exportButton = document.getElementById("export");
const importButton = document.getElementById("import");
const fileInput = document.getElementById("file");
const statusEl = document.getElementById("status");
let language = HdmLanguages.detect(chrome.i18n.getUILanguage());
let languageChanged = false;
let statusMessage = null;

const translate = (key, values) => HdmPopupText.translate(language, key, values);

function applyLanguage(next) {
  language = HdmPopupText.normalizeLanguage(next);
  document.documentElement.lang = language;
  for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = translate(element.dataset.i18n);
  if (statusMessage) statusEl.textContent = translate(statusMessage.key, statusMessage.values);
}

function report(key, values, failed = false) {
  statusMessage = { key, values };
  statusEl.textContent = translate(key, values);
  statusEl.classList.toggle("error", failed);
}

async function run(operation, success, failure) {
  exportButton.disabled = importButton.disabled = true;
  try { report(success, { count: await operation() }); }
  catch (error) { report(error.message === "invalid_file" ? "backupInvalid" : failure, {}, true); }
  finally { exportButton.disabled = importButton.disabled = false; }
}

exportButton.addEventListener("click", () => run(() => HdmBackup.save(chrome, document, language), "backupExported", "backupExportFailed"));
importButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  fileInput.value = "";
  if (file) run(() => HdmBackup.load(chrome, file), "backupImported", "backupImportFailed");
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.language) {
    languageChanged = true;
    applyLanguage(changes.language.newValue ?? HdmLanguages.detect(chrome.i18n.getUILanguage()));
  }
});

applyLanguage(language);
chrome.storage.sync.get({ language }).then(stored => {
  if (!languageChanged) applyLanguage(stored.language);
}).catch(() => {});
