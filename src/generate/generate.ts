import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSite, type SiteBuilder } from "../astro/run.ts";
import type { Config } from "../config/schema.ts";
import type { EngineKind } from "../engine/adapter.ts";
import { type EngineRunner, runEngine } from "../engine/runner.ts";
import { stageEngineDefaults } from "../engine/stage.ts";
import { STAGE_TIER } from "../engine/tiers.ts";
import type { Client } from "../storage/client.ts";
import { type ClientPaths, isVersionBuilt, versionMarkerPath } from "../storage/layout.ts";
import type { Profile } from "../synthesize/profile.ts";
import { UserError } from "../util/errors.ts";
import { commitAll } from "../util/git.ts";
import type { Logger } from "../util/log.ts";
import { nowIso } from "../util/time.ts";
import { artifactsDir, ensureArtifactsDir } from "./artifacts.ts";
import { deriveBrief } from "./brief.ts";
import { copyKitInto, gitInitBaseline } from "./kit.ts";
import { readImagesManifest, resolveImages } from "./pexels.ts";
import { buildGeneratePrompt, GENERATE_SYSTEM_PROMPT } from "./prompts.ts";
import { type QaAsk, runQaSession } from "./qa.ts";

/**
 * The real `generate` stage: turns the synthesized Context
 * into a tailored, locally-building Astro Site Version. In order: the QA session
 * resolves the Profile's Unknown and Guessed fields; the Kit is copied in and git-seeded; a small
 * engine call derives the Design Brief; the main engine call builds the Site on
 * the Kit (honoring Brief + Profile, invoking `ui-ux-pro-max`); declared stock
 * image slots are fetched (Pexels → fallback pack); and `astro build` gates the
 * result. Code plus AI (ADR-0001/0005/0006).
 *
 * The whole Site Version tree is rebuilt each run (QA answers live in
 * `context/`, so they persist), but `state.json` is preserved — hence the stage
 * declares only a `.generated` marker as its output, not the version dir.
 */

const GENERATE_BUDGET_USD = 10;
const GENERATE_TIMEOUT_MS = 1_800_000;

export interface GenerateParams {
  paths: ClientPaths;
  config: Config;
  version: number;
  client: Client;
  /** The synthesized Profile (read from `context/profile.json`); QA mutates it. */
  profile: Profile;
  /** Whether the QA gate may prompt. False → all Unknowns become Guessed (Guessed fields remain). */
  interactive: boolean;
  vibe?: string;
  style?: string;
  log: Logger;
  /** Injected engine runner (tests pass a fake); defaults to the real one. */
  engine?: EngineRunner;
  /** Injected compile gate (tests stub it); defaults to install + `astro build`. */
  buildSite?: SiteBuilder;
  /** Injected QA prompter (tests drive it); defaults to a `@clack/prompts` input. */
  qaAsk?: QaAsk;
  /** Injected Pexels fetch (tests stub it); defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Resolved from RunContext; falls back to config.defaultEngine when absent (e.g. tests). */
  engineKind?: EngineKind;
  engineBin?: string;
  modelFor?: (stage: string) => string;
}

export async function runGenerate(params: GenerateParams): Promise<void> {
  const { paths, config, version, client, profile, interactive, vibe, style, log } = params;
  const engine = params.engine ?? runEngine;
  const compile = params.buildSite ?? buildSite;

  // Resolve engine fields; fall back to config defaults so tests need not pass them.
  const engineKind = params.engineKind ?? config.defaultEngine;
  const engineProfile = config.engines[engineKind];
  const engineBin = params.engineBin ?? engineProfile.bin;
  const modelFor =
    params.modelFor ??
    ((stage: string) => {
      const tier = STAGE_TIER[stage] ?? "best";
      return engineProfile.models[tier];
    });

  const versionDir = params.paths.versionDir(version);

  // Last-line-of-defense before the irreversible clear below: never regenerate
  // over a Site Version that already built to completion. The orchestrator
  // guards this on the production path too, but the destruction lives here, so
  // the check lives here as well — no caller may delete a finished version.
  assertNotOverwritingBuiltVersion(paths, version);

  // 0. Rebuild from a pristine tree each run/resume (keep state.json).
  clearVersionTree(versionDir);

  // 1. QA session — resolve the Profile's Unknown and Guessed fields (interactive gate).
  await runQaSession({ profile, contextDir: paths.context, interactive, log, ask: params.qaAsk });

  // 2. Copy the Kit, seed the Site Version's git history, and set up the
  // pipeline-artifacts folder the Brief + build calls write into.
  copyKitInto(versionDir, log);
  gitInitBaseline(versionDir, log);
  ensureArtifactsDir(versionDir);

  // 3. Derive the Design Brief (small engine call + brand-color extraction).
  await deriveBrief({
    paths,
    config,
    version,
    clientName: client.name,
    profile,
    vibe,
    style,
    log,
    engine,
    engineKind,
    engineBin,
    modelFor,
  });

  // 4. The main AI build on top of the Kit.
  const imagesJsonPath = join(artifactsDir(versionDir), "images.json");
  log.step("generate: building Site (this can take several minutes)");
  const build = await engine(engineBin, {
    ...stageEngineDefaults(),
    engine: engineKind,
    prompt: buildGeneratePrompt({
      clientName: client.name,
      profileMdPath: join(paths.context, "profile.md"),
      profileJsonPath: join(paths.context, "profile.json"),
      assetsDir: join(paths.context, "assets"),
      assets: profile.assets,
      imagesJsonPath,
    }),
    cwd: versionDir,
    addDirs: [paths.context, paths.ingest],
    appendSystemPrompt: GENERATE_SYSTEM_PROMPT,
    model: modelFor("generate"),
    maxBudgetUsd: GENERATE_BUDGET_USD,
    timeoutMs: GENERATE_TIMEOUT_MS,
    log,
  });
  if (!build.ok) {
    throw new UserError(`generate: Site build failed: ${build.error}`);
  }

  // 5. Materialize the stock image slots the build declared (Pexels → fallback).
  const manifest = readImagesManifest(imagesJsonPath);
  if (manifest) {
    await resolveImages({
      siteDir: versionDir,
      manifest,
      apiKey: config.pexelsApiKey,
      log,
      fetchImpl: params.fetchImpl,
    });
  }

  // 6. Compile gate — a build failure fails the stage before any audit pass.
  log.step("generate: running astro build compile gate");
  const compiled = await compile(versionDir, log);
  if (!compiled.ok) {
    throw new UserError(
      "generate: astro build failed — the Site does not compile",
      compiled.output.trim().slice(-1500),
    );
  }

  // 7. Best-effort evidence check: warn (never fail) when a captured Asset never
  // shows up anywhere in the built Site, so a silently-dropped logo/photo is at
  // least visible to the operator instead of vanishing unnoticed (ADR-0007:
  // evidence, not a gate — a real design reason to skip one is legitimate).
  warnUnusedCapturedAssets(paths.context, versionDir, profile.assets, log);

  // 8. Snapshot the generated Site (best-effort), then drop the completion marker.
  if (commitAll(versionDir, "feat: generated site")) {
    log.step("generate: committed generated Site");
  }
  writeFileSync(versionMarkerPath(paths, version), `${nowIso()}\n`);
  log.success(`generate: built Site v${version}`);
}

