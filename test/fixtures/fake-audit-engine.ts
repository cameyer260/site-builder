import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineResult, EngineRunner } from "../../src/engine/runner.ts";

/**
 * In-process fake of `runEngine` for the `audit` stage. It dispatches on the
 * review prompt and writes the on-disk artifact the real model would (the
 * `audit/audit.md` findings file), so `runAudit` can be exercised offline.
 */

const ok = (): EngineResult => ({
  ok: true,
  resultText: "done",
  isError: false,
  exitCode: 0,
  events: [],
});

const fail = (): EngineResult => ({
  ok: false,
  resultText: null,
  isError: true,
  exitCode: 1,
  events: [],
  error: "forced engine failure",
});

export interface FakeAuditEngineOptions {
  /** Make the review call report failure. */
  failReview?: boolean;
  /** Review succeeds but writes no audit.md (exercises the fallback findings). */
  skipAuditMd?: boolean;
}

export function fakeAuditEngine(options: FakeAuditEngineOptions = {}): EngineRunner {
  return async (_engineBin, opts) => {
    if (opts.prompt.includes("audit reviewer for a freshly generated")) {
      if (options.failReview) {
        return fail();
      }
      if (!options.skipAuditMd) {
        mkdirSync(join(opts.cwd, "audit"), { recursive: true });
        writeFileSync(
          join(opts.cwd, "audit", "audit.md"),
          "# Audit\n\n## Summary\n\nLooks solid; minor fixes applied.\n",
        );
      }
      return ok();
    }
    return ok();
  };
}
