import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";

/**
 * Thin wrapper around the npm/Astro commands a Site Version needs. Shared by
 * `generate` (the compile gate after the AI build) and reused by `audit`
 * (Phase 6, which previews the same built Site). Keeping the spawn/capture
 * logic in one place means both stages run Astro the same way.
 */

export interface CommandResult {
  ok: boolean;
  code: number | null;
  /** Tail of combined stdout+stderr, for diagnostics on failure. */
  output: string;
}

const OUTPUT_TAIL = 8000;
const INSTALL_TIMEOUT_MS = 600_000;
const BUILD_TIMEOUT_MS = 600_000;

/**
 * Spawns a command in `cwd`, capturing a tail of its combined output. Never
 * rejects: a spawn error or non-zero exit is reported in the resolved result.
 */
export function runCommand(
  command: string,
  args: string[],
  opts: { cwd: string; log?: Logger; timeoutMs?: number },
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let output = "";
    let timedOut = false;
    const append = (chunk: string): void => {
      output = (output + chunk).slice(-OUTPUT_TAIL);
    };

    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", append);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", append);

    child.on("error", (err) => {
      append(
        `\n${(err as NodeJS.ErrnoException).code === "ENOENT" ? `command not found: ${command}` : err.message}`,
      );
      if (timer) {
        clearTimeout(timer);
      }
      resolve({ ok: false, code: null, output });
    });

    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (timedOut) {
        append(`\ncommand timed out after ${opts.timeoutMs}ms`);
      }
      resolve({ ok: !timedOut && code === 0, code, output });
    });
  });
}

/** Installs the Site Version's npm dependencies (Astro, Tailwind, …). */
export async function installDeps(siteDir: string, log?: Logger): Promise<CommandResult> {
  log?.step("astro: installing dependencies");
  const result = await runCommand("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: siteDir,
    log,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (!result.ok) {
    log?.warn("astro: npm install failed");
  }
  return result;
}

/** Runs the Astro static build (`npm run build`). */
export async function astroBuild(siteDir: string, log?: Logger): Promise<CommandResult> {
  log?.step("astro: building site");
  return runCommand("npm", ["run", "build"], {
    cwd: siteDir,
    log,
    timeoutMs: BUILD_TIMEOUT_MS,
  });
}

/**
 * The full compile gate: install dependencies (when absent) then `astro build`.
 * Returns the failing step's output so the caller can surface it. This is the
 * default `buildSite` the `generate` stage runs; tests inject a fake instead.
 */
export async function buildSite(siteDir: string, log?: Logger): Promise<CommandResult> {
  if (!existsSync(join(siteDir, "node_modules"))) {
    const installed = await installDeps(siteDir, log);
    if (!installed.ok) {
      return installed;
    }
  }
  return astroBuild(siteDir, log);
}

/** The injectable shape `generate` accepts so tests can stub the compile gate. */
export type SiteBuilder = (siteDir: string, log?: Logger) => Promise<CommandResult>;

export interface EnsureBuiltDistParams {
  versionDir: string;
  /** The compile gate (the injected `buildSite`). */
  compile: SiteBuilder;
  log: Logger;
  /** Logged (as a step) when no dist is found and a build is kicked off. */
  buildingMessage: string;
  /** The UserError message when that build fails. */
  failureMessage: string;
}

/**
 * Ensures the Site Version at `versionDir` has a built `dist/index.html`,
 * compiling it via `compile` when absent. Shared by `audit` (so the preview
 * server has something to serve) and `deploy` (so there is something to upload):
 * a normal pipeline run keeps generate's/audit's dist, so this only rebuilds on a
 * standalone resume that lost it. Throws a {@link UserError} carrying the build
 * output tail with the caller's `failureMessage` when the build fails.
 */
export async function ensureBuiltDist(params: EnsureBuiltDistParams): Promise<void> {
  const { versionDir, compile, log, buildingMessage, failureMessage } = params;
  if (existsSync(join(versionDir, "dist", "index.html"))) {
    return;
  }
  log.step(buildingMessage);
  const built = await compile(versionDir, log);
  if (!built.ok) {
    throw new UserError(failureMessage, built.output.trim().slice(-1500));
  }
}
