import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, DEFAULTS } from "../src/config/schema.ts";
import type { IngestManifest } from "../src/ingest/manifest.ts";
import { newClient } from "../src/storage/client.ts";
import { clientPaths } from "../src/storage/layout.ts";
import {
  type AssetClassification,
  candidateAssets,
  parseClassification,
  reconcileAssets,
} from "../src/synthesize/assets.ts";
import { CHECKLIST, renderChecklistForPrompt } from "../src/synthesize/checklist.ts";
import {
  displayFieldValue,
  type Profile,
  ProfileSchema,
  statusCounts,
} from "../src/synthesize/profile.ts";
import {
  renderAssetsSection,
  renderChecklistGaps,
  runSynthesize,
} from "../src/synthesize/synthesize.ts";
import { createLogger } from "../src/util/log.ts";
import { fakeStageEngine } from "./fixtures/fake-stage-engine.ts";

// A 1x1 PNG standing in for a downloaded image Asset.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

const log = createLogger({ quiet: true });
const config = { ...DEFAULTS, root: "/unused" } as Config;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sb-synth-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function emptyManifest(over: Partial<IngestManifest> = {}): IngestManifest {
  return {
    createdAt: new Date().toISOString(),
    inputs: { docCount: 0, imageCount: 0, hasNotes: true },
    docs: [],
    images: [],
    ...over,
  };
}

// ---- Checklist (pure) -----------------------------------------------------

test("the shipped Checklist covers identity, offering, voice and contact", () => {
  const keys = CHECKLIST.map((i) => i.key);
  for (const required of ["companyName", "services", "tone", "contactEmail", "socials"]) {
    expect(keys).toContain(required);
  }
  expect(new Set(keys).size).toBe(keys.length); // keys are unique
  const rendered = renderChecklistForPrompt();
  expect(rendered).toContain("`companyName`");
  expect(rendered).toContain("`callToAction`");
});

// ---- Profile helpers (pure) ----------------------------------------------

test("statusCounts tallies Field statuses", () => {
  const counts = statusCounts([
    { key: "a", label: "A", value: "x", status: "Known" },
    { key: "b", label: "B", value: null, status: "Unknown" },
    { key: "c", label: "C", value: "y", status: "Guessed" },
    { key: "d", label: "D", value: "z", status: "Known" },
  ]);
  expect(counts).toEqual({ Known: 2, Guessed: 1, Unknown: 1 });
});

test("renderChecklistGaps lists Unknown and Guessed fields, not Known ones", () => {
  const profile: Profile = ProfileSchema.parse({
    client: "Acme",
    fields: [
      { key: "companyName", label: "Company name", value: "Acme", status: "Known" },
      { key: "hours", label: "Business hours", value: null, status: "Unknown" },
      { key: "tone", label: "Brand voice", value: "warm", status: "Guessed", note: "inferred" },
    ],
  });
  const md = renderChecklistGaps(profile);
  expect(md).toContain("Business hours");
  expect(md).toContain("Brand voice");
  expect(md).toContain("inferred");
  expect(md).not.toContain("Company name");
});

test("the Profile schema normalizes multi-valued model output to string | string[]", () => {
  // Real models return lists for services/socials and objects for grouped data.
  const profile = ProfileSchema.parse({
    client: "Acme",
    fields: [
      { key: "services", label: "Services", value: ["drains", "heaters"], status: "Known" },
      {
        key: "socials",
        label: "Socials",
        value: { instagram: "https://ig/acme" },
        status: "Known",
      },
      { key: "name", label: "Name", value: "Acme", status: "Known" },
      { key: "hours", label: "Hours", value: null, status: "Unknown" },
    ],
  });
  expect(profile.fields[0]?.value).toEqual(["drains", "heaters"]);
  expect(profile.fields[1]?.value).toEqual(["instagram: https://ig/acme"]); // object → "k: v"
  expect(profile.fields[2]?.value).toBe("Acme");
  expect(profile.fields[3]?.value).toBeNull();

  expect(displayFieldValue(["drains", "heaters"])).toBe("drains, heaters");
  expect(displayFieldValue("Acme")).toBe("Acme");
  expect(displayFieldValue(null)).toBe("");
});

