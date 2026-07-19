import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, DEFAULTS } from "../src/config/schema.ts";
import type { EngineRunner } from "../src/engine/runner.ts";
import { resolveEffort, resolveModel } from "../src/engine/tiers.ts";
import { ARTIFACTS_DIRNAME } from "../src/generate/artifacts.ts";
import { runVariant, smartBuild } from "../src/pipeline/orchestrator.ts";
import type { RunContext } from "../src/pipeline/types.ts";
import { type ClientInputs, ClientInputsSchema, readClient } from "../src/storage/client.ts";
import { clientPaths } from "../src/storage/layout.ts";
import { readState, writeState } from "../src/storage/state.ts";
import { createLogger } from "../src/util/log.ts";
import { fakeInspect, fakeLighthouse } from "./fixtures/fake-audit-tools.ts";
import { fakeDeploy } from "./fixtures/fake-deploy.ts";
import { fakeStageEngine } from "./fixtures/fake-stage-engine.ts";

const INPUTS: ClientInputs = ClientInputsSchema.parse({ notes: "a test client" });

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sb-smart-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeCtx(name: string, opts: { engine?: EngineRunner } = {}): RunContext {
  const paths = clientPaths(root, name);
  mkdirSync(paths.dir, { recursive: true });
  const engineKind = DEFAULTS.defaultEngine;
  const engineProfile = DEFAULTS.engines[engineKind];
  return {
    config: { ...DEFAULTS, root } as Config,
    paths,
    version: 1,
    engineKind,
    engineBin: engineProfile.bin,
    modelFor: (stage) => resolveModel(engineProfile, stage),
    effortFor: (stage) => resolveEffort(engineProfile, stage),
    log: createLogger({ quiet: true }),
    inputs: INPUTS,
    engine: opts.engine ?? fakeStageEngine(),
    buildSite: async () => ({ ok: true, code: 0, output: "" }),
    inspectSite: fakeInspect,
    runLighthouse: fakeLighthouse,
    deploySite: fakeDeploy,
  };
}

test("new Client runs the full pipeline into v1", async () => {
  const result = await smartBuild(makeCtx("Acme Co"), { refresh: false });

  expect(result.kind).toBe("new");
  expect(result.version).toBe(1);
  expect(result.ran).toEqual(["init", "ingest", "synthesize", "generate", "audit", "deploy"]);

  const paths = clientPaths(root, "Acme Co");
  expect(readClient(paths.clientJson)?.sites).toEqual([
    { version: 1, deployUrl: `https://${paths.slug}.pages.dev` },
  ]);
});

test("a complete Client with no new Inputs is a no-op", async () => {
  await smartBuild(makeCtx("Beta"), { refresh: false });
  const result = await smartBuild(makeCtx("Beta"), { refresh: false });

  expect(result.kind).toBe("noop");
  expect(result.ran).toEqual([]);
  expect(result.version).toBe(1);
});

test("refresh re-runs context and forks a new Site Version", async () => {
  await smartBuild(makeCtx("Gamma"), { refresh: false });
  const result = await smartBuild(makeCtx("Gamma"), { refresh: true });

  expect(result.kind).toBe("refresh");
  expect(result.version).toBe(2);
  // context re-ran from ingest, then the generation phase into v2
  expect(result.ran).toEqual(["ingest", "synthesize", "generate", "audit", "deploy"]);

  const paths = clientPaths(root, "Gamma");
  // both versions on disk; both recorded, ordered
  expect(existsSync(paths.versionDir(1))).toBe(true);
  expect(existsSync(paths.versionDir(2))).toBe(true);
  expect(readClient(paths.clientJson)?.sites.map((s) => s.version)).toEqual([1, 2]);
  // context state was re-run (ingest re-marked: a second attempt)
  expect(readState(paths.state)?.stages.ingest?.attempts).toBe(2);
});

test("an incomplete run is continued in place (no new version)", async () => {
  // First build fails at synthesize (the profile engine call throws).
  const failed = await smartBuild(
    makeCtx("Delta", { engine: fakeStageEngine({ failProfile: true }) }),
    {
      refresh: false,
    },
  );
  expect(failed.ok).toBe(false);
  expect(failed.failedStage).toBe("synthesize");

  const result = await smartBuild(makeCtx("Delta"), { refresh: false });
  expect(result.kind).toBe("continue");
  expect(result.version).toBe(1);
  expect(result.ran).toEqual(["synthesize", "generate", "audit", "deploy"]);

  const paths = clientPaths(root, "Delta");
  expect(readState(paths.versionState(1))?.stages.deploy?.status).toBe("completed");
});

