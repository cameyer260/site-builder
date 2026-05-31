import { join } from "node:path";
import type { Stage } from "../types.ts";
import { runStub } from "./stub.ts";

/**
 * `audit` (stub) — will run deterministic checks (axe-core, links, Lighthouse)
 * plus an AI review and one fix pass (Phase 6). Owns the `audit/` dir under the
 * version.
 */
export const auditStage: Stage = {
  name: "audit",
  phase: "generation",
  outputs: (ctx) => [join(ctx.paths.versionDir(ctx.version), "audit")],
  async run(ctx) {
    runStub(ctx, "audit", [join(ctx.paths.versionDir(ctx.version), "audit", ".stub")]);
    ctx.log.step(`audit: reviewed Site v${ctx.version} (stub)`);
  },
};
