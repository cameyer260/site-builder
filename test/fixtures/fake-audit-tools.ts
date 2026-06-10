import type { SiteInspector } from "../../src/audit/inspect.ts";
import type { LighthouseRunner } from "../../src/audit/lighthouse.ts";

/**
 * Offline stand-ins for `audit`'s two heavy seams. `fakeInspect` returns a small
 * inspection result without serving the Site or launching a browser;
 * `fakeLighthouse` returns a fixed Scorecard without launching Chrome. Both keep
 * the audit tests deterministic and free of real I/O.
 */

export const fakeInspect: SiteInspector = async () => ({
  pages: [{ url: "http://localhost/", slug: "index", screenshots: { desktop: [], mobile: [] } }],
  axe: [
    {
      url: "http://localhost/",
      slug: "index",
      violations: [
        {
          id: "color-contrast",
          impact: "serious",
          help: "Elements must have sufficient contrast",
          nodes: 1,
          sampleTarget: "p.muted",
        },
      ],
    },
  ],
  brokenRefs: [],
});

export const fakeLighthouse: LighthouseRunner = async () => ({
  url: "http://localhost/",
  generatedAt: new Date().toISOString(),
  results: [
    {
      formFactor: "mobile",
      scores: { performance: 96, accessibility: 100, bestPractices: 100, seo: 100 },
      metrics: { lcpMs: 1200, cls: 0.01, tbtMs: 50 },
    },
    {
      formFactor: "desktop",
      scores: { performance: 99, accessibility: 100, bestPractices: 100, seo: 100 },
      metrics: { lcpMs: 700, cls: 0, tbtMs: 10 },
    },
  ],
});
