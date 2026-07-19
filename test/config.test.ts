import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixConfig } from "../src/config/fix.ts";
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
  expect(setConfigValue(cfg, "blogPageCap", "3").blogPageCap).toBe(3);
  expect(() => setConfigValue(cfg, "viewports.mobile", "abc")).toThrow();
  expect(() => setConfigValue(cfg, "pageCap", "-3")).toThrow();
  expect(() => setConfigValue(cfg, "blogPageCap", "0")).toThrow();
  expect(() => setConfigValue(cfg, "nope", "x")).toThrow();
});

test("fixConfig repairs invalid leaves and missing sections, leaving valid ones untouched", () => {
  writeFileSync(
    configPath(),
    JSON.stringify({
      root: "/tmp/clients",
      defaultEngine: "not-a-real-engine",
      engines: {
        claudey: { bin: "claudey", models: { best: "claude-opus-4-8", small: "" } },
        codey: { bin: "codey", models: { best: "gpt-5.6-sol", small: "gpt-5.6-terra" } },
        // opencode section missing entirely
      },
      pageCap: -5,
      wranglerBin: "wrangler-custom",
    }),
  );

  const result = fixConfig();
  expect(result.rootMissing).toBe(false);
  expect(result.config?.root).toBe("/tmp/clients");
  expect(result.config?.defaultEngine).toBe("claudey");
  expect(result.config?.engines.claudey.models.small).toBe(DEFAULTS.engines.claudey.models.small);
  expect(result.config?.engines.opencode).toEqual(DEFAULTS.engines.opencode);
  expect(result.config?.pageCap).toBe(DEFAULTS.pageCap);
  // Untouched valid value survives the repair.
  expect(result.config?.wranglerBin).toBe("wrangler-custom");

  const keys = result.changes.map((c) => c.key);
  expect(keys).toContain("defaultEngine");
  expect(keys).toContain("engines.claudey.models.small");
  expect(keys).toContain("pageCap");
  expect(keys.some((k) => k.startsWith("engines.opencode"))).toBe(true);

  // Repaired config is persisted.
  expect(loadConfig()?.wranglerBin).toBe("wrangler-custom");
});

test("fixConfig reports rootMissing and does not save when root is unset or invalid", () => {
  writeFileSync(configPath(), JSON.stringify({ wranglerBin: "wrangler" }));
  const missing = fixConfig();
  expect(missing.rootMissing).toBe(true);
  expect(missing.config).toBeNull();
  // fixConfig never wrote a file here — the on-disk (still root-less) copy
  // remains, and loading it directly still fails the whole-file way.
  expect(() => loadConfig()).toThrow();

  writeFileSync(configPath(), JSON.stringify({ root: "   ", wranglerBin: "wrangler" }));
  const blank = fixConfig();
  expect(blank.rootMissing).toBe(true);
  expect(blank.rootValue).toBe("   ");
});

test("fixConfig treats an unparseable file as empty and a missing file as no changes needed beyond root", () => {
  writeFileSync(configPath(), "{not json");
  const fromBadJson = fixConfig();
  expect(fromBadJson.rootMissing).toBe(true);

  rmSync(configPath());
  const fromMissingFile = fixConfig();
  expect(fromMissingFile.rootMissing).toBe(true);
  expect(fromMissingFile.changes).toEqual([]);
});

test("fixConfig is a no-op on an already-valid config", () => {
  saveConfig(makeConfig("/tmp/clients"));
  const result = fixConfig();
  expect(result.changes).toEqual([]);
  expect(result.config?.root).toBe("/tmp/clients");
});
