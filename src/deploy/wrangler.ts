import { relative } from "node:path";
import { runCommand } from "../astro/run.ts";
import type { Logger } from "../util/log.ts";

/**
 * The Cloudflare Pages **Direct Upload** seam for `deploy` (ADR-0004): publish
 * a Site Version's pre-built static output with the Wrangler CLI and return the
 * shareable `*.pages.dev` URL. Direct Upload is fully CLI-automatable (no
 * dashboard OAuth step) and rides the one-time `wrangler login` already verified
 * by `sb config`. No GitHub repo is involved — a live link comes purely from
 * `astro build` + `wrangler pages deploy`.
 *
 * The real runner spawns wrangler via the shared {@link runCommand}; tests inject
 * a fake through `RunContext.deploySite` so they never shell out to wrangler.
 */

export interface DeployResult {
  ok: boolean;
  /** The deployment's `*.pages.dev` URL, parsed from wrangler's output. */
  url?: string;
  /** Tail of wrangler's combined output, for diagnostics on failure. */
  output: string;
}

export interface DeployParams {
  /** The Site Version directory (wrangler's cwd; holds `dist/`). */
  siteDir: string;
  /** Absolute path to the built static output to upload. */
  distDir: string;
  /** Cloudflare Pages project name, derived per-Client from the slug. */
  projectName: string;
  /** The wrangler binary (`config.wranglerBin`). */
  wranglerBin: string;
  log: Logger;
}

/** The injectable shape `deploy` accepts so tests can stub the whole upload. */
export type DeployRunner = (params: DeployParams) => Promise<DeployResult>;

const PROJECT_CREATE_TIMEOUT_MS = 120_000;
const DEPLOY_TIMEOUT_MS = 300_000;

/**
 * Cloudflare Pages project name for a Client. The slug already satisfies the
 * naming rules (lowercase, `a–z0–9-`, no leading/trailing hyphen); only the
 * 58-character limit needs enforcing. One project per Client — each Site Version
 * deploy still gets its own immutable `*.pages.dev` link recorded per version.
 */
export function pagesProjectName(slug: string): string {
  return slug.slice(0, 58).replace(/-+$/, "");
}

/** Pulls the last `*.pages.dev` URL out of wrangler's output (the deployment link). */
export function parsePagesUrl(output: string): string | undefined {
  const matches = output.match(/https?:\/\/[^\s)]+\.pages\.dev\b[^\s)]*/g);
  return matches?.at(-1)?.replace(/[.,]+$/, "");
}

/** The real Direct Upload runner: ensure the project exists, then deploy `dist/`. */
export const deployToCloudflarePages: DeployRunner = async ({
  siteDir,
  distDir,
  projectName,
  wranglerBin,
  log,
}) => {
  // 1. Ensure the Pages project exists. Idempotent: a non-zero exit here almost
  //    always means "already exists" (a re-deploy / variant), which is fine —
  //    the deploy below is the real gate.
  log.step(`deploy: ensuring Cloudflare Pages project "${projectName}"`);
  const created = await runCommand(
    wranglerBin,
    ["pages", "project", "create", projectName, "--production-branch", "main"],
    { cwd: siteDir, log, timeoutMs: PROJECT_CREATE_TIMEOUT_MS },
  );
  if (!created.ok) {
    log.info("deploy: project create returned non-zero (likely already exists) — continuing");
  }

  // 2. Direct Upload the built static output.
  log.step(`deploy: uploading ${relative(siteDir, distDir) || distDir} to Cloudflare Pages`);
  const result = await runCommand(
    wranglerBin,
    ["pages", "deploy", distDir, "--project-name", projectName],
    { cwd: siteDir, log, timeoutMs: DEPLOY_TIMEOUT_MS },
  );

  return { ok: result.ok, url: parsePagesUrl(result.output), output: result.output };
};
