import type { Browser, Page } from "playwright";
import { isPageWorthy, sameOrigin } from "../ingest/url.ts";
import { DEFAULT_USER_AGENT } from "./browser.ts";
import type { ViewportProfile } from "./screenshot.ts";

/**
 * The shared Playwright crawl skeleton behind `ingest` (crawl.ts) and `audit`
 * (inspect.ts): it opens one browser context at the primary Viewport Profile and
 * runs a same-origin breadth-first walk bounded by `pageCap`, delegating per-page
 * work and link discovery to `visit`. A behavior-preserving extraction of the two
 * stages' identical BFS frames (ADR-0009); their differences (nav timeout, settle
 * time, load-failure log text, and what each page actually does) are parameters.
 */

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

export interface WalkPage {
  /** The live page, navigated to `url` and settled. */
  page: Page;
  /** The URL pulled from the queue (before any redirect). */
  url: string;
}

export interface WalkOptions {
  browser: Browser;
  /** Same-origin guard for link-following. */
  baseUrl: string;
  /** Viewport Profiles; the first sets the crawl context viewport. */
  profiles: ViewportProfile[];
  /** Initial queue — sitemap URLs, or just the homepage. */
  seed: string[];
  /** Cap on the number of successfully visited pages. */
  pageCap: number;
  navTimeoutMs: number;
  /** Quiet period after `load`, mirroring each stage's existing settle. */
  settleMs: number;
  /** Invoked (to warn) when a page fails to load. */
  onLoadError: (url: string) => void;
  /**
   * Per-page work, run after load + settle. Returns candidate URLs discovered on
   * the page to follow; the walker applies the same-origin / page-worthy /
   * already-visited / already-queued de-duplication, so return raw normalized
   * hrefs (or `[]` to follow nothing).
   */
  visit: (walked: WalkPage) => Promise<string[]>;
}

export async function walkSite(opts: WalkOptions): Promise<void> {
  const { browser, baseUrl, profiles, seed, pageCap, navTimeoutMs, settleMs, onLoadError, visit } =
    opts;
  const primary = profiles[0];
  const context = await browser.newContext({
    viewport: primary ? { width: primary.width, height: primary.height } : DEFAULT_VIEWPORT,
    deviceScaleFactor: 1,
    userAgent: DEFAULT_USER_AGENT,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(navTimeoutMs);

  const queue = [...seed];
  const visited = new Set<string>();
  let processed = 0;

  try {
    while (queue.length > 0 && processed < pageCap) {
      const url = queue.shift() as string;
      if (visited.has(url)) {
        continue;
      }
      visited.add(url);

      try {
        await page.goto(url, { waitUntil: "load", timeout: navTimeoutMs });
      } catch {
        onLoadError(url);
        continue;
      }
      await page.waitForTimeout(settleMs);

      for (const candidate of await visit({ page, url })) {
        if (
          sameOrigin(candidate, baseUrl) &&
          isPageWorthy(candidate) &&
          !visited.has(candidate) &&
          !queue.includes(candidate)
        ) {
          queue.push(candidate);
        }
      }
      processed += 1;
    }
  } finally {
    await context.close();
  }
}
