import { spawn } from "node:child_process";
import type { Logger } from "../util/log.ts";
import { ADAPTERS, type EngineAdapter, type EngineKind, errorEventDetail } from "./adapter.ts";

/**
 * Generic engine runner (ADR-0001/0010). Keeps all process lifecycle (spawn,
 * process-group kill, timeout, drain) engine-agnostic; per-CLI invocation and
 * result parsing are delegated to the ADAPTERS map. claudey is the default.
 *
 * Containment (file edits, bash) is delegated to each CLI's wrapper by default,
 * so no permission flags are sent here; the bypass option exists only for
 * running against a raw binary inside a sandbox.
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

/**
 * Quota telemetry the claudey engine emits as a `rate_limit_event`. It fires on
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
  /** The user/stage prompt; delivered to the engine per-adapter (stdin or positional). */
  prompt: string;
  /** Working directory the engine is scoped to (its primary tool-access root). */
  cwd: string;
  /** Engine kind to dispatch to; defaults to `"claudey"`. */
  engine?: EngineKind;
  /** Model alias ("opus"/"sonnet") or full id ("claude-opus-4-8"). */
  model?: string;
  /** Extra directories the engine may read/write (`--add-dir`). */
  addDirs?: string[];
  /** Tool-orchestration directives appended to the system prompt (claudey) or prepended to the prompt (codey/opencode). */
  appendSystemPrompt?: string;
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
   * engine (e.g. a long, silent build) is never affected. claudey-only.
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
  /**
   * Bounded excerpt of stderr, for diagnostics: the start and end of what the
   * engine printed, elided in the middle when it's long. Keeping both ends
   * (not just a tail) matters when the failure is a repeating error (e.g. an
   * engine writing to an already-broken pipe on every attempt) — a tail-only
   * window fills up with copies of the *last* repeat and loses the first,
   * usually-causal, line.
   */
  stderrExcerpt?: string;
}

/**
 * Backward-compatible re-export: builds the claudey argv from engine options.
 * Pure and order-stable so it can be asserted on directly in tests.
 */
export function buildEngineArgs(opts: EngineOptions): string[] {
  return ADAPTERS.claudey.buildInvocation(opts).args;
}

/**
 * Parses one line of stream-json into an event, or null for a blank/non-JSON
 * line. The single shared parse primitive: the live streaming path (`runEngine`)
 * and the batch `parseStreamJson` both go through it, so "what counts as an
 * event" has exactly one definition.
 */
export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as StreamEvent;
  } catch {
    // non-JSON noise (e.g. warnings) is ignored
    return null;
  }
}

/** Parses a full stream-json buffer, tolerating blank and non-JSON lines. */
export function parseStreamJson(stdout: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of stdout.split("\n")) {
    const event = parseStreamLine(line);
    if (event) {
      events.push(event);
    }
  }
  return events;
}

/**
 * Backward-compatible re-export: turns raw run outcomes into a success/failure
 * verdict using the claudey adapter's logic.
 */
export function interpretResult(input: {
  events: StreamEvent[];
  exitCode: number | null;
  spawnError?: string;
  stderrExcerpt?: string;
}): EngineResult {
  return ADAPTERS.claudey.interpretResult(input);
}

/** Grace given to the engine's process tree to tear down on SIGTERM before we SIGKILL it. */
const KILL_GRACE_MS = 5_000;
/**
 * After the direct child exits, how long to wait for stdout to drain (i.e. for
 * `close`) before resolving anyway. Bounds the hang when an orphaned grandchild
 * (e.g. the `claudey` wrapper's `docker run`) keeps the stdout pipe open.
 */
const EXIT_DRAIN_MS = 2_000;

/** How much of stderr's start and end are kept for the diagnostic excerpt. */
const STDERR_EXCERPT_CAP = 2_000;

/** Longest repeating block (in lines) `collapseRepeats` looks for. */
const COLLAPSE_MAX_PERIOD = 20;

/**
 * Collapses immediate repeats of the same multi-line block — e.g. an engine
 * writing the same error object to stderr on every failed write — into one
 * copy plus a repeat count. Without this, a bounded excerpt window can end up
 * holding a dozen copies of one stanza and nothing else, which is exactly the
 * "buries the causal line" failure `composeStderrExcerpt` otherwise guards
 * against. Only exact, immediately-adjacent repeats collapse (no fuzzy
 * matching), so distinct lines — including near-duplicates that differ by a
 * line number — are left alone.
 */
