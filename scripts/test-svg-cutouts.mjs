import assert from "node:assert/strict";
import fs from "node:fs";
import { createBrowserHarness } from "./support/browser.mjs";

for (const ratio of [1, 1.25, 1.5, 2]) {
  const harness = createBrowserHarness({
    extension: false,
    headless: true,
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: ratio,
    timeout: 60000,
    name: "SVG cutout",
    directory: process.env.HDM_SVG_SCRATCH,
  });
  await harness.run(async () => {
    const context = await harness.launch();
    harness.deadline();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const command = await cdp.send("Browser.getBrowserCommandLine");
    assert(command.arguments.some((value) => value.startsWith("--headless")));
    await cdp.detach();
    const source = ["shared/rules.js", "content/selectors.js", "content/cutout-geometry.js", "content/cutouts.js"]
      .map((file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"))
      .join("\n");
    const sample = async (points) => {
      const png = await page.screenshot();
      return page.evaluate(
        async ({ encoded, points }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${encoded}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(image, 0, 0);
          return points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
        },
        {
          encoded: png.toString("base64"),
          points: points.map(([x, y]) => [Math.round(x * ratio), Math.round(y * ratio)]),
        },
      );
    };
    for (const owner of ["workspace", "outer"])
      for (const scale of [1, 1.25]) {
        await page.setContent(`<!doctype html><style>
      body{margin:0;background:#bbb}#workspace{margin:20px;width:500px;height:380px;background:white;transform:scale(${scale});transform-origin:top left}
      #outer{position:absolute;left:30px;top:30px;overflow:hidden}
      [data-owner]{filter:invert(90%) hue-rotate(180deg)}
      [data-hdm-cutout]{filter:var(--hdm-cutout-filter)!important}
      </style><div id="workspace"><svg id="outer" width="400" height="300" viewBox="0 0 400 300">
      <rect x="20" y="20" width="300" height="200" fill="white"/>
      <svg id="protected" x="120" y="100" width="100" height="60" viewBox="0 0 100 60"><rect width="100" height="60" fill="#061e47"/><rect x="10" y="10" width="20" height="20" fill="#28e4bc"/></svg>
      </svg></div>`);
        await page.addScriptTag({ content: source });
        const coordinates = [
          [175, 155],
          [185, 165],
          [85, 85],
          [35, 35],
          [265, 205],
          [165, 145],
          [275, 215],
        ].map(([x, y]) => [Math.floor(20 + (x - 20) * scale), Math.floor(20 + (y - 20) * scale)]);
        const original = await sample(coordinates);
        assert.deepEqual(
          original[0],
          [6, 30, 71, 255],
          "Fixture navy sample must lie inside the protected graphic",
        );
        assert.deepEqual(
          original[1],
          [40, 228, 188, 255],
          "Fixture saturated sample must lie inside the protected graphic",
        );
        const geometry = await page.evaluate(
          ({ owner }) => {
            const element = document.getElementById(owner),
              target = document.getElementById("protected"),
              outer = document.getElementById("outer");
            window.cutouts = HdmCutouts.create();
            element.setAttribute("data-owner", "");
            const box = outer.getBBox(),
              rect = outer.getBoundingClientRect();
            cutouts.paint(new Map([[element, 90]]), [target]);
            return {
              blocked: cutouts.blocked(),
              graphics: [box.x, box.y, box.width, box.height],
              viewport: [rect.x, rect.y, rect.width, rect.height],
            };
          },
          { owner },
        );
        const actual = await sample(coordinates);
        console.log(JSON.stringify({ owner, scale, geometry, original, actual }));
        assert.equal(
          geometry.blocked,
          false,
          `${owner}/${scale}: supported SVG clipping must not suspend inversion`,
        );
        assert.deepEqual(
          actual[0],
          original[0],
          `${owner}/${scale}: navy protection must retain original pixels`,
        );
        assert.deepEqual(
          actual[1],
          original[1],
          `${owner}/${scale}: saturated protection must retain original pixels`,
        );
        assert.deepEqual(actual[4], original[4], `${owner}/${scale}: protection must reach its far corner`);
        for (const index of [5, 6])
          assert(
            actual[index].slice(0, 3).every((value) => value < 40),
            `${owner}/${scale}: outside mask edge must remain dark`,
          );
        assert(
          actual[2][0] < 40 && actual[2][1] < 40 && actual[2][2] < 40,
          `${owner}/${scale}: neighboring white graphics must become dark`,
        );
        if (owner === "outer")
          assert.deepEqual(actual[3], original[3], "Unselected workspace must remain original");
        await page.evaluate(() => {
          cutouts.clear();
          document.querySelector("[data-owner]").removeAttribute("data-owner");
        });
        assert.deepEqual(await sample(coordinates), original, "Cleanup restores every sampled pixel");
      }
    console.log("PASS: SVG clipping and sparse SVG owner pixels");

    // Native screenshots supply the edge oracle independently of mask arithmetic.
    await page.setContent(`<!doctype html><style>
    body{margin:0;background:#bbb}#owner{position:absolute;left:40.3px;top:30.7px;width:300.3px;height:200.9px;background:white}
    #inner{position:absolute;left:20.4px;top:20.2px;width:200.6px;height:120.4px;background:#061e47}
    [data-owner]{filter:invert(90%) hue-rotate(180deg)}
    [data-hdm-cutout]{filter:var(--hdm-cutout-filter)!important}
    </style><div id="owner"><div id="inner"></div></div>`);
    await page.addScriptTag({ content: source });
    const [left, top, right, bottom] = await page.evaluate(() => {
      const rect = document.getElementById("inner").getBoundingClientRect();
      return [rect.left, rect.top, rect.right, rect.bottom].map(Math.round);
    });
    const centerX = (left + right) >> 1,
      centerY = (top + bottom) >> 1;
    const inside = [
      [left, centerY],
      [right - 1, centerY],
      [centerX, top],
      [centerX, bottom - 1],
    ];
    const before = (edge) => (Math.floor(edge * ratio) - 1) / ratio;
    const after = (edge) => Math.ceil(edge * ratio) / ratio;
    const beside = [
      [before(left), centerY],
      [after(right), centerY],
      [centerX, before(top)],
      [centerX, after(bottom)],
    ];
    const painted = await sample(inside);
    assert.deepEqual(
      (await sample([[centerX, centerY]]))[0],
      [6, 30, 71, 255],
      "the native protected surface has its authored center color",
    );
    for (const pixel of painted)
      assert(
        pixel[0] < 255 && pixel[3] === 255,
        "fixture samples must touch the native protected edge, including antialiasing",
      );
    await page.evaluate(() => {
      const owner = document.getElementById("owner");
      owner.setAttribute("data-owner", "");
      HdmCutouts.create().paint(new Map([[owner, 90]]), [document.getElementById("inner")]);
    });
    assert.deepEqual(
      await sample(inside),
      painted,
      "every edge pixel of a fractional protected box keeps its original color",
    );
    for (const pixel of await sample(beside)) {
      assert(
        pixel.slice(0, 3).every((value) => value < 40),
        `no line of original colors may remain beside a fractional protected box: ${pixel}`,
      );
    }
    console.log(`PASS: fractional HTML box edges at DPR ${ratio}`);

    const storeImage = async (name) => {
      const encoded = (await page.screenshot()).toString("base64");
      await page.evaluate(
        async ({ name, encoded }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${encoded}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0);
          globalThis[name] = {
            width: image.width,
            pixels: context.getImageData(0, 0, image.width, image.height).data,
          };
        },
        { name, encoded },
      );
    };
    for (const scale of [1.25, 0.8])
      for (const translate of [0, 0.3]) {
        harness.deadline();
        await page.setContent(`<!doctype html><style>
      body{margin:0;background:#bbb}#owner{position:absolute;left:40.3px;top:30.7px;width:300.3px;height:200.9px;background:white;
      transform:translate(${translate}px,${translate}px) scale(${scale});transform-origin:top left}
      #inner{position:absolute;left:20.4px;top:20.2px;width:200.6px;height:120.4px;background:#061e47}
      [data-owner]{filter:invert(90%) hue-rotate(180deg)}[data-hdm-cutout]{filter:var(--hdm-cutout-filter)!important}
      </style><div id="owner"><div id="inner"></div></div>`);
        await page.addScriptTag({ content: source });
        await storeImage("originalPixels");
        await page.evaluate(() => {
          const owner = document.getElementById("owner");
          owner.setAttribute("data-owner", "");
          globalThis.transformedCutouts = HdmCutouts.create();
          transformedCutouts.paint(new Map([[owner, 90]]), [document.getElementById("inner")]);
        });
        await storeImage("protectedPixels");
        const result = await page.evaluate(() => {
          const { pixels: original, width } = originalPixels,
            actual = protectedPixels.pixels;
          let count = 0,
            changed = 0;
          for (let index = 0; index < original.length; index += 4) {
            if (original[index] !== 6 || original[index + 1] !== 30 || original[index + 2] !== 71) continue;
            count++;
            if (
              actual[index] !== original[index] ||
              actual[index + 1] !== original[index + 1] ||
              actual[index + 2] !== original[index + 2]
            )
              changed++;
          }
          return { count, changed, width, blocked: transformedCutouts.blocked() };
        });
        assert(result.count > 1000, "native paint must contain a substantial protected surface");
        assert.equal(result.blocked, false, "axis-aligned scaling remains supported");
        assert.equal(
          result.changed,
          0,
          `DPR ${ratio}, scale ${scale}, translation ${translate}: protected native pixels retain original colors`,
        );
      }
    console.log(`PASS: scaled HTML protection at DPR ${ratio}`);
  });
}
