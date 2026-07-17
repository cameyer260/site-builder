import type { EngineOptions, EngineResult, StreamEvent } from "./runner.ts";

/**
 * Pluggable engine adapters (ADR-0010). Each adapter owns three things for its
 * CLI: the invocation dialect (argv + stdin), result parsing (verdict), and
 * whether it emits a parseable rate-limit signal.
 */

export type EngineKind = "claudey" | "codey" | "opencode";

export interface EngineAdapter {
  buildInvocation(opts: EngineOptions): { args: string[]; stdin?: string };
  interpretResult(input: {
    events: StreamEvent[];
    exitCode: number | null;
    spawnError?: string;
    stderrExcerpt?: string;
  }): EngineResult;
  watchesRateLimit: boolean;
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

/** Upper bound on an extracted error detail, so it stays a readable log line. */
const ERROR_DETAIL_CAP = 500;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Best-effort human message from an error-carrying stream event. The engines
 * don't share one payload shape — codey puts `message` at the top level,
 * opencode nests it under `error` (with the specifics under `error.data`) — so
 * the common spots are probed in turn, and the serialized event is the bounded
 * fallback: an ugly payload still beats discarding the only place the CLI said
 * *why* it failed.
 */
export function errorEventDetail(event: StreamEvent): string {
  const err = asRecord(event.error);
  const message =
    asString(event.message) ??
    asString(event.error) ??
    asString(asRecord(err?.data)?.message) ??
    asString(err?.message);
  const name = asString(err?.name);
  const detail =
    message !== undefined
      ? name !== undefined
        ? `${name}: ${message}`
        : message
      : JSON.stringify(event);
  return detail.length > ERROR_DETAIL_CAP ? `${detail.slice(0, ERROR_DETAIL_CAP)}…` : detail;
}

// ---------------------------------------------------------------------------
// claudey adapter
// ---------------------------------------------------------------------------

const claudeyAdapter: EngineAdapter = {
  buildInvocation(opts) {
    const args: string[] = ["--print", "--output-format", "stream-json", "--verbose"];
    if (opts.addDirs && opts.addDirs.length > 0) {
      args.push("--add-dir", ...opts.addDirs);
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
    // Locked effort level (ADR-0010): xhigh is Anthropic's recommended level for
    // coding/agentic work and is the only deliberate behavioral addition in Phase 1.
    args.push("--effort", "xhigh");
    return { args, stdin: opts.prompt };
  },

  interpretResult({ events, exitCode, spawnError, stderrExcerpt }) {
    const base = { events, exitCode, stderrExcerpt, resultText: null, isError: true } as const;
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
      stderrExcerpt,
      error: ok ? undefined : claudeyErrorText(resultEvent),
    };
  },

  watchesRateLimit: true,
};

/**
 * The failure reason for an erroring claudey result event. The verdict itself
 * (`is_error` / a non-success subtype) says only *that* it failed; when the
 * engine has something to say about *why* — an auth failure, an exhausted credit
 * balance, a refusal — it puts it in the result event's own `result` field, the
 * same slot a successful run uses for its answer. That text is often the only
 * record of the cause (nothing reaches stderr), so it's folded into the reason
 * rather than left behind in `resultText`. See ADR-0014.
 */
function claudeyErrorText(resultEvent: ResultEvent): string {
  const verdict =
    resultEvent.subtype && resultEvent.subtype !== "success"
      ? `engine result subtype "${resultEvent.subtype}"`
      : "engine reported an error";
  const detail = asString(resultEvent.result);
  if (detail === undefined) {
    return verdict;
  }
  const capped =
    detail.length > ERROR_DETAIL_CAP ? `${detail.slice(0, ERROR_DETAIL_CAP)}…` : detail;
  return `${verdict}: ${capped}`;
}

// ---------------------------------------------------------------------------
// codey adapter (Codex — `codex exec`)
// ---------------------------------------------------------------------------

/** Prepends an appendSystemPrompt value as a delimited XML block. */
function prependSystemBlock(prompt: string, systemPrompt: string | undefined): string {
  if (!systemPrompt) {
    return prompt;
  }
  return `<system>\n${systemPrompt}\n</system>\n\n${prompt}`;
}

const codeyAdapter: EngineAdapter = {
  buildInvocation(opts) {
    const args: string[] = ["exec"];
    if (opts.model) {
      args.push("--model", opts.model);
    }
    // Codex uses a config key/value pair for effort (--effort is not a valid flag — R0).
    args.push("-c", "model_reasoning_effort=xhigh");
    args.push("--json");
    // Always skip the git-repo check — synthesize runs in a non-git Client dir (R6).
    args.push("--skip-git-repo-check");
    if (opts.addDirs) {
      for (const dir of opts.addDirs) {
        args.push("--add-dir", dir);
      }
    }
    // Codex has no per-call system-prompt flag; prepend as a delimited block instead.
    args.push(prependSystemBlock(opts.prompt, opts.appendSystemPrompt));
    return { args }; // prompt is positional; no stdin
  },

  interpretResult({ events, exitCode, spawnError, stderrExcerpt }) {
    const base = { events, exitCode, stderrExcerpt, resultText: null, isError: true } as const;
    if (spawnError) {
      return { ...base, ok: false, error: spawnError };
    }
    const turnFailed = events.find((e) => e.type === "turn.failed");
    if (turnFailed) {
      return {
        ...base,
        ok: false,
        error: `engine reported turn.failed: ${errorEventDetail(turnFailed)}`,
      };
    }
    // Non-transient error event: ignore "Reconnecting… X/Y" notices (R4).
    const fatalError = events.find(
      (e) =>
        e.type === "error" &&
        !(typeof e.message === "string" && e.message.startsWith("Reconnecting")),
    );
    if (fatalError) {
      return {
        ...base,
        ok: false,
        error: `engine reported a fatal error: ${errorEventDetail(fatalError)}`,
      };
    }
    const turnCompleted = events.find((e) => e.type === "turn.completed");
    if (!turnCompleted || exitCode !== 0) {
      return {
        ...base,
        ok: false,
        error: !turnCompleted
          ? "engine produced no turn.completed event"
          : `engine exited ${exitCode}`,
      };
    }
    return {
      ok: true,
      resultText: codeyResultText(events),
      isError: false,
      usage: turnCompleted.usage,
      exitCode,
      events,
      stderrExcerpt,
    };
  },

  watchesRateLimit: false,
};

/** Extracts the last agent_message text from codey's item.completed events. */
function codeyResultText(events: StreamEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type !== "item.completed") {
      continue;
    }
    const item = e.item;
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const rec = item as Record<string, unknown>;
    if (rec.type !== "agent_message") {
      continue;
    }
    const text = rec.text;
    return typeof text === "string" ? text : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// opencode adapter (`opencode run`)
// ---------------------------------------------------------------------------

const opencodeAdapter: EngineAdapter = {
  buildInvocation(opts) {
    const args: string[] = ["run"];
    args.push("--variant", "max");
    args.push("--format", "json");
    // Always skip permission prompts (R1 — opencode's headless bypass flag).
    args.push("--dangerously-skip-permissions");
    // opencode does NOT honor the spawned process's cwd — it resolves its own
    // working/project directory and would otherwise write files into whatever
    // directory it discovers (e.g. the dir `sb` was launched from). `--dir`
    // pins it to the scoped cwd, the opencode analogue of codey's --add-dir.
    args.push("--dir", opts.cwd);
    if (opts.model) {
      args.push("-m", opts.model);
    }
    // opencode has no --add-dir / sandbox-mount flag; it has full filesystem
    // access under --dangerously-skip-permissions, so addDirs is a no-op here.
    // opencode has no per-call --system flag; prepend as a delimited block (R7).
    // The message must be the final trailing positional (matching the CLI spec).
    args.push(prependSystemBlock(opts.prompt, opts.appendSystemPrompt));
    return { args }; // prompt is positional; no stdin
  },

  interpretResult({ events, exitCode, spawnError, stderrExcerpt }) {
    const base = { events, exitCode, stderrExcerpt, resultText: null, isError: true } as const;
    if (spawnError) {
      return { ...base, ok: false, error: spawnError };
    }
    // Exit code is primary (R2 — step_finish may be absent in early exits),
    // but the error event's payload is the only place the CLI says *why* (it
    // prints nothing to stderr), so it's appended whenever one was emitted.
    const errorEvent = events.find((e) => e.type === "error");
    if (exitCode !== 0) {
      return {
        ...base,
        ok: false,
        error: errorEvent
          ? `engine exited ${exitCode}: ${errorEventDetail(errorEvent)}`
          : `engine exited ${exitCode}`,
      };
    }
    // A type:"error" event overrides a clean exit code.
    // step_finish reason is NOT checked: intermediate steps (e.g. tool_use)
    // also emit step_finish with a non-"stop" reason — that's normal flow,
    // not a failure. Exit code is the authoritative verdict (R2).
    if (errorEvent) {
      return {
        ...base,
        ok: false,
        error: `engine reported a fatal error: ${errorEventDetail(errorEvent)}`,
      };
    }
    return {
      ok: true,
      resultText: opencodeResultText(events),
      isError: false,
      exitCode,
      events,
      stderrExcerpt,
    };
  },

  watchesRateLimit: false,
};

/** Concatenates all text part values from opencode's `text` events. */
function opencodeResultText(events: StreamEvent[]): string | null {
  const parts: string[] = [];
  for (const e of events) {
    if (e.type !== "text") {
      continue;
    }
    const part = e.part as Record<string, unknown> | undefined;
    if (typeof part?.text === "string") {
      parts.push(part.text);
    }
  }
  const combined = parts.join("").trim();
  return combined || null;
}

// ---------------------------------------------------------------------------

export const ADAPTERS: Record<EngineKind, EngineAdapter> = {
  claudey: claudeyAdapter,
  codey: codeyAdapter,
  opencode: opencodeAdapter,
};
