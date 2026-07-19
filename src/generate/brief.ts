import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config/schema.ts";
import type { EngineKind } from "../engine/adapter.ts";
import {
  type EngineRunner,
  engineFailureReason,
  logEngineFailureDetail,
  runEngine,
} from "../engine/runner.ts";
import { stageEngineDefaults } from "../engine/stage.ts";
import { resolveEffort, resolveModel } from "../engine/tiers.ts";
import type { ClientPaths } from "../storage/layout.ts";
import { displayFieldValue, type Profile } from "../synthesize/profile.ts";
import type { Logger } from "../util/log.ts";
import { artifactsDir } from "./artifacts.ts";
import { buildBriefPrompt } from "./prompts.ts";

/**
 * **Design Brief** derivation (CONTEXT.md): a small engine
 * call that turns the Client Profile, logo (brand colors), and existing-site
 * screenshots into `sites/vN/.site-builder/brief.md` — one Site Version's
 * explicit visual direction, steerable via `--vibe`/`--style`. Best-effort: if
 * the call fails or omits the file, a deterministic Brief derived from the
 * Profile is written instead, so the build always has a direction to honor.
 */

const BRIEF_BUDGET_USD = 1.5;
const BRIEF_TIMEOUT_MS = 300_000;

export interface DeriveBriefParams {
  paths: ClientPaths;
  config: Config;
  version: number;
  clientName: string;
  profile: Profile;
  vibe?: string;
  style?: string;
  log: Logger;
  engine?: EngineRunner;
  /** Resolved from RunContext; falls back to config.defaultEngine when absent (e.g. tests). */
  engineKind?: EngineKind;
  engineBin?: string;
  modelFor?: (stage: string) => string;
  effortFor?: (stage: string) => string;
}

export async function deriveBrief(params: DeriveBriefParams): Promise<void> {
  const { paths, config, version, clientName, profile, vibe, style, log } = params;
  const engine = params.engine ?? runEngine;

  // Resolve engine fields; fall back to config defaults so tests need not pass them.
  const engineKind = params.engineKind ?? config.defaultEngine;
  const engineProfile = config.engines[engineKind];
  const engineBin = params.engineBin ?? engineProfile.bin;
  const modelFor = params.modelFor ?? ((stage: string) => resolveModel(engineProfile, stage));
  const effortFor = params.effortFor ?? ((stage: string) => resolveEffort(engineProfile, stage));

  const versionDir = paths.versionDir(version);
  const briefMdPath = join(artifactsDir(versionDir), "brief.md");

  const logoEntry = profile.assets.find((a) => a.role === "logo");
  const logoPath = logoEntry ? join(paths.context, logoEntry.file) : undefined;
  const screenshotsDir = join(paths.ingest, "site", "screenshots", "desktop");

  log.step("generate: deriving Design Brief");
  const result = await engine(engineBin, {
    ...stageEngineDefaults(),
    engine: engineKind,
    prompt: buildBriefPrompt({
      clientName,
      artifactsDir: artifactsDir(versionDir),
      profileMdPath: join(paths.context, "profile.md"),
      profileJsonPath: join(paths.context, "profile.json"),
      logoPath: logoPath && existsSync(logoPath) ? logoPath : undefined,
      screenshotsDir: existsSync(screenshotsDir) ? screenshotsDir : undefined,
      vibe,
      style,
    }),
    cwd: versionDir,
    addDirs: [paths.context, paths.ingest],
    // Brief is the `classify` role (cheap vision) — it opens the logo + existing-
    // site screenshots — and is a sub-call of generate, not a stage of its own.
    model: modelFor("brief"),
    effort: effortFor("brief"),
    maxBudgetUsd: BRIEF_BUDGET_USD,
    timeoutMs: BRIEF_TIMEOUT_MS,
    log,
  });

  if (result.ok && existsSync(briefMdPath)) {
    log.step("generate: Design Brief ready");
    return;
  }

  log.warn(
    `generate: Design Brief call ${result.ok ? "wrote no brief.md" : `failed (${engineFailureReason(result)})`}; using a Profile-derived brief`,
  );
  if (!result.ok) {
    logEngineFailureDetail(result, log, "generate: Design Brief");
  }
  writeFileSync(briefMdPath, fallbackBrief(profile, vibe, style));
}

/** A plain, deterministic Brief from the Profile, used when the engine call can't deliver one. */
function fallbackBrief(profile: Profile, vibe?: string, style?: string): string {
  const field = (key: string): string => {
    const f = profile.fields.find((x) => x.key === key);
    return f ? displayFieldValue(f.value) : "";
  };
  const industry = field("industry") || "small business";
  const tone = field("tone") || "professional and approachable";

  const lines = [
    `# Design Brief — ${profile.client}`,
    "",
    "_Auto-derived from the Client Profile (the design engine call was unavailable)._",
    "",
    "## Style & mood",
    `A clean, modern, trustworthy site for a ${industry}. Voice: ${tone}.`,
    "",
    "## Palette",
    "Use the Kit's default brand ramp, adjusted toward the brand's logo colors",
    "where available. Maintain WCAG AA contrast.",
    "",
    "## Typography",
    "A readable, modern Google-Fonts pairing (a confident heading face + a clean",
    "body face).",
    "",
    "## Layout & imagery",
    "Generous spacing, a strong hero, clear service sections, and authentic",
    "photography over generic stock.",
    "",
  ];
  if (vibe || style) {
    lines.push(
      "## Operator direction",
      [vibe ? `Vibe: ${vibe}.` : "", style ? `Style: ${style}.` : ""].filter(Boolean).join(" "),
      "",
    );
  }
  return lines.join("\n");
}