test("renderAssetsSection lists each Asset, flagging fallbacks", () => {
  const section = renderAssetsSection([
    { role: "logo", file: "assets/logo.svg", source: "fallback", description: "Acme logo" },
    { role: "hero", file: "assets/hero.png", source: "captured", description: "Storefront" },
  ]);
  expect(section).toContain("## Assets");
  expect(section).toContain(
    "**logo** (fallback — no original found): `assets/logo.svg` — Acme logo",
  );
  expect(section).toContain("**hero**: `assets/hero.png` — Storefront");
});

test("renderChecklistGaps reports a clean bill when all Known", () => {
  const profile: Profile = ProfileSchema.parse({
    client: "Acme",
    fields: [{ key: "companyName", label: "Company name", value: "Acme", status: "Known" }],
  });
  expect(renderChecklistGaps(profile)).toContain("Every Checklist item is Known");
});

// ---- Asset candidate selection + classification parsing (pure) ------------

test("candidateAssets includes images, skips non-images, and dedupes", () => {
  const manifest = emptyManifest({
    site: {
      baseUrl: "http://x",
      pageCap: 10,
      discovery: "single",
      pages: [],
      assets: [
        {
          url: "http://x/a.png",
          localPath: "site/assets/a.png",
          kind: "img",
          fromPage: "http://x",
          bytes: 1,
        },
        {
          url: "http://x/a.png",
          localPath: "site/assets/a.png",
          kind: "og",
          fromPage: "http://x",
          bytes: 1,
        },
        {
          url: "http://x/styles.css",
          localPath: "site/assets/styles.css",
          kind: "img",
          fromPage: "http://x",
          bytes: 1,
        },
      ],
    },
    images: [{ source: "/tmp/logo.svg", localPath: "images/logo.svg" }],
  });
  const candidates = candidateAssets(manifest, "/ingest");
  const paths = candidates.map((c) => c.absPath);
  expect(paths).toContain(join("/ingest", "site/assets/a.png"));
  expect(paths).toContain(join("/ingest", "images/logo.svg"));
  expect(paths).not.toContain(join("/ingest", "site/assets/styles.css")); // not an image
  expect(paths.filter((p) => p.endsWith("a.png")).length).toBe(1); // deduped
});

test("parseClassification rejects malformed payloads", () => {
  expect(
    parseClassification({ assets: [{ source: "/x", role: "logo", keep: true }] }),
  ).not.toBeNull();
  expect(
    parseClassification({ assets: [{ source: "/x", role: "spaceship", keep: true }] }),
  ).toBeNull();
  expect(parseClassification({ nope: true })).toBeNull();
});

// ---- Asset reconciliation (fs) -------------------------------------------

test("reconcileAssets copies kept captured assets and skips a fallback when a logo exists", () => {
  const ingest = join(root, "ingest");
  const contextDir = join(root, "context");
  mkdirSync(join(ingest, "a"), { recursive: true });
  const logoPath = join(ingest, "a", "logo.png");
  const heroPath = join(ingest, "a", "hero.png");
  writeFileSync(logoPath, PNG);
  writeFileSync(heroPath, PNG);

  const classification: AssetClassification = {
    assets: [
      { source: logoPath, role: "logo", keep: true, description: "Acme logo" },
      { source: heroPath, role: "hero", keep: true },
      { source: join(ingest, "a", "missing.png"), role: "photo", keep: true },
    ],
  };
  const manifest = reconcileAssets({
    classification,
    candidates: [{ absPath: logoPath, url: "http://x/logo.png" }, { absPath: heroPath }],
    contextDir,
    clientName: "Acme",
    log,
  });

  expect(manifest.find((a) => a.role === "logo")?.source).toBe("captured");
  expect(manifest.find((a) => a.role === "logo")?.file).toBe("assets/logo.png");
  expect(manifest.find((a) => a.role === "hero")?.file).toBe("assets/hero.png");
  expect(manifest.some((a) => a.source === "fallback")).toBe(false); // a real logo was kept
  expect(existsSync(join(contextDir, "assets", "logo.png"))).toBe(true);
  expect(existsSync(join(contextDir, "assets", "hero.png"))).toBe(true);
});