function collapseRepeats(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const maxPeriod = Math.min(COLLAPSE_MAX_PERIOD, Math.floor((lines.length - i) / 2));
    let collapsed = false;
    // Smallest period first: a coarser period that happens to also repeat
    // (e.g. 2 stanzas of a 1-stanza-periodic block) would still pass the
    // exact-match check but collapse far less tightly than the true unit.
    for (let period = 1; period <= maxPeriod; period++) {
      const block = lines.slice(i, i + period).join("\n");
      if (block === "" || lines.slice(i + period, i + period * 2).join("\n") !== block) {
        continue;
      }
      let repeats = 2;
      let cursor = i + period * 2;
      while (
        cursor + period <= lines.length &&
        lines.slice(cursor, cursor + period).join("\n") === block
      ) {
        repeats++;
        cursor += period;
      }
      out.push(block, `…(repeated ${repeats}×)…`);
      i = cursor;
      collapsed = true;
      break;
    }
    if (!collapsed) {
      out.push(lines[i] ?? "");
      i++;
    }
  }
  return out.join("\n");
}

/**
 * Composes the stderr excerpt from a bounded head and a rolling tail: when the
 * whole stream fit in the tail's window, it already holds everything, so it's
 * returned as-is; otherwise the head (likely the causal first line) and tail
 * (the final state) are shown with an elision marker for what's in between.
 * Each window is independently collapsed first, so a stanza an engine spams
 * on every attempt doesn't crowd out everything around it.
 */
function composeStderrExcerpt(head: string, tail: string, totalLen: number): string {
  if (totalLen <= STDERR_EXCERPT_CAP) {
    return collapseRepeats(tail);
  }
  const collapsedHead = collapseRepeats(head);
  const collapsedTail = collapseRepeats(tail);
  const omitted = totalLen - head.length - tail.length;
  return omitted > 0
    ? `${collapsedHead}\n…[${omitted} more chars]…\n${collapsedTail}`
    : `${collapsedHead}${collapsedTail}`;
}

interface ActiveEngine {
  terminate: (reason: string) => void;
  settled: Promise<void>;
}

/**
 * Every in-flight `runEngine` call, so a top-level signal handler can reap them
 * on shutdown. Each engine is spawned `detached: true` in its own process group
 * so `killTree` can reach the whole tree (ADR-0001) — but that same detachment
 * means the terminal's own Ctrl+C (SIGINT) is delivered to sb's process group
 * only, never to the engine's. Without this registry, cancelling `sb build`
 * orphans the engine, which keeps running standalone (observed with opencode
 * spinning on EPIPE against its now-closed stdout pipe after such a cancel).
 */
const activeEngines = new Set<ActiveEngine>();

/**
 * Signals every in-flight engine's process tree to terminate — the same
 * SIGTERM-then-SIGKILL escalation `runEngine` already uses for timeouts — and
 * waits for each to actually exit, bounded so a hung engine can't block sb's
 * own shutdown forever. Called from bin/sb.ts's SIGINT/SIGTERM handler.
 */
export async function killActiveEngines(reason: string): Promise<void> {
  const entries = [...activeEngines];
  if (entries.length === 0) {
    return;
  }
  for (const entry of entries) {
    entry.terminate(reason);
  }
  await Promise.race([
    Promise.all(entries.map((entry) => entry.settled)),
    new Promise<void>((resolve) => setTimeout(resolve, KILL_GRACE_MS + 1_000)),
  ]);
}

/**
 * Spawns the engine, streams events (teeing a trace to the logger), delivers
 * the prompt per-adapter, and resolves with a parsed success/failure verdict.
 * Never rejects: all failures are reported in the resolved EngineResult.
 */
