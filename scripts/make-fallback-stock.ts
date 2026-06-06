/**
 * Dev-only generator for the Fallback Asset stock pack
 * (`assets/fallbacks/stock/*.jpg`). These tasteful abstract gradients stand in
 * for Pexels photography when no API key is configured or a fetch fails, so a
 * generated Site still compiles and looks intentional offline (CONTEXT.md >
 * Image sourcing, tier 3). Run once and commit the output:
 *
 *   bun run scripts/make-fallback-stock.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withBrowser } from "../src/playwright/browser.ts";

const OUT_DIR = fileURLToPath(new URL("../assets/fallbacks/stock", import.meta.url));

interface Variant {
  name: string;
  width: number;
  height: number;
  /** Two diagonal gradient stops + two soft blobs, in CSS color syntax. */
  a: string;
  b: string;
  blob1: string;
  blob2: string;
}

const VARIANTS: Variant[] = [
  {
    name: "landscape",
    width: 1600,
    height: 900,
    a: "oklch(0.55 0.16 264)",
    b: "oklch(0.32 0.12 286)",
    blob1: "oklch(0.7 0.15 230)",
    blob2: "oklch(0.6 0.18 320)",
  },
  {
    name: "portrait",
    width: 900,
    height: 1200,
    a: "oklch(0.5 0.14 200)",
    b: "oklch(0.3 0.1 250)",
    blob1: "oklch(0.68 0.14 180)",
    blob2: "oklch(0.62 0.16 280)",
  },
  {
    name: "square",
    width: 1200,
    height: 1200,
    a: "oklch(0.52 0.15 150)",
    b: "oklch(0.3 0.12 210)",
    blob1: "oklch(0.7 0.15 130)",
    blob2: "oklch(0.6 0.16 250)",
  },
];

function html(v: Variant): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${v.width}px;height:${v.height}px;overflow:hidden}
    .bg{position:absolute;inset:0;background:linear-gradient(135deg,${v.a},${v.b})}
    .blob{position:absolute;border-radius:50%;filter:blur(80px);opacity:.55;mix-blend-mode:screen}
    .b1{width:55%;aspect-ratio:1;background:${v.blob1};top:-10%;left:-8%}
    .b2{width:60%;aspect-ratio:1;background:${v.blob2};bottom:-15%;right:-10%}
    .grain{position:absolute;inset:0;opacity:.06;
      background-image:radial-gradient(rgba(255,255,255,.9) 1px,transparent 1px);
      background-size:4px 4px}
  </style></head><body>
    <div class="bg"></div><div class="blob b1"></div><div class="blob b2"></div>
    <div class="grain"></div>
  </body></html>`;
}

await withBrowser(async (browser) => {
  mkdirSync(OUT_DIR, { recursive: true });
  const page = await browser.newPage();
  for (const v of VARIANTS) {
    await page.setViewportSize({ width: v.width, height: v.height });
    await page.setContent(html(v), { waitUntil: "load" });
    const buffer = await page.screenshot({ type: "jpeg", quality: 82 });
    const out = `${OUT_DIR}/${v.name}.jpg`;
    writeFileSync(out, buffer);
    console.log(`wrote ${out} (${v.width}x${v.height}, ${buffer.length} bytes)`);
  }
  await page.close();
});
