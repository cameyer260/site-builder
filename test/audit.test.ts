import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../src/astro/run.ts";
import { runAudit } from "../src/audit/audit.ts";
import { renderScorecardTable, type Scorecard } from "../src/audit/lighthouse.ts";
import { type Config, DEFAULTS } from "../src/config/schema.ts";
import { newClient } from "../src/storage/client.ts";
import { clientPaths } from "../src/storage/layout.ts";
import { createLogger } from "../src/util/log.ts";
import { fakeAuditEngine } from "./fixtures/fake-audit-engine.ts";
import { fakeInspect, fakeLighthouse } from "./fixtures/fake-audit-tools.ts";

const log = createLogger({ quiet: true });
const config = { ...DEFAULTS, root: "/unused" } as Config;
const client = newClient("Tailored Co.", { docs: [], images: [], notes: "n" });

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sb-audit-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A compile gate that mimics `astro build` emitting a dist/. */
function fakeBuild(onCall?: () => void) {
  return async (siteDir: string): Promise<CommandResult> => {
    onCall?.();
    mkdirSync(join(siteDir, "dist"), { recursive: true });
    writeFileSync(join(siteDir, "dist", "index.html"), "<!doctype html>");
    return { ok: true, code: 0, output: "" };
  };
}

/** Sets up a built Site Version dir + the context profile audit reads. */
function setup(): { paths: ReturnType<typeof clientPaths>; versionDir: string } {
  const paths = clientPaths(root, "Tailored Co.");
  mkdirSync(paths.context, { recursive: true });
  writeFileSync(join(paths.context, "profile.md"), "# Profile\n\nTailored Co.\n");
  writeFileSync(join(paths.context, "profile.json"), '{"client":"Tailored Co.","fields":[]}');
  const versionDir = paths.versionDir(1);
  mkdirSync(join(versionDir, "dist"), { recursive: true });
  writeFileSync(join(versionDir, "dist", "index.html"), "<!doctype html>");
  return { paths, versionDir };
}

test("runAudit produces checks, findings, and a Scorecard, and re-gates the build", async () => {
  const { paths, versionDir } = setup();
  let regateCalls = 0;

  await runAudit({
    paths,
    config,
    version: 1,
    client,
    log,
    engine: fakeAuditEngine(),
    buildSite: fakeBuild(() => {
      regateCalls += 1;
    }),
    inspect: fakeInspect,
    lighthouse: fakeLighthouse,
  });

  const auditDir = join(versionDir, "audit");

  // deterministic checks persisted with a summary
  const checks = JSON.parse(readFileSync(join(auditDir, "checks.json"), "utf8"));
  expect(checks.summary.pages).toBe(1);
  expect(checks.summary.a11yViolations).toBe(1);
  expect(checks.summary.brokenRefs).toBe(0);

  // findings file written by the (fake) model, with the Scorecard table prepended
  const auditMd = readFileSync(join(auditDir, "audit.md"), "utf8");
  expect(auditMd).toContain("Lighthouse Scorecard");
  expect(auditMd).toContain("Mobile");
  expect(auditMd).toContain("Desktop");
  expect(auditMd).toContain("minor fixes applied"); // the model's own findings survive below the table

  // Scorecard persisted with both form factors
  const lh: Scorecard = JSON.parse(readFileSync(join(auditDir, "lighthouse.json"), "utf8"));
  expect(lh.results.map((r) => r.formFactor).sort()).toEqual(["desktop", "mobile"]);
  expect(lh.results[0]?.scores.accessibility).toBe(100);

  // dist already existed, so only the post-fix re-gate ran (not ensureBuilt)
  expect(regateCalls).toBe(1);
});

