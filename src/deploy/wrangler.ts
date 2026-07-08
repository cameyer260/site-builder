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

/**
 * The Cloudflare teardown seams for `sb remove` (ADR-0012). Cloudflare Pages is
 * one project per Client (`pagesProjectName`), with each `deploy` a separate
 * deployment inside it — so per-Version removal deletes one *deployment*,
 * found by listing the project's deployments and matching the Version's
 * recorded `deployUrl`; whole-Client removal (or removing a Client's last
 * remaining Version) deletes the whole *project* instead.
 */

export interface PagesDeployment {
  id: string;
  url: string;
}

export interface ListDeploymentsParams {
  /** Cloudflare Pages project name (`pagesProjectName(slug)`). */
  projectName: string;
  wranglerBin: string;
  cwd: string;
  log: Logger;
}

export interface ListDeploymentsResult {
  ok: boolean;
  deployments: PagesDeployment[];
  output: string;
}

/** The injectable shape `remove` accepts for finding a Version's deployment. */
export type DeploymentLister = (params: ListDeploymentsParams) => Promise<ListDeploymentsResult>;

const LIST_TIMEOUT_MS = 60_000;
const DELETE_DEPLOYMENT_TIMEOUT_MS = 60_000;
const DELETE_PROJECT_TIMEOUT_MS = 60_000;

/**
 * Parses `wrangler pages deployment list --json`'s output into the minimal
 * shape removal needs. This is **not** the raw Cloudflare API deployment
 * object — wrangler's own handler (`src/pages/deployments.ts`) maps each one
 * into a display row with renamed, capitalized keys before printing it (the
 * same object it would otherwise hand to `logger.table()`): `Id`, not `id`;
 * `Deployment` (the `*.pages.dev` URL), not `url`. Verified by reading that
 * handler in the installed wrangler CLI directly — there is no `--json`
 * schema documented for this subcommand. Returns `[]` on anything
 * unparseable or shaped unexpectedly — best-effort, matched by the caller
 * warning and skipping rather than throwing (ADR-0012).
 */
export function parseDeploymentList(output: string): PagesDeployment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as Record<string, unknown>).Id !== "string" ||
      typeof (entry as Record<string, unknown>).Deployment !== "string"
    ) {
      return [];
    }
    const e = entry as { Id: string; Deployment: string };
    return [{ id: e.Id, url: e.Deployment }];
  });
}

/** The real lister: `wrangler pages deployment list --project-name <name> --json`. */
export const listPagesDeployments: DeploymentLister = async ({
  projectName,
  wranglerBin,
  cwd,
  log,
}) => {
  log.step(`remove: listing Cloudflare Pages deployments for "${projectName}"`);
  const result = await runCommand(
    wranglerBin,
    ["pages", "deployment", "list", "--project-name", projectName, "--json"],
    { cwd, log, timeoutMs: LIST_TIMEOUT_MS },
  );
  return {
    ok: result.ok,
    deployments: result.ok ? parseDeploymentList(result.output) : [],
    output: result.output,
  };
};

export interface DeleteDeploymentParams {
  deploymentId: string;
  projectName: string;
  wranglerBin: string;
  cwd: string;
  log: Logger;
}

export interface CloudflareDeleteResult {
  ok: boolean;
  output: string;
  /**
   * Set on a failed deployment delete that failed for exactly one reason:
   * Cloudflare refuses to delete a project's active production deployment
   * (API error 8000034). See {@link isActiveProductionDeploymentError}.
   * Callers can treat this as a known, reportable skip rather than a hard
   * failure.
   */
  blockedByActiveProduction?: boolean;
}

/**
 * Cloudflare's own, permanent restriction: `wrangler pages deployment delete`
 * (and the REST API underneath it) refuses to delete a project's *active
 * production* deployment — the most recent deploy to the production branch —
 * with API error 8000034. There is no wrangler flag or CLI subcommand to
 * promote a different deployment to production first (`wrangler pages
 * deployment` only has `list`/`delete`/`tail`); the only way is the
 * dashboard's "Rollback" button or a raw Cloudflare API call outside the
 * wrangler-CLI seam this codebase relies on (ADR-0004/ADR-0012). Detected
 * from wrangler's error text so the caller can tell this specific, permanent
 * case apart from a transient/real failure.
 */
export function isActiveProductionDeploymentError(output: string): boolean {
  return /cannot delete the active production deployment|\[code:\s*8000034\]/i.test(output);
}

/** The injectable shape `remove` accepts for deleting a single deployment. */
export type DeploymentDeleter = (params: DeleteDeploymentParams) => Promise<CloudflareDeleteResult>;

/**
 * The real deleter: `wrangler pages deployment delete <id> --project-name <name> --force`.
 * `--force`/`-f` is load-bearing, not optional: the command's own `--help`
 * only documents it as "delete even if the deployment has an active alias,"
 * but reading the handler shows it also gates the confirmation prompt
 * (`force || await confirm(...)`). Without it, wrangler's confirm helper
 * detects our stdin-less, non-TTY spawn and resolves to its `fallbackValue:
 * false` — so the handler returns *without deleting anything* and exits 0.
 * `runCommand` would then report `ok: true` for a deployment that was never
 * actually removed. `--force` skips the prompt outright, so the delete either
 * really happens or fails loudly.
 */
export const deletePagesDeployment: DeploymentDeleter = async ({
  deploymentId,
  projectName,
  wranglerBin,
  cwd,
  log,
}) => {
  log.step(`remove: deleting Cloudflare Pages deployment "${deploymentId}"`);
  const result = await runCommand(
    wranglerBin,
    ["pages", "deployment", "delete", deploymentId, "--project-name", projectName, "--force"],
    { cwd, log, timeoutMs: DELETE_DEPLOYMENT_TIMEOUT_MS },
  );
  return {
    ok: result.ok,
    output: result.output,
    blockedByActiveProduction: !result.ok && isActiveProductionDeploymentError(result.output),
  };
};

export interface DeleteProjectParams {
  projectName: string;
  wranglerBin: string;
  cwd: string;
  log: Logger;
}

/** The injectable shape `remove` accepts for deleting the whole Pages project. */
export type ProjectDeleter = (params: DeleteProjectParams) => Promise<CloudflareDeleteResult>;

/** The real deleter: `wrangler pages project delete <name> --yes`. */
export const deletePagesProject: ProjectDeleter = async ({
  projectName,
  wranglerBin,
  cwd,
  log,
}) => {
  log.step(`remove: deleting Cloudflare Pages project "${projectName}"`);
  const result = await runCommand(
    wranglerBin,
    ["pages", "project", "delete", projectName, "--yes"],
    {
      cwd,
      log,
      timeoutMs: DELETE_PROJECT_TIMEOUT_MS,
    },
  );
  return { ok: result.ok, output: result.output };
};
