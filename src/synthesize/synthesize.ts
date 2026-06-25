import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config/schema.ts";
import type { EngineKind } from "../engine/adapter.ts";
import { type EngineRunner, engineFailureReason, runEngine } from "../engine/runner.ts";
import { stageEngineDefaults } from "../engine/stage.ts";
import { STAGE_TIER } from "../engine/tiers.ts";
import type { IngestManifest } from "../ingest/manifest.ts";
import type { Client } from "../storage/client.ts";
import type { ClientPaths } from "../storage/layout.ts";
import { UserError } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";
import { nowIso } from "../util/time.ts";
import {
  type AssetClassification,
  candidateAssets,
  readClassification,
  reconcileAssets,
} from "./assets.ts";
import {
  type AssetManifestEntry,
  displayFieldValue,
  type Profile,
  readProfile,
  statusCounts,
  writeProfile,
} from "./profile.ts";
import { buildAssetPrompt, buildProfilePrompt } from "./prompts.ts";

/**
 * The real `synthesize` stage: turns the ingested raw material into structured
 * Client context. Two engine calls — asset classification (vision) and profile
 * synthesis — bracketed by deterministic code that reconciles Assets and derives
 * the Checklist gaps. Owns `context/`.
 */

const ASSET_BUDGET_USD = 1.0;
const PROFILE_BUDGET_USD = 1.5;
const CALL_TIMEOUT_MS = 300_000;

export interface SynthesizeParams {
  paths: ClientPaths;
  config: Config;
  client: Client;
  manifest: IngestManifest;
  log: Logger;
  /** Injected engine runner (tests pass a fake); defaults to the real one. */
  engine?: EngineRunner;
  /** Resolved from RunContext; falls back to config.defaultEngine when absent (e.g. tests). */
  engineKind?: EngineKind;
  engineBin?: string;
  modelFor?: (stage: string) => string;
}

export async function runSynthesize(params: SynthesizeParams): Promise<Profile> {
  const { paths, config, client, manifest, log } = params;
  const engine = params.engine ?? runEngine;

  // Resolve engine fields: use caller-provided values (from RunContext) when
  // available, falling back to config defaults so tests need not pass them.
  const engineKind = params.engineKind ?? config.defaultEngine;
  const engineProfile = config.engines[engineKind];
  const engineBin = params.engineBin ?? engineProfile.bin;
  const modelFor =
    params.modelFor ??
    ((stage: string) => {
      const tier = STAGE_TIER[stage] ?? "best";
      return engineProfile.models[tier];
    });

  const contextDir = paths.context;
  mkdirSync(contextDir, { recursive: true });

  const defaults = stageEngineDefaults();
  const sharedDirs = [paths.ingest];

  // --- Call A: asset classification (vision) -> reconciled asset manifest ----
  const candidates = candidateAssets(manifest, paths.ingest);
  let classification: AssetClassification = { assets: [] };
  if (candidates.length > 0) {
    log.step(`synthesize: classifying ${candidates.length} captured asset(s)`);
    const result = await engine(engineBin, {
      ...defaults,
      engine: engineKind,
      prompt: buildAssetPrompt({ contextDir, candidates }),
      cwd: contextDir,
      addDirs: sharedDirs,
      model: modelFor("assetClassification"),
      maxBudgetUsd: ASSET_BUDGET_USD,
      timeoutMs: CALL_TIMEOUT_MS,
      log,
    });
    const parsed = readClassification(contextDir);
    if (result.ok && parsed) {
      classification = parsed;
    } else {
      // Asset classification is best-effort: a failure falls back to logo-only.
      log.warn(
        `synthesize: asset classification unavailable (${result.ok ? "no valid assets.json" : engineFailureReason(result)}); using fallbacks`,
      );
    }
  } else {
    log.step("synthesize: no captured assets to classify");
  }
  const assets = reconcileAssets({
    classification,
    candidates,
    contextDir,
    clientName: client.name,
    log,
  });

  // --- Call B: profile synthesis -> profile.json + profile.md ---------------
  log.step("synthesize: building Client Profile");
  const profileResult = await engine(engineBin, {
    ...defaults,
    engine: engineKind,
    prompt: buildProfilePrompt({
      ingestDir: paths.ingest,
      contextDir,
      manifest,
      clientName: client.name,
    }),
    cwd: contextDir,
    addDirs: sharedDirs,
    model: modelFor("synthesize"),
    maxBudgetUsd: PROFILE_BUDGET_USD,
    timeoutMs: CALL_TIMEOUT_MS,
    log,
  });
  if (!profileResult.ok) {
    throw new UserError(
      `synthesize: profile synthesis failed: ${engineFailureReason(profileResult)}`,
    );
  }

  const profile = finalizeProfile(contextDir, client.name, assets);
  const counts = statusCounts(profile.fields);
  log.success(
    `synthesize: Profile ready — ${counts.Known} Known, ${counts.Guessed} Guessed, ${counts.Unknown} Unknown`,
  );
  return profile;
}

/**
 * Reads the model-written `profile.json`/`profile.md`, validates the JSON,
 * stamps in the authoritative client name + reconciled asset manifest, and
 * derives the Checklist gaps file deterministically so it always matches the
 * recorded Field statuses.
 */
function finalizeProfile(
  contextDir: string,
  clientName: string,
  assets: AssetManifestEntry[],
): Profile {
  const profilePath = join(contextDir, "profile.json");
  const profile = readProfile(profilePath);
  if (!existsSync(join(contextDir, "profile.md"))) {
    throw new UserError(`synthesize: expected profile.md in ${contextDir}, but it was not written`);
  }

  profile.client = clientName;
  profile.generatedAt = nowIso();
  profile.assets = assets;
  persistProfile(contextDir, profile);
  return profile;
}

/**
 * Persists a resolved Profile's machine artifacts to `context/`: the JSON sidecar
 * (`profile.json`) and the re-derived Checklist gaps (`checklist.md`), written
 * together so the gaps always match the recorded Field statuses. Shared by
 * `synthesize` (finalize) and the QA session (which then appends to `profile.md`).
 */
export function persistProfile(contextDir: string, profile: Profile): void {
  writeProfile(join(contextDir, "profile.json"), profile);
  writeFileSync(join(contextDir, "checklist.md"), renderChecklistGaps(profile));
}

/** The "what we still need to know" Checklist: every non-Known field. */
export function renderChecklistGaps(profile: Profile): string {
  const guessed = profile.fields.filter((f) => f.status === "Guessed");
  const unknown = profile.fields.filter((f) => f.status === "Unknown");

  const lines: string[] = [`# Checklist gaps — ${profile.client}`, ""];
  if (guessed.length === 0 && unknown.length === 0) {
    lines.push("Every Checklist item is Known. Nothing outstanding.", "");
    return `${lines.join("\n")}`;
  }

  if (unknown.length > 0) {
    lines.push("## Unknown — no basis in the inputs", "");
    for (const f of unknown) {
      lines.push(`- **${f.label}** (\`${f.key}\`)`);
    }
    lines.push("");
  }
  if (guessed.length > 0) {
    lines.push("## Guessed — verify before relying on these", "");
    for (const f of guessed) {
      const note = f.note ? ` — ${f.note}` : "";
      lines.push(`- **${f.label}** (\`${f.key}\`): ${displayFieldValue(f.value)}${note}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}`;
}
