import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, DEFAULTS } from "../src/config/schema.ts";
import type { EngineRunner } from "../src/engine/runner.ts";
import { findResumeStage, resumePipeline, runBuild } from "../src/pipeline/orchestrator.ts";
import type { RunContext } from "../src/pipeline/types.ts";
import { type ClientInputs, ClientInputsSchema, readClient } from "../src/storage/client.ts";
import { clientPaths } from "../src/storage/layout.ts";
import { markFailed, readState, writeState } from "../src/storage/state.ts";
import { createLogger } from "../src/util/log.ts";
import { fakeInspect, fakeLighthouse } from "./fixtures/fake-audit-tools.ts";
import { fakeDeploy } from "./fixtures/fake-deploy.ts";
import { fakeStageEngine } from "./fixtures/fake-stage-engine.ts";

const INPUTS: ClientInputs = ClientInputsSchema.parse({ notes: "a test client" });

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sb-orch-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeCtx(
  name: string,
  opts: { failAt?: string; withInputs?: boolean; engine?: EngineRunner } = {},
): RunContext {
  const paths = clientPaths(root, name);
  mkdirSync(paths.dir, { recursive: true });
  return {
    config: { ...DEFAULTS, root } as Config,
    paths,
    version: 1,
    log: createLogger({ quiet: true }),
    failAt: opts.failAt,
    inputs: opts.withInputs === false ? undefined : INPUTS,
    // synthesize/generate/audit are real AI stages now; inject a fake engine to
    // stay offline and stub generate's/audit's compile gate so they don't shell
    // out to npm. audit's preview/browser/Lighthouse and deploy's wrangler upload
    // are stubbed too.
    engine: opts.engine ?? fakeStageEngine(),
    buildSite: async () => ({ ok: true, code: 0, output: "" }),
    inspectSite: fakeInspect,
    runLighthouse: fakeLighthouse,
    deploySite: fakeDeploy,
  };
}

test("happy path: build walks all six stub stages and records both state files", async () => {
  const ctx = makeCtx("Acme Co");
  const result = await runBuild(ctx);

  expect(result.ok).toBe(true);
  expect(result.ran).toEqual(["init", "ingest", "synthesize", "generate", "audit", "deploy"]);

  const context = readState(ctx.paths.state);
  expect(context?.stages.init?.status).toBe("completed");
  expect(context?.stages.synthesize?.status).toBe("completed");

  const generation = readState(ctx.paths.versionState(1));
  expect(generation?.version).toBe(1);
  expect(generation?.stages.deploy?.status).toBe("completed");

  // init registered the Client; ingest (notes-only here) wrote its manifest
  const client = readClient(ctx.paths.clientJson);
  expect(client?.name).toBe("Acme Co");
  expect(existsSync(join(ctx.paths.ingest, "manifest.json"))).toBe(true);
  // deploy recorded the shareable *.pages.dev link on the v1 pointer
  expect(client?.sites).toEqual([{ version: 1, deployUrl: `https://${ctx.paths.slug}.pages.dev` }]);
});

test("forced failure records failure and keeps prior stages; resume completes", async () => {
  // Drive the failure through the engine: the synthesize profile call fails.
  const failed = await runBuild(
    makeCtx("Beta", { engine: fakeStageEngine({ failProfile: true }) }),
  );
  expect(failed.ok).toBe(false);
  expect(failed.failedStage).toBe("synthesize");

  const ctx = makeCtx("Beta");
  const context = readState(ctx.paths.state);
  expect(context?.stages.ingest?.status).toBe("completed"); // keep-prior
  expect(context?.stages.synthesize?.status).toBe("failed");
  // generation phase never started
  expect(readState(ctx.paths.versionState(1))).toBeNull();
  // resume point is the failed stage
  expect(findResumeStage(ctx)?.name).toBe("synthesize");

  const resumed = await resumePipeline(ctx);
  expect(resumed.ok).toBe(true);

  const after = readState(ctx.paths.state);
  expect(after?.stages.synthesize?.status).toBe("completed");
  expect(after?.stages.synthesize?.attempts).toBe(2); // failed once, then succeeded
  expect(readState(ctx.paths.versionState(1))?.stages.deploy?.status).toBe("completed");
});

test("resume clears the resumed stage's own output (clear-own-output)", async () => {
  await runBuild(makeCtx("Gamma"));

  // Simulate a stale/partial artifact and force ingest back to failed.
  const ctx = makeCtx("Gamma");
  const state = readState(ctx.paths.state);
  if (!state) {
    throw new Error("expected context state");
  }
  markFailed(state, "ingest", "synthetic");
  writeState(ctx.paths.state, state);
  writeFileSync(join(ctx.paths.ingest, "stale.txt"), "leftover");

  await resumePipeline(makeCtx("Gamma"));

  // ingest dir was wiped then re-created on resume
  expect(existsSync(join(ctx.paths.ingest, "stale.txt"))).toBe(false);
  expect(existsSync(join(ctx.paths.ingest, "manifest.json"))).toBe(true);
  // prior stage (init) untouched: the Client record survives
  expect(readClient(ctx.paths.clientJson)?.name).toBe("Gamma");
});

test("resume on a fully complete pipeline is a no-op", async () => {
  await runBuild(makeCtx("Delta"));
  const ctx = makeCtx("Delta");
  expect(findResumeStage(ctx)).toBeNull();
  const result = await resumePipeline(ctx);
  expect(result.ok).toBe(true);
  expect(result.ran).toEqual([]);
});
