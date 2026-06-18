import { spawn } from "node:child_process";
import type { Logger } from "../util/log.ts";
import type { McpConfig } from "./mcp.ts";

/**
 * The `claude -p` engine runner (ADR-0001). Each AI stage is a fresh headless
 * invocation that reads prior stages' on-disk artifacts; there is no session
 * continuity to preserve. The prompt is fed on stdin (not as a positional) so
 * it can never be swallowed by a preceding variadic flag like `--add-dir`.
 *
 * Containment (file edits, bash) is delegated to the `claudey` wrapper in
 * production, so no permission flags are sent by default; the bypass options
 * exist only for running against a raw `claude` binary inside a sandbox.
 */

export type PermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan";

/** One line of `--output-format stream-json` output, parsed loosely. */
export interface StreamEvent {
  type?: string;
  subtype?: string;
  [key: string]: unknown;
}

interface ResultEvent extends StreamEvent {
  type: "result";
  is_error?: boolean;
  result?: string;
  session_id?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: unknown;
}

/**
 * Quota telemetry the engine emits as a `rate_limit_event`. It fires on
 * essentially every run as informational status (`status: "allowed"` or
 * `"allowed_warning"`), *not* only when throttled — so the mere presence of the
 * event says nothing. Only `status: "rejected"` means the request was actually
 * blocked and the engine is now waiting for the window (`resetsAt`) to reset.
 */
interface RateLimitEvent extends StreamEvent {
  type: "rate_limit_event";
  rate_limit_info?: {
    status?: string;
    rateLimitType?: string;
    resetsAt?: number;
  };
}

/** The engine is actually throttled (blocked) only on a `rejected` status. */
function isThrottled(event: RateLimitEvent): boolean {
  return event.rate_limit_info?.status === "rejected";
}

export interface EngineOptions {
  /** The user/stage prompt; delivered to the engine on stdin. */
  prompt: string;
  /** Working directory the engine is scoped to (its primary tool-access root). */
  cwd: string;
  /** Model alias ("opus"/"sonnet") or full id ("claude-opus-4-8"). */
  model?: string;
  /** Extra directories the engine may read/write (`--add-dir`). */
  addDirs?: string[];
  /** Tool-orchestration directives appended to the system prompt. */
  appendSystemPrompt?: string;
  /** MCP servers to load (e.g. the Playwright fallback). Object or raw JSON/path. */
  mcpConfig?: McpConfig | string;
  /** Ignore all other MCP sources, using only `mcpConfig`. */
  strictMcpConfig?: boolean;
  /** Hard ceiling on spend for this invocation (`--max-budget-usd`). */
  maxBudgetUsd?: number;
  /** Don't persist the session to disk (stage runs are stateless). */
  noSessionPersistence?: boolean;
  /** Explicit permission mode; normally left unset (claudey handles it). */
  permissionMode?: PermissionMode;
  /** Bypass all permission checks — only for raw-claude sandbox use. */
  dangerouslySkipPermissions?: boolean;
  /** Extra/overriding environment variables for the child process. */
  env?: Record<string, string>;
  /** Environment variables to remove from the child (applied before `env`). */
  unsetEnv?: string[];
  /** Kill the engine after this many milliseconds. */
  timeoutMs?: number;
  /**
   * After the engine reports a *rejected* rate limit, abort the run if it then
   * produces no output for this long — rather than waiting out the full
   * `timeoutMs`. Only armed once the engine is genuinely throttled, so a busy
   * engine (e.g. a long, silent build) is never affected.
   */
  rateLimitGraceMs?: number;
  /** Logger to tee a one-line trace of each stream event to. */
  log?: Logger;
  /** Called with every parsed stream event (for persistence/inspection). */
  onEvent?: (event: StreamEvent) => void;
  /** Abort the run early. */
  signal?: AbortSignal;
}

export interface EngineResult {
  /** True only when the engine reported a successful result and exited cleanly. */
  ok: boolean;
  /** The final result text, if any. */
  resultText: string | null;
  isError: boolean;
  subtype?: string;
  sessionId?: string;
  numTurns?: number;
  durationMs?: number;
  totalCostUsd?: number;
  usage?: unknown;
  exitCode: number | null;
  /** Every parsed stream event, in order. */
  events: StreamEvent[];
  /** Failure reason for non-ok results (spawn error, no result, etc.). */
  error?: string;
  /** Tail of stderr, for diagnostics. */
  stderrTail?: string;
}

/**
 * Builds the engine argv (excluding the prompt, which goes on stdin). Pure and
 * order-stable so it can be asserted on directly in tests.
 */
