import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, errorEventDetail } from "../src/engine/adapter.ts";
import {
  buildEngineArgs,
  type EngineOptions,
  engineFailureDetail,
  engineFailureReason,
  interpretResult,
  parseStreamJson,
  runEngine,
  type StreamEvent,
} from "../src/engine/runner.ts";
import type { Logger } from "../src/util/log.ts";

const FAKE_ENGINE = join(import.meta.dir, "fixtures", "fake-engine.ts");

function opts(partial: Partial<EngineOptions> & { cwd: string }): EngineOptions {
  return { prompt: "hi", ...partial };
}

// ---- buildEngineArgs (pure) ----------------------------------------------

test("buildEngineArgs always requests streaming print output", () => {
  const args = buildEngineArgs(opts({ cwd: "/x" }));
  expect(args.slice(0, 4)).toEqual(["--print", "--output-format", "stream-json", "--verbose"]);
});

test("buildEngineArgs never includes the prompt (it goes on stdin)", () => {
  const args = buildEngineArgs(opts({ cwd: "/x", prompt: "secret prompt text" }));
  expect(args).not.toContain("secret prompt text");
});

test("buildEngineArgs maps options to flags", () => {
  const args = buildEngineArgs(
    opts({
      cwd: "/x",
      model: "claude-opus-4-8",
      addDirs: ["/a", "/b"],
      appendSystemPrompt: "use the Kit",
      maxBudgetUsd: 2,
      noSessionPersistence: true,
      dangerouslySkipPermissions: true,
    }),
  );
  expect(args).toContain("--model");
  expect(args).toContain("claude-opus-4-8");
  // --add-dir is variadic with both dirs following it
  const di = args.indexOf("--add-dir");
  expect(args.slice(di + 1, di + 3)).toEqual(["/a", "/b"]);
  expect(args).toContain("--append-system-prompt");
  expect(args).toContain("--max-budget-usd");
  expect(args).toContain("--no-session-persistence");
  expect(args).toContain("--dangerously-skip-permissions");
});

// ---- parseStreamJson (pure) ----------------------------------------------

test("parseStreamJson reads JSONL and skips noise", () => {
  const stdout = [
    '{"type":"system"}',
    "",
    "not json",
    '{"type":"result","subtype":"success"}',
  ].join("\n");
  const events = parseStreamJson(stdout);
  expect(events.map((e) => e.type)).toEqual(["system", "result"]);
});

// ---- interpretResult (pure) ----------------------------------------------

function ev(e: StreamEvent): StreamEvent {
  return e;
}

test("interpretResult: clean success", () => {
  const r = interpretResult({
    events: [
      ev({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "s1" }),
    ],
    exitCode: 0,
  });
  expect(r.ok).toBe(true);
  expect(r.resultText).toBe("done");
  expect(r.sessionId).toBe("s1");
});

test("interpretResult: error subtype is a failure", () => {
  const r = interpretResult({
    events: [ev({ type: "result", subtype: "error_max_turns", is_error: true })],
    exitCode: 0,
  });
  expect(r.ok).toBe(false);
  expect(r.subtype).toBe("error_max_turns");
  expect(r.error).toContain("error_max_turns");
});

test("interpretResult: no result event is a failure", () => {
  const r = interpretResult({ events: [ev({ type: "system" })], exitCode: 0 });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("no result event");
});

test("interpretResult: an erroring result event carries the engine's own text, not a bare verdict", () => {
  // Where claudey puts the *why* (auth, credit balance, a refusal): the result
  // event's own `result` field. A bare "engine reported an error" loses it.
  const r = interpretResult({
    events: [
      ev({ type: "result", is_error: true, result: "Credit balance is too low to continue" }),
    ],
    exitCode: 0,
  });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("Credit balance is too low");
});

test("interpretResult: an erroring result event with no text falls back to the verdict", () => {
  const r = interpretResult({ events: [ev({ type: "result", is_error: true })], exitCode: 0 });
  expect(r.ok).toBe(false);
  expect(r.error).toBe("engine reported an error");
});

