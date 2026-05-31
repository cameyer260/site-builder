import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config/schema.ts";
import type { RunContext } from "./pipeline/types.ts";
import type { ClientInputs } from "./storage/client.ts";
import { clientPaths } from "./storage/layout.ts";
import { createLogger } from "./util/log.ts";

/**
 * Assembles a RunContext for a command invocation: resolves the Client's paths,
 * bootstraps the directory + logs/ so the run is loggable from the first stage,
 * opens a per-run log file, and wires the `SB_STUB_FAIL` injection hook.
 */
export function buildRunContext(opts: {
  config: Config;
  name: string;
  version: number;
  command: string;
  inputs?: ClientInputs;
}): RunContext {
  const paths = clientPaths(opts.config.root, opts.name);
  mkdirSync(paths.dir, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const log = createLogger({ file: join(paths.logs, `${stamp}-${opts.command}.log`) });

  return {
    config: opts.config,
    paths,
    version: opts.version,
    log,
    failAt: process.env.SB_STUB_FAIL || undefined,
    inputs: opts.inputs,
  };
}
