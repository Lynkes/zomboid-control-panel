// Renders the Workshop art into the three committed images: preview.png
// (512, Steam page) and poster.png (256, in-game mod list) from
// pz-mod/workshop/art/bridge.svg, and icon.png (32, mod list rows) from the
// simplified pz-mod/workshop/art/bridge-icon.svg -- the full console art
// turns to mush at 32 px. Both SVGs come from scripts/workshop/generate-art.mjs,
// and this command regenerates them first:
//
//   npm run workshop:art
//
// It needs Playwright's Chromium (npx playwright install chromium). The build
// never renders; it only validates the committed PNGs, so CI and release.ps1
// don't need a browser.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { IMAGE_RULES, REPO_ROOT, imageErrors, isMainModule } from "./lib.mjs";

const ART_SVG = "pz-mod/workshop/art/bridge.svg";
const ICON_SVG = "pz-mod/workshop/art/bridge-icon.svg";
const TARGETS = [
  { file: IMAGE_RULES.preview.file, source: ART_SVG, size: 512, sizes: IMAGE_RULES.preview.sizes },
  { file: IMAGE_RULES.poster.file, source: ART_SVG, size: 256, sizes: IMAGE_RULES.poster.sizes },
  { file: IMAGE_RULES.icon.file, source: ICON_SVG, size: 32, sizes: IMAGE_RULES.icon.sizes },
];

export async function renderArt({ repoRoot = REPO_ROOT, log = console.log } = {}) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    for (const target of TARGETS) {
      const svg = fs.readFileSync(path.join(repoRoot, target.source));
      const dataUrl = `data:image/svg+xml;base64,${svg.toString("base64")}`;
      const page = await browser.newPage({
        viewport: { width: target.size, height: target.size },
        deviceScaleFactor: 1,
      });
      // An <img> of the exact pixel size lets Chromium rasterise the vector
      // art at that size (crisper at 32 px than downscaling the 512 render).
      await page.setContent(
        `<!doctype html><html><body style="margin:0;background:transparent">` +
          `<img src="${dataUrl}" width="${target.size}" height="${target.size}" style="display:block"></body></html>`,
      );
      await page.locator("img").evaluate((img) => img.decode());
      const png = await page.screenshot({
        type: "png",
        omitBackground: true,
        clip: { x: 0, y: 0, width: target.size, height: target.size },
      });
      await page.close();
      const errors = imageErrors(target.file, png, target.sizes);
      if (errors.length) throw new Error(errors.join("\n"));
      fs.writeFileSync(path.join(repoRoot, target.file), png);
      log(`Wrote ${target.file} (${target.size}x${target.size}, ${png.length} bytes)`);
    }
  } finally {
    await browser.close();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await renderArt();
  } catch (error) {
    console.error(`Rendering the Workshop art failed: ${error.message}`);
    process.exitCode = 1;
  }
}
