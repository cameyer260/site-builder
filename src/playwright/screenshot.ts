import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { Viewports } from "../config/schema.ts";

/**
 * A named browser size the screenshot component renders at (CONTEXT.md >
 * Viewport Profile). Capture happens at the page context's deviceScaleFactor,
 * which the tool sets to 1 — i.e. native, 1 CSS px = 1 device px. Per-profile
 * scale factors would need separate contexts (deferred; see roadmap).
 */
export interface ViewportProfile {
  name: string;
  width: number;
  height: number;
}

/** The v1 profiles: desktop 1440 + mobile 390 by default, both configurable. */
export function profilesFromConfig(viewports: Viewports): ViewportProfile[] {
  return [
    { name: "desktop", width: viewports.desktop, height: 900 },
    { name: "mobile", width: viewports.mobile, height: 844 },
  ];
}

export interface CaptureOptions {
  profiles: ViewportProfile[];
  /** Base directory; segments are written under `<outDir>/<profile>/`. */
  outDir: string;
  /** Filename stem for this page's segments (e.g. the page slug). */
  baseName: string;
  /** Cap on segments per profile, to bound pathologically long pages. */
  maxSegments?: number;
}

/**
 * The reusable screenshot component. For each Viewport Profile it resizes the
 * page and captures screen-by-screen segments down the full page height,
 * returning the written file paths per profile. The caller must navigate the
 * page first; ingest uses this now and audit reuses it later.
 */
export async function captureScreens(
  page: Page,
  opts: CaptureOptions,
): Promise<Record<string, string[]>> {
  const maxSegments = opts.maxSegments ?? 12;
  const result: Record<string, string[]> = {};

  for (const profile of opts.profiles) {
    await page.setViewportSize({ width: profile.width, height: profile.height });
    await page.waitForTimeout(150); // let reflow + lazy content settle

    const totalHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const segments = Math.max(1, Math.min(maxSegments, Math.ceil(totalHeight / profile.height)));

    const dir = join(opts.outDir, profile.name);
    mkdirSync(dir, { recursive: true });

    const paths: string[] = [];
    for (let i = 0; i < segments; i++) {
      await page.evaluate((top) => window.scrollTo(0, top), i * profile.height);
      await page.waitForTimeout(80);
      const file = join(dir, `${opts.baseName}-${String(i + 1).padStart(2, "0")}.png`);
      await page.screenshot({ path: file });
      paths.push(file);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    result[profile.name] = paths;
  }

  return result;
}
