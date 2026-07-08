import { runCommand } from "../astro/run.ts";
import { remoteUrl } from "../util/git.ts";
import type { Logger } from "../util/log.ts";

/**
 * The GitHub publish seam for the opt-in `--github`/`sb push` flow (ADR-0004).
 * GitHub is a fully optional, independent feature: a live link comes purely from
 * `astro build` + `wrangler pages deploy`, so nothing in the core pipeline
 * depends on this. Each Site Version is already its own git repo (seeded by
 * `generate`); publishing creates a private GitHub repo from that tree and pushes
 * it via `gh repo create … --source=<dir> --push`. `--github` creates the repo —
 * it never links an existing one.
 *
 * The real publisher shells out to the GitHub CLI via the shared {@link
 * runCommand}; tests inject a fake through {@link GitHubPublisher} so they never
 * touch the network.
 */

export interface PublishResult {
  ok: boolean;
  /** The created repo's remote URL, read from `origin` after the push. */
  remote?: string;
  /** Tail of the gh CLI's combined output, for diagnostics on failure. */
  output: string;
}

export interface PublishParams {
  /** The Site Version directory — a git repo, and the gh CLI's `--source`. */
  siteDir: string;
  /** The GitHub repository name to create (derived per Site Version). */
  repoName: string;
  /** The gh binary (`config.ghBin`). */
  ghBin: string;
  log: Logger;
}

/** The injectable shape `push` accepts so tests can stub the whole publish. */
export type GitHubPublisher = (params: PublishParams) => Promise<PublishResult>;

const CREATE_TIMEOUT_MS = 120_000;

/**
 * GitHub repository name for a Site Version. The slug already satisfies repo
 * naming (lowercase, `a–z0–9-`); the version suffix keeps each Site Version's
 * repo distinct, since every version is its own local git repo (kit.ts).
 */
export function githubRepoName(slug: string, version: number): string {
  return `${slug}-v${version}`;
}

/** Pulls the first `github.com/<owner>/<repo>` URL out of the gh CLI's output. */
export function parseRemoteUrl(output: string): string | undefined {
  return output.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/)?.[0]?.replace(/\.git$/, "");
}

/** The real publisher: create a private repo from the Site Version tree and push. */
export const publishToGitHub: GitHubPublisher = async ({ siteDir, repoName, ghBin, log }) => {
  log.step(`push: creating private GitHub repo "${repoName}"`);
  const result = await runCommand(
    ghBin,
    ["repo", "create", repoName, "--private", "--source", siteDir, "--push"],
    { cwd: siteDir, log, timeoutMs: CREATE_TIMEOUT_MS },
  );
  // Prefer the authoritative `origin` URL git recorded over scraping gh output.
  const remote = result.ok ? (remoteUrl(siteDir) ?? parseRemoteUrl(result.output)) : undefined;
  return { ok: result.ok, remote, output: result.output };
};

/**
 * The GitHub teardown seams for `sb remove` (ADR-0012): deleting a Site
 * Version's repo outright, and renaming one during Removal's Compaction (a
 * shifted Version keeps its repo, just renumbered to match its new slot).
 * Both take the already-known `owner/repo` slug — parsed from the stored
 * `remote` by {@link repoSlugFromRemote} — rather than re-deriving it, since
 * `client.json` is the only remaining record once the local checkout is gone.
 */

/** Pulls `owner/repo` out of a stored `https://github.com/<owner>/<repo>` remote URL. */
export function repoSlugFromRemote(remote: string): string | undefined {
  return remote.match(/github\.com\/([\w.-]+\/[\w.-]+)/)?.[1];
}

export interface DeleteRepoParams {
  /** `owner/repo`, parsed from the stored remote. */
  repo: string;
  /** Working directory for the gh CLI call — the repo is addressed explicitly, so this is only for consistency/logging. */
  cwd: string;
  /** The gh binary (`config.ghBin`). */
  ghBin: string;
  log: Logger;
}

export interface GitHubDeleteResult {
  ok: boolean;
  output: string;
}

/** The injectable shape `remove` accepts for deleting a repo outright. */
export type GitHubRepoDeleter = (params: DeleteRepoParams) => Promise<GitHubDeleteResult>;

const DELETE_TIMEOUT_MS = 60_000;
const RENAME_TIMEOUT_MS = 60_000;

/**
 * The real deleter: `gh repo delete <owner/repo> --yes`. Deletion requires the
 * `delete_repo` scope on top of the base `gh auth login` (`config doctor` notes
 * this); a missing scope surfaces as a failed result, never a thrown error.
 */
export const deleteGitHubRepo: GitHubRepoDeleter = async ({ repo, cwd, ghBin, log }) => {
  log.step(`remove: deleting GitHub repo "${repo}"`);
  const result = await runCommand(ghBin, ["repo", "delete", repo, "--yes"], {
    cwd,
    log,
    timeoutMs: DELETE_TIMEOUT_MS,
  });
  return { ok: result.ok, output: result.output };
};

export interface RenameRepoParams {
  /** Current `owner/repo`, parsed from the stored remote. */
  repo: string;
  /** The new repo name (bare, same owner) — the shifted Version's `<slug>-vN`. */
  newName: string;
  /** Working directory for the gh CLI call — see {@link DeleteRepoParams.cwd}. */
  cwd: string;
  /** The gh binary (`config.ghBin`). */
  ghBin: string;
  log: Logger;
}

export interface RenameRepoResult {
  ok: boolean;
  /** The renamed repo's new remote URL, reconstructed from `owner` + `newName`. */
  remote?: string;
  output: string;
}

/** The injectable shape `remove` accepts for renaming a repo during Compaction. */
export type GitHubRepoRenamer = (params: RenameRepoParams) => Promise<RenameRepoResult>;

/** The real renamer: `gh repo rename <newName> -R <owner/repo> --yes`. */
export const renameGitHubRepo: GitHubRepoRenamer = async ({ repo, newName, cwd, ghBin, log }) => {
  log.step(`remove: renaming GitHub repo "${repo}" → "${newName}"`);
  const result = await runCommand(ghBin, ["repo", "rename", newName, "-R", repo, "--yes"], {
    cwd,
    log,
    timeoutMs: RENAME_TIMEOUT_MS,
  });
  if (!result.ok) {
    return { ok: false, output: result.output };
  }
  const owner = repo.split("/")[0];
  return { ok: true, remote: `https://github.com/${owner}/${newName}`, output: result.output };
};
