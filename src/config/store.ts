import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UserError } from "../util/errors.ts";
import { type Config, ConfigSchema, formatZodError } from "./schema.ts";

/**
 * Resolves the config directory. Honors `SB_CONFIG_DIR` (used by tests to point
 * at a temp dir) and then `XDG_CONFIG_HOME`, falling back to `~/.config`.
 */
export function configDir(): string {
  const override = process.env.SB_CONFIG_DIR;
  if (override) {
    return override;
  }
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "site-builder");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function configExists(): boolean {
  return existsSync(configPath());
}

export function loadConfig(): Config | null {
  const p = configPath();
  if (!existsSync(p)) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    throw new UserError(
      `config at ${p} is not valid JSON`,
      "fix or delete it, then run `sb config`",
    );
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UserError(
      `config at ${p} is invalid: ${formatZodError(parsed.error)}`,
      "run `sb config` to repair it",
    );
  }
  return parsed.data;
}

export function loadConfigOrThrow(): Config {
  const cfg = loadConfig();
  if (!cfg) {
    throw new UserError("Site Builder is not configured yet", "run `sb config` first");
  }
  return cfg;
}

export function saveConfig(cfg: Config): void {
  const validated = ConfigSchema.parse(cfg);
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(validated, null, 2)}\n`);
}

/** The settable leaf keys, with how a raw string value should be coerced. */
const KEY_KINDS = {
  root: "string",
  engineBin: "string",
  wranglerBin: "string",
  pexelsApiKey: "string",
  "viewports.desktop": "number",
  "viewports.mobile": "number",
  pageCap: "number",
  "models.generate": "string",
  "models.audit": "string",
  "models.synthesize": "string",
  "models.assetClassification": "string",
} as const;

export type ConfigKey = keyof typeof KEY_KINDS;

export const CONFIG_KEYS = Object.keys(KEY_KINDS) as ConfigKey[];

function isConfigKey(key: string): key is ConfigKey {
  return key in KEY_KINDS;
}

export function getConfigValue(cfg: Config, key: string): unknown {
  if (!isConfigKey(key)) {
    throw new UserError(`unknown config key: ${key}`, `valid keys: ${CONFIG_KEYS.join(", ")}`);
  }
  return key
    .split(".")
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], cfg);
}

/**
 * Returns a new Config with `key` set to the coerced `rawValue`, re-validated
 * against the schema. Throws UserError on an unknown key or invalid value.
 */
export function setConfigValue(cfg: Config, key: string, rawValue: string): Config {
  if (!isConfigKey(key)) {
    throw new UserError(`unknown config key: ${key}`, `valid keys: ${CONFIG_KEYS.join(", ")}`);
  }
  const kind = KEY_KINDS[key];
  let value: string | number;
  if (kind === "number") {
    const n = Number(rawValue);
    if (!Number.isFinite(n)) {
      throw new UserError(`config key ${key} expects a number, got "${rawValue}"`);
    }
    value = n;
  } else {
    value = rawValue;
  }

  const next = structuredClone(cfg) as Record<string, unknown>;
  const parts = key.split(".");
  let cursor = next;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string;
    if (typeof cursor[part] !== "object" || cursor[part] === null) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1] as string] = value;

  const parsed = ConfigSchema.safeParse(next);
  if (!parsed.success) {
    throw new UserError(`invalid value for ${key}: ${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}