test("engineFailureReason: stays a short one-liner, with stderr split into the detail", () => {
  // The real failure mode: no result event, exit 1, the cause on stderr only.
  // The reason is what lands in state.json, so the excerpt must not be inlined.
  const r = interpretResult({
    events: [],
    exitCode: 1,
    stderrExcerpt: "Error: Input must be provided either through stdin or as a prompt argument\n",
  });
  expect(engineFailureReason(r)).toBe("engine exited 1 with no result event");
  expect(engineFailureDetail(r)).toContain("stdin");
});

test("engineFailureDetail: is undefined when the engine printed no stderr", () => {
  const r = interpretResult({ events: [], exitCode: 1, stderrExcerpt: "  " });
  expect(engineFailureDetail(r)).toBeUndefined();
});

test("interpretResult: spawn error short-circuits", () => {
  const r = interpretResult({
    events: [],
    exitCode: null,
    spawnError: "engine binary not found: nope",
  });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("not found");
});

test("interpretResult: success event but non-zero exit is a failure", () => {
  const r = interpretResult({
    events: [ev({ type: "result", subtype: "success", is_error: false })],
    exitCode: 2,
  });
  expect(r.ok).toBe(false);
});

// ---- runEngine (integration, against the fake engine) ---------------------

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sb-engine-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("runEngine: success path writes a file in the scoped cwd and parses success", async () => {
  const result = await runEngine(FAKE_ENGINE, { prompt: "make a file", cwd: dir });
  expect(result.ok).toBe(true);
  expect(result.resultText).toBe("done");
  expect(result.sessionId).toBe("fake-123");
  // proves cwd scoping + unattended file write reach the parsed result
  const touched = join(dir, "engine-touched.txt");
  expect(existsSync(touched)).toBe(true);
  expect(readFileSync(touched, "utf8")).toBe("ok");
}, 20_000);

test("runEngine: failure path is detected from the result event + exit code", async () => {
  const result = await runEngine(FAKE_ENGINE, { prompt: "please FAIL now", cwd: dir });
  expect(result.ok).toBe(false);
  expect(result.isError).toBe(true);
  expect(result.subtype).toBe("error_during_execution");
  expect(result.exitCode).toBe(1);
}, 20_000);

test("runEngine: missing binary resolves to a failure (never throws)", async () => {
  const result = await runEngine(join(dir, "does-not-exist"), { prompt: "x", cwd: dir });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("not found");
}, 20_000);

test("runEngine: a repeating stderr error keeps the causal first line, not just the last repeat", async () => {
  const result = await runEngine(FAKE_ENGINE, { prompt: "STDERR_SPAM", cwd: dir });
  expect(result.ok).toBe(false);
  // A tail-only window would have this pushed out by the trailing spam.
  expect(engineFailureDetail(result)).toContain("FATAL: root cause line");
}, 20_000);

test("runEngine: an identically-repeating stderr stanza is collapsed, not spammed verbatim", async () => {
  const result = await runEngine(FAKE_ENGINE, { prompt: "STDERR_IDENTICAL_REPEAT", cwd: dir });
  expect(result.ok).toBe(false);
  const excerpt = result.stderrExcerpt ?? "";
  expect(excerpt).toContain("(repeated");
  // Uncollapsed, this stanza would appear 30 times in the excerpt.
  const occurrences = excerpt.split("EPIPE: broken pipe, write").length - 1;
  expect(occurrences).toBeLessThan(5);
}, 20_000);

test("runEngine: an error event's payload is traced to the log, not just its type", async () => {
  const warns: string[] = [];
  const log: Logger = {
    info: () => {},
    step: () => {},
    success: () => {},
    warn: (m) => warns.push(m),
    error: () => {},
  };
  const result = await runEngine(FAKE_ENGINE, { prompt: "ERROR_EVENT", cwd: dir, log });
  expect(result.ok).toBe(false);
  // The build log must keep the cause — a bare "engine error" trace loses it.
  expect(warns.join("\n")).toContain("ProviderModelNotFoundError: model not found: nope/nope-9");
}, 20_000);

