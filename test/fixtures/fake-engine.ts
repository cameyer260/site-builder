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

// The benign quota ping the engine emits on essentially every run; it must not
// arm the stall watchdog (status "allowed", not "rejected").
emit({
  type: "rate_limit_event",
  rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
});

if (prompt.includes("BENIGN_STALL")) {
  // Only the benign quota ping above, then silence. The watchdog must NOT arm —
  // this run can only be ended by the wall-clock timeout, not the stall guard.
  await new Promise(() => {});
} else if (prompt.includes("RATE_LIMIT_STALL")) {
  // Report a *rejected* rate limit, then go silent forever without exiting — the
  // runner's stall watchdog must abandon us rather than wait out the full timeout.
  emit({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
  });
  await new Promise(() => {});
} else if (prompt.includes("STDERR_SPAM")) {
  // Simulates a repeating-error crash (e.g. an engine writing to an
  // already-broken stdout pipe on every attempt): the causal first line is
  // followed by thousands of chars of a repeated, less useful message.
  process.stderr.write("FATAL: root cause line\n");
  for (let i = 0; i < 500; i++) {
    process.stderr.write(`repeated spam line ${i}\n`);
  }
  process.exit(1);
} else if (prompt.includes("STDERR_IDENTICAL_REPEAT")) {
  // Simulates an engine that spams the exact same multi-line error object on
  // every failed write (e.g. opencode's EPIPE-on-a-broken-stdout-pipe bug) —
  // the runner's excerpt should collapse these into one copy + a repeat
  // count instead of filling the window with copies of one stanza.
  for (let i = 0; i < 30; i++) {
    process.stderr.write("EPIPE: broken pipe, write\n  fd: 5\n  code: EPIPE\n");
  }
  process.exit(1);
} else if (prompt.includes("ERROR_EVENT")) {
  // Dies at startup the way the à-la-carte CLIs do: the cause goes to stdout
  // as a type:"error" event (stderr stays silent), then a bare non-zero exit.
  emit({
    type: "error",
    error: {
      name: "ProviderModelNotFoundError",
      data: { message: "model not found: nope/nope-9" },
    },
  });
  process.exit(1);
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
