import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, DEFAULTS } from "../src/config/schema.ts";
import { pagesProjectName } from "../src/deploy/wrangler.ts";
import { githubRepoName } from "../src/github/github.ts";
import { stageNamesFor } from "../src/pipeline/pipeline.ts";
import {
  type PreviewVersion,
  previewRemoval,
  type RemoveParams,
  runRemove,
} from "../src/remove/remove.ts";
import { newClient, readClient, recordSiteVersion, writeClient } from "../src/storage/client.ts";
import { clientPaths } from "../src/storage/layout.ts";
import { emptyState, readState, writeState } from "../src/storage/state.ts";
import { remoteUrl } from "../src/util/git.ts";
import { createLogger } from "../src/util/log.ts";
import {
  fakeDeleteDeployment,
  fakeDeleteProject,
  fakeDeleteRepo,
  fakeListDeployments,
  fakeRenameRepo,
} from "./fixtures/fake-remove.ts";

const log = createLogger({ quiet: true });
const config = { ...DEFAULTS, root: "/unused" } as Config;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sb-remove-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const seams = {
  deleteRepo: fakeDeleteRepo,
  renameRepo: fakeRenameRepo,
  listDeployments: fakeListDeployments,
  deleteDeployment: fakeDeleteDeployment,
  deleteProject: fakeDeleteProject,
};

/** A registered Client with real (empty) git repos for each of `versions`, each recorded on client.json with a deploy URL + GitHub remote shaped like the real seams expect. */
function setup(name: string, versions: number[]) {
  const paths = clientPaths(root, name);
  mkdirSync(paths.dir, { recursive: true });
  writeClient(paths.clientJson, newClient(name, { docs: [], images: [], notes: "n" }));

  const projectName = pagesProjectName(paths.slug);
  for (const v of versions) {
    const versionDir = paths.versionDir(v);
    mkdirSync(versionDir, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: versionDir });
    const remote = `https://github.com/acme/${githubRepoName(paths.slug, v)}`;
    spawnSync("git", ["remote", "add", "origin", remote], { cwd: versionDir });

    const state = emptyState("generation", stageNamesFor("generation"), v);
    writeState(paths.versionState(v), state);

    recordSiteVersion(paths.clientJson, {
      version: v,
      deployUrl: `https://x.${projectName}.pages.dev`,
      remote,
    });
  }
  return paths;
}

test("previewRemoval — whole Client scope lists every Version and always deletes the project", () => {
  const paths = setup("Acme", [1, 2]);
  const preview = previewRemoval(paths);
  expect(preview.scope).toBe("client");
  expect(preview.versions.map((v) => v.version)).toEqual([1, 2]);
  expect(preview.deleteWholeProject).toBe(true);
});

test("previewRemoval — version scope marks higher Versions with willShiftTo", () => {
  const paths = setup("Acme", [1, 2, 3]);
  const preview = previewRemoval(paths, 1);
  expect(preview.scope).toBe("version");
  const byVersion = new Map<number, PreviewVersion>(preview.versions.map((v) => [v.version, v]));
  expect(byVersion.get(1)?.willShiftTo).toBeUndefined();
  expect(byVersion.get(2)?.willShiftTo).toBe(1);
  expect(byVersion.get(3)?.willShiftTo).toBe(2);
  expect(preview.deleteWholeProject).toBe(false);
});

test("previewRemoval flags mayBeActiveProduction only for the highest surviving, deployed Version", () => {
  const paths = setup("Acme", [1, 2, 3]);
  // sandwiched or lowest: other Versions survive above it, so it's not the active deployment
  expect(previewRemoval(paths, 1).mayBeActiveProduction).toBe(false);
  expect(previewRemoval(paths, 2).mayBeActiveProduction).toBe(false);
  // the highest surviving Version is the one Cloudflare is likely to still call "production"
  expect(previewRemoval(paths, 3).mayBeActiveProduction).toBe(true);
  // the last remaining Version deletes the whole project instead — no deployment-level restriction
  const solo = setup("Solo", [1]);
  expect(previewRemoval(solo, 1).mayBeActiveProduction).toBe(false);
  // whole-Client scope always deletes the whole project too
  expect(previewRemoval(paths).mayBeActiveProduction).toBe(false);
});

test("previewRemoval throws for a Version that doesn't exist", () => {
  const paths = setup("Acme", [1]);
  expect(() => previewRemoval(paths, 9)).toThrow(/no Site Version v9/);
});

