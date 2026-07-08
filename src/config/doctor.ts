import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import type { EngineKind } from "../engine/adapter.ts";
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

/**
 * Checks one engine binary. The defaultEngine's bin is required (blocks runs);
 * the other two configured bins are optional warnings only.
 */
function checkEngine(bin: string, kind: EngineKind, required: boolean): CheckResult {
  const present = binaryPresent(bin);
  return {
    name: `engine ${kind} (${bin})`,
    ok: present,
    required,
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
 * GitHub CLI for the opt-in `--github`/`sb push` flow (ADR-0004) and for
 * `sb remove`'s GitHub teardown (ADR-0012). Non-required: the core promise (a
 * live link) comes from deploy alone, so a missing/unauthed `gh` only warns.
 * When present, `gh auth status` is cheap and worth probing — though it can't
 * confirm the `delete_repo` scope `sb remove` additionally needs
 * (`gh auth refresh -h github.com -s delete_repo`), only that some token exists.
 */
function checkGitHub(bin: string): CheckResult {
  if (!binaryPresent(bin)) {
    return {
      name: `github cli (${bin})`,
      ok: false,
      required: false,
      detail: "not found — `--github`/`sb push`/`sb remove` will be unavailable",
    };
  }
  const r = spawnSync(bin, ["auth", "status"], { encoding: "utf8" });
  const authed = r.status === 0;
  return {
    name: "github cli auth",
    ok: authed,
    required: false,
    detail: authed
      ? "authenticated (sb remove also needs the delete_repo scope)"
      : "present but not authenticated — run `gh auth login`",
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
  const engineKinds: EngineKind[] = ["claudey", "codey", "opencode"];
  const engineChecks = engineKinds.map((kind) =>
    checkEngine(cfg.engines[kind].bin, kind, kind === cfg.defaultEngine),
  );
  return [
    ...engineChecks,
    checkWranglerPresent(cfg.wranglerBin),
    checkWranglerAuth(cfg.wranglerBin),
    checkRoot(cfg.root),
    checkGitHub(cfg.ghBin),
    checkPexels(cfg.pexelsApiKey),
  ];
}
