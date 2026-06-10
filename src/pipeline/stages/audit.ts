import { join } from "node:path";
import { runAudit } from "../../audit/audit.ts";
import { readClient } from "../../storage/client.ts";
import type { Stage } from "../types.ts";

/**
 * `audit` — reviews the locally built Site Version (deterministic checks +
 * screenshots feeding one AI review + fix pass), re-gates with `astro build`,
 * and records the Lighthouse Scorecard (Phase 6, ADR-0007). Owns the `audit/`
 * dir, cleared on resume. Note: the fix pass also edits the Site *source*, which
 * is not a declared output — those edits are committed on success and left in
 * place on a failed attempt, so a resumed audit re-reviews the current tree.
 */
export const auditStage: Stage = {
  name: "audit",
  phase: "generation",
  outputs: (ctx) => [join(ctx.paths.versionDir(ctx.version), "audit")],
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
    });
  },
};
