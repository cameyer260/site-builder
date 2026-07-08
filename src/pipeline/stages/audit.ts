import { join } from "node:path";
import { runAudit } from "../../audit/audit.ts";
import { readClient } from "../../storage/client.ts";
import { ARTIFACTS_DIRNAME } from "../../storage/layout.ts";
import type { Stage } from "../types.ts";

/**
 * `audit` — reviews the locally built Site Version (deterministic checks +
 * screenshots feeding one AI review + fix pass), re-gates with `astro build`,
 * and records the Lighthouse Scorecard (Phase 6, ADR-0007). The `audit/` dir is
 * a transient working area deleted after the re-gate; only the Scorecard
 * (`.site-builder/lighthouse.json`) persists. Both are declared outputs so a
 * resume clears any stale copies first — but NOT `.site-builder/` itself, which
 * also holds generate's Design Brief and the `.generated` completion marker.
 * Note: the fix pass also edits the Site *source*, which is not a declared
 * output — those edits are committed on success and left in place on a failed
 * attempt, so a resumed audit re-reviews the current tree.
 */
export const auditStage: Stage = {
  name: "audit",
  phase: "generation",
  outputs: (ctx) => {
    const versionDir = ctx.paths.versionDir(ctx.version);
    return [join(versionDir, "audit"), join(versionDir, ARTIFACTS_DIRNAME, "lighthouse.json")];
  },
  async run(ctx) {
    const client = readClient(ctx.paths.clientJson);
    if (!client) {
      throw new Error("audit: client.json missing — init must run first");
    }
    await runAudit({
      paths: ctx.paths,
      config: ctx.config,
      version: ctx.version,
      client,
      log: ctx.log,
      engine: ctx.engine,
      buildSite: ctx.buildSite,
      inspect: ctx.inspectSite,
      lighthouse: ctx.runLighthouse,
      engineKind: ctx.engineKind,
      engineBin: ctx.engineBin,
      modelFor: ctx.modelFor,
    });
  },
};
