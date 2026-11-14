import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function relative(file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function fail(message) {
  failures.push(message);
}

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function parseJson(file) {
  try {
    return JSON.parse(read(file));
  } catch (error) {
    fail(`${file}: invalid JSON (${error.message})`);
    return null;
  }
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (directory === root && entry.name === "release") continue;
    if ([".git", "backup", "dev_docs", "node_modules", "output", "temporary_files"].includes(entry.name)) {
      continue;
    }
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(target));
    } else {
      files.push(target);
    }
  }
  return files;
}

const manifest = parseJson("manifest.json");
if (!manifest) {
  process.exitCode = 1;
} else {
  const referencedFiles = new Set([
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    manifest.background?.service_worker,
    ...Object.values(manifest.icons || {}),
    ...(manifest.content_scripts || []).flatMap((script) => [...(script.js || []), ...(script.css || [])])
  ].filter(Boolean));

  for (const file of referencedFiles) {
    if (!fs.existsSync(path.join(root, file))) {
      fail(`manifest.json: missing referenced file ${file}`);
    }
  }

  if (manifest.manifest_version !== 3) {
    fail("manifest.json: the extension is written for Manifest V3");
  }
  for (const permission of ["storage", "scripting"]) {
    if (!manifest.permissions?.includes(permission)) fail(`manifest.json: the ${permission} permission is required`);
  }
  if (!manifest.host_permissions?.includes("http://*/*") ||
      !manifest.host_permissions?.includes("https://*/*")) {
    fail("manifest.json: universal mode requires the declared HTTP and HTTPS host access");
  }
  if (manifest.content_scripts?.length) {
    fail("manifest.json: sites must be activated through the library, not automatic content scripts");
  }
  if (manifest.permissions?.includes("activeTab")) {
    fail("manifest.json: activeTab is redundant while broad host access is declared");
  }
  if (!Number.isFinite(Number(manifest.minimum_chrome_version)) || Number(manifest.minimum_chrome_version) < 119) {
    fail("manifest.json: matchOriginAsFallback requires Chrome 119 or newer");
  }
}

const allFiles = walk(root);
const javascriptFiles = allFiles.filter((file) => [".js", ".mjs"].includes(path.extname(file)));
for (const file of javascriptFiles) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    fail(`${relative(file)}: JavaScript syntax check failed\n${(result.stderr || result.stdout).trim()}`);
  }
}

