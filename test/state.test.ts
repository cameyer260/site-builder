import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyState,
  ensureState,
  markCompleted,
  markFailed,
  markRunning,
  readState,
  writeState,
} from "../src/storage/state.ts";

test("stage transitions update status, attempts, and lastRun", () => {
  const s = emptyState("context", ["init", "ingest"]);
  expect(s.stages.init?.status).toBe("pending");

  markRunning(s, "init");
  expect(s.stages.init?.status).toBe("running");
  expect(s.stages.init?.attempts).toBe(1);

  markCompleted(s, "init");
  expect(s.stages.init?.status).toBe("completed");
  expect(s.lastRun?.status).toBe("completed");
  expect(s.lastRun?.stage).toBe("init");

  markFailed(s, "ingest", "boom");
  expect(s.stages.ingest?.status).toBe("failed");
  expect(s.lastRun?.status).toBe("failed");
  expect(s.lastRun?.error).toBe("boom");
});

test("re-running a stage increments attempts and clears prior error", () => {
  const s = emptyState("context", ["ingest"]);
  markRunning(s, "ingest");
  markFailed(s, "ingest", "boom");
  expect(s.stages.ingest?.attempts).toBe(1);
  markRunning(s, "ingest");
  expect(s.stages.ingest?.attempts).toBe(2);
  expect(s.stages.ingest?.error).toBeUndefined();
});

test("read/write round trip and ensure-existing", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-st-"));
  const p = join(dir, "state.json");
  expect(readState(p)).toBeNull();

  const s = ensureState(p, "context", ["init"]);
  expect(s.stages.init?.status).toBe("pending");
  markCompleted(s, "init");
  writeState(p, s);
  expect(readState(p)?.stages.init?.status).toBe("completed");

  // ensureState returns the existing file rather than resetting it
  expect(ensureState(p, "context", ["init"]).stages.init?.status).toBe("completed");
  rmSync(dir, { recursive: true, force: true });
});