test("reconcileAssets keeps only the first of a singleton role and drops the rest", () => {
  const ingest = join(root, "ingest");
  const contextDir = join(root, "context");
  mkdirSync(join(ingest, "a"), { recursive: true });
  const logoPath = join(ingest, "a", "logo.png");
  const logo2Path = join(ingest, "a", "logo2.png");
  writeFileSync(logoPath, PNG);
  writeFileSync(logo2Path, PNG);

  const classification: AssetClassification = {
    assets: [
      { source: logoPath, role: "logo", keep: true, description: "Acme logo" },
      { source: logo2Path, role: "logo", keep: true, description: "Acme logo variant" },
    ],
  };
  const manifest = reconcileAssets({
    classification,
    candidates: [{ absPath: logoPath }, { absPath: logo2Path }],
    contextDir,
    clientName: "Acme",
    log,
  });

  expect(manifest.filter((a) => a.role === "logo")).toHaveLength(1);
  expect(manifest.find((a) => a.role === "logo")?.file).toBe("assets/logo.png");
  expect(existsSync(join(contextDir, "assets", "logo2.png"))).toBe(false);
});

test("reconcileAssets drops a multi-instance-role asset with no description, keeps a described one", () => {
  const ingest = join(root, "ingest");
  const contextDir = join(root, "context");
  mkdirSync(join(ingest, "a"), { recursive: true });
  const teamPath = join(ingest, "a", "team.png");
  const team2Path = join(ingest, "a", "team2.png");
  writeFileSync(teamPath, PNG);
  writeFileSync(team2Path, PNG);

  const classification: AssetClassification = {
    assets: [
      { source: teamPath, role: "team", keep: true },
      { source: team2Path, role: "team", keep: true, description: "Two staff at the counter" },
    ],
  };
  const manifest = reconcileAssets({
    classification,
    candidates: [{ absPath: teamPath }, { absPath: team2Path }],
    contextDir,
    clientName: "Acme",
    log,
  });

  expect(manifest.filter((a) => a.role === "team")).toHaveLength(1);
  expect(manifest.find((a) => a.role === "team")?.file).toBe("assets/team.png");
  expect(existsSync(join(contextDir, "assets", "team.png"))).toBe(true);
});

test("reconcileAssets drops in the Fallback Asset logo when none is captured", () => {
  const contextDir = join(root, "context");
  const manifest = reconcileAssets({
    classification: { assets: [] },
    candidates: [],
    contextDir,
    clientName: "Acme",
    log,
  });
  const logo = manifest.find((a) => a.role === "logo");
  expect(logo?.source).toBe("fallback");
  expect(logo?.file).toBe("assets/logo.svg");
  expect(existsSync(join(contextDir, "assets", "logo.svg"))).toBe(true);
});

// ---- runSynthesize end-to-end (fake engine) -------------------------------

test("runSynthesize emits a Profile + Checklist gaps and a fallback logo (notes-only)", async () => {
  const paths = clientPaths(root, "Acme Plumbing");
  mkdirSync(paths.ingest, { recursive: true });
  const client = newClient("Acme Plumbing", { docs: [], images: [], notes: "family-owned" });

  const profile = await runSynthesize({
    paths,
    config,
    client,
    manifest: emptyManifest({ notes: "notes.md" }),
    log,
    engine: fakeStageEngine(),
  });

  // milestone artifacts present
  expect(existsSync(join(paths.context, "profile.json"))).toBe(true);
  expect(existsSync(join(paths.context, "profile.md"))).toBe(true);
  expect(existsSync(join(paths.context, "checklist.md"))).toBe(true);

  // client name is authoritative (overrides whatever the model wrote)
  expect(profile.client).toBe("Acme Plumbing");
  // Known and Unknown fields both present — the milestone
  const counts = statusCounts(profile.fields);
  expect(counts.Known).toBeGreaterThan(0);
  expect(counts.Unknown).toBeGreaterThan(0);

  // no captured assets -> fallback logo
  expect(profile.assets.find((a) => a.role === "logo")?.source).toBe("fallback");
  expect(existsSync(join(paths.context, "assets", "logo.svg"))).toBe(true);

  // checklist gaps were derived from the statuses
  expect(readFileSync(join(paths.context, "checklist.md"), "utf8")).toContain("Business hours");
});