/**
 * Refuses to proceed when `version` already holds a Site Version that built to
 * completion — signalled by the completion marker ({@link isVersionBuilt}),
 * written only after a successful build + compile gate. `generate` rebuilds the
 * tree from scratch ({@link clearVersionTree}), so overwriting a finished
 * version would destroy its files and git history with no backup. No
 * legitimate flow reaches here (a new version's dir is fresh; a resumed
 * generation that never finished has no marker); reaching it means an
 * upstream Site Version targeting bug.
 */
function assertNotOverwritingBuiltVersion(paths: ClientPaths, version: number): void {
  if (!isVersionBuilt(paths, version)) {
    return;
  }
  const versionDir = paths.versionDir(version);
  throw new UserError(
    `generate: refusing to overwrite the already-built Site v${version}`,
    `${versionDir} was generated to completion; regenerating would destroy it and its git ` +
      "history. This is a Site Version targeting bug. To make a new take, run `sb variant`.",
  );
}

/**
 * Clears everything under the Site Version dir except `state.json`, which the
 * orchestrator owns and must survive a resume. Creates the dir if absent.
 */
function clearVersionTree(versionDir: string): void {
  if (!existsSync(versionDir)) {
    mkdirSync(versionDir, { recursive: true });
    return;
  }
  for (const entry of readdirSync(versionDir)) {
    if (entry === "state.json") {
      continue;
    }
    rmSync(join(versionDir, entry), { recursive: true, force: true });
  }
}

/**
 * Best-effort evidence check, not a gate: warns when a captured Asset's bytes
 * never turn up anywhere under the built Site's `src/`/`public/` (scoped to
 * those two — `node_modules`/`dist`/`.astro` are huge and irrelevant, and
 * exist by this point since the compile gate already ran). Compares file
 * *content*, not just filename — the Kit ships its own placeholders under the
 * very names (`logo.png`, `hero.png`, …) the canonical Asset set reuses, so a
 * name-only match can't tell "the model kept the Kit's default" from
 * "the model copied in the real one". A prompt-only instruction to reuse
 * captured Assets was previously easy for the build call to silently drop
 * (e.g. drawing a substitute logo instead of using the real one) with nothing
 * surfacing it; this makes that outcome visible without failing a Site that
 * had a genuine reason to skip one.
 */
function warnUnusedCapturedAssets(
  contextDir: string,
  versionDir: string,
  assets: Profile["assets"],
  log: Logger,
): void {
  const captured = assets.filter((a) => a.source === "captured");
  if (captured.length === 0) {
    return;
  }

  const builtFiles = ["src", "public"]
    .map((dir) => join(versionDir, dir))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => (readdirSync(dir, { recursive: true }) as string[]).map((f) => join(dir, f)));

  const isPresent = (assetPath: string): boolean => {
    let expected: Buffer;
    try {
      expected = readFileSync(assetPath);
    } catch {
      return true; // can't read the source Asset; don't report a false positive
    }
    return builtFiles.some((f) => {
      try {
        return readFileSync(f).equals(expected);
      } catch {
        return false; // directories and unreadable entries just don't match
      }
    });
  };

  const unused = captured.filter((a) => !isPresent(join(contextDir, a.file)));
  if (unused.length > 0) {
    const list = unused.map((a) => `${a.role} (${a.file})`).join(", ");
    log.warn(
      `generate: captured asset(s) not found anywhere in the built Site — verify they were used: ${list}`,
    );
  }
}