test("runEngine: a rate-limit stall is abandoned after the grace window, not the timeout", async () => {
  const result = await runEngine(FAKE_ENGINE, {
    prompt: "RATE_LIMIT_STALL",
    cwd: dir,
    rateLimitGraceMs: 500,
    // Far above the grace: proves the watchdog — not the wall-clock ceiling — fired.
    timeoutMs: 30_000,
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("stalled after a rate limit");
}, 20_000);

test("runEngine: a benign quota ping does NOT arm the stall watchdog", async () => {
  const result = await runEngine(FAKE_ENGINE, {
    prompt: "BENIGN_STALL",
    cwd: dir,
    // Tiny grace, larger timeout: if an "allowed" ping wrongly armed the watchdog
    // it would fire first and report a rate-limit stall. Correct behaviour is to
    // ignore it and let only the wall-clock timeout end the run.
    rateLimitGraceMs: 200,
    timeoutMs: 1500,
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("timed out");
  expect(result.error).not.toContain("stalled after a rate limit");
}, 20_000);

// ---- codey adapter (pure) ------------------------------------------------

function codeyInterpret(
  evs: StreamEvent[],
  exitCode: number | null,
  extra?: { spawnError?: string },
) {
  return ADAPTERS.codey.interpretResult({ events: evs, exitCode, ...extra });
}

function codeyArgs(partial: Partial<EngineOptions> & { cwd?: string }): string[] {
  return ADAPTERS.codey.buildInvocation({ prompt: "hi", cwd: "/x", ...partial }).args;
}

test("codey buildInvocation: always starts with exec + effort + json + git-check flags", () => {
  const args = codeyArgs({});
  expect(args[0]).toBe("exec");
  expect(args).toContain("-c");
  expect(args[args.indexOf("-c") + 1]).toBe("model_reasoning_effort=medium");
  expect(args).toContain("--json");
  expect(args).toContain("--skip-git-repo-check");
});

test("codey buildInvocation: prompt is the last positional arg (no stdin)", () => {
  const result = ADAPTERS.codey.buildInvocation({ prompt: "do the thing", cwd: "/x" });
  expect(result.args[result.args.length - 1]).toBe("do the thing");
  expect(result.stdin).toBeUndefined();
});

test("codey buildInvocation: model flag inserted before effort flags", () => {
  const args = codeyArgs({ model: "gpt-5.5" });
  expect(args).toContain("--model");
  expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.5");
});

test("codey buildInvocation: appendSystemPrompt is prepended as XML block", () => {
  const result = ADAPTERS.codey.buildInvocation({
    prompt: "build the site",
    cwd: "/x",
    appendSystemPrompt: "Use the Kit.",
  });
  const prompt = result.args[result.args.length - 1] as string;
  expect(prompt).toContain("<system>");
  expect(prompt).toContain("Use the Kit.");
  expect(prompt).toContain("</system>");
  expect(prompt).toContain("build the site");
  expect(prompt.indexOf("</system>")).toBeLessThan(prompt.indexOf("build the site"));
});

test("codey buildInvocation: --add-dir emits one flag per directory", () => {
  const args = codeyArgs({ addDirs: ["/a", "/b"] });
  const first = args.indexOf("--add-dir");
  expect(first).toBeGreaterThan(-1);
  expect(args[first + 1]).toBe("/a");
  const second = args.indexOf("--add-dir", first + 1);
  expect(second).toBeGreaterThan(first);
  expect(args[second + 1]).toBe("/b");
});

test("codey watchesRateLimit is false", () => {
  expect(ADAPTERS.codey.watchesRateLimit).toBe(false);
});

test("codey interpretResult: success — turn.completed + exit 0", () => {
  const evs: StreamEvent[] = [
    { type: "thread.started" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "PING" } },
    { type: "turn.completed", usage: { output_tokens: 32 } },
  ];
  const r = codeyInterpret(evs, 0);
  expect(r.ok).toBe(true);
  expect(r.resultText).toBe("PING");
  expect((r.usage as Record<string, unknown>)?.output_tokens).toBe(32);
});

test("codey interpretResult: turn.failed → failure", () => {
  const evs: StreamEvent[] = [
    { type: "turn.started" },
    { type: "turn.failed", reason: "max_tokens" },
  ];
  const r = codeyInterpret(evs, 1);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("turn.failed");
});

test("codey interpretResult: transient Reconnecting error is ignored, success still ok", () => {
  const evs: StreamEvent[] = [
    { type: "turn.started" },
    { type: "error", message: "Reconnecting… 1/5" },
    { type: "item.completed", item: { type: "agent_message", text: "recovered" } },
    { type: "turn.completed" },
  ];
  const r = codeyInterpret(evs, 0);
  expect(r.ok).toBe(true);
  expect(r.resultText).toBe("recovered");
});

test("codey interpretResult: non-transient error event → failure", () => {
  const evs: StreamEvent[] = [
    { type: "turn.started" },
    { type: "error", message: "Authentication failed" },
  ];
  const r = codeyInterpret(evs, 0);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("fatal error");
  expect(r.error).toContain("Authentication failed");
});

test("codey interpretResult: non-zero exit with no turn.completed → failure", () => {
  const evs: StreamEvent[] = [{ type: "turn.started" }];
  const r = codeyInterpret(evs, 1);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("turn.completed");
});

test("codey interpretResult: spawn error short-circuits", () => {
  const r = codeyInterpret([], null, { spawnError: "engine binary not found: codey" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("not found");
});

// ---- opencode adapter (pure) ---------------------------------------------

function opencodeInterpret(
  evs: StreamEvent[],
  exitCode: number | null,
  extra?: { spawnError?: string },
) {
  return ADAPTERS.opencode.interpretResult({ events: evs, exitCode, ...extra });
}

function opencodeArgs(partial: Partial<EngineOptions> & { cwd?: string }): string[] {
  return ADAPTERS.opencode.buildInvocation({ prompt: "hi", cwd: "/x", ...partial }).args;
}

test("opencode buildInvocation: starts with run, flags first, prompt last", () => {
  const args = opencodeArgs({});
  expect(args[0]).toBe("run");
  expect(args).toContain("--variant");
  expect(args[args.indexOf("--variant") + 1]).toBe("medium");
  expect(args).toContain("--format");
  expect(args[args.indexOf("--format") + 1]).toBe("json");
  expect(args).toContain("--dangerously-skip-permissions");
  // prompt is the final trailing positional (matching opencode run CLI spec)
  expect(args[args.length - 1]).toBe("hi");
});

test("opencode buildInvocation: prompt is positional, no stdin", () => {
  const result = ADAPTERS.opencode.buildInvocation({ prompt: "build it", cwd: "/x" });
  expect(result.args).toContain("build it");
  expect(result.stdin).toBeUndefined();
});

test("opencode buildInvocation: model passed as -m flag", () => {
  const args = opencodeArgs({ model: "openrouter/deepseek/deepseek-v4-pro" });
  expect(args).toContain("-m");
  expect(args[args.indexOf("-m") + 1]).toBe("openrouter/deepseek/deepseek-v4-pro");
});

test("opencode buildInvocation: appendSystemPrompt is prepended as XML block", () => {
  const result = ADAPTERS.opencode.buildInvocation({
    prompt: "build the site",
    cwd: "/x",
    appendSystemPrompt: "Use the Kit.",
  });
  // Prompt is the final trailing positional
  const prompt = result.args[result.args.length - 1] as string;
  expect(prompt).toContain("<system>");
  expect(prompt).toContain("Use the Kit.");
  expect(prompt).toContain("build the site");
});

test("opencode buildInvocation: --dir pins the working directory to cwd", () => {
  // opencode ignores the spawned process cwd; --dir is how it's told where to
  // write, so file outputs land in the scoped dir, not opencode's discovered root.
  const args = ADAPTERS.opencode.buildInvocation({ prompt: "hi", cwd: "/scoped/work" }).args;
  expect(args).toContain("--dir");
  expect(args[args.indexOf("--dir") + 1]).toBe("/scoped/work");
});

test("opencode buildInvocation: addDirs is a no-op (opencode has no --add-dir)", () => {
  // opencode uses --dangerously-skip-permissions for full FS access; it has no
  // sandbox-mount flag. Passing addDirs must not emit any unknown flag.
  const args = opencodeArgs({ addDirs: ["/c", "/d"] });
  expect(args).not.toContain("--add-dir");
});

test("opencode watchesRateLimit is false", () => {
  expect(ADAPTERS.opencode.watchesRateLimit).toBe(false);
});

test("opencode interpretResult: exit 0 with no terminal event → ok (R2 — exit primary)", () => {
  const evs: StreamEvent[] = [
    { type: "step_start" },
    { type: "text", part: { type: "text", text: " PING" } },
  ];
  const r = opencodeInterpret(evs, 0);
  expect(r.ok).toBe(true);
  expect(r.resultText).toBe("PING");
});

test("opencode interpretResult: exit 0 with step_finish reason=stop → ok", () => {
  const evs: StreamEvent[] = [
    { type: "step_start" },
    { type: "text", part: { type: "text", text: "done" } },
    { type: "step_finish", part: { reason: "stop" } },
  ];
  const r = opencodeInterpret(evs, 0);
  expect(r.ok).toBe(true);
});

test("opencode interpretResult: non-zero exit → fail (exit code primary)", () => {
  const evs: StreamEvent[] = [{ type: "step_start" }];
  const r = opencodeInterpret(evs, 1);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("1");
});

test("opencode interpretResult: fatal error event overrides clean exit", () => {
  const evs: StreamEvent[] = [
    { type: "step_start" },
    { type: "error", message: "Provider auth failed" },
  ];
  const r = opencodeInterpret(evs, 0);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("fatal error");
  expect(r.error).toContain("Provider auth failed");
});

test("opencode interpretResult: intermediate tool_use step_finish is not fatal (exit 0)", () => {
  // Multi-step runs emit step_finish with reason "tool_use" between tool calls;
  // only exit code and type:"error" events determine the verdict (R2).
  const evs: StreamEvent[] = [
    { type: "step_start" },
    { type: "tool_use" },
    { type: "step_finish", part: { reason: "tool_use" } },
    { type: "step_start" },
    { type: "text", part: { type: "text", text: "done" } },
    { type: "step_finish", part: { reason: "stop" } },
  ];
  const r = opencodeInterpret(evs, 0);
  expect(r.ok).toBe(true);
  expect(r.resultText).toBe("done");
});

test("opencode interpretResult: spawn error short-circuits", () => {
  const r = opencodeInterpret([], null, { spawnError: "engine binary not found: opencode" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("not found");
});

test("opencode interpretResult: non-zero exit carries the error event's payload", () => {
  // opencode prints nothing to stderr when it dies at startup; the type:"error"
  // event is the only record of the cause, so "engine exited 1" alone is useless.
  const evs: StreamEvent[] = [
    { type: "error", error: { name: "ProviderAuthError", data: { message: "invalid API key" } } },
  ];
  const r = opencodeInterpret(evs, 1);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("engine exited 1");
  expect(r.error).toContain("ProviderAuthError: invalid API key");
});

// ---- errorEventDetail (pure) ----------------------------------------------

test("errorEventDetail: top-level message (codey dialect)", () => {
  expect(errorEventDetail({ type: "error", message: "Authentication failed" })).toBe(
    "Authentication failed",
  );
});

test("errorEventDetail: nested error.name + error.data.message (opencode dialect)", () => {
  const detail = errorEventDetail({
    type: "error",
    error: { name: "ProviderModelNotFoundError", data: { message: "model not found" } },
  });
  expect(detail).toBe("ProviderModelNotFoundError: model not found");
});

test("errorEventDetail: string error field", () => {
  expect(errorEventDetail({ type: "error", error: "boom" })).toBe("boom");
});

test("errorEventDetail: unknown shape falls back to the serialized event", () => {
  const detail = errorEventDetail({ type: "error", weird: true });
  expect(detail).toContain('"weird":true');
});

test("errorEventDetail: long payloads are bounded", () => {
  const detail = errorEventDetail({ type: "error", message: "x".repeat(5_000) });
  expect(detail.length).toBeLessThanOrEqual(501);
});
