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

test("runAudit re-gates the build, persists the Scorecard, and clears the working dir", async () => {
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

  // the transient working dir (checks, screenshots, findings) is removed after the re-gate
  expect(existsSync(join(versionDir, "audit"))).toBe(false);

  // only the Scorecard persists, under .site-builder/, with both form factors
  const lh: Scorecard = JSON.parse(
    readFileSync(join(versionDir, ".site-builder", "lighthouse.json"), "utf8"),
  );
  expect(lh.results.map((r) => r.formFactor).sort()).toEqual(["desktop", "mobile"]);
  expect(lh.results[0]?.scores.accessibility).toBe(100);

  // dist already existed, so only the post-fix re-gate ran (not ensureBuilt)
  expect(regateCalls).toBe(1);
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

  // stage succeeded: the working dir is cleaned up and no Scorecard was written
  expect(existsSync(join(versionDir, "audit"))).toBe(false);
  expect(existsSync(join(versionDir, ".site-builder", "lighthouse.json"))).toBe(false);
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