test("runRemove — whole Client deletes every repo, the whole project, then the directory", async () => {
  const paths = setup("Acme", [1, 2]);
  const deletedRepos: string[] = [];
  const deletedProjects: string[] = [];

  const result = await runRemove({
    paths,
    config,
    log,
    ...seams,
    deleteRepo: async (p) => {
      deletedRepos.push(p.repo);
      return fakeDeleteRepo(p);
    },
    deleteProject: async (p) => {
      deletedProjects.push(p.projectName);
      return fakeDeleteProject(p);
    },
  } satisfies RemoveParams);

  expect(result.ok).toBe(true);
  expect(deletedRepos.sort()).toEqual(["acme/acme-v1", "acme/acme-v2"]);
  expect(deletedProjects).toEqual([pagesProjectName(paths.slug)]);
  expect(existsSync(paths.dir)).toBe(false);
});

test("runRemove — whole Client skips the Cloudflare project when nothing was ever deployed", async () => {
  const paths = clientPaths(root, "Never Deployed");
  mkdirSync(paths.dir, { recursive: true });
  writeClient(paths.clientJson, newClient("Never Deployed", { docs: [], images: [], notes: "n" }));
  mkdirSync(paths.versionDir(1), { recursive: true });
  recordSiteVersion(paths.clientJson, { version: 1 }); // no deployUrl, no remote

  let projectDeleteCalls = 0;
  const result = await runRemove({
    paths,
    config,
    log,
    ...seams,
    deleteProject: async (p) => {
      projectDeleteCalls += 1;
      return fakeDeleteProject(p);
    },
  } satisfies RemoveParams);

  expect(result.ok).toBe(true);
  expect(projectDeleteCalls).toBe(0);
  expect(existsSync(paths.dir)).toBe(false);
});