const cssFiles = allFiles.filter((file) => path.extname(file) === ".css");
const remoteCssPattern = /@import\s+(?:url\()?\s*["']?https?:|url\(\s*["']?https?:/i;
for (const file of cssFiles) {
  if (remoteCssPattern.test(fs.readFileSync(file, "utf8"))) {
    fail(`${relative(file)}: remote CSS asset found`);
  }
}

const englishLocale = parseJson("_locales/en/messages.json");
const russianLocale = parseJson("_locales/ru/messages.json");
if (englishLocale && russianLocale) {
  const englishKeys = Object.keys(englishLocale).sort();
  const russianKeys = Object.keys(russianLocale).sort();
  if (JSON.stringify(englishKeys) !== JSON.stringify(russianKeys)) {
    fail("_locales: English and Russian message keys differ");
  }
  for (const [, key] of JSON.stringify(manifest || {}).matchAll(/__MSG_(\w+)__/g)) {
    if (!englishLocale[key]?.message || !russianLocale[key]?.message) fail(`_locales: manifest message ${key} is missing`);
  }
}
if (manifest && !fs.existsSync(path.join(root, "_locales", String(manifest.default_locale), "messages.json"))) {
  fail("manifest.json: default_locale has no messages.json");
}

for (const size of [16, 32, 48, 128]) {
  const file = path.join(root, `icons/icon${size}.png`);
  if (!fs.existsSync(file)) {
    fail(`icons/icon${size}.png: missing icon`);
    continue;
  }
  const image = fs.readFileSync(file);
  const isPng = image.length >= 24 && image.subarray(1, 4).toString("ascii") === "PNG";
  const width = isPng ? image.readUInt32BE(16) : 0;
  const height = isPng ? image.readUInt32BE(20) : 0;
  if (!isPng || width !== size || height !== size) {
    fail(`icons/icon${size}.png: expected ${size}x${size} PNG, got ${width}x${height}`);
  }
}

const siteUtilsSource = read("shared/site-utils.js");
const siteContext = { URL };
siteContext.globalThis = siteContext;
vm.createContext(siteContext);
try {
  vm.runInContext(read("shared/rules.js"), siteContext, { filename: "shared/rules.js" });
  vm.runInContext(siteUtilsSource, siteContext, { filename: "shared/site-utils.js" });
  const utility = siteContext.HdmSites;
  for (const url of ["https://deepl.com/", "https://www.deepl.com/", "https://translate.google.com/"]) {
    if (!utility.normalizeStoredSite({ origin: url })) fail("shared/site-utils.js: former profile sites must be eligible for the library");
  }
  const firstPort = utility.fromUrl("http://localhost:3000/");
  const secondPort = utility.fromUrl("http://localhost:4000/");
  if (firstPort.origin !== "http://localhost" || firstPort.scriptId !== secondPort.scriptId) {
    fail("shared/site-utils.js: ports must share one host-level library entry");
  }
} catch (error) {
  fail(`shared/site-utils.js: utility checks failed (${error.message})`);
}

const runtime = vm.createContext({});
vm.runInContext(read("shared/runtime.js"), runtime, { filename: "shared/runtime.js" });
const injected = new Set(["shared", "content", "boot", "shadow", "css"].flatMap((list) => runtime.HdmRuntime[list] || []));
for (const file of injected) {
  if (!fs.existsSync(path.join(root, file))) fail(`Missing runtime asset: ${file}`);
}
// A page script that no injection list names would silently never run.
for (const file of allFiles.map(relative).filter((name) => /^(?:content|editor)\/.+\.js$/.test(name))) {
  if (!injected.has(file)) fail(`${file}: not part of any injection list in shared/runtime.js`);
}
for (const page of [manifest?.action?.default_popup, manifest?.options_ui?.page].filter(Boolean)) {
  if (!fs.existsSync(path.join(root, page))) continue;
  for (const match of read(page).matchAll(/(?:src|href)\s*=\s*["']([^"'#]+)["']/g)) {
    const file = path.resolve(root, path.dirname(page), match[1]);
    if (/^(?:[a-z]+:)?\/\//i.test(match[1]) || !file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      fail(`${page} references a missing or external asset: ${match[1]}`);
    }
  }
}

const universalCss = read("styles/universal.css");
// The engine promises not to restyle selection or scrollbars.
for (const marker of ["::selection", "scrollbar"]) {
  if (universalCss.includes(marker)) {
    fail(`styles/universal.css: the page filter must not restyle ${marker}`);
  }
}
if (!/html\.dmx-on\.dmx-site-universal:not\(\.dmx-mode-selected\)\s*\{[^}]*filter:\s*invert\(90%\)\s+hue-rotate\(180deg\)/.test(universalCss) ||
    !/canvas\s*\{\s*filter:\s*none\s*!important;/s.test(universalCss) ||
    !/^\s*(?:\/\*[^]*?\*\/\s*)*@media screen\s*\{/.test(universalCss)) {
  fail("styles/universal.css: expected screen-only page filter or canvas behavior is missing");
}

const textFiles = allFiles.filter((file) =>
  relative(file) !== "scripts/check.mjs" &&
  [".css", ".html", ".js", ".json", ".md", ".mjs"].includes(path.extname(file))
);
const mojibakePattern = /(?:Рџ|Рё|Р°|С‚|â€|Ã[A-Za-z])/;
for (const file of textFiles) {
  if (mojibakePattern.test(fs.readFileSync(file, "utf8"))) {
    fail(`${relative(file)}: possible mojibake found`);
  }
}

if (failures.length > 0) {
  console.error(`Project audit failed with ${failures.length} issue(s):`);
  failures.forEach((message) => console.error(`- ${message}`));
  process.exitCode = 1;
} else {
  console.log(`Project checks passed: ${javascriptFiles.length} scripts, ${cssFiles.length} stylesheets, ${Object.keys(manifest?.icons || {}).length} icons.`);
}
