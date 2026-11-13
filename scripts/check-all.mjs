import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.some(argument => argument !== "--browser")) throw Error("Usage: node scripts/check-all.mjs [--browser]");
const commands = [["scripts/check.mjs"], ["--test", "scripts/unit/*.test.mjs"]];
if (args.includes("--browser")) {
  if (!process.env.HDM_PLAYWRIGHT_PATH) console.log("SKIP browser checks: set HDM_PLAYWRIGHT_PATH to run them.");
  else for (const file of readdirSync(new URL("./", import.meta.url)).sort()) {
    if (/^test-.*\.mjs$/.test(file)) commands.push([`scripts/${file}`]);
  }
}
for (const command of commands) {
  const result = spawnSync(process.execPath, command, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
