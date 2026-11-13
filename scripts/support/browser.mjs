import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function createBrowserHarness({ server, extension = true, headless = false,
  viewport = { width: 1000, height: 850 }, deviceScaleFactor, timeout = 0, name = "Browser", directory } = {}) {
  let context, scratch, watchdog, timeoutError;

  function deadline() {
    clearTimeout(watchdog);
    if (!timeout) return;
    watchdog = setTimeout(() => {
      timeoutError = Error(`${name} scenario exceeded ${timeout / 1000} seconds`);
      void context?.close().catch(error => console.error("Browser deadline cleanup:", error));
    }, timeout);
  }

  async function launch() {
    if (!process.env.HDM_PLAYWRIGHT_PATH) throw Error("Set HDM_PLAYWRIGHT_PATH to an installed Playwright entry point.");
    await context?.close();
    if (!scratch) {
      if (directory) {
        const target = path.resolve(directory);
        assert(!fs.existsSync(target), "Refuse to reuse an existing browser directory");
        fs.mkdirSync(target);
        scratch = target;
      } else {
        const base = path.resolve(process.env.HDM_TEMP_DIR || path.join(project, "temporary_files"));
        fs.mkdirSync(base, { recursive: true });
        scratch = fs.mkdtempSync(path.join(base, "browser-"));
      }
    }
    const { chromium } = await import(pathToFileURL(process.env.HDM_PLAYWRIGHT_PATH));
    context = await chromium.launchPersistentContext(path.join(scratch, "p"), {
      executablePath: process.env.HDM_CHROMIUM || undefined, headless, viewport,
      ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
      ignoreDefaultArgs: ["--disable-blink-features=AutomationControlled", ...(extension ? ["--disable-extensions"] : [])],
      args: ["--enable-automation", ...(extension ? [`--disable-extensions-except=${project}`, `--load-extension=${project}`] : [])]
    });
    const page = context.pages()[0] || await context.newPage();
    const session = await context.newCDPSession(page);
    try {
      const command = await session.send("Browser.getBrowserCommandLine");
      assert(!command.arguments.some(value => value.includes("AutomationControlled")), "Unexpected browser automation override");
    } finally {
      await session.detach();
    }
    return context;
  }

  function removeScratch() {
    if (!scratch) return;
    assert.equal(fs.realpathSync(scratch), scratch, "Browser scratch directory changed");
    const inspect = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        let stat;
        try { stat = fs.lstatSync(filename); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        assert(!stat.isSymbolicLink(), "Refuse cleanup through symbolic links");
        if (entry.isDirectory()) inspect(filename);
      }
    };
    inspect(scratch);
    fs.rmSync(scratch, { recursive: true, maxRetries: 5, retryDelay: 100 });
    assert(!fs.existsSync(scratch), "Browser scratch cleanup did not finish");
  }

  async function run(operation) {
    if (!process.env.HDM_PLAYWRIGHT_PATH) {
      console.log(`SKIP ${name}: set HDM_PLAYWRIGHT_PATH to run browser checks.`);
      return;
    }
    let failed = false, failure;
    try { await operation(); } catch (error) { failed = true; failure = error; }
    clearTimeout(watchdog);
    const results = await Promise.allSettled([
      context?.close(),
      server && new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close(error => error ? reject(error) : resolve());
      })
    ]);
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (results[0].status === "fulfilled") {
      try { removeScratch(); } catch (error) { failures.push(error); }
    }
    if (timeoutError) {
      failure = failed ? new AggregateError([timeoutError, failure], timeoutError.message, { cause: failure }) : timeoutError;
      failed = true;
    }
    if (failed && failures.length) throw new AggregateError([failure, ...failures], failure?.message || String(failure), { cause: failure });
    if (failed) throw failure;
    if (failures.length) throw new AggregateError(failures, "Browser fixture cleanup failed");
  }

  return { launch, run, deadline, get scratch() { return scratch; } };
}

export function decodePng(page, png) {
  return page.evaluate(async encoded => {
    const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, pixels: [...context.getImageData(0, 0, image.width, image.height).data] };
  }, png.toString("base64"));
}