test("runRemove — removing a sandwiched Version compacts every higher Version down by one", async () => {
  const paths = setup("Acme", [1, 2, 3, 4, 5]);

  const result = await runRemove({
    paths,
    version: 3,
    config,
    log,
    ...seams,
  } satisfies RemoveParams);
  expect(result.ok).toBe(true);

  // v3 is gone; v4 -> v3, v5 -> v4; v1/v2 untouched; no v5 left.
  expect(existsSync(paths.versionDir(5))).toBe(false);
  expect(existsSync(paths.versionDir(1))).toBe(true);
  expect(existsSync(paths.versionDir(2))).toBe(true);
  expect(existsSync(paths.versionDir(3))).toBe(true);
  expect(existsSync(paths.versionDir(4))).toBe(true);

  // The renamed dirs' state.json now reports their new slot.
  expect(readState(paths.versionState(3))?.version).toBe(3);
  expect(readState(paths.versionState(4))?.version).toBe(4);

  // client.json: v1/v2 untouched, v3/v4 are the shifted refs with renamed remotes.
  const client = readClient(paths.clientJson);
  const byVersion = new Map(client?.sites.map((s) => [s.version, s]));
  expect([...byVersion.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  expect(byVersion.get(3)?.remote).toBe(`https://github.com/acme/${githubRepoName(paths.slug, 3)}`);
  expect(byVersion.get(4)?.remote).toBe(`https://github.com/acme/${githubRepoName(paths.slug, 4)}`);
  // deployUrl is untouched by compaction (Cloudflare URLs aren't derived from the version number).
  expect(byVersion.get(3)?.deployUrl).toContain(".pages.dev");

  // The local git checkout's origin was actually updated to the renamed repo.
  expect(remoteUrl(paths.versionDir(3))).toBe(
    `https://github.com/acme/${githubRepoName(paths.slug, 3)}`,
  );
  expect(remoteUrl(paths.versionDir(4))).toBe(
    `https://github.com/acme/${githubRepoName(paths.slug, 4)}`,
  );
});

test("runRemove — removing a Client's only Version deletes the whole Cloudflare project, not a deployment", async () => {
  const paths = setup("Solo", [1]);
  let listCalls = 0;
  let projectDeleteCalls = 0;

  const result = await runRemove({
    paths,
    version: 1,
    config,
    log,
    ...seams,
    listDeployments: async (p) => {
      listCalls += 1;
      return fakeListDeployments(p);
    },
    deleteProject: async (p) => {
      projectDeleteCalls += 1;
      return fakeDeleteProject(p);
    },
  } satisfies RemoveParams);

  expect(result.ok).toBe(true);
  expect(listCalls).toBe(0);
  expect(projectDeleteCalls).toBe(1);
  expect(readClient(paths.clientJson)?.sites).toEqual([]);
});

test("runRemove — a Version with no recorded remote/deployUrl skips teardown instead of failing", async () => {
  const paths = clientPaths(root, "Partial");
  mkdirSync(paths.dir, { recursive: true });
  writeClient(paths.clientJson, newClient("Partial", { docs: [], images: [], notes: "n" }));
  mkdirSync(paths.versionDir(1), { recursive: true });
  mkdirSync(paths.versionDir(2), { recursive: true });
  recordSiteVersion(paths.clientJson, { version: 1 }); // no remote, no deployUrl
  recordSiteVersion(paths.clientJson, { version: 2 });

  const result = await runRemove({
    paths,
    version: 1,
    config,
    log,
    ...seams,
  } satisfies RemoveParams);

  expect(result.ok).toBe(true);
  const githubOutcome = result.outcomes.find((o) => o.resource.startsWith("github v1"));
  expect(githubOutcome).toEqual({ resource: "github v1", ok: true, skipped: true });
});

test("runRemove — a deployment blocked by Cloudflare's active-production restriction is a loud skip, not a failure", async () => {
  const paths = setup("Acme", [1, 2]);

  const result = await runRemove({
    paths,
    version: 2, // the highest surviving Version — the one likely to be active production
    config,
    log,
    ...seams,
    deleteDeployment: async () => ({
      ok: false,
      output: "You cannot delete the active production deployment. [code: 8000034]",
      blockedByActiveProduction: true,
    }),
  } satisfies RemoveParams);

  expect(result.ok).toBe(true);
  expect(result.aborted).toBeUndefined();
  const outcome = result.outcomes.find((o) => o.resource.startsWith("cloudflare:deployment"));
  expect(outcome).toMatchObject({ ok: true, skipped: true });
  expect(outcome?.detail).toContain("pages.dev");
  // local removal proceeded despite the deployment being left live on Cloudflare
  expect(existsSync(paths.versionDir(2))).toBe(false);
  expect(readClient(paths.clientJson)?.sites.map((s) => s.version)).toEqual([1]);
});

test("runRemove — a failed teardown aborts before any local deletion, unless --force", async () => {
  const paths = setup("Acme", [1, 2]);
  const failing = {
    ...seams,
    deleteRepo: async () => ({ ok: false, output: "gh: insufficient scope" }),
  };

  // v2 (the highest Version) so a forced removal has nothing above it to compact,
  // isolating the abort/force behavior from compaction's own directory reuse.
  const aborted = await runRemove({
    paths,
    version: 2,
    config,
    log,
    ...failing,
  } satisfies RemoveParams);
  expect(aborted.ok).toBe(false);
  expect(aborted.aborted).toBe(true);
  expect(existsSync(paths.versionDir(2))).toBe(true);
  expect(readClient(paths.clientJson)?.sites.map((s) => s.version)).toEqual([1, 2]);

  const forced = await runRemove({
    paths,
    version: 2,
    config,
    log,
    force: true,
    ...failing,
  } satisfies RemoveParams);
  expect(forced.ok).toBe(false); // the teardown still failed...
  expect(forced.aborted).toBeUndefined();
  expect(existsSync(paths.versionDir(2))).toBe(false); // ...but local deletion proceeded anyway
  expect(readClient(paths.clientJson)?.sites.map((s) => s.version)).toEqual([1]);
});

test("runRemove — --local-only skips every external call", async () => {
  const paths = setup("Acme", [1, 2]);
  let externalCalls = 0;
  const counting = {
    deleteRepo: async (p: Parameters<typeof fakeDeleteRepo>[0]) => {
      externalCalls += 1;
      return fakeDeleteRepo(p);
    },
    renameRepo: async (p: Parameters<typeof fakeRenameRepo>[0]) => {
      externalCalls += 1;
      return fakeRenameRepo(p);
    },
    listDeployments: async (p: Parameters<typeof fakeListDeployments>[0]) => {
      externalCalls += 1;
      return fakeListDeployments(p);
    },
    deleteDeployment: async (p: Parameters<typeof fakeDeleteDeployment>[0]) => {
      externalCalls += 1;
      return fakeDeleteDeployment(p);
    },
    deleteProject: async (p: Parameters<typeof fakeDeleteProject>[0]) => {
      externalCalls += 1;
      return fakeDeleteProject(p);
    },
  };

  const result = await runRemove({
    paths,
    version: 1,
    config,
    log,
    localOnly: true,
    ...counting,
  } satisfies RemoveParams);

  expect(result.ok).toBe(true);
  expect(externalCalls).toBe(0);
  // v1 removed; v2 shifted down into the freed v1 slot, so v2's dir no longer exists.
  expect(existsSync(paths.versionDir(1))).toBe(true);
  expect(existsSync(paths.versionDir(2))).toBe(false);
  expect(readState(paths.versionState(1))?.version).toBe(1);
});