test("runAudit writes a fallback audit.md from the checks when the model omits one", async () => {
  const { paths, versionDir } = setup();

  await runAudit({
    paths,
    config,
    version: 1,
    client,
    log,
    engine: fakeAuditEngine({ skipAuditMd: true }),
    buildSite: fakeBuild(),
    inspect: fakeInspect,
    lighthouse: fakeLighthouse,
  });

  const auditMd = readFileSync(join(versionDir, "audit", "audit.md"), "utf8");
  expect(auditMd).toContain("Lighthouse Scorecard"); // table still prepended
  expect(auditMd).toContain("color-contrast"); // fallback rendered the axe finding
});

test("runAudit builds first when no dist is present", async () => {
  const { paths, versionDir } = setup();
  rmSync(join(versionDir, "dist"), { recursive: true, force: true });
  let buildCalls = 0;

  await runAudit({
    paths,
    config,
    version: 1,
    client,
    log,
    engine: fakeAuditEngine(),
    buildSite: fakeBuild(() => {
      buildCalls += 1;
    }),
    inspect: fakeInspect,
    lighthouse: fakeLighthouse,
  });

  // ensureBuilt + the post-fix re-gate both ran
  expect(buildCalls).toBe(2);
  expect(existsSync(join(versionDir, "dist", "index.html"))).toBe(true);
});

test("runAudit fails the stage when the AI review fails", async () => {
  const { paths } = setup();
  let caught: unknown;
  try {
    await runAudit({
      paths,
      config,
      version: 1,
      client,
      log,
      engine: fakeAuditEngine({ failReview: true }),
      buildSite: fakeBuild(),
      inspect: fakeInspect,
      lighthouse: fakeLighthouse,
    });
  } catch (err) {
    caught = err;
  }
  expect((caught as Error)?.message).toMatch(/AI review failed/);
});

test("runAudit fails when the post-fix re-gate fails", async () => {
  const { paths } = setup();
  let caught: unknown;
  try {
    await runAudit({
      paths,
      config,
      version: 1,
      client,
      log,
      engine: fakeAuditEngine(),
      // dist exists (ensureBuilt skips), so this is the re-gate failing
      buildSite: async () => ({ ok: false, code: 1, output: "Expected a default export" }),
      inspect: fakeInspect,
      lighthouse: fakeLighthouse,
    });
  } catch (err) {
    caught = err;
  }
  expect((caught as Error)?.message).toMatch(/astro build failed after the fix pass/);
});

test("runAudit keeps going (non-gating) when Lighthouse throws", async () => {
  const { paths, versionDir } = setup();

  await runAudit({
    paths,
    config,
    version: 1,
    client,
    log,
    engine: fakeAuditEngine(),
    buildSite: fakeBuild(),
    inspect: fakeInspect,
    lighthouse: async () => {
      throw new Error("chrome unavailable");
    },
  });

  // stage succeeded; audit.md exists but has no Scorecard, and no lighthouse.json
  const auditDir = join(versionDir, "audit");
  expect(existsSync(join(auditDir, "audit.md"))).toBe(true);
  expect(existsSync(join(auditDir, "lighthouse.json"))).toBe(false);
  expect(readFileSync(join(auditDir, "audit.md"), "utf8")).not.toContain("Lighthouse Scorecard");
});

test("renderScorecardTable lays out both form factors and their categories", () => {
  const scorecard: Scorecard = {
    url: "http://localhost/",
    generatedAt: new Date().toISOString(),
    results: [
      {
        formFactor: "mobile",
        scores: { performance: 95, accessibility: 100, bestPractices: 100, seo: 100 },
        metrics: { lcpMs: 1200, cls: 0.01, tbtMs: 50 },
      },
      {
        formFactor: "desktop",
        scores: { performance: null, accessibility: 100, bestPractices: 100, seo: 100 },
        metrics: { lcpMs: null, cls: null, tbtMs: null },
      },
    ],
  };
  const table = renderScorecardTable(scorecard);
  expect(table).toContain("| Mobile | 95 | 100 | 100 | 100 |");
  expect(table).toContain("| Desktop | — | 100 | 100 | 100 |"); // null renders as em dash
});