test("a refresh that fails before generation resumes into its target Version, not the previous one", async () => {
  // A complete v1 to refresh away from.
  await smartBuild(makeCtx("Theta"), { refresh: false });

  // Refresh toward v2, but synthesize (context phase) fails before v2's dir is
  // ever materialized on disk.
  const failed = await smartBuild(
    makeCtx("Theta", { engine: fakeStageEngine({ failProfile: true }) }),
    {
      refresh: true,
    },
  );
  expect(failed.ok).toBe(false);
  expect(failed.failedStage).toBe("synthesize");
  expect(failed.version).toBe(2);

  const paths = clientPaths(root, "Theta");
  // v2 never materialized — only v1 on disk — but the target Version was recorded.
  expect(existsSync(paths.versionDir(2))).toBe(false);
  expect(readState(paths.state)?.targetVersion).toBe(2);

  // A plain continue must pick up the v2 intent, not regenerate over v1.
  const resumed = await smartBuild(makeCtx("Theta"), { refresh: false });
  expect(resumed.kind).toBe("continue");
  expect(resumed.version).toBe(2);
  expect(resumed.ran).toEqual(["synthesize", "generate", "audit", "deploy"]);

  // v1 preserved, v2 created.
  expect(existsSync(paths.versionDir(1))).toBe(true);
  expect(existsSync(paths.versionDir(2))).toBe(true);
  expect(readClient(paths.clientJson)?.sites.map((s) => s.version)).toEqual([1, 2]);
});

test("a context resume that mis-resolves to a completed Site Version is refused, not overwritten", async () => {
  // The real-world regression: a complete v1 exists, then the Context phase was
  // re-run and left `synthesize` failed — but the new-version intent
  // (`targetVersion`) was never durably recorded (the on-disk state.json we
  // recovered had no such field). A plain continue then resolves back to v1 and,
  // pre-fix, regenerated over it. It must now refuse and leave v1 untouched.
  await smartBuild(makeCtx("Iota"), { refresh: false });
  const paths = clientPaths(root, "Iota");
  writeFileSync(join(paths.versionDir(1), "PRECIOUS"), "irreplaceable v1 history");

  const ctxState = readState(paths.state);
  if (!ctxState) throw new Error("expected context state");
  ctxState.stages.synthesize = { status: "failed", attempts: 2, error: "engine exited 141" };
  ctxState.targetVersion = undefined;
  writeState(paths.state, ctxState);

  const resumed = await smartBuild(makeCtx("Iota"), { refresh: false });

  expect(resumed.ok).toBe(false);
  expect(resumed.failedStage).toBe("generate");
  expect(resumed.error).toMatch(/refusing to overwrite the already-built Site v1/);
  // v1's files and the completion marker survive untouched.
  expect(readFileSync(join(paths.versionDir(1), "PRECIOUS"), "utf8")).toBe(
    "irreplaceable v1 history",
  );
  expect(existsSync(join(paths.versionDir(1), ARTIFACTS_DIRNAME, ".generated"))).toBe(true);
});

test("a missing Client record with existing Site Versions is refused, not overwritten", async () => {
  await smartBuild(makeCtx("Lambda"), { refresh: false });
  const paths = clientPaths(root, "Lambda");
  writeFileSync(join(paths.versionDir(1), "PRECIOUS"), "irreplaceable v1 history");

  // The Client record goes missing while v1 stays on disk (moved/deleted/corrupt).
  rmSync(paths.clientJson, { force: true });

  let caught: unknown;
  await smartBuild(makeCtx("Lambda"), { refresh: false }).catch((err) => {
    caught = err;
  });
  expect((caught as Error)?.message).toMatch(/no Client record .* but Site v1 exists/);
  expect(readFileSync(join(paths.versionDir(1), "PRECIOUS"), "utf8")).toBe(
    "irreplaceable v1 history",
  );
});

test("variant generates a new Site Version from existing context", async () => {
  await smartBuild(makeCtx("Epsilon"), { refresh: false });

  const ctx = makeCtx("Epsilon");
  ctx.version = 2;
  const result = await runVariant(ctx);

  expect(result.ok).toBe(true);
  expect(result.ran).toEqual(["generate", "audit", "deploy"]);

  const paths = clientPaths(root, "Epsilon");
  expect(readState(paths.versionState(2))?.stages.deploy?.status).toBe("completed");
  expect(readClient(paths.clientJson)?.sites.map((s) => s.version)).toEqual([1, 2]);
});
