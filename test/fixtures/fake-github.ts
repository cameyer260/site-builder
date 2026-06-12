import type { GitHubPublisher } from "../../src/github/github.ts";

/**
 * Offline stand-in for the `push` GitHub publish seam. Returns a deterministic
 * `github.com/<owner>/<repo>` remote shaped like a real `gh repo create` result,
 * without spawning the gh CLI or touching the network.
 */
export const fakeGitHub: GitHubPublisher = async ({ repoName }) => ({
  ok: true,
  remote: `https://github.com/acme/${repoName}`,
  output: `✓ Created repository acme/${repoName} on GitHub\nhttps://github.com/acme/${repoName}`,
});
