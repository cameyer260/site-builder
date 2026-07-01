import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, DEFAULTS } from "../src/config/schema.ts";
import {
  configPath,
  getConfigValue,
  loadConfig,
  saveConfig,
  setConfigValue,
} from "../src/config/store.ts";

function makeConfig(root: string): Config {
  return { ...DEFAULTS, root };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sb-cfg-"));
  process.env.SB_CONFIG_DIR = dir;
});

afterEach(() => {
  process.env.SB_CONFIG_DIR = undefined;
  rmSync(dir, { recursive: true, force: true });
});

test("configPath honors SB_CONFIG_DIR", () => {
  expect(configPath()).toBe(join(dir, "config.json"));
});

test("save/load round trip", () => {
  expect(loadConfig()).toBeNull();
  saveConfig(makeConfig("/tmp/clients"));
  const loaded = loadConfig();
  expect(loaded?.root).toBe("/tmp/clients");
  expect(loaded?.defaultEngine).toBe("claudey");
  expect(loaded?.engines.claudey.models.best).toBe(DEFAULTS.engines.claudey.models.best);
});

test("get returns nested values", () => {
  const cfg = makeConfig("/tmp/clients");
  expect(getConfigValue(cfg, "viewports.desktop")).toBe(1440);
  expect(getConfigValue(cfg, "engines.claudey.models.small")).toBe("claude-sonnet-5");
  expect(() => getConfigValue(cfg, "bogus")).toThrow();
});

test("set coerces numbers, validates, rejects unknown keys", () => {
  const cfg = makeConfig("/tmp/clients");
  expect(setConfigValue(cfg, "viewports.mobile", "414").viewports.mobile).toBe(414);
  expect(setConfigValue(cfg, "engines.claudey.bin", "claudey-custom").engines.claudey.bin).toBe(
    "claudey-custom",
  );
  expect(() => setConfigValue(cfg, "viewports.mobile", "abc")).toThrow();
  expect(() => setConfigValue(cfg, "pageCap", "-3")).toThrow();
  expect(() => setConfigValue(cfg, "nope", "x")).toThrow();
});
