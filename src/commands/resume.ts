import { parseArgs } from "node:util";
import pc from "picocolors";
import { loadConfigOrThrow } from "../config/store.ts";
import { resumePipeline } from "../pipeline/orchestrator.ts";
import { buildRunContext } from "../runtime.ts";
import { clientExists, clientPaths, latestVersion } from "../storage/layout.ts";
import { UserError } from "../util/errors.ts";

const USAGE = "usage: sb resume <client>";

export async function resumeCommand(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const name = positionals[0];
  if (!name) {
    throw new UserError("missing client name", USAGE);
  }

  const config = loadConfigOrThrow();
  if (!clientExists(config.root, name)) {
    throw new UserError(`no Client found for "${name}"`, "run `sb build` first");
  }

  // Resume targets the latest Site Version (or v1 if generation never started).
  const paths = clientPaths(config.root, name);
  const version = latestVersion(paths.sites) ?? 1;

  const ctx = buildRunContext({ config, name, version, command: "resume" });
  const result = await resumePipeline(ctx);
  if (result.ok) {
    if (result.ran.length > 0) {
      ctx.log.success(`resume complete — ran ${result.ran.join(" → ")}`);
    }
    return 0;
  }

  console.error(
    pc.dim(`still failing at "${result.failedStage}"; run \`sb status ${name}\` to inspect`),
  );
  return 1;
}
