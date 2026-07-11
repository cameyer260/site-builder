import type { Browser } from "playwright";
import { captureScreens, type ViewportProfile } from "../playwright/screenshot.ts";
import { walkSite } from "../playwright/walk.ts";
import type { Logger } from "../util/log.ts";
import { uniqueName } from "../util/names.ts";
import type { AssetSource } from "./assets.ts";
import { htmlToMarkdown } from "./markdown.ts";
import { isBlogUrl, isPageWorthy, normalizeUrl, pageSlug, sameOrigin } from "./url.ts";

/**
 * The Playwright crawl: sitemap-first discovery with an internal-link BFS
 * fallback, same-origin, capped at `pageCap`. The homepage is always crawled,
 * and core pages are prioritized over blog posts (of which at most a couple are
 * pulled) so the branded, high-value pages fill the budget. Each page is
 * rendered (so JS sites work), converted HTML→Markdown, screenshotted across all
 * Viewport Profiles, and has its `<img>`/`og:image`/favicon/logo Asset URLs
 * collected.
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

/**
 * Quiet period after `load` before capture. Longer than a bare paint because
 * theme headers (e.g. TheGem/WordPress) build their logo/nav in JS after `load`;
 * at a few hundred ms the logo `<img>` isn't in the DOM yet and asset collection
 * misses it.
 */
const SETTLE_MS = 1200;

/** Safety bound on child sitemaps fetched from a sitemap index. */
const MAX_CHILD_SITEMAPS = 50;

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

/**
 * Orders discovered page URLs against the crawl budget: all core (non-blog)
 * pages first, then at most `blogCap` blog posts, capped at `cap` total. Keeps
 * the branded, high-value pages from being crowded out by a long tail of blog
 * posts (which a sitemap often lists first).
 */
export function prioritizePages(urls: string[], cap: number, blogCap: number): string[] {
  const core: string[] = [];
  const blog: string[] = [];
  for (const url of urls) {
    (isBlogUrl(url) ? blog : core).push(url);
  }
  return [...core, ...blog.slice(0, blogCap)].slice(0, cap);
}

/**
 * Discovers page URLs from `/sitemap.xml` (handling sitemap indexes), then
 * prioritizes core pages over blog posts within `cap` (see `prioritizePages`).
 * Unlike a plain cap, this reads *all* child sitemaps so a `page-sitemap` listed
 * after `post-sitemap` still contributes its high-value pages.
 */
async function discoverFromSitemap(
  baseUrl: string,
  cap: number,
  blogCap: number,
): Promise<string[]> {
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
    for (const child of extractLocs(xml).slice(0, MAX_CHILD_SITEMAPS)) {
      const childXml = await fetchText(child);
      if (childXml) {
        locs.push(...extractLocs(childXml));
      }
    }
  } else {
    locs = extractLocs(xml);
  }

  const eligible: string[] = [];
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
      eligible.push(normalized);
    }
  }
  return prioritizePages(eligible, cap, blogCap);
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
  blogPageCap: number,
  log: Logger,
): Promise<CrawlResult> {
  const home = normalizeUrl(baseUrl, baseUrl) ?? baseUrl;
  const sitemapUrls = await discoverFromSitemap(baseUrl, pageCap, blogPageCap);
  const usingSitemap = sitemapUrls.length > 0;
  // Always crawl the homepage first: it carries the branded header/logo and
  // og:image that deep pages (blog posts) often omit, and it must not be crowded
  // out of the page budget. walkSite dedups, so a sitemap that also lists it is
  // fine; filtering just keeps the seed tidy.
  const seed = usingSitemap ? [home, ...sitemapUrls.filter((u) => u !== home)] : [home];

  const usedSlugs = new Set<string>();
  const pages: CrawledPage[] = [];
  // Link-BFS blog budget: distinct blog URLs we've queued to follow (the sitemap
  // path is already blog-capped by prioritizePages).
  const blogFollowed = new Set<string>();

  await walkSite({
    browser,
    baseUrl,
    profiles,
    seed,
    pageCap,
    navTimeoutMs: NAV_TIMEOUT_MS,
    settleMs: SETTLE_MS,
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
      const follow: string[] = [];
      for (const href of hrefs) {
        const candidate = normalizeUrl(href, finalUrl);
        if (!candidate) {
          continue;
        }
        // Cap blog posts so a large blog doesn't consume the page budget; core
        // pages are always followed.
        if (isBlogUrl(candidate) && !blogFollowed.has(candidate)) {
          if (blogFollowed.size >= blogPageCap) {
            continue;
          }
          blogFollowed.add(candidate);
        }
        follow.push(candidate);
      }
      return follow;
    },
  });

  const discovery: CrawlResult["discovery"] = usingSitemap
    ? "sitemap"
    : pages.length <= 1
      ? "single"
      : "links";
  return { baseUrl, discovery, pages };
}

/**
 * Pulls `<img>`, `og:image`, favicon, and logo Asset URLs from the rendered
 * page. Beyond `document.images`, it harvests logos rendered as CSS
 * `background-image` on logo-ish containers (which `document.images` can't see),
 * so a brand mark isn't missed when a theme paints it as a background.
 */
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
    // Logos painted as CSS background-image (e.g. `.custom-logo`, header brand
    // marks) rather than <img>: harvest the url() off logo-ish containers.
    for (const el of Array.from(
      document.querySelectorAll('[class*="logo" i], [id*="logo" i], .custom-logo, header .brand'),
    )) {
      const bg = getComputedStyle(el).backgroundImage;
      const match = bg?.match(/url\((?:"|')?([^"')]+)(?:"|')?\)/i);
      if (match?.[1]) {
        found.push({ url: match[1], kind: "img" });
      }
    }
    const og = document.querySelector('meta[property="og:image"]')?.getAttribute("content");
    if (og) {
      found.push({ url: og, kind: "og" });
    }
    for (const link of Array.from(
      document.querySelectorAll(
        'link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]',
      ),
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
