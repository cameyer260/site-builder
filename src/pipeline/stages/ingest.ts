import { runIngest } from "../../ingest/ingest.ts";
import { readClient } from "../../storage/client.ts";
import type { Stage } from "../types.ts";

/**
 * `ingest` — gathers raw material from every provided Input into `ingest/`
 * (crawl + screenshots + assets + extracted docs + notes) and writes
 * `manifest.json`. Pure code, no AI. Reads the Client's Inputs from the
 * `client.json` written by `init`, so it works identically on resume. Owns the
 * whole `ingest/` dir, cleared wholesale on resume.
 */
export const ingestStage: Stage = {
  name: "ingest",
  phase: "context",
  outputs: (ctx) => [ctx.paths.ingest],
  async run(ctx) {
    const client = readClient(ctx.paths.clientJson);
    if (!client) {
      throw new Error("ingest: client.json missing — init must run first");
    }
    await runIngest({
      paths: ctx.paths,
      inputs: client.inputs,
      config: ctx.config,
      pageCap: ctx.pageCap ?? ctx.config.pageCap,
      log: ctx.log,
    });
  },
};
