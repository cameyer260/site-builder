import type { Config } from "../config/schema.ts";
import {
  type CloudflareDeleteResult,
  type DeploymentDeleter,
  type DeploymentLister,
  deletePagesDeployment,
  deletePagesProject,
  listPagesDeployments,
  type ProjectDeleter,
  pagesProjectName,
} from "../deploy/wrangler.ts";
import {
  deleteGitHubRepo,
  type GitHubDeleteResult,
  type GitHubRepoDeleter,
  type GitHubRepoRenamer,
  githubRepoName,
  renameGitHubRepo,
  repoSlugFromRemote,
} from "../github/github.ts";
import { readClient, type SiteVersionRef, setSiteVersions } from "../storage/client.ts";
import {
  type ClientPaths,
  removeClientDir,
  removeVersionDir,
  renameVersionDir,
} from "../storage/layout.ts";
import { clearStaleTargetVersion, renumberState } from "../storage/state.ts";
import { UserError } from "../util/errors.ts";
import { setRemoteUrl } from "../util/git.ts";
import type { Logger } from "../util/log.ts";

/**
 * `sb remove` (ADR-0012): the inverse of the create path. Scoped to a whole
 * Client or a single Site Version. External teardown always runs before any
 * local deletion — `client.json`'s Site Version pointers are the only record
 * of what exists on Cloudflare/GitHub, so reading them first and deleting
 * local state last means a failed teardown never strands an unreachable
 * orphan. `--local-only` skips external teardown entirely; a failed teardown
 * aborts before any local deletion unless `--force`.
 */

export interface ResourceOutcome {
  /** A short label identifying what this outcome is about, e.g. `github:acme/foo-v3`. */
  resource: string;
  ok: boolean;
  /** True when the resource had nothing to tear down (no recorded URL/remote). */
  skipped?: boolean;
  detail?: string;
}

export interface RemovalResult {
  ok: boolean;
  outcomes: ResourceOutcome[];
  /** True when a failed teardown stopped the operation before any local deletion. */
  aborted?: boolean;
}

export interface RemoveParams {
  paths: ClientPaths;
  /** Present to scope to one Site Version; absent removes the whole Client. */
  version?: number;
  config: Config;
  log: Logger;
  /** Skip all external teardown (GitHub/Cloudflare); local + CRM only. */
  localOnly?: boolean;
  /** Proceed with local deletion even if an external teardown failed. */
  force?: boolean;
  /** Injected seams (tests stub them); default to the real gh/wrangler ones. */
  deleteRepo?: GitHubRepoDeleter;
  renameRepo?: GitHubRepoRenamer;
  listDeployments?: DeploymentLister;
  deleteDeployment?: DeploymentDeleter;
  deleteProject?: ProjectDeleter;
}

function detailOf(result: { output: string }): string {
  return result.output.trim().slice(-500);
}

async function teardownGitHubRepo(
  params: RemoveParams,
  version: number,
  remote: string | undefined,
  outcomes: ResourceOutcome[],
): Promise<boolean> {
  const { paths, config, log } = params;
  if (!remote) {
    log.warn(`remove: Site v${version} has no recorded GitHub remote — skipping repo delete`);
    outcomes.push({ resource: `github v${version}`, ok: true, skipped: true });
    return true;
  }
  const repo = repoSlugFromRemote(remote);
  if (!repo) {
    log.warn(
      `remove: could not parse owner/repo from remote "${remote}" for v${version} — skipping repo delete`,
    );
    outcomes.push({ resource: `github v${version}`, ok: true, skipped: true });
    return true;
  }
  const deleteRepo = params.deleteRepo ?? deleteGitHubRepo;
  const result: GitHubDeleteResult = await deleteRepo({
    repo,
    cwd: paths.versionDir(version),
    ghBin: config.ghBin,
    log,
  });
  outcomes.push({ resource: `github:${repo}`, ok: result.ok, detail: detailOf(result) });
  return result.ok;
}

/** Whole-Client teardown: delete every recorded repo, then the whole Pages project. */
async function teardownWholeClient(
  params: RemoveParams,
  sites: SiteVersionRef[],
  outcomes: ResourceOutcome[],
): Promise<boolean> {
  const { paths, config, log } = params;
  let ok = true;

  for (const site of sites) {
    const repoOk = await teardownGitHubRepo(params, site.version, site.remote, outcomes);
    ok &&= repoOk;
  }

  if (!sites.some((s) => s.deployUrl)) {
    log.info("remove: no Site Version was ever deployed — nothing to tear down on Cloudflare");
    return ok;
  }
  const projectName = pagesProjectName(paths.slug);
  const deleteProject = params.deleteProject ?? deletePagesProject;
  const result: CloudflareDeleteResult = await deleteProject({
    projectName,
    wranglerBin: config.wranglerBin,
    cwd: paths.dir,
    log,
  });
  outcomes.push({
    resource: `cloudflare:project ${projectName}`,
    ok: result.ok,
    detail: detailOf(result),
  });
  return ok && result.ok;
}

