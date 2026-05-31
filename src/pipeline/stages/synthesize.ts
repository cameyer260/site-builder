import { join } from "node:path";
import type { Stage } from "../types.ts";
import { runStub } from "./stub.ts";

/**
 * `synthesize` (stub) — will classify Assets and produce the Client Profile
 * plus Checklist gaps (Phase 3). Owns the whole `context/` dir.
 */
export const synthesizeStage: Stage = {
  name: "synthesize",
  phase: "context",
  outputs: (ctx) => [ctx.paths.context],
  async run(ctx) {
    runStub(ctx, "synthesize", [join(ctx.paths.context, ".stub")]);
    ctx.log.step("synthesize: built Client context (stub)");
  },
};
