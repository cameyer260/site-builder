import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasLocalAstroBin, runCommand } from "../src/astro/run.ts";
import { type Config, DEFAULTS } from "../src/config/schema.ts";
import { runGenerate } from "../src/generate/generate.ts";
import { readImagesManifest, resolveImages } from "../src/generate/pexels.ts";
import { type QaAsk, runQaSession } from "../src/generate/qa.ts";
import { newClient } from "../src/storage/client.ts";
import { clientPaths } from "../src/storage/layout.ts";
import { CHECKLIST } from "../src/synthesize/checklist.ts";
import {
  type Profile,
  ProfileSchema,
  statusCounts,
  writeProfile,
} from "../src/synthesize/profile.ts";
import { createLogger } from "../src/util/log.ts";
import { fakeGenerateEngine } from "./fixtures/fake-generate-engine.ts";

const log = createLogger({ quiet: true });
const config = { ...DEFAULTS, root: "/unused" } as Config;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sb-gen-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A full-Checklist Profile: companyName/industry Known, tone Guessed, rest Unknown. */
function makeProfile(client = "Tailored Co."): Profile {
  return ProfileSchema.parse({
    client,
    fields: CHECKLIST.map((item) => {
      if (item.key === "companyName") {
        return { key: item.key, label: item.label, value: client, status: "Known" };
      }
      if (item.key === "industry") {
        return { key: item.key, label: item.label, value: "plumbing", status: "Known" };
      }
      if (item.key === "tone") {
        return {
          key: item.key,
          label: item.label,
          value: "warm and dependable",
          status: "Guessed",
          note: "inferred",
        };
      }
      return { key: item.key, label: item.label, value: null, status: "Unknown" };
    }),
  });
}

/** A passing compile gate that mimics `astro build` emitting a dist/. */
const fakeBuildOk = async (siteDir: string) => {
  mkdirSync(join(siteDir, "dist"), { recursive: true });
  writeFileSync(join(siteDir, "dist", "index.html"), "<!doctype html>");
  return { ok: true, code: 0, output: "" };
};

// ---- QA session -----------------------------------------------------------

test("runQaSession (non-interactive) turns every Unknown into Guessed and persists", async () => {
  const contextDir = join(root, "context");
  mkdirSync(contextDir, { recursive: true });
  const profile = makeProfile();
  const before = statusCounts(profile.fields);
  expect(before.Unknown).toBeGreaterThan(0);

  await runQaSession({ profile, contextDir, interactive: false, log });

  const after = statusCounts(profile.fields);
  expect(after.Unknown).toBe(0);
  expect(after.Guessed).toBe(before.Guessed + before.Unknown);

  // persisted to disk, and the Checklist gaps were re-derived
  const onDisk = ProfileSchema.parse(
    JSON.parse(readFileSync(join(contextDir, "profile.json"), "utf8")),
  );
  expect(statusCounts(onDisk.fields).Unknown).toBe(0);
  const gaps = readFileSync(join(contextDir, "checklist.md"), "utf8");
  expect(gaps).not.toContain("Unknown — no basis");
});

test("runQaSession (interactive) records answers as Known, skips as Guessed, stops on cancel", async () => {
  const contextDir = join(root, "context");
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(join(contextDir, "profile.md"), "# Profile\n");
  const profile = makeProfile();

  // Answer the first Unknown, skip the second, cancel on the third.
  let seen = 0;
  const ask: QaAsk = async (field) => {
    seen += 1;
    if (seen === 1) {
      return { kind: "answer", value: `answer for ${field.key}` };
    }
    if (seen === 2) {
      return { kind: "skip" };
    }
    return { kind: "cancel" };
  };

  await runQaSession({ profile, contextDir, interactive: true, log, ask });

  // cancel short-circuits the rest, so we prompt exactly three times
  expect(seen).toBe(3);
  expect(statusCounts(profile.fields).Unknown).toBe(0);
  const known = profile.fields.filter((f) => f.note === "provided in QA session");
  expect(known.length).toBe(1);
  expect(known[0]?.status).toBe("Known");

  // the answer is appended to the human Profile so generate reads it
  expect(readFileSync(join(contextDir, "profile.md"), "utf8")).toContain("## QA session answers");
});

// ---- Pexels image sourcing ------------------------------------------------

test("resolveImages copies a fallback image per slot when no Pexels key is set", async () => {
  const siteDir = join(root, "site");
  mkdirSync(siteDir, { recursive: true });
  const result = await resolveImages({
    siteDir,
    manifest: {
      slots: [
        { id: "hero", query: "office", orientation: "landscape" },
        { id: "team", query: "people", orientation: "portrait" },
      ],
    },
    log,
  });
  expect(result.fallback).toBe(2);
  expect(result.fetched).toBe(0);
  expect(existsSync(join(siteDir, "src/assets/stock/hero.jpg"))).toBe(true);
  expect(existsSync(join(siteDir, "src/assets/stock/team.jpg"))).toBe(true);
});

