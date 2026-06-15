import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { browseAndScan } from "../src/audit/inspect.ts";
import { DEFAULTS } from "../src/config/schema.ts";
import { profilesFromConfig } from "../src/playwright/screenshot.ts";
import { createLogger } from "../src/util/log.ts";

// A 1x1 PNG for the (valid) image route.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      switch (pathname) {
        // Homepage: an alt-less <img> (axe violation), a real link, a broken page
        // link, and a broken asset (both 404 -> broken refs).
        case "/":
          return html(
            "<!doctype html><html><head><title>Home</title></head><body>" +
              '<h1>Home</h1><img src="/logo.png">' +
              '<a href="/about">About</a> <a href="/missing">Missing</a>' +
              '<img src="/broken.png" alt="broken">' +
              "</body></html>",
          );
        case "/about":
          return html(
            "<!doctype html><html><head><title>About</title></head><body>" +
              '<h1>About</h1><img src="/logo.png" alt="logo"></body></html>',
          );
        case "/logo.png":
          return new Response(PNG, { headers: { "content-type": "image/png" } });
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function html(markup: string): Response {
  return new Response(markup, { headers: { "content-type": "text/html" } });
}

// Browser-dependent: skip cleanly where chromium isn't installed.
const browserAvailable = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

test.skipIf(!browserAvailable)(
  "browses a site: screenshots per profile, axe violations, and broken refs",
  async () => {
    const auditDir = mkdtempSync(join(tmpdir(), "sb-inspect-"));
    try {
      const result = await browseAndScan(base, {
        siteDir: auditDir,
        profiles: profilesFromConfig(DEFAULTS.viewports),
        auditDir,
        pageCap: 5,
        log: createLogger({ quiet: true }),
      });

      // The same-origin BFS reaches the homepage + /about, each screenshotted.
      expect(result.pages.length).toBeGreaterThanOrEqual(2);
      for (const page of result.pages) {
        const shots = Object.values(page.screenshots).flat();
        expect(shots.length).toBeGreaterThanOrEqual(1);
        expect(existsSync(join(auditDir, shots[0] as string))).toBe(true);
      }

      // axe ran and flagged at least the alt-less homepage image.
      const totalViolations = result.axe.reduce((n, p) => n + p.violations.length, 0);
      expect(totalViolations).toBeGreaterThanOrEqual(1);

      // The 404 page link and 404 asset are reported as broken references.
      expect(result.brokenRefs.length).toBeGreaterThanOrEqual(1);
      expect(result.brokenRefs.some((r) => r.status === 404)).toBe(true);
    } finally {
      rmSync(auditDir, { recursive: true, force: true });
    }
  },
  60_000,
);
