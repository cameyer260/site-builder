import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusCommand } from "../src/commands/status.ts";
import { type Config, DEFAULTS } from "../src/config/schema.ts";
import { saveConfig } from "../src/config/store.ts";
import { ClientInputsSchema, newClient, writeClient } from "../src/storage/client.ts";
import { clientPaths } from "../src/storage/layout.ts";
import { emptyState, writeState } from "../src/storage/state.ts";
import { formatUserDateTime } from "../src/util/time.ts";

let root: string;
let configDir: string;
let originalLog: typeof console.log;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sb-status-root-"));
  configDir = mkdtempSync(join(tmpdir(), "sb-status-cfg-"));
  process.env.SB_CONFIG_DIR = configDir;
  originalLog = console.log;
});

afterEach(() => {
  console.log = originalLog;
  process.env.SB_CONFIG_DIR = undefined;
  rmSync(root, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

test("status formats last-run timestamp for people instead of printing raw UTC", async () => {
  saveConfig({ ...DEFAULTS, root } as Config);
  const paths = clientPaths(root, "Acme Co");
  mkdirSync(paths.dir, { recursive: true });
  writeClient(paths.clientJson, newClient("Acme Co", ClientInputsSchema.parse({})));

  const state = emptyState("context", ["init"]);
  state.stages.init = { status: "completed", attempts: 1 };
  state.lastRun = { status: "completed", stage: "init", at: "2026-01-02T03:04:00.000Z" };
  writeState(paths.state, state);

  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  await statusCommand(["Acme Co"]);

  const output = lines.join("\n");
  expect(output).toContain(`last run: completed @ init (${formatUserDateTime(state.lastRun.at)})`);
  expect(output).not.toContain("2026-01-02T03:04:00.000Z");
});
