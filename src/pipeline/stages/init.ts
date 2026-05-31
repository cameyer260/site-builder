import { existsSync, mkdirSync } from "node:fs";
import { newClient, writeClient } from "../../storage/client.ts";
import type { Stage } from "../types.ts";

/**
 * `init` — registers the Client and ensures its folder substructure exists.
 * Pure code. The orchestrator owns the machine state files; this stage owns the
 * CRM record (`client.json`). On a fresh `build` it writes the record from the
 * gathered Inputs; on resume the record already exists and init only verifies.
 *
 * Its outputs are deliberately empty: the Client record must never be cleared
 * on resume (that would delete the Client).
 */
export const initStage: Stage = {
  name: "init",
  phase: "context",
  outputs: () => [],
  async run(ctx) {
    if (ctx.failAt === "init") {
      throw new Error('forced stub failure at stage "init" (SB_STUB_FAIL)');
    }
    if (!existsSync(ctx.paths.clientJson)) {
      if (!ctx.inputs) {
        throw new Error("init: no Inputs available to register a new Client");
      }
      writeClient(ctx.paths.clientJson, newClient(ctx.paths.name, ctx.inputs));
      ctx.log.step(`init: registered Client "${ctx.paths.name}"`);
    } else {
      ctx.log.step(`init: Client "${ctx.paths.name}" already registered`);
    }
    mkdirSync(ctx.paths.sites, { recursive: true });
  },
};
