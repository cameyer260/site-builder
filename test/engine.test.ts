import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { playwrightMcpConfig } from "../src/engine/mcp.ts";
import {
  buildEngineArgs,
  type EngineOptions,
  engineFailureReason,
  interpretResult,
  parseStreamJson,
  runEngine,
  type StreamEvent,
} from "../src/engine/runner.ts";

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

test("buildEngineArgs serializes an MCP config object to JSON", () => {
  const args = buildEngineArgs(
    opts({ cwd: "/x", mcpConfig: playwrightMcpConfig(), strictMcpConfig: true }),
  );
  const ci = args.indexOf("--mcp-config");
  expect(ci).toBeGreaterThanOrEqual(0);
  const parsed = JSON.parse(args[ci + 1] as string);
  expect(parsed.mcpServers.playwright.command).toBe("npx");
  expect(args).toContain("--strict-mcp-config");
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

test("engineFailureReason: appends the stderr tail when the engine only printed there", () => {
  // The real failure mode: no result event, exit 1, the cause on stderr only.
  const r = interpretResult({
    events: [],
    exitCode: 1,
    stderrTail: "Error: Input must be provided either through stdin or as a prompt argument\n",
  });
  const reason = engineFailureReason(r);
  expect(reason).toContain("engine exited 1 with no result event");
  expect(reason).toContain("stdin");
});

test("engineFailureReason: omits the stderr clause when stderr is empty", () => {
  const r = interpretResult({ events: [], exitCode: 1, stderrTail: "  " });
  expect(engineFailureReason(r)).toBe("engine exited 1 with no result event");
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