export function buildEngineArgs(opts: EngineOptions): string[] {
  const args: string[] = ["--print", "--output-format", "stream-json", "--verbose"];

  if (opts.addDirs && opts.addDirs.length > 0) {
    args.push("--add-dir", ...opts.addDirs);
  }
  if (opts.mcpConfig !== undefined) {
    const value =
      typeof opts.mcpConfig === "string" ? opts.mcpConfig : JSON.stringify(opts.mcpConfig);
    args.push("--mcp-config", value);
    if (opts.strictMcpConfig) {
      args.push("--strict-mcp-config");
    }
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.appendSystemPrompt) {
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }
  if (opts.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  }
  if (opts.noSessionPersistence) {
    args.push("--no-session-persistence");
  }
  if (opts.permissionMode) {
    args.push("--permission-mode", opts.permissionMode);
  }
  if (opts.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  return args;
}

/** Parses line-delimited stream-json, tolerating blank and non-JSON lines. */
export function parseStreamJson(stdout: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed) as StreamEvent);
    } catch {
      // non-JSON noise (e.g. warnings) is ignored
    }
  }
  return events;
}

/**
 * Turns raw run outcomes into a success/failure verdict. A run is ok only when
 * a `result` event is present with `is_error` false and subtype `success`, and
 * the process exited cleanly.
 */
export function interpretResult(input: {
  events: StreamEvent[];
  exitCode: number | null;
  spawnError?: string;
  stderrTail?: string;
}): EngineResult {
  const { events, exitCode, spawnError, stderrTail } = input;

  const base = { events, exitCode, stderrTail, resultText: null, isError: true } as const;

  if (spawnError) {
    return { ...base, ok: false, error: spawnError };
  }

  const resultEvent = [...events].reverse().find((e) => e.type === "result") as
    | ResultEvent
    | undefined;
  if (!resultEvent) {
    return {
      ...base,
      ok: false,
      error:
        exitCode === 0
          ? "engine produced no result event"
          : `engine exited ${exitCode} with no result event`,
    };
  }

  const isError =
    resultEvent.is_error === true ||
    (resultEvent.subtype !== undefined && resultEvent.subtype !== "success");
  const ok = !isError && (exitCode === 0 || exitCode === null);

  return {
    ok,
    resultText: typeof resultEvent.result === "string" ? resultEvent.result : null,
    isError,
    subtype: resultEvent.subtype,
    sessionId: resultEvent.session_id,
    numTurns: resultEvent.num_turns,
    durationMs: resultEvent.duration_ms,
    totalCostUsd: resultEvent.total_cost_usd,
    usage: resultEvent.usage,
    exitCode,
    events,
    stderrTail,
    error: ok
      ? undefined
      : resultEvent.subtype && resultEvent.subtype !== "success"
        ? `engine result subtype "${resultEvent.subtype}"`
        : "engine reported an error",
  };
}

/** Grace given to the engine's process tree to tear down on SIGTERM before we SIGKILL it. */
const KILL_GRACE_MS = 5_000;
/**
 * After the direct child exits, how long to wait for stdout to drain (i.e. for
 * `close`) before resolving anyway. Bounds the hang when an orphaned grandchild
 * (e.g. the `claudey` wrapper's `docker run`) keeps the stdout pipe open.
 */
const EXIT_DRAIN_MS = 2_000;

/**
 * Spawns the engine, streams stream-json events (teeing a trace to the logger),
 * feeds the prompt on stdin, and resolves with a parsed success/failure verdict.
 * Never rejects: all failures are reported in the resolved EngineResult.
 */
