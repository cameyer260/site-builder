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
