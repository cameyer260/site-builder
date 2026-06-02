import type { Config } from "../config/schema.ts";
import type { ClientInputs } from "../storage/client.ts";
import type { ClientPaths } from "../storage/layout.ts";
import type { Logger } from "../util/log.ts";

export type Phase = "context" | "generation";

/** Everything a stage needs to run. Assembled per command invocation. */
export interface RunContext {
  config: Config;
  paths: ClientPaths;
  /** The active Site Version this run targets. */
  version: number;
  /** Effective crawl page cap for this run (`--pages` override, else config). */
  pageCap?: number;
  log: Logger;
  /**
   * Test/dev hook (from `SB_STUB_FAIL`): forces the named stub stage to throw,
   * so resume/state behavior can be exercised. Removed once stages are real.
   */
  failAt?: string;
  /**
   * The Inputs gathered by `build` for a brand-new Client. Consumed by `init`
   * to write `client.json`; absent on resume (the record already exists).
   */
  inputs?: ClientInputs;
}

export interface Stage {
  readonly name: string;
  readonly phase: Phase;
  run(ctx: RunContext): Promise<void>;
  /**
   * Filesystem paths this stage owns. On resume, the failed stage's outputs are
   * removed (clear-own-output) before re-running, while earlier stages' outputs
   * are kept (keep-prior). Must never include a `state.json`.
   */
  outputs(ctx: RunContext): string[];
}