export function runEngine(engineBin: string, opts: EngineOptions): Promise<EngineResult> {
  const args = buildEngineArgs(opts);
  const events: StreamEvent[] = [];
  let stdoutBuffer = "";
  let stderrTail = "";
  let spawnError: string | undefined;
  let killReason: string | undefined;

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of opts.unsetEnv ?? []) {
    delete childEnv[key];
  }
  Object.assign(childEnv, opts.env);

  return new Promise<EngineResult>((resolve) => {
    const child = spawn(engineBin, args, {
      cwd: opts.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      signal: opts.signal,
      // Own process group, so a timeout can reap the whole tree — not just the
      // direct child. With `engineBin` = `claudey` the tree is
      // wrapper → `docker run` → container; killing the lone wrapper orphans the
      // `docker run`, which keeps the stdout pipe open so `close` never fires.
      detached: true,
    });

    let settled = false;
    let exitDrainTimer: NodeJS.Timeout | null = null;
    let escalationTimer: NodeJS.Timeout | null = null;
    let rateLimited = false;
    let rateLimitTimer: NodeJS.Timeout | null = null;

    // A bare `child.kill()` signals only the direct child. Signal the whole
    // process group so the wrapper *and* its `docker run` go down together;
    // SIGTERM first so the wrapper can `docker kill` its container, with a
    // SIGKILL backstop for anything still alive (ADR-0001).
    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        child.kill(signal);
      }
    };

    // Tear the engine tree down for `reason` (timeout or rate-limit stall):
    // SIGTERM, then a SIGKILL backstop after the grace window. First reason wins.
    const terminate = (reason: string): void => {
      if (killReason) {
        return;
      }
      killReason = reason;
      killTree("SIGTERM");
      escalationTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
    };

    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => terminate(`engine timed out after ${opts.timeoutMs}ms`), opts.timeoutMs)
        : null;

    // Rate-limit stall watchdog: a throttled engine can sit silent for the full
    // wall-clock `timeoutMs` (5–30 min). Once the engine reports a *rejected*
    // rate limit, arm a much shorter deadline that any further output resets — a
    // backoff that recovers is left alone, but one that goes quiet is abandoned
    // fast. Never armed by the benign quota pings, so a busy engine is unaffected.
    const bumpRateLimitWatchdog = (): void => {
      if (!rateLimited || settled || opts.rateLimitGraceMs === undefined) {
        return;
      }
      if (rateLimitTimer) {
        clearTimeout(rateLimitTimer);
      }
      rateLimitTimer = setTimeout(
        () =>
          terminate(`engine stalled after a rate limit: no output for ${opts.rateLimitGraceMs}ms`),
        opts.rateLimitGraceMs,
      );
    };

    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      for (const t of [timer, rateLimitTimer, exitDrainTimer, escalationTimer]) {
        if (t) {
          clearTimeout(t);
        }
      }
      ingestLine(stdoutBuffer);
      if (killReason && !spawnError) {
        spawnError = killReason;
      }
      resolve(interpretResult({ events, exitCode: code, spawnError, stderrTail }));
    };

    const ingestLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      try {
        const event = JSON.parse(trimmed) as StreamEvent;
        events.push(event);
        opts.onEvent?.(event);
        if (event.type === "rate_limit_event") {
          // Most of these are benign quota pings (status "allowed"); only a
          // `rejected` status means the engine is genuinely blocked and may go
          // silent waiting for the window to reset. Warn/arm the stall watchdog
          // only then — otherwise this fires (falsely) on every run.
          if (isThrottled(event as RateLimitEvent)) {
            rateLimited = true;
            bumpRateLimitWatchdog();
            const graceNote =
              opts.rateLimitGraceMs !== undefined
                ? ` (aborts after ${Math.round(opts.rateLimitGraceMs / 1000)}s with no further output)`
                : "";
            opts.log?.warn(`engine rate limited by the API; waiting for it to clear${graceNote}`);
          } else {
            const status = (event as RateLimitEvent).rate_limit_info?.status ?? "unknown";
            opts.log?.info(`engine rate_limit_event (${status})`);
          }
        } else {
          opts.log?.info(
            `engine ${event.type ?? "event"}${event.subtype ? `:${event.subtype}` : ""}`,
          );
        }
      } catch {
        // non-JSON noise
      }
    };

    child.on("error", (err) => {
      spawnError =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `engine binary not found: ${engineBin}`
          : err.message;
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bumpRateLimitWatchdog();
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        ingestLine(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      bumpRateLimitWatchdog();
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    // `exit` fires the moment the direct child dies; `close` waits for every
    // stdio stream to end and may never come if an orphaned grandchild still
    // holds the stdout pipe. Resolve on `close` when it arrives (it carries the
    // fully-drained output), but fall back to `exit` after a short drain window
    // so a killed-but-orphaned tree can't hang the pipeline forever.
    child.on("exit", (code) => {
      if (settled || exitDrainTimer) {
        return;
      }
      exitDrainTimer = setTimeout(() => finish(code), EXIT_DRAIN_MS);
    });

    child.on("close", (code) => {
      finish(code);
    });

    // The prompt is delivered on stdin; swallow EPIPE if the child exits early.
    child.stdin.on("error", () => {});
    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}

/**
 * A human-facing failure reason for a non-ok engine run: the interpreted error
 * plus a compact tail of the child's stderr when present. Stage failures route
 * through this so a crash the engine printed only to stderr — never to the
 * stream-json result event (e.g. a `claudey` wrapper not forwarding stdin, or an
 * auth error) — is surfaced instead of silently dropped. See ADR-0001.
 */
export function engineFailureReason(result: EngineResult): string {
  const reason = result.error ?? "engine failed with no result";
  const tail = result.stderrTail?.trim();
  return tail ? `${reason} (stderr: ${tail.slice(-800)})` : reason;
}

/**
 * The shape of `runEngine`, so AI stages can accept an injected runner. Stages
 * default to the real `runEngine`; tests pass a fake that simulates the model
 * writing its on-disk artifacts, keeping the pipeline offline and deterministic.
 */
export type EngineRunner = (engineBin: string, opts: EngineOptions) => Promise<EngineResult>;
