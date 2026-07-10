#!/usr/bin/env bun
/**
 * Live engine smoke test. Runs a real headless engine against a scoped temp
 * directory, asks it to create a file unattended, and verifies we parse a clean
 * success signal.
 *
 * Usage:
 *   bun run engine:smoke                         # claudey (default)
 *   bun run engine:smoke -- --engine codey       # codey adapter
 *   bun run engine:smoke -- --engine opencode    # opencode adapter
 *   SB_ENGINE=codey bun run engine:smoke         # env-var form
 *   SB_ENGINE_BIN=claudey bun run engine:smoke   # override binary path
 *
 * Costs a small amount of subscription usage. Never run from CI.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config/schema.ts";
import type { EngineKind } from "../src/engine/adapter.ts";
import { runEngine } from "../src/engine/runner.ts";
import { NESTED_AGENT_MARKERS } from "../src/engine/stage.ts";
import { createLogger } from "../src/util/log.ts";

const engineArg = process.argv.indexOf("--engine");
const engineKind: EngineKind = ((engineArg >= 0 ? process.argv[engineArg + 1] : undefined) ??
  process.env.SB_ENGINE ??
  "claudey") as EngineKind;

// Use SB_ENGINE_BIN override if set; otherwise fall back to the engine kind name
// (claudey/codey/opencode are each expected to be on PATH in production).
const engineBin = process.env.SB_ENGINE_BIN ?? engineKind;

// Scrub all nested-agent markers so the child behaves as a standalone engine.
for (const key of NESTED_AGENT_MARKERS) {
  delete process.env[key];
}

const dir = mkdtempSync(join(tmpdir(), "sb-engine-smoke-"));
const log = createLogger();

// Use the small-tier model configured for this engine (simple file-write task).
const model = DEFAULTS.engines[engineKind].models.small;

log.step(`engine: ${engineKind} (bin: ${engineBin})`);
log.step(`model:  ${model}`);
log.step(`scoped cwd: ${dir}`);

const result = await runEngine(engineBin, {
  engine: engineKind,
  prompt:
    "Use your file tools to create a file named hello.txt in the current working directory. " +
    "Its contents must be exactly the text engine-ok with no other characters or whitespace. " +
    "Do not ask for confirmation; just do it, then stop.",
  cwd: dir,
  model,
  // Give codey explicit sandbox access to the temp dir (codey mounts dirs via --add-dir;
  // without this the cwd is outside its sandbox and file writes fail).
  addDirs: [dir],
  dangerouslySkipPermissions: true,
  noSessionPersistence: true,
  maxBudgetUsd: 0.5,
  timeoutMs: 180_000,
  log,
});

const target = join(dir, "hello.txt");
const fileExists = existsSync(target);
const contents = fileExists ? readFileSync(target, "utf8").trim() : null;

log.info("");
log.step("=== engine result ===");
log.info(`ok:        ${result.ok}`);
log.info(`subtype:   ${result.subtype ?? "—"}`);
log.info(`session:   ${result.sessionId ?? "—"}`);
log.info(`turns:     ${result.numTurns ?? "—"}`);
log.info(`cost usd:  ${result.totalCostUsd ?? "—"}`);
log.info(`duration:  ${result.durationMs ?? "—"}ms`);
log.info(`exit code: ${result.exitCode}`);
if (result.error) {
  log.error(`error: ${result.error}`);
}
if (result.stderrExcerpt) {
  log.info(`stderr excerpt: ${result.stderrExcerpt}`);
}
if (result.resultText) {
  log.info(`result text: ${result.resultText.slice(0, 500)}`);
}
// Set SB_SMOKE_VERBOSE=1 to dump every raw engine event (handy for diagnosing a
// new engine's argv/verdict dialect, e.g. where it actually wrote a file).
if (process.env.SB_SMOKE_VERBOSE === "1") {
  log.step("=== raw events ===");
  for (const ev of result.events) {
    log.info(JSON.stringify(ev));
  }
}
log.info(`file created: ${fileExists}`);
log.info(`file contents: ${JSON.stringify(contents)}`);

const pass = result.ok && fileExists && contents === "engine-ok";
rmSync(dir, { recursive: true, force: true });

if (pass) {
  log.success(
    `MILESTONE: ${engineKind} engine created a file in a scoped dir and we parsed a clean success`,
  );
  process.exit(0);
}
log.error("smoke test FAILED");
process.exit(1);
