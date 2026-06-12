import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { runDoctor } from "../config/doctor.ts";
import { type Config, DEFAULTS } from "../config/schema.ts";
import {
  CONFIG_KEYS,
  configPath,
  getConfigValue,
  loadConfig,
  loadConfigOrThrow,
  saveConfig,
  setConfigValue,
} from "../config/store.ts";
import { UserError } from "../util/errors.ts";

function expandHome(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

function safeLoad(): Config | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

async function interactiveSetup(): Promise<number> {
  const existing = safeLoad();
  p.intro(pc.bold("Site Builder configuration"));

  const root = await p.text({
    message: "Root directory for Client folders",
    placeholder: resolve(homedir(), "clients"),
    initialValue: existing?.root ?? "",
    validate: (v) => (!v || v.trim().length === 0 ? "required" : undefined),
  });
  if (p.isCancel(root)) {
    p.cancel("cancelled");
    return 1;
  }

  const engineBin = await p.text({
    message: "Engine binary (the claudey container wrapper)",
    initialValue: existing?.engineBin ?? DEFAULTS.engineBin,
  });
  if (p.isCancel(engineBin)) {
    p.cancel("cancelled");
    return 1;
  }

  const wranglerBin = await p.text({
    message: "Wrangler binary (Cloudflare deploy)",
    initialValue: existing?.wranglerBin ?? DEFAULTS.wranglerBin,
  });
  if (p.isCancel(wranglerBin)) {
    p.cancel("cancelled");
    return 1;
  }

  const pexels = await p.text({
    message: "Pexels API key (optional — enables stock imagery during generate)",
    initialValue: existing?.pexelsApiKey ?? "",
  });
  if (p.isCancel(pexels)) {
    p.cancel("cancelled");
    return 1;
  }

  const resolvedRoot = expandHome(root);
  if (!existsSync(resolvedRoot)) {
    const create = await p.confirm({
      message: `${resolvedRoot} does not exist. Create it?`,
      initialValue: true,
    });
    if (p.isCancel(create)) {
      p.cancel("cancelled");
      return 1;
    }
    if (create) {
      mkdirSync(resolvedRoot, { recursive: true });
    }
  }

  const config: Config = {
    root: resolvedRoot,
    engineBin: engineBin.trim() || DEFAULTS.engineBin,
    wranglerBin: wranglerBin.trim() || DEFAULTS.wranglerBin,
    // gh is only needed for the opt-in --github flow; carry it without prompting.
    ghBin: existing?.ghBin ?? DEFAULTS.ghBin,
    pexelsApiKey: pexels.trim() || undefined,
    viewports: existing?.viewports ?? DEFAULTS.viewports,
    pageCap: existing?.pageCap ?? DEFAULTS.pageCap,
    models: existing?.models ?? DEFAULTS.models,
  };
  saveConfig(config);

  p.log.success(`saved ${configPath()}`);
  p.note(formatDoctor(config), "Environment check");
  p.outro("Run `sb config doctor` anytime to re-check.");
  return 0;
}

function formatDoctor(config: Config): string {
  return runDoctor(config)
    .map((r) => {
      const mark = r.ok ? pc.green("✓") : r.required ? pc.red("✗") : pc.yellow("!");
      return `${mark} ${r.name}: ${r.detail}`;
    })
    .join("\n");
}

function getSubcommand(key: string | undefined): number {
  if (!key) {
    throw new UserError(
      "missing config key",
      `usage: sb config get <key>\nkeys: ${CONFIG_KEYS.join(", ")}`,
    );
  }
  const value = getConfigValue(loadConfigOrThrow(), key);
  if (value === undefined) {
    console.log(pc.dim("(unset)"));
  } else {
    console.log(typeof value === "string" ? value : JSON.stringify(value));
  }
  return 0;
}

function setSubcommand(key: string | undefined, valueParts: string[]): number {
  if (!key || valueParts.length === 0) {
    throw new UserError("usage: sb config set <key> <value>", `keys: ${CONFIG_KEYS.join(", ")}`);
  }
  const next = setConfigValue(loadConfigOrThrow(), key, valueParts.join(" "));
  saveConfig(next);
  console.log(pc.green(`✓ set ${key}`));
  return 0;
}

function doctorSubcommand(): number {
  const config = loadConfigOrThrow();
  const results = runDoctor(config);
  for (const r of results) {
    const mark = r.ok ? pc.green("✓") : r.required ? pc.red("✗") : pc.yellow("!");
    console.log(`${mark} ${r.name}: ${r.detail}`);
  }
  const failedRequired = results.filter((r) => r.required && !r.ok);
  if (failedRequired.length > 0) {
    console.error(pc.red(`\n${failedRequired.length} required check(s) failed`));
    return 1;
  }
  return 0;
}

export async function configCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
      return interactiveSetup();
    case "get":
      return getSubcommand(rest[0]);
    case "set":
      return setSubcommand(rest[0], rest.slice(1));
    case "doctor":
      return doctorSubcommand();
    case "path":
      console.log(configPath());
      return 0;
    default:
      throw new UserError(
        `unknown config subcommand: ${sub}`,
        "expected: get, set, doctor, path — or no subcommand for interactive setup",
      );
  }
}
