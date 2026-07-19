import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSite, ensureBuiltDist, type SiteBuilder } from "../astro/run.ts";
import type { Config } from "../config/schema.ts";
import type { EngineKind } from "../engine/adapter.ts";
import {
  type EngineRunner,
  engineFailureDetail,
  engineFailureReason,
  runEngine,
} from "../engine/runner.ts";
import { stageEngineDefaults } from "../engine/stage.ts";
import { resolveEffort, resolveModel } from "../engine/tiers.ts";
import { profilesFromConfig } from "../playwright/screenshot.ts";
import type { Client } from "../storage/client.ts";
import { ARTIFACTS_DIRNAME, type ClientPaths } from "../storage/layout.ts";
import { UserError } from "../util/errors.ts";
import { commitAll } from "../util/git.ts";
import type { Logger } from "../util/log.ts";
import { nowIso } from "../util/time.ts";
import { type InspectResult, inspectBuiltSite, type SiteInspector } from "./inspect.ts";
import { type LighthouseRunner, runLighthouseScorecard, type Scorecard } from "./lighthouse.ts";
import { AUDIT_SYSTEM_PROMPT, buildAuditPrompt } from "./prompts.ts";

/**
 * The real `audit` stage (ADR-0007). Against the locally
 * built Site it: (1) ensures the Site is built, (2) serves it and runs the
 * deterministic fix-drivers (screenshots, axe-core, broken-link/asset check)
 * into a transient `audit/` working dir, (3) has the engine review + apply ONE
 * fix pass (writing `audit/audit.md`), (4) re-gates with `astro build` — the only
 * hard gate, and (5) measures the fixed Site with Lighthouse to produce the
 * **Scorecard**, persisted as `.site-builder/lighthouse.json` (recorded, never
 * gating). The transient `audit/` working dir — checks, screenshots, findings —
 * is deleted after the re-gate; only the Scorecard persists. Review + fix only;
 * the multi-pass loop and score gating are deferred (ADR-0007).
 */

const AUDIT_BUDGET_USD = 6;
const AUDIT_TIMEOUT_MS = 1_200_000; // 20 minutes
/** Pages to inspect from the homepage; bounded to keep the review's cost in check. */
const AUDIT_PAGE_CAP = 5;

export interface AuditParams {
  paths: ClientPaths;
  config: Config;
  version: number;
  client: Client;
  log: Logger;
  /** Injected engine runner (tests pass a fake); defaults to the real one. */
  engine?: EngineRunner;
  /** Injected compile gate (tests stub it); defaults to install + `astro build`. */
  buildSite?: SiteBuilder;
  /** Injected deterministic inspector (tests stub it); defaults to the real one. */
  inspect?: SiteInspector;
  /** Injected Lighthouse Scorecard runner (tests stub it); defaults to the real one. */
  lighthouse?: LighthouseRunner;
  /** Resolved from RunContext; falls back to config.defaultEngine when absent (e.g. tests). */
  engineKind?: EngineKind;
  engineBin?: string;
  modelFor?: (stage: string) => string;
  effortFor?: (stage: string) => string;
}

