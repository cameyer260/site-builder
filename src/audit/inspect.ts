import { join, relative } from "node:path";
import axe from "axe-core";
import type { Browser, Page } from "playwright";
import { withPreview } from "../astro/preview.ts";
import { isPageWorthy, normalizeUrl, pageSlug, sameOrigin } from "../ingest/url.ts";
import { withBrowser } from "../playwright/browser.ts";
import { captureScreens, type ViewportProfile } from "../playwright/screenshot.ts";
import { walkSite } from "../playwright/walk.ts";
import type { Logger } from "../util/log.ts";
import { uniqueName } from "../util/names.ts";

/**
 * The deterministic fix-drivers `audit` feeds into the AI review (CONTEXT.md >
 * audit): it serves the built Site (`astro preview`), then in one Playwright
 * pass over a bounded set of pages captures native-resolution screenshots per
 * Viewport Profile (reusing the ingest screenshot component), runs **axe-core**
 * for accessibility violations, and collects every internal link/asset to
 * status-check for broken references. Pure code — the findings are evidence the
 * review reads, not a gate.
 */

const AXE_SOURCE = (axe as unknown as { source: string }).source;
const NAV_TIMEOUT_MS = 20_000;
const REF_TIMEOUT_MS = 8000;

export interface AxeViolation {
  /** axe rule id, e.g. `color-contrast`, `image-alt`. */
  id: string;
  impact: string | null;
  help: string;
  /** Number of DOM nodes failing this rule on the page. */
  nodes: number;
  /** A selector for the first failing node, to orient the fixer. */
  sampleTarget?: string;
}

export interface PageAxe {
  url: string;
  slug: string;
  violations: AxeViolation[];
}

export interface BrokenRef {
  url: string;
  /** HTTP status, or null when the request itself failed (network error). */
  status: number | null;
  kind: "page" | "asset";
  /** The page the reference was found on. */
  foundOn: string;
}

export interface InspectedPage {
  url: string;
  slug: string;
  /** Screenshot paths per Viewport Profile, relative to the audit dir. */
  screenshots: Record<string, string[]>;
}

export interface InspectResult {
  pages: InspectedPage[];
  axe: PageAxe[];
  brokenRefs: BrokenRef[];
}

export interface InspectParams {
  siteDir: string;
  profiles: ViewportProfile[];
  /** Screenshots are written under `<auditDir>/screenshots/<profile>/`. */
  auditDir: string;
  /** Cap on pages crawled from the homepage, to bound cost. */
  pageCap: number;
  log: Logger;
}

/**
 * The injectable shape the `audit` stage accepts so tests can stub the whole
 * preview + browser + Lighthouse-free inspection in one seam (mirroring how
 * `generate` injects its compile gate). Defaults to {@link inspectBuiltSite}.
 */
export type SiteInspector = (params: InspectParams) => Promise<InspectResult>;

/** The real inspector: serve the build, then browse + scan it. */
export const inspectBuiltSite: SiteInspector = (params) => {
  return withPreview(params.siteDir, (preview) => browseAndScan(preview.url, params), params.log);
};

/**
 * The browser half of the inspector: a bounded same-origin crawl from `baseUrl`
 * that runs axe-core, collects references, and screenshots each page. Exported so
 * the real-Chromium inspect test can drive it against a `Bun.serve` fixture
 * without standing up an `astro preview`.
 */
export async function browseAndScan(
  baseUrl: string,
  params: InspectParams,
): Promise<InspectResult> {
  const { profiles, auditDir, pageCap, log } = params;
  const screenshotsDir = join(auditDir, "screenshots");
  const start = normalizeUrl(baseUrl, baseUrl) ?? baseUrl;

  const usedSlugs = new Set<string>();
  const pages: InspectedPage[] = [];
  const axeResults: PageAxe[] = [];
  /** Unique references collected across pages, with where each was first seen. */
  const refs = new Map<string, { kind: "page" | "asset"; foundOn: string }>();

  return withBrowser(async (browser: Browser) => {
    await walkSite({
      browser,
      baseUrl,
      profiles,
      seed: [start],
      pageCap,
      navTimeoutMs: NAV_TIMEOUT_MS,
      settleMs: 200,
      onLoadError: (url) => log.warn(`audit: could not load ${url}`),
      visit: async ({ page, url }) => {
        const slug = uniqueName(pageSlug(url), usedSlugs);

        // Accessibility scan at the primary (desktop) viewport, before screenshots
        // resize the page.
        const violations = await runAxe(page);
        axeResults.push({ url, slug, violations });

        // Collect links/assets; same-origin pages are returned for the bounded crawl.
        const next: string[] = [];
        for (const ref of await collectRefs(page, url)) {
          if (!refs.has(ref.url)) {
            refs.set(ref.url, { kind: ref.kind, foundOn: url });
          }
          if (ref.kind === "page") {
            next.push(ref.url);
          }
        }

        const screenshots = await captureScreens(page, {
          profiles,
          outDir: screenshotsDir,
          baseName: slug,
        });
        pages.push({ url, slug, screenshots: relativize(screenshots, auditDir) });
        log.step(`audit: inspected ${url} (${violations.length} a11y rule(s) failing)`);
        return next;
      },
    });

    const brokenRefs = await checkRefs(refs, baseUrl);
    return { pages, axe: axeResults, brokenRefs };
  });
}

