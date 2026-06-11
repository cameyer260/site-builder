import type { SiteBuilder } from "../astro/run.ts";
import type { SiteInspector } from "../audit/inspect.ts";
import type { LighthouseRunner } from "../audit/lighthouse.ts";
import type { Config } from "../config/schema.ts";
import type { DeployRunner } from "../deploy/wrangler.ts";
import type { EngineRunner } from "../engine/runner.ts";
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
  /**
   * Engine runner for the AI stages. Left unset in production (stages default
   * to the real `runEngine`); tests inject a fake to stay offline.
   */
  engine?: EngineRunner;
  /**
   * Compile gate for `generate`/`audit` (npm install + `astro build`). Unset in
   * production (defaults to the real one); full-pipeline tests inject a stub so
   * they don't shell out to npm.
   */
  buildSite?: SiteBuilder;
  /**
   * `audit`'s deterministic inspector (preview + screenshots + axe + link check).
   * Unset in production (defaults to the real one); tests inject a fake so they
   * don't serve the Site or launch a browser.
   */
  inspectSite?: SiteInspector;
  /**
   * `audit`'s Lighthouse Scorecard runner. Unset in production (defaults to the
   * real one); tests inject a fake so they don't launch Chrome.
   */
  runLighthouse?: LighthouseRunner;
  /**
   * `deploy`'s Cloudflare Pages upload runner. Unset in production (defaults to
   * the real wrangler one); tests inject a fake so they don't shell out to
   * wrangler or hit the network.
   */
  deploySite?: DeployRunner;
  /**
   * Whether the run may prompt the operator (the QA session gate). True only on
   * an interactive TTY without `--yes`; false in CI/tests → Unknowns become
   * Guessed (CONTEXT.md > QA session).
   */
  interactive?: boolean;
  /** Design Brief steering for `generate` (`--vibe`/`--style`). */
  vibe?: string;
  style?: string;
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
