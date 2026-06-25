import { join } from "node:path";
import { runGenerate } from "../../generate/generate.ts";
import { readClient } from "../../storage/client.ts";
import { readProfile } from "../../synthesize/profile.ts";
import type { Stage } from "../types.ts";

/**
 * `generate` — copies the Kit into `sites/vN/`, runs the QA gate, derives the
 * Design Brief, has the engine build the Site, sources stock imagery, and gates
 * on `astro build` (Phase 5). It rebuilds the version tree on every run but must
 * preserve `sites/vN/state.json`, so its declared output is a marker, not the
 * whole version dir.
 */
export const generateStage: Stage = {
  name: "generate",
  phase: "generation",
  outputs: (ctx) => [join(ctx.paths.versionDir(ctx.version), ".generated")],
  async run(ctx) {
    const client = readClient(ctx.paths.clientJson);
    if (!client) {
      throw new Error("generate: client.json missing — init must run first");
    }
    const profile = readProfile(join(ctx.paths.context, "profile.json"));
    await runGenerate({
      paths: ctx.paths,
      config: ctx.config,
      version: ctx.version,
      client,
      profile,
      interactive: ctx.interactive ?? false,
      vibe: ctx.vibe,
      style: ctx.style,
      log: ctx.log,
      engine: ctx.engine,
      buildSite: ctx.buildSite,
      engineKind: ctx.engineKind,
      engineBin: ctx.engineBin,
      modelFor: ctx.modelFor,
    });
  },
};
