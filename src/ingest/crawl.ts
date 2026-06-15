import type { Browser } from "playwright";
import { captureScreens, type ViewportProfile } from "../playwright/screenshot.ts";
import { walkSite } from "../playwright/walk.ts";
import type { Logger } from "../util/log.ts";
import { uniqueName } from "../util/names.ts";
import type { AssetSource } from "./assets.ts";
import { htmlToMarkdown } from "./markdown.ts";
import { isPageWorthy, normalizeUrl, pageSlug, sameOrigin } from "./url.ts";

/**
 * The Playwright crawl: sitemap-first discovery with an internal-link BFS
 * fallback, same-origin, capped at `pageCap`. Each page is rendered (so JS
 * sites work), converted HTML→Markdown, screenshotted across all Viewport
 * Profiles, and has its `<img>`/`og:image`/favicon Asset URLs collected.
 */

export interface CrawledPage {
  url: string;
  slug: string;
  title: string;
  markdown: string;
  screenshots: Record<string, string[]>;
  assets: AssetSource[];
}

export interface CrawlResult {
  baseUrl: string;
  discovery: "sitemap" | "links" | "single";
  pages: CrawledPage[];
}

const NAV_TIMEOUT_MS = 30_000;

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1] as string);
}

/** Discovers up to `cap` page URLs from `/sitemap.xml` (handles sitemap indexes). */
async function discoverFromSitemap(baseUrl: string, cap: number): Promise<string[]> {
  const sitemapUrl = normalizeUrl("/sitemap.xml", baseUrl);
  if (!sitemapUrl) {
    return [];
  }
  const xml = await fetchText(sitemapUrl);
  if (!xml) {
    return [];
  }

  let locs: string[];
  if (/<sitemapindex/i.test(xml)) {
    locs = [];
    for (const child of extractLocs(xml)) {
      if (locs.length >= cap) {
        break;
      }
      const childXml = await fetchText(child);
      if (childXml) {
        locs.push(...extractLocs(childXml));
      }
    }
  } else {
    locs = extractLocs(xml);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const loc of locs) {
    const normalized = normalizeUrl(loc, baseUrl);
    if (
      normalized &&
      sameOrigin(normalized, baseUrl) &&
      isPageWorthy(normalized) &&
      !seen.has(normalized)
    ) {
      seen.add(normalized);
      out.push(normalized);
      if (out.length >= cap) {
        break;
      }
    }
  }
  return out;
}

interface RawAsset {
  url: string;
  kind: AssetSource["kind"];
}

export async function crawlSite(
  browser: Browser,
  baseUrl: string,
  profiles: ViewportProfile[],
  screenshotDir: string,
  pageCap: number,
  log: Logger,
): Promise<CrawlResult> {
  const sitemapUrls = await discoverFromSitemap(baseUrl, pageCap);
  const usingSitemap = sitemapUrls.length > 0;
  const seed = usingSitemap ? sitemapUrls : [normalizeUrl(baseUrl, baseUrl) ?? baseUrl];

  const usedSlugs = new Set<string>();
  const pages: CrawledPage[] = [];

  await walkSite({
    browser,
    baseUrl,
    profiles,
    seed,
    pageCap,
    navTimeoutMs: NAV_TIMEOUT_MS,
    settleMs: 300,
    onLoadError: (url) => log.warn(`ingest: could not load ${url}`),
    visit: async ({ page, url }) => {
      const finalUrl = page.url();
      const title = await page.title();
      const markdown = htmlToMarkdown(await page.content());
      const assets = await collectAssets(page, finalUrl);

      const slug = uniqueName(pageSlug(url), usedSlugs);

      const screenshots = await captureScreens(page, {
        profiles,
        outDir: screenshotDir,
        baseName: slug,
      });
      pages.push({ url, slug, title, markdown, screenshots, assets });
      log.step(`ingest: captured ${url} (${assets.length} asset ref(s))`);

      // Sitemap-discovered crawls don't follow links; link-BFS crawls do.
      if (usingSitemap) {
        return [];
      }
      const hrefs = await page.$$eval("a[href]", (els) =>
        els.map((el) => (el as HTMLAnchorElement).href),
      );
      return hrefs
        .map((href) => normalizeUrl(href, finalUrl))
        .filter((u): u is string => u !== null);
    },
  });

  const discovery: CrawlResult["discovery"] = usingSitemap
    ? "sitemap"
    : pages.length <= 1
      ? "single"
      : "links";
  return { baseUrl, discovery, pages };
}

/** Pulls `<img>`, `og:image`, and favicon Asset URLs from the rendered page. */
async function collectAssets(
  page: Awaited<ReturnType<Browser["newPage"]>>,
  pageUrl: string,
): Promise<AssetSource[]> {
  const raw: RawAsset[] = await page.evaluate(() => {
    const found: { url: string; kind: "img" | "og" | "favicon" }[] = [];
    for (const img of Array.from(document.images)) {
      const src = img.currentSrc || img.src;
      if (src) {
        found.push({ url: src, kind: "img" });
      }
    }
    const og = document.querySelector('meta[property="og:image"]')?.getAttribute("content");
    if (og) {
      found.push({ url: og, kind: "og" });
    }
    for (const link of Array.from(
      document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]'),
    )) {
      const href = link.getAttribute("href");
      if (href) {
        found.push({ url: href, kind: "favicon" });
      }
    }
    return found;
  });

  const out: AssetSource[] = [];
  const seen = new Set<string>();
  for (const asset of raw) {
    const abs = normalizeUrl(asset.url, pageUrl);
    if (abs && !seen.has(abs)) {
      seen.add(abs);
      out.push({ url: abs, kind: asset.kind });
    }
  }
  return out;
}
