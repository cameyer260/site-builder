import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config/schema.ts";
import { STAGE_TIER } from "../src/engine/tiers.ts";
import { buildRunContext } from "../src/runtime.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sb-rt-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeConfig(overrides?: Partial<typeof DEFAULTS>) {
  return { ...DEFAULTS, root, ...overrides };
}

test("defaults to claudey when no engine flag is passed", () => {
  const ctx = buildRunContext({ config: makeConfig(), name: "Acme", version: 1, command: "build" });
  expect(ctx.engineKind).toBe("claudey");
  expect(ctx.engineBin).toBe(DEFAULTS.engines.claudey.bin);
});

test("engine flag overrides defaultEngine", () => {
  const ctx = buildRunContext({
    config: makeConfig(),
    name: "Acme",
    version: 1,
    command: "build",
    engine: "codey",
  });
  expect(ctx.engineKind).toBe("codey");
  expect(ctx.engineBin).toBe(DEFAULTS.engines.codey.bin);
});

test("opencode engine flag resolves opencode profile", () => {
  const ctx = buildRunContext({
    config: makeConfig(),
    name: "Acme",
    version: 1,
    command: "build",
    engine: "opencode",
  });
  expect(ctx.engineKind).toBe("opencode");
  expect(ctx.engineBin).toBe(DEFAULTS.engines.opencode.bin);
});

test("config defaultEngine is honoured when no flag passed", () => {
  const ctx = buildRunContext({
    config: makeConfig({ defaultEngine: "codey" }),
    name: "Acme",
    version: 1,
    command: "build",
  });
  expect(ctx.engineKind).toBe("codey");
  expect(ctx.engineBin).toBe(DEFAULTS.engines.codey.bin);
});

test("engine flag beats config defaultEngine", () => {
  const ctx = buildRunContext({
    config: makeConfig({ defaultEngine: "codey" }),
    name: "Acme",
    version: 1,
    command: "build",
    engine: "opencode",
  });
  expect(ctx.engineKind).toBe("opencode");
});

test("modelFor maps generate/audit → best tier", () => {
  const ctx = buildRunContext({ config: makeConfig(), name: "Acme", version: 1, command: "build" });
  const best = DEFAULTS.engines.claudey.models.best;
  expect(ctx.modelFor("generate")).toBe(best);
  expect(ctx.modelFor("audit")).toBe(best);
});

test("modelFor maps synthesize/assetClassification → small tier", () => {
  const ctx = buildRunContext({ config: makeConfig(), name: "Acme", version: 1, command: "build" });
  const small = DEFAULTS.engines.claudey.models.small;
  expect(ctx.modelFor("synthesize")).toBe(small);
  expect(ctx.modelFor("assetClassification")).toBe(small);
});

test("modelFor falls back to best tier for unknown stage names", () => {
  const ctx = buildRunContext({ config: makeConfig(), name: "Acme", version: 1, command: "build" });
  const best = DEFAULTS.engines.claudey.models.best;
  expect(ctx.modelFor("unknown")).toBe(best);
  expect(ctx.modelFor("")).toBe(best);
});

test("STAGE_TIER maps the four known stages to the right tiers", () => {
  expect(STAGE_TIER.generate).toBe("best");
  expect(STAGE_TIER.audit).toBe("best");
  expect(STAGE_TIER.synthesize).toBe("small");
  expect(STAGE_TIER.assetClassification).toBe("small");
});
