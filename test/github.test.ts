import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GitHubPublisher, githubRepoName, parseRemoteUrl } from "../src/github/github.ts";
import { runPush } from "../src/github/push.ts";
import { newClient, readClient, writeClient } from "../src/storage/client.ts";
import { clientPaths } from "../src/storage/layout.ts";
import { createLogger } from "../src/util/log.ts";
import { fakeGitHub } from "./fixtures/fake-github.ts";

const log = createLogger({ quiet: true });

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sb-gh-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A registered Client whose v1 Site Version dir is a git repo. */
function setup(name = "Tailored Co.", version = 1) {
  const paths = clientPaths(root, name);
  mkdirSync(paths.dir, { recursive: true });
  writeClient(paths.clientJson, newClient(name, { docs: [], images: [], notes: "n" }));
  mkdirSync(join(paths.versionDir(version), ".git"), { recursive: true });
  return paths;
}

test("githubRepoName suffixes the slug with the version", () => {
  expect(githubRepoName("tailored-co", 1)).toBe("tailored-co-v1");
  expect(githubRepoName("tailored-co", 3)).toBe("tailored-co-v3");
});

test("parseRemoteUrl pulls the repo URL and strips a trailing .git", () => {
  const output = "✓ Created repository acme/site on GitHub\nhttps://github.com/acme/site.git";
  expect(parseRemoteUrl(output)).toBe("https://github.com/acme/site");
  expect(parseRemoteUrl("no url here")).toBeUndefined();
});

test("runPush publishes and records the remote on the Site Version", async () => {
  const paths = setup();
  let repoName = "";

  const remote = await runPush({
    paths,
    version: 1,
    ghBin: "gh",
    log,
    publish: async (params) => {
      repoName = params.repoName;
      return fakeGitHub(params);
    },
  });

  expect(repoName).toBe(`${paths.slug}-v1`);
  expect(remote).toBe(`https://github.com/acme/${paths.slug}-v1`);

  const client = readClient(paths.clientJson);
  expect(client?.sites).toEqual([{ version: 1, repoPath: paths.versionDir(1), remote }]);
});

test("runPush throws when the Site Version is not a git repo", async () => {
  const paths = clientPaths(root, "No Repo");
  mkdirSync(paths.dir, { recursive: true });
  writeClient(paths.clientJson, newClient("No Repo", { docs: [], images: [], notes: "n" }));

  let caught: unknown;
  try {
    await runPush({ paths, version: 1, ghBin: "gh", log, publish: fakeGitHub });
  } catch (err) {
    caught = err;
  }
  expect((caught as Error)?.message).toMatch(/not a git repo/);
});

test("runPush throws when gh repo create fails, recording nothing", async () => {
  const paths = setup();
  const failing: GitHubPublisher = async () => ({
    ok: false,
    output: "GraphQL: Name already exists on this account (createRepository)",
  });

  let caught: unknown;
  try {
    await runPush({ paths, version: 1, ghBin: "gh", log, publish: failing });
  } catch (err) {
    caught = err;
  }
  expect((caught as Error)?.message).toMatch(/gh repo create. failed/);
  expect(readClient(paths.clientJson)?.sites).toEqual([]);
});
