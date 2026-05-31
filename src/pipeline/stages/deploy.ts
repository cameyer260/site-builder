import { join } from "node:path";
import type { Stage } from "../types.ts";
import { runStub } from "./stub.ts";

/**
 * `deploy` (stub) — will publish the built Site to Cloudflare Pages via Wrangler
 * Direct Upload and record the `*.pages.dev` URL (Phase 7). Publishing is an
 * external side effect with nothing local to clear on resume, so its declared
 * outputs are empty.
 */
export const deployStage: Stage = {
  name: "deploy",
  phase: "generation",
  outputs: () => [],
  async run(ctx) {
    runStub(ctx, "deploy", [join(ctx.paths.versionDir(ctx.version), ".deployed")]);
    ctx.log.step(`deploy: published Site v${ctx.version} (stub)`);
  },
};
