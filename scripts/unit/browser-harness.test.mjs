import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { createBrowserHarness } from "../support/browser.mjs";

test("browser harness owns its profiles, launch policy and complete disposal", async t => {
  const base = path.resolve(process.env.HDM_TEMP_DIR || fileURLToPath(new URL("../../temporary_files", import.meta.url)));
  fs.mkdirSync(base, { recursive: true });
  const owned = fs.mkdtempSync(path.join(base, "harness-test-"));
  const modulePath = path.join(owned, "playwright.mjs");
  const originalEntry = process.env.HDM_PLAYWRIGHT_PATH, originalBase = process.env.HDM_TEMP_DIR;
  fs.writeFileSync(modulePath, `import fs from "node:fs";
export const state = { launches: [], closeFailures: 0, closeCalls: 0 };
export const chromium = { async launchPersistentContext(profile, options) {
  fs.mkdirSync(profile, { recursive: true });
  if (!fs.existsSync(profile + "/fixture.txt")) fs.writeFileSync(profile + "/fixture.txt", "owned profile");
  state.launches.push({ profile, options });
  return {
    pages: () => [{}],
    async newCDPSession() { return {
      async send() { return { arguments: ["--disable-extensions", "--disable-blink-features=AutomationControlled"]
        .filter(value => !options.ignoreDefaultArgs.includes(value)).concat(options.args) }; },
      async detach() {}
    }; },
    async close() { state.closeCalls++; if (state.closeFailures > 0) { state.closeFailures--; throw Error("close failed"); } }
  };
} };`, "utf8");
  process.env.HDM_PLAYWRIGHT_PATH = modulePath;
  process.env.HDM_TEMP_DIR = owned;
  try {
    const { state } = await import(pathToFileURL(modulePath));
    await t.test("missing browser tooling is explicitly skipped without starting the scenario", async () => {
      delete process.env.HDM_PLAYWRIGHT_PATH;
      try {
        let ran = false;
        await createBrowserHarness().run(() => { ran = true; });
        assert.equal(ran, false);
      } finally { process.env.HDM_PLAYWRIGHT_PATH = modulePath; }
    });
    await t.test("cleanup tolerates a browser file removed after directory enumeration", async () => {
      const harness = createBrowserHarness(), originalStat = fs.lstatSync;
      try {
        await harness.run(async () => {
          await harness.launch();
          fs.lstatSync = filename => {
            if (filename === path.join(harness.scratch, "p", "fixture.txt")) {
              fs.unlinkSync(filename);
              const error = Error("removed"); error.code = "ENOENT"; throw error;
            }
            return originalStat(filename);
          };
        });
        assert(!fs.existsSync(harness.scratch));
      } finally { fs.lstatSync = originalStat; }
    });
    await t.test("restarts reuse one profile and completed runs remove it", async () => {
      const harness = createBrowserHarness({ viewport: { width: 321, height: 654 }, deviceScaleFactor: 1 });
      await harness.run(async () => {
        await harness.launch();
        const first = state.launches.at(-1);
        assert.equal(first.options.viewport.width, 321);
        assert.equal(first.options.viewport.height, 654);
        assert.equal(first.options.deviceScaleFactor, 1);
        assert.equal(first.options.headless, false);
        assert(first.options.ignoreDefaultArgs.includes("--disable-blink-features=AutomationControlled"));
        assert(first.options.ignoreDefaultArgs.includes("--disable-extensions"));
        assert(first.options.args.some(value => value.startsWith("--load-extension=")));
        assert(first.options.args.includes("--enable-automation"));
        assert(fs.existsSync(path.join(harness.scratch, "p", "fixture.txt")));
        fs.writeFileSync(path.join(harness.scratch, "p", "fixture.txt"), "persistent", "utf8");
        await harness.launch();
        assert.equal(state.launches.at(-1).profile, first.profile);
        assert.equal(fs.readFileSync(path.join(harness.scratch, "p", "fixture.txt"), "utf8"), "persistent");
      });
      assert(!fs.existsSync(harness.scratch));
    });
    await t.test("headless module checks do not load the extension", async () => {
      const harness = createBrowserHarness({ extension: false, headless: true });
      await harness.run(async () => {
        await harness.launch();
        const { options } = state.launches.at(-1);
        assert.equal(options.headless, true);
        assert(options.args.every(value => !value.startsWith("--load-extension=") && !value.startsWith("--disable-extensions-except=")));
      });
      assert(!fs.existsSync(harness.scratch));
    });
    await t.test("scenario failures still close servers and remove owned profiles", async t => {
      const server = http.createServer(), harness = createBrowserHarness({ server });
      t.after(() => server.listening && new Promise(resolve => server.close(resolve)));
      const failure = Error("scenario failed");
      await assert.rejects(harness.run(async () => {
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        await harness.launch();
        throw failure;
      }), error => error === failure);
      assert.equal(server.listening, false);
      assert(!fs.existsSync(harness.scratch));
    });
    await t.test("browser close failure preserves the original error and still closes the server", async t => {
      const server = http.createServer(), harness = createBrowserHarness({ server });
      t.after(() => server.listening && new Promise(resolve => server.close(resolve)));
      const failure = Error("scenario failed");
      await assert.rejects(harness.run(async () => {
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        await harness.launch();
        state.closeFailures = 1;
        throw failure;
      }), error => error instanceof AggregateError && error.cause === failure && error.errors[0] === failure && /close failed/.test(error.errors[1].message));
      assert.equal(server.listening, false);
      assert(fs.existsSync(harness.scratch), "A possibly active browser profile must not be deleted");
    });
    await t.test("an existing directory is never reused or removed", async () => {
      const existing = path.join(owned, "existing"); fs.mkdirSync(existing);
      fs.writeFileSync(path.join(existing, "keep.txt"), "retained", "utf8");
      const harness = createBrowserHarness({ directory: existing });
      await assert.rejects(harness.run(() => harness.launch()), /Refuse to reuse/);
      assert.equal(fs.readFileSync(path.join(existing, "keep.txt"), "utf8"), "retained");
    });
    await t.test("cleanup refuses links and preserves their target", async () => {
      const target = path.join(owned, "target"); fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "keep.txt"), "retained", "utf8");
      const harness = createBrowserHarness();
      await assert.rejects(harness.run(async () => {
        await harness.launch();
        fs.symlinkSync(target, path.join(harness.scratch, "link"), process.platform === "win32" ? "junction" : "dir");
      }), /Browser fixture cleanup failed/);
      assert.equal(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "retained");
      assert(fs.existsSync(harness.scratch));
    });
    await t.test("a phase deadline cannot be reported as a successful scenario", async () => {
      const harness = createBrowserHarness({ timeout: 1, name: "Fixture" });
      await assert.rejects(harness.run(async () => {
        await harness.launch(); harness.deadline();
        await new Promise(resolve => setTimeout(resolve, 20));
      }), /Fixture scenario exceeded/);
      assert(!fs.existsSync(harness.scratch));
    });
    await t.test("non-Error rejections are not mistaken for successful scenarios", async () => {
      const harness = createBrowserHarness();
      const outcome = await harness.run(() => Promise.reject(0)).then(() => ({ success: true }), error => ({ error }));
      assert.deepEqual(outcome, { error: 0 });
    });
    await t.test("a deadline remains visible when closing the browser interrupts a scenario", async () => {
      const harness = createBrowserHarness({ timeout: 1, name: "Fixture" });
      const interrupted = Error("target closed");
      await assert.rejects(harness.run(async () => {
        await harness.launch(); harness.deadline();
        await new Promise(resolve => setTimeout(resolve, 20));
        throw interrupted;
      }), error => error instanceof AggregateError && /Fixture scenario exceeded/.test(error.message) && error.cause === interrupted);
      assert(!fs.existsSync(harness.scratch));
    });
  } finally {
    if (originalEntry === undefined) delete process.env.HDM_PLAYWRIGHT_PATH;
    else process.env.HDM_PLAYWRIGHT_PATH = originalEntry;
    if (originalBase === undefined) delete process.env.HDM_TEMP_DIR;
    else process.env.HDM_TEMP_DIR = originalBase;
    assert.equal(fs.realpathSync(owned), owned);
    fs.rmSync(owned, { recursive: true });
  }
});