/** Injects axe-core into the loaded page and returns its violations (compactly). */
async function runAxe(page: Page): Promise<AxeViolation[]> {
  try {
    await page.addScriptTag({ content: AXE_SOURCE });
    return (await page.evaluate(async () => {
      const runner = (
        globalThis as unknown as { axe: { run: (...a: unknown[]) => Promise<unknown> } }
      ).axe;
      const result = (await runner.run(document, { resultTypes: ["violations"] })) as {
        violations: {
          id: string;
          impact: string | null;
          help: string;
          nodes: { target: string[] }[];
        }[];
      };
      return result.violations.map((v) => ({
        id: v.id,
        impact: v.impact ?? null,
        help: v.help,
        nodes: v.nodes.length,
        sampleTarget: v.nodes[0]?.target?.join(" "),
      }));
    })) as AxeViolation[];
  } catch {
    // axe failing to run is non-fatal — the review still has screenshots + source.
    return [];
  }
}

/** Reads the page's anchors, images, scripts, and links as resolved references. */
async function collectRefs(
  page: Page,
  pageUrl: string,
): Promise<{ url: string; kind: "page" | "asset" }[]> {
  const raw = await page.evaluate(() => {
    const found: { href: string; kind: "page" | "asset" }[] = [];
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      const href = a.getAttribute("href");
      if (href) {
        found.push({ href, kind: "page" });
      }
    }
    for (const el of Array.from(document.querySelectorAll("img[src], script[src], link[href]"))) {
      const src = el.getAttribute("src") ?? el.getAttribute("href");
      if (src) {
        found.push({ href: src, kind: "asset" });
      }
    }
    return found;
  });

  const seen = new Set<string>();
  const out: { url: string; kind: "page" | "asset" }[] = [];
  for (const ref of raw) {
    const abs = normalizeUrl(ref.href, pageUrl);
    if (!abs || seen.has(abs)) {
      continue;
    }
    seen.add(abs);
    // A page-worthy anchor is a page; everything else (and explicit assets) is an asset.
    const kind = ref.kind === "page" && isPageWorthy(abs) ? "page" : "asset";
    out.push({ url: abs, kind });
  }
  return out;
}

/** Status-checks every same-origin reference; cross-origin links are left alone. */
async function checkRefs(
  refs: Map<string, { kind: "page" | "asset"; foundOn: string }>,
  baseUrl: string,
): Promise<BrokenRef[]> {
  const broken: BrokenRef[] = [];
  for (const [url, meta] of refs) {
    if (!sameOrigin(url, baseUrl)) {
      continue;
    }
    let status: number | null = null;
    try {
      let res = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(REF_TIMEOUT_MS),
      });
      if (res.status === 405 || res.status === 501) {
        // The static server may not implement HEAD; fall back to GET.
        res = await fetch(url, {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(REF_TIMEOUT_MS),
        });
      }
      status = res.status;
    } catch {
      status = null;
    }
    if (status === null || status >= 400) {
      broken.push({ url, status, kind: meta.kind, foundOn: meta.foundOn });
    }
  }
  return broken;
}

/** Rewrites the captured screenshot paths relative to the audit dir. */
function relativize(
  screenshots: Record<string, string[]>,
  baseDir: string,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [profile, files] of Object.entries(screenshots)) {
    out[profile] = files.map((f) => relative(baseDir, f));
  }
  return out;
}
