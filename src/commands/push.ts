import { parseArgs } from "node:util";
import { loadConfigOrThrow } from "../config/store.ts";
import { runPush } from "../github/push.ts";
import { buildRunContext } from "../runtime.ts";
import { clientExists, clientPaths, latestVersion } from "../storage/layout.ts";
import { UserError } from "../util/errors.ts";

const USAGE = "usage: sb push <client> [--version <n>]";

/**
 * `sb push` — publish a Site Version's source to a new private GitHub repo and
 * record the remote (ADR-0004). The opt-in counterpart to `build`/`variant
 * --github`, for publishing a Site Version that was generated without it.
 */
export async function pushCommand(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { version: { type: "string" } },
  });
  const name = positionals[0];
  if (!name) {
    throw new UserError("missing client name", USAGE);
  }

  const config = loadConfigOrThrow();
  if (!clientExists(config.root, name)) {
    throw new UserError(`no Client found for "${name}"`, "run `sb build` first");
  }

  const paths = clientPaths(config.root, name);
  const latest = latestVersion(paths.sites);
  if (!latest) {
    throw new UserError(`no Site Version exists for "${name}"`, "run `sb build` first");
  }

  let version = latest;
  if (values.version !== undefined) {
    version = Number(values.version);
    if (!Number.isInteger(version) || version <= 0) {
      throw new UserError(`--version expects a positive integer, got "${values.version}"`);
    }
  }

  const ctx = buildRunContext({ config, name, version, command: "push" });
  await runPush({ paths, version, ghBin: config.ghBin, log: ctx.log });
  return 0;
}
