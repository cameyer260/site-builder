import { parseArgs } from "node:util";
import pc from "picocolors";
import { loadConfigOrThrow } from "../config/store.ts";
import type { EngineKind } from "../engine/adapter.ts";
import { resumePipeline, resumeVersion } from "../pipeline/orchestrator.ts";
import { buildRunContext } from "../runtime.ts";
import { clientExists, clientPaths } from "../storage/layout.ts";
import { UserError } from "../util/errors.ts";

const USAGE =
  "usage: sb resume <client> [--engine <kind>] [--vibe <text>] [--style <text>] [--yes]";

export async function resumeCommand(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      engine: { type: "string" },
      vibe: { type: "string" },
      style: { type: "string" },
      yes: { type: "boolean", short: "y" },
    },
  });
  const name = positionals[0];
  if (!name) {
    throw new UserError("missing client name", USAGE);
  }

  const config = loadConfigOrThrow();
  if (!clientExists(config.root, name)) {
    throw new UserError(`no Client found for "${name}"`, "run `sb build` first");
  }

  // Resume targets the in-flight Site Version: the target a refresh recorded
  // before it failed, else the latest on disk (or v1 if generation never started).
  const paths = clientPaths(config.root, name);
  const version = resumeVersion(paths);

  const engineKinds = ["claudey", "codey", "opencode"] as const;
  if (values.engine !== undefined && !(engineKinds as readonly string[]).includes(values.engine)) {
    throw new UserError(
      `unknown engine: "${values.engine}"`,
      `valid engines: ${engineKinds.join(", ")}`,
    );
  }
  const engineKind = values.engine as EngineKind | undefined;

  const interactive = Boolean(process.stdin.isTTY) && !values.yes;
  const ctx = buildRunContext({
    config,
    name,
    version,
    command: "resume",
    engine: engineKind,
    interactive,
    vibe: values.vibe,
    style: values.style,
  });

  const result = await resumePipeline(ctx, {
    vibe: values.vibe,
    style: values.style,
    yes: values.yes,
  });
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
