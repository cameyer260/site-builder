import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import type { Config } from "./schema.ts";

/**
 * A single environment check. `required` checks block real runs when failing;
 * non-required checks (e.g. Pexels key) only warn.
 */
export interface CheckResult {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

/** True if `bin` exists on PATH and runs (probed with `--version`). */
function binaryPresent(bin: string): boolean {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  // ENOENT => not on PATH. A non-zero exit from a present binary still counts.
  return !(r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT");
}

function checkEngine(bin: string): CheckResult {
  const present = binaryPresent(bin);
  return {
    name: `engine (${bin})`,
    ok: present,
    required: true,
    // Auth for the claudey wrapper can't be probed cheaply without spending
    // usage; v1 verifies presence only and trusts the wrapper's own auth.
    detail: present ? "present (auth delegated to the wrapper)" : "not found on PATH",
  };
}

function checkWranglerPresent(bin: string): CheckResult {
  const present = binaryPresent(bin);
  return {
    name: `wrangler (${bin})`,
    ok: present,
    required: true,
    detail: present ? "present" : "not found on PATH",
  };
}

function checkWranglerAuth(bin: string): CheckResult {
  if (!binaryPresent(bin)) {
    return { name: "wrangler auth", ok: false, required: true, detail: "wrangler not installed" };
  }
  const r = spawnSync(bin, ["whoami"], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const authed = r.status === 0 && !/not authenticated|not logged in/i.test(out);
  return {
    name: "wrangler auth",
    ok: authed,
    required: true,
    detail: authed ? "authenticated" : "not authenticated — run `wrangler login`",
  };
}

function checkRoot(root: string): CheckResult {
  if (!existsSync(root)) {
    return { name: "root directory", ok: false, required: true, detail: `${root} does not exist` };
  }
  try {
    accessSync(root, constants.W_OK);
    return { name: "root directory", ok: true, required: true, detail: `${root} (writable)` };
  } catch {
    return { name: "root directory", ok: false, required: true, detail: `${root} is not writable` };
  }
}

/**
 * GitHub CLI for the opt-in `--github`/`sb push` flow (ADR-0004). Non-required:
 * the core promise (a live link) comes from deploy alone, so a missing/unauthed
 * `gh` only warns. When present, `gh auth status` is cheap and worth probing.
 */
function checkGitHub(bin: string): CheckResult {
  if (!binaryPresent(bin)) {
    return {
      name: `github cli (${bin})`,
      ok: false,
      required: false,
      detail: "not found — `--github`/`sb push` will be unavailable",
    };
  }
  const r = spawnSync(bin, ["auth", "status"], { encoding: "utf8" });
  const authed = r.status === 0;
  return {
    name: "github cli auth",
    ok: authed,
    required: false,
    detail: authed ? "authenticated" : "present but not authenticated — run `gh auth login`",
  };
}

function checkPexels(key: string | undefined): CheckResult {
  const present = Boolean(key && key.length > 0);
  return {
    name: "pexels api key",
    ok: present,
    required: false,
    detail: present ? "set" : "not set — generate will fall back to the curated asset pack",
  };
}

export function runDoctor(cfg: Config): CheckResult[] {
  return [
    checkEngine(cfg.engineBin),
    checkWranglerPresent(cfg.wranglerBin),
    checkWranglerAuth(cfg.wranglerBin),
    checkRoot(cfg.root),
    checkGitHub(cfg.ghBin),
    checkPexels(cfg.pexelsApiKey),
  ];
}
