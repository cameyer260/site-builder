#!/usr/bin/env bun
/**
 * Live engine smoke test for Phase 1. Runs a real throwaway `claude -p` against
 * a scoped temp directory, asks it to create a file unattended, and verifies we
 * parse a clean success signal — the Phase 1 milestone.
 *
 * Usage:
 *   bun run scripts/engine-smoke.ts            # uses `claude` (or $SB_ENGINE_BIN)
 *   SB_ENGINE_BIN=claudey bun run scripts/engine-smoke.ts
 *
 * Costs a small amount of subscription usage (uses haiku + a budget cap).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEngine } from "../src/engine/runner.ts";
import { createLogger } from "../src/util/log.ts";

// Make the child behave like a standalone engine, not a nested Claude Code run.
for (const key of [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_EXECPATH",
  "AI_AGENT",
  "CLAUDE_EFFORT",
]) {
  delete process.env[key];
}

const engineBin = process.env.SB_ENGINE_BIN ?? "claude";
const dir = mkdtempSync(join(tmpdir(), "sb-engine-smoke-"));
const log = createLogger();

log.step(`engine: ${engineBin}`);
log.step(`scoped cwd: ${dir}`);

const result = await runEngine(engineBin, {
  prompt:
    "Use your file tools to create a file named hello.txt in the current working directory. " +
    "Its contents must be exactly the text engine-ok with no other characters or whitespace. " +
    "Do not ask for confirmation; just do it, then stop.",
  cwd: dir,
  model: "haiku",
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
if (result.stderrTail) {
  log.info(`stderr tail: ${result.stderrTail.slice(-400)}`);
}
log.info(`file created: ${fileExists}`);
log.info(`file contents: ${JSON.stringify(contents)}`);

const pass = result.ok && fileExists && contents === "engine-ok";
rmSync(dir, { recursive: true, force: true });

if (pass) {
  log.success(
    "PHASE 1 MILESTONE: engine created a file in a scoped dir and we parsed a clean success",
  );
  process.exit(0);
}
log.error("smoke test FAILED");
process.exit(1);
