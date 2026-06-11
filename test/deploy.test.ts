import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../src/astro/run.ts";
import { type Config, DEFAULTS } from "../src/config/schema.ts";
import { runDeploy } from "../src/deploy/deploy.ts";
import { type DeployRunner, pagesProjectName, parsePagesUrl } from "../src/deploy/wrangler.ts";
import { newClient, readClient, recordSiteVersion, writeClient } from "../src/storage/client.ts";
import { clientPaths } from "../src/storage/layout.ts";
import { createLogger } from "../src/util/log.ts";
import { fakeDeploy } from "./fixtures/fake-deploy.ts";

const log = createLogger({ quiet: true });
const config = { ...DEFAULTS, root: "/unused" } as Config;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sb-deploy-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A built Site Version dir + a registered Client to record the URL onto. */
function setup(name = "Tailored Co.") {
  const paths = clientPaths(root, name);
  mkdirSync(paths.dir, { recursive: true });
  writeClient(paths.clientJson, newClient(name, { docs: [], images: [], notes: "n" }));
  const versionDir = paths.versionDir(1);
  mkdirSync(join(versionDir, "dist"), { recursive: true });
  writeFileSync(join(versionDir, "dist", "index.html"), "<!doctype html>");
  return { paths, versionDir };
}

/** A compile gate that mimics `astro build` emitting a dist/. */
function fakeBuild(onCall?: () => void) {
  return async (siteDir: string): Promise<CommandResult> => {
    onCall?.();
    mkdirSync(join(siteDir, "dist"), { recursive: true });
    writeFileSync(join(siteDir, "dist", "index.html"), "<!doctype html>");
    return { ok: true, code: 0, output: "" };
  };
}

test("runDeploy uploads dist and records the *.pages.dev URL on the version", async () => {
  const { paths } = setup();
  let deployCalls = 0;
  let buildCalls = 0;

  const url = await runDeploy({
    paths,
    config,
    version: 1,
    log,
    buildSite: fakeBuild(() => {
      buildCalls += 1;
    }),
    deploy: async (params) => {
      deployCalls += 1;
      expect(params.projectName).toBe(paths.slug);
      expect(params.distDir).toBe(join(paths.versionDir(1), "dist"));
      return fakeDeploy(params);
    },
  });

  expect(url).toBe(`https://${paths.slug}.pages.dev`);
  expect(deployCalls).toBe(1);
  // dist already existed, so the compile gate was skipped.
  expect(buildCalls).toBe(0);

  const client = readClient(paths.clientJson);
  expect(client?.sites).toEqual([{ version: 1, deployUrl: url }]);
});

test("runDeploy builds first when no dist is present", async () => {
  const { paths, versionDir } = setup();
  rmSync(join(versionDir, "dist"), { recursive: true, force: true });
  let buildCalls = 0;

  await runDeploy({
    paths,
    config,
    version: 1,
    log,
    buildSite: fakeBuild(() => {
      buildCalls += 1;
    }),
    deploy: fakeDeploy,
  });

  expect(buildCalls).toBe(1);
});

test("runDeploy throws when wrangler deploy fails", async () => {
  const { paths } = setup();
  const failing: DeployRunner = async () => ({
    ok: false,
    output: "Authentication error [code: 10000]",
  });

  let caught: unknown;
  try {
    await runDeploy({ paths, config, version: 1, log, buildSite: fakeBuild(), deploy: failing });
  } catch (err) {
    caught = err;
  }
  expect((caught as Error)?.message).toMatch(/wrangler pages deploy failed/);
  // nothing recorded on a failed deploy
  expect(readClient(paths.clientJson)?.sites).toEqual([]);
});

test("runDeploy throws when the deploy URL can't be determined", async () => {
  const { paths } = setup();
  const noUrl: DeployRunner = async () => ({ ok: true, output: "done, but no link printed" });

  let caught: unknown;
  try {
    await runDeploy({ paths, config, version: 1, log, buildSite: fakeBuild(), deploy: noUrl });
  } catch (err) {
    caught = err;
  }
  expect((caught as Error)?.message).toMatch(/could not determine the \*\.pages\.dev URL/);
});

test("parsePagesUrl picks the last pages.dev link and strips trailing punctuation", () => {
  const output = [
    "🌍 Uploading... (3/3)",
    "✨ Deployment complete! Take a peek over at https://a1b2c3.tailored-co.pages.dev.",
  ].join("\n");
  expect(parsePagesUrl(output)).toBe("https://a1b2c3.tailored-co.pages.dev");
  expect(parsePagesUrl("no link here")).toBeUndefined();
});

test("pagesProjectName keeps the slug but caps it at 58 chars", () => {
  expect(pagesProjectName("tailored-co")).toBe("tailored-co");
  const long = "a".repeat(70);
  expect(pagesProjectName(long)).toBe("a".repeat(58));
  // a hyphen landing on the boundary is trimmed (Pages rejects trailing hyphens)
  expect(pagesProjectName(`${"a".repeat(57)}-bc`)).toBe("a".repeat(57));
});

test("recordSiteVersion merges into the existing entry, preserving other fields", () => {
  const { paths } = setup();
  // a prior generation recorded a repo path for v1
  recordSiteVersion(paths.clientJson, { version: 1, repoPath: "/clients/tailored-co/sites/v1" });
  // deploy later records the URL — repoPath must survive
  recordSiteVersion(paths.clientJson, { version: 1, deployUrl: "https://x.pages.dev" });
  // a second variant appends, keeping order
  recordSiteVersion(paths.clientJson, { version: 2, deployUrl: "https://y.pages.dev" });

  expect(readClient(paths.clientJson)?.sites).toEqual([
    { version: 1, repoPath: "/clients/tailored-co/sites/v1", deployUrl: "https://x.pages.dev" },
    { version: 2, deployUrl: "https://y.pages.dev" },
  ]);
});
