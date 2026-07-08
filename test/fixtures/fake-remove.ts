import type {
  DeploymentDeleter,
  DeploymentLister,
  ProjectDeleter,
} from "../../src/deploy/wrangler.ts";
import type { GitHubRepoDeleter, GitHubRepoRenamer } from "../../src/github/github.ts";

/**
 * Offline stand-ins for `sb remove`'s teardown seams. Each returns a
 * deterministic success shaped like the real gh/wrangler CLI output, without
 * spawning either or touching the network, keeping remove tests fast and
 * offline (per the testing posture in AGENTS.md).
 */

export const fakeDeleteRepo: GitHubRepoDeleter = async ({ repo }) => ({
  ok: true,
  output: `✓ Deleted repository ${repo}`,
});

export const fakeRenameRepo: GitHubRepoRenamer = async ({ repo, newName }) => {
  const owner = repo.split("/")[0];
  return {
    ok: true,
    remote: `https://github.com/${owner}/${newName}`,
    output: `✓ Renamed to ${newName}`,
  };
};

/** Deployment ids are derived from the project so multiple projects don't collide in one test. */
export const fakeListDeployments: DeploymentLister = async ({ projectName }) => ({
  ok: true,
  deployments: [{ id: `${projectName}-deployment-id`, url: `https://x.${projectName}.pages.dev` }],
  output: JSON.stringify([
    { id: `${projectName}-deployment-id`, url: `https://x.${projectName}.pages.dev` },
  ]),
});

export const fakeDeleteDeployment: DeploymentDeleter = async ({ deploymentId }) => ({
  ok: true,
  output: `✓ Deleted deployment ${deploymentId}`,
});

export const fakeDeleteProject: ProjectDeleter = async ({ projectName }) => ({
  ok: true,
  output: `✓ Deleted project ${projectName}`,
});
