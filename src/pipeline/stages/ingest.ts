import { join } from "node:path";
import type { Stage } from "../types.ts";
import { runStub } from "./stub.ts";

/**
 * `ingest` (stub) — will crawl the existing site, capture screenshots, download
 * Assets, and extract documents (Phase 2). Owns the whole `ingest/` dir, which
 * is cleared wholesale on resume.
 */
export const ingestStage: Stage = {
  name: "ingest",
  phase: "context",
  outputs: (ctx) => [ctx.paths.ingest],
  async run(ctx) {
    runStub(ctx, "ingest", [join(ctx.paths.ingest, ".stub")]);
    ctx.log.step("ingest: gathered raw inputs (stub)");
  },
};
