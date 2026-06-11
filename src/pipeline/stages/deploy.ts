import { runDeploy } from "../../deploy/deploy.ts";
import { readClient } from "../../storage/client.ts";
import type { Stage } from "../types.ts";

/**
 * `deploy` — publishes the built Site Version to Cloudflare Pages via Wrangler
 * Direct Upload and records the `*.pages.dev` URL on the Client (Phase 7,
 * ADR-0004). Publishing is an external side effect and the recorded URL lives in
 * the CRM record (never a stage output), so its declared outputs are empty:
 * nothing local to clear on resume.
 */
export const deployStage: Stage = {
  name: "deploy",
  phase: "generation",
  outputs: () => [],
  async run(ctx) {
    if (!readClient(ctx.paths.clientJson)) {
      throw new Error("deploy: client.json missing — init must run first");
    }
    await runDeploy({
      paths: ctx.paths,
      config: ctx.config,
      version: ctx.version,
      log: ctx.log,
      buildSite: ctx.buildSite,
      deploy: ctx.deploySite,
    });
  },
};
