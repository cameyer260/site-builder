import type { EngineOptions } from "./runner.ts";

/**
 * Shared engine wiring for the AI stages (synthesize/generate/audit). Keeps the
 * env scrubbing and stage defaults in one place so every stage invokes the engine
 * the same way (ADR-0010).
 */

/**
 * Environment markers set when this process is itself running inside a coding-
 * agent CLI (Claude Code, Codex, or OpenCode). They are unset on the spawned
 * child so it behaves as a standalone engine and not a nested session. The list
 * is the union of all three CLIs' markers so one shared scrub covers every engine.
 * Harmless when absent — the normal case when a user runs `sb` from their own shell.
 *
 * claudey (Claude Code): CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SESSION_ID,
 *   CLAUDE_CODE_EXECPATH, CLAUDE_CODE_CHILD_SESSION, CLAUDE_EFFORT, AI_AGENT
 * codey (Codex): CODEX_THREAD_ID, CODEX_CI
 *   (CODEX_HOME is intentionally omitted — it's config dir, not a session marker)
 * opencode: OPENCODE, OPENCODE_PID, AGENT
 */
export const NESTED_AGENT_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_EFFORT",
  "AI_AGENT",
  "CODEX_THREAD_ID",
  "CODEX_CI",
  "OPENCODE",
  "OPENCODE_PID",
  "AGENT",
];

/**
 * How long a stage tolerates silence *after* the engine reports a rate limit
 * before giving up. Generous enough to ride out a backoff that recovers (the
 * engine streams events again, resetting it), short enough that a stalled
 * throttle fails fast instead of burning the stage's full wall-clock timeout.
 * claudey-only; codey/opencode rely on timeoutMs alone (ADR-0010).
 */
export const STAGE_RATE_LIMIT_GRACE_MS = 120_000;

/**
 * Common EngineOptions for every AI stage. Permission containment is delegated
 * to each CLI's wrapper by default (ADR-0001/0010); when running against a raw
 * `claude` binary in a sandbox, opt into bypass with
 * `SB_DANGEROUSLY_SKIP_PERMISSIONS=1`.
 */
export function stageEngineDefaults(): Pick<
  EngineOptions,
  "unsetEnv" | "noSessionPersistence" | "dangerouslySkipPermissions" | "rateLimitGraceMs"
> {
  return {
    unsetEnv: NESTED_AGENT_MARKERS,
    noSessionPersistence: true,
    dangerouslySkipPermissions: process.env.SB_DANGEROUSLY_SKIP_PERMISSIONS === "1",
    rateLimitGraceMs: STAGE_RATE_LIMIT_GRACE_MS,
  };
}
