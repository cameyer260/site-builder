import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config/schema.ts";
import type { EngineKind } from "./engine/adapter.ts";
import { resolveEffort, resolveModel } from "./engine/tiers.ts";
import type { RunContext } from "./pipeline/types.ts";
import type { ClientInputs } from "./storage/client.ts";
import { clientPaths } from "./storage/layout.ts";
import { createLogger } from "./util/log.ts";
import { nowIso } from "./util/time.ts";

/**
 * Assembles a RunContext for a command invocation: resolves the Engine selection
 * (flag → defaultEngine), binds engine kind/bin/modelFor, bootstraps the
 * directory + logs/, and wires the `SB_STUB_FAIL` injection hook.
 */
export function buildRunContext(opts: {
  config: Config;
  name: string;
  version: number;
  command: string;
  engine?: EngineKind;
  inputs?: ClientInputs;
  pageCap?: number;
  interactive?: boolean;
  vibe?: string;
  style?: string;
}): RunContext {
  const engineKind: EngineKind = opts.engine ?? opts.config.defaultEngine;
  const engineProfile = opts.config.engines[engineKind];
  const engineBin = engineProfile.bin;
  const modelFor = (stage: string): string => resolveModel(engineProfile, stage);
  const effortFor = (stage: string): string => resolveEffort(engineProfile, stage);

  const paths = clientPaths(opts.config.root, opts.name);
  mkdirSync(paths.dir, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });

  const stamp = nowIso().replace(/[:.]/g, "-");
  const log = createLogger({ file: join(paths.logs, `${stamp}-${opts.command}.log`) });

  return {
    config: opts.config,
    paths,
    version: opts.version,
    engineKind,
    engineBin,
    modelFor,
    effortFor,
    pageCap: opts.pageCap,
    log,
    failAt: process.env.SB_STUB_FAIL || undefined,
    inputs: opts.inputs,
    interactive: opts.interactive,
    vibe: opts.vibe,
    style: opts.style,
  };
}