export function runEngine(engineBin: string, opts: EngineOptions): Promise<EngineResult> {
  const adapter: EngineAdapter = ADAPTERS[opts.engine ?? "claudey"];
  const { args, stdin } = adapter.buildInvocation(opts);
  const events: StreamEvent[] = [];
  let stdoutBuffer = "";
  let stderrHead = "";
  let stderrTail = "";
  let stderrTotal = 0;
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

    let markSettled = (): void => {};
    const activeEntry: ActiveEngine = {
      terminate,
      settled: new Promise<void>((resolve) => {
        markSettled = resolve;
      }),
    };
    activeEngines.add(activeEntry);

    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => terminate(`engine timed out after ${opts.timeoutMs}ms`), opts.timeoutMs)
        : null;

    // Rate-limit stall watchdog: claudey-only (adapter.watchesRateLimit). A
    // throttled claudey engine can sit silent for the full wall-clock `timeoutMs`
    // (5–30 min). Once the engine reports a *rejected* rate limit, arm a much
    // shorter deadline that any further output resets — a backoff that recovers is
    // left alone, but one that goes quiet is abandoned fast. Never armed by the
    // benign quota pings, so a busy engine is unaffected.
    const bumpRateLimitWatchdog = (): void => {
      if (
        !adapter.watchesRateLimit ||
        !rateLimited ||
        settled ||
        opts.rateLimitGraceMs === undefined
      ) {
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
      activeEngines.delete(activeEntry);
      markSettled();
      ingestLine(stdoutBuffer);
      if (killReason && !spawnError) {
        spawnError = killReason;
      }
      const stderrExcerpt = composeStderrExcerpt(stderrHead, stderrTail, stderrTotal);
      resolve(adapter.interpretResult({ events, exitCode: code, spawnError, stderrExcerpt }));
    };

    const ingestLine = (line: string): void => {
      const event = parseStreamLine(line);
      if (!event) {
        return;
      }
      events.push(event);
      opts.onEvent?.(event);
      if (adapter.watchesRateLimit && event.type === "rate_limit_event") {
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
      } else if (event.type === "error") {
        // An error event's payload is often the only record of *why* a run
        // died (some engines exit non-zero with a silent stderr); trace it in
        // full so the build log keeps the cause, not just the event type.
        opts.log?.warn(`engine error: ${errorEventDetail(event)}`);
      } else {
        opts.log?.info(
          `engine ${event.type ?? "event"}${event.subtype ? `:${event.subtype}` : ""}`,
        );
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
      stderrTotal += chunk.length;
      if (stderrHead.length < STDERR_EXCERPT_CAP) {
        stderrHead += chunk;
      }
      stderrTail = (stderrTail + chunk).slice(-STDERR_EXCERPT_CAP);
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

    // Deliver the prompt per-adapter: claudey uses stdin; codey/opencode use a
    // positional arg (stdin is undefined) so we just close the pipe.
    child.stdin.on("error", () => {});
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

/**
 * The short, human-facing failure reason for a non-ok engine run: the
 * interpreted error alone, one line. Safe as a stage's UserError *message*,
 * which `markFailed` persists into `state.json` and every warn line prints
 * verbatim. The bulky diagnostics are {@link engineFailureDetail}'s job — the
 * two are deliberately split so a kilobyte of engine stderr can reach the
 * operator without also being written into state or stacked onto a warning.
 */
export function engineFailureReason(result: EngineResult): string {
  return result.error ?? "engine failed with no result";
}

/**
 * The bulky diagnostic for a non-ok engine run — what the engine printed to
 * stderr — or undefined when it printed nothing. Stage failures pass this as the
 * UserError *hint* so a crash the engine reported only on stderr, never in its
 * result event (e.g. a `claudey` wrapper not forwarding stdin, or an auth
 * error), is surfaced instead of silently dropped. See ADR-0001. Doesn't
 * re-truncate the excerpt: `composeStderrExcerpt` already bounded it, and
 * slicing from the end again would cut off exactly the causal first line it was
 * built to keep.
 */
export function engineFailureDetail(result: EngineResult): string | undefined {
  const excerpt = result.stderrExcerpt?.trim();
  return excerpt ? `engine stderr:\n${excerpt}` : undefined;
}

/**
 * Tees an engine failure's detail to the log at info level, under `label`.
 * For the best-effort calls (asset classification, the Design Brief) that warn
 * and carry on with a fallback: the warning stays one readable line while the
 * diagnostic still lands in the build log. Stage-fatal calls don't use this —
 * they pass the detail as a UserError hint, which reaches the console.
 */
export function logEngineFailureDetail(result: EngineResult, log: Logger, label: string): void {
  const detail = engineFailureDetail(result);
  if (detail) {
    log.info(`${label}: ${detail}`);
  }
}

/**
 * The shape of `runEngine`, so AI stages can accept an injected runner. Stages
 * default to the real `runEngine`; tests pass a fake that simulates the model
 * writing its on-disk artifacts, keeping the pipeline offline and deterministic.
 */
export type EngineRunner = (engineBin: string, opts: EngineOptions) => Promise<EngineResult>;
