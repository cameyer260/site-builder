import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config/schema.ts";
import type { EngineKind } from "../engine/adapter.ts";
import { type EngineRunner, engineFailureReason, runEngine } from "../engine/runner.ts";
import { stageEngineDefaults } from "../engine/stage.ts";
import { resolveModel } from "../engine/tiers.ts";
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
  const modelFor = params.modelFor ?? ((stage: string) => resolveModel(engineProfile, stage));

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
    // Asset classification is best-effort and re-gates on the artifact, not the
    // engine's own verdict: some engines (e.g. opencode) can write a fully valid
    // assets.json and still report a non-zero exit — a stdout-mirroring race in
    // the CLI's event loop, unrelated to whether the classification succeeded.
    // Trusting a schema-valid file over a flaky exit code is what saves the
    // captured Assets in that case; only fall back when nothing usable landed.
    const parsed = readClassification(contextDir);
    if (parsed) {
      classification = parsed;
      if (!result.ok) {
        // Keep the console line short — the artifact already proved this call
        // actually succeeded, so this isn't a failure worth an alarming wall
        // of stderr. The full excerpt (still useful if the *pattern* of
        // engine noise ever needs diagnosing) goes to the build log at info
        // level instead of stacking onto the warning.
        log.warn(
          `synthesize: asset classification engine reported an error (${result.error ?? "unknown error"}) but wrote a valid assets.json; using it anyway`,
        );
        if (result.stderrExcerpt?.trim()) {
          log.info(`synthesize: asset classification stderr — ${result.stderrExcerpt.trim()}`);
        }
      }
    } else {
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
 *
 * The asset manifest doesn't exist until after Call B has already written
 * `profile.md` (it's the result of Call A + deterministic reconciliation), so
 * the model has no way to mention it there itself. We append it here so the
 * one document `generate` is told holds "all the business facts" actually
 * surfaces the Assets it should reuse, instead of leaving them discoverable
 * only as JSON the model must think to go read.
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
  if (assets.length > 0) {
    appendFileSync(join(contextDir, "profile.md"), renderAssetsSection(assets));
  }
  return profile;
}

/** The "## Assets" section appended to `profile.md` (CONTEXT.md "Asset"). */
export function renderAssetsSection(assets: AssetManifestEntry[]): string {
  const lines = [
    "",
    "## Assets",
    "",
    "Captured from the Client's own existing site/materials (or a Fallback Asset",
    "where none was found) — `generate` should reuse these rather than",
    "substituting stock photography or a redrawn mark:",
    "",
  ];
  for (const a of assets) {
    const tag = a.source === "fallback" ? " (fallback — no original found)" : "";
    const description = a.description ? ` — ${a.description}` : "";
    lines.push(`- **${a.role}**${tag}: \`${a.file}\`${description}`);
  }
  lines.push("");
  return lines.join("\n");
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
