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
  let timedOut = false;

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
    });

    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, opts.timeoutMs)
        : null;

    const ingestLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      try {
        const event = JSON.parse(trimmed) as StreamEvent;
        events.push(event);
        opts.onEvent?.(event);
        opts.log?.info(
          `engine ${event.type ?? "event"}${event.subtype ? `:${event.subtype}` : ""}`,
        );
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
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      ingestLine(stdoutBuffer);
      if (timedOut && !spawnError) {
        spawnError = `engine timed out after ${opts.timeoutMs}ms`;
      }
      resolve(interpretResult({ events, exitCode: code, spawnError, stderrTail }));
    });

    // The prompt is delivered on stdin; swallow EPIPE if the child exits early.
    child.stdin.on("error", () => {});
    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}

/**
 * The shape of `runEngine`, so AI stages can accept an injected runner. Stages
 * default to the real `runEngine`; tests pass a fake that simulates the model
 * writing its on-disk artifacts, keeping the pipeline offline and deterministic.
 */
export type EngineRunner = (engineBin: string, opts: EngineOptions) => Promise<EngineResult>;