async function removeWholeClient(params: RemoveParams): Promise<RemovalResult> {
  const { paths, log, localOnly, force } = params;
  const client = readClient(paths.clientJson);
  const outcomes: ResourceOutcome[] = [];

  const ok = localOnly ? true : await teardownWholeClient(params, client?.sites ?? [], outcomes);

  if (!ok && !force) {
    log.error(
      "remove: one or more external teardowns failed — local data left intact " +
        "(use --force to remove it anyway)",
    );
    return { ok: false, outcomes, aborted: true };
  }

  removeClientDir(paths);
  log.success(`remove: deleted "${paths.name}" and all its data`);
  return { ok, outcomes };
}

/** Per-Version teardown: this Version's repo, and its deployment (or the whole project if it's the last one left). */
async function teardownOneVersion(
  params: RemoveParams,
  v: number,
  target: SiteVersionRef,
  isLastRemaining: boolean,
  outcomes: ResourceOutcome[],
): Promise<boolean> {
  const { paths, config, log } = params;
  let ok = await teardownGitHubRepo(params, v, target.remote, outcomes);

  const projectName = pagesProjectName(paths.slug);
  if (!target.deployUrl) {
    log.info(`remove: Site v${v} was never deployed — nothing to tear down on Cloudflare`);
    return ok;
  }

  if (isLastRemaining) {
    const deleteProject = params.deleteProject ?? deletePagesProject;
    const result = await deleteProject({
      projectName,
      wranglerBin: config.wranglerBin,
      cwd: paths.versionDir(v),
      log,
    });
    outcomes.push({
      resource: `cloudflare:project ${projectName}`,
      ok: result.ok,
      detail: detailOf(result),
    });
    return ok && result.ok;
  }

  const listDeployments = params.listDeployments ?? listPagesDeployments;
  const listResult = await listDeployments({
    projectName,
    wranglerBin: config.wranglerBin,
    cwd: paths.versionDir(v),
    log,
  });
  if (!listResult.ok) {
    outcomes.push({
      resource: `cloudflare:deployment for v${v}`,
      ok: false,
      detail: detailOf(listResult),
    });
    return false;
  }
  const match = listResult.deployments.find((d) => d.url === target.deployUrl);
  if (!match) {
    log.warn(
      `remove: no Cloudflare deployment matched the recorded URL for v${v} — skipping (may already be gone)`,
    );
    outcomes.push({ resource: `cloudflare:deployment for v${v}`, ok: true, skipped: true });
    return ok;
  }
  const deleteDeployment = params.deleteDeployment ?? deletePagesDeployment;
  const result = await deleteDeployment({
    deploymentId: match.id,
    projectName,
    wranglerBin: config.wranglerBin,
    cwd: paths.versionDir(v),
    log,
  });
  if (!result.ok && result.blockedByActiveProduction) {
    log.warn(
      `remove: Cloudflare won't delete deployment ${match.id} for v${v} — it is still ` +
        `"${projectName}"'s active production deployment, and Cloudflare has no way to delete ` +
        "that deployment or hand production to another one without it (wrangler error 8000034, " +
        "no CLI workaround exists). It will stay live at " +
        `${target.deployUrl} until the whole Cloudflare Pages project is deleted ` +
        `(e.g. \`sb remove ${paths.name}\`).`,
    );
    outcomes.push({
      resource: `cloudflare:deployment ${match.id}`,
      ok: true,
      skipped: true,
      detail: `left live — still the active production deployment: ${target.deployUrl}`,
    });
    return ok;
  }
  outcomes.push({
    resource: `cloudflare:deployment ${match.id}`,
    ok: result.ok,
    detail: detailOf(result),
  });
  ok &&= result.ok;
  return ok;
}

/**
 * Removal's Compaction (ADR-0012): shift every Version above the removed one
 * down by one, ascending, so each target slot is already vacated. Renames the
 * dir, rewrites the generation `state.json`'s version, and — best-effort —
 * renames the GitHub repo and updates the local `origin` remote. A rename
 * failure is reported but does not abort the shift: the local slot numbering
 * (the actual gaplessness invariant) is already committed by this point, so
 * leaving a survivor's repo under its old name is a recoverable loose end, not
 * a reason to leave the directory layout half-compacted.
 */
async function compactAbove(
  params: RemoveParams,
  higherRefs: SiteVersionRef[],
  outcomes: ResourceOutcome[],
): Promise<SiteVersionRef[]> {
  const { paths, config, log, localOnly } = params;
  const shifted: SiteVersionRef[] = [];

  for (const ref of higherRefs) {
    const from = ref.version;
    const to = from - 1;
    renameVersionDir(paths, from, to);
    renumberState(paths.versionState(to), to);

    let remote = ref.remote;
    if (!localOnly && remote) {
      const repo = repoSlugFromRemote(remote);
      if (repo) {
        const newName = githubRepoName(paths.slug, to);
        const renameRepo = params.renameRepo ?? renameGitHubRepo;
        const result = await renameRepo({
          repo,
          newName,
          cwd: paths.versionDir(to),
          ghBin: config.ghBin,
          log,
        });
        if (result.ok && result.remote) {
          setRemoteUrl(paths.versionDir(to), result.remote);
          remote = result.remote;
          outcomes.push({ resource: `github:${repo} → ${newName}`, ok: true });
        } else {
          log.warn(
            `remove: could not rename GitHub repo "${repo}" to "${newName}" — ` +
              `its remote still reads v${from} (${detailOf(result)})`,
          );
          outcomes.push({
            resource: `github:${repo} → ${newName}`,
            ok: false,
            detail: detailOf(result),
          });
        }
      }
    }
    shifted.push({ ...ref, version: to, remote });
  }

  return shifted;
}

