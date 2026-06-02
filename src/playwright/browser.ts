import { type Browser, chromium, type LaunchOptions } from "playwright";

/**
 * Browser launch helper for the Playwright script (the tool's own code driving
 * Playwright — distinct from the Playwright MCP exposed to the engine). Used by
 * ingest (crawl + screenshots) and reused by audit.
 */
export async function launchBrowser(opts: LaunchOptions = {}): Promise<Browser> {
  return chromium.launch({ headless: true, ...opts });
}

/** Runs `fn` with a launched browser, always closing it afterwards. */
export async function withBrowser<T>(
  fn: (browser: Browser) => Promise<T>,
  opts: LaunchOptions = {},
): Promise<T> {
  const browser = await launchBrowser(opts);
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

/** A desktop Chrome UA so crawled sites serve their normal markup. */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