test("resolveImages fetches from Pexels when a key + fetch are available", async () => {
  const siteDir = join(root, "site");
  mkdirSync(siteDir, { recursive: true });
  const fetchImpl = (async (url: string | URL) => {
    if (String(url).includes("api.pexels.com")) {
      return new Response(JSON.stringify({ photos: [{ src: { large: "https://img/x.jpg" } }] }), {
        status: 200,
      });
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await resolveImages({
    siteDir,
    manifest: { slots: [{ id: "hero", query: "office" }] },
    apiKey: "test-key",
    log,
    fetchImpl,
  });
  expect(result.fetched).toBe(1);
  expect(readFileSync(join(siteDir, "src/assets/stock/hero.jpg"))).toEqual(Buffer.from([1, 2, 3]));
});

test("readImagesManifest rejects a malformed slot id", () => {
  const path = join(root, "images.json");
  writeFileSync(path, JSON.stringify({ slots: [{ id: "Bad Id!", query: "x" }] }));
  expect(readImagesManifest(path)).toBeNull();
});

// ---- runGenerate end-to-end (fake engine + fake compile) ------------------

async function setupClientContext(): Promise<{
  paths: ReturnType<typeof clientPaths>;
  profile: Profile;
}> {
  const paths = clientPaths(root, "Tailored Co.");
  mkdirSync(paths.context, { recursive: true });
  const profile = makeProfile();
  writeProfile(join(paths.context, "profile.json"), profile);
  writeFileSync(join(paths.context, "profile.md"), "# Profile\n\nTailored Co.\n");
  return { paths, profile };
}

test("runGenerate produces a tailored, building Site Version with brief + stock imagery", async () => {
  const { paths, profile } = await setupClientContext();
  const client = newClient("Tailored Co.", { docs: [], images: [], notes: "family-owned" });

  // a pre-existing state.json must survive the version-tree rebuild
  const versionDir = paths.versionDir(1);
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(join(versionDir, "state.json"), '{"keep":true}');
  writeFileSync(join(versionDir, "stale.txt"), "old");

  let compiled = 0;
  await runGenerate({
    paths,
    config,
    version: 1,
    client,
    profile,
    interactive: false,
    log,
    engine: fakeGenerateEngine(),
    buildSite: async (dir) => {
      compiled += 1;
      return fakeBuildOk(dir);
    },
  });

  // milestone: a real, locally-building Astro site materialized
  expect(existsSync(join(versionDir, "package.json"))).toBe(true); // Kit copied
  expect(existsSync(join(versionDir, "brief.md"))).toBe(true); // Design Brief
  expect(readFileSync(join(versionDir, "src/data/site.ts"), "utf8")).toContain("Tailored Co.");
  expect(existsSync(join(versionDir, "src/assets/stock/hero.jpg"))).toBe(true); // fallback stock
  expect(existsSync(join(versionDir, ".generated"))).toBe(true); // completion marker
  expect(compiled).toBe(1); // compile gate ran

  // node_modules was never copied from the Kit
  expect(existsSync(join(versionDir, "node_modules"))).toBe(false);
  // state.json preserved, stale tree cleared
  expect(readFileSync(join(versionDir, "state.json"), "utf8")).toContain("keep");
  expect(existsSync(join(versionDir, "stale.txt"))).toBe(false);

  // QA ran non-interactively: no Unknowns remain in the persisted Profile
  const onDisk = ProfileSchema.parse(
    JSON.parse(readFileSync(join(paths.context, "profile.json"), "utf8")),
  );
  expect(statusCounts(onDisk.fields).Unknown).toBe(0);
});

test("runGenerate falls back to a Profile-derived Brief when the call omits brief.md", async () => {
  const { paths, profile } = await setupClientContext();
  const client = newClient("Tailored Co.", { docs: [], images: [], notes: "n" });

  await runGenerate({
    paths,
    config,
    version: 1,
    client,
    profile,
    interactive: false,
    log,
    engine: fakeGenerateEngine({ skipBriefMd: true }),
    buildSite: fakeBuildOk,
  });

  const brief = readFileSync(join(paths.versionDir(1), "brief.md"), "utf8");
  expect(brief).toContain("Auto-derived");
  expect(brief).toContain("plumbing"); // industry pulled from the Profile
});

test("runGenerate fails the stage when the compile gate fails", async () => {
  const { paths, profile } = await setupClientContext();
  const client = newClient("Tailored Co.", { docs: [], images: [], notes: "n" });

  let caught: unknown;
  try {
    await runGenerate({
      paths,
      config,
      version: 1,
      client,
      profile,
      interactive: false,
      log,
      engine: fakeGenerateEngine(),
      buildSite: async () => ({ ok: false, code: 1, output: "Expected a default export" }),
    });
  } catch (err) {
    caught = err;
  }
  expect((caught as Error)?.message).toMatch(/astro build failed/);
});

test("runGenerate fails when the build engine call fails", async () => {
  const { paths, profile } = await setupClientContext();
  const client = newClient("Tailored Co.", { docs: [], images: [], notes: "n" });

  let caught: unknown;
  try {
    await runGenerate({
      paths,
      config,
      version: 1,
      client,
      profile,
      interactive: false,
      log,
      engine: fakeGenerateEngine({ failBuild: true }),
      buildSite: fakeBuildOk,
    });
  } catch (err) {
    caught = err;
  }
  expect((caught as Error)?.message).toMatch(/Site build failed/);
});

// ---- shared astro runner --------------------------------------------------

test("runCommand reports success and failure exit codes", async () => {
  const okResult = await runCommand("node", ["-e", "process.stdout.write('hi')"], { cwd: root });
  expect(okResult.ok).toBe(true);
  expect(okResult.output).toContain("hi");

  const badResult = await runCommand("node", ["-e", "process.exit(3)"], { cwd: root });
  expect(badResult.ok).toBe(false);
  expect(badResult.code).toBe(3);
});

test("hasLocalAstroBin treats incomplete node_modules as missing dependencies", () => {
  const siteDir = join(root, "site");
  mkdirSync(join(siteDir, "node_modules"), { recursive: true });
  expect(hasLocalAstroBin(siteDir)).toBe(false);

  mkdirSync(join(siteDir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(siteDir, "node_modules", ".bin", "astro"), "");
  expect(hasLocalAstroBin(siteDir)).toBe(true);
});
