import { join } from "node:path";
import type { Stage } from "../types.ts";
import { runStub } from "./stub.ts";

/**
 * `generate` (stub) — will copy the Kit into `sites/vN/`, derive the Design
 * Brief, and have the engine build the Site (Phase 5). The real stage clears
 * the Astro tree on resume but must preserve `sites/vN/state.json`, so its
 * declared output is a marker, not the whole version dir.
 */
export const generateStage: Stage = {
  name: "generate",
  phase: "generation",
  outputs: (ctx) => [join(ctx.paths.versionDir(ctx.version), ".generated")],
  async run(ctx) {
    runStub(ctx, "generate", [join(ctx.paths.versionDir(ctx.version), ".generated")]);
    ctx.log.step(`generate: built Site v${ctx.version} (stub)`);
  },
};
