import type { EngineOptions } from "./runner.ts";

/**
 * Shared engine wiring for the AI stages (synthesize/generate/audit). Keeps the
 * env scrubbing and permission policy in one place so every stage invokes
 * `claude -p` the same way.
 */

/**
 * Environment markers set when this process is itself running inside Claude Code.
 * They are unset on the spawned child so it behaves as a standalone engine and
 * not a nested session. Harmless when absent — the normal case when a user runs
 * `sb` from their own shell; needed only when developing/testing inside Claude Code.
 */
export const NESTED_CLAUDE_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_EXECPATH",
  "AI_AGENT",
  "CLAUDE_EFFORT",
];

/**
 * How long a stage tolerates silence *after* the engine reports a rate limit
 * before giving up. Generous enough to ride out a backoff that recovers (the
 * engine streams events again, resetting it), short enough that a stalled
 * throttle fails fast instead of burning the stage's full wall-clock timeout.
 */
export const STAGE_RATE_LIMIT_GRACE_MS = 120_000;

/**
 * Common EngineOptions for every AI stage. Permission containment is delegated
 * to the `claudey` wrapper by default (ADR-0001); when running against a raw
 * `claude` binary in a sandbox, opt into bypass with
 * `SB_DANGEROUSLY_SKIP_PERMISSIONS=1`.
 */
export function stageEngineDefaults(): Pick<
  EngineOptions,
  "unsetEnv" | "noSessionPersistence" | "dangerouslySkipPermissions" | "rateLimitGraceMs"
> {
  return {
    unsetEnv: NESTED_CLAUDE_MARKERS,
    noSessionPersistence: true,
    dangerouslySkipPermissions: process.env.SB_DANGEROUSLY_SKIP_PERMISSIONS === "1",
    rateLimitGraceMs: STAGE_RATE_LIMIT_GRACE_MS,
  };
}
