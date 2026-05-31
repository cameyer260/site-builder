import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunContext } from "../types.ts";

/**
 * Shared body for Phase-0 stub stages: honor the `SB_STUB_FAIL` injection, then
 * write marker files standing in for real artifacts. Each real stage (Phases
 * 1–7) replaces its stub with actual work but keeps the same Stage contract.
 */
export function runStub(ctx: RunContext, stageName: string, markers: string[]): void {
  if (ctx.failAt === stageName) {
    throw new Error(`forced stub failure at stage "${stageName}" (SB_STUB_FAIL)`);
  }
  for (const marker of markers) {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, `stub output for "${stageName}" @ ${new Date().toISOString()}\n`);
  }
}
