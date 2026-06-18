#!/usr/bin/env bun
/**
 * A deterministic stand-in for `claude -p --output-format stream-json`, used by
 * the engine runner's offline integration tests. It reads the prompt from
 * stdin, emits stream-json events, and — on the success path — writes a file in
 * its cwd to mimic the engine editing files unattended. If the prompt contains
 * "FAIL" it emits an error result and exits non-zero.
 */
const prompt = await Bun.stdin.text();

function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}

emit({ type: "system", subtype: "init", session_id: "fake-123" });

if (prompt.includes("RATE_LIMIT_STALL")) {
  // Report a rate limit, then go silent forever without exiting — the runner's
  // rate-limit watchdog must abandon us rather than wait out the full timeout.
  emit({ type: "rate_limit_event" });
  await new Promise(() => {});
} else if (prompt.includes("FAIL")) {
  emit({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    session_id: "fake-123",
    num_turns: 1,
  });
  process.exit(1);
}

await Bun.write("engine-touched.txt", "ok");
emit({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "wrote file" }] },
});
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  session_id: "fake-123",
  num_turns: 1,
  duration_ms: 5,
  total_cost_usd: 0,
});
process.exit(0);