async function removeOneVersion(params: RemoveParams, version: number): Promise<RemovalResult> {
  const { paths, log, localOnly, force } = params;

  const client = readClient(paths.clientJson);
  if (!client) {
    throw new UserError(`cannot remove Site Version: no client.json at ${paths.clientJson}`);
  }
  const target = client.sites.find((s) => s.version === version);
  if (!target) {
    throw new UserError(`no Site Version v${version} recorded for "${paths.name}"`);
  }
  const isLastRemaining = client.sites.length === 1;
  const higherRefs = client.sites
    .filter((s) => s.version > version)
    .sort((a, b) => a.version - b.version);

  const outcomes: ResourceOutcome[] = [];
  const ok = localOnly
    ? true
    : await teardownOneVersion(params, version, target, isLastRemaining, outcomes);

  if (!ok && !force) {
    log.error(
      `remove: one or more external teardowns failed for v${version} — local data left intact ` +
        "(use --force to remove it anyway)",
    );
    return { ok: false, outcomes, aborted: true };
  }

  removeVersionDir(paths, version);
  const shiftedRefs = await compactAbove(params, higherRefs, outcomes);

  const untouched = client.sites.filter((s) => s.version < version);
  setSiteVersions(paths.clientJson, [...untouched, ...shiftedRefs]);
  clearStaleTargetVersion(paths.state, version);

  const shiftNote =
    higherRefs.length > 0
      ? ` — v${version + 1}..v${version + higherRefs.length} shifted down by one`
      : "";
  log.success(`remove: deleted Site v${version} for "${paths.name}"${shiftNote}`);
  return { ok, outcomes };
}

/** Runs `sb remove`: whole-Client scope when `params.version` is unset, one Site Version otherwise. */
export async function runRemove(params: RemoveParams): Promise<RemovalResult> {
  const { version } = params;
  return version === undefined ? removeWholeClient(params) : removeOneVersion(params, version);
}

/** One Site Version's removal-relevant facts, for a `--dry-run` preview. */
export interface PreviewVersion {
  version: number;
  versionDir: string;
  deployUrl?: string;
  remote?: string;
  /** Set when this Version will shift down to a new number (Removal's Compaction). */
  willShiftTo?: number;
}

export interface RemovalPreview {
  scope: "client" | "version";
  clientDir: string;
  versions: PreviewVersion[];
  /** True when the whole Cloudflare Pages project will be deleted rather than one deployment. */
  deleteWholeProject: boolean;
  /**
   * True when the targeted Version is the highest-numbered one left (so it's
   * likely still Cloudflare's active production deployment) while other,
   * lower Versions survive it. Cloudflare refuses to delete that deployment
   * (API error 8000034, no wrangler workaround) — removal still proceeds, but
   * that one deployment is left live rather than deleted.
   */
  mayBeActiveProduction: boolean;
}

/**
 * Describes what `sb remove` would do, without touching anything — the
 * `--dry-run` and confirmation-prompt summary. Reads only `client.json`; it
 * does not call out to GitHub/Cloudflare to resolve exact deployment IDs.
 */
export function previewRemoval(paths: ClientPaths, version?: number): RemovalPreview {
  const client = readClient(paths.clientJson);
  const sites = client?.sites ?? [];

  if (version === undefined) {
    return {
      scope: "client",
      clientDir: paths.dir,
      versions: sites.map((s) => ({
        version: s.version,
        versionDir: paths.versionDir(s.version),
        deployUrl: s.deployUrl,
        remote: s.remote,
      })),
      deleteWholeProject: true,
      mayBeActiveProduction: false,
    };
  }

  const target = sites.find((s) => s.version === version);
  if (!target) {
    throw new UserError(`no Site Version v${version} recorded for "${paths.name}"`);
  }
  const higher = sites.filter((s) => s.version > version).sort((a, b) => a.version - b.version);

  return {
    scope: "version",
    clientDir: paths.dir,
    mayBeActiveProduction: higher.length === 0 && sites.length > 1 && target.deployUrl !== undefined,
    versions: [
      {
        version: target.version,
        versionDir: paths.versionDir(version),
        deployUrl: target.deployUrl,
        remote: target.remote,
      },
      ...higher.map((s) => ({
        version: s.version,
        versionDir: paths.versionDir(s.version),
        deployUrl: s.deployUrl,
        remote: s.remote,
        willShiftTo: s.version - 1,
      })),
    ],
    deleteWholeProject: sites.length === 1,
  };
}