export async function runAudit(params: AuditParams): Promise<void> {
  const { paths, config, version, client, log } = params;
  const engine = params.engine ?? runEngine;
  const compile = params.buildSite ?? buildSite;

  // Resolve engine fields; fall back to config defaults so tests need not pass them.
  const engineKind = params.engineKind ?? config.defaultEngine;
  const engineProfile = config.engines[engineKind];
  const engineBin = params.engineBin ?? engineProfile.bin;
  const modelFor = params.modelFor ?? ((stage: string) => resolveModel(engineProfile, stage));
  const effortFor = params.effortFor ?? ((stage: string) => resolveEffort(engineProfile, stage));
  const inspect = params.inspect ?? inspectBuiltSite;
  const lighthouse = params.lighthouse ?? runLighthouseScorecard;

  const versionDir = paths.versionDir(version);
  const auditDir = join(versionDir, "audit");
  const checksPath = join(auditDir, "checks.json");
  mkdirSync(auditDir, { recursive: true });

  // 1. Ensure the generated Site is built so it can be served (kept from generate
  //    on a normal run; rebuilt here if a standalone resume lost the dist).
  await ensureBuiltDist({
    versionDir,
    compile,
    log,
    buildingMessage: "audit: building Site before preview (no dist found)",
    failureMessage: "audit: astro build failed — cannot preview the Site",
  });

  // 2. Deterministic inspection → audit/checks.json + audit/screenshots/.
  log.step("audit: inspecting built Site (screenshots, a11y, links)");
  const inspection = await inspect({
    siteDir: versionDir,
    profiles: profilesFromConfig(config.viewports),
    auditDir,
    pageCap: AUDIT_PAGE_CAP,
    log,
  });
  writeChecks(checksPath, inspection);
  logInspection(inspection, log);

  // 3. AI review + one fix pass → audit/audit.md + edits to the Site source.
  log.step("audit: AI review + fix pass (this can take several minutes)");
  const review = await engine(engineBin, {
    ...stageEngineDefaults(),
    engine: engineKind,
    prompt: buildAuditPrompt({
      clientName: client.name,
      checksJsonPath: "audit/checks.json",
      screenshotsDir: "audit/screenshots",
      auditMdPath: "audit/audit.md",
      profileMdPath: join(paths.context, "profile.md"),
      profileJsonPath: join(paths.context, "profile.json"),
    }),
    cwd: versionDir,
    addDirs: [paths.context],
    appendSystemPrompt: AUDIT_SYSTEM_PROMPT,
    model: modelFor("audit"),
    effort: effortFor("audit"),
    maxBudgetUsd: AUDIT_BUDGET_USD,
    timeoutMs: AUDIT_TIMEOUT_MS,
    log,
  });
  if (!review.ok) {
    throw new UserError(
      `audit: AI review failed: ${engineFailureReason(review)}`,
      engineFailureDetail(review),
    );
  }

  // 4. Re-gate: the fix pass must still compile. This is the only hard gate.
  log.step("audit: re-running astro build after the fix pass");
  const rebuilt = await compile(versionDir, log);
  if (!rebuilt.ok) {
    throw new UserError(
      "audit: astro build failed after the fix pass — the Site no longer compiles",
      rebuilt.output.trim().slice(-1500),
    );
  }

  // 5. Scorecard: Lighthouse per form factor on the fixed Site. Non-gating —
  //    a failure to measure is recorded as absent, never failing the stage.
  await writeScorecard({ versionDir, lighthouse, log });

  // 6. Drop the transient working artifacts (checks, screenshots, findings); only
  //    the Scorecard (now under .site-builder/) persists (ADR-0007).
  rmSync(auditDir, { recursive: true, force: true });

  // 7. Snapshot the audit fixes in the version's git history (best-effort).
  if (commitAll(versionDir, "fix: audit pass")) {
    log.step("audit: committed fix pass");
  }
  log.success(`audit: reviewed Site v${version}`);
}

/** Persists the deterministic findings as `audit/checks.json`. */
function writeChecks(path: string, inspection: InspectResult): void {
  const a11yViolations = inspection.axe.reduce((n, page) => n + page.violations.length, 0);
  const payload = {
    generatedAt: nowIso(),
    summary: {
      pages: inspection.pages.length,
      a11yViolations,
      brokenRefs: inspection.brokenRefs.length,
    },
    accessibility: inspection.axe,
    brokenRefs: inspection.brokenRefs,
    screenshots: inspection.pages.map((p) => ({
      url: p.url,
      slug: p.slug,
      screenshots: p.screenshots,
    })),
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function logInspection(inspection: InspectResult, log: Logger): void {
  const a11y = inspection.axe.reduce((n, page) => n + page.violations.length, 0);
  log.step(
    `audit: inspected ${inspection.pages.length} page(s) — ${a11y} a11y violation(s), ${inspection.brokenRefs.length} broken ref(s)`,
  );
}

interface WriteScorecardParams {
  /** The Site Version dir; the Scorecard lands in its `.site-builder/`. */
  versionDir: string;
  lighthouse: LighthouseRunner;
  log: Logger;
}

/** Runs Lighthouse and persists the Scorecard as `.site-builder/lighthouse.json`. */
async function writeScorecard(params: WriteScorecardParams): Promise<void> {
  const { versionDir, lighthouse, log } = params;
  let scorecard: Scorecard;
  try {
    scorecard = await lighthouse({ siteDir: versionDir, log });
  } catch (err) {
    log.warn(
      `audit: Lighthouse Scorecard unavailable: ${err instanceof Error ? err.message : String(err)} (non-gating)`,
    );
    return;
  }

  const artifactsDir = join(versionDir, ARTIFACTS_DIRNAME);
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, "lighthouse.json"), `${JSON.stringify(scorecard, null, 2)}\n`);

  logScorecard(scorecard, log);
}

function logScorecard(scorecard: Scorecard, log: Logger): void {
  for (const r of scorecard.results) {
    const s = r.scores;
    log.success(
      `audit: Lighthouse ${r.formFactor} — Perf ${s.performance ?? "—"} · A11y ${s.accessibility ?? "—"} · BP ${s.bestPractices ?? "—"} · SEO ${s.seo ?? "—"}`,
    );
  }
}
