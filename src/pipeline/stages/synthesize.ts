import { join } from "node:path";
import { readManifest } from "../../ingest/manifest.ts";
import { readClient } from "../../storage/client.ts";
import { runSynthesize } from "../../synthesize/synthesize.ts";
import type { Stage } from "../types.ts";

/**
 * `synthesize` — classifies the captured image Assets and produces the Client
 * Profile (`profile.md` + `profile.json`) plus the Checklist gaps
 * (`checklist.md`). Code plus AI (two `claude -p` calls). Reads the `ingest/`
 * manifest, so it works identically on resume. Owns the whole `context/` dir,
 * cleared wholesale on resume.
 */
export const synthesizeStage: Stage = {
  name: "synthesize",
  phase: "context",
  outputs: (ctx) => [ctx.paths.context],
  async run(ctx) {
    const client = readClient(ctx.paths.clientJson);
    if (!client) {
      throw new Error("synthesize: client.json missing — init must run first");
    }
    const manifest = readManifest(join(ctx.paths.ingest, "manifest.json"));
    if (!manifest) {
      throw new Error("synthesize: ingest manifest missing — ingest must run first");
    }
    await runSynthesize({
      paths: ctx.paths,
      config: ctx.config,
      client,
      manifest,
      log: ctx.log,
      engine: ctx.engine,
      engineKind: ctx.engineKind,
      engineBin: ctx.engineBin,
      modelFor: ctx.modelFor,
    });
  },
};
