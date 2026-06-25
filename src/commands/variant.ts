import { parseArgs } from "node:util";
import pc from "picocolors";
import { loadConfigOrThrow } from "../config/store.ts";
import type { EngineKind } from "../engine/adapter.ts";
import { runPush } from "../github/push.ts";
import { runVariant } from "../pipeline/orchestrator.ts";
import { stageNamesFor } from "../pipeline/pipeline.ts";
import { buildRunContext } from "../runtime.ts";
import { clientExists, clientPaths, nextVersion } from "../storage/layout.ts";
import { readState } from "../storage/state.ts";
import { UserError } from "../util/errors.ts";

const USAGE =
  "usage: sb variant <client> [--engine <kind>] [--vibe <text>] [--style <text>] [--github] [--yes]";

/**
 * `sb variant` — run the Generation phase only, into a *new* Site Version
 * (ADR-0002). Reuses the existing Context phase untouched; the new version is
 * the same Client context with a different Design Brief (steer it with
 * `--vibe`/`--style`). Kept a distinct verb from `build`/`resume` so a new take
 * is always explicit, never an accidental overwrite.
 */
export async function variantCommand(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      engine: { type: "string" },
      vibe: { type: "string" },
      style: { type: "string" },
      github: { type: "boolean" },
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

  // A variant needs a finished Context phase to build from.
  const paths = clientPaths(config.root, name);
  const contextState = readState(paths.state);
  const contextDone = stageNamesFor("context").every(
    (s) => contextState?.stages[s]?.status === "completed",
  );
  if (!contextDone) {
    throw new UserError(
      `the Context phase for "${name}" is not complete`,
      `run \`sb build ${name}\` (or \`sb resume ${name}\`) first`,
    );
  }

  const engineKinds = ["claudey", "codey", "opencode"] as const;
  if (values.engine !== undefined && !(engineKinds as readonly string[]).includes(values.engine)) {
    throw new UserError(
      `unknown engine: "${values.engine}"`,
      `valid engines: ${engineKinds.join(", ")}`,
    );
  }
  const engineKind = values.engine as EngineKind | undefined;

  const version = nextVersion(paths.sites);
  const interactive = Boolean(process.stdin.isTTY) && !values.yes;
  const ctx = buildRunContext({
    config,
    name,
    version,
    command: "variant",
    engine: engineKind,
    interactive,
    vibe: values.vibe,
    style: values.style,
  });
  ctx.log.step(`creating Site v${version} for "${name}"`);

  const result = await runVariant(ctx);
  if (!result.ok) {
    console.error(pc.dim(`run \`sb resume ${name}\` to retry from "${result.failedStage}"`));
    return 1;
  }

  ctx.log.success(`variant complete — Site v${version} ran ${result.ran.join(" → ")}`);
  if (values.github) {
    await runPush({ paths: ctx.paths, version, ghBin: config.ghBin, log: ctx.log });
  }
  return 0;
}
