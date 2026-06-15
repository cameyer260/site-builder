import { chromium } from "playwright";
import { withPreview } from "../astro/preview.ts";
import type { Logger } from "../util/log.ts";
import { nowIso } from "../util/time.ts";

/**
 * The **Scorecard** (CONTEXT.md, ADR-0007): after `audit`'s single fix pass +
 * `astro build` re-gate, Lighthouse runs once per form factor (its own mobile +
 * desktop presets) on the homepage to record the *achieved* Performance,
 * Accessibility, Best Practices, and SEO scores. It is **non-gating** evidence —
 * a low score is persisted and surfaced to the client, never failing the stage.
 *
 * The container has no system Chrome, so Lighthouse drives the Playwright
 * Chromium via `chrome-launcher` with `--no-sandbox --headless=new` (non-root).
 * `lighthouse` + `chrome-launcher` are dynamically imported so they only load
 * when the Scorecard actually runs.
 */

export type FormFactor = "mobile" | "desktop";

export interface CategoryScores {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
}

export interface FormFactorScore {
  formFactor: FormFactor;
  scores: CategoryScores;
  /** Headline lab metrics, useful when a Performance score regresses. */
  metrics: { lcpMs: number | null; cls: number | null; tbtMs: number | null };
}

export interface Scorecard {
  /** Homepage URL that was measured. */
  url: string;
  generatedAt: string;
  results: FormFactorScore[];
}

export interface LighthouseParams {
  siteDir: string;
  log: Logger;
}

/**
 * The injectable shape the `audit` stage accepts so tests can stub the whole
 * Lighthouse run (preview + Chrome + lighthouse) in one seam. Defaults to
 * {@link runLighthouseScorecard}.
 */
export type LighthouseRunner = (params: LighthouseParams) => Promise<Scorecard>;

const FORM_FACTORS: readonly FormFactor[] = ["mobile", "desktop"];
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"] as const;
const CHROME_FLAGS = ["--no-sandbox", "--headless=new", "--disable-gpu", "--disable-dev-shm-usage"];

/** Lighthouse's own desktop preset (mobile is the default, no overrides needed). */
const DESKTOP_SETTINGS = {
  formFactor: "desktop" as const,
  screenEmulation: {
    mobile: false,
    width: 1350,
    height: 940,
    deviceScaleFactor: 1,
    disabled: false,
  },
  throttling: {
    rttMs: 40,
    throughputKbps: 10_240,
    cpuSlowdownMultiplier: 1,
    requestLatencyMs: 0,
    downloadThroughputKbps: 0,
    uploadThroughputKbps: 0,
  },
};

/** Minimal slice of the Lighthouse result (`lhr`) we read scores/metrics from. */
interface Lhr {
  categories?: Record<string, { score?: number | null } | undefined>;
  audits?: Record<string, { numericValue?: number } | undefined>;
}

/** The real Scorecard runner: serve the built Site, then measure each form factor. */
export const runLighthouseScorecard: LighthouseRunner = ({ siteDir, log }) => {
  return withPreview(
    siteDir,
    async (preview) => {
      const url = `${preview.url}/`;
      const { launch } = await import("chrome-launcher");
      // The shipped lighthouse default-export type resolves oddly under Bun's
      // module resolution; pin the slice of its signature we use.
      const lighthouse = (await import("lighthouse")).default as unknown as (
        url: string,
        flags?: Record<string, unknown>,
      ) => Promise<{ lhr: Lhr } | undefined>;

      const chrome = await launch({
        chromePath: chromium.executablePath(),
        chromeFlags: CHROME_FLAGS,
      });
      const results: FormFactorScore[] = [];
      try {
        for (const formFactor of FORM_FACTORS) {
          log.step(`audit: running Lighthouse (${formFactor})`);
          try {
            const settings = formFactor === "desktop" ? DESKTOP_SETTINGS : { formFactor };
            const run = await lighthouse(url, {
              port: chrome.port,
              output: "json",
              logLevel: "error",
              onlyCategories: [...CATEGORIES],
              ...settings,
            });
            results.push(scoreFrom(formFactor, run?.lhr));
          } catch (err) {
            log.warn(`audit: Lighthouse ${formFactor} run failed: ${message(err)}`);
            results.push(emptyScore(formFactor));
          }
        }
      } finally {
        chrome.kill();
      }
      return { url, generatedAt: nowIso(), results };
    },
    log,
  );
};

function scoreFrom(formFactor: FormFactor, lhr: Lhr | undefined): FormFactorScore {
  if (!lhr) {
    return emptyScore(formFactor);
  }
  const category = (id: string): number | null => {
    const score = lhr.categories?.[id]?.score;
    return typeof score === "number" ? Math.round(score * 100) : null;
  };
  const numeric = (id: string): number | null => {
    const value = lhr.audits?.[id]?.numericValue;
    return typeof value === "number" ? Math.round(value) : null;
  };
  const clsRaw = lhr.audits?.["cumulative-layout-shift"]?.numericValue;
  return {
    formFactor,
    scores: {
      performance: category("performance"),
      accessibility: category("accessibility"),
      bestPractices: category("best-practices"),
      seo: category("seo"),
    },
    metrics: {
      lcpMs: numeric("largest-contentful-paint"),
      cls: typeof clsRaw === "number" ? Math.round(clsRaw * 1000) / 1000 : null,
      tbtMs: numeric("total-blocking-time"),
    },
  };
}

function emptyScore(formFactor: FormFactor): FormFactorScore {
  return {
    formFactor,
    scores: { performance: null, accessibility: null, bestPractices: null, seo: null },
    metrics: { lcpMs: null, cls: null, tbtMs: null },
  };
}

const cell = (n: number | null): string => (n === null ? "—" : String(n));
const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Renders the Scorecard as the Markdown table `audit.md` is prefixed with. */
export function renderScorecardTable(scorecard: Scorecard): string {
  const lines = [
    "## Lighthouse Scorecard",
    "",
    "Achieved scores after the audit fix pass (non-gating evidence, not a promise of perfect 100s).",
    "",
    "| Form factor | Performance | Accessibility | Best Practices | SEO |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const r of scorecard.results) {
    lines.push(
      `| ${titleCase(r.formFactor)} | ${cell(r.scores.performance)} | ${cell(r.scores.accessibility)} | ${cell(r.scores.bestPractices)} | ${cell(r.scores.seo)} |`,
    );
  }
  lines.push("", "Core metrics (lab):", "");
  for (const r of scorecard.results) {
    lines.push(
      `- **${titleCase(r.formFactor)}** — LCP ${cell(r.metrics.lcpMs)}ms · CLS ${r.metrics.cls ?? "—"} · TBT ${cell(r.metrics.tbtMs)}ms`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
