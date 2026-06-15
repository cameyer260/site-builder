import { expect, test } from "bun:test";
import { generateOnlyFlagsIgnored } from "../src/pipeline/orchestrator.ts";
import { STAGES } from "../src/pipeline/pipeline.ts";
import type { Stage } from "../src/pipeline/types.ts";

function stage(name: string): Stage {
  const found = STAGES.find((s) => s.name === name);
  if (!found) {
    throw new Error(`no stage "${name}"`);
  }
  return found;
}

const ALL = { vibe: "calm", style: "bold", yes: true };

test("generate-only flags are live when resuming at or before generate", () => {
  for (const name of ["init", "ingest", "synthesize", "generate"]) {
    expect(generateOnlyFlagsIgnored(stage(name), ALL)).toEqual([]);
  }
});

test("generate-only flags are ignored when resuming past generate", () => {
  expect(generateOnlyFlagsIgnored(stage("audit"), ALL)).toEqual(["--vibe", "--style", "--yes"]);
  expect(generateOnlyFlagsIgnored(stage("deploy"), ALL)).toEqual(["--vibe", "--style", "--yes"]);
});

test("only the flags actually passed are reported as ignored", () => {
  expect(generateOnlyFlagsIgnored(stage("audit"), { style: "bold" })).toEqual(["--style"]);
  expect(generateOnlyFlagsIgnored(stage("deploy"), { yes: true })).toEqual(["--yes"]);
  // an empty string is still an explicitly passed flag
  expect(generateOnlyFlagsIgnored(stage("audit"), { vibe: "" })).toEqual(["--vibe"]);
  // nothing passed → nothing to warn about
  expect(generateOnlyFlagsIgnored(stage("audit"), {})).toEqual([]);
});
