import { existsSync } from "node:fs";
import { join } from "node:path";
import { recordSiteVersion } from "../storage/client.ts";
import type { ClientPaths } from "../storage/layout.ts";
import { UserError } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";
import { type GitHubPublisher, githubRepoName, publishToGitHub } from "./github.ts";

/**
 * `sb push` (and `build`/`variant --github`): publish one Site Version to a new
 * private GitHub repo and record the remote on the Client's Site Version pointer
 * (ADR-0003/0004). Independent of `deploy` — pushing source to GitHub and
 * deploying to Cloudflare Pages are orthogonal. The publisher is behind an
 * injectable seam so tests never shell out to the gh CLI.
 */

export interface PushParams {
  paths: ClientPaths;
  /** The Site Version to publish. */
  version: number;
  /** The gh binary (`config.ghBin`). */
  ghBin: string;
  log: Logger;
  /** Injected publisher (tests stub it); defaults to the real gh CLI one. */
  publish?: GitHubPublisher;
}

/** Publishes the Site Version and returns its GitHub remote URL. */
export async function runPush(params: PushParams): Promise<string> {
  const { paths, version, ghBin, log } = params;
  const publish = params.publish ?? publishToGitHub;

  const versionDir = paths.versionDir(version);
  if (!existsSync(join(versionDir, ".git"))) {
    throw new UserError(
      `push: Site v${version} is not a git repo`,
      "run `sb build` or `sb variant` to generate the Site first",
    );
  }

  const result = await publish({
    siteDir: versionDir,
    repoName: githubRepoName(paths.slug, version),
    ghBin,
    log,
  });
  if (!result.ok) {
    throw new UserError("push: `gh repo create` failed", result.output.trim().slice(-1500));
  }
  if (!result.remote) {
    throw new UserError(
      "push: repo created, but could not determine its remote URL",
      result.output.trim().slice(-1500),
    );
  }

  // The CRM record is never a stage output, so this survives resume (ADR-0003).
  recordSiteVersion(paths.clientJson, { version, repoPath: versionDir, remote: result.remote });
  log.success(`push: published Site v${version} → ${result.remote}`);
  return result.remote;
}