test("runSynthesize classifies captured assets into the manifest (vision call)", async () => {
  const paths = clientPaths(root, "Acme Plumbing");
  const logoAbs = join(paths.ingest, "site/assets/logo.png");
  mkdirSync(join(paths.ingest, "site/assets"), { recursive: true });
  writeFileSync(logoAbs, PNG);
  const client = newClient("Acme Plumbing", { docs: [], images: [], notes: "n" });

  const manifest = emptyManifest({
    site: {
      baseUrl: "http://x",
      pageCap: 10,
      discovery: "single",
      pages: [],
      assets: [
        {
          url: "http://x/logo.png",
          localPath: "site/assets/logo.png",
          kind: "img",
          fromPage: "http://x",
          bytes: PNG.length,
        },
      ],
    },
  });

  const profile = await runSynthesize({
    paths,
    config,
    client,
    manifest,
    log,
    engine: fakeStageEngine({
      assetsJson: {
        assets: [{ source: logoAbs, role: "logo", keep: true, description: "Acme logo" }],
      },
    }),
  });

  const logo = profile.assets.find((a) => a.role === "logo");
  expect(logo?.source).toBe("captured");
  expect(logo?.file).toBe("assets/logo.png");
  expect(logo?.originalUrl).toBe("http://x/logo.png");
  expect(existsSync(join(paths.context, "assets", "logo.png"))).toBe(true);

  // profile.md (written before the asset manifest exists) gets the Assets
  // section appended, so `generate`'s primary human-readable doc actually
  // surfaces what it should reuse instead of only raw JSON.
  const profileMd = readFileSync(join(paths.context, "profile.md"), "utf8");
  expect(profileMd).toContain("## Assets");
  expect(profileMd).toContain("**logo**: `assets/logo.png` — Acme logo");
});

test("runSynthesize trusts a valid assets.json even when the classification call reports a non-ok result", async () => {
  const paths = clientPaths(root, "Acme Plumbing");
  const logoAbs = join(paths.ingest, "site/assets/logo.png");
  mkdirSync(join(paths.ingest, "site/assets"), { recursive: true });
  writeFileSync(logoAbs, PNG);
  const client = newClient("Acme Plumbing", { docs: [], images: [], notes: "n" });

  const manifest = emptyManifest({
    site: {
      baseUrl: "http://x",
      pageCap: 10,
      discovery: "single",
      pages: [],
      assets: [
        {
          url: "http://x/logo.png",
          localPath: "site/assets/logo.png",
          kind: "img",
          fromPage: "http://x",
          bytes: PNG.length,
        },
      ],
    },
  });

  const profile = await runSynthesize({
    paths,
    config,
    client,
    manifest,
    log,
    engine: fakeStageEngine({
      assetsJson: {
        assets: [{ source: logoAbs, role: "logo", keep: true, description: "Acme logo" }],
      },
      failClassification: true,
    }),
  });

  // the captured logo is used despite the engine reporting failure — not the fallback
  const logo = profile.assets.find((a) => a.role === "logo");
  expect(logo?.source).toBe("captured");
  expect(logo?.file).toBe("assets/logo.png");
  expect(existsSync(join(paths.context, "assets", "logo.png"))).toBe(true);
});

async function expectSynthesizeError(
  engine: ReturnType<typeof fakeStageEngine>,
  pattern: RegExp,
): Promise<void> {
  const paths = clientPaths(root, "Acme");
  mkdirSync(paths.ingest, { recursive: true });
  const client = newClient("Acme", { docs: [], images: [], notes: "n" });
  let caught: unknown;
  try {
    await runSynthesize({ paths, config, client, manifest: emptyManifest(), log, engine });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(pattern);
}

test("runSynthesize fails when the profile call fails", async () => {
  await expectSynthesizeError(fakeStageEngine({ failProfile: true }), /profile synthesis failed/);
});

test("runSynthesize fails when profile.json is not written", async () => {
  await expectSynthesizeError(fakeStageEngine({ skipProfileJson: true }), /profile\.json/);
});

test("runSynthesize fails when profile.json omits Checklist fields", async () => {
  await expectSynthesizeError(
    fakeStageEngine({
      profileJson: {
        client: "Acme",
        fields: [{ key: "companyName", label: "Company name", value: "Acme", status: "Known" }],
      },
    }),
    /does not match Checklist/,
  );
});
