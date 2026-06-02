import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, DEFAULTS } from "../src/config/schema.ts";
import { findResumeStage, resumePipeline, runBuild } from "../src/pipeline/orchestrator.ts";
import type { RunContext } from "../src/pipeline/types.ts";
import { type ClientInputs, ClientInputsSchema, readClient } from "../src/storage/client.ts";
import { clientPaths } from "../src/storage/layout.ts";
import { markFailed, readState, writeState } from "../src/storage/state.ts";
import { createLogger } from "../src/util/log.ts";

const INPUTS: ClientInputs = ClientInputsSchema.parse({ notes: "a test client" });

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sb-orch-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeCtx(name: string, opts: { failAt?: string; withInputs?: boolean } = {}): RunContext {
  const paths = clientPaths(root, name);
  mkdirSync(paths.dir, { recursive: true });
  return {
    config: { ...DEFAULTS, root } as Config,
    paths,
    version: 1,
    log: createLogger({ quiet: true }),
    failAt: opts.failAt,
    inputs: opts.withInputs === false ? undefined : INPUTS,
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
  expect(readClient(ctx.paths.clientJson)?.name).toBe("Acme Co");
  expect(existsSync(join(ctx.paths.ingest, "manifest.json"))).toBe(true);
});

test("forced failure records failure and keeps prior stages; resume completes", async () => {
  const failed = await runBuild(makeCtx("Beta", { failAt: "synthesize" }));
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
